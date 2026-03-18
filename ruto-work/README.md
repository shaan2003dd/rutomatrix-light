# Android Test Station Pro

A low-latency Android screen streaming, control, and **test recording** system with Dropbox cloud storage and professional frontend.

---

## ✨ What's New (v2.0)

| Feature | Description |
|---|---|
| **Keystroke Recording** | Records every tap, swipe, keyevent, and text input with precise timestamps |
| **Dropbox Storage** | Recordings automatically upload to Dropbox, newest appear first |
| **Playback Controls** | Play, Pause, Stop, and variable speed (1×/1.5×/2×) for each recording |
| **Lower Latency** | JPEG compression pipeline cuts frame size by ~70%; adaptive FPS avoids backpressure |
| **Binary WebSocket Frames** | Skips base64 JSON overhead — raw binary delivery to browser |
| **Auto-Rotation** | Detects device orientation changes and auto-rotates the stream view |
| **Swipe Trail** | Visual green trace overlay when swiping on the canvas |
| **Stream Quality Sliders** | Live-adjust FPS, JPEG quality, and max resolution without restarting |
| **Pro Frontend** | Rebuilt UI with Syne + IBM Plex Mono, dark industrial aesthetic |

---

## 🚀 Quick Setup

### Prerequisites

- **Node.js** ≥ 16
- **ADB** (Android Platform Tools) — must be in `PATH`
- **Android device** with USB Debugging enabled
- **ImageMagick** _(optional, but strongly recommended for JPEG compression)_

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — see Dropbox Setup below

# 3. Start server
npm start
# or for development with auto-reload:
npm run dev

# 4. Open in browser
open http://localhost:8000
```

---

## 📦 Dropbox Setup (Required for Cloud Recordings)

1. Visit [https://www.dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
2. Click **Create app**
3. Choose:
   - API: **Scoped access**
   - Access type: **Full Dropbox**
   - Name: anything (e.g. `AndroidTestStation`)
4. In **Permissions** tab, enable:
   - `files.content.write`
   - `files.content.read`
   - `files.metadata.read`
   - `files.metadata.write`
5. In **Settings** tab → **OAuth 2** → click **Generate access token**
6. Copy the token into your `.env` file:

```env
DROPBOX_ACCESS_TOKEN=sl.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DROPBOX_FOLDER=/AndroidTestRecordings
```

> If Dropbox is not configured, the app still runs — the Recordings tab will show a warning banner and recordings won't be saved.

---

## 🔧 Latency Reduction Guide

### Enable ImageMagick (Recommended — ~3× faster frames)

ImageMagick converts PNG screenshots to JPEG on the fly, dramatically reducing payload size.

**macOS:**
```bash
brew install imagemagick
```

**Ubuntu/Debian:**
```bash
sudo apt install imagemagick
```

**Windows:**  
Download from [https://imagemagick.org/script/download.php](https://imagemagick.org/script/download.php)

After installation, JPEG compression activates automatically.

### Stream Quality Tuning

In the sidebar under **Stream Quality**:

| Setting | Low Latency | High Quality |
|---|---|---|
| FPS | 5–8 | 12–20 |
| Quality | 50–60% | 80–90% |
| Max Width | 480px | 720–1080px |

### Connection Tips

- Use **USB** (not wireless ADB) for best latency
- Disable unnecessary background apps on the device
- Run the server on the same machine as ADB

---

## 📹 Recording & Playback

### Recording a Session

1. Select a device from the sidebar
2. Click **Record** (or press `Ctrl+R`)
3. Interact with the device — all inputs are captured
4. Click **Stop Rec** to save to Dropbox

Each recording captures:
- Touch taps (with pixel coordinates)
- Swipe gestures (start/end + duration)
- Key events (power, home, back, volume, etc.)
- Text input
- Relative timestamps for accurate playback

### Viewing Recordings

1. Click **Recordings** tab in the header
2. All recordings are shown newest-first from Dropbox
3. Click **Play** to open the playback modal

### Playback Controls

| Control | Action |
|---|---|
| ▶ Play | Start/resume playback |
| ⏸ Pause | Pause, preserving position |
| ⏹ Stop | Reset to beginning |
| 1× / 1.5× / 2× | Speed multiplier |
| Progress bar | Shows elapsed vs total |
| Event log | Highlights current event |

> **Note:** A device must be connected and selected for playback to execute.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `F1` | Home key |
| `F2` | Back key |
| `F3` | Recents |
| `F4` | Power key |
| `Ctrl+R` | Start recording |
| `Ctrl+S` | Take screenshot |

---

## 🎮 Canvas Interactions

| Gesture | Action |
|---|---|
| Click | Tap at that position |
| Click + Drag | Swipe gesture (green trail shown) |
| Touch tap | Tap (mobile browser) |
| Touch drag | Swipe (mobile browser) |

---

## 📡 API Reference

### Stream
```
GET  /api/status                     — Server status
GET  /api/devices                    — List devices
POST /api/devices/:id/start-stream   — Start streaming
POST /api/devices/:id/stop-stream    — Stop streaming
GET  /api/devices/:id/screenshot     — Download screenshot
GET  /api/devices/:id/orientation    — Get rotation (0-3)
GET  /api/devices/:id/foreground-app — Current foreground app
```

### Device Control
```
POST /api/devices/:id/tap         { x, y }
POST /api/devices/:id/swipe       { x1, y1, x2, y2, duration }
POST /api/devices/:id/keyevent    { keycode }
POST /api/devices/:id/text        { text }
POST /api/devices/:id/home
POST /api/devices/:id/back
POST /api/devices/:id/power
POST /api/devices/:id/volume-up
POST /api/devices/:id/volume-down
POST /api/devices/:id/reboot      { mode?: "recovery" }
```

### Recordings
```
GET    /api/recordings              — List all (newest first)
POST   /api/recordings              — Save new recording
GET    /api/recordings/:path        — Get single recording
DELETE /api/recordings/:path        — Delete recording
GET    /api/dropbox/status          — Dropbox connection info
```

---

## 🏗️ Architecture

```
browser
  │
  ├── WebSocket (binary frames) ──→ ws://localhost:8000/ws
  │     ├── Binary: [4B header][JPEG/PNG data]
  │     └── JSON:  control messages, events
  │
  └── REST API ──────────────────→ http://localhost:8000/api

backend/server.js        — Express + WS server, recordings API
backend/device-manager.js — ADB streaming, adaptive FPS, orientation
backend/adb-controller.js — ADB wrapper, JPEG screenshot pipeline
backend/dropbox-service.js — Dropbox API v2 integration

frontend/index.html      — App shell, two-tab layout
frontend/app.js          — Streaming, recording, playback engine
frontend/style.css       — Syne + IBM Plex Mono, dark industrial theme
```

---

## 🛠 Troubleshooting

**Device not showing up**
```bash
adb devices  # Should list your device
adb kill-server && adb start-server  # Reset ADB
```

**Slow/laggy stream**
- Install ImageMagick for JPEG compression
- Lower quality to 55% and FPS to 6 in the sidebar sliders
- Check USB cable — use USB 3.0 if possible

**Recordings not saving**
- Check Dropbox token in `.env` — must have write permissions
- Look at server console for `[Dropbox]` errors
- Try regenerating the token in the Dropbox developer console

**WebSocket keeps disconnecting**
- The server auto-pings every 10s; dead connections are cleaned up
- Browser auto-reconnects every 3s
- Check for firewall rules blocking WebSocket on port 8000
