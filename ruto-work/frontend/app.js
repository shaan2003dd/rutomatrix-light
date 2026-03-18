// app.js — Android Test Station Pro
// Features: optimized streaming, keystroke recording, Dropbox playback, auto-rotation

class AndroidTestStation {
  constructor() {
    // Core state
    this.ws          = null;
    this.wsId        = null;
    this.selectedDevice = null;
    this.devices     = [];
    this.isStreaming = false;
    this.activeTab   = 'stream';

    // Canvas & rendering
    this.canvas      = document.getElementById('streamCanvas');
    this.ctx         = this.canvas.getContext('2d');
    this.touchCanvas = document.getElementById('touchCanvas');
    this.touchCtx    = this.touchCanvas.getContext('2d');
    this.deviceRes   = null;
    this.scaleX      = 1;
    this.scaleY      = 1;
    this.rotation    = 0;     // Current display rotation (0/1/2/3)
    this.autoRotate  = false; // Auto-rotate follows device orientation

    // Stats
    this.frameCount  = 0;
    this.fpsCounter  = 0;
    this.lastLatency = 0;
    this.pingStart   = 0;

    // Timers
    this.pingInterval    = null;
    this.fpsTimer        = null;
    this.batteryTimer    = null;
    this.wsReconnectTimer = null;

    // Touch tracking
    this.touchStart  = null;
    this.swipeTrail  = [];

    // ── Recording state ──────────────────────────────────────
    this.isRecording      = false;
    this.isRecordingPaused = false;
    this.recordingEvents  = [];
    this.recordingStart   = 0;
    this.recTimerInterval = null;

    // ── Playback state ───────────────────────────────────────
    this.playbackRecording = null;
    this.playbackPaused    = false;
    this.playbackSpeed     = 1;
    this.playbackHandle    = null; // timeout for next event
    this.playbackIndex     = 0;
    this.playbackOffset    = 0;   // ms elapsed when paused

    // ── ImageBitmap decode queue (for low-latency rendering) ─
    this._pendingFrame   = null;
    this._decoding       = false;

    this.init();
  }

  init() {
    this.setupWebSocket();
    this.setupCanvasEvents();
    this.setupKeyboardShortcuts();
    this.setupTextInput();
    this.setupQualitySliders();
    this.setupFpsCounter();
    this.loadDevices();

    setInterval(() => this.loadDevices(), 5000);
    this.batteryTimer = setInterval(() => {
      if (this.selectedDevice) this.refreshBattery();
    }, 30000);

    this.checkDropboxStatus();
  }

