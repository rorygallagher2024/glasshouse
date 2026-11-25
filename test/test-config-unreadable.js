/**
 * test/test-config-unreadable.js - a setting saved while config.json cannot be
 * read is refused, and the file is left as it is, rather than replaced by that
 * one setting.
 *
 * Strict ES5 and node 0.10 APIs: runs on the TV's node.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var routes = require('../server/lib/routes');

console.log('Running test-config-unreadable.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-config-' + process.pid);
fs.mkdirSync(dir);
var CFG = path.join(dir, 'config.json');

routes.init({
  config: { web: { enabled: false }, token: '', allowControl: true },
  configFile: CFG,
  version: '0.159.0'
});

// No file yet: the first setting starts it.
routes.writeSettings({ update: { check: true } }, function (err) {
  assert.ifError(err);
  assert.deepEqual(JSON.parse(fs.readFileSync(CFG, 'utf8')), { update: { check: true } });

  // A readable file keeps everything else.
  fs.writeFileSync(CFG, JSON.stringify({ mqtt: { host: '192.168.1.65' }, update: { check: true } }));
  routes.writeSettings({ update: { askOnTv: true } }, function (err2) {
    assert.ifError(err2);
    var kept = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    assert.strictEqual(kept.mqtt.host, '192.168.1.65');
    assert.deepEqual(kept.update, { check: true, askOnTv: true });

    // A trailing comma left by a hand edit: refused, the file untouched.
    var broken = '{\n  "mqtt": { "host": "192.168.1.65" },\n  "update": { "check": true, }\n}\n';
    fs.writeFileSync(CFG, broken);
    routes.writeSettings({ update: { askOnTv: false } }, function (err3) {
      assert.ok(err3, 'refused');
      assert.ok(/could not be read/.test(err3.message), err3.message);
      assert.strictEqual(fs.readFileSync(CFG, 'utf8'), broken, 'left as it was');
      fs.unlinkSync(CFG);
      fs.rmdirSync(dir);
      console.log('ALL test-config-unreadable.js assertions passed!');
    });
  });
});
