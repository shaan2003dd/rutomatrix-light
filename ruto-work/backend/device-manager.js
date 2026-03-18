// device-manager.js
// Manages device tracking, streaming sessions, and scrcpy processes
// Enhanced: adaptive JPEG streaming, lower latency, orientation detection

const { spawn } = require('child_process');
const EventEmitter = require('events');
const adb = require('./adb-controller');

class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();           // deviceId -> device info
    this.streamingSessions = new Map(); // deviceId -> scrcpy process
    this.rawStreams = new Map();        // wsId -> { stop }
    this.pollInterval = null;
    this.adbPath = process.env.ADB_PATH || 'adb';
    this.scrcpyPath = process.env.SCRCPY_PATH || 'scrcpy';
  }

  startPolling(intervalMs = 3000) {
    this.pollInterval = setInterval(() => this.refreshDevices(), intervalMs);
    this.refreshDevices();
  }

  stopPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  async refreshDevices() {
    try {
      const deviceList = await adb.getDevices();
      const currentIds = new Set(deviceList.map(d => d.id));
      const previousIds = new Set(this.devices.keys());

      for (const device of deviceList) {
        if (!previousIds.has(device.id)) {
          if (device.state === 'device') {
            try {
              const info = await adb.getFullDeviceInfo(device.id);
              device.info = info;
            } catch (e) {
              device.info = {};
            }
          }
          this.devices.set(device.id, device);
          this.emit('deviceConnected', device);
          console.log(`[DeviceManager] Device connected: ${device.id} (${device.model})`);
        } else {
          const existing = this.devices.get(device.id);
          if (existing.state !== device.state) {
            existing.state = device.state;
            this.emit('deviceStateChanged', existing);
          }
        }
      }

      for (const id of previousIds) {
        if (!currentIds.has(id)) {
          const device = this.devices.get(id);
          this.devices.delete(id);
          this.stopStreaming(id);
          this.emit('deviceDisconnected', device);
          console.log(`[DeviceManager] Device disconnected: ${id}`);
        }
      }
    } catch (err) {
      console.error('[DeviceManager] Error refreshing devices:', err.message);
    }
  }

  getDevices()       { return Array.from(this.devices.values()); }
  getDevice(id)      { return this.devices.get(id) || null;      }
  isStreaming(id)    { return this.streamingSessions.has(id);    }

  startStreaming(deviceId, options = {}) {
    if (this.streamingSessions.has(deviceId)) {
      return this.streamingSessions.get(deviceId);
    }

    const {
      maxSize = 1080, bitrate = '4M', maxFps = 60,
      noAudio = true, noControl = false,
    } = options;

    const args = [
      '-s', deviceId,
      '--max-size', maxSize.toString(),
      '--bit-rate', bitrate,
      '--max-fps', maxFps.toString(),
      '--window-title', `Android-${deviceId}`,
      '--window-x', '9999', '--window-y', '9999',
      '--window-width', '1', '--window-height', '1',
    ];
    if (noAudio) args.push('--no-audio');
    if (noControl) args.push('--no-control');

    const proc = spawn(this.scrcpyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => console.log(`[scrcpy:${deviceId}] ${d.toString().trim()}`));
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.log(`[scrcpy:${deviceId}] ${m}`); });
    proc.on('close', (code) => {
      console.log(`[scrcpy:${deviceId}] exited ${code}`);
      this.streamingSessions.delete(deviceId);
      this.emit('streamingStopped', deviceId);
    });
    proc.on('error', (err) => {
      console.error(`[scrcpy:${deviceId}] Error: ${err.message}`);
      this.streamingSessions.delete(deviceId);
      this.emit('streamingError', { deviceId, error: err.message });
    });

    this.streamingSessions.set(deviceId, proc);
    this.emit('streamingStarted', deviceId);
    return proc;
  }

  stopStreaming(deviceId) {
    const proc = this.streamingSessions.get(deviceId);
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 3000);
      this.streamingSessions.delete(deviceId);
    }
  }

  // ─── Optimized Raw Stream ────────────────────────────────────────
  // Uses JPEG where possible for 3–5× smaller payloads → lower latency
  // Backpressure-aware: skips frames when WS buffer is congested
  startRawStream(deviceId, ws, options = {}, wsId) {
    const {
      quality = 55,            // Lower default quality → smaller payload → less latency
      maxSize = 480,           // Reduced default size for lower latency
      targetFps = 20,          // Higher FPS default
    } = options;

    let running = true;
    let frameCount = 0;
    let inFlight = false;
    let lastOrientation = -1;
    let consecutiveSkips = 0;

    const frameInterval = Math.floor(1000 / targetFps); // ms per frame target
    const WS_BACKPRESSURE_LIMIT = 150 * 1024; // 150KB — skip frame if buffer too full

    const sendFrame = () => {
      if (!running || ws.readyState !== 1) { running = false; return; }

      // Backpressure detection: if WS buffer is backed up, skip this frame
      if (ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
        consecutiveSkips++;
        setTimeout(sendFrame, Math.min(frameInterval * 2, 200));
        return;
      }
      consecutiveSkips = 0;

      if (inFlight) {
        // Still waiting for previous capture — adaptive skip
        setTimeout(sendFrame, Math.max(frameInterval / 2, 16));
        return;
      }

      inFlight = true;
      const captureStart = Date.now();

      adb.takeJpegScreenshot(deviceId, quality, maxSize, (err, buffer, format) => {
        inFlight = false;
        if (!running || ws.readyState !== 1) return;

        if (err || !buffer) {
          if (running) setTimeout(sendFrame, 500);
          return;
        }

        frameCount++;

        try {
          // Binary frame: 4-byte header + image data
          // Byte 0: format (0=png, 1=jpeg)
          // Byte 1: reserved
          // Bytes 2-3: frame count (16-bit big-endian)
          const formatByte = format === 'jpeg' ? 1 : 0;
          const header = Buffer.alloc(4);
          header.writeUInt8(formatByte, 0);
          header.writeUInt8(0, 1);
          header.writeUInt16BE(frameCount & 0xFFFF, 2);
          ws.send(Buffer.concat([header, buffer]), { binary: true });
        } catch (e) {
          // Binary failed, fallback to JSON base64
          try {
            ws.send(JSON.stringify({
              type: 'frame',
              format: format || 'png',
              data: buffer.toString('base64'),
              frameIndex: frameCount,
              timestamp: Date.now(),
            }));
          } catch (_) {}
        }

        if (running) {
          const elapsed = Date.now() - captureStart;
          // If capture was fast → honor frame interval. If slow → go immediately.
          const delay = Math.max(0, frameInterval - elapsed);
          if (delay === 0) setImmediate(sendFrame);
          else setTimeout(sendFrame, delay);
        }
      });
    };

    // Check orientation every 4s (less often = less overhead)
    const orientationInterval = setInterval(async () => {
      if (!running) return;
      try {
        const orient = await adb.getOrientation(deviceId);
        if (orient !== lastOrientation) {
          lastOrientation = orient;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'orientation_changed', rotation: orient }));
          }
        }
      } catch (_) {}
    }, 4000);

    sendFrame();
    if (wsId) this.rawStreams.set(wsId, { deviceId });

    return {
      stop: () => {
        running = false;
        clearInterval(orientationInterval);
        if (wsId) this.rawStreams.delete(wsId);
      },
    };
  }

  stopAllStreaming() {
    for (const [deviceId] of this.streamingSessions) this.stopStreaming(deviceId);
  }
}

module.exports = new DeviceManager();
