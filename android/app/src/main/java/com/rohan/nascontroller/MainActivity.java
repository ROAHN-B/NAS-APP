package com.rohan.nascontroller;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
// 1. Import the NodeJS plugin
import com.capawesome.capacitor.nodejs.NodeJS;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // 2. Start the Node.js server (pointing to your server.js file)
        NodeJS.getInstance().start(this, "server.js", new com.capawesome.capacitor.nodejs.NodeJSStartupListener() {
            @Override
            public void onStartup() {
                // Node.js is running successfully
            }
        });
    }
}