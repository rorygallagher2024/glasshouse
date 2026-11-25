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

step('the compositor\'s bar is only on the compositor while a Brightness key is set, in every style, and is taken off when none is', function (done) {
  var made = 0, destroyed = 0, launched = [];
  function bar() { made++; return { show: function () { return true; }, hide: function () {}, destroy: function () { destroyed++; }, volumeBar: null }; }
  var volumeBar = { restartClosingTimer: function () {}, closeView: function () {} };
  var view = { children: [volumeBar] };
  view.parent = { children: [view] };
  var sandbox = vm.createContext({
    console: console,
    applicationManager: { launch: function (id, params) { launched.push(JSON.parse(params).level); } },
    views: { starfishVolume: view },
    Qt: { createQmlObject: bar }
  });
  var setup = levelBar.filterShow('com.example.bar');
  var config = function (value) { return 'var value = ' + JSON.stringify(value) + ';\n' + levelBar.filterConfig(); };
  vm.runInContext(setup, sandbox);
  vm.runInContext(config({}), sandbox);
  assert.strictEqual(made, 0, 'nothing is made with no Brightness key set');
  vm.runInContext(config({ osd: true }), sandbox);
  assert.strictEqual(made, 1, 'made with a key set');
  vm.runInContext(config({ osd: true, osdStyle: 'horizontal' }), sandbox);
  vm.runInContext(config({ osd: true, osdStyle: 'vertical' }), sandbox);
  assert.strictEqual(made, 1, 'and only once, whatever the style: it draws them all');
  assert.strictEqual(destroyed, 0);
  vm.runInContext(config({}), sandbox);
  assert.strictEqual(destroyed, 1, 'taken off the compositor when the keys are cleared');
  vm.runInContext(config({ osd: true }), sandbox);
  assert.strictEqual(made, 2, 'made again when a key is set again');
  // A volume view without LG's volume bar still holds the bar: LG's pictures are left to the item, which draws the layout itself.
  made = 0; destroyed = 0; launched.length = 0;
  var other = { children: [{ children: [] }] };
  other.parent = { children: [other] };
  var sandbox2 = vm.createContext({
    console: console,
    applicationManager: { launch: function (id, params) { launched.push(JSON.parse(params).level); } },
    views: { starfishVolume: other },
    Qt: { createQmlObject: bar }
  });
  vm.runInContext(setup + '\n' + config({ osd: true }) + '\nglasshouseBrightnessShow(40, 1);', sandbox2);
  assert.strictEqual(made, 1);
  assert.deepEqual(launched, [], 'no app opens');
  // Where the QML cannot be made the app opens, once for each press, and the failure is not tried again.
  made = 0; launched.length = 0;
  var tried = 0;
  var sandbox3 = vm.createContext({
    console: { warn: function () {}, log: console.log },
    applicationManager: { launch: function (id, params) { launched.push(JSON.parse(params).level); } },
    views: { starfishVolume: view },
    Qt: { createQmlObject: function () { tried++; throw new Error('Cannot load library'); } }
  });
  vm.runInContext(setup + '\n' + config({ osd: true }) + '\nglasshouseBrightnessShow(40, 1); glasshouseBrightnessShow(50, 2);', sandbox3);
  assert.strictEqual(tried, 1, 'tried once');
  assert.deepEqual(launched, [40, 50], 'the app opens');
  done();
});

step('the QML draws the four looks and waits for every one of LG\'s pictures', function (done) {
  var qml = levelBar.COMPOSITOR_BAR_QML;
  ['trackImage', 'fillImage', 'capTop', 'capBottom', 'arrowUp', 'arrowDown'].forEach(function (id) {
    assert.ok(new RegExp(id + '\\.status === Image\\.Ready').test(qml), id + ' is checked');
  });
  assert.ok(/property bool nativeLook: ready && volumeBar !== null/.test(qml), 'LG\'s pictures need LG\'s volume bar too');
  assert.ok(/style === "horizontal" \? "h" : style === "vertical" \? "v" : \(nativeLook \? "lg" : "lgdrawn"\)/.test(qml), 'the look is chosen by the style and by what loaded');
  assert.ok(/function show\(value, style\)/.test(qml));
  assert.ok(/function giveWay\(done\)[\s\S]*?hold\.restart\(\)/.test(qml), 'giveWay keeps hold as a backstop if opened never arrives');
  assert.ok(!/\n\s*Image \{[^}]*visible: bar\.mode === "lgdrawn"/.test(qml), 'the drawn look uses no picture');
  done();
});

step('the bar is drawn once for each level and no app is opened', function (done) {
  var launched = [], made = [], shown = [], destroyed = 0, ready = true;
  var old = { objectName: levelBar.COMPOSITOR_BAR, destroy: function () { destroyed++; } };
  var volumeBar = { restartClosingTimer: function () {}, closeView: function () {} };
  var volumeMute = { moveDirection: 'down', closeView: function () {} };
  var volumeView = { children: [{ children: [volumeMute] }, volumeBar] };
  var host = { children: [volumeView, old] };
  volumeView.parent = host;
  var sandbox = {
    console: console,
    applicationManager: { launch: function (id, params) { launched.push(JSON.parse(params).level); } },
    views: { starfishVolume: volumeView },
    Qt: { createQmlObject: function (qml, parent, name) {
      made.push({ qml: qml, parent: parent, name: name });
      return made[made.length - 1].bar = { show: function (level, style) { shown.push([level, style]); return ready; }, hide: function () {} };
    } }
  };
  var code = 'var value = { osd: true };\n' + levelBar.filterShow('com.example.bar') + '\n' + levelBar.filterConfig() + '\n' +
    'glasshouseBrightnessShow(60, 1); glasshouseBrightnessShow(70, 1); glasshouseBrightnessShow(80, 2);';
  vm.runInNewContext(code, sandbox);
  assert.strictEqual(made.length, 1, 'made once, ahead of the first press');
  assert.strictEqual(made[0].parent, host, 'beside the volume view');
  assert.strictEqual(destroyed, 1, 'one left by an earlier copy of the filter is taken off');
  assert.ok(/objectName: "glasshouseBrightnessBar"/.test(made[0].qml));
  assert.strictEqual(made[0].bar.volumeBar, volumeBar, 'told LG\'s volume bar, to close it early');
  assert.strictEqual(made[0].bar.volumeMute, volumeMute, 'and LG\'s mute icon, found under the positioner');
  assert.deepEqual(shown, [[60, 'lg'], [70, 'lg'], [80, 'lg']], 'every level, not once for each press, with the style');
  assert.deepEqual(launched, [], 'no app opened');
  // The pill styles go to the same item.
  shown.length = 0;
  vm.runInNewContext(code.replace('{ osd: true }', '{ osd: true, osdStyle: "vertical" }'), sandbox);
  assert.deepEqual(shown.map(function (x) { return x[1]; }), ['vertical', 'vertical', 'vertical']);
  assert.deepEqual(launched, []);
  // An item that cannot show the level leaves it to the app.
  ready = false; made.length = 0; shown.length = 0;
  vm.runInNewContext(code, sandbox);
  assert.deepEqual(launched, [60, 80], 'the app, once for each press');
  done();
});

next();
