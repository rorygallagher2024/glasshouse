/**
 * test/test-tile-hiding-handover.js - tile hiding handed to Glasshouse Home:
 * the apps it hid go on Glasshouse Home's hidden list (those in More apps
 * kept there), it is switched off, and sam is never restarted for it, even
 * where it does not read the apps again.
 *
 * Strict ES5 for Node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var FLAG = '/var/lib/tvweb/tile_hiding_enabled';

var calls = [];
child.execFile = function (file, args, opts, cb) {
  calls.push(file + ' ' + (args || []).join(' '));
  process.nextTick(function () { cb(null, '', ''); });
};

var files = {};
files[FLAG] = '1\n';
files['/var/lib/tvweb/hidden_apps'] = 'com.webos.app.camera\ncom.webos.app.mediadiscovery\n';
var env = mockEnv.createMockEnv({ files: files, luna: {} });
env.install();

var apps = require('../server/lib/apps');
var samrescan = require('../server/lib/samrescan');
var home = require('../server/lib/home');

console.log('Running test-tile-hiding-handover.js ...');

// Outside /var and /tmp, which mock-env keeps in memory, so home.json's write
// and rename reach the disk.
var dir = path.join(__dirname, '.tile-handover-' + process.pid);
fs.mkdirSync(dir);
home.init({ stateDir: dir, webosVersion: '9.2.2', port: 8080, luna: function (uri, params, cb) { cb({ returnValue: false }); } });

// Media Player is in More apps; Netflix is hidden there already.
var layout = home.layout();
home.setLayout({ hidden: { app: layout.hidden.app.concat(['netflix']) }, folder: ['com.webos.app.mediadiscovery'] }, function (r) {
  assert.ok(r.ok, 'layout saved: ' + JSON.stringify(r));

  // sam does not read the apps again: no restart either.
  var refreshed = 0;
  samrescan.refresh = function (check, cb) { refreshed++; cb(false); };
  apps.init({ luna: env.mockLuna, config: { allowControl: true, allowTileHiding: true } });
  calls = [];

  apps.handOverToHome(home.hideApps, function (handed) {
    assert.strictEqual(handed, true);
    var hidden = home.layout().hidden.app;
    assert.ok(hidden.indexOf('com.webos.app.camera') !== -1, 'what tile hiding hid stays hidden in Glasshouse Home');
    assert.ok(hidden.indexOf('com.webos.app.mediadiscovery') === -1, 'an app in More apps stays there');
    assert.deepEqual(home.layout().folder, ['com.webos.app.mediadiscovery']);
    assert.strictEqual(hidden.filter(function (id) { return id === 'netflix'; }).length, 1, 'no duplicates');
    console.log('  ✓ the apps tile hiding hid are hidden in Glasshouse Home, More apps kept');

    assert.strictEqual(apps.isTileHidingEnabled(), false, 'tile hiding switched off');
    assert.strictEqual(refreshed, 1, 'sam asked to read the apps again');
    assert.ok(!calls.some(function (c) { return /systemctl|initctl|kill|sam/.test(c); }), 'sam not restarted: ' + calls.join('; '));
    console.log('  ✓ switched off with sam asked to reread, never restarted');

    apps.handOverToHome(function () { throw new Error('handed over twice'); }, function (again) {
      assert.strictEqual(again, false, 'nothing to hand over once it is off');
      console.log('  ✓ handed over once');
      fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
      fs.rmdirSync(dir);
      console.log('ALL test-tile-hiding-handover.js assertions passed!');
      // apps.init leaves a timer running.
      process.exit(0);
    });
  });
});
