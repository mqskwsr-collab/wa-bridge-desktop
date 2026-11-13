'use strict';
// Client for the WA Bridge server (/api/desk/*). No Electron imports: it is tested on its own.

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status || 0;
    this.data = data || null;
  }
}

// Accepts what the dashboard shows: the personal-area link (https://host/me/<token>) or the phone-app link (https://host/exec?token=<token>).
function parseLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !local) return null; // the token and the password never travel over plain http
  let token = u.searchParams.get('token') || '';
  if (!token) {
    const m = u.pathname.match(/^\/me\/([A-Za-z0-9_-]{8,128})/);
    if (m) token = m[1];
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  return { serverUrl: u.origin, token };
}

function createApi({ fetch, getSession, onAuthExpired }) {
  async function request(method, base, path, { body, headers, timeoutMs = 30000 } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new ApiError(timeout ? 'השרת לא הגיב בזמן (ייתכן שהוא מתעורר, נסה שוב בעוד רגע)' : 'אין חיבור לשרת', 0);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) throw new ApiError((data && data.error) || `שגיאת שרת (${res.status})`, res.status, data);
    return data;
  }

  return {
    async login({ serverUrl, token, password, code, deviceName }) {
      return request('POST', serverUrl, '/api/desk/login', { body: { token, password, code, deviceName }, timeoutMs: 70000 });
    },
    // opts.accountId: which signed-in account (default: the active one)
    async call(method, path, body, opts = {}) {
      const s = getSession(opts.accountId);
      if (!s || !s.deviceKey) throw new ApiError('login', 401);
      try {
        return await request(method, s.serverUrl, path, { body, headers: { 'x-wab-token': s.token, 'x-wab-device': s.deviceKey }, timeoutMs: opts.timeoutMs || (path.startsWith('/api/desk/send') ? 120000 : 30000) });
      } catch (e) {
        if (e.status === 401 && onAuthExpired) onAuthExpired(s.id);
        throw e;
      }
    },
  };
}

module.exports = { createApi, parseLink, ApiError };