  // ─── Tab Navigation ────────────────────────────────────────
  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-view').forEach(v => v.classList.toggle('active', v.id === `tab${tab.charAt(0).toUpperCase()+tab.slice(1)}`));
    if (tab === 'recordings') this.loadRecordings();
  }

  // ─── WebSocket ─────────────────────────────────────────────
  setupWebSocket() {
    const url = `ws://${window.location.host}/ws`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer'; // Use binary for frames

    this.ws.onopen = () => {
      this.setConnectionStatus(true);
      clearTimeout(this.wsReconnectTimer);
      this.ws.send(JSON.stringify({ type: 'subscribe_devices' }));

      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.pingStart = Date.now();
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 4000);
    };

    this.ws.onmessage = (event) => {
      // Binary frame (optimized path)
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryFrame(event.data);
        return;
      }
      // JSON message
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error', e);
      }
    };

    this.ws.onclose = () => {
      this.setConnectionStatus(false);
      clearInterval(this.pingInterval);
      this.wsReconnectTimer = setTimeout(() => this.setupWebSocket(), 3000);
    };

    this.ws.onerror = () => {};
  }

  // Binary frame: [4-byte header][image data]
  // Header byte 0: 0=png, 1=jpeg
  handleBinaryFrame(buffer) {
    const view = new DataView(buffer);
    const format = view.getUint8(0); // 0=png, 1=jpeg
    const mime = format === 1 ? 'image/jpeg' : 'image/png';
    const imageData = buffer.slice(4);
    const blob = new Blob([imageData], { type: mime });

    // Use createImageBitmap for async off-thread decode
    if (this._decoding) {
      this._pendingFrame = blob; // Queue only the latest
      return;
    }
    this._decodeBitmap(blob);
  }

  _decodeBitmap(blob) {
    this._decoding = true;
    createImageBitmap(blob).then((bitmap) => {
      this._decoding = false;

      this._renderBitmap(bitmap);
      bitmap.close();

      // If a newer frame queued up, process it
      if (this._pendingFrame) {
        const next = this._pendingFrame;
        this._pendingFrame = null;
        this._decodeBitmap(next);
      }
    }).catch(() => {
      this._decoding = false;
    });
  }

  _renderBitmap(bitmap) {
    const loading = document.getElementById('streamLoading');
    if (loading.style.display !== 'none') loading.style.display = 'none';

    this.frameCount++;
    this.fpsCounter++;

    // Resize canvas to fit container whenever source dimensions change
    if (!this.deviceRes ||
        this._lastBitmapW !== bitmap.width ||
        this._lastBitmapH !== bitmap.height) {
      this._lastBitmapW = bitmap.width;
      this._lastBitmapH = bitmap.height;
      this.setCanvasSize(bitmap.width, bitmap.height);
    }

    const cw = this.canvas.width;
    const ch = this.canvas.height;

    if (this.rotation === 0) {
      // Fast path — no transform needed
      this.ctx.drawImage(bitmap, 0, 0, cw, ch);
    } else {
      // Rotated: draw centered, rotated, then scaled to canvas
      this.ctx.save();
      this.ctx.translate(cw / 2, ch / 2);
      this.ctx.rotate((this.rotation * 90 * Math.PI) / 180);
      // When rotated 90/270 the logical w/h are swapped
      const isOdd = this.rotation % 2 !== 0;
      const dw = isOdd ? ch : cw;
      const dh = isOdd ? cw : ch;
      this.ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
      this.ctx.restore();
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this.wsId = msg.wsId;
        break;

      case 'devices':
        this.devices = msg.devices || [];
        this.renderDeviceList();
        break;

      case 'device_connected':
        this.toast(`📱 ${msg.device.model || msg.device.id} connected`, 'success');
        this.devices.push(msg.device);
        this.renderDeviceList();
        break;

      case 'device_disconnected':
        this.toast(`📵 ${msg.device?.id} disconnected`, 'warn');
        this.devices = this.devices.filter(d => d.id !== msg.device?.id);
        if (this.selectedDevice === msg.device?.id) {
          this.selectedDevice = null;
          this.updateStreamUI(false);
        }
        this.renderDeviceList();
        break;

      case 'device_info':
        this.applyDeviceInfo(msg);
        break;

      case 'stream_started':
        this.isStreaming = true;
        this.updateStreamUI(true);
        break;

      case 'stream_stopped':
        this.isStreaming = false;
        this.updateStreamUI(false);
        break;

      // Fallback: JSON base64 frame (if binary not supported)
      case 'frame':
        this.handleJsonFrame(msg);
        break;

      case 'orientation_changed':
        if (this.autoRotate) this.applyRotation(msg.rotation);
        break;

      case 'screenshot':
        this.downloadScreenshot(msg.data);
        break;

      case 'screenshot_error':
        this.toast('Screenshot failed: ' + msg.error, 'error');
        break;

      case 'pong':
        this.lastLatency = Date.now() - this.pingStart;
        document.getElementById('latencyDisplay').textContent = this.lastLatency;
        break;
    }
  }

  handleJsonFrame(msg) {
    const mime = msg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const byteStr = atob(msg.data);
    const ab = new ArrayBuffer(byteStr.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
    const blob = new Blob([ab], { type: mime });
    if (this._decoding) { this._pendingFrame = blob; return; }
    this._decodeBitmap(blob);
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ─── Devices ───────────────────────────────────────────────
  async loadDevices() {
    try {
      const res = await fetch('/api/devices');
      const data = await res.json();
      this.devices = data.devices || [];
      this.renderDeviceList();
    } catch (_) {}
  }

  renderDeviceList() {
    const list    = document.getElementById('deviceList');
    const empty   = document.getElementById('noDevices');
    const count   = document.getElementById('deviceCount');

    count.textContent = this.devices.length;
    if (!this.devices.length) {
      list.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = this.devices.map(d => `
      <div class="device-item ${this.selectedDevice===d.id?'selected':''} ${d.state!=='device'?'disabled':''}"
           onclick="app.selectDevice('${d.id}')">
        <div class="device-thumb">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="4" y="1" width="12" height="18" rx="2"/><circle cx="10" cy="16" r="1" fill="currentColor"/><line x1="7" y1="5" x2="13" y2="5"/></svg>
        </div>
        <div class="device-meta">
          <div class="device-meta-name">${d.info?.model || d.model || d.id}</div>
          <div class="device-meta-id">${d.id}</div>
        </div>
        <div class="device-tag ${d.state}">${d.state}</div>
      </div>
    `).join('');
  }

  async selectDevice(deviceId) {
    this.selectedDevice = deviceId;
    this.renderDeviceList();
    if (this.isStreaming) this.stopStream();

    try {
      const res = await fetch(`/api/devices/${deviceId}`);
      const info = await res.json();
      this.applyDeviceInfo({ deviceId, ...info });
    } catch (_) {}

    document.getElementById('streamPlaceholder').style.display = 'none';
    document.getElementById('startStreamBtn').disabled = false;
    document.getElementById('screenshotBtn').disabled = false;
    document.getElementById('startRecBtn').disabled = false;
    document.getElementById('deviceInfoPanel').style.display = 'block';
    this.toast(`Selected: ${deviceId}`, 'info');
  }

  applyDeviceInfo(info) {
    const { resolution, androidVersion, model, battery, density, orientation } = info;
    if (resolution) {
      this.deviceRes = resolution;
      document.getElementById('dRes').textContent = `${resolution.width}×${resolution.height}`;
      this.setCanvasSize(resolution.width, resolution.height);
    }
    if (androidVersion) document.getElementById('dAndroid').textContent = `Android ${androidVersion}`;
    if (model) {
      document.getElementById('dModel').textContent = model;
      document.getElementById('deviceModelDisplay') && (document.getElementById('deviceModelDisplay').textContent = model);
    }
    if (battery) this.updateBattery(battery);
    if (density) document.getElementById('dDpi').textContent = `${density} dpi`;
    if (orientation != null) {
      this.applyRotation(orientation);
    }
  }

  async refreshBattery() {
    if (!this.selectedDevice) return;
    try {
      const res = await fetch(`/api/devices/${this.selectedDevice}`);
      const data = await res.json();
      if (data.battery) this.updateBattery(data.battery);
    } catch (_) {}
  }

  updateBattery(battery) {
    const icon = battery.charging ? '⚡' : '🔋';
    document.getElementById('batteryDisplay').textContent = `${battery.level ?? '--'}%`;
    document.getElementById('dBattery').textContent = `${icon} ${battery.level ?? '--'}%`;
  }

  // ─── Streaming ─────────────────────────────────────────────
  startStream() {
    if (!this.selectedDevice) { this.toast('Select a device first', 'warn'); return; }
    document.getElementById('startStreamBtn').disabled = true;
    document.getElementById('stopStreamBtn').disabled = false;
    document.getElementById('streamLoading').style.display = 'flex';

    const fps  = parseInt(document.getElementById('fpsSetting').value);
    const qual = parseInt(document.getElementById('qualSetting').value);
    const size = parseInt(document.getElementById('sizeSetting').value);

    this.frameCount = 0; this.fpsCounter = 0;

    this.send({
      type: 'start_stream',
      deviceId: this.selectedDevice,
      payload: { fps, quality: qual, maxSize: size },
    });
  }

  stopStream() {
    this.send({ type: 'stop_stream' });
    this.isStreaming = false;
    this.updateStreamUI(false);
  }

  updateStreamUI(active) {
    document.getElementById('startStreamBtn').disabled = active;
    document.getElementById('stopStreamBtn').disabled = !active;
    const badge = document.getElementById('streamBadge');
    badge.textContent = active ? 'LIVE' : 'IDLE';
    badge.setAttribute('data-state', active ? 'live' : 'idle');
    if (!active) document.getElementById('streamLoading').style.display = 'none';
  }

  // ─── Canvas ─────────────────────────────────────────────────
  setCanvasSize(w, h) {
    const container = document.getElementById('streamContainer');
    const maxW = container.clientWidth  || 600;
    const maxH = container.clientHeight || 800;

    // If rotated 90/270, swap dimensions
    const isLandscape = this.rotation % 2 !== 0;
    const effW = isLandscape ? h : w;
    const effH = isLandscape ? w : h;

    const scale = Math.min(maxW / effW, maxH / effH, 1);
    const cw = Math.round(effW * scale);
    const ch = Math.round(effH * scale);

    this.canvas.width  = cw;
    this.canvas.height = ch;
    this.canvas.style.width  = cw + 'px';
    this.canvas.style.height = ch + 'px';
    this.touchCanvas.width   = cw;
    this.touchCanvas.height  = ch;

    this.scaleX = (this.deviceRes?.width  || w) / cw;
    this.scaleY = (this.deviceRes?.height || h) / ch;

    const rotText = ['Portrait', 'Landscape ↺', 'Portrait ↷', 'Landscape ↻'];
    document.getElementById('dRotation').textContent = rotText[this.rotation] || 'Portrait';
  }

  applyRotation(rot) {
    this.rotation = rot % 4;
    if (this.deviceRes) this.setCanvasSize(this.deviceRes.width, this.deviceRes.height);
    document.getElementById('dRotation').textContent = ['Portrait','Landscape ↺','Portrait ↷','Landscape ↻'][this.rotation];
  }

  rotateManual() {
    this.rotation = (this.rotation + 1) % 4;
    if (this.deviceRes) this.setCanvasSize(this.deviceRes.width, this.deviceRes.height);
  }

  toggleAutoRotate() {
    this.autoRotate = !this.autoRotate;
    const btn = document.getElementById('autoRotateBtn');
    btn.style.background = this.autoRotate ? 'var(--acid-dim)' : '';
    btn.style.borderColor = this.autoRotate ? 'rgba(163,240,0,0.3)' : '';
    btn.style.color = this.autoRotate ? 'var(--acid)' : '';
    this.toast(`Auto-rotate ${this.autoRotate ? 'ON' : 'OFF'}`, 'info');
  }

  // ─── Canvas Touch/Mouse Events ──────────────────────────────
  setupCanvasEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (!this.isStreaming) return;
      this.touchStart = this.getCoords(e);
      this.swipeTrail = [this.touchStart];
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.touchStart || !this.isStreaming) return;
      const pos = this.getCoords(e);
      this.swipeTrail.push(pos);
      this.drawSwipeTrail();
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!this.touchStart || !this.isStreaming) return;
      const end = this.getCoords(e);
      const dx = Math.abs(end.x - this.touchStart.x);
      const dy = Math.abs(end.y - this.touchStart.y);

      if (dx > 15 || dy > 15) {
        this.sendSwipe(this.touchStart.x, this.touchStart.y, end.x, end.y, 300);
      } else {
        this.sendTap(end.x, end.y);
      }

      this.touchStart = null;
      this.swipeTrail = [];
      setTimeout(() => this.clearTouchOverlay(), 400);
    });

    canvas.addEventListener('mouseleave', () => {
      this.touchStart = null;
      this.clearTouchOverlay();
    });

    // Touch events
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!this.isStreaming) return;
      this.touchStart = this.getTouchCoords(e.touches[0]);
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (!this.touchStart || !this.isStreaming) return;
      const end = this.getTouchCoords(e.changedTouches[0]);
      const dx = Math.abs(end.x - this.touchStart.x);
      const dy = Math.abs(end.y - this.touchStart.y);
      if (dx < 15 && dy < 15) this.sendTap(end.x, end.y);
      else this.sendSwipe(this.touchStart.x, this.touchStart.y, end.x, end.y, 300);
      this.touchStart = null;
    }, { passive: false });
  }

  getCoords(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * this.scaleX),
      y: Math.round((e.clientY - r.top)  * this.scaleY),
    };
  }

  getTouchCoords(touch) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.round((touch.clientX - r.left) * this.scaleX),
      y: Math.round((touch.clientY - r.top)  * this.scaleY),
    };
  }

  drawSwipeTrail() {
    this.clearTouchOverlay();
    const ctx = this.touchCtx;
    if (this.swipeTrail.length < 2) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(163,240,0,0.6)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const scaleBack = 1 / this.scaleX;
    ctx.moveTo(this.swipeTrail[0].x * scaleBack, this.swipeTrail[0].y * (1/this.scaleY));
    for (let i = 1; i < this.swipeTrail.length; i++) {
      ctx.lineTo(this.swipeTrail[i].x * scaleBack, this.swipeTrail[i].y * (1/this.scaleY));
    }
    ctx.stroke();
    ctx.restore();
  }

  clearTouchOverlay() {
    this.touchCtx.clearRect(0, 0, this.touchCanvas.width, this.touchCanvas.height);
  }

  // ─── ADB Actions (recording-aware) ─────────────────────────
  sendTap(x, y) {
    if (!this.selectedDevice) return;
    const event = { type: 'tap', x, y, timestamp: this.recordTs() };
    this.recordEvent(event);
    this.send({ type: 'tap', deviceId: this.selectedDevice, payload: { x, y } });
  }

  sendSwipe(x1, y1, x2, y2, duration = 300) {
    if (!this.selectedDevice) return;
    const event = { type: 'swipe', x1, y1, x2, y2, duration, timestamp: this.recordTs() };
    this.recordEvent(event);
    this.send({ type: 'swipe', deviceId: this.selectedDevice, payload: { x1, y1, x2, y2, duration } });
  }

  sendKey(keycode) {
    if (!this.selectedDevice) return;
    const event = { type: 'keyevent', keycode, timestamp: this.recordTs() };
    this.recordEvent(event);
    this.send({ type: 'keyevent', deviceId: this.selectedDevice, payload: { keycode } });
  }

  sendText(text) {
    if (!this.selectedDevice || !text) return;
    const event = { type: 'text', text, timestamp: this.recordTs() };
    this.recordEvent(event);
    this.send({ type: 'text', deviceId: this.selectedDevice, payload: { text } });
  }

  // ─── Recording ─────────────────────────────────────────────
  recordTs() {
    if (!this.isRecording) return 0;
    return Date.now() - this.recordingStart;
  }

  recordEvent(event) {
    if (this.isRecording && !this.isRecordingPaused) {
      this.recordingEvents.push(event);
      // Flash the event counter to confirm capture
      const el = document.getElementById('recEventCount');
      if (el) {
        el.textContent = `${this.recordingEvents.length} events`;
        el.style.color = 'var(--acid)';
        clearTimeout(this._recFlashTimer);
        this._recFlashTimer = setTimeout(() => { el.style.color = ''; }, 300);
      }
    }
  }

  startRecording() {
    if (!this.selectedDevice) { this.toast('Select a device first', 'warn'); return; }

    // Must be streaming — recording only captures events sent through the PC interface
    if (!this.isStreaming) {
      this.toast('Start the stream first — recording captures your PC interactions', 'warn');
      // Auto-start stream for them
      this.startStream();
      // Small delay to let stream handshake complete, then begin recording
      setTimeout(() => {
        if (this.selectedDevice) this._beginRecording();
      }, 800);
      return;
    }
    this._beginRecording();
  }

  _beginRecording() {
    this.isRecording      = true;
    this.isRecordingPaused = false;
    this.recordingEvents  = [];
    this.recordingStart   = Date.now();

    document.getElementById('startRecBtn').style.display = 'none';
    document.getElementById('stopRecBtn').style.display  = '';
    document.getElementById('recChip').style.display     = '';
    document.getElementById('recBar').style.display      = 'flex';
    document.getElementById('recDevice').textContent     = this.selectedDevice;
    document.getElementById('pauseRecBtn').style.display  = '';
    document.getElementById('resumeRecBtn').style.display = 'none';
    document.getElementById('recEventCount').textContent  = '0 events';

    let elapsed = 0;
    this.recTimerInterval = setInterval(() => {
      if (!this.isRecordingPaused) elapsed++;
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      document.getElementById('recTimer').textContent     = `${m}:${s}`;
      document.getElementById('recEventCount').textContent = `${this.recordingEvents.length} events`;
    }, 1000);

    this.toast('🔴 Recording — interact via canvas or control buttons', 'success');
  }

  pauseRecording() {
    if (!this.isRecording || this.isRecordingPaused) return;
    this.isRecordingPaused = true;
    document.getElementById('pauseRecBtn').style.display = 'none';
    document.getElementById('resumeRecBtn').style.display = '';
    this.toast('Recording paused', 'info');
  }

  resumeRecording() {
    if (!this.isRecording || !this.isRecordingPaused) return;
    this.isRecordingPaused = false;
    document.getElementById('pauseRecBtn').style.display = '';
    document.getElementById('resumeRecBtn').style.display = 'none';
    this.toast('Recording resumed', 'success');
  }

  discardRecording() {
    if (!this.isRecording) return;
    if (!confirm('Discard this recording? All events will be lost.')) return;
    this.isRecording = false;
    this.isRecordingPaused = false;
    this.recordingEvents = [];
    clearInterval(this.recTimerInterval);
    document.getElementById('startRecBtn').style.display = '';
    document.getElementById('stopRecBtn').style.display = 'none';
    document.getElementById('recChip').style.display = 'none';
    document.getElementById('recBar').style.display = 'none';
    document.getElementById('pauseRecBtn').style.display = '';
    document.getElementById('resumeRecBtn').style.display = 'none';
    this.toast('Recording discarded', 'warn');
  }

  async stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.isRecordingPaused = false;
    clearInterval(this.recTimerInterval);

    document.getElementById('startRecBtn').style.display = '';
    document.getElementById('stopRecBtn').style.display = 'none';
    document.getElementById('recChip').style.display = 'none';
    document.getElementById('recBar').style.display = 'none';
    document.getElementById('pauseRecBtn').style.display = '';
    document.getElementById('resumeRecBtn').style.display = 'none';

    if (this.recordingEvents.length === 0) {
      this.toast('No events captured — interact via the stream canvas or control buttons while recording', 'warn');
      return;
    }

    const device = this.devices.find(d => d.id === this.selectedDevice);
    const recording = {
      id: this.generateId(),
      deviceId: this.selectedDevice,
      deviceModel: device?.info?.model || device?.model || this.selectedDevice,
      androidVersion: document.getElementById('dAndroid').textContent,
      startTime: this.recordingStart,
      endTime: Date.now(),
      duration: Date.now() - this.recordingStart,
      events: this.recordingEvents,
      createdAt: new Date().toISOString(),
    };

    this.toast('Saving recording…', 'info');
    try {
      const res = await fetch('/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recording),
      });
      const data = await res.json();
      if (data.success) {
        const where = data.savedToDropbox ? '✅ Saved to Dropbox + local' : '✅ Saved locally';
        this.toast(`${where} (${this.recordingEvents.length} events)`, 'success');
      } else {
        this.toast('Save failed: ' + (data.error || 'Unknown'), 'error');
      }
    } catch (e) {
      this.toast('Network error saving recording', 'error');
    }
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ─── Dropbox Recordings List ────────────────────────────────
  async checkDropboxStatus() {
    try {
      const res = await fetch('/api/dropbox/status');
      const data = await res.json();
      const notice = document.getElementById('dropboxNotice');
      const text   = document.getElementById('dropboxStatusText');

      if (!data.available) {
        notice.style.display = 'flex';
        text.textContent = `Saving locally → ${data.localDir || 'recordings/'}`;
      } else {
        notice.style.display = 'none';
        text.textContent = `Dropbox synced · ${data.folder} · also saved locally`;
      }
    } catch (_) {}
  }

  async loadRecordings() {
    const list  = document.getElementById('recordingsList');
    const empty = document.getElementById('recordingsEmpty');

    list.innerHTML = '<div style="padding:20px;text-align:center"><div class="loader"></div></div>';
    empty.style.display = 'none';

    try {
      const res = await fetch('/api/recordings');
      const data = await res.json();

      if (!data.success || !data.recordings?.length) {
        list.innerHTML = '';
        empty.style.display = 'flex';
        document.getElementById('recCount').style.display = 'none';
        return;
      }

      const recordings = data.recordings;
      const countEl = document.getElementById('recCount');
      countEl.style.display = '';
      countEl.textContent = recordings.length;

      list.innerHTML = recordings.map((r, i) => {
        const date = new Date(r.serverModified).toLocaleString();
        const name = r.name.replace('recording-', '').replace('.json', '');
        const dur  = r.duration ? this.formatDuration(r.duration) : '—';
        const evts = r.eventCount != null ? `${r.eventCount} events` : '';
        return `
          <div class="rec-card" data-path="${r.path}">
            <div class="rec-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" opacity=".3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/></svg>
            </div>
            <div class="rec-card-info">
              <div class="rec-card-name">Recording ${i+1} — ${name.slice(0,12)}</div>
              <div class="rec-card-meta">
                <span class="rec-m-device">${r.deviceModel || r.recordingId.slice(0,8)}</span>
                <span>${date}</span>
                <span>${dur}</span>
                ${evts ? `<span class="rec-m-events">${evts}</span>` : ''}
                <span>${Math.round(r.size/1024)} KB</span>
              </div>
            </div>
            <div class="rec-card-actions">
              <button class="btn btn-success btn-sm" onclick="app.openPlayback('${r.path}')">
                <svg class="bi" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l8 4-8 4V4z"/></svg>
                Play
              </button>
              <button class="btn btn-danger btn-sm" onclick="app.deleteRecording('${r.path}', this)">
                <svg class="bi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="2,4 14,4"/><path d="M5 4V2h6v2M6 7v5M10 7v5"/><path d="M3 4l1 10h8l1-10"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red);font-size:13px">Error loading recordings</div>';
    }
  }

  async deleteRecording(dropboxPath, btn) {
    if (!confirm('Delete this recording?')) return;
    btn.disabled = true;
    try {
      const encoded = encodeURIComponent(dropboxPath.replace(/^\//, ''));
      const res = await fetch(`/api/recordings/${encoded}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.toast('Recording deleted', 'success');
        this.loadRecordings();
      } else {
        this.toast('Delete failed: ' + data.error, 'error');
      }
    } catch (e) {
      this.toast('Network error', 'error');
    }
  }

  // ─── Playback ───────────────────────────────────────────────
  async openPlayback(dropboxPath) {
    this.toast('Loading recording…', 'info');
    try {
      const encoded = encodeURIComponent(dropboxPath.replace(/^\//, ''));
      const res = await fetch(`/api/recordings/${encoded}`);
      if (!res.ok) { this.toast('Failed to load recording', 'error'); return; }
      const recording = await res.json();

      this.playbackRecording = recording;
      this.playbackPaused = false;
      this.playbackIndex  = 0;
      this.playbackOffset = 0;
      this.playbackSpeed  = 1;

      // Populate modal
      document.getElementById('pbTitle').textContent = `▶ ${recording.deviceModel || recording.deviceId || 'Recording'}`;
      document.getElementById('pbDevice').textContent = recording.deviceModel || recording.deviceId || '—';
      document.getElementById('pbDate').textContent = new Date(recording.createdAt || recording.startTime).toLocaleString();
      document.getElementById('pbDuration').textContent = this.formatDuration(recording.duration);
      document.getElementById('pbEvents').textContent = `${recording.events?.length || 0} events`;
      document.getElementById('pbProgress').style.width = '0%';
      document.getElementById('pbCurrentTime').textContent = '0:00';

      // Build event log
      const log = document.getElementById('pbLog');
      log.innerHTML = (recording.events || []).map((evt, i) => `
        <div class="pb-log-entry" id="pbevt${i}">
          <span class="pb-log-time">${this.formatMs(evt.timestamp)}</span>
          <span class="pb-log-type">${evt.type.toUpperCase()}</span>
          <span class="pb-log-detail">${this.describeEvent(evt)}</span>
        </div>
      `).join('');

      // Switch to stream tab so user can watch the device screen live during playback
      this.switchTab('stream');

      // Auto-start stream if not already running and device is available
      const streamNotice = document.getElementById('pbStreamNotice');
      if (this.selectedDevice && !this.isStreaming) {
        this.startStream();
        if (streamNotice) streamNotice.style.display = 'flex';
      } else if (this.isStreaming) {
        if (streamNotice) streamNotice.style.display = 'flex';
      } else {
        if (streamNotice) streamNotice.style.display = 'none';
      }

      document.getElementById('playbackModal').style.display = 'flex';
    } catch (e) {
      this.toast('Failed to load recording', 'error');
    }
  }

  closePlayback() {
    this.playbackStop();
    document.getElementById('playbackModal').style.display = 'none';
    this.playbackRecording = null;
  }

  playbackPlay() {
    if (!this.playbackRecording) return;
    if (this.playbackPaused) {
      this.playbackPaused = false;
      document.getElementById('pbPlayBtn').style.display = 'none';
      document.getElementById('pbPauseBtn').style.display = '';
      this._scheduleNextEvent();
      return;
    }
    // Fresh play
    this.playbackIndex  = 0;
    this.playbackOffset = 0;
    this.playbackPaused = false;
    document.getElementById('pbPlayBtn').style.display = 'none';
    document.getElementById('pbPauseBtn').style.display = '';
    this._scheduleNextEvent();
  }

  playbackPause() {
    this.playbackPaused = true;
    clearTimeout(this.playbackHandle);
    document.getElementById('pbPlayBtn').style.display = '';
    document.getElementById('pbPauseBtn').style.display = 'none';
    // Save time offset for resume
    if (this.playbackRecording && this.playbackIndex < this.playbackRecording.events.length) {
      const currentEvt = this.playbackRecording.events[this.playbackIndex];
      this.playbackOffset = currentEvt.timestamp;
    }
  }

  playbackStop() {
    clearTimeout(this.playbackHandle);
    this.playbackPaused = false;
    this.playbackIndex  = 0;
    this.playbackOffset = 0;
    document.getElementById('pbPlayBtn').style.display = '';
    document.getElementById('pbPauseBtn').style.display = 'none';
    document.getElementById('pbProgress').style.width = '0%';
    document.getElementById('pbCurrentTime').textContent = '0:00';
    // Clear highlighted events
    document.querySelectorAll('.pb-log-entry.active').forEach(el => el.classList.remove('active'));
  }

  setPlaybackSpeed(speed, btn) {
    this.playbackSpeed = speed;
    document.querySelectorAll('.pb-speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  _scheduleNextEvent() {
    if (!this.playbackRecording || this.playbackPaused) return;

    const events   = this.playbackRecording.events;
    const duration = this.playbackRecording.duration;
    if (this.playbackIndex >= events.length) {
      this.playbackStop();
      this.toast('Playback complete', 'success');
      return;
    }

    const evt      = events[this.playbackIndex];
    const prevTs   = this.playbackIndex > 0 ? events[this.playbackIndex - 1].timestamp : 0;
    const delay    = Math.max(0, (evt.timestamp - prevTs) / this.playbackSpeed);

    this.playbackHandle = setTimeout(() => {
      if (this.playbackPaused) return;

      // Execute event
      this._executePlaybackEvent(evt);

      // Update UI
      const progress = ((evt.timestamp / duration) * 100).toFixed(1);
      document.getElementById('pbProgress').style.width = `${Math.min(progress, 100)}%`;
      document.getElementById('pbCurrentTime').textContent = this.formatMs(evt.timestamp);

      // Highlight log entry
      const el = document.getElementById(`pbevt${this.playbackIndex}`);
      if (el) {
        document.querySelectorAll('.pb-log-entry.active').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      this.playbackIndex++;
      this._scheduleNextEvent();
    }, delay);
  }

  _executePlaybackEvent(evt) {
    if (!this.selectedDevice) {
      this.toast('Select a device for playback', 'warn');
      this.playbackPause();
      return;
    }
    switch (evt.type) {
      case 'tap':
        this.send({ type: 'tap', deviceId: this.selectedDevice, payload: { x: evt.x, y: evt.y } });
        break;
      case 'swipe':
        this.send({ type: 'swipe', deviceId: this.selectedDevice, payload: { x1: evt.x1, y1: evt.y1, x2: evt.x2, y2: evt.y2, duration: evt.duration } });
        break;
      case 'keyevent':
        this.send({ type: 'keyevent', deviceId: this.selectedDevice, payload: { keycode: evt.keycode } });
        break;
      case 'text':
        this.send({ type: 'text', deviceId: this.selectedDevice, payload: { text: evt.text } });
        break;
    }
  }

  describeEvent(evt) {
    switch (evt.type) {
      case 'tap':      return `tap (${evt.x}, ${evt.y})`;
      case 'swipe':    return `${evt.x1},${evt.y1} → ${evt.x2},${evt.y2}`;
      case 'keyevent': return `keycode ${evt.keycode}`;
      case 'text':     return `"${(evt.text || '').slice(0, 40)}"`;
      default:         return JSON.stringify(evt).slice(0, 50);
    }
  }

  formatMs(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }

  formatDuration(ms) {
    const s = Math.round((ms || 0) / 1000);
    return `${Math.floor(s/60)}m ${s%60}s`;
  }

  // ─── Keyboard ───────────────────────────────────────────────
  setupTextInput() {
    const input = document.getElementById('keyboardInput');
    const btn   = document.getElementById('sendTextBtn');

    const sendFn = () => {
      const text = input.value;
      if (!text || !this.selectedDevice) return;
      this.sendText(text);
      input.value = '';
      this.toast(`Sent: "${text.slice(0, 30)}"`, 'info');
    };

    btn.addEventListener('click', sendFn);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFn(); }
    });
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;
      const isInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';
      if (isInput) return;

      switch (e.key) {
        case 'F1': e.preventDefault(); this.sendKey(3);   break; // Home
        case 'F2': e.preventDefault(); this.sendKey(4);   break; // Back
        case 'F3': e.preventDefault(); this.sendKey(187); break; // Recents
        case 'F4': e.preventDefault(); this.sendKey(26);  break; // Power
      }

      if (e.ctrlKey) {
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.startRecording(); }
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); this.takeScreenshot(); }
      }
    });
  }

  // ─── FPS / Stats ────────────────────────────────────────────
  setupFpsCounter() {
    this.fpsTimer = setInterval(() => {
      document.getElementById('fpsDisplay').textContent = this.fpsCounter;
      this.fpsCounter = 0;
    }, 1000);
  }

  // ─── Quality Sliders ────────────────────────────────────────
  setupQualitySliders() {
    const fps  = document.getElementById('fpsSetting');
    const qual = document.getElementById('qualSetting');
    const size = document.getElementById('sizeSetting');

    const fpsVal  = document.getElementById('fpsVal');
    const qualVal = document.getElementById('qualVal');
    const sizeVal = document.getElementById('sizeVal');

    fps.addEventListener('input',  () => { fpsVal.textContent  = fps.value;  });
    qual.addEventListener('input', () => { qualVal.textContent = qual.value; });
    size.addEventListener('input', () => { sizeVal.textContent = size.value; });

    // Apply quality changes live if streaming
    const applyQuality = () => {
      if (this.isStreaming) {
        this.send({
          type: 'set_stream_quality',
          payload: {
            fps:     parseInt(fps.value),
            quality: parseInt(qual.value),
            maxSize: parseInt(size.value),
          },
        });
      }
    };
    fps.addEventListener('change',  applyQuality);
    qual.addEventListener('change', applyQuality);
    size.addEventListener('change', applyQuality);
  }

  // ─── Screenshot ─────────────────────────────────────────────
  takeScreenshot() {
    if (!this.selectedDevice) { this.toast('No device selected', 'warn'); return; }
    const a = document.createElement('a');
    a.href = `/api/devices/${this.selectedDevice}/screenshot`;
    a.download = `screenshot-${Date.now()}.png`;
    a.click();
    this.toast('Screenshot downloaded', 'success');
  }

  downloadScreenshot(base64Data) {
    const a = document.createElement('a');
    a.href = 'data:image/png;base64,' + base64Data;
    a.download = `screenshot-${Date.now()}.png`;
    a.click();
  }

  // ─── Device Controls ────────────────────────────────────────
  pressPower()      { this.sendKey(26); }
  pressVolumeUp()   { this.sendKey(24); }
  pressVolumeDown() { this.sendKey(25); }
  pressHome()       { this.sendKey(3);  }
  pressBack()       { this.sendKey(4);  }
  pressRecents()    { this.sendKey(187);}
  pressMenu()       { this.sendKey(82); }

  async rebootDevice() {
    if (!this.selectedDevice) return;
    if (!confirm('Reboot device?')) return;
    await fetch(`/api/devices/${this.selectedDevice}/reboot`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
    this.toast('Rebooting…', 'warn');
  }

  toggleFullscreen() {
    const panel = document.getElementById('streamPanel') || document.querySelector('.stream-panel');
    if (!document.fullscreenElement) panel?.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  // ─── Connection Status ──────────────────────────────────────
  setConnectionStatus(online) {
    const dot   = document.getElementById('wsDot');
    const label = document.getElementById('wsLabel');
    dot.className   = 'chip-dot ' + (online ? 'online' : 'offline');
    label.textContent = online ? 'ONLINE' : 'OFFLINE';
  }

  // ─── Toast ──────────────────────────────────────────────────
  toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new AndroidTestStation();

  // Wire stream buttons
  document.getElementById('refreshDevicesBtn').onclick = () => app.loadDevices();
  document.getElementById('startStreamBtn').onclick    = () => app.startStream();
  document.getElementById('stopStreamBtn').onclick     = () => app.stopStream();
  document.getElementById('screenshotBtn').onclick     = () => app.takeScreenshot();
  document.getElementById('rotateBtn').onclick         = () => app.rotateManual();
  document.getElementById('autoRotateBtn').onclick     = () => app.toggleAutoRotate();
  document.getElementById('fullscreenBtn').onclick     = () => app.toggleFullscreen();
  document.getElementById('rebootBtn').onclick         = () => app.rebootDevice();

  // Recording
  document.getElementById('startRecBtn').onclick       = () => app.startRecording();
  document.getElementById('stopRecBtn').onclick        = () => app.stopRecording();

  // Recordings tab
  document.getElementById('refreshRecBtn').onclick     = () => app.loadRecordings();

  // Control buttons
  document.getElementById('btnPower').onclick          = () => app.pressPower();
  document.getElementById('btnVolUp').onclick          = () => app.pressVolumeUp();
  document.getElementById('btnVolDown').onclick        = () => app.pressVolumeDown();
  document.getElementById('btnHome').onclick           = () => app.pressHome();
  document.getElementById('btnBack').onclick           = () => app.pressBack();
  document.getElementById('btnRecents').onclick        = () => app.pressRecents();
  document.getElementById('btnMenu').onclick           = () => app.pressMenu();
  document.getElementById('sendTextBtn').onclick       = () => {
    const input = document.getElementById('keyboardInput');
    const text = input.value;
    if (text && app.selectedDevice) { app.sendText(text); input.value = ''; }
  };
});
