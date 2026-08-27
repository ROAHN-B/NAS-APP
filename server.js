const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Enable CORS for APK communication
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AES-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let tunnelProcess = null;
const AES_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F]);

function broadcastLog(data, type = 'info') {
  const message = JSON.stringify({ type, text: data.toString(), time: new Date().toLocaleTimeString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// Start Cloudflare Tunnel
app.post('/api/tunnel/start', (req, res) => {
  if (tunnelProcess) {
    return res.json({ status: 'running', message: 'Tunnel is already running.' });
  }

  tunnelProcess = spawn('cloudflared', ['tunnel', 'run']);
  broadcastLog('[SYSTEM] Initializing Cloudflare Zero Trust Tunnel...', 'system');

  tunnelProcess.stdout.on('data', (data) => broadcastLog(data, 'stdout'));
  tunnelProcess.stderr.on('data', (data) => broadcastLog(data, 'stderr'));

  tunnelProcess.on('close', (code) => {
    broadcastLog(`[SYSTEM] Tunnel process terminated with code ${code}`, 'system');
    tunnelProcess = null;
  });

  res.json({ status: 'started' });
});

// Stop Cloudflare Tunnel
app.post('/api/tunnel/stop', (req, res) => {
  if (tunnelProcess) {
    tunnelProcess.kill('SIGINT');
    tunnelProcess = null;
    broadcastLog('[SYSTEM] Cloudflare Tunnel stopped by user.', 'system');
    return res.json({ status: 'stopped' });
  }
  res.json({ status: 'not_running' });
});

// Tunnel Status
app.get('/api/tunnel/status', (req, res) => {
  res.json({ running: tunnelProcess !== null });
});

// Dynamic AES-128 CTR SD Card File Decryption
app.post('/api/decrypt', express.raw({ type: 'application/octet-stream', limit: '1024mb' }), (req, res) => {
  try {
    const keyString = req.headers['x-aes-key'];
    if (!keyString) return res.status(400).send('Missing AES Key header.');

    const keyArray = keyString.split(',').map(s => parseInt(s.trim(), 16));
    if (keyArray.length !== 16 || keyArray.some(isNaN)) {
      return res.status(400).send('Invalid AES key format. Must be 16 valid hex bytes.');
    }

    const aesKey = Buffer.from(keyArray);
    const decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, AES_IV);
    const decrypted = Buffer.concat([decipher.update(req.body), decipher.final()]);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(decrypted);
  } catch (err) {
    res.status(500).send('Decryption failed: ' + err.message);
  }
});

const PORT = 5050;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[NAS ENGINE] Running on http://localhost:${PORT}`);
});