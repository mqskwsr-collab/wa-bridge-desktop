'use strict';
// Points electron-updater at the WA Bridge server (which fetches the files from the private GitHub repo).
// NOTE: electron-updater reads "requestHeaders" only in its constructor - setFeedURL() silently ignores them -
// so the device headers must be set on the updater object itself. (Version 1.0.x/1.1.0 got this wrong: 401.)
function applyFeed(autoUpdater, session) {
  autoUpdater.setFeedURL({ provider: 'generic', url: `${session.serverUrl}/api/desk/update` });
  autoUpdater.requestHeaders = { 'x-wab-token': session.token, 'x-wab-device': session.deviceKey };
}

// short, readable text for the settings dialog instead of a stack trace
function friendlyUpdateError(e) {
  const m = String((e && e.message) || e || '');
  if (/\b401\b/.test(m)) return 'השרת דחה את בקשת העדכון (401). התחבר מחדש לחשבון.';
  if (/\b404\b/.test(m)) return 'אין עדיין גרסה חדשה בשרת.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::/.test(m)) return 'אין חיבור לשרת. ננסה שוב בהמשך.';
  return m.split('\n')[0].slice(0, 140);
}

module.exports = { applyFeed, friendlyUpdateError };
