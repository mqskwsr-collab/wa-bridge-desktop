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

  // ---- config: several accounts ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabd-'));
  const fake = { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from('E' + x), decryptString: (b) => b.toString().slice(1) };
  let c = new Config(dir, fake);
  assert.strictEqual(c.getSession(), null); assert.deepStrictEqual(c.listAccounts(), []);
  const a1 = c.addAccount({ serverUrl: 'https://s', token: T, deviceKey: 'id.secret1', label: 'הדסה' });
  const a2 = c.addAccount({ serverUrl: 'https://s', token: T + 'B', deviceKey: 'id.secret2', label: 'משה' });
  assert.notStrictEqual(a1, a2); assert.strictEqual(c.getActiveId(), a2); ok('a second number is added and becomes the active one');
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('secret')); ok('device keys are not stored in clear text');
  c = new Config(dir, fake);
  assert.strictEqual(c.getSession().deviceKey, 'id.secret2'); assert.strictEqual(c.getSession(a1).deviceKey, 'id.secret1'); assert.strictEqual(c.getSession(a1).label, 'הדסה'); ok('both sessions survive a restart; a session can be fetched per account');
  assert.deepStrictEqual(c.listAccounts().map((a) => a.label), ['הדסה', 'משה']); assert.ok(!('deviceKey' in c.listAccounts()[0]) && !('token' in c.listAccounts()[0])); ok('the account list never exposes keys or tokens');
  assert.ok(c.setActive(a1)); assert.strictEqual(c.getSession().label, 'הדסה'); assert.strictEqual(c.setActive('nope'), false); ok('switching between numbers');
  assert.strictEqual(c.addAccount({ serverUrl: 'https://s', token: T, deviceKey: 'id.new', label: 'הדסה' }), a1); assert.strictEqual(c.listAccounts().length, 2); assert.strictEqual(c.getSession(a1).deviceKey, 'id.new'); ok('adding the same link again refreshes it instead of duplicating');
  c.removeAccount(a1);
  assert.strictEqual(c.getActiveId(), a2); assert.strictEqual(c.listAccounts().length, 1); ok('removing the active account falls back to another one');
  c.removeAccount(a2); assert.strictEqual(c.getActiveId(), null); assert.strictEqual(c.getSession(), null); ok('no accounts left -> signed out');
  c.set('settings', { autoStart: false });
  assert.deepStrictEqual(c.get('settings'), { autoStart: false, showPreview: true, localCache: true }); ok('settings merge with defaults');

  // ---- migration from the single-account version ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wabd-'));
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ session: { serverUrl: 'https://s', token: T, label: 'ישן', deviceKey: 'enc:' + fake.encryptString('id.old').toString('base64') }, settings: { autoStart: false } }));
  const m = new Config(dir2, fake);
  assert.strictEqual(m.listAccounts().length, 1); assert.strictEqual(m.getSession().deviceKey, 'id.old'); assert.strictEqual(m.getSession().label, 'ישן'); assert.strictEqual(m.get('settings').autoStart, false); ok('an installed 1.0.x keeps its login after the update (migration)');

  // ---- api client picks the account ----
  const sessions = { a: { id: 'a', serverUrl: 'https://s', token: 'ta-token', deviceKey: 'da' }, b: { id: 'b', serverUrl: 'https://s', token: 'tb-token', deviceKey: 'db' } };
  let expiredId = null;
  const api2 = createApi({ fetch: stub(() => ({ status: 200, body: { ok: true } })), getSession: (id) => sessions[id || 'a'], onAuthExpired: (id) => { expiredId = id; } });
  await api2.call('GET', '/api/desk/summary', null, { accountId: 'b' });
  assert.strictEqual(seen[seen.length - 1].init.headers['x-wab-token'], 'tb-token'); ok('a call can target a specific account');
  const api3 = createApi({ fetch: stub(() => ({ status: 401, body: { error: 'login' } })), getSession: (id) => sessions[id || 'a'], onAuthExpired: (id) => { expiredId = id; } });
  await assert.rejects(api3.call('GET', '/api/desk/sync', null, { accountId: 'b' }));
  assert.strictEqual(expiredId, 'b'); ok('a 401 reports which account expired');

  // ---- binary download ----
  const bin = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const dl = createApi({ fetch: async (u, i) => { seen.push({ url: u, init: i }); return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length) }; }, getSession: () => ({ id: 'a', serverUrl: 'https://s', token: 'tok-1', deviceKey: 'dk' }) });
  const got = await dl.download('/api/desk/media/m' + 'a'.repeat(24));
  assert.ok(got.buffer.equals(bin)); assert.strictEqual(got.contentType, 'image/png'); assert.strictEqual(seen[seen.length - 1].init.headers['x-wab-device'], 'dk'); ok('pictures are downloaded as bytes with the device headers');
  let exp = null;
  const dl2 = createApi({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: 'login' }) }), getSession: () => ({ id: 'z', serverUrl: 'https://s', token: 'tok-1', deviceKey: 'dk' }), onAuthExpired: (id) => { exp = id; } });
  await assert.rejects(dl2.download('/api/desk/media/x'), (e) => e.status === 401); assert.strictEqual(exp, 'z'); ok('a rejected download signs that account out');
  await assert.rejects(createApi({ fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }), getSession: () => ({ id: 'a', serverUrl: 'https://s', token: 't', deviceKey: 'd' }) }).download('/api/desk/media/x'), (e) => e.status === 404); ok('a picture that is gone gives a clean 404');

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
