'use strict';
// Settings + signed-in accounts in <userData>/config.json. Each account = one personal link (one WhatsApp number) on the server.
// Device keys are encrypted with Windows DPAPI (Electron safeStorage).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = { settings: { autoStart: true, showPreview: true }, bounds: { width: 1100, height: 720 } };
const idOf = (serverUrl, token) => crypto.createHash('sha256').update(serverUrl + '|' + token).digest('hex').slice(0, 10);

class Config {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'config.json');
    this.safe = safeStorage;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    if (this.data.session && !this.data.accounts) { // version 1.0.x had a single account
      const s = this.data.session;
      this.data.accounts = [{ id: idOf(s.serverUrl, s.token), serverUrl: s.serverUrl, token: s.token, label: s.label, deviceKey: s.deviceKey }];
      this.data.activeId = this.data.accounts[0].id;
      delete this.data.session;
      try { this.save(); } catch { /* retried on the next change */ }
    }
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

  // ---- accounts ----
  listAccounts() {
    return (this.data.accounts || []).map((a) => ({ id: a.id, serverUrl: a.serverUrl, label: a.label }));
  }
  getActiveId() {
    const list = this.data.accounts || [];
    return list.some((a) => a.id === this.data.activeId) ? this.data.activeId : list[0] ? list[0].id : null;
  }
  setActive(id) {
    if ((this.data.accounts || []).some((a) => a.id === id)) { this.data.activeId = id; this.save(); return true; }
    return false;
  }
  // the session of an account (default: the active one) including the decrypted device key
  getSession(id) {
    const a = (this.data.accounts || []).find((x) => x.id === (id || this.getActiveId()));
    if (!a || !a.deviceKey) return null;
    let deviceKey = '';
    try {
      deviceKey = a.deviceKey.startsWith('enc:') ? this.safe.decryptString(Buffer.from(a.deviceKey.slice(4), 'base64')) : a.deviceKey.slice(4);
    } catch { return null; }
    return { id: a.id, serverUrl: a.serverUrl, token: a.token, label: a.label, deviceKey };
  }
  // adds the account (or refreshes it if the same link was added before) and makes it the active one
  addAccount({ serverUrl, token, deviceKey, label }) {
    const id = idOf(serverUrl, token);
    const enc = this.safe && this.safe.isEncryptionAvailable() ? 'enc:' + this.safe.encryptString(deviceKey).toString('base64') : 'raw:' + deviceKey;
    const list = (this.data.accounts = this.data.accounts || []);
    const i = list.findIndex((a) => a.id === id);
    const rec = { id, serverUrl, token, label, deviceKey: enc };
    if (i >= 0) list[i] = rec; else list.push(rec);
    this.data.activeId = id;
    this.save();
    return id;
  }
  removeAccount(id) {
    this.data.accounts = (this.data.accounts || []).filter((a) => a.id !== id);
    if (this.data.activeId === id) this.data.activeId = this.data.accounts[0] ? this.data.accounts[0].id : null;
    this.save();
  }
}

module.exports = { Config, DEFAULTS, idOf };
