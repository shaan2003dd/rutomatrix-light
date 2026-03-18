// adb-controller.js
// Handles all ADB commands and device interaction
// Enhanced: JPEG compression, faster screenshots, orientation detection
// -

const { exec, spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class ADBController {
  constructor() {
    this.adbPath = process.env.ADB_PATH || 'adb';
    this._hasImageMagick = null;
  }

  // Check once if ImageMagick is available for JPEG conversion
  async checkImageMagick() {
    if (this._hasImageMagick !== null) return this._hasImageMagick;
    try {
      await execAsync('convert --version', { timeout: 3000 });
      this._hasImageMagick = true;
    } catch {
      this._hasImageMagick = false;
    }
    return this._hasImageMagick;
  }

  // Run a generic ADB command
  async run(command, deviceId = null) {
    const deviceFlag = deviceId ? `-s ${deviceId}` : '';
    const fullCmd = `${this.adbPath} ${deviceFlag} ${command}`;
    try {
      const { stdout, stderr } = await execAsync(fullCmd, { timeout: 15000 });
      return { success: true, output: stdout.trim(), error: stderr.trim() };
    } catch (err) {
      return { success: false, output: '', error: err.message };
    }
  }

  // Get list of connected devices
  async getDevices() {
    const result = await this.run('devices -l');
    if (!result.success) return [];

    const lines = result.output.split('\n').slice(1);
    const devices = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '') continue;

      const parts = trimmed.split(/\s+/);
      const id = parts[0];
      const state = parts[1];

      if (state === 'device' || state === 'offline' || state === 'unauthorized') {
        const infoStr = parts.slice(2).join(' ');
        const modelMatch = infoStr.match(/model:(\S+)/);
        const productMatch = infoStr.match(/product:(\S+)/);
        const transportMatch = infoStr.match(/transport_id:(\S+)/);

        devices.push({
          id,
          state,
          model: modelMatch ? modelMatch[1] : 'Unknown',
          product: productMatch ? productMatch[1] : 'Unknown',
          transportId: transportMatch ? transportMatch[1] : null,
        });
      }
    }
    return devices;
  }

  async getResolution(deviceId) {
    const result = await this.run('shell wm size', deviceId);
    if (!result.success) return null;

    const overrideMatch = result.output.match(/Override size:\s*(\d+)x(\d+)/i);
    const physicalMatch = result.output.match(/Physical size:\s*(\d+)x(\d+)/i);

    if (overrideMatch) {
      return { width: parseInt(overrideMatch[1]), height: parseInt(overrideMatch[2]), type: 'override' };
    } else if (physicalMatch) {
      return { width: parseInt(physicalMatch[1]), height: parseInt(physicalMatch[2]), type: 'physical' };
    }
    return null;
  }

  async getDensity(deviceId) {
    const result = await this.run('shell wm density', deviceId);
    if (!result.success) return null;
    const match = result.output.match(/Physical density:\s*(\d+)/i);
    return match ? parseInt(match[1]) : null;
  }

  async getAndroidVersion(deviceId) {
    const result = await this.run('shell getprop ro.build.version.release', deviceId);
    return result.success ? result.output : null;
  }

  async getDeviceModel(deviceId) {
    const result = await this.run('shell getprop ro.product.model', deviceId);
    return result.success ? result.output : null;
  }

  async getBatteryInfo(deviceId) {
    const result = await this.run('shell dumpsys battery', deviceId);
    if (!result.success) return null;

    const levelMatch = result.output.match(/level:\s*(\d+)/);
    const chargingMatch = result.output.match(/status:\s*(\d+)/);
    const isCharging = chargingMatch && (chargingMatch[1] === '2' || chargingMatch[1] === '5');

    return {
      level: levelMatch ? parseInt(levelMatch[1]) : null,
      charging: isCharging,
    };
  }

  // Get current screen rotation (0=portrait, 1=landscape-left, 2=portrait-down, 3=landscape-right)
  async getOrientation(deviceId) {
    const result = await this.run('shell settings get system user_rotation', deviceId);
    if (!result.success) return 0;
    const val = parseInt(result.output);
    return isNaN(val) ? 0 : val;
  }

  // Get surface flinger rotation (actual rendered rotation, more reliable)
  async getSurfaceRotation(deviceId) {
    const result = await this.run('shell dumpsys SurfaceFlinger | grep -i "orientation"', deviceId);
    if (!result.success) return 0;
    const match = result.output.match(/orientation=(\d)/);
    return match ? parseInt(match[1]) : 0;
  }

  // Send key event
  async sendKeyEvent(deviceId, keycode) {
    return await this.run(`shell input keyevent ${keycode}`, deviceId);
  }

  // Key event constants
  async pressPower(deviceId)      { return this.sendKeyEvent(deviceId, 26);  }
  async pressVolumeUp(deviceId)   { return this.sendKeyEvent(deviceId, 24);  }
  async pressVolumeDown(deviceId) { return this.sendKeyEvent(deviceId, 25);  }
  async pressHome(deviceId)       { return this.sendKeyEvent(deviceId, 3);   }
  async pressBack(deviceId)       { return this.sendKeyEvent(deviceId, 4);   }
  async pressRecents(deviceId)    { return this.sendKeyEvent(deviceId, 187); }
  async pressMenu(deviceId)       { return this.sendKeyEvent(deviceId, 82);  }
  async pressEnter(deviceId)      { return this.sendKeyEvent(deviceId, 66);  }
  async pressDelete(deviceId)     { return this.sendKeyEvent(deviceId, 67);  }

  // Send text input (escapes special characters)
  async sendText(deviceId, text) {
    const escaped = text.replace(/([\\'";& |<>!$`()])/g, '\\$1').replace(/ /g, '%s');
    return await this.run(`shell input text "${escaped}"`, deviceId);
  }

  async sendTap(deviceId, x, y) {
    return await this.run(`shell input tap ${Math.round(x)} ${Math.round(y)}`, deviceId);
  }

  async sendSwipe(deviceId, x1, y1, x2, y2, duration = 300) {
    return await this.run(
      `shell input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${duration}`,
      deviceId
    );
  }

  // ─── Screenshot (PNG fallback) ──────────────────────────────────
  takeScreenshot(deviceId, callback) {
    const args = [...(deviceId ? ['-s', deviceId] : []), 'exec-out', 'screencap', '-p'];
    const child = spawn(this.adbPath, args);

    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (d) => console.error('[ADB Screenshot Error]', d.toString()));
    child.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        callback(null, Buffer.concat(chunks));
      } else {
        callback(new Error('Screenshot failed'), null);
      }
    });
    child.on('error', (err) => callback(err, null));
  }

  // ─── Optimized JPEG Screenshot ──────────────────────────────────
  // Priority order: sharp (in-process, fastest) → ffmpeg pipe → ImageMagick pipe → raw PNG
  takeJpegScreenshot(deviceId, quality = 55, maxWidth = 480, callback) {
    // Step 1: Capture raw PNG from device via adb
    const args = [...(deviceId ? ['-s', deviceId] : []), 'exec-out', 'screencap', '-p'];
    const child = spawn(this.adbPath, args);
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', () => {});
    child.on('error', (err) => callback(err, null, null));
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        return callback(new Error('adb screencap failed'), null, null);
      }
      const pngBuf = Buffer.concat(chunks);
      if (pngBuf.length < 1000) {
        return callback(new Error('screencap too small'), null, null);
      }

      // Step 2: Convert using sharp (fastest, in-process, no spawn overhead)
      let sharpLib = null;
      try { sharpLib = require('sharp'); } catch (_) {}

      if (sharpLib) {
        sharpLib(pngBuf)
          .resize(maxWidth, null, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
          .jpeg({ quality, mozjpeg: false, progressive: false })
          .toBuffer()
          .then(jpegBuf => callback(null, jpegBuf, 'jpeg'))
          .catch(() => callback(null, pngBuf, 'png')); // fallback to raw PNG
        return;
      }

      // Step 3: ffmpeg fallback (if sharp not available)
      const ffmpegCmd = `ffmpeg -hide_banner -loglevel quiet -i pipe:0 -vf scale=${maxWidth}:-2 -frames:v 1 -q:v ${Math.round((100-quality)/5)+1} -f image2pipe -vcodec mjpeg pipe:1`;
      const ff = spawn('sh', ['-c', ffmpegCmd]);
      const ffChunks = [];
      ff.stdin.write(pngBuf);
      ff.stdin.end();
      ff.stdout.on('data', (d) => ffChunks.push(d));
      ff.on('close', (ffCode) => {
        if (ffCode === 0 && ffChunks.length > 0) {
          const jpegBuf = Buffer.concat(ffChunks);
          if (jpegBuf.length > 500) return callback(null, jpegBuf, 'jpeg');
        }
        // Step 4: ImageMagick fallback
        const im = spawn('sh', ['-c', `convert - -resize ${maxWidth}x -quality ${quality} jpeg:-`]);
        const imChunks = [];
        im.stdin.write(pngBuf);
        im.stdin.end();
        im.stdout.on('data', (d) => imChunks.push(d));
        im.on('close', (imCode) => {
          if (imCode === 0 && imChunks.length > 0) {
            const jpegBuf = Buffer.concat(imChunks);
            if (jpegBuf.length > 500) return callback(null, jpegBuf, 'jpeg');
          }
          // Final fallback: send raw PNG
          callback(null, pngBuf, 'png');
        });
        im.on('error', () => callback(null, pngBuf, 'png'));
      });
      ff.on('error', () => {
        // skip ffmpeg, try ImageMagick directly via callback recursion
        const im = spawn('sh', ['-c', `convert - -resize ${maxWidth}x -quality ${quality} jpeg:-`]);
        const imChunks = [];
        im.stdin.write(pngBuf);
        im.stdin.end();
        im.stdout.on('data', (d) => imChunks.push(d));
        im.on('close', (imCode) => {
          if (imCode === 0 && imChunks.length > 0) {
            const jpegBuf = Buffer.concat(imChunks);
            if (jpegBuf.length > 500) return callback(null, jpegBuf, 'jpeg');
          }
          callback(null, pngBuf, 'png');
        });
        im.on('error', () => callback(null, pngBuf, 'png'));
      });
    });
  }

  // Reboot device
  async reboot(deviceId) { return await this.run('reboot', deviceId); }
  async rebootRecovery(deviceId) { return await this.run('reboot recovery', deviceId); }

  // Get full device info bundle
  async getFullDeviceInfo(deviceId) {
    const [resolution, density, androidVersion, model, battery, orientation] = await Promise.all([
      this.getResolution(deviceId),
      this.getDensity(deviceId),
      this.getAndroidVersion(deviceId),
      this.getDeviceModel(deviceId),
      this.getBatteryInfo(deviceId),
      this.getOrientation(deviceId),
    ]);
    return { resolution, density, androidVersion, model, battery, orientation };
  }

  async checkScrcpy() {
    try {
      const { stdout } = await execAsync('scrcpy --version', { timeout: 5000 });
      const match = stdout.match(/scrcpy\s+([\d.]+)/);
      return { available: true, version: match ? match[1] : 'unknown' };
    } catch {
      return { available: false, version: null };
    }
  }

  async checkADB() {
    try {
      const result = await this.run('version');
      const match = result.output.match(/Android Debug Bridge version ([\d.]+)/);
      return { available: true, version: match ? match[1] : 'unknown' };
    } catch {
      return { available: false, version: null };
    }
  }

  async startServer() { return await execAsync(`${this.adbPath} start-server`); }

  async installApk(deviceId, apkPath) {
    return await this.run(`install -r "${apkPath}"`, deviceId);
  }

  async getPackages(deviceId) {
    const result = await this.run('shell pm list packages', deviceId);
    if (!result.success) return [];
    return result.output.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
  }

  async launchApp(deviceId, packageName, activity = null) {
    if (activity) {
      return await this.run(`shell am start -n ${packageName}/${activity}`, deviceId);
    }
    return await this.run(`shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, deviceId);
  }

  async killApp(deviceId, packageName) {
    return await this.run(`shell am force-stop ${packageName}`, deviceId);
  }

  // Get top foreground app/activity
  async getForegroundApp(deviceId) {
    const result = await this.run('shell dumpsys activity activities | grep mResumedActivity', deviceId);
    if (!result.success) return null;
    const match = result.output.match(/u\d+ (\S+)/);
    return match ? match[1] : null;
  }
}

module.exports = new ADBController();
