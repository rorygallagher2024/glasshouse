/**
 * test/test-screensaver-lost.js - Start screensaver where sam has lost the
 * screen saver app: it rereads its apps first, and says so if that fails
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var screensavers = require('../server/lib/screensavers');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-screensaver-lost.js ...');

var realLog = console.log;
console.log = function () {};

// A TV whose sam answers "Invalid appId" for the screen saver until a nudge
// (a blockedAppList write) makes it read its apps again, when canFind allows.
function tv(canFind) {
  var state = { found: false, started: 0, nudges: 0 };
  state.luna = function (uri, params, cb) {
    if (uri === 'com.webos.service.tvpower/power/getPowerState') return cb({ returnValue: true, state: state.started ? 'Screen Saver' : 'Active' });
    if (uri === 'com.webos.applicationManager/getForegroundAppInfo') return cb({ returnValue: true, appId: 'netflix' });
    if (uri === 'com.webos.applicationManager/getAppInfo') {
      return cb(state.found ? { returnValue: true, appInfo: { id: params.id, type: 'qml' } }
        : { returnValue: false, errorCode: 1, errorText: 'Invalid appId specified OR Unsupported Application Type: ' + params.id });
    }
    if (uri === 'com.webos.service.config/getConfigs') return cb({ returnValue: true, configs: { 'profile.blockedAppList': [] } });
    if (uri === 'com.webos.service.config/setConfigs') {
      state.nudges++;
      if (canFind) state.found = true;
      return cb({ returnValue: true });
    }
    if (/blockSystemApp$/.test(uri)) return cb({ returnValue: false, errorText: 'invalid parameters' });
    if (uri === 'com.webos.service.tvpower/power/turnOnScreenSaver') { state.started++; return cb({ returnValue: true }); }
    cb({ returnValue: true });
  };
  samrescan.init({ luna: state.luna, nudgeMs: 1, pollMs: 1 });
  screensavers.init({ luna: state.luna, config: {}, injectKey: function () {}, KEY_BACK: 412,
                      inputKey: function (id) { return id; } });
  return state;
}

var back = tv(true);
screensavers.trigger(function (r) {
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(back.nudges >= 1, 'sam was made to read its apps again');
  assert.strictEqual(back.started, 1, 'then the screen saver was started');
  realLog('  ✓ a screen saver app sam has lost is found again by a reread, then started');

  var gone = tv(false);
  screensavers.trigger(function (r2) {
    assert.strictEqual(r2.ok, false);
    assert.ok(/lost track of its screen saver app/.test(r2.error), r2.error);
    assert.strictEqual(gone.started, 0, 'nothing is asked of tvpower');
    realLog('  ✓ one still lost after the reread is reported, not started silently');
    console.log = realLog;
    console.log('ALL test-screensaver-lost.js assertions passed!\n');
  });
});
