'use strict';
// A local copy of the conversation list and the last messages, so the app opens instantly (and shows something while the
// server wakes up or when there is no connection). Encrypted with Windows DPAPI (Electron safeStorage): readable only by
// this Windows user. If encryption is not available nothing is stored.
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-f0-9]{10}$/;
const MAX_BYTES = 6 * 1024 * 1024;

class LocalCache {
  constructor(dir, safe) { this.dir = dir; this.safe = safe; }
  file(id) { return ID_RE.test(String(id)) ? path.join(this.dir, `cache-${id}.bin`) : null; }
  available() { return !!(this.safe && this.safe.isEncryptionAvailable()); }
  load(id) {
    const f = this.file(id);
    if (!f || !this.available()) return null;
    try { return this.safe.decryptString(fs.readFileSync(f)); } catch { return null; }
  }
  save(id, json) {
    const f = this.file(id);
    if (!f || !this.available() || typeof json !== 'string' || json.length > MAX_BYTES) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, this.safe.encryptString(json));
      fs.renameSync(tmp, f);
      return true;
    } catch { return false; }
  }
  clear(id) { const f = this.file(id); if (f) try { fs.rmSync(f, { force: true }); } catch { /* nothing to remove */ } }
}

module.exports = { LocalCache };
