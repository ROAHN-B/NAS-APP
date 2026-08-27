const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AES-Key, X-File-Name, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Setup public directory for public web interface
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// Automatically create a default open public dashboard page if missing
const indexPath = path.join(PUBLIC_DIR, 'index.html');
if (!fs.existsSync(indexPath)) {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Rohan's NAS</title>
  <style>
    body { background: #0b0f19; color: #f3f4f6; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .card { background: #111827; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); width: 350px; text-align: center; }
    h1 { color: #3b82f6; margin-bottom: 10px; }
    p { color: #9ca3af; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Rohan's NAS</h1>
    <p>Storage Engine Online & Operational</p>
  </div>
</body>
</html>`;
  fs.writeFileSync(indexPath, htmlContent);
}

app.use(express.static(PUBLIC_DIR));

let tunnelProcess = null;
const AES_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F]);
const DECRYPTED_DIR = '/data/data/com.termux/files/home/storage/shared/Download/NAS_Decrypted';

if (!fs.existsSync(DECRYPTED_DIR)) {
  fs.mkdirSync(DECRYPTED_DIR, { recursive: true });
}

const activeTokens = new Set();

// Authentication Middleware (Protects App Endpoints)
function verifyAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token && activeTokens.has(token)) {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized access. Please log in from the app.' });
  }
}

function broadcastLog(data, type = 'info') {
  const message = JSON.stringify({ type, text: data.toString(), time: new Date().toLocaleTimeString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// App Login Endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // Credentials for your NAS Controller App
  if (username === 'Admin' && password === 'admin123') {
    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.add(token);
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, error: 'Invalid username or password.' });
});

// Start Cloudflare Tunnel (Protected for App)
app.post('/api/tunnel/start', verifyAuth, (req, res) => {
  if (tunnelProcess) {
    return res.json({ status: 'running', message: 'Tunnel is already running.' });
  }

  tunnelProcess = spawn('cloudflared', [
    '--config', 
    '/data/data/com.termux/files/home/.cloudflared/config.yml',
    'tunnel', 
    'run', 
    'ROHAN_NAS'
  ], {
    env: { 
      ...process.env, 
      HOME: '/data/data/com.termux/files/home',
      TUNNEL_ORIGIN_CERT: '/data/data/com.termux/files/home/.cloudflared/cert.pem'
    }
  });

  broadcastLog('[SYSTEM] Initializing Cloudflare Zero Trust Tunnel...', 'system');
  tunnelProcess.stdout.on('data', (data) => broadcastLog(data, 'stdout'));
  tunnelProcess.stderr.on('data', (data) => broadcastLog(data, 'stderr'));

  tunnelProcess.on('close', (code) => {
    broadcastLog(`[SYSTEM] Tunnel process terminated with code ${code}`, 'system');
    tunnelProcess = null;
  });

  res.json({ status: 'started' });
});

// Stop Cloudflare Tunnel (Protected for App)
app.post('/api/tunnel/stop', verifyAuth, (req, res) => {
  if (tunnelProcess) {
    tunnelProcess.kill('SIGINT');
    tunnelProcess = null;
    broadcastLog('[SYSTEM] Cloudflare Tunnel stopped by user.', 'system');
    return res.json({ status: 'stopped' });
  }
  res.json({ status: 'not_running' });
});

// Tunnel Status (Protected for App)
app.get('/api/tunnel/status', verifyAuth, (req, res) => {
  res.json({ running: tunnelProcess !== null });
});

// AES-128-CTR Decryption (Protected for App)
app.post('/api/decrypt', verifyAuth, express.raw({ type: 'application/octet-stream', limit: '1024mb' }), (req, res) => {
  try {
    const keyString = req.headers['x-aes-key'];
    const originalFileName = req.headers['x-file-name'] || `decrypted_${Date.now()}.bin`;

    if (!keyString) return res.status(400).send('Missing AES Key header.');

    const keyArray = keyString.split(',').map(s => parseInt(s.trim(), 16));
    if (keyArray.length !== 16 || keyArray.some(isNaN)) {
      return res.status(400).send('Invalid AES key format. Must be 16 valid hex bytes.');
    }

    const aesKey = Buffer.from(keyArray);
    const decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, AES_IV);
    const decryptedBuffer = Buffer.concat([decipher.update(req.body), decipher.final()]);

    const savedFilePath = path.join(DECRYPTED_DIR, originalFileName);
    fs.writeFileSync(savedFilePath, decryptedBuffer);

    res.json({
      success: true,
      message: 'File decrypted successfully',
      fileName: originalFileName,
      savedPath: savedFilePath,
      sizeBytes: decryptedBuffer.length
    });

  } catch (err) {
    res.status(500).json({ success: false, error: 'Decryption failed: ' + err.message });
  }
});

const PORT = 5050;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[NAS ENGINE] Running on http://localhost:${PORT}`);
});