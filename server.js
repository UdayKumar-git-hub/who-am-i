const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

// Make sure the data folder exists so state survives server restarts
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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
if (!Array.isArray(gameState.buzzLog)) gameState.buzzLog = [];
if (!Array.isArray(gameState.lockedOut)) gameState.lockedOut = [];

// Broadcast state to all connected WebSocket clients instantly (< 1ms)
function broadcastState(excludeWs = null) {
  const payload = JSON.stringify({ type: 'STATE', state: gameState });
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        console.error('WS broadcast error:', err);
      }
    }
  });
}

// Function to save state to disk asynchronously without blocking event loop
let saveTimeout = null;
function persistState(broadcast = true) {
  gameState.version = (gameState.version || 0) + 1;
  if (broadcast) broadcastState();
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(gameState));
    } catch (e) {
      console.error('Error persisting state:', e);
    }
  }, 40);
}

// Atomic Multi-Team Buzz Handler (Ultra-Fast & Accurate)
function handleBuzz(teamId, clientTs) {
  if (!teamId) return { ok: false, error: 'Missing teamId' };

  // Buzzer must be live (open or buzzed phase allows queued buzzes)
  if (gameState.phase !== 'open' && gameState.phase !== 'buzzed') {
    return { ok: false, reason: 'not_open', phase: gameState.phase, buzzedTeamId: gameState.buzzedTeamId };
  }

  // Check if team is locked out for this question
  if (gameState.lockedOut && gameState.lockedOut.includes(teamId)) {
    return { ok: false, reason: 'locked_out' };
  }

  if (!Array.isArray(gameState.buzzLog)) gameState.buzzLog = [];

  // Check if team already buzzed for this question
  const existingIdx = gameState.buzzLog.findIndex(e => e.teamId === teamId);
  if (existingIdx !== -1) {
    return {
      ok: true,
      alreadyLogged: true,
      rank: existingIdx + 1,
      buzzedTeamId: gameState.buzzedTeamId,
      answerTimerEnd: gameState.answerTimerEnd
    };
  }

  const serverNow = Date.now();
  const teamObj = (gameState.teams || []).find(t => t.id === teamId);
  const teamName = teamObj ? teamObj.name : teamId;
  const semester = teamObj ? teamObj.semester : 1;

  const isFirst = gameState.buzzLog.length === 0;
  const firstBuzzTs = isFirst ? serverNow : gameState.buzzLog[0].ts;
  const deltaMs = isFirst ? 0 : Math.max(1, serverNow - firstBuzzTs);
  const rank = gameState.buzzLog.length + 1;

  const buzzEntry = {
    teamId,
    name: teamName,
    semester,
    ts: serverNow,
    clientTs: clientTs || serverNow,
    deltaMs,
    rank
  };

  gameState.buzzLog.push(buzzEntry);

  // If first team, activate answer timer and sound
  if (isFirst) {
    gameState.buzzedTeamId = teamId;
    gameState.phase = 'buzzed';
    gameState.answerTimerEnd = serverNow + 5000;
    gameState.soundEvent = { type: 'buzz', id: 'buzz_' + serverNow };
  }

  persistState(true);

  return {
    ok: true,
    isFirst,
    rank,
    deltaMs,
    buzzedTeamId: gameState.buzzedTeamId,
    answerTimerEnd: gameState.answerTimerEnd
  };
}

// Pass to next team in queue
function handlePassNext() {
  if (!gameState.buzzedTeamId) return { ok: false, error: 'No active team' };
  if (!Array.isArray(gameState.lockedOut)) gameState.lockedOut = [];
  
  if (!gameState.lockedOut.includes(gameState.buzzedTeamId)) {
    gameState.lockedOut.push(gameState.buzzedTeamId);
  }

  // Find next team in buzzLog not locked out
  const nextEntry = (gameState.buzzLog || []).find(e => !gameState.lockedOut.includes(e.teamId));
  const serverNow = Date.now();

  if (nextEntry) {
    gameState.buzzedTeamId = nextEntry.teamId;
    gameState.phase = 'buzzed';
    gameState.answerTimerEnd = serverNow + 5000;
    gameState.soundEvent = { type: 'buzz', id: 'buzz_pass_' + serverNow };
  } else {
    // No more queued teams, set to locked
    gameState.buzzedTeamId = null;
    gameState.phase = 'locked';
  }

  persistState(true);
  return { ok: true, buzzedTeamId: gameState.buzzedTeamId, phase: gameState.phase };
}

// WebSocket Connection Management
wss.on('connection', (ws, req) => {
  // Send state immediately upon connection
  ws.send(JSON.stringify({ type: 'STATE', state: gameState }));

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'BUZZ') {
        const result = handleBuzz(data.teamId, data.ts);
        ws.send(JSON.stringify({ type: 'BUZZ_REPLY', result }));
      } else if (data.type === 'PASS_NEXT') {
        const result = handlePassNext();
        ws.send(JSON.stringify({ type: 'PASS_NEXT_REPLY', result }));
      } else if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', clientTs: data.clientTs, serverTs: Date.now() }));
      } else if (data.type === 'SET_STATE') {
        if (data.state) {
          gameState = data.state;
          persistState(true);
        }
      }
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  ws.on('error', err => {
    console.error('WS client error:', err);
  });
});

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
app.get('/api/state', (req, res) => {
  res.json(gameState);
});

app.post('/api/state', (req, res) => {
  try {
    gameState = req.body;
    persistState(true);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to write state:', e);
    res.status(500).json({ ok: false });
  }
});

// POST /api/buzz -> Atomic high-speed buzzer lock & multi-team queue
app.post('/api/buzz', (req, res) => {
  try {
    const { teamId, ts } = req.body;
    const result = handleBuzz(teamId, ts);
    return res.json(result);
  } catch (e) {
    console.error('Buzz endpoint error:', e);
    res.status(500).json({ ok: false });
  }
});

// POST /api/pass-next -> Pass to next team in queue
app.post('/api/pass-next', (req, res) => {
  try {
    const result = handlePassNext();
    return res.json(result);
  } catch (e) {
    console.error('Pass-next endpoint error:', e);
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

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }

  console.log('');
  console.log('  ======================================================');
  console.log('  TAIT Presents : WHO AM I? HIGH-SPEED SERVER READY ⚡');
  console.log('  ======================================================');
  console.log('');
  console.log(`  Local:     http://localhost:${PORT}/`);
  addresses.forEach(ip => console.log(`  Network:   http://${ip}:${PORT}/`));
  console.log(`  WebSocket: ws://localhost:${PORT}/ (Sub-millisecond Real-Time)`);
  console.log('');
  console.log('  Open the network URL above on the admin laptop, TV, and all 24 team phones.');
  console.log('  Multi-team buzzer queue, split-millisecond ranking & instant push active.');
  console.log('');
});

