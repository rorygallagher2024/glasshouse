/**
 * test/test-privacy-held.js - consent flags and Live Plus switched off are put back off
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var privacy = require('../server/lib/privacy');

console.log('Running test-privacy-held.js ...');

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-held-')) : path.join(os.tmpdir(), 'glasshouse-held-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

var tv = { livePlus: 'on', eulaStatus: { acrAllowed: true }, eulaInfoNetwork: { eulaList: [] } };
var writes = [];
function luna(uri, payload, cb) {
  if (/getSystemSettings$/.test(uri)) {
    var out = {};
    (payload.keys || []).forEach(function (k) { out[k] = tv[k]; });
    return cb({ returnValue: true, settings: out });
  }
  writes.push(payload);
  if (payload.settings.livePlus) tv.livePlus = payload.settings.livePlus;
  if (payload.settings.eulaInfoNetwork) tv.eulaInfoNetwork = payload.settings.eulaInfoNetwork;
  if (payload.settings.eulaStatus) tv.eulaStatus = payload.settings.eulaStatus;
  cb({ returnValue: true });
}
privacy.init({ stateDir: dir, luna: luna });

privacy.rememberHeld('livePlus', '', true);
privacy.rememberHeld('consent', 'acrAllowed', true);
privacy.rememberHeld('consent', 'voiceAllowed', true);
privacy.rememberHeld('consent', 'voiceAllowed', false);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'privacy-held.json'), 'utf8')),
                 { livePlus: true, 'consent:acrAllowed': true });

// Still off: nothing written.
tv.livePlus = 'off'; tv.eulaStatus = { acrAllowed: false };
privacy.reapplyHeld(function () {
  assert.strictEqual(writes.length, 0);
  // The TV turns both back on at boot.
  tv.livePlus = 'on'; tv.eulaStatus = { acrAllowed: true };
  privacy.reapplyHeld(function () {
    assert.strictEqual(tv.livePlus, 'off');
    assert.strictEqual(tv.eulaStatus.acrAllowed, false);
    console.log('  ✓ held settings are put back off, others left alone');
    var file = path.join(dir, 'privacy-held.json');
    fs.unlinkSync(file);
    // Switched off on the Privacy tab: recorded. Switched on again: dropped.
    tv.eulaStatus = { acrAllowed: true };
    privacy.setConsent('acrAllowed', false, function (r) {
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'consent:acrAllowed': true });
      privacy.setConsent('acrAllowed', true, function (r2) {
        assert.ok(r2.ok, JSON.stringify(r2));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
        console.log('  ✓ a consent switched off is recorded, and dropped when switched on');
        fs.unlinkSync(file);
        fs.rmdirSync(dir);
      });
    });
  });
});
