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

test('parseGlasshouseLogs parses standardized subsystem tags into proc', function () {
  var bootTime = 1760000000000;
  var raw = [
    '2026-10-07T15:59:30.123Z [13641.123] [INFO] server: listening on 0.0.0.0:8080 (control: on)',
    '2026-10-07T15:59:30.200Z [13641.200] [INFO] config: loaded /var/lib/tvweb/config.json',
    '2026-10-07T15:59:30.300Z [13641.300] [WARN] security: apps.sideload is on and no token is set',
    '2026-10-07T15:59:30.400Z [13641.400] [INFO] tvapp: old tile removed; Homebrew Channel replaces it',
    '2026-10-07T15:59:30.500Z [13641.500] [INFO] device: detected LG C2 OLED',
    '2026-10-07T15:59:30.600Z [13641.600] [INFO] watchdog: resumed after 120s suspended - skipping one check'
  ].join('\n');

  var parsed = logs.parseGlasshouseLogs(raw, bootTime, 13640.0);
  assert.strictEqual(parsed.length, 6);
  assert.strictEqual(parsed[0].proc, 'server');
  assert.strictEqual(parsed[1].proc, 'config');
  assert.strictEqual(parsed[2].proc, 'security');
  assert.strictEqual(parsed[2].level, 'warning');
  assert.strictEqual(parsed[3].proc, 'tvapp');
  assert.strictEqual(parsed[4].proc, 'device');
  assert.strictEqual(parsed[5].proc, 'watchdog');
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

test('parseKernelLogs reads the priority dmesg -r puts first', function () {
  var parsed = logs.parseKernelLogs('<3>[   42.250000] usb 1-1: device descriptor read/64, error -71\n' +
    '[   43.000000] usb 1-1: new high-speed USB device number 3\n', 1760000000000);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].pri, 3);
  assert.strictEqual(parsed[0].mono, 42.25);
  assert.strictEqual(parsed[0].proc, 'usb');
  assert.strictEqual(parsed[0].msg, 'usb 1-1: device descriptor read/64, error -71');
  assert.strictEqual(parsed[1].pri, undefined, 'plain dmesg has none');
});

