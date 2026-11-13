'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLink, createApi, ApiError } = require('../src/api');
const { Config } = require('../src/config');

let n = 0;
const ok = (m) => console.log('  ok', ++n, '-', m);

(async () => {
  // ---- parseLink ----
  const T = 'abcDEF123_-xyzABC987';
  assert.deepStrictEqual(parseLink(`https://x.onrender.com/me/${T}`), { serverUrl: 'https://x.onrender.com', token: T }); ok('personal-area link');
  assert.deepStrictEqual(parseLink(`https://x.onrender.com/exec?token=${T}`), { serverUrl: 'https://x.onrender.com', token: T }); ok('phone-app link');
  assert.deepStrictEqual(parseLink(`x.onrender.com/me/${T}/`), { serverUrl: 'https://x.onrender.com', token: T }); ok('scheme is optional');
  assert.strictEqual(parseLink(`http://x.onrender.com/me/${T}`), null); ok('plain http is refused (except localhost)');
  assert.deepStrictEqual(parseLink(`http://127.0.0.1:3000/me/${T}`), { serverUrl: 'http://127.0.0.1:3000', token: T }); ok('localhost http is allowed for development');
  assert.strictEqual(parseLink('https://x.onrender.com/'), null);
  assert.strictEqual(parseLink(''), null);
  assert.strictEqual(parseLink('https://x.onrender.com/me/short'), null); ok('links without a valid token are refused');

  // ---- api client with a stub fetch ----
  const seen = [];
  const stub = (handler) => async (url, init) => { seen.push({ url, init }); const r = handler(url, init); return { ok: r.status < 400, status: r.status, json: async () => r.body }; };
  let expired = 0;
  let api = createApi({ fetch: stub(() => ({ status: 200, body: { ok: true, deviceKey: 'id.secret' } })), getSession: () => null, onAuthExpired: () => expired++ });
  const r = await api.login({ serverUrl: 'https://s', token: T, password: 'p', deviceName: 'PC' });
  assert.strictEqual(r.deviceKey, 'id.secret'); assert.strictEqual(seen[0].url, 'https://s/api/desk/login'); assert.ok(!seen[0].init.headers['x-wab-device']); ok('login posts to /api/desk/login without device headers');
  await assert.rejects(api.call('GET', '/api/desk/sync'), (e) => e instanceof ApiError && e.status === 401); ok('calls without a session fail with 401');

  api = createApi({ fetch: stub(() => ({ status: 200, body: { ok: true } })), getSession: () => ({ serverUrl: 'https://s', token: T, deviceKey: 'id.secret' }), onAuthExpired: () => expired++ });
  await api.call('POST', '/api/desk/send', { text: 'x' });
  const last = seen[seen.length - 1];
  assert.strictEqual(last.init.headers['x-wab-token'], T); assert.strictEqual(last.init.headers['x-wab-device'], 'id.secret'); ok('authenticated calls carry token + device key');

  api = createApi({ fetch: stub(() => ({ status: 401, body: { error: 'login' } })), getSession: () => ({ serverUrl: 'https://s', token: T, deviceKey: 'k' }), onAuthExpired: () => expired++ });
  await assert.rejects(api.call('GET', '/api/desk/sync'), (e) => e.status === 401);
  assert.strictEqual(expired, 1); ok('a 401 triggers the sign-out callback');

  api = createApi({ fetch: async () => { throw new Error('ECONNREFUSED'); }, getSession: () => ({ serverUrl: 'https://s', token: T, deviceKey: 'k' }) });
  await assert.rejects(api.call('GET', '/api/desk/sync'), (e) => e.status === 0 && /אין חיבור/.test(e.message)); ok('network failure gives a readable error');

  api = createApi({ fetch: stub(() => ({ status: 401, body: { error: 'נדרש קוד', needCode: true } })), getSession: () => null });
  await assert.rejects(api.login({ serverUrl: 'https://s', token: T, password: 'p' }), (e) => e.data && e.data.needCode === true); ok('login error keeps the "needCode" flag');

  // ---- config ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabd-'));
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('E' + s), decryptString: (b) => b.toString().slice(1) };
  let c = new Config(dir, fake);
  assert.strictEqual(c.getSession(), null);
  c.setSession({ serverUrl: 'https://s', token: T, deviceKey: 'id.secret', label: 'דוד' });
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('id.secret')); ok('the device key is not stored in clear text');
  c = new Config(dir, fake);
  assert.strictEqual(c.getSession().deviceKey, 'id.secret'); assert.strictEqual(c.getSession().label, 'דוד'); ok('session survives a restart');
  c.set('settings', { autoStart: false });
  assert.deepStrictEqual(c.get('settings'), { autoStart: false, showPreview: true }); ok('settings merge with defaults');
  c.clearSession();
  assert.strictEqual(new Config(dir, fake).getSession(), null); ok('sign-out removes the session');

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
