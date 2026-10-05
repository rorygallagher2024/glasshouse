/**
 * test/test-timers.js - LG's On and Off Timers
 */

var assert = require('assert');
var timers = require('../server/lib/timers');

console.log('Running test-timers.js ...');

// As a C2 (webOS 9.2) reports them, with LG's range for the hour running to 24.
var c2 = {
  onTimerEnable: 'on', onTimerHour: '7', onTimerMinute: '5', onTimerWeekday: '62',
  onTimerAppId: 'com.webos.app.livetv', onTimerChannel: 'noChannel', autoOff2HourOnTimer: 'on',
  offTimerEnable: 'off', offTimerHour: '24', offTimerMinute: '0', offTimerWeekday: '0',
  sleepTimer: 'off'
};
var t = timers.fromSettings(c2);
assert.deepStrictEqual(t.on, { enabled: true, time: '07:05', days: [1, 2, 3, 4, 5], autoOff: true });
assert.deepStrictEqual(t.off, { enabled: false, time: '00:00', days: [] });
console.log('  ✓ days come from a Sunday-first bitmask, 0 being once');

assert.strictEqual(timers.fromSettings({ sleepTimer: 'off' }), undefined);
assert.strictEqual(timers.fromSettings(null), undefined);
console.log('  ✓ a TV without the timers has none');

function fakeLuna(stored, homeApp) {
  var writes = [];
  var fn = function (uri, payload, cb) {
    if (/getSystemSettings$/.test(uri)) return cb({ returnValue: true, settings: stored });
    if (/getAppInfo$/.test(uri)) return cb({ returnValue: !!homeApp });
    writes.push(payload.settings);
    cb({ returnValue: true });
  };
  fn.writes = writes;
  return fn;
}

var luna = fakeLuna(c2, true);
timers.set(luna, { timer: 'off', time: '23:30', days: [0, 6] }, function (r) {
  assert.ok(r.ok);
  assert.deepStrictEqual(luna.writes, [{ offTimerHour: '23', offTimerMinute: '30', offTimerWeekday: '65' }]);
});
console.log('  ✓ only the fields given are written');

luna = fakeLuna(c2, true);
timers.set(luna, { timer: 'on', enabled: true }, function (r) {
  assert.ok(r.ok);
  assert.deepStrictEqual(luna.writes, [{ onTimerEnable: 'on', onTimerAppId: 'com.webos.app.home' }]);
});
console.log('  ✓ switched on while set to Live TV with no channel, it turns the TV on to Home');

luna = fakeLuna(c2, false);
timers.set(luna, { timer: 'on', enabled: true }, function (r) {
  assert.ok(r.ok);
  assert.deepStrictEqual(luna.writes, [{ onTimerEnable: 'on' }]);
});
console.log('  ✓ without a Home app (webOS 3-5), it is switched on as set, as LG\'s own menu does');

luna = fakeLuna({ onTimerAppId: 'com.webos.app.hdmi2', onTimerChannel: 'noChannel' }, true);
timers.set(luna, { timer: 'on', enabled: true }, function (r) {
  assert.deepStrictEqual(luna.writes, [{ onTimerEnable: 'on' }]);
});
console.log('  ✓ an input already chosen is kept');

[{ timer: 'on', time: '24:00' }, { timer: 'on', time: '7' }, { timer: 'on', days: [7] },
 { timer: 'on', days: '1' }, { timer: 'sleep', enabled: true }, { timer: 'on' }].forEach(function (bad) {
  luna = fakeLuna(c2, true);
  timers.set(luna, bad, function (r) { assert.ok(!r.ok, JSON.stringify(bad)); });
  assert.strictEqual(luna.writes.length, 0);
});
console.log('  ✓ bad times, days and timers are refused');

console.log('ALL test-timers.js assertions passed!\n');
