'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, dialog, safeStorage, net, session } = require('electron');
const { Config } = require('./src/config');
const { createApi, parseLink } = require('./src/api');

const DEV = !app.isPackaged;
const START_HIDDEN = process.argv.includes('--hidden');
const MAX_FILE_BYTES = 25 * 1024 * 1024;

app.setAppUserModelId('com.wabridge.desktop'); // needed for Windows notifications and the taskbar group

let win = null;
let tray = null;
let quitting = false;
let config = null;
let api = null;
let autoUpdater = null;
const state = { unread: 0, update: { status: 'idle', version: '', percent: 0, error: '' } };

// ---------------------------------------------------------------- window
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const b = config.get('bounds');
  win = new BrowserWindow({
    width: b.width || 1100, height: b.height || 720, minWidth: 780, minHeight: 540,
    show: false, backgroundColor: '#f0f2f5', autoHideMenuBar: true, title: 'WA Bridge',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, // keep syncing while the window sits in the tray
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!START_HIDDEN) win.show(); });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); } // closing only hides it: messages keep arriving
  });
  win.on('focus', () => win.flashFrame(false));
  let t = null;
  const saveBounds = () => { clearTimeout(t); t = setTimeout(() => { if (win && !win.isMaximized() && !win.isMinimized()) { const [width, height] = win.getSize(); config.set('bounds', { width, height }); } }, 600); };
  win.on('resize', saveBounds);

  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('context-menu', (e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    Menu.buildFromTemplate([
      { role: 'cut', label: 'גזור', enabled: p.editFlags.canCut }, { role: 'copy', label: 'העתק', enabled: p.editFlags.canCopy },
      { role: 'paste', label: 'הדבק', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: 'בחר הכל' },
    ]).popup();
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- tray (the icon next to the Windows clock)
const img = (name) => nativeImage.createFromPath(path.join(__dirname, 'build', name));

function trayTooltip() {
  const v = app.getVersion();
  let s = `WA Bridge ‏v${v}`;
  if (state.unread > 0) s += `\n${state.unread} הודעות שלא נקראו`;
  const u = state.update;
  if (u.status === 'ready') s += `\nעדכון v${u.version} מוכן להתקנה`;
  else if (u.status === 'downloading') s += `\nמוריד עדכון v${u.version} (${Math.round(u.percent)}%)`;
  return s;
}

function updateMenuItem() {
  const u = state.update;
  if (u.status === 'ready') return { label: `⬇ התקן עדכון v${u.version} והפעל מחדש`, click: installUpdate };
  if (u.status === 'downloading') return { label: `מוריד עדכון v${u.version} (${Math.round(u.percent)}%)…`, enabled: false };
  if (u.status === 'checking') return { label: 'בודק עדכונים…', enabled: false };
  return { label: 'בדוק עדכונים', click: () => checkForUpdates(true) };
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: `WA Bridge — גרסה ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'פתח', click: showWindow },
    updateMenuItem(),
    { type: 'checkbox', label: 'הפעל עם Windows', checked: !!config.get('settings').autoStart, click: (mi) => applySettings({ autoStart: mi.checked }) },
    { type: 'separator' },
    { label: 'יציאה', click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const icon = state.update.status === 'ready' ? 'tray-update.png' : state.unread > 0 ? 'tray-unread.png' : 'tray.png';
  tray.setImage(img(icon));
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(img('tray.png'));
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  refreshTray();
}

// ---------------------------------------------------------------- settings
function applySettings(patch) {
  const s = { ...config.get('settings'), ...patch };
  config.set('settings', s);
  if (!DEV) app.setLoginItemSettings({ openAtLogin: !!s.autoStart, args: ['--hidden'] });
  refreshTray();
  send('settings', s);
  return s;
}

// ---------------------------------------------------------------- auto update (GitHub releases, electron-updater)
function setUpdate(patch) {
  Object.assign(state.update, patch);
  send('update', state.update);
  refreshTray();
}

function initUpdater() {
  if (DEV) { setUpdate({ status: 'dev' }); return; }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.disableDifferentialDownload = true; // the server streams whole files (the GitHub repo is private and sits behind it)
  autoUpdater.autoInstallOnAppQuit = true; // an update that was downloaded is installed the next time the app closes, even without a click
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: p.percent || 0 }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ status: 'ready', version: i.version, percent: 100 });
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'WA Bridge — עדכון מוכן', body: `גרסה ${i.version} הורדה. לחץ כדי להפעיל מחדש ולהתעדכן.`, icon: img('tray-update.png') });
      n.on('click', installUpdate);
      n.show();
    }
  });
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', error: String((e && e.message) || e).slice(0, 200) }));
  setTimeout(() => checkForUpdates(false), 15 * 1000);
  setInterval(() => checkForUpdates(false), 3 * 3600 * 1000);
}

// Updates come from the WA Bridge server (it fetches them from the private GitHub repo), authenticated with this device's key.
function configureFeed() {
  const s = config.getSession();
  if (!s) return false;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${s.serverUrl}/api/desk/update`,
    requestHeaders: { 'x-wab-token': s.token, 'x-wab-device': s.deviceKey },
  });
  return true;
}

