// dropbox-service.js
// Handles all Dropbox API operations for storing/retrieving test recordings
// Uses Dropbox API v2 via the official 'dropbox' npm package

const path = require('path');

// Gracefully handle missing dropbox package
let Dropbox;
try {
  Dropbox = require('dropbox').Dropbox;
} catch (e) {
  console.warn('[Dropbox] dropbox package not installed. Run: npm install dropbox');
  Dropbox = null;
}

const RECORDINGS_FOLDER = process.env.DROPBOX_FOLDER || '/AndroidTestRecordings';

class DropboxService {
  constructor() {
    this.token = process.env.DROPBOX_ACCESS_TOKEN || null;
    this.dbx = null;
    this.available = false;
    this._init();
  }

  _init() {
    if (!Dropbox) {
      console.warn('[Dropbox] SDK not available');
      return;
    }
    if (!this.token) {
      console.warn('[Dropbox] DROPBOX_ACCESS_TOKEN not set — recordings will be stored locally only');
      return;
    }
    try {
      this.dbx = new Dropbox({ accessToken: this.token });
      this.available = true;
      console.log('[Dropbox] ✅ Initialized');
      this._ensureFolder();
    } catch (e) {
      console.error('[Dropbox] Init error:', e.message);
    }
  }

  async _ensureFolder() {
    try {
      await this.dbx.filesCreateFolderV2({ path: RECORDINGS_FOLDER });
    } catch (e) {
      // Folder likely already exists; ignore
    }
  }

  isAvailable() { return this.available; }

  // Upload a recording JSON to Dropbox
  // Returns { success, path, id, name } or { success: false, error }
  async uploadRecording(recording) {
    if (!this.available) return { success: false, error: 'Dropbox not configured' };

    const filename = `recording-${recording.id}.json`;
    const dropboxPath = `${RECORDINGS_FOLDER}/${filename}`;
    const content = JSON.stringify(recording, null, 2);

    try {
      const result = await this.dbx.filesUpload({
        path: dropboxPath,
        contents: Buffer.from(content),
        mode: { '.tag': 'overwrite' },
        autorename: false,
        mute: false,
      });

      return {
        success: true,
        path: result.result.path_display,
        id: result.result.id,
        name: result.result.name,
        size: result.result.size,
        serverModified: result.result.server_modified,
      };
    } catch (e) {
      console.error('[Dropbox] Upload error:', e.message);
      return { success: false, error: e.message };
    }
  }

  // List all recordings from Dropbox, newest first
  async listRecordings() {
    if (!this.available) return { success: false, error: 'Dropbox not configured', recordings: [] };

    try {
      const result = await this.dbx.filesListFolder({ path: RECORDINGS_FOLDER });
      const entries = result.result.entries.filter(e => e['.tag'] === 'file' && e.name.endsWith('.json'));

      // Sort newest first (by server_modified)
      entries.sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

      const recordings = entries.map(e => ({
        dropboxId: e.id,
        name: e.name,
        path: e.path_display,
        size: e.size,
        serverModified: e.server_modified,
        recordingId: e.name.replace('recording-', '').replace('.json', ''),
      }));

      return { success: true, recordings };
    } catch (e) {
      // If folder not found, return empty
      if (e.error?.error_summary?.includes('not_found')) {
        return { success: true, recordings: [] };
      }
      console.error('[Dropbox] List error:', e.message);
      return { success: false, error: e.message, recordings: [] };
    }
  }

  // Download a specific recording by Dropbox path
  async getRecording(dropboxPath) {
    if (!this.available) return { success: false, error: 'Dropbox not configured' };

    try {
      const result = await this.dbx.filesDownload({ path: dropboxPath });
      const content = result.result.fileBinary
        ? result.result.fileBinary.toString('utf8')
        : (result.result.fileBlob
          ? await result.result.fileBlob.text()
          : null);

      if (!content) return { success: false, error: 'Empty download' };
      const recording = JSON.parse(content);
      return { success: true, recording };
    } catch (e) {
      console.error('[Dropbox] Download error:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Delete a recording by Dropbox path
  async deleteRecording(dropboxPath) {
    if (!this.available) return { success: false, error: 'Dropbox not configured' };

    try {
      await this.dbx.filesDeleteV2({ path: dropboxPath });
      return { success: true };
    } catch (e) {
      console.error('[Dropbox] Delete error:', e.message);
      return { success: false, error: e.message };
    }
  }

  // Search recordings by device or date
  async searchRecordings(query) {
    if (!this.available) return { success: false, error: 'Dropbox not configured', results: [] };

    try {
      const result = await this.dbx.filesSearchV2({
        query,
        options: { path: RECORDINGS_FOLDER },
      });
      return { success: true, results: result.result.matches };
    } catch (e) {
      return { success: false, error: e.message, results: [] };
    }
  }
}

module.exports = new DropboxService();
