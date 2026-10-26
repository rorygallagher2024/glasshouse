/* Alternative View is opt-in, saved independently of the Home takeover and
 * row arrangement, and off for layouts saved by older versions. Strict ES5. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var home = require('../server/lib/home');
var dir = path.join(os.tmpdir(), 'glasshouse-home-view-' + process.pid);
var calls = 0;
fs.mkdirSync(dir);
process.on('exit', function () {
  home.stop();
  fs.readdirSync(dir).forEach(function (name) { fs.unlinkSync(path.join(dir, name)); });
  fs.rmdirSync(dir);
});
console.log('Running test-home-view.js ...');
[null, {}, {view:'other',weather:'yes'}, {view:true,weather:1}].forEach(function (raw) {
  var normal = home.normalise(raw);
  assert.strictEqual(normal.view, 'standard');
  assert.strictEqual(normal.weather, false);
});
var normal = home.normalise({view:'alternative',weather:true});
assert.strictEqual(normal.view, 'alternative');
assert.strictEqual(normal.weather, true);
assert.strictEqual(normal.enabled, false);
var seed = {rows:['dev','app','ch'],hidden:{app:['unwanted'],dev:['spare'],ch:[]},
  colours:{text:'#ece7df',accent:'#b9a6ff'},fade:true,hideUnused:true,picture:true,search:true,searchHintSeen:true};
fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(seed));
home.init({stateDir:dir, webosVersion:'10.2.2', luna:function () { calls++; }});
// Search discovers LG's host at init; appearance saves must add no calls.
var initialCalls = calls;
assert.strictEqual(home.layout().view, 'standard');
home.setLayout({view:'alternative',weather:true}, function (r) {
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.layout.view, 'alternative');
  assert.strictEqual(r.layout.weather, true);
  assert.deepEqual(r.layout.rows, seed.rows);
  assert.deepEqual(r.layout.hidden.app, seed.hidden.app);
  assert.deepEqual(r.layout.hidden.dev, seed.hidden.dev);
  assert.deepEqual(r.layout.colours, seed.colours);
  assert.strictEqual(r.layout.fade, true);
  assert.strictEqual(r.layout.hideUnused, true);
  assert.strictEqual(r.layout.picture, true);
  assert.strictEqual(r.layout.search, true);
  assert.strictEqual(r.layout.searchHintSeen, true);
  var disk = JSON.parse(fs.readFileSync(path.join(dir, 'home.json'), 'utf8'));
  assert.strictEqual(disk.view, 'alternative');
  assert.strictEqual(disk.weather, true);
  assert.strictEqual(disk.enabled, false);
  assert.strictEqual(disk.search, true);
  assert.strictEqual(calls, initialCalls, 'a view change must not call LG services');
  home.setLayout({hidden:{app:['another']}}, function (r2) {
    assert.ok(r2.ok);
    assert.strictEqual(r2.layout.view, 'alternative');
    assert.strictEqual(r2.layout.weather, true);
    assert.strictEqual(r2.layout.search, true);
    assert.deepEqual(r2.layout.rows, seed.rows);
    home.setLayout({reset:true}, function (r3) {
      assert.ok(r3.ok);
      assert.strictEqual(r3.layout.view, 'alternative', 'row reset is not an appearance reset');
      assert.strictEqual(r3.layout.weather, true);
      assert.strictEqual(r3.layout.search, true, 'row reset keeps the separate search preference');
      home.setLayout({view:'standard'}, function (r4) {
        assert.ok(r4.ok);
        assert.strictEqual(r4.layout.view, 'standard');
        assert.strictEqual(r4.layout.weather, true, 'preference is kept, but Standard never fetches');
        assert.strictEqual(r4.layout.search, true, 'Standard keeps the search preference');
        home.setLayout({weather:false}, function (r5) {
          assert.ok(r5.ok);
          assert.strictEqual(r5.layout.weather, false);
          home.setLayout({search:false}, function (r6) {
            assert.ok(r6.ok);
            assert.strictEqual(r6.layout.search, false);
            assert.strictEqual(r6.layout.view, 'standard');
            assert.strictEqual(r6.layout.weather, false);
            assert.strictEqual(r6.layout.searchHintSeen, true);
            assert.strictEqual(calls, initialCalls);
            home.stop();
            home.init({stateDir:dir});
            assert.strictEqual(home.layout().view, 'standard');
            assert.strictEqual(home.layout().weather, false);
            assert.strictEqual(home.layout().search, false);
            assert.strictEqual(home.layout().searchHintSeen, true);
            console.log('ALL test-home-view.js assertions passed!');
          });
        });
      });
    });
  });
});
