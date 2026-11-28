/**
 * test/test-palmbus.js - one-shot luna calls through palmbus: which go there,
 * which go through luna-send instead and stay there, that nothing but a read
 * is ever made twice, and when palmbus switches itself off
 *
 * Strict ES5: runs on node 0.10.
 */
require('./fake-clock').install();
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');

process.env.TVWEB_PALMBUS = path.join(__dirname, 'mocks', 'fake-palmbus.js');
var bus = global.fakeBus = { calls: [], answers: {}, delays: {} };

// luna-send answers at once, as the bus would (same shape), unless told otherwise.
var sent = [];
var lsAnswers = {};
child.execFile = function (file, args, opts, cb) {
  var uri = args[args.length - 2].replace('luna://', '');
  sent.push({ uri: uri, appId: args[0] === '-a' ? args[1] : null });
  var answer = lsAnswers[uri] || { returnValue: true, via: 'luna-send', n: JSON.parse(args[args.length - 1]).n || 0 };
  setTimeout(function () { cb(null, JSON.stringify(answer)); }, 5);
  return { on: function () {} };
};

var luna = require('../server/lib/luna');
var dir = path.join(os.tmpdir(), 'palmbus-' + process.pid);
fs.mkdirSync(dir);
var stateFile = path.join(dir, 'palmbus.json');
process.on('exit', function () { try { fs.unlinkSync(stateFile); } catch (e) {} try { fs.rmdirSync(dir); } catch (e) {} });
var logs = [];
console.log = (function (log) { return function (m) { if (/^luna: /.test(String(m))) logs.push(String(m)); else log.apply(console, arguments); }; })(console.log);

console.log('Running test-palmbus.js ...');

function sentTo(uri) { return sent.filter(function (s) { return s.uri === uri; }).length; }
function busTo(uri) { return bus.calls.filter(function (c) { return c === uri; }).length; }
function state() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; } }
// A boot of its own each time, unless a step says: a start in the same boot finds the last still marked running.
var boots = 0;
function start(opts) {
  var o = { setting: null, tried: true, stateDir: dir, version: '1.0.0', boot: 'boot-' + (++boots) };
  for (var k in opts || {}) o[k] = opts[k];
  return luna.configurePalmbus(o);
}

var steps = [];
function step(fn) { steps.push(fn); }
function run(i) {
  if (i >= steps.length) { console.log('ALL test-palmbus.js assertions passed!\n'); process.exit(0); }
  steps[i](function () { run(i + 1); });
}

// 1. On by default where tried, off where not, and the owner's choice wins.
step(function (next) {
  // Each a start of its own, without the state folder, which would take them for restarts.
  assert.strictEqual(start({ setting: null, tried: true, stateDir: null }), true, 'on by default on a version it has been tried on');
  assert.strictEqual(start({ setting: null, tried: false, stateDir: null }), false, 'off by default elsewhere');
  assert.strictEqual(start({ setting: true, tried: false, stateDir: null }), true, 'on where switched on');
  assert.strictEqual(start({ setting: false, tried: true, stateDir: null }), false, 'off where switched off');
  console.log('  ✓ on by default where tried, off elsewhere, and the switch wins');
  next();
});

// 2. A read the bus answers starts no process, and is compared with luna-send once.
step(function (next) {
  start();
  var u = 'com.webos.applicationManager/getForegroundAppInfo';
  luna.call(u, { n: 1 }, function (r) {
    assert.strictEqual(r.via, 'palmbus');
    setTimeout(function () {
      assert.strictEqual(sentTo(u), 1, 'compared with luna-send once');
      assert.strictEqual(state().checked[u], true, 'and the same: kept as checked');
      luna.call(u, { n: 2 }, function (r2) {
        assert.strictEqual(r2.via, 'palmbus');
        setTimeout(function () {
          assert.strictEqual(sentTo(u), 1, 'not compared again');
          console.log('  ✓ a read the bus answers starts no process, and is compared with luna-send once');
          next();
        }, 500);
      });
    }, 500);
  });
});

// 3. A read whose answer is made differently through luna-send goes there.
step(function (next) {
  var u = 'com.webos.applicationManager/listApps';
  bus.answers[u] = { returnValue: true, apps: [1, 2] };
  lsAnswers[u] = { returnValue: true, apps: [1, 2, 3] };
  luna.call(u, {}, function (r) {
    assert.deepEqual(r.apps, [1, 2], 'the bus\'s answer the first time');
    setTimeout(function () {
      assert.ok(/^answered differently/.test(state().lunaSend[u]), 'then luna-send, kept');
      luna.call(u, {}, function (r2) {
        assert.deepEqual(r2.apps, [1, 2, 3]);
        console.log('  ✓ a read answered differently through luna-send goes there from then on');
        next();
      });
    }, 500);
  });
});

