'use strict';
// App lock: a numeric PIN that hides the chat after a period of inactivity (or when the window is closed to the tray, or
// Windows is locked). The PIN is stored only as a salted scrypt hash. Wrong guesses are slowed down.
// This keeps casual onlookers out; it is not a replacement for locking Windows itself.
const crypto = require('crypto');

const PIN_RE = /^\d{4,12}$/;
const MINUTES = [1, 5, 15, 30, 60];

function hashPin(pin, salt = crypto.randomBytes(16)) {
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
function checkPin(pin, rec) {
  if (!rec || !rec.hash || !rec.salt) return false;
  const h = crypto.scryptSync(String(pin), Buffer.from(rec.salt, 'hex'), 32);
  const want = Buffer.from(rec.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

// 5 free guesses, then 30 s, 60 s, 2 min ... up to 15 min between guesses
class Limiter {
  constructor(now) { this.now = now; this.fails = 0; this.until = 0; }
  check() { const wait = this.until - this.now(); return wait > 0 ? { allowed: false, waitMs: wait } : { allowed: true, waitMs: 0 }; }
  fail() { this.fails++; if (this.fails >= 5) this.until = this.now() + Math.min(15 * 60 * 1000, 30000 * 2 ** (this.fails - 5)); }
  ok() { this.fails = 0; this.until = 0; }
}

function createLock(config, now = Date.now) {
  const limiter = new Limiter(now);
  let locked = !!config.get('lock').enabled; // an enabled lock starts locked
  const clampMinutes = (m) => (MINUTES.includes(Number(m)) ? Number(m) : 5);
  const api = {
    isLocked: () => locked,
    state() { const l = config.get('lock'); return { enabled: !!l.enabled, minutes: l.minutes || 5, onHide: l.onHide !== false, locked }; },
    setup({ pin, minutes, onHide }) {
      if (!PIN_RE.test(String(pin))) throw new Error('הקוד חייב להיות 4 עד 12 ספרות');
      config.set('lock', { enabled: true, minutes: clampMinutes(minutes), onHide: onHide !== false, ...hashPin(pin) });
      locked = false;
    },
    update({ minutes, onHide }) {
      const l = config.get('lock');
      if (!l.enabled) return;
      config.set('lock', { ...l, minutes: minutes === undefined ? l.minutes : clampMinutes(minutes), onHide: onHide === undefined ? l.onHide : !!onHide });
    },
    verify(pin) {
      const c = limiter.check();
      if (!c.allowed) return { ok: false, waitMs: c.waitMs };
      if (checkPin(String(pin), config.get('lock'))) { limiter.ok(); locked = false; return { ok: true }; }
      limiter.fail();
      return { ok: false, waitMs: limiter.check().waitMs };
    },
    disable(pin) {
      const r = api.verify(pin);
      if (!r.ok) return r;
      config.set('lock', { enabled: false, minutes: 5, onHide: true });
      locked = false;
      return { ok: true };
    },
    lockNow() { if (config.get('lock').enabled) locked = true; return locked; },
    reset() { config.set('lock', { enabled: false, minutes: 5, onHide: true }); locked = false; }, // "forgot the PIN": the caller also signs every account out
  };
  return api;
}

module.exports = { createLock, hashPin, checkPin, PIN_RE, MINUTES };
