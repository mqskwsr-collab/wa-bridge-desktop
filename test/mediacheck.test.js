'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { verifyMedia } = require('../src/mediaCheck');

let n = 0;
const ok = (m) => console.log('  ok', ++n, '-', m);
const real = crypto.randomBytes(5000);
const standIn = crypto.randomBytes(1800); // "this picture is being checked"
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

assert.deepStrictEqual(verifyMedia(real, { sha256: sha(real), size: real.length }), { ok: true }); ok('the real file passes');
let r = verifyMedia(standIn, { sha256: sha(real), size: real.length });
assert.strictEqual(r.ok, false); assert.strictEqual(r.altered, true); ok('a stand-in picture (different bytes) is recognised');
assert.strictEqual(verifyMedia(Buffer.concat([real.subarray(0, 4999), Buffer.from([1])]), { sha256: sha(real) }).altered, true); ok('even a one-byte change is caught');
assert.strictEqual(verifyMedia(standIn, { size: real.length }).altered, true); assert.strictEqual(verifyMedia(real, { size: real.length }).ok, true); ok('older messages without a fingerprint are checked by size');
assert.strictEqual(verifyMedia(standIn, {}, sha(real)).altered, true); assert.strictEqual(verifyMedia(real, {}, sha(real).toUpperCase()).ok, true); ok('the response header is used when the message has no fingerprint (case-insensitive)');
assert.strictEqual(verifyMedia(standIn, { sha256: sha(standIn) }, sha(real)).ok, true); ok('the message fingerprint wins over the header (the header can be rewritten by a filter)');
assert.strictEqual(verifyMedia(standIn, {}).ok, true); ok('with nothing to compare against the file is accepted (nothing is invented)');
console.log(`\n${n} checks passed`);
