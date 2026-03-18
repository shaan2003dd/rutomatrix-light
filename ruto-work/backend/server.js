// server.js
// Main backend server — Express + WebSocket
// Enhanced: recordings API, Dropbox integration, optimized binary streaming

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const adb = require('./adb-controller');
const deviceManager = require('./device-manager');
const dropbox = require('./dropbox-service');

const PORT = process.env.PORT || 8000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ─── Middleware ──────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── Status ──────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const [adbCheck, scrcpyCheck] = await Promise.all([adb.checkADB(), adb.checkScrcpy()]);
  res.json({
    server: 'running',
    adb: adbCheck,
    scrcpy: scrcpyCheck,
    dropbox: dropbox.isAvailable(),
    timestamp: Date.now(),
  });
});

// ─── Devices ─────────────────────────────────────────────────────
app.get('/api/devices', async (req, res) => {
  try {
    const devices = deviceManager.getDevices();
    if (devices.length === 0) await deviceManager.refreshDevices();
    res.json({ devices: deviceManager.getDevices() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:id', async (req, res) => {
  try {
    const info = await adb.getFullDeviceInfo(req.params.id);
    res.json({ deviceId: req.params.id, ...info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Device control endpoints
app.post('/api/devices/:id/keyevent',    async (req, res) => {
  const { keycode } = req.body;
  if (!keycode) return res.status(400).json({ error: 'keycode required' });
  res.json(await adb.sendKeyEvent(req.params.id, keycode));
});
app.post('/api/devices/:id/tap',         async (req, res) => {
  const { x, y } = req.body;
  if (x == null || y == null) return res.status(400).json({ error: 'x and y required' });
  res.json(await adb.sendTap(req.params.id, x, y));
});
app.post('/api/devices/:id/swipe',       async (req, res) => {
  const { x1, y1, x2, y2, duration } = req.body;
  res.json(await adb.sendSwipe(req.params.id, x1, y1, x2, y2, duration));
});
app.post('/api/devices/:id/text',        async (req, res) => {
  const { text } = req.body;
  if (text == null) return res.status(400).json({ error: 'text required' });
  res.json(await adb.sendText(req.params.id, text));
});
app.post('/api/devices/:id/power',       async (req, res) => res.json(await adb.pressPower(req.params.id)));
app.post('/api/devices/:id/volume-up',   async (req, res) => res.json(await adb.pressVolumeUp(req.params.id)));
app.post('/api/devices/:id/volume-down', async (req, res) => res.json(await adb.pressVolumeDown(req.params.id)));
app.post('/api/devices/:id/home',        async (req, res) => res.json(await adb.pressHome(req.params.id)));
app.post('/api/devices/:id/back',        async (req, res) => res.json(await adb.pressBack(req.params.id)));
app.post('/api/devices/:id/recents',     async (req, res) => res.json(await adb.pressRecents(req.params.id)));
app.post('/api/devices/:id/reboot',      async (req, res) => {
  const { mode } = req.body;
  res.json(mode === 'recovery' ? await adb.rebootRecovery(req.params.id) : await adb.reboot(req.params.id));
});

// Screenshot endpoint
app.get('/api/devices/:id/screenshot', (req, res) => {
  adb.takeScreenshot(req.params.id, (err, buffer) => {
    if (err) return res.status(500).json({ error: err.message });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename=screenshot-${req.params.id}-${Date.now()}.png`);
    res.send(buffer);
  });
});

// Orientation
app.get('/api/devices/:id/orientation', async (req, res) => {
  const rotation = await adb.getOrientation(req.params.id);
  res.json({ rotation });
});

// Foreground app
app.get('/api/devices/:id/foreground-app', async (req, res) => {
  const app_ = await adb.getForegroundApp(req.params.id);
  res.json({ app: app_ });
});

// Stream control
app.post('/api/devices/:id/start-stream', (req, res) => {
  try {
    deviceManager.startStreaming(req.params.id, req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/devices/:id/stop-stream', (req, res) => {
  deviceManager.stopStreaming(req.params.id);
  res.json({ success: true });
});

// ─── Local Recording Storage (always available) ──────────────────
const fs   = require('fs');
const LOCAL_REC_DIR = path.join(__dirname, '..', 'recordings');
if (!fs.existsSync(LOCAL_REC_DIR)) fs.mkdirSync(LOCAL_REC_DIR, { recursive: true });

function localList() {
  try {
    return fs.readdirSync(LOCAL_REC_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const full = path.join(LOCAL_REC_DIR, f);
        const stat = fs.statSync(full);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) {}
        return {
          recordingId: f.replace('.json', ''),
          name: f,
          path: `/local/${f}`,
          size: stat.size,
          serverModified: stat.mtime.toISOString(),
          deviceModel: meta.deviceModel || meta.deviceId || '—',
          duration: meta.duration || 0,
          eventCount: meta.events?.length || 0,
          source: 'local',
        };
      })
      .sort((a, b) => new Date(b.serverModified) - new Date(a.serverModified));
  } catch (e) {
    return [];
  }
}

// ─── Recordings API ───────────────────────────────────────────────

// List all recordings — local first, then Dropbox (newest first)
app.get('/api/recordings', async (req, res) => {
  const local = localList();

  let cloud = [];
  if (dropbox.isAvailable()) {
    const result = await dropbox.listRecordings();
    if (result.success) cloud = (result.recordings || []).map(r => ({ ...r, source: 'dropbox' }));
  }

  // Merge, deduplicate by recordingId, newest first
  const seen = new Set();
  const all = [...local, ...cloud].filter(r => {
    if (seen.has(r.recordingId)) return false;
    seen.add(r.recordingId);
    return true;
  }).sort((a, b) => new Date(b.serverModified) - new Date(a.serverModified));

  res.json({ success: true, recordings: all });
});

// Save a recording — always write locally, also sync to Dropbox if available
app.post('/api/recordings', async (req, res) => {
  const recording = req.body;
  if (!recording || !recording.events) {
    return res.status(400).json({ error: 'Invalid recording data' });
  }
  if (!recording.id) recording.id = uuidv4();
  if (!recording.createdAt) recording.createdAt = new Date().toISOString();

  // 1. Always save locally
  const filename = `recording-${recording.id}.json`;
  const localPath = path.join(LOCAL_REC_DIR, filename);
  try {
    fs.writeFileSync(localPath, JSON.stringify(recording, null, 2));
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to write local file: ' + e.message });
  }

  // 2. Also upload to Dropbox if configured (non-blocking — don't fail if it errors)
  let dropboxResult = null;
  if (dropbox.isAvailable()) {
    try {
      dropboxResult = await dropbox.uploadRecording(recording);
    } catch (e) {
      console.warn('[Recordings] Dropbox sync failed:', e.message);
    }
  }

  res.json({
    success: true,
    path: `/local/${filename}`,
    recordingId: recording.id,
    savedLocally: true,
    savedToDropbox: dropboxResult?.success || false,
  });
});

// Get a specific recording — check local first, then Dropbox
app.get('/api/recordings/:recpath(*)', async (req, res) => {
  const p = decodeURIComponent(req.params.recpath);

  // Local file
  if (p.startsWith('local/')) {
    const filename = p.replace('local/', '');
    const localPath = path.join(LOCAL_REC_DIR, filename);
    if (fs.existsSync(localPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        return res.json(data);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to read file' });
      }
    }
    return res.status(404).json({ error: 'Recording not found' });
  }

  // Dropbox path
  if (dropbox.isAvailable()) {
    const result = await dropbox.getRecording('/' + p);
    if (result.success) return res.json(result.recording);
  }
  res.status(404).json({ error: 'Recording not found' });
});

// Delete a recording
app.delete('/api/recordings/:recpath(*)', async (req, res) => {
  const p = decodeURIComponent(req.params.recpath);

  if (p.startsWith('local/')) {
    const filename = p.replace('local/', '');
    const localPath = path.join(LOCAL_REC_DIR, filename);
    try {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (dropbox.isAvailable()) {
    const result = await dropbox.deleteRecording('/' + p);
    return res.json(result);
  }
  res.status(404).json({ success: false, error: 'Not found' });
});

// Dropbox status
app.get('/api/dropbox/status', (req, res) => {
  res.json({
    available: dropbox.isAvailable(),
    configured: !!process.env.DROPBOX_ACCESS_TOKEN,
    folder: process.env.DROPBOX_FOLDER || '/AndroidTestRecordings',
    localDir: LOCAL_REC_DIR,
  });
});

// ─── WebSocket Handler ────────────────────────────────────────────
const activeStreams = new Map(); // wsId -> { deviceId, stream }

wss.on('connection', (ws) => {
  const wsId = uuidv4();
  ws.id = wsId;
  ws.isAlive = true;
  console.log(`[WS] Client connected: ${wsId}`);

  ws.send(JSON.stringify({ type: 'connected', wsId }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data, isBinary) => {
    // Binary messages not expected from client, only from server→client
    if (isBinary) return;

    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const { type, deviceId, payload } = msg;

    switch (type) {
      case 'subscribe_devices':
        ws.send(JSON.stringify({ type: 'devices', devices: deviceManager.getDevices() }));
        break;

      case 'start_stream': {
        if (!deviceId) break;
        const existing = activeStreams.get(wsId);
        if (existing) { existing.stream.stop(); activeStreams.delete(wsId); }

        const fps = payload?.fps || 20;
        const quality = payload?.quality || 55;
        const maxSize = payload?.maxSize || 480;

        const stream = deviceManager.startRawStream(deviceId, ws, { quality, maxSize, targetFps: fps }, wsId);
        activeStreams.set(wsId, { deviceId, stream });
        ws.send(JSON.stringify({ type: 'stream_started', deviceId }));

        try {
          const info = await adb.getFullDeviceInfo(deviceId);
          ws.send(JSON.stringify({ type: 'device_info', deviceId, ...info }));
        } catch (_) {}
        break;
      }

      case 'stop_stream': {
        const s = activeStreams.get(wsId);
        if (s) { s.stream.stop(); activeStreams.delete(wsId); }
        ws.send(JSON.stringify({ type: 'stream_stopped' }));
        break;
      }

      case 'keyevent':
        if (deviceId && payload?.keycode != null)
          await adb.sendKeyEvent(deviceId, payload.keycode);
        break;

      case 'tap':
        if (deviceId && payload?.x != null)
          await adb.sendTap(deviceId, payload.x, payload.y);
        break;

      case 'swipe':
        if (deviceId)
          await adb.sendSwipe(deviceId, payload.x1, payload.y1, payload.x2, payload.y2, payload.duration);
        break;

      case 'text':
        if (deviceId && payload?.text != null)
          await adb.sendText(deviceId, payload.text);
        break;

      case 'screenshot':
        if (!deviceId) break;
        adb.takeScreenshot(deviceId, (err, buffer) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'screenshot_error', error: err.message }));
          } else {
            ws.send(JSON.stringify({
              type: 'screenshot', deviceId,
              data: buffer.toString('base64'), timestamp: Date.now(),
            }));
          }
        });
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      // Quality control from client
      case 'set_stream_quality': {
        const s = activeStreams.get(wsId);
        if (s) {
          s.stream.stop();
          const newStream = deviceManager.startRawStream(
            s.deviceId, ws,
            { quality: payload.quality || 75, maxSize: payload.maxSize || 720, targetFps: payload.fps || 10 },
            wsId
          );
          activeStreams.set(wsId, { deviceId: s.deviceId, stream: newStream });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${wsId}`);
    const s = activeStreams.get(wsId);
    if (s) { s.stream.stop(); activeStreams.delete(wsId); }
  });

  ws.on('error', (err) => console.error(`[WS] Error ${wsId}:`, err.message));
});

// WebSocket heartbeat — kills dead connections quickly
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);
wss.on('close', () => clearInterval(heartbeat));

// ─── Broadcast helpers ────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

deviceManager.on('deviceConnected',     (d) => broadcast({ type: 'device_connected',      device: d     }));
deviceManager.on('deviceDisconnected',  (d) => broadcast({ type: 'device_disconnected',   device: d     }));
deviceManager.on('deviceStateChanged',  (d) => broadcast({ type: 'device_state_changed',  device: d     }));
deviceManager.on('streamingStarted',    (id) => broadcast({ type: 'streaming_started',    deviceId: id  }));
deviceManager.on('streamingStopped',    (id) => broadcast({ type: 'streaming_stopped',    deviceId: id  }));

// ─── Start Server ─────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║  Android Test Station Pro  —  Port ${PORT}     ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  const adbCheck = await adb.checkADB();
  console.log(adbCheck.available ? `✅ ADB ${adbCheck.version}` : '⚠️  ADB not found');

  const scrcpyCheck = await adb.checkScrcpy();
  console.log(scrcpyCheck.available ? `✅ scrcpy ${scrcpyCheck.version}` : '⚠️  scrcpy not found (screenshot fallback)');

  console.log(dropbox.isAvailable() ? '✅ Dropbox connected' : '⚠️  Dropbox not configured (set DROPBOX_ACCESS_TOKEN)');

  deviceManager.startPolling(3000);
  console.log('\n🔍 Polling devices every 3s...');
  console.log(`\n🌐 Open http://localhost:${PORT}\n`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[Server] Shutting down...');
  deviceManager.stopPolling();
  deviceManager.stopAllStreaming();
  server.close(() => { process.exit(0); });
}
