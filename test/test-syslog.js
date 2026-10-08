/**
 * test/test-syslog.js - Forwarding the logs to a syslog server
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var assert = require('assert');
var child = require('child_process');
var dgram = require('dgram');
var fs = require('fs');
var os = require('os');
var path = require('path');

// dmesg answers from here. The module keeps its own reference to execFile, so
// this has to be in place before it is required.
var dmesgRuns = 0;
var dmesgOut = '';
var realExecFile = child.execFile;
child.execFile = function (file, args, opts, cb) {
  if (file !== 'dmesg') return realExecFile.apply(child, arguments);
  dmesgRuns++;
  process.nextTick(function () { cb(null, dmesgOut); });
};

var logs = require('../server/lib/logs');
var children = require('../server/lib/children');
var syslog = require('../server/lib/syslog');

var launches = 0;
var realLaunch = children.launch;
children.launch = function (fn) {
  launches++;
  realLaunch(fn);
};

var BOOT = Date.UTC(2026, 9, 8, 12, 0, 0);
var OPTS = { hostname: 'Living Room TV', bootTimeMs: BOOT, redact: true };

// node 0.12 has no fs.mkdtempSync.
var tempDirs = 0;
function tempDir() {
  var dir = path.join(os.tmpdir(), 'glasshouse-syslog-' + process.pid + '-' + (tempDirs++));
  fs.mkdirSync(dir);
  return dir;
}

function format(entry, opts) {
  return syslog.formatMessage(entry, opts || OPTS).toString('utf8');
}

// 1. One line of each source
(function testFormat() {
  var sys = logs.parseSystemLogs('2026-10-08T15:47:19.010008Z [13639.010008] user.info sam [] SAM NL_APP_LAUNCH_BEGIN {"id":"com.webos.app.discovery"}', BOOT)[0];
  assert.strictEqual(format(sys),
    '<14>1 2026-10-08T15:47:19.010Z Living-Room-TV sam - system - SAM NL_APP_LAUNCH_BEGIN {"id":"com.webos.app.discovery"}');

  var warn = logs.parseSystemLogs('2026-10-08T12:00:01.000000Z [1.000000] daemon.warning pulseaudio [] sink underrun', BOOT)[0];
  assert.strictEqual(format(warn).split(' ')[0], '<28>1', 'daemon.warning');

  // Before the clock syncs the C4 dates its lines 2023-01-01; the uptime
  // places them.
  var early = logs.parseSystemLogs('2023-01-01T00:00:12.500000Z [12.500000] user.warning WebAppMgr [] app memory high', BOOT)[0];
  assert.strictEqual(format(early),
    '<12>1 2026-10-08T12:00:12.500Z Living-Room-TV WebAppMgr - system - app memory high');

  // Uptime stood still through five hours of standby on a CX: the line's own
  // time, not boot time plus uptime, which would put it at 11:00.
  var standbyBoot = Date.UTC(2026, 9, 8, 11, 0, 1) - 82335704;
  var beforeStandby = logs.parseSystemLogs('2026-10-08T06:00:00.319298Z [82332.5489667] user.info emmcd [] health report', standbyBoot)[0];
  assert.strictEqual(format(beforeStandby, { hostname: 'Living Room TV', bootTimeMs: standbyBoot, redact: true }),
    '<14>1 2026-10-08T06:00:00.319Z Living-Room-TV emmcd - system - health report');

  var gh = logs.parseGlasshouseLogs('2026-10-08T12:30:00.000Z [1800.000] [WARN] mqtt: connection dropped, retrying', BOOT, 1800)[0];
  assert.strictEqual(format(gh),
    '<28>1 2026-10-08T12:30:00.000Z Living-Room-TV mqtt - glasshouse - mqtt: connection dropped, retrying');
  var ghErr = logs.parseGlasshouseLogs('2026-10-08T12:30:01.000Z [1801.000] [ERR] fatal: uncaught exception', BOOT, 1801)[0];
  assert.strictEqual(format(ghErr).split(' ')[0], '<27>1', 'daemon.err from the tag');

  var kern = logs.parseKernelLogs('<3>[   42.250000] usb 1-1: device descriptor read/64, error -71', BOOT)[0];
  assert.strictEqual(format(kern),
    '<3>1 2026-10-08T12:00:42.250Z Living-Room-TV kernel - kernel - usb 1-1: device descriptor read/64, error -71');
  var kernInfo = logs.parseKernelLogs('<6>[    0.000000] Booting Linux on physical CPU 0x0', BOOT)[0];
  assert.deepEqual(format(kernInfo).split(' ').slice(0, 5), ['<6>1', '2026-10-08T12:00:00.000Z', 'Living-Room-TV', 'kernel', '-']);
  var kmsgUser = logs.parseKernelLogs('<14>[   30.000000] init: starting display service', BOOT)[0];
  assert.strictEqual(format(kmsgUser).split(' ')[0], '<14>1', 'a userspace write keeps its facility');
  assert.strictEqual(format(kmsgUser).split(' ')[3], 'kernel', 'and is the kernel log as an app');
  var plain = logs.parseKernelLogs('[   31.000000] warning: thermal sensor above normal threshold', BOOT)[0];
  assert.strictEqual(format(plain).split(' ')[0], '<4>1', 'without -r, kern and the level');
  assert.strictEqual(format(plain).split(' ')[3], 'kernel');

  assert.strictEqual(format(gh, { hostname: '', bootTimeMs: BOOT, redact: true }).split(' ')[2], '-',
    'no name is the nil value');
  console.log('  ✓ a line of each source is formatted with its priority, time and names');
})();

// 1c. An unstamped Glasshouse line at the start of a read is dated at the read
(function testUnstamped() {
  var now = Date.UTC(2026, 9, 8, 15, 33, 8);
  var text = "node: ../deps/uv/src/unix/core.c:117: uv_close: Assertion `!uv__is_closing(handle)' failed.\n" +
    '2026-10-08T15:33:06.000Z [98721.000] [ERR] luna: luna://com.webos.service.settings/getSystemSettings died (SIGABRT) before answering, trying once more\n' +
    '    at a continuation line\n';
  var entries = syslog.dateUnstamped(logs.parseGlasshouseLogs(text, BOOT, 98723), now, 98723);
  assert.strictEqual(entries[0].ts, '2026-10-08T15:33:08.000Z', 'dated at the read');
  assert.strictEqual(entries[0].mono, 98723);
  assert.strictEqual(entries[1].ts, '2026-10-08T15:33:06.000Z', 'a stamped line keeps its own');
  assert.strictEqual(entries[2].ts, '2026-10-08T15:33:06.000Z', 'later unstamped lines still take the line before them');
  assert.strictEqual(format(entries[0]).split(' ')[1], '2026-10-08T15:33:08.000Z');
  console.log('  ✓ an unstamped line at the start of a read is dated at the read, not at boot');
})();

// 2. A datagram is capped, on a character boundary
(function testTruncate() {
  var long = new Array(3000).join('é');
  var entry = logs.parseGlasshouseLogs('2026-10-08T12:30:00.000Z [1800.000] [INFO] screensaver: ' + long, BOOT, 1800)[0];
  var buf = syslog.formatMessage(entry, OPTS);
  assert.ok(buf.length <= syslog.MAX_DATAGRAM && buf.length > syslog.MAX_DATAGRAM - 2, 'length ' + buf.length);
  assert.strictEqual(buf.toString('utf8').indexOf('�'), -1, 'no character cut in half');
  console.log('  ✓ a datagram is capped at ' + syslog.MAX_DATAGRAM + ' bytes');
})();

// 3. Redaction on and off
(function testRedact() {
  var line = '2026-10-08T13:00:00.000000Z [3600.000000] user.info pqcontroller [] NL_PICTURE_PERIODIC_REPORT {"backlight":80,"zip_code":"zz99zz","app_id":"com.webos.app.hdmi1","ip":"192.168.1.20"}';
  var entry = logs.parseSystemLogs(line, BOOT)[0];
  var on = format(entry);
  assert.ok(on.indexOf('"zip_code":"<LOCATION>"') !== -1, on);
  assert.ok(on.indexOf('<IP>') !== -1 && on.indexOf('192.168.1.20') === -1, on);
  var off = format(entry, { hostname: 'Living Room TV', bootTimeMs: BOOT, redact: false });
  assert.ok(off.indexOf('"zip_code":"zz99zz"') !== -1 && off.indexOf('192.168.1.20') !== -1, off);
  console.log('  ✓ redaction is on unless redact is false');
})();

// 4. Settings
(function testSettings() {
  assert.strictEqual(syslog.readSettings({}), null);
  assert.strictEqual(syslog.readSettings({ syslog: { server: ' ' } }), null);
  assert.deepEqual(syslog.readSettings({ syslog: { server: 'logs.lan' } }),
    { server: 'logs.lan', port: 514, hostname: '', sources: ['system', 'glasshouse'], redact: true });
  assert.deepEqual(syslog.readSettings({ syslog: { server: 'logs.lan', port: '1514', hostname: ' bedroom-tv ', sources: ['kernel', 'nonsense', 'system'], redact: false } }),
    { server: 'logs.lan', port: 1514, hostname: 'bedroom-tv', sources: ['system', 'kernel'], redact: false });
  assert.strictEqual(syslog.readSettings({ syslog: { server: 'logs.lan', port: 70000 } }).port, 514);
  console.log('  ✓ settings default to port 514, the system and Glasshouse logs, and redaction');
})();

// 5. Where a start begins
(function testStartCursors() {
  var dir = tempDir();
  var paths = { system: path.join(dir, 'messages'), glasshouse: path.join(dir, 'tvweb.log') };
  try {
    fs.writeFileSync(paths.system, 'twelve bytes');
    fs.writeFileSync(paths.glasshouse, 'five\n');
    var boot = syslog.startCursors(true, paths);
    assert.strictEqual(boot.system.end, 0, 'the first start since boot sends the system log from its beginning');
    assert.strictEqual(boot.glasshouse.end, 5, 'the Glasshouse log is always from its end');
    assert.strictEqual(boot.kernel, -1, 'and the kernel log from its beginning');
    var later = syslog.startCursors(false, paths);
    assert.strictEqual(later.system.end, 12, 'any other start from the end');
    assert.strictEqual(later.glasshouse.end, 5);
    assert.strictEqual(later.kernel, null, 'the kernel log from what dmesg has at the first poll');
    var missing = syslog.startCursors(false, { system: path.join(dir, 'none'), glasshouse: path.join(dir, 'none') });
    assert.strictEqual(missing.system.end, 0, 'a file that appears later is all new');

    var marker = path.join(dir, 'started');
    syslog.init({ config: {}, markerPath: marker });
    assert.strictEqual(syslog.bootLogsUnsent(), true, 'no marker: the boot logs are unsent');
    fs.writeFileSync(marker, '');
    assert.strictEqual(syslog.bootLogsUnsent(), false, 'a restart finds the marker');
    fs.unlinkSync(marker);
  } finally {
    try { fs.unlinkSync(paths.system); fs.unlinkSync(paths.glasshouse); fs.rmdirSync(dir); } catch (e) {}
  }
  console.log('  ✓ until the boot logs are sent the system log goes whole, after that from the end');
})();

// 6. End to end, to a listener on localhost
(function testSend() {
  var dir = tempDir();
  var messages = path.join(dir, 'messages');
  var tvweb = path.join(dir, 'tvweb.log');
  process.env.TVWEB_LOG = tvweb;
  // The boot logs already sent: from the end.
  var started = path.join(dir, 'started');
  fs.writeFileSync(started, '');
  fs.writeFileSync(messages, '2026-10-08T12:00:01.000000Z [1.000000] user.info sam [] sent before the start\n');
  fs.writeFileSync(tvweb, '2026-10-08T12:00:02.000Z [2.000] [INFO] tvweb listening on 0.0.0.0:8080\n');

  var got = [];
  var listener = dgram.createSocket('udp4');
  var deadline = setTimeout(function () { assert.fail('timed out with ' + got.length + ' messages'); }, 5000);

  function cleanup() {
    clearTimeout(deadline);
    syslog.stop();
    listener.close();
    try { fs.unlinkSync(messages); fs.unlinkSync(tvweb); fs.unlinkSync(started); fs.rmdirSync(dir); } catch (e) {}
  }

  listener.on('message', function (buf) {
    got.push(buf.toString('utf8'));
    if (got.length < 3) return;
    // The counters are bumped by the send callbacks, after the datagrams leave.
    setTimeout(function () {
      assert.ok(/^<14>1 \S+ Bedroom-TV sam - system - first after the start$/.test(got[0]), got[0]);
      assert.ok(/^<14>1 \S+ Bedroom-TV sam - system - second with <IP>$/.test(got[1]), got[1]);
      assert.ok(/^<27>1 \S+ Bedroom-TV mqtt - glasshouse - mqtt: broker refused the connection$/.test(got[2]), got[2]);
      assert.deepEqual(syslog.getCounters(), { messages: { system: 2, glasshouse: 1 }, errors: 0 });
      cleanup();
      console.log('  ✓ lines written after the start reach a listener, and are counted');
      testSendIpv6();
    }, 100);
  });

  listener.bind(0, '127.0.0.1', function () {
    syslog.init({ config: { syslog: { server: '127.0.0.1', port: listener.address().port } }, messagesPath: messages, markerPath: started, uptime: function () { return 4000; } });
    assert.strictEqual(syslog.start(), true);
    fs.appendFileSync(messages,
      '2026-10-08T12:00:03.000000Z [3.000000] user.info sam [] first after the start\n' +
      '2026-10-08T12:00:04.000000Z [4.000000] user.info sam [] second with 10.0.0.7\n');
    fs.appendFileSync(tvweb, '2026-10-08T12:00:05.000Z [5.000] [ERR] mqtt: broker refused the connection\n');
    syslog.poll(function () {
      assert.strictEqual(got.length, 0, 'nothing is sent before the device name is known');
      syslog.setHostname('Bedroom TV');
      // The lookup runs at start; the poll after it sends.
      setTimeout(function () { syslog.poll(); }, 50);
    });
  });
})();

// 7. An address the lookup gives as IPv6 is sent to over udp6
function testSendIpv6() {
  var dir = tempDir();
  var messages = path.join(dir, 'messages');
  process.env.TVWEB_LOG = path.join(dir, 'tvweb.log');
  fs.writeFileSync(messages, '');
  var started = path.join(dir, 'started');
  fs.writeFileSync(started, '');
  var listener = dgram.createSocket('udp6');
  var deadline = null;
  function cleanup() {
    clearTimeout(deadline);
    syslog.stop();
    try { listener.close(); } catch (e) {}
    try { fs.unlinkSync(messages); fs.unlinkSync(started); fs.rmdirSync(dir); } catch (e) {}
  }
  listener.on('error', function () {
    cleanup();
    console.log('  - no IPv6 loopback here; the udp6 send is not tested');
    testBootMarker();
  });
  deadline = setTimeout(function () { assert.fail('timed out over IPv6'); }, 5000);
  listener.on('message', function (buf) {
    assert.ok(/ bedroom-tv WebAppMgr - system - over IPv6$/.test(buf.toString('utf8')), buf.toString('utf8'));
    cleanup();
    console.log('  ✓ an IPv6 address is sent to over udp6, as the configured hostname');
    testBootMarker();
  });
  listener.bind(0, '::1', function () {
    syslog.init({ config: { syslog: { server: '::1', port: listener.address().port, hostname: 'bedroom-tv' } }, messagesPath: messages, markerPath: started, uptime: function () { return 4000; } });
    syslog.start();
    syslog.setHostname('LG OLED55C4PUA');
    fs.appendFileSync(messages, '2026-10-08T12:00:03.000000Z [3.000000] user.info WebAppMgr [] over IPv6\n');
    setTimeout(function () { syslog.poll(); }, 50);
  });
}

// 8. The marker is left once the boot's system log has gone, not at start
function testBootMarker() {
  var dir = tempDir();
  var messages = path.join(dir, 'messages');
  var marker = path.join(dir, 'boot-sent');
  process.env.TVWEB_LOG = path.join(dir, 'tvweb.log');
  fs.writeFileSync(messages,
    '2023-01-01T00:00:05.000000Z [5.000000] user.info sam [] boot line one\n' +
    '2023-01-01T00:00:06.000000Z [6.000000] user.info sam [] boot line two\n');
  var got = [];
  var listener = dgram.createSocket('udp4');
  var deadline = setTimeout(function () { assert.fail('timed out with ' + got.length + ' boot lines'); }, 5000);
  listener.on('message', function (buf) {
    got.push(buf.toString('utf8'));
    if (got.length < 2) return;
    clearTimeout(deadline);
    assert.ok(/ - boot line one$/.test(got[0]) && / - boot line two$/.test(got[1]), got.join('\n'));
    assert.ok(fs.existsSync(marker), 'the marker is left once the boot lines are sent');
    syslog.stop();
    listener.close();
    try { fs.unlinkSync(messages); fs.unlinkSync(marker); fs.rmdirSync(dir); } catch (e) {}
    console.log('  ✓ the boot marker is left once the boot lines are sent, not at start');
    testKernelInterval();
  });
  listener.bind(0, '127.0.0.1', function () {
    syslog.init({ config: { syslog: { server: '127.0.0.1', port: listener.address().port } }, messagesPath: messages, markerPath: marker, uptime: function () { return 4000; } });
    syslog.start();
    syslog.poll(function () {
      assert.ok(!fs.existsSync(marker), 'a start that has not sent the boot lines leaves no marker');
      syslog.setHostname('Bedroom TV');
      setTimeout(function () { syslog.poll(); }, 50);
    });
  });
}

// 9. dmesg runs in turn with the other child starts, every 30 s rather than
// at every poll of the files
function testKernelInterval() {
  var dir = tempDir();
  var messages = path.join(dir, 'messages');
  var started = path.join(dir, 'started');
  process.env.TVWEB_LOG = path.join(dir, 'tvweb.log');
  fs.writeFileSync(messages, '');
  fs.writeFileSync(started, '');
  dmesgOut = '<6>[   10.000000] already in the ring at the start\n';
  dmesgRuns = 0;
  launches = 0;
  var now = 1000000;
  var got = [];
  var listener = dgram.createSocket('udp4');
  var deadline = setTimeout(function () { assert.fail('timed out with ' + got.length + ' messages'); }, 5000);
  listener.on('message', function (buf) { got.push(buf.toString('utf8')); });

  function settle(fn) { setTimeout(fn, 50); }

  listener.bind(0, '127.0.0.1', function () {
    syslog.init({ config: { syslog: { server: '127.0.0.1', port: listener.address().port, sources: ['system', 'kernel'] } },
                  messagesPath: messages, markerPath: started, uptime: function () { return 4000; },
                  clock: function () { return now; } });
    syslog.start();
    syslog.setHostname('Bedroom TV');
    settle(function () {
      syslog.poll(function () {
        assert.strictEqual(dmesgRuns, 1, 'the first poll reads the kernel log');
        assert.strictEqual(launches, 1, 'through the launch gate');
        dmesgOut += '<6>[   20.000000] new in the ring\n';
        fs.appendFileSync(messages, '2026-10-08T12:00:03.000000Z [3.000000] user.info sam [] five seconds on\n');
        now += 5000;
        syslog.poll(function () {
          assert.strictEqual(dmesgRuns, 1, 'a poll 5 s later reads the files and not the kernel log');
          now += 25000;
          syslog.poll(function () {
            assert.strictEqual(dmesgRuns, 2, 'a poll 30 s after the last read reads it again');
            assert.strictEqual(launches, 2);
            settle(function () {
              clearTimeout(deadline);
              assert.strictEqual(got.length, 2, got.join('\n'));
              assert.ok(/ sam - system - five seconds on$/.test(got[0]), got[0]);
              assert.ok(/ kernel - kernel - new in the ring$/.test(got[1]), got[1]);
              syslog.stop();
              listener.close();
              try { fs.unlinkSync(messages); fs.unlinkSync(started); fs.rmdirSync(dir); } catch (e) {}
              console.log('  ✓ dmesg starts through the launch gate, every 30 s rather than every poll');
            });
          });
        });
      });
    });
  });
}
