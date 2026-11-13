'use strict';
// Settings + login session in <userData>/config.json. The device key is encrypted with Windows DPAPI (Electron safeStorage).
const fs = require('fs');
const path = require('path');

const DEFAULTS = { settings: { autoStart: true, showPreview: true }, bounds: { width: 1100, height: 720 } };

class Config {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'config.json');
    this.safe = safeStorage;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  get(key) {
    const v = this.data[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...DEFAULTS[key], ...v } : v === undefined ? DEFAULTS[key] : v;
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
  }
  getSession() {
    const s = this.data.session;
    if (!s || !s.deviceKey) return null;
    let deviceKey = '';
    try {
      deviceKey = s.deviceKey.startsWith('enc:') ? this.safe.decryptString(Buffer.from(s.deviceKey.slice(4), 'base64')) : s.deviceKey.slice(4);
    } catch { return null; }
    return { serverUrl: s.serverUrl, token: s.token, label: s.label, deviceKey };
  }
  setSession({ serverUrl, token, deviceKey, label }) {
    const enc = this.safe && this.safe.isEncryptionAvailable() ? 'enc:' + this.safe.encryptString(deviceKey).toString('base64') : 'raw:' + deviceKey;
    this.data.session = { serverUrl, token, label, deviceKey: enc };
    this.save();
  }
  clearSession() {
    delete this.data.session;
    this.save();
  }
}

module.exports = { Config, DEFAULTS };
