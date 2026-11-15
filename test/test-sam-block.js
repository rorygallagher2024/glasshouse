/**
 * test/test-sam-block.js - the block and release that make sam reread one app:
 * webOS 11's block needs forceBlockSystemApp, which its schema requires (#768)
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-sam-block.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-sam-block-' + process.pid);
fs.mkdirSync(dir);
var webos11 = path.join(dir, 'webos11.schema');
var webos10 = path.join(dir, 'webos10.schema');
fs.writeFileSync(webos11, '{"type":"object","properties":{"id":{"type":"string"},"forceBlockSystemApp":{"type":"boolean","description":"force blocking system app for WEE platfrom"}},"required":["id","forceBlockSystemApp"]}');
fs.writeFileSync(webos10, '{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}');

var calls, logs = [], realLog = console.log;
console.log = function (s) { logs.push(String(s)); };

// sam: a block refused with webOS 11's answer unless forceBlockSystemApp is
// there, when the schema has it; the release takes only an id.
function tv(schema, needsForce) {
  calls = [];
  var type = 'flutter', blocked = false;
  samrescan.init({ blockSchema: schema, pollMs: 1, luna: function (uri, payload, cb) {
    calls.push([uri.split('/').pop(), payload]);
    if (/blockSystemApp$/.test(uri) && !/release/.test(uri)) {
      if (needsForce && payload.forceBlockSystemApp !== false) {
        return cb({ errorCode: 2, returnValue: false, errorText: 'invalid parameters' });
      }
      blocked = true;
      return cb({ returnValue: true });
    }
    // sam rereads the app on the release of a block, not on the release asked first.
    if (/releaseBlockSystemApp$/.test(uri)) { if (blocked) type = 'qml'; blocked = false; return cb({ returnValue: true }); }
    cb({ returnValue: false });
  } });
  return function (done) { done(type === 'qml'); };
}

var check = tv(webos11, true);
samrescan.rereadApp('com.webos.app.screensaver', check, function (ok) {
  assert.strictEqual(ok, true);
  assert.deepEqual(calls[0], ['releaseBlockSystemApp', { id: 'com.webos.app.screensaver' }], 'whether sam has the release, asked first');
  assert.deepEqual(calls[1], ['blockSystemApp', { id: 'com.webos.app.screensaver', forceBlockSystemApp: false }]);
  assert.deepEqual(calls[2], ['releaseBlockSystemApp', { id: 'com.webos.app.screensaver' }], 'the release takes the id alone');
  realLog('  ✓ where the schema names forceBlockSystemApp, the block sends it as false and the release does not');

  check = tv(webos10, false);
  samrescan.rereadApp('com.webos.app.screensaver', check, function (ok2) {
    assert.strictEqual(ok2, true);
    assert.deepEqual(calls[1], ['blockSystemApp', { id: 'com.webos.app.screensaver' }]);
    realLog('  ✓ where it does not, the block is the id alone, as on webOS 10');

    // A webOS 11 TV whose schema could not be read: refused, and the
    // refusal is logged as sam gave it.
    logs = [];
    check = tv(path.join(dir, 'missing.schema'), true);
    samrescan.rereadApp('com.webos.app.screensaver', check, function (ok3) {
      assert.strictEqual(ok3, false);
      assert.ok(logs.some(function (l) { return /blockSystemApp for com\.webos\.app\.screensaver refused: invalid parameters \(2\)/.test(l); }), logs.join('\n'));
      realLog('  ✓ a refused block is logged with sam\'s own error');

      console.log = realLog;
      [webos11, webos10].forEach(function (f) { fs.unlinkSync(f); });
      fs.rmdirSync(dir);
      console.log('ALL test-sam-block.js assertions passed!\n');
    });
  });
});
