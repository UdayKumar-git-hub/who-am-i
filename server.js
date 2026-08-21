const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

// Make sure the data folder exists so state survives server restarts
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let gameState = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    gameState = JSON.parse(raw || '{}');
  }
} catch (e) {
  console.error('Failed to load initial state:', e);
}
if (!gameState.version) gameState.version = 1;

// Function to save state to disk asynchronously
let saveTimeout = null;
function persistState() {
  gameState.version = (gameState.version || 0) + 1;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(gameState));
    } catch (e) {
      console.error('Error persisting state:', e);
    }
  }, 50);
}

// ---- Instant Authentication Endpoint ----
app.post('/api/login', (req, res) => {
  try {
    const { role, username, password } = req.body;
    const u = (username || '').trim().toLowerCase();
    const p = (password || '').trim();
    const creds = gameState.credentials || {
      admin: { username: 'admin', password: 'password123' },
      tv: { username: 'tvdisplay', password: 'password123' },
      teams: {}
    };

    if (role === 'admin') {
      if (u === (creds.admin.username || '').toLowerCase() && p === creds.admin.password) {
        return res.json({ ok: true, role: 'admin' });
      }
      return res.json({ ok: false, error: 'Incorrect admin username or password.' });
    }

    if (role === 'tv') {
      if (u === (creds.tv.username || '').toLowerCase() && p === creds.tv.password) {
        return res.json({ ok: true, role: 'tv' });
      }
      return res.json({ ok: false, error: 'Incorrect TV login username or password.' });
    }

    if (role === 'team') {
      const match = Object.entries(creds.teams || {}).find(
        ([id, c]) => (c.username || '').toLowerCase() === u && c.password === p
      );
      if (match) {
        const teamObj = (gameState.teams || []).find(t => t.id === match[0]);
        return res.json({ ok: true, role: 'team', teamId: match[0], team: teamObj });
      }
      return res.json({ ok: false, error: 'Incorrect team username or password.' });
    }

    return res.status(400).json({ ok: false, error: 'Invalid role' });
  } catch (e) {
    console.error('Login endpoint error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ---- Shared game state endpoints ----
// GET  /api/state  -> returns in-memory state in < 1ms
app.get('/api/state', (req, res) => {
  res.json(gameState);
});

// POST /api/state  -> update state in-memory and schedule disk save
app.post('/api/state', (req, res) => {
  try {
    gameState = req.body;
    persistState();
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to write state:', e);
    res.status(500).json({ ok: false });
  }
});

// POST /api/buzz  -> Atomic high-speed buzzer lock (instant millisecond response)
app.post('/api/buzz', (req, res) => {
  try {
    const { teamId, ts } = req.body;
    if (!teamId) return res.status(400).json({ ok: false, error: 'Missing teamId' });

    // Check if buzzer is live
    if (gameState.phase !== 'open') {
      return res.json({ ok: false, reason: 'not_open', phase: gameState.phase, buzzedTeamId: gameState.buzzedTeamId });
    }

    // Check if team is locked out
    if (gameState.lockedOut && gameState.lockedOut.includes(teamId)) {
      return res.json({ ok: false, reason: 'locked_out' });
    }

    // Check if another team already won the race
    if (gameState.buzzedTeamId) {
      return res.json({ ok: false, reason: 'already_buzzed', buzzedTeamId: gameState.buzzedTeamId });
    }

    // FIRST BUZZ WINS! Atomically lock state in memory
    const now = Date.now();
    gameState.buzzedTeamId = teamId;
    gameState.phase = 'buzzed';
    gameState.answerTimerEnd = now + 5000;
    if (!gameState.buzzLog) gameState.buzzLog = [];
    gameState.buzzLog.push({ teamId, ts: ts || now });
    gameState.soundEvent = { type: 'buzz', id: 'buzz' + now };

    persistState();
    return res.json({ ok: true, buzzedTeamId: teamId, answerTimerEnd: gameState.answerTimerEnd });
  } catch (e) {
    console.error('Buzz endpoint error:', e);
    res.status(500).json({ ok: false });
  }
});

// Endpoint to fetch local IP addresses for offline hotspot connection
app.get('/api/ips', (req, res) => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push({ name, ip: net.address, url: `http://${net.address}:${PORT}` });
    }
  }
  res.json({ port: PORT, addresses });
});

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }

  console.log('');
  console.log('  ========================================');
  console.log('  TAIT Presents : WHO AM I? SERVER STARTED');
  console.log('  ========================================');
  console.log('');
  console.log(`  Local:   http://localhost:${PORT}/`);
  addresses.forEach(ip => console.log(`  Network: http://${ip}:${PORT}/`));
  console.log('');
  console.log('  Open the network URL above on the admin laptop, the TV, and every team phone.');
  console.log('  All devices must be on the same Wi-Fi / router. No internet required.');
  console.log('');
});
