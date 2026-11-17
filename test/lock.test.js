'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLock, hashPin, checkPin } = require('../src/lock');
const { LocalCache } = require('../src/cache');
const { Config } = require('../src/config');

let n = 0;
const ok = (m) => console.log('  ok', ++n, '-', m);
const xor = (b) => Buffer.from(b).map((v) => v ^ 0x5a); // a stand-in cipher: the bytes on disk are not the text
const fake = { isEncryptionAvailable: () => true, encryptString: (x) => xor(Buffer.from(x)), decryptString: (b) => xor(b).toString() };

// ---- app lock ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-lock-'));
const cfg = new Config(dir, fake);
let t = 1000000; const now = () => t;
const lock = createLock(cfg, now);
assert.strictEqual(lock.state().enabled, false); assert.strictEqual(lock.isLocked(), false); ok('the lock is off by default');
assert.throws(() => lock.setup({ pin: '12' }), /4 עד 12/); assert.throws(() => lock.setup({ pin: 'abcd' })); ok('a PIN must be 4-12 digits');
lock.setup({ pin: '4821', minutes: 15, onHide: true });
assert.deepStrictEqual([lock.state().enabled, lock.state().minutes, lock.isLocked()], [true, 15, false]); ok('setting a PIN turns the lock on (and does not lock you out at once)');
assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('4821')); assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).lock.hash.length === 64); ok('only a salted hash of the PIN is stored, never the PIN');
assert.notStrictEqual(hashPin('4821').hash, hashPin('4821').hash); ok('two hashes of the same PIN differ (random salt)');
assert.strictEqual(lock.lockNow(), true); assert.strictEqual(lock.isLocked(), true); ok('lock now');
assert.strictEqual(lock.verify('0000').ok, false); assert.strictEqual(lock.isLocked(), true); ok('a wrong PIN keeps it locked');
assert.strictEqual(lock.verify('4821').ok, true); assert.strictEqual(lock.isLocked(), false); ok('the right PIN unlocks');
// brute force slows down
lock.lockNow();
for (let i = 0; i < 4; i++) lock.verify('1111');
let r = lock.verify('1111');
assert.strictEqual(r.ok, false); assert.ok(r.waitMs >= 29000); ok('after 5 wrong guesses there is a 30 second wait');
assert.strictEqual(lock.verify('4821').ok, false); assert.ok(lock.verify('4821').waitMs > 0); ok('even the right PIN is refused during the wait');
t += 31000;
assert.strictEqual(lock.verify('4821').ok, true); ok('after the wait the right PIN works again');
lock.lockNow(); for (let i = 0; i < 5; i++) lock.verify('2222'); t += 31000;
r = lock.verify('2222'); assert.ok(r.waitMs >= 59000); ok('every further wrong guess doubles the wait');
t += 3600000; assert.strictEqual(lock.verify('4821').ok, true);
// restart: an enabled lock starts locked
const lock2 = createLock(new Config(dir, fake), now);
assert.strictEqual(lock2.isLocked(), true); ok('after a restart the app starts locked');
assert.strictEqual(lock2.disable('9999').ok, false); assert.strictEqual(lock2.state().enabled, true); ok('turning the lock off needs the PIN');
assert.strictEqual(lock2.verify('4821').ok, true); assert.strictEqual(lock2.disable('4821').ok, true); assert.strictEqual(lock2.state().enabled, false); ok('with the PIN it can be turned off');
lock2.setup({ pin: '1234', minutes: 7777 }); assert.strictEqual(lock2.state().minutes, 5); ok('an unsupported timeout falls back to 5 minutes');
lock2.update({ minutes: 30, onHide: false }); assert.deepStrictEqual([lock2.state().minutes, lock2.state().onHide], [30, false]); ok('timeout and "lock when closed to the tray" can be changed');
lock2.reset(); assert.strictEqual(lock2.state().enabled, false); assert.strictEqual(lock2.isLocked(), false); ok('"forgot the PIN" reset clears the lock');
assert.strictEqual(checkPin('1', null), false);

// ---- local cache ----
const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-cache-'));
const cache = new LocalCache(cd, fake);
assert.strictEqual(cache.load('aaaaaaaaaa'), null); ok('no cache yet');
assert.ok(cache.save('aaaaaaaaaa', JSON.stringify({ hello: 'שלום' }))); assert.deepStrictEqual(JSON.parse(cache.load('aaaaaaaaaa')), { hello: 'שלום' }); ok('the cache is saved and read back');
assert.ok(!fs.readFileSync(path.join(cd, 'cache-aaaaaaaaaa.bin'), 'utf8').includes('שלום')); ok('the file on disk is encrypted');
assert.strictEqual(cache.save('../evil', 'x'), false); assert.strictEqual(cache.load('../../etc'), null); ok('account ids cannot be used for path tricks');
assert.strictEqual(cache.save('bbbbbbbbbb', 'x'.repeat(7 * 1024 * 1024)), false); ok('an oversized cache is refused');
cache.clear('aaaaaaaaaa'); assert.strictEqual(cache.load('aaaaaaaaaa'), null); ok('the cache can be deleted (sign-out)');
const noEnc = new LocalCache(cd, { isEncryptionAvailable: () => false });
assert.strictEqual(noEnc.save('cccccccccc', 'x'), false); ok('without OS encryption nothing is written');

console.log(`\n${n} checks passed`);