// 3b. luna-send failing the comparison says nothing about the bus: tried again, then left to the bus.
step(function (next) {
  var u = 'com.webos.audio/getSoundOutNow';
  bus.answers[u] = { returnValue: true, muted: false, volume: 9 };
  lsAnswers[u] = { returnValue: false, errorCode: -1, errorText: 'Internal error' };
  var n = 0;
  (function again() {
    luna.call(u, {}, function (r) {
      assert.strictEqual(r.volume, 9, 'the bus\'s answer each time');
      setTimeout(function () {
        if (++n < 4) return again();
        assert.ok(!state().lunaSend[u], 'not moved to luna-send');
        assert.strictEqual(state().checked[u], true, 'left to the bus after three comparisons luna-send failed');
        assert.strictEqual(sentTo(u), 3, 'compared three times, then no more');
        console.log('  ✓ a comparison luna-send fails moves nothing, and after three the bus keeps the method');
        next();
      }, 300);
    });
  })();
});

// 4. Refused, in so many words: through luna-send, from then on, kept.
step(function (next) {
  var u = 'com.webos.audio/getSoundOut';
  bus.answers[u] = { returnValue: false, errorCode: -1, errorText: 'Denied method call "getSoundOut" for category "/"' };
  luna.call(u, {}, function (r) {
    assert.strictEqual(r.via, 'luna-send');
    var before = busTo(u);
    luna.call(u, {}, function () {
      assert.strictEqual(busTo(u), before, 'not tried on the bus again');
      assert.ok(/^refused: Denied/.test(state().lunaSend[u]));
      console.log('  ✓ a call the bus refuses goes through luna-send, from then on, and is kept');
      next();
    });
  });
});

// 5. Refused under a renamed service's one name: the other, on the bus.
step(function (next) {
  var u = 'com.webos.service.settings/getSystemSettings';
  bus.answers[u] = { returnValue: false, errorCode: -1, errorText: 'Denied method call "getSystemSettings" for category "/"' };
  var lsBefore = sentTo(u);
  luna.call(u, { n: 5 }, function (r) {
    assert.strictEqual(r.via, 'palmbus');
    assert.strictEqual(r.n, 5);
    assert.strictEqual(busTo('com.webos.settingsservice/getSystemSettings'), 1, 'under the other name');
    luna.call(u, { n: 6 }, function () {
      assert.strictEqual(busTo('com.webos.settingsservice/getSystemSettings'), 2, 'straight away after');
      setTimeout(function () {
        assert.strictEqual(sentTo(u), lsBefore + 1, 'only its comparison went through luna-send');
        console.log('  ✓ a call refused under a renamed service\'s one name goes through palmbus under the other');
        next();
      }, 500);
    });
  });
});

// 6. Another false, in other words: luna-send asked once; a real error stays with the bus.
step(function (next) {
  var odd = 'com.webos.service.odd/getThing';
  bus.answers[odd] = { returnValue: false, errorCode: -1, errorText: 'Some other refusal' };
  var real = 'com.webos.service.store/getValue';
  bus.answers[real] = { returnValue: false, errorCode: 2, errorText: 'No such key' };
  lsAnswers[real] = { returnValue: false, errorCode: 2, errorText: 'No such key' };
  luna.call(odd, {}, function (r) {
    assert.strictEqual(r.via, 'luna-send');
    assert.ok(/^refused: Some other/.test(state().lunaSend[odd]));
    luna.call(real, {}, function () {
      var ls = sentTo(real);
      luna.call(real, {}, function (r2) {
        assert.strictEqual(r2.errorText, 'No such key');
        assert.strictEqual(sentTo(real), ls, 'where luna-send fails too, the bus\'s answer stands from then on');
        console.log('  ✓ a false in other words is checked with luna-send once, and a real error is left to the bus');
        next();
      });
    });
  });
});

// 7. Unanswered: a read is answered through luna-send; anything else is not sent again.
step(function (next) {
  var read = 'com.webos.service.audio/master/getVolume';
  var act = 'com.webos.service.preloadmanager/setPreloadPolicy';
  bus.answers[read] = null;
  bus.answers[act] = null;
  luna.call(read, {}, function (r) {
    assert.strictEqual(r.via, 'luna-send', 'a read: answered through luna-send');
    luna.call(act, { apps: [] }, function (r2) {
      assert.strictEqual(r2, null, 'an action: no answer, as a luna-send timeout gives');
      assert.strictEqual(sentTo(act), 0, 'and not made again through luna-send');
      assert.ok(/no answer/.test(state().lunaSend[act]), 'kept for next time');
      luna.call(act, { apps: [] }, function (r3) {
        assert.strictEqual(r3.via, 'luna-send', 'which goes through luna-send');
        console.log('  ✓ an unanswered read is answered through luna-send, an unanswered action is not made twice');
        next();
      });
    });
  });
});

