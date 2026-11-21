/**
 * test/test-levelbar.js - what the level bar of a Brightness key shows: the
 * panel's level from a subscription to the settings service's backlight, a
 * read of the settings service while that has not answered, the style kept
 * for two seconds, and the part of the key filter that opens the bar
 *
 * Strict ES5: runs on node 0.12.
 */
require('./fake-clock').install();
var assert = require('assert');
var vm = require('vm');
var levelBar = require('../server/lib/levelbar');

console.log('Running test-levelbar.js ...');

var reads = 0;
var panel = 40;
var style = 'lg';
var styleReads = 0;
var subs = [];

function FakeSub(uri, payload, appId, handlers) {
  this.uri = uri; this.payload = payload; this.handlers = handlers; this.running = false;
  subs.push(this);
}
FakeSub.prototype.start = function () { this.running = true; };
FakeSub.prototype.stop = function () { this.running = false; };

function luna(uri, payload, cb) {
  assert.strictEqual(uri, 'com.webos.service.settings/getSystemSettings');
  assert.deepEqual(payload, { category: 'picture', keys: ['backlight'] });
  reads++;
  process.nextTick(function () { cb({ returnValue: true, settings: { backlight: String(panel) } }); });
}

function start() {
  reads = 0; styleReads = 0; subs = [];
  levelBar.init({ luna: luna, subscription: FakeSub, idleMs: 40, readStyle: function () { styleReads++; return style; } });
}

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function next() {
  var s = steps.shift();
  if (!s) { console.log('test-levelbar.js passed'); return process.exit(0); }
  s.fn(function () { console.log('  ✓ ' + s.name); next(); });
}

step('with no luna to ask, the answer is that there is none', function (done) {
  levelBar.init({});
  levelBar.getBrightness(function (r) {
    assert.deepEqual(r, { ok: false });
    done();
  });
});

step('the first ask reads the settings service and starts a subscription to the backlight', function (done) {
  start();
  levelBar.getBrightness(function (r) {
    assert.deepEqual(r, { ok: true, level: 40, style: 'lg' });
    assert.strictEqual(reads, 1);
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(subs[0].uri, 'com.webos.settingsservice/getSystemSettings');
    assert.deepEqual(subs[0].payload, { category: 'picture', keys: ['backlight'], subscribe: true });
    assert.ok(subs[0].running);
    done();
  });
});

step('once the subscription has answered, the level is its and no further read is made', function (done) {
  subs[0].handlers.message({ returnValue: true, subscribed: true, settings: { backlight: '55' } });
  levelBar.getBrightness(function (r) {
    assert.deepEqual(r, { ok: true, level: 55, style: 'lg' });
    assert.strictEqual(reads, 1);
    subs[0].handlers.message({ returnValue: true, settings: { backlight: '30' } });
    levelBar.getBrightness(function (r2) {
      assert.strictEqual(r2.level, 30, 'and it follows each change it is sent');
      assert.strictEqual(reads, 1);
      done();
    });
  });
});

step('an answer with no level, or a refusal, is not kept', function (done) {
  subs[0].handlers.message({ returnValue: false, errorText: 'Access denied' });
  levelBar.getBrightness(function (r) {
    assert.strictEqual(r.level, 40, 'the ask goes to the settings service again');
    assert.strictEqual(reads, 2);
    done();
  });
});

step('the style is read at most every two seconds, and again once it has changed', function (done) {
  start();
  levelBar.getBrightness(function () {
    levelBar.getBrightness(function () {
      assert.strictEqual(styleReads, 1, 'two asks, one read of the style');
      style = 'horizontal';
      levelBar.getBrightness(function (r) {
        assert.strictEqual(r.style, 'lg', 'the style kept is used for two seconds');
        levelBar.forgetStyle();
        levelBar.getBrightness(function (r2) {
          assert.strictEqual(r2.style, 'horizontal', 'a change of style is seen at once');
          setTimeout(function () {
            levelBar.getBrightness(function (r3) {
              assert.strictEqual(r3.style, 'horizontal');
              assert.ok(styleReads >= 2);
              style = 'lg';
              done();
            });
          }, 2500);
        });
      });
    });
  });
});

step('a closed subscription is not trusted, and with no asks for a while it is stopped and started again by the next', function (done) {
  start();
  levelBar.getBrightness(function () {
    subs[0].handlers.message({ returnValue: true, settings: { backlight: '70' } });
    subs[0].handlers.close();
    levelBar.getBrightness(function (r) {
      assert.strictEqual(r.level, 40, 'after it closes the ask is made of the settings service');
      assert.strictEqual(reads, 2);
      setTimeout(function () {
        assert.strictEqual(subs[0].running, false, 'stopped when no one has asked for a while');
        levelBar.getBrightness(function () {
          assert.strictEqual(subs.length, 2, 'the next ask starts another');
          assert.ok(subs[1].running);
          levelBar.stop();
          assert.strictEqual(subs[1].running, false, 'stop() ends it');
          done();
        });
      }, 100);
    });
  });
});

step('only the four styles are valid', function (done) {
  assert.ok(levelBar.isStyle('lg'));
  assert.ok(levelBar.isStyle('horizontal'));
  assert.ok(levelBar.isStyle('vertical'));
  assert.ok(levelBar.isStyle('none'));
  assert.ok(!levelBar.isStyle('diagonal'));
  assert.ok(!levelBar.isStyle(undefined));
  assert.deepEqual(levelBar.STYLES, ['lg', 'horizontal', 'vertical', 'none']);
  done();
});

step('the filter opens the bar\'s app once for each press, with the level and the style, and only where it is wanted', function (done) {
  var launched = [];
  var sandbox = { applicationManager: { launch: function (id, params) { launched.push({ id: id, params: JSON.parse(params) }); } } };
  // The two values it reads from the configd value, as the filter's own read places them.
  var value = { osd: true, osdStyle: 'horizontal' };
  var code = 'var value = ' + JSON.stringify(value) + ';\n' + levelBar.filterShow('com.example.bar') + '\n' +
    levelBar.filterConfig() + '\n' +
    'glasshouseBrightnessShow(60, 1); glasshouseBrightnessShow(70, 1); glasshouseBrightnessShow(80, 2);';
  vm.runInNewContext(code, sandbox);
  assert.deepEqual(launched.map(function (l) { return l.params.level; }), [60, 80], 'once for each press');
  assert.strictEqual(launched[0].id, 'com.example.bar');
  assert.deepEqual(launched[0].params, { glasshouse: 'osd', kind: 'brightness', level: 60, style: 'horizontal' });
  launched.length = 0;
  vm.runInNewContext('var value = {};\n' + levelBar.filterShow('com.example.bar') + '\n' + levelBar.filterConfig() + '\nglasshouseBrightnessShow(60, 1);', sandbox);
  assert.deepEqual(launched, [], 'nothing opens with no Brightness key set');
  launched.length = 0;
  vm.runInNewContext('var value = { osd: true, osdStyle: "diagonal" };\n' + levelBar.filterShow('com.example.bar') + '\n' + levelBar.filterConfig() + '\nglasshouseBrightnessShow(60, 1);', sandbox);
  assert.strictEqual(launched[0].params.style, 'lg', 'an unknown style is the LG-style one');
  launched.length = 0;
  vm.runInNewContext('var value = { osd: true, osdStyle: "vertical" };\n' + levelBar.filterShow('com.example.bar') + '\n' + levelBar.filterConfig() + '\nglasshouseBrightnessShow(60, 1);', sandbox);
  assert.strictEqual(launched[0].params.style, 'vertical', 'the upright pill is passed on');
  done();
});

next();
