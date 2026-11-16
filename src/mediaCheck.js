'use strict';
// Is the file that arrived the real one? A content filter on the network (for example NetFree) may answer a picture request
// with a stand-in image ("this picture is being checked") instead of the real bytes. The fingerprint and size come from the
// chat message itself (a JSON answer the filter does not change), so a stand-in is recognised instead of being shown as the picture.
const crypto = require('crypto');

function verifyMedia(buffer, expect = {}, headerSha) {
  const want = String(expect.sha256 || headerSha || '').toLowerCase();
  if (want) {
    const got = crypto.createHash('sha256').update(buffer).digest('hex');
    return got === want ? { ok: true } : { ok: false, altered: true, reason: 'hash' };
  }
  if (expect.size && buffer.length !== expect.size) return { ok: false, altered: true, reason: 'size' };
  return { ok: true };
}

module.exports = { verifyMedia };
