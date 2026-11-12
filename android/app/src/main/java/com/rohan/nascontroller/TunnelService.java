package com.rohan.nascontroller;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs the bundled cloudflared (lib/arm64-v8a/libcloudflared.so) as a foreground service so the
 * NAS stays reachable at its Cloudflare address while the screen is off. Replaces Termux + start_nas.js.
 */
public class TunnelService extends Service {

    static final String ACTION_START = "com.rohan.nascontroller.TUNNEL_START";
    static final String ACTION_STOP = "com.rohan.nascontroller.TUNNEL_STOP";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TUNNEL_ID = "tunnelId";

    private static final String CHANNEL_ID = "nas_tunnel";
    private static final int NOTIFICATION_ID = 7844;
    private static final int MAX_LOG_LINES = 200;
    private static final Pattern CONN_INDEX = Pattern.compile("connIndex=(\\d+)");

    // Read by TunnelPlugin; the service and the plugin run in the same process.
    static volatile String state = "stopped"; // stopped | starting | connected | error
    static volatile String originUrl = "";
    private static final Set<String> liveConnections = new HashSet<>();
    private static final ArrayDeque<String> log = new ArrayDeque<>();

    private Process process;
    private boolean stopRequested;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    static File credentialsFile(Context c) {
        return new File(c.getFilesDir(), "tunnel-credentials.json");
    }

    static File binary(Context c) {
        return new File(c.getApplicationInfo().nativeLibraryDir, "libcloudflared.so");
    }

    static synchronized void addLog(String line) {
        if (log.size() >= MAX_LOG_LINES) log.removeFirst();
        log.addLast(line);
    }

    static synchronized List<String> logLines() {
        return new ArrayList<>(log);
    }

    static synchronized int connectionCount() {
        return liveConnections.size();
    }

    // Track connections by connIndex so repeated or missing log lines can't make the count drift.
    private static synchronized void trackConnection(String line) {
        Matcher m = CONN_INDEX.matcher(line);
        if (!m.find()) return;
        String index = m.group(1);
        if (line.contains("Registered tunnel connection")) {
            liveConnections.add(index);
        } else if (line.contains("Unregistered tunnel connection") || line.contains("Connection terminated") || line.contains("Serve tunnel error")) {
            liveConnections.remove(index);
        }
    }

    private static synchronized void resetSession() {
        log.clear();
        liveConnections.clear();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) {
            synchronized (this) {
                if (process != null) {
                    addLog("[app] The tunnel is already running. Stop it first to switch NAS.");
                    return START_NOT_STICKY;
                }
            }
            originUrl = intent.getStringExtra(EXTRA_URL);
            state = "starting";
            // Must call startForeground() within a few seconds of startForegroundService().
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            startTunnel(originUrl, intent.getStringExtra(EXTRA_TUNNEL_ID));
        } else if (ACTION_STOP.equals(action)) {
            stopTunnel();
        }
        return START_NOT_STICKY;
    }

    private synchronized void startTunnel(String url, String tunnelId) {
        if (process != null) {
            addLog("[app] The tunnel is already running.");
            return;
        }
        resetSession();
        stopRequested = false;

        File bin = binary(this);
        if (!bin.exists()) {
            fail("This phone can't host the tunnel: cloudflared is only included for 64-bit ARM phones.");
            return;
        }

        // Flag order matters: --no-autoupdate is global (before "tunnel"), --grace-period belongs to "tunnel".
        ProcessBuilder pb = new ProcessBuilder(
            bin.getAbsolutePath(),
            "--no-autoupdate",
            "tunnel", "--grace-period", "2s",
            "run",
            "--url", url,
            "--credentials-file", credentialsFile(this).getAbsolutePath(),
            tunnelId
        );
        pb.redirectErrorStream(true);
        pb.directory(getFilesDir());
        pb.environment().put("HOME", getFilesDir().getAbsolutePath());
        pb.environment().put("GODEBUG", "netdns=cgo"); // use Android's DNS resolver; there is no /etc/resolv.conf

        addLog("[app] Starting tunnel " + tunnelId + " to " + url);
        final Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            fail("Could not start cloudflared: " + e.getMessage());
            return;
        }
        process = p;
        acquireLocks();

        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) {
                    addLog(line);
                    trackConnection(line);
                    String next = connectionCount() > 0 ? "connected" : "starting";
                    if (!next.equals(state)) {
                        state = next;
                        updateNotification();
                    }
                }
            } catch (IOException ignored) {
                // stream closes when the process ends
            }
            int code;
            try {
                code = p.waitFor();
            } catch (InterruptedException e) {
                code = -1;
            }
            onProcessExit(p, code);
        }, "cloudflared-output");
        reader.start();
    }

    private synchronized void onProcessExit(Process p, int code) {
        if (process != p) return;
        process = null;
        synchronized (TunnelService.class) {
            liveConnections.clear();
        }
        if (stopRequested) {
            state = "stopped";
            addLog("[app] Tunnel stopped.");
        } else {
            state = "error";
            addLog("[app] cloudflared stopped unexpectedly (exit code " + code + "). See the lines above.");
        }
        shutDown();
    }

    private synchronized void stopTunnel() {
        stopRequested = true;
        if (process != null) {
            addLog("[app] Stopping tunnel...");
            process.destroy(); // SIGTERM; --grace-period 2s keeps this short. onProcessExit() finishes the shutdown.
        } else {
            state = "stopped";
            shutDown();
        }
    }

    private void fail(String message) {
        addLog("[app] " + message);
        state = "error";
        shutDown();
    }

    private void shutDown() {
        releaseLocks();
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        synchronized (this) {
            if (process != null) {
                stopRequested = true;
                process.destroy();
            }
        }
        releaseLocks();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nascontroller:tunnel");
        wakeLock.acquire();
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "nascontroller:tunnel");
            wifiLock.acquire();
        }
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "NAS tunnel", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent openApp = PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(
            this, 1, new Intent(this, TunnelService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        String text = "connected".equals(state)
            ? "Online. Serving " + originUrl
            : "Connecting to Cloudflare... (" + originUrl + ")";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("NAS tunnel active")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp)
            .addAction(0, "Stop", stop)
            .build();
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, buildNotification());
    }
}