test('a forward read takes a grown file a piece at a time from the cursor', function () {
  var fs = require('fs'), os = require('os'), path = require('path');
  var file = path.join(os.tmpdir(), 'glasshouse-forward-' + process.pid + '.log');
  try {
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    var a = logs.readLines(file, 0, '', 9, true);
    assert.strictEqual(a.text, 'one\ntwo\n');
    assert.strictEqual(a.whole, false);
    assert.strictEqual(a.atEnd, false, 'more of the file to come');
    var b = logs.readLines(file, a.end, a.ino, 9, true);
    assert.strictEqual(b.text, 'three\n');
    assert.strictEqual(b.atEnd, true);
    var c = logs.readLines(file, b.end, b.ino, 9, true);
    assert.strictEqual(c.text, '');
    assert.strictEqual(c.end, b.end);

    fs.writeFileSync(file, 'abcdefghijklmnop\nq\n');
    var cut = logs.readLines(file, 0, '', 8, true);
    assert.strictEqual(cut.text, 'abcdefgh', 'a line longer than a read is not stuck on');
    assert.strictEqual(cut.end, 8);

    fs.writeFileSync(file, 'new\n');
    var rotated = logs.readLines(file, 18, cut.ino, 8, true);
    assert.strictEqual(rotated.text, 'new\n', 'a file cut short is read from its start');
    assert.strictEqual(rotated.whole, true);
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
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

test('a poll with the cursor gets only what was added, in whole lines', function () {
  var fs = require('fs'), os = require('os'), path = require('path');
  var file = path.join(os.tmpdir(), 'glasshouse-logs-' + process.pid + '.log');
  var saved = process.env.TVWEB_LOG;
  process.env.TVWEB_LOG = file;
  function line(n) { return '2026-10-08T10:00:0' + n + '.000Z [' + n + '.0] mqtt: line ' + n + '\n'; }
  function read(since) {
    var out = null;
    logs.getLogs({ sources: ['glasshouse'], since: since }, function (err, r) { assert.ifError(err); out = r; });
    return out;
  }
  try {
    fs.writeFileSync(file, line(1) + line(2));
    var first = read('');
    assert.strictEqual(first.entries.length, 2);
    assert.strictEqual(first.incremental, false, 'no cursor, a whole read');
    assert.ok(/^glasshouse:\d+:/.test(first.cursor), 'a cursor to send back: ' + first.cursor);

    var none = read(first.cursor);
    assert.strictEqual(none.incremental, true);
    assert.strictEqual(none.entries.length, 0, 'nothing new, nothing sent');

    fs.appendFileSync(file, line(3) + '2026-10-08T10:00:04.000Z [4.0] mqtt: still being wri');
    var more = read(none.cursor);
    assert.strictEqual(more.incremental, true);
    assert.deepEqual(more.entries.map(function (e) { return e.msg; }), ['mqtt: line 3'],
      'only the new line, and not the one still being written');

    fs.appendFileSync(file, 'tten\n');
    var rest = read(more.cursor);
    assert.deepEqual(rest.entries.map(function (e) { return e.msg; }), ['mqtt: still being written'],
      'the unfinished line once it is whole');

    fs.writeFileSync(file, line(5));
    var rotated = read(rest.cursor);
    assert.strictEqual(rotated.incremental, false, 'a file shorter than the cursor was rotated: read whole');
    assert.deepEqual(rotated.entries.map(function (e) { return e.msg; }), ['mqtt: line 5']);
  } finally {
    if (saved === undefined) delete process.env.TVWEB_LOG; else process.env.TVWEB_LOG = saved;
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

test('an error the server tagged is an error, whatever its words', function () {
  var parsed = logs.parseGlasshouseLogs(
    '2026-10-08T10:00:00.000Z [5.0] [ERR] adblock: could not close port 9998\n' +
    '2026-10-08T10:00:01.000Z [6.0] [INFO] adblock: port 9998 answers on the TV only\n', Date.now() - 10000, 0);
  assert.strictEqual(parsed[0].level, 'error');
  assert.strictEqual(parsed[0].proc, 'adblock', 'the tag is not taken for the process');
  assert.strictEqual(parsed[0].msg, 'adblock: could not close port 9998');
  assert.strictEqual(parsed[1].level, 'info');
  var dbg = logs.parseGlasshouseLogs('2026-10-08T10:00:02.000Z [7.0] [DBG] mqtt: detail\n', Date.now() - 10000, 0);
  assert.strictEqual(dbg[0].level, 'debug', 'the tag tvweb.js writes for console.debug');
});

test('the cursor is read back as it was written', function () {
  var c = logs.parseCursor('system:120:55,glasshouse:9:7,kernel:13.5');
  assert.deepEqual(c.system, { end: 120, ino: '55' });
  assert.deepEqual(c.glasshouse, { end: 9, ino: '7' });
  assert.strictEqual(c.kernel, 13.5);
  assert.deepEqual(logs.parseCursor('rubbish,system:x'), {}, 'anything malformed is ignored');
});

test('formatFatalError formats stack traces and primitives with memory stats', function () {
  var err = new Error('simulated test failure');
  var lines = logs.formatFatalError(err);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length >= 2);
  assert.ok(/^fatal: uncaught exception/.test(lines[0]));
  assert.ok(lines[1].indexOf('Error: simulated test failure') !== -1);
  for (var i = 0; i < lines.length; i++) {
    assert.strictEqual(lines[i].indexOf('fatal: '), 0);
  }

  // String / non-Error crash values
  var strLines = logs.formatFatalError('string error reason');
  assert.ok(strLines.length >= 2);
  assert.strictEqual(strLines[1], 'fatal: string error reason');
});

test('getLogs stitches entries from rotated log tvweb.log.1 across rotation boundary', function (done) {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');

  var tmpDir = tempDir('tvweb-rot-test-');
  var logPath = path.join(tmpDir, 'tvweb.log');
  var rotPath = path.join(tmpDir, 'tvweb.log.1');

  var oldEnv = process.env.TVWEB_LOG;
  process.env.TVWEB_LOG = logPath;

  // Earlier entries in rotated generation (.1)
  var rotContent = [
    '2026-10-07T15:00:00.000Z [1000.000] [INFO] line 1 from previous generation',
    '2026-10-07T15:00:01.000Z [1001.000] [WARN] line 2 from previous generation'
  ].join('\n') + '\n';

  // New entries in current generation
  var curContent = [
    '2026-10-07T15:00:02.000Z [1002.000] [INFO] line 3 from current generation'
  ].join('\n') + '\n';

  fs.writeFileSync(rotPath, rotContent, 'utf8');
  fs.writeFileSync(logPath, curContent, 'utf8');

  logs.getLogs({ limit: 10, sources: ['glasshouse'] }, function (err, res) {
    if (oldEnv !== undefined) process.env.TVWEB_LOG = oldEnv;
    else delete process.env.TVWEB_LOG;
    try { fs.unlinkSync(logPath); fs.unlinkSync(rotPath); fs.rmdirSync(tmpDir); } catch (e) {}

    assert.ifError(err);
    assert.ok(res);
    assert.ok(res.sources.glasshouse.rotatedAvailable);
    assert.strictEqual(res.entries.length, 3);
    assert.strictEqual(res.entries[0].msg, 'line 1 from previous generation');
    assert.strictEqual(res.entries[1].msg, 'line 2 from previous generation');
    assert.strictEqual(res.entries[2].msg, 'line 3 from current generation');
    if (typeof done === 'function') done();
  });
});

test('getLogs puts an earlier boot before this one, and a limit keeps the newest', function (done) {
  var fs = require('fs');
  var path = require('path');

  var tmpDir = tempDir('tvweb-boots-test-');
  var logPath = path.join(tmpDir, 'tvweb.log');
  var oldEnv = process.env.TVWEB_LOG;
  process.env.TVWEB_LOG = logPath;

  // The first boot ran for 4000 s; the TV then restarted and uptime began again.
  fs.writeFileSync(logPath, [
    '2026-11-02T15:49:00.000Z [1363.000] [INFO] first boot, early',
    '2026-11-02T16:54:55.000Z [5000.000] [INFO] first boot, late',
    '2026-11-02T18:01:29.000Z [50.000] [INFO] second boot, early',
    '2026-11-02T18:04:26.000Z [227.000] [INFO] second boot, late'
  ].join('\n') + '\n', 'utf8');

  logs.getLogs({ limit: 3, sources: ['glasshouse'] }, function (err, res) {
    if (oldEnv !== undefined) process.env.TVWEB_LOG = oldEnv;
    else delete process.env.TVWEB_LOG;
    try { fs.unlinkSync(logPath); fs.rmdirSync(tmpDir); } catch (e) {}

    assert.ifError(err);
    assert.deepEqual(res.entries.map(function (e) { return e.msg; }),
                     ['first boot, late', 'second boot, early', 'second boot, late']);
    assert.deepEqual(res.entries.map(function (e) { return e.boot; }), [-1, 0, 0]);
    if (typeof done === 'function') done();
  });
});

test('logs.redact scrubs sensitive network and device data while preserving safe tokens', function () {
  // IP addresses
  assert.strictEqual(
    logs.redact('connected to 192.168.1.125:1883 and 10.0.0.42 and 172.16.5.10'),
    'connected to <IP>:1883 and <IP> and <IP>'
  );
  assert.strictEqual(
    logs.redact('listening on 127.0.0.1:8080 and 0.0.0.0:8080 version 0.80.8'),
    'listening on 127.0.0.1:8080 and 0.0.0.0:8080 version 0.80.8'
  );

  // MAC addresses
  assert.strictEqual(
    logs.redact('peer 14:49:e0:1a:2b:3c and eth 00-14-22-01-23-45'),
    'peer <MAC> and eth <MAC>'
  );

  // Serial numbers
  assert.strictEqual(
    logs.redact('serialNumber: "301NDXK0C912", device_id=ABCDEF123456'),
    'serialNumber: "<SERIAL>", device_id=<SERIAL>'
  );

  // Tokens, keys, and passwords
  assert.strictEqual(
    logs.redact('GET /api/logs?k=mySecretToken123&sources=glasshouse'),
    'GET /api/logs?k=<REDACTED>&sources=glasshouse'
  );
  assert.strictEqual(
    logs.redact('Authorization: Bearer mySecretJwtToken.123.abc'),
    'Authorization: Bearer <REDACTED>'
  );
  assert.strictEqual(
    logs.redact('{"password":"superSecretPassword","other":"ok"}'),
    '{"password":"<REDACTED>","other":"ok"}'
  );
  assert.strictEqual(
    logs.redact('connecting to mqtt://user:secretPass@192.168.1.50:1883'),
    'connecting to mqtt://user:<REDACTED>@<IP>:1883'
  );

  // Wi-Fi SSIDs
  assert.strictEqual(
    logs.redact('wlan0: associate to SSID "Home_Network_5G"'),
    'wlan0: associate to SSID "<SSID>"'
  );

  // Postcodes and coordinates, as a C2's picture report carries them
  assert.strictEqual(
    logs.redact('pqcontroller NL_PICTURE_PERIODIC_REPORT {"backlight":186,"zip_code":"bt155at","app_id":"com.webos.app.hdmi2"}'),
    'pqcontroller NL_PICTURE_PERIODIC_REPORT {"backlight":186,"zip_code":"<LOCATION>","app_id":"com.webos.app.hdmi2"}'
  );
  assert.strictEqual(
    logs.redact('postcode: "SW1A 1AA", latitude=51.5014, longitude=-0.1419'),
    'postcode: "<LOCATION>", latitude=<LOCATION>, longitude=<LOCATION>'
  );
});

test('logs.redactEntry redacts msg, proc, and raw and preserves metadata', function () {
  var entry = {
    ts: '2026-10-07T12:00:00.000Z',
    mono: 123.456,
    source: 'glasshouse',
    proc: 'tvweb(192.168.1.131)',
    level: 'info',
    msg: 'mqtt connected to 192.168.1.125:1883 with key ?k=secret123',
    raw: 'raw line with 192.168.1.125:1883 and ?k=secret123'
  };

  var redacted = logs.redactEntry(entry);
  assert.strictEqual(redacted.ts, entry.ts);
  assert.strictEqual(redacted.mono, entry.mono);
  assert.strictEqual(redacted.source, entry.source);
  assert.strictEqual(redacted.level, entry.level);
  assert.strictEqual(redacted.proc, 'tvweb(<IP>)');
  assert.strictEqual(redacted.msg, 'mqtt connected to <IP>:1883 with key ?k=<REDACTED>');
  assert.strictEqual(redacted.raw, 'raw line with <IP>:1883 and ?k=<REDACTED>');
});

test('getLogs with redact: true redacts sensitive entries in results', function (done) {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');

  var tmpDir = tempDir('tvweb-redact-test-');
  var logPath = path.join(tmpDir, 'tvweb.log');
  var oldEnv = process.env.TVWEB_LOG;
  process.env.TVWEB_LOG = logPath;

  var content = [
    '2026-10-07T15:00:00.000Z [1000.000] [INFO] connected to 192.168.1.125:1883 with ?k=secretKey'
  ].join('\n') + '\n';
  fs.writeFileSync(logPath, content, 'utf8');

  logs.getLogs({ limit: 10, sources: ['glasshouse'], redact: true }, function (err, res) {
    if (oldEnv !== undefined) process.env.TVWEB_LOG = oldEnv;
    else delete process.env.TVWEB_LOG;
    try { fs.unlinkSync(logPath); fs.rmdirSync(tmpDir); } catch (e) {}

    assert.ifError(err);
    assert.ok(res);
    assert.strictEqual(res.entries.length, 1);
    assert.strictEqual(res.entries[0].msg, 'connected to <IP>:1883 with ?k=<REDACTED>');
    if (typeof done === 'function') done();
  });
});

test('shouldLog filters log levels according to quiet, info, and debug modes', function () {
  // quiet mode: only WARN, ERR, and FATAL are allowed
  assert.strictEqual(logs.shouldLog('ERR', 'quiet'), true);
  assert.strictEqual(logs.shouldLog('FATAL', 'quiet'), true);
  assert.strictEqual(logs.shouldLog('WARN', 'quiet'), true);
  assert.strictEqual(logs.shouldLog('INFO', 'quiet'), false);
  assert.strictEqual(logs.shouldLog('DBG', 'quiet'), false);

  // info mode (default): INFO, WARN, ERR allowed; DBG suppressed
  assert.strictEqual(logs.shouldLog('ERR', 'info'), true);
  assert.strictEqual(logs.shouldLog('WARN', 'info'), true);
  assert.strictEqual(logs.shouldLog('INFO', 'info'), true);
  assert.strictEqual(logs.shouldLog('DBG', 'info'), false);
  assert.strictEqual(logs.shouldLog('INFO'), true);

  // debug mode: all levels allowed
  assert.strictEqual(logs.shouldLog('ERR', 'debug'), true);
  assert.strictEqual(logs.shouldLog('WARN', 'debug'), true);
  assert.strictEqual(logs.shouldLog('INFO', 'debug'), true);
  assert.strictEqual(logs.shouldLog('DBG', 'debug'), true);
});

// fs.mkdtempSync arrived in node 5; webOS 2 and 4 run 0.10 and 0.12.
var tempDirs = 0;
function tempDir(prefix) {
  var fs = require('fs'), os = require('os'), path = require('path');
  var dir = path.join(os.tmpdir(), prefix + process.pid + '-' + (tempDirs++));
  fs.mkdirSync(dir);
  return dir;
}

// Run all tests
var failures = 0;
// Every async test and the synchronous pass, so a test registered after an
// async one that calls back at once still counts.
var asyncLeft = 1 + tests.filter(function (t) { return t[1].length > 0; }).length;

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
    // An async test that threw never calls back: counted as done here, or the
    // run never finishes and exits 0 with the failure unreported.
    if (t[1].length > 0) { asyncLeft--; checkDone(); }
  }
});
asyncLeft--;
checkDone();
