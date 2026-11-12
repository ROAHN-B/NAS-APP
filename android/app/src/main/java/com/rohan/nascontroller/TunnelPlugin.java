package com.rohan.nascontroller;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/** Lets the app page import the tunnel key and start/stop TunnelService. */
@CapacitorPlugin(name = "Tunnel")
public class TunnelPlugin extends Plugin {

    private static final String NOTIFICATION_PERMISSION = "android.permission.POST_NOTIFICATIONS";

    /** Stores the tunnel credentials JSON (from ~/.cloudflared/<tunnel-id>.json) in app-private storage. */
    @PluginMethod
    public void saveCredentials(PluginCall call) {
        String json = call.getString("json", "");
        String tunnelId;
        try {
            JSONObject o = new JSONObject(json);
            tunnelId = o.getString("TunnelID");
            o.getString("TunnelSecret");
            o.getString("AccountTag");
        } catch (JSONException e) {
            call.reject("That isn't a tunnel key file. It should contain AccountTag, TunnelSecret and TunnelID.");
            return;
        }
        File f = TunnelService.credentialsFile(getContext());
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            call.reject("Could not save the key: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("tunnelId", tunnelId);
        call.resolve(r);
    }

    @PluginMethod
    public void removeCredentials(PluginCall call) {
        File f = TunnelService.credentialsFile(getContext());
        if (f.exists() && !f.delete()) {
            call.reject("Could not remove the key.");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", TunnelService.binary(getContext()).exists());
        r.put("tunnelId", readTunnelId());
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Pick the NAS to put online first.");
            return;
        }
        String tunnelId = readTunnelId();
        if (tunnelId == null) {
            call.reject("Import your tunnel key first.");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(getContext(), NOTIFICATION_PERMISSION) != PackageManager.PERMISSION_GRANTED
            && getActivity() != null) {
            // Without it the tunnel still runs; Android just hides the "tunnel active" notification.
            ActivityCompat.requestPermissions(getActivity(), new String[] { NOTIFICATION_PERMISSION }, 7845);
        }
        Intent intent = new Intent(getContext(), TunnelService.class)
            .setAction(TunnelService.ACTION_START)
            .putExtra(TunnelService.EXTRA_URL, url)
            .putExtra(TunnelService.EXTRA_TUNNEL_ID, tunnelId);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!"stopped".equals(TunnelService.state) && !"error".equals(TunnelService.state)) {
            getContext().startService(new Intent(getContext(), TunnelService.class).setAction(TunnelService.ACTION_STOP));
        }
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("state", TunnelService.state);
        r.put("connections", TunnelService.connectionCount());
        r.put("url", TunnelService.originUrl);
        List<String> lines = TunnelService.logLines();
        JSArray log = new JSArray();
        for (int i = Math.max(0, lines.size() - 60); i < lines.size(); i++) log.put(lines.get(i));
        r.put("log", log);
        call.resolve(r);
    }

    /** Opens Android's battery optimisation list so the user can set the app to "Unrestricted". */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 23) {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    private String readTunnelId() {
        File f = TunnelService.credentialsFile(getContext());
        if (!f.exists()) return null;
        try {
            byte[] bytes = new byte[(int) f.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int read = 0;
                while (read < bytes.length) {
                    int n = in.read(bytes, read, bytes.length - read);
                    if (n < 0) break;
                    read += n;
                }
            }
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8)).getString("TunnelID");
        } catch (IOException | JSONException e) {
            return null;
        }
    }
}