// 8. A timeout renews the handle: a read waiting on the old one is made again, an action is not.
step(function (next) {
  bus.answers['com.webos.service.hangs/getIt'] = null;
  bus.delays = { 'com.webos.service.slow/getIt': 1800, 'com.webos.service.slow/launchIt': 1800 };
  var got = {};
  luna.call('com.webos.service.hangs/getIt', {}, function () {});
  // Counted from the handle that call opened.
  var handles = bus.handles;
  setTimeout(function () {
    luna.call('com.webos.service.slow/getIt', {}, function (r) { got.read = r && r.via; });
    luna.call('com.webos.service.slow/launchIt', {}, function (r) { got.act = r; });
  }, 500);
  setTimeout(function () {
    assert.strictEqual(bus.handles, handles + 1, 'a new handle');
    assert.strictEqual(got.read, 'palmbus', 'the read cut short answered on the new handle');
    assert.strictEqual(got.act, null, 'the action cut short has no answer');
    assert.strictEqual(busTo('com.webos.service.slow/launchIt'), 1, 'and was not made again');
    assert.strictEqual(sentTo('com.webos.service.slow/launchIt'), 0);
    bus.delays = {};
    console.log('  ✓ a timeout renews the handle; a read cut short is made again, an action is not');
    next();
  }, 9000);
});

// 9. As another app: luna-send.
step(function (next) {
  luna.call('com.webos.notification/getAlertNotification', {}, function (r) {
    assert.strictEqual(r.via, 'luna-send');
    console.log('  ✓ a call made as another app goes through luna-send');
    next();
  }, 'com.webos.surfacemanager');
});

// 10. Key presses keep their order when one goes through luna-send.
step(function (next) {
  bus.answers['com.webos.service.networkinput/test/sendKeyCode'] = { returnValue: false, errorText: 'Denied method call "sendKeyCode"' };
  var order = [];
  luna.callUrgent('com.webos.service.networkinput/test/sendKeyCode', { keyCode: 1 }, function () { order.push('first'); });
  luna.callUrgent('com.webos.service.tv.keymanager/sendKey', { keyCode: 2 }, function () { order.push('second'); });
  setTimeout(function () {
    assert.deepEqual(order, ['first', 'second']);
    console.log('  ✓ key presses stay in order when one goes through luna-send');
    next();
  }, 4000);
});

// 11. A restart keeps what was learned.
step(function (next) {
  start();
  var before = busTo('com.webos.audio/getSoundOut');
  luna.call('com.webos.audio/getSoundOut', {}, function (r) {
    assert.strictEqual(r.via, 'luna-send');
    assert.strictEqual(busTo('com.webos.audio/getSoundOut'), before, 'not tried on the bus after a restart');
    console.log('  ✓ after a restart what was learned still holds');
    next();
  });
});

// 12. Five unanswered calls in a row switch it off for this version.
step(function (next) {
  start();
  for (var i = 0; i < 5; i++) bus.answers['com.webos.service.mute' + i + '/getIt'] = null;
  (function one(j) {
    if (j === 5) return after();
    luna.call('com.webos.service.mute' + j + '/getIt', {}, function () { one(j + 1); });
  })(0);
  function after() {
    assert.strictEqual(luna.palmbusStatus().on, false, 'off');
    assert.ok(/5 calls in a row/.test(state().off.reason));
    assert.strictEqual(start(), false, 'still off after a restart of the same version');
    assert.strictEqual(start({ version: '1.0.1' }), true, 'tried again on a new version');
    console.log('  ✓ five unanswered calls in a row switch it off until the next version');
    next();
  }
});

// 13. The server stopping without exiting twice in one boot switches it off.
step(function (next) {
  fs.unlinkSync(stateFile);
  start({ version: '2.0.0', boot: 'same' });
  // No exit: the next start in this boot finds it still running.
  assert.strictEqual(start({ version: '2.0.0', boot: 'same' }), true, 'once: still on');
  assert.strictEqual(state().uncleanEnds, 1);
  assert.strictEqual(start({ version: '2.0.0', boot: 'other' }), true, 'a reboot in between is not counted');
  assert.strictEqual(state().uncleanEnds, 1);
  start({ version: '2.0.0', boot: 'other' });
  assert.strictEqual(luna.palmbusStatus().on, false, 'twice: off');
  assert.ok(/stopped without exiting/.test(state().off.reason));
  assert.strictEqual(luna.setPalmbus(true), true, 'switched on by hand: tried again');
  assert.ok(!state().off);
  console.log('  ✓ the server stopping without exiting twice in one boot switches it off; the switch brings it back');
  next();
});

// 14. Switched off, everything through luna-send.
step(function (next) {
  luna.setPalmbus(false);
  luna.call('com.webos.applicationManager/getForegroundAppInfo', {}, function (r) {
    assert.strictEqual(r.via, 'luna-send');
    console.log('  ✓ switched off, every call goes through luna-send');
    next();
  });
});

run(0);