function checkForUpdates(manual) {
  if (!autoUpdater) { if (manual) setUpdate({ status: 'dev' }); return; }
  if (state.update.status === 'downloading' || state.update.status === 'ready') return;
  if (!configureFeed()) { if (manual) setUpdate({ status: 'error', error: 'התחבר לחשבון כדי לקבל עדכונים' }); return; }
  autoUpdater.checkForUpdates().then((r) => {
    if (manual && r && r.updateInfo && r.updateInfo.version === app.getVersion() && Notification.isSupported()) {
      new Notification({ title: 'WA Bridge', body: `אתה משתמש בגרסה העדכנית (${app.getVersion()}).` }).show();
    }
  }).catch((e) => setUpdate({ status: 'error', error: String((e && e.message) || e).slice(0, 200) }));
}

function installUpdate() {
  if (!autoUpdater || state.update.status !== 'ready') return;
  quitting = true;
  autoUpdater.quitAndInstall(true, true); // silent install, then start the app again
}

// ---------------------------------------------------------------- IPC
function info() {
  const s = config.getSession();
  return { version: app.getVersion(), packaged: !DEV, loggedIn: !!s, label: s ? s.label : '', serverUrl: s ? s.serverUrl : '', settings: config.get('settings'), update: state.update };
}

function registerIpc() {
  ipcMain.handle('app:info', () => info());

  ipcMain.handle('auth:login', async (e, { link, password, code } = {}) => {
    const p = parseLink(link);
    if (!p) return { ok: false, error: 'הקישור לא תקין. הדבק את הקישור של "אזור אישי" מהדשבורד (חייב להתחיל ב-https).' };
    try {
      const r = await api.login({ serverUrl: p.serverUrl, token: p.token, password: String(password || ''), code: code ? String(code) : undefined, deviceName: `Windows - ${os.hostname()}` });
      config.setSession({ serverUrl: p.serverUrl, token: p.token, deviceKey: r.deviceKey, label: r.label });
      setTimeout(() => checkForUpdates(false), 3000); // now that the app is signed in, look for a newer version
      return { ok: true, label: r.label, passwordIsDefault: !!r.passwordIsDefault };
    } catch (err) {
      return { ok: false, error: err.message, needCode: !!(err.data && err.data.needCode) };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    try { await api.call('POST', '/api/desk/logout', {}); } catch { /* signing out locally anyway */ }
    config.clearSession();
    state.unread = 0;
    refreshTray();
    return { ok: true };
  });

  // the renderer never talks to the network itself: only these server paths, with the device key added here
  ipcMain.handle('api:call', async (e, { method, path: p, body } = {}) => {
    if (typeof p !== 'string' || !p.startsWith('/api/desk/') || p.startsWith('/api/desk/login') || !['GET', 'POST'].includes(method)) return { ok: false, status: 0, error: 'bad request' };
    try {
      return { ok: true, data: await api.call(method, p, body) };
    } catch (err) {
      return { ok: false, status: err.status || 0, error: err.message };
    }
  });

  ipcMain.handle('file:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'בחר קבצים לשליחה' });
    const files = [];
    const skipped = [];
    for (const f of r.canceled ? [] : r.filePaths.slice(0, 12)) {
      try {
        const st = fs.statSync(f);
        if (st.size > MAX_FILE_BYTES) { skipped.push(`${path.basename(f)} (גדול מ-25MB)`); continue; }
        files.push({ name: path.basename(f), size: st.size, data: fs.readFileSync(f).toString('base64') });
      } catch { skipped.push(path.basename(f)); }
    }
    return { files, skipped };
  });

  ipcMain.handle('settings:set', (e, patch) => {
    const allowed = {};
    if (patch && typeof patch.autoStart === 'boolean') allowed.autoStart = patch.autoStart;
    if (patch && typeof patch.showPreview === 'boolean') allowed.showPreview = patch.showPreview;
    return applySettings(allowed);
  });

  ipcMain.on('unread:set', (e, n) => { state.unread = Math.max(0, Number(n) || 0); refreshTray(); });

  ipcMain.on('notify', (e, { key, title, body } = {}) => {
    if (win && win.isVisible() && win.isFocused()) return;
    if (win && !win.isFocused()) win.flashFrame(true);
    if (!Notification.isSupported()) return;
    const show = config.get('settings').showPreview;
    const n = new Notification({ title: String(title || 'WA Bridge').slice(0, 80), body: show ? String(body || '').slice(0, 160) : 'הודעה חדשה', icon: img('tray-unread.png') });
    n.on('click', () => { showWindow(); send('open-conv', key); });
    n.show();
  });

  ipcMain.handle('update:check', () => { checkForUpdates(true); return state.update; });
  ipcMain.handle('update:install', () => { installUpdate(); return true; });
}

// ---------------------------------------------------------------- start
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* stay in the tray */ });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));
    config = new Config(app.getPath('userData'), safeStorage);
    api = createApi({
      fetch: (url, init) => net.fetch(url, init), // uses the system proxy settings
      getSession: () => config.getSession(),
      onAuthExpired: () => { config.clearSession(); send('auth-expired'); },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'עריכה', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'תצוגה', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }, ...(DEV ? [{ role: 'toggleDevTools' }] : [])] },
    ]));
    registerIpc();
    createWindow();
    createTray();
    initUpdater();
    applySettings({}); // applies the "start with Windows" choice
  });
}
