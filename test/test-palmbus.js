/**
 * test/test-palmbus.js - one-shot luna calls go through palmbus where it is
 * switched on, and through luna-send where the bus refuses them, cannot read
 * them or leaves them unanswered, from then on, a refusal across a restart
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
global.fakeBus = { calls: [], answers: {} };

// luna-send answers at once, saying it did.
var sent = [];
var lsAnswers = {};
child.execFile = function (file, args, opts, cb) {
  var uri = args[args.length - 2].replace('luna://', '');
  sent.push({ uri: uri, appId: args[0] === '-a' ? args[1] : null });
  var answer = lsAnswers[uri] || { returnValue: true, via: 'luna-send' };
  setTimeout(function () { cb(null, JSON.stringify(answer)); }, 5);
  return { on: function () {} };
};

var luna = require('../server/lib/luna');
var dir = path.join(os.tmpdir(), 'palmbus-' + process.pid);
fs.mkdirSync(dir);
process.on('exit', function () {
  try { fs.unlinkSync(path.join(dir, 'luna-send-only.json')); } catch (e) {}
  fs.rmdirSync(dir);
});
var logs = [];
console.log = (function (log) { return function (m) { if (/^luna: /.test(String(m))) logs.push(String(m)); else log.apply(console, arguments); }; })(console.log);

console.log('Running test-palmbus.js ...');

global.fakeBus.answers['com.webos.audio/getSoundOut'] = { returnValue: false, errorCode: -1, errorText: 'Denied method call "getSoundOut" for category "/"' };
global.fakeBus.answers['com.webos.service.audio/master/getVolume'] = null;
global.fakeBus.answers['com.webos.service.settings/getSystemSettings'] = { returnValue: false, errorCode: -1, errorText: 'Denied method call "getSystemSettings" for category "/"' };

function call(uri, payload, appId) {
  return function (next) {
    luna.call(uri, payload || {}, function (r, raw) { next(r, raw); }, appId);
  };
}
function steps(list, done) {
  var i = 0;
  (function go() { if (i >= list.length) return done(); list[i++](go); })();
}

assert.strictEqual(luna.usePalmbus(true, dir), true, 'switched on where the binding loads');

luna.call('com.webos.applicationManager/getForegroundAppInfo', {}, function (r, raw) {
  assert.strictEqual(r.via, 'palmbus');
  assert.ok(/"via":"palmbus"/.test(raw), 'the answer\'s text comes too');
  assert.deepEqual(sent, [], 'no luna-send for a call the bus answers');
  console.log('  ✓ a call the bus answers goes through palmbus, with no process started');

  luna.call('com.webos.audio/getSoundOut', {}, function (r2) {
    assert.strictEqual(r2.via, 'luna-send', 'a refused call is answered through luna-send');
    assert.deepEqual(sent.map(function (s) { return s.uri; }), ['com.webos.audio/getSoundOut']);
    var busBefore = global.fakeBus.calls.length;
    luna.call('com.webos.audio/getSoundOut', {}, function (r3) {
      assert.strictEqual(r3.via, 'luna-send');
      assert.strictEqual(global.fakeBus.calls.length, busBefore, 'and goes to luna-send straight away after');
      var kept = JSON.parse(fs.readFileSync(path.join(dir, 'luna-send-only.json'), 'utf8'));
      assert.ok(/^refused: Denied/.test(kept['com.webos.audio/getSoundOut']), 'the refusal is kept');
      console.log('  ✓ a call the bus refuses goes through luna-send, from then on, and is remembered');

      sent = [];
      luna.call('com.webos.service.settings/getSystemSettings', { category: 'picture' }, function (ra) {
        assert.strictEqual(ra.via, 'palmbus', 'refused under one name, answered under the other');
        assert.deepEqual(ra.payload, { category: 'picture' });
        assert.deepEqual(sent, [], 'no luna-send');
        var seen = global.fakeBus.calls.length;
        luna.call('com.webos.service.settings/getSystemSettings', { category: 'sound' }, function (rb) {
          assert.strictEqual(rb.via, 'palmbus');
          assert.strictEqual(global.fakeBus.calls[seen], 'com.webos.settingsservice/getSystemSettings', 'the other name straight away after');
          assert.strictEqual(global.fakeBus.calls.length, seen + 1);
          console.log('  ✓ a call refused under a renamed service\'s one name goes through palmbus under the other');

      luna.call('com.webos.service.audio/master/getVolume', {}, function (r4) {
        assert.strictEqual(r4.via, 'luna-send', 'an unanswered call is made again through luna-send');
        kept = JSON.parse(fs.readFileSync(path.join(dir, 'luna-send-only.json'), 'utf8'));
        assert.ok(/no answer/.test(kept['com.webos.service.audio/master/getVolume']), 'kept: each one costs the binding until its handle is renewed');
        console.log('  ✓ a call the bus leaves unanswered goes through luna-send, from then on, and is remembered');

        sent = [];
        luna.call('com.webos.notification/getAlertNotification', {}, function (r5) {
          assert.strictEqual(r5.via, 'luna-send');
          assert.strictEqual(sent[0].appId, 'com.webos.surfacemanager', 'made as the app it names');
          console.log('  ✓ a call made as another app goes through luna-send');

          // A restart reads the refusals kept.
          luna.usePalmbus(true, dir);
          sent = [];
          var busCalls = global.fakeBus.calls.length;
          luna.call('com.webos.audio/getSoundOut', {}, function (r6) {
            assert.strictEqual(r6.via, 'luna-send');
            assert.strictEqual(global.fakeBus.calls.length, busCalls, 'not tried on the bus after a restart');
            var before = global.fakeBus.calls.length;
            luna.call('com.webos.service.audio/master/getVolume', {}, function (r7) {
              assert.strictEqual(global.fakeBus.calls.length, before, 'nor is a call it left unanswered');
              assert.strictEqual(r7.via, 'luna-send');
              console.log('  ✓ after a restart what the bus refused or left unanswered goes straight to luna-send');
              otherWords();
            });
          });
        }, 'com.webos.surfacemanager');
      });
        });
      });
    });
  });
});

// A refusal in other words is found by asking luna-send once; a real error is left to the bus.
function otherWords() {
  luna.usePalmbus(true, null);
  global.fakeBus.answers['com.webos.service.panelcontroller/getOledCellInfo'] = { returnValue: false, errorCode: -1, errorText: 'Method "getOledCellInfo" for category "/" was not handled' };
  global.fakeBus.answers['com.webos.service.odd/get'] = { returnValue: false, errorCode: -1, errorText: 'Some other refusal' };
  global.fakeBus.answers['com.webos.service.settings2/getValue'] = { returnValue: false, errorCode: 2, errorText: 'No such key' };
  lsAnswers['com.webos.service.settings2/getValue'] = { returnValue: false, errorCode: 2, errorText: 'No such key', via: 'luna-send' };
  sent = [];
  luna.call('com.webos.service.panelcontroller/getOledCellInfo', {}, function (ra) {
    assert.strictEqual(ra.via, 'luna-send', '"was not handled" is a refusal');
    luna.call('com.webos.service.odd/get', {}, function (rb) {
      assert.strictEqual(rb.via, 'luna-send', 'any other false is checked with luna-send, which answered');
      var bus = global.fakeBus.calls.length;
      luna.call('com.webos.service.odd/get', {}, function (rc) {
        assert.strictEqual(rc.via, 'luna-send');
        assert.strictEqual(global.fakeBus.calls.length, bus, 'and goes there from then on');
        luna.call('com.webos.service.settings2/getValue', {}, function (rd) {
          assert.strictEqual(rd.via, 'luna-send', 'checked once');
          sent = [];
          luna.call('com.webos.service.settings2/getValue', {}, function (re) {
            assert.strictEqual(re.errorText, 'No such key');
            assert.deepEqual(sent, [], 'where luna-send fails too, the bus\'s answer stands from then on');
            console.log('  ✓ a refusal in other words is found by asking luna-send once, and a real error is left to the bus');
            renewed();
          });
        });
      });
    });
  });
}

// An unanswered call renews the handle; a call waiting on the old one is made again on the new.
function renewed() {
  luna.usePalmbus(true, null);
  global.fakeBus.answers['com.webos.service.hangs/get'] = null;
  global.fakeBus.delays = { 'com.webos.service.slow/get': 1800 };
  var handlesBefore = global.fakeBus.handles;
  var got = {};
  luna.call('com.webos.service.hangs/get', {}, function (r) { got.hang = r && r.via; });
  setTimeout(function () {
    luna.call('com.webos.service.slow/get', {}, function (r) { got.slow = r && r.via; });
  }, 500);
  setTimeout(function () {
    assert.strictEqual(got.hang, 'luna-send', 'the unanswered call through luna-send');
    assert.strictEqual(global.fakeBus.handles, handlesBefore + 1, 'and a new handle opened');
    assert.strictEqual(got.slow, 'palmbus', 'the call cut short on the old handle answered on the new');
    global.fakeBus.delays = {};
    console.log('  ✓ an unanswered call renews the handle, and a call cut short by it is made again');
    order();
  }, 9000);
}

// Key presses keep their order when one is refused and goes through luna-send.
function order() {
  luna.usePalmbus(true, null);
  global.fakeBus.answers['com.webos.service.networkinput/test/sendKeyCode'] = { returnValue: false, errorText: 'Denied method call "sendKeyCode"' };
  var answered = [];
  luna.callUrgent('com.webos.service.networkinput/test/sendKeyCode', { keyCode: 1 }, function () { answered.push('first'); });
  luna.callUrgent('com.webos.service.tv.keymanager/sendKey', { keyCode: 2 }, function () { answered.push('second'); });
  setTimeout(function () {
    assert.deepEqual(answered, ['first', 'second'], 'the second press waits for the first, which went through luna-send');
    console.log('  ✓ key presses stay in order when one goes through luna-send');
    luna.usePalmbus(false, null);
    sent = [];
    luna.call('com.webos.applicationManager/getForegroundAppInfo', {}, function (r) {
      assert.strictEqual(r.via, 'luna-send', 'switched off: luna-send as before');
      console.log('  ✓ switched off, every call goes through luna-send');
      console.log('ALL test-palmbus.js assertions passed!\n');
      process.exit(0);
    });
  }, 4000);
}
