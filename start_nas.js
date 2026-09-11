const http = require('http');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const configPath = `${os.homedir()}/.cloudflared/config.yml`;

// Dynamically find the active local Wi-Fi / Hotspot subnet
let subnet = '';
const interfaces = os.networkInterfaces();

for (const name in interfaces) {
    for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
            // Look for standard local private network ranges
            if (iface.address.startsWith('10.') || 
                iface.address.startsWith('192.168.') || 
                iface.address.startsWith('172.')) {
                
                const parts = iface.address.split('.');
                subnet = `${parts[0]}.${parts[1]}.${parts[2]}.`;
                break;
            }
        }
    }
    if (subnet) break;
}

if (!subnet) {
    console.log(' Could not find an active local Wi-Fi/Hotspot network. Are you connected to a hotspot?');
    process.exit(1);
}

console.log(` Scanning dynamic subnet ${subnet}1-254 for ESP32...`);

let found = false;
process.stdout.write(' Sweeping IPs');

for (let i = 1; i <= 254; i++) {
    const ip = subnet + i;
    
    const options = {
        hostname: ip,
        port: 80,
        path: '/login',
        agent: false,
        timeout: 1200 
    };

    const req = http.get(options, (res) => {
        if (!found && res.statusCode === 200) {
            found = true;
            console.log(`\n Found ESP32 at IP: ${ip}`);
            
            // Rewrite Cloudflare Config
            let config = fs.readFileSync(configPath, 'utf8');
            config = config.replace(/service: http:\/\/[^\s]+/, `service: http://${ip}`);
            fs.writeFileSync(configPath, config);
            
            console.log('🚀 Config updated. Starting Cloudflare Tunnel...');
            spawn('cloudflared', ['tunnel', 'run', 'ROHAN_NAS'], { stdio: 'inherit' });
        }
    });

    req.on('error', () => {}); 
    req.on('timeout', () => req.destroy());
}

setTimeout(() => {
    if (!found) console.log('\n Scan finished. Ensure ESP32 is powered on and connected to this network.');
}, 2500);
