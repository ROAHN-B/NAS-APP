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

// CORS & Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AES-Key, X-File-Name, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Set up public web interface (for visitors directly hitting media-server.app)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Termux Storage Config
const DECRYPTED_DIR = '/data/data/com.termux/files/home/storage/shared/Download/NAS_Decrypted';
if (!fs.existsSync(DECRYPTED_DIR)) {
  fs.mkdirSync(DECRYPTED_DIR, { recursive: true });
}

// Hardware Matching IV
const AES_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F]);

let tunnelProcess = null;
const activeTokens = new Set();

// Authentication Middleware
function verifyAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token && activeTokens.has(token)) {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized access. Please log in.' });
  }
}

function broadcastLog(data, type = 'info') {
  const message = JSON.stringify({ type, text: data.toString(), time: new Date().toLocaleTimeString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// Login Endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'Admin' && password === 'rohan123') {
    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.add(token);
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, error: 'Invalid credentials.' });
});

// Tunnel Endpoints
app.post('/api/tunnel/start', verifyAuth, (req, res) => {
  if (tunnelProcess) return res.json({ status: 'running' });
  
  tunnelProcess = spawn('cloudflared', [
    '--config', '/data/data/com.termux/files/home/.cloudflared/config.yml',
    'tunnel', 'run', 'ROHAN_NAS'
  ], {
    env: { ...process.env, HOME: '/data/data/com.termux/files/home', TUNNEL_ORIGIN_CERT: '/data/data/com.termux/files/home/.cloudflared/cert.pem' }
  });

  tunnelProcess.stdout.on('data', (data) => broadcastLog(data, 'stdout'));
  tunnelProcess.stderr.on('data', (data) => broadcastLog(data, 'stderr'));
  tunnelProcess.on('close', () => { tunnelProcess = null; });
  res.json({ status: 'started' });
});

app.post('/api/tunnel/stop', verifyAuth, (req, res) => {
  if (tunnelProcess) {
    tunnelProcess.kill('SIGINT');
    tunnelProcess = null;
    return res.json({ status: 'stopped' });
  }
  res.json({ status: 'not_running' });
});

app.get('/api/tunnel/status', verifyAuth, (req, res) => {
  res.json({ running: tunnelProcess !== null });
});

// SD Card Decryption Endpoint
app.post('/api/decrypt', verifyAuth, express.raw({ type: 'application/octet-stream', limit: '1024mb' }), (req, res) => {
  try {
    const keyString = req.headers['x-aes-key'];
    const originalFileName = req.headers['x-file-name'] || `decrypted_${Date.now()}.bin`;

    if (!keyString) return res.status(400).json({ success: false, error: 'Missing AES Key header' });

    const keyArray = keyString.split(',').map(s => parseInt(s.trim(), 16));
    if (keyArray.length !== 16 || keyArray.some(isNaN)) {
      return res.status(400).json({ success: false, error: 'Invalid AES key format' });
    }

    const aesKey = Buffer.from(keyArray);
    const decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, AES_IV);
    const decryptedBuffer = Buffer.concat([decipher.update(req.body), decipher.final()]);

    const savedFilePath = path.join(DECRYPTED_DIR, originalFileName);
    fs.writeFileSync(savedFilePath, decryptedBuffer);
    
    console.log(`[DECRYPT SUCCESS] Saved to ${savedFilePath}`);

    res.json({
      success: true,
      fileName: originalFileName,
      savedPath: savedFilePath,
      sizeBytes: decryptedBuffer.length
    });

  } catch (err) {
    console.error('[DECRYPT ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = 5050;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[NAS ENGINE] Running on http://localhost:${PORT}`);
});