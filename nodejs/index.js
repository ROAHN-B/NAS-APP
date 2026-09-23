const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 5050;
let tunnelProcess = null;

app.use(express.json());
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

function broadcastLog(type, text) {
    const time = new Date().toLocaleTimeString();
    const payload = JSON.stringify({ type, time, text });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'system', time: new Date().toLocaleTimeString(), text: '[SYSTEM] Connected to embedded Node engine backend.' }));
});

app.post('/api/tunnel/start', (req, res) => {
    if (tunnelProcess) {
        return res.status(400).send({ error: 'Tunnel already running' });
    }

    broadcastLog('system', '[SYSTEM] Starting Cloudflare tunnel...');
    
    tunnelProcess = spawn('node', ['start_nas.js'], { stdio: ['ignore', 'pipe', 'pipe'] });

    tunnelProcess.stdout.on('data', (data) => {
        data.toString().split('\n').forEach(line => {
            if (line.trim()) broadcastLog('stdout', line);
        });
    });

    tunnelProcess.stderr.on('data', (data) => {
        data.toString().split('\n').forEach(line => {
            if (line.trim()) broadcastLog('stderr', line);
        });
    });

    tunnelProcess.on('close', (code) => {
        broadcastLog('system', `[SYSTEM] Tunnel process exited with code ${code}`);
        tunnelProcess = null;
    });

    res.send({ success: true, message: 'Tunnel sequence initiated.' });
});

app.post('/api/tunnel/stop', (req, res) => {
    if (tunnelProcess) {
        tunnelProcess.kill('SIGINT');
        tunnelProcess = null;
    }
    broadcastLog('system', '[SYSTEM] Tunnel stopped by user.');
    res.send({ success: true, message: 'Tunnel stopped.' });
});

app.get('/api/tunnel/status', (req, res) => {
    res.send({ running: tunnelProcess !== null });
});

app.post('/api/decrypt', (req, res) => {
    try {
        const keyHeader = req.headers['x-aes-key'];
        if (!keyHeader) return res.status(400).send('Missing X-AES-Key header');

        const keyBytes = keyHeader.split(',').map(b => parseInt(b.trim(), 16));
        const AES_KEY = Buffer.from(keyBytes);
        const AES_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F]);

        const decipher = crypto.createDecipheriv('aes-128-ctr', AES_KEY, AES_IV);
        const decryptedBuffer = Buffer.concat([decipher.update(req.body), decipher.final()]);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(decryptedBuffer);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`NAS Command Hub backend running on port ${PORT}`);
});