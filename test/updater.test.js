'use strict';
// Runs the REAL electron-updater (with a tiny stand-in for the "electron" module) against a fake WA Bridge server
// and checks that the device headers reach both the update check and the download.
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const fs = require('fs');
process.resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-res-'));
fs.writeFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'provider: generic\nurl: http://127.0.0.1:1/unused\n');
const APP = 'wab-updater-test-' + crypto.randomBytes(4).toString('hex'); // own cache dir per run, so a re-run really downloads
const electronStub = {
  app: { getVersion: () => '1.0.0', getName: () => APP, name: APP, isPackaged: true, getAppPath: () => process.cwd(), getPath: () => os.tmpdir(), whenReady: () => Promise.resolve(), on() {}, once() {}, quit() {}, userAgentFallback: 'test' },
  net: {}, session: {}, BrowserWindow: class {}, autoUpdater: {},
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electronStub : load.call(this, request, ...rest); };

const { NsisUpdater } = require('electron-updater');
const { HttpExecutor } = require('builder-util-runtime');
const { applyFeed, friendlyUpdateError } = require('../src/feed');

class NodeExecutor extends HttpExecutor {
  createRequest(options, callback) { return (options.protocol === 'https:' ? require('https') : http).request(options, callback); }
  // the real ElectronHttpExecutor streams to disk; this stand-in does the same with plain node
  download(url, destination, options) {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { headers: options.headers || {} }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('download HTTP ' + res.statusCode)); }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, Buffer.concat(chunks)); resolve(destination); });
      });
      req.on('error', reject);
      req.end();
    });
  }
}

let n = 0;
const ok = (m) => console.log('  ok', ++n, '-', m);
const FILE = Buffer.from('fake-installer-bytes');
const SHA = crypto.createHash('sha512').update(FILE).digest('base64');
const YML = `version: 9.9.9\nfiles:\n  - url: WA-Bridge-Setup-9.9.9.exe\n    sha512: ${SHA}\n    size: ${FILE.length}\npath: WA-Bridge-Setup-9.9.9.exe\nsha512: ${SHA}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`;

(async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const okAuth = req.headers['x-wab-token'] === 'tok-123' && req.headers['x-wab-device'] === 'dev.key';
    seen.push({ url: req.url, okAuth });
    if (!okAuth) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"login"}'); }
    if (/^\/api\/desk\/update\/latest(-\w+)?\.yml/.test(req.url)) { res.writeHead(200, { 'content-type': 'text/yaml' }); return res.end(YML); }
    if (req.url === '/api/desk/update/WA-Bridge-Setup-9.9.9.exe') { res.writeHead(200, { 'content-length': FILE.length }); return res.end(FILE); }
    res.writeHead(404); res.end();
  }).listen(0);
  const session = { serverUrl: 'http://127.0.0.1:' + server.address().port, token: 'tok-123', deviceKey: 'dev.key' };

  const make = () => { const u = new NsisUpdater(); u.httpExecutor = new NodeExecutor(); u.autoDownload = false; u.disableDifferentialDownload = true; u.autoInstallOnAppQuit = false; return u; };

  // 1) the way 1.0.x/1.1.0 did it: headers in setFeedURL -> the server never sees them
  const bad = make();
  bad.setFeedURL({ provider: 'generic', url: `${session.serverUrl}/api/desk/update`, requestHeaders: { 'x-wab-token': session.token, 'x-wab-device': session.deviceKey } });
  await assert.rejects(bad.checkForUpdates(), (e) => /401/.test(e.message));
  ok('regression: headers passed through setFeedURL() are ignored by electron-updater (this was the 401 bug)');

  // 2) the fix
  const u = make();
  applyFeed(u, session);
  const r = await u.checkForUpdates();
  assert.strictEqual(r.updateInfo.version, '9.9.9'); assert.ok(seen.filter((x) => /latest(-\w+)?\.yml/.test(x.url)).pop().okAuth); ok('update check carries the device headers and finds the new version');

  await u.downloadUpdate();
  assert.ok(seen.some((x) => x.url.endsWith('.exe') && x.okAuth)); ok('the installer download carries the device headers too');
  assert.ok(seen.every((x) => x.okAuth || /latest(-\w+)?\.yml/.test(x.url))); // only the old-style attempt was refused
  const dl = await u.downloadUpdate().catch(() => null); void dl;

  assert.ok(/401/.test(friendlyUpdateError(new Error('401 Unauthorized "method: GET url: ...\n Data: {}')))); assert.ok(!friendlyUpdateError(new Error('x\nsecond line')).includes('second')); ok('update errors are shown as one readable line, not a stack trace');
  console.log(`\n${n} checks passed`);
  server.close();
  fs.rmSync(path.join(os.homedir(), '.cache', APP), { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
