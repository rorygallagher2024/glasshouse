/**
 * test/test-home-lg-options.js - the Home tab is offered for LG's Home's own
 * options (its layout, system apps hidden from it, and Open Home at power-on)
 * on a TV without Glasshouse Home, as a B8 (webOS 4.4) is, and ?with=lghome
 * carries them. Under Glasshouse Home, hiding system apps is left out.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var home = require('../server/lib/home');
var routes = require('../server/lib/routes');

console.log('Running test-home-lg-options.js ...');

var dir = path.join(os.tmpdir(), 'home-lg-options-' + process.pid);
fs.mkdirSync(dir);
// The TV has LG's Open Home at power-on only where powerOn is set.
var powerOn = false;
home.init({ stateDir: dir, webosVersion: '4.4.3', port: 8080, luna: function (uri, params, cb) {
  if (powerOn && /getSystemSettings$/.test(uri) && params.keys && params.keys.indexOf('homeAutoLaunch') !== -1) {
    return cb({ returnValue: true, settings: { homeAutoLaunch: 'off' } });
  }
  cb({ returnValue: false });
} });

var tileHiding = true;
var apps = {
  tileHidingAllowed: function () { return tileHiding; },
  getApps: function (cb) {
    cb({ ok: true, installed: [], hiddenCount: 1, tileHidingEnabled: true, tileHidingNudge: false,
      systemTiles: [{ id: 'com.webos.app.music', title: 'Music', hidden: true }] });
  }
};
// webOS 4.4 has no layout Glasshouse can change.
var homeScreen = { supported: function () { return false; }, getHomeScreen: function (cb) { cb(null); } };
routes.init({ config: { allowControl: true }, home: home, apps: apps, homeScreen: homeScreen,
  fromHomebrewChannel: function () { return false; } });

var server = http.createServer(routes.handleRequest), port;
function get(url, cb) {
  http.get({ hostname: '127.0.0.1', port: port, path: url }, function (res) {
    var body = '';
    res.on('data', function (d) { body += d; });
    res.on('end', function () { cb(JSON.parse(body)); });
  }).on('error', function (e) { throw e; });
}

function post(url, body, cb) {
  var req = http.request({ hostname: '127.0.0.1', port: port, path: url, method: 'POST',
    headers: { 'Content-Type': 'application/json' } }, function (res) {
    var text = '';
    res.on('data', function (d) { text += d; });
    res.on('end', function () { cb(res.statusCode, JSON.parse(text)); });
  });
  req.on('error', function (e) { throw e; });
  req.end(JSON.stringify(body));
}

server.listen(0, '127.0.0.1', function () {
  port = server.address().port;
  get('/api/home', function (st) {
    assert.strictEqual(st.supported.ok, false, 'no Glasshouse Home on webOS 4.4');
    assert.strictEqual(st.available, true, 'the tab is there for LG\'s Home\'s options');
    assert.strictEqual(st.lgHomeAvailable, true);
    assert.strictEqual(st.lgHome, undefined, 'the options themselves only when asked for');
    get('/api/home?with=lghome', function (st2) {
      assert.deepEqual(st2.lgHome.systemTiles.map(function (x) { return x.id; }), ['com.webos.app.music']);
      assert.strictEqual(st2.lgHome.tileHidingEnabled, true);
      assert.strictEqual(st2.lgHome.homeScreen, null);
      console.log('  ✓ a TV without Glasshouse Home has the Home tab for hiding system apps');
      tileHiding = false;
      get('/api/home', function (st3) {
        assert.strictEqual(st3.available, false, 'nothing to show: no tab');
        console.log('  ✓ with neither, the Home tab is left out');
        powerOn = true;
        get('/api/home', function (st4) {
          assert.strictEqual(st4.homeAutoLaunch, false);
          assert.strictEqual(st4.available, true, 'Open Home at power-on alone is enough');
          console.log('  ✓ LG\'s Open Home at power-on alone gives the Home tab');
          tileHiding = true;
          fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ enabled: true }));
          get('/api/home?with=lghome', function (st5) {
            assert.strictEqual(st5.lgHome.tileHidingAvailable, false, 'Glasshouse Home hides apps itself');
            assert.deepEqual(st5.lgHome.systemTiles, []);
            post('/api/apps/tile-hiding', { enabled: true }, function (code, r) {
              assert.strictEqual(code, 400);
              assert.ok(/Glasshouse Home/.test(r.error), r.error);
              console.log('  ✓ under Glasshouse Home tile hiding is neither shown nor switched on');
              server.close();
              console.log('ALL test-home-lg-options.js assertions passed!');
            });
          });
        });
      });
    });
  });
});
