/**
 * test/test-acr-consent.js - Which consent flags the ACR switch writes (#629)
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var privacy = require('../server/lib/privacy');
var controls = require('../server/lib/controls');

console.log('Running test-acr-consent.js ...');

var dir = path.join(os.tmpdir(), 'glasshouse-acr-' + process.pid);
fs.mkdirSync(dir);
function binary(name, strings) {
  var file = path.join(dir, name);
  // NUL-separated, as the names sit in a binary's string table.
  fs.writeFileSync(file, '\x7fELF\x00' + strings.join('\x00') + '\x00');
  return file;
}

var cases = [
  // A C9 (webOS 4.10.2): count 0, 1, 1 for acrAllowed, acrOnAllowed, acrAdAllowed.
  ['webOS 4.10', binary('c9', ['generalTermsAllowed', 'acrOnAllowed', 'acrAdAllowed', 'livePlus']), ['acrOnAllowed']],
  ['both named', binary('both', ['acrAllowed', 'acrOnAllowed']), ['acrAllowed', 'acrOnAllowed']],
  ['neither named', binary('neither', ['acrAdAllowed', 'livePlus']), ['acrAllowed']],
  ['no binary', path.join(dir, 'missing'), ['acrAllowed']]
];

function next() {
  var c = cases.shift();
  if (!c) return testControl();
  privacy._setAcrBinary(c[1]);
  privacy.acrConsentKeys(function (keys) {
    assert.deepEqual(keys, c[2], c[0]);
    next();
  });
}

// The switch sets livePlus, then each flag found, and counts what else went.
function testControl() {
  console.log('  ✓ the flags are those the ACR binary names, or acrAllowed');
  var calls = [];
  controls.init({
    config: { allowControl: true },
    telemetry: { clearCache: function () {} },
    clearLunaCache: function () {},
    luna: function (uri, payload, cb) {
      calls.push(uri.split('/').pop() + ' ' + JSON.stringify(payload.settings));
      cb({ returnValue: true });
    },
    privacy: {
      acrConsentKeys: function (cb) { cb(['acrAllowed', 'acrOnAllowed']); },
      setConsent: function (key, on, cb) {
        calls.push(key + ' ' + on);
        cb(key === 'acrOnAllowed' ? { ok: true, alsoChanged: 2 } : { ok: false, error: 'no such consent flag: ' + key });
      }
    }
  });
  controls.doControl('acr', false, function (res) {
    assert.deepEqual(calls, ['setSystemSettings {"livePlus":"off"}', 'acrAllowed false', 'acrOnAllowed false']);
    assert.deepEqual(res, { ok: true, alsoChanged: 2 });
    console.log('  ✓ the ACR switch writes livePlus and every flag found');
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
    fs.rmdirSync(dir);
    console.log('ALL test-acr-consent.js assertions passed!\n');
  });
}

next();
