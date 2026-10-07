/**
 * test/test-logs.js - System, Glasshouse, and Kernel log parsing and retrieval
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var assert = require('assert');
var logs = require('../server/lib/logs');

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('detectLevel maps explicit hints and keyword heuristics', function () {
  // Explicit hints
  assert.strictEqual(logs.detectLevel('everything ok', 'err'), 'error');
  assert.strictEqual(logs.detectLevel('everything ok', 'crit'), 'error');
  assert.strictEqual(logs.detectLevel('everything ok', 'emerg'), 'error');
  assert.strictEqual(logs.detectLevel('check status', 'warn'), 'warning');
  assert.strictEqual(logs.detectLevel('trace data', 'debug'), 'debug');
  assert.strictEqual(logs.detectLevel('status ok', 'info'), 'info');
  assert.strictEqual(logs.detectLevel('status ok', 'notice'), 'info');

  // Keyword detection in text
  assert.strictEqual(logs.detectLevel('fatal: failed to open bus connection'), 'error');
  assert.strictEqual(logs.detectLevel('kernel panic - not syncing'), 'error');
  assert.strictEqual(logs.detectLevel('warning: audio sink buffer underrun'), 'warning');
  assert.strictEqual(logs.detectLevel('debug verbose diagnostics enabled'), 'debug');
  assert.strictEqual(logs.detectLevel('server listening on port 8080'), 'info');
});

test('parseSystemLogs parses webOS syslog lines with monotonic timestamps', function () {
  var bootTime = 1760000000000;
  var raw = [
    '2026-10-07T15:59:28.001403Z [13639.010008] user.info sam [] SAM NL_APP_LAUNCH_BEGIN {"id":"com.webos.app.discovery"}',
    '2026-10-07T15:59:29.100000Z [13640.100000] daemon.warn pulseaudio [1234] sink underrun detected',
    '2026-10-07T15:59:30.000000Z [13641.000000] kern.err kernel [0] segfault at 00000000',
    ''
  ].join('\n');

  var parsed = logs.parseSystemLogs(raw, bootTime);
  assert.strictEqual(parsed.length, 3);

  assert.strictEqual(parsed[0].source, 'system');
  assert.strictEqual(parsed[0].ts, '2026-10-07T15:59:28.001403Z');
  assert.strictEqual(parsed[0].mono, 13639.010008);
  assert.strictEqual(parsed[0].level, 'info');
  assert.strictEqual(parsed[0].proc, 'sam');
  assert.strictEqual(parsed[0].msg, 'SAM NL_APP_LAUNCH_BEGIN {"id":"com.webos.app.discovery"}');

  assert.strictEqual(parsed[1].level, 'warning');
  assert.strictEqual(parsed[1].proc, 'pulseaudio');

  assert.strictEqual(parsed[2].level, 'error');
  assert.strictEqual(parsed[2].proc, 'kernel');
});

test('parseSystemLogs handles unstructured syslog lines and empty input', function () {
  var bootTime = 1760000000000;
  assert.deepEqual(logs.parseSystemLogs('', bootTime), []);

  var fallbackRaw = '2026-10-07T16:00:00.000Z simple message without facility';
  var parsed = logs.parseSystemLogs(fallbackRaw, bootTime);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].source, 'system');
  assert.strictEqual(parsed[0].msg, 'simple message without facility');
  assert.strictEqual(parsed[0].proc, 'system');
});

test('parseGlasshouseLogs parses stamped lines and multi-line continuations', function () {
  var bootTime = 1760000000000;
  var raw = [
    '2026-10-07T15:59:30.123Z [13641.123] mqtt: connected to broker at 192.168.1.100',
    '2026-10-07T15:59:31.000Z [13642.000] ha: discovery published for 109 entities',
    '    additional stack trace line',
    '2026-10-07T15:59:32.000Z [13643.000] warning: stats collection safety timeout reached'
  ].join('\n');

  var parsed = logs.parseGlasshouseLogs(raw, bootTime, 13640.0);
  assert.strictEqual(parsed.length, 4);

  assert.strictEqual(parsed[0].source, 'glasshouse');
  assert.strictEqual(parsed[0].ts, '2026-10-07T15:59:30.123Z');
  assert.strictEqual(parsed[0].mono, 13641.123);
  assert.strictEqual(parsed[0].proc, 'mqtt');
  assert.strictEqual(parsed[0].msg, 'mqtt: connected to broker at 192.168.1.100');

  assert.strictEqual(parsed[1].proc, 'ha');

  // Continuation line inherits previous monotonic timestamp
  assert.strictEqual(parsed[2].mono, 13642.000);
  assert.strictEqual(parsed[2].ts, '2026-10-07T15:59:31.000Z');
  assert.strictEqual(parsed[2].proc, 'tvweb');
  assert.strictEqual(parsed[2].msg, 'additional stack trace line');

  // Warning line sets level to warning and proc to tvweb (not 'warning')
  assert.strictEqual(parsed[3].level, 'warning');
  assert.strictEqual(parsed[3].proc, 'tvweb');
});

test('parseGlasshouseLogs handles legacy unstamped lines at start without claiming current time', function () {
  var bootTime = 1760000000000;
  var raw = [
    'update: installed v0.75.0',
    'device detected: LG C2 OLED',
    '2026-10-07T15:59:30.123Z [13641.123] mqtt: connected'
  ].join('\n');

  var parsed = logs.parseGlasshouseLogs(raw, bootTime, 14000.0);
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[0].mono, 0);
  assert.strictEqual(parsed[0].ts, new Date(bootTime).toISOString());
  assert.strictEqual(parsed[0].msg, 'update: installed v0.75.0');

  assert.strictEqual(parsed[1].mono, 0);
  assert.strictEqual(parsed[1].msg, 'device detected: LG C2 OLED');

  assert.strictEqual(parsed[2].mono, 13641.123);
  assert.strictEqual(parsed[2].ts, '2026-10-07T15:59:30.123Z');
});

test('parseGlasshouseLogs parses explicit level tags [INFO], [WARN], [ERR]', function () {
  var bootTime = 1760000000000;
  var raw = [
    '2026-10-07T15:59:30.123Z [13641.123] [INFO] tvweb listening on 0.0.0.0:8080',
    '2026-10-07T15:59:31.000Z [13642.000] [WARN] warning: stats collection safety timeout reached',
    '2026-10-07T15:59:32.000Z [13643.000] [ERR] luna bus transport failed'
  ].join('\n');

  var parsed = logs.parseGlasshouseLogs(raw, bootTime, 13640.0);
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[0].level, 'info');
  assert.strictEqual(parsed[0].msg, 'tvweb listening on 0.0.0.0:8080');
  assert.strictEqual(parsed[1].level, 'warning');
  assert.strictEqual(parsed[1].msg, 'warning: stats collection safety timeout reached');
  assert.strictEqual(parsed[2].level, 'error');
  assert.strictEqual(parsed[2].msg, 'luna bus transport failed');
});

test('parseKernelLogs parses dmesg monotonic timestamps and process tags', function () {
  var bootTime = 1760000000000;
  var raw = [
    '[13639.123456] usb 1-1: new high-speed USB device number 2',
    '[ 13640.500000 ] [drm] initialized panel driver',
    '[ 13641.000000 ] warning: thermal sensor above normal threshold'
  ].join('\n');

  var parsed = logs.parseKernelLogs(raw, bootTime);
  assert.strictEqual(parsed.length, 3);

  assert.strictEqual(parsed[0].source, 'kernel');
  assert.strictEqual(parsed[0].mono, 13639.123456);
  assert.strictEqual(parsed[0].proc, 'usb');
  assert.strictEqual(parsed[0].level, 'info');

  assert.strictEqual(parsed[1].mono, 13640.5);
  assert.strictEqual(parsed[1].proc, 'drm');

  assert.strictEqual(parsed[2].level, 'warning');
  assert.strictEqual(parsed[2].proc, 'kernel');
  // Expected absolute timestamp calculated from bootTime
  var expectedTs = new Date(bootTime + 13641000).toISOString();
  assert.strictEqual(parsed[2].ts, expectedTs);
});

test('getLogs clamps limits and handles filtering', function (done) {
  logs.getLogs({ limit: 5000, sources: [] }, function (err, result) {
    assert.ifError(err);
    assert.ok(result);
    assert.strictEqual(result.limit, 1000); // MAX_LIMIT
    assert.ok(Array.isArray(result.entries));
    assert.ok(result.sources);
    assert.ok(result.sources.system);
    assert.ok(result.sources.glasshouse);

    logs.getLogs({ limit: -10, sources: ['system'] }, function (err2, result2) {
      assert.ifError(err2);
      assert.strictEqual(result2.limit, 100); // DEFAULT_LIMIT
      if (typeof done === 'function') done();
    });
  });
});

// Run all tests
var failures = 0;
var asyncLeft = 1;

function checkDone() {
  if (asyncLeft === 0) {
    console.log((tests.length - failures) + ' passed, ' + failures + ' failed');
    if (failures > 0) process.exit(1);
  }
}

tests.forEach(function (t) {
  try {
    if (t[1].length > 0) {
      t[1](function () {
        console.log('  ✓ ' + t[0]);
        asyncLeft--;
        checkDone();
      });
    } else {
      t[1]();
      console.log('  ✓ ' + t[0]);
    }
  } catch (e) {
    failures++;
    console.log('  ✗ ' + t[0] + '\n      ' + (e.stack || e.message));
  }
});
asyncLeft--;
checkDone();
