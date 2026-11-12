package com.rohan.nascontroller;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.Inet4Address;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * Lists this phone's private IPv4 addresses (Wi-Fi, hotspot, USB tethering) so the
 * app page can scan the right local network for the NAS. Replaces os.networkInterfaces()
 * from the old Termux start_nas.js.
 */
@CapacitorPlugin(name = "NetInfo")
public class NetInfoPlugin extends Plugin {

    @PluginMethod
    public void getNetworks(PluginCall call) {
        JSArray networks = new JSArray();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getAddress() instanceof Inet4Address && ia.getAddress().isSiteLocalAddress()) {
                        JSObject net = new JSObject();
                        net.put("name", ni.getName());
                        net.put("address", ia.getAddress().getHostAddress());
                        net.put("prefixLength", ia.getNetworkPrefixLength());
                        networks.put(net);
                    }
                }
            }
        } catch (Exception e) {
            call.reject("Could not read network interfaces: " + e.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("networks", networks);
        call.resolve(result);
    }
}
