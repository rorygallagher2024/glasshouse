/*
 * test/test-home-lifecycle.js - sam's registration of Glasshouse Home's view
 *
 * The registration stands in for luna-send: the messages sam sends are
 * played to it, and the signals sent to the view are recorded.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var lifecycle = require('../server/lib/home-lifecycle');

var dir = path.join(os.tmpdir(), 'tvweb-home-lifecycle-' + process.pid);
var launchFile = path.join(dir, 'launch.json');
var procDir = path.join(dir, 'proc');
fs.mkdirSync(dir);
fs.mkdirSync(procDir);
process.on('exit', function () {
  fs.readdirSync(procDir).forEach(function (d) {
    fs.unlinkSync(path.join(procDir, d, 'cmdline'));
    fs.rmdirSync(path.join(procDir, d));
  });
  fs.rmdirSync(procDir);
  try { fs.unlinkSync(launchFile); } catch (e) {}
  fs.rmdirSync(dir);
});

var subs = [];
function FakeSubscription(uri, payload, appId, handlers) {
  this.uri = uri;
  this.appId = appId;
  this.handlers = handlers;
  this.stopped = true;
  subs.push(this);
}
FakeSubscription.prototype.start = function () { this.stopped = false; };
FakeSubscription.prototype.stop = function () { this.stopped = true; };

var signals = [];
var alive = {};
function signal(pid, sig) {
  if (sig === 0) {
    if (!alive[pid]) throw new Error('ESRCH');
    return;
  }
  signals.push(pid + ' ' + sig);
}

function proc(pid, argv) {
  fs.mkdirSync(path.join(procDir, String(pid)));
  fs.writeFileSync(path.join(procDir, String(pid), 'cmdline'), argv.join('\0'));
}

// A registration left from before the server started is ended at start.
proc(700, ['/usr/bin/luna-send', '-a', 'com.webos.app.home', '-i', 'luna://com.webos.applicationManager/registerNativeApp', '{}']);
proc(701, ['/usr/bin/luna-send', '-n', '1', 'luna://com.webos.applicationManager/launch', '{}']);
lifecycle.init({ Subscription: FakeSubscription, signal: signal, launchFile: launchFile, procDir: procDir });
assert.deepEqual(signals, ['700 SIGTERM'], 'only the leftover registration is ended');
signals = [];

// The view's heartbeat registers it, acting for LG's Home's id.
alive[3716] = true;
proc(3716, ['/usr/palm/applications/com.webos.app.home/glasshouse-home']);
lifecycle.view(3716);
assert.strictEqual(subs.length, 1);
assert.strictEqual(subs[0].uri, 'com.webos.applicationManager/registerNativeApp');
assert.strictEqual(subs[0].appId, 'com.webos.app.home');
lifecycle.view(3716);
assert.strictEqual(subs.length, 1, 'a heartbeat from the same view does not register again');
lifecycle.view('3716');
lifecycle.view(-1);
assert.strictEqual(subs.length, 1, 'anything but a process id is ignored');

// A preview's PID belongs to a different computer and can name another
// process on the TV. It must not replace the actual view's registration.
alive[9000] = true;
proc(9000, ['/usr/bin/node']);
lifecycle.view(9000);
assert.strictEqual(subs.length, 1, 'a process that is not the view is ignored');
assert.ok(!subs[0].stopped, 'the actual view stays registered');

subs[0].handlers.message({ returnValue: true, message: 'registered' });
assert.deepEqual(lifecycle.state(), { pid: 3716, registered: true });

// relaunch: its parameters written, then the view signalled.
subs[0].handlers.message({ returnValue: true, message: 'relaunch', parameters: { wall: 'night' } });
assert.deepEqual(JSON.parse(fs.readFileSync(launchFile, 'utf8')), { wall: 'night' });
assert.deepEqual(signals, ['3716 SIGUSR1']);
signals = [];

// A new view replaces the registration.
alive[4000] = true;
proc(4000, ['/usr/palm/applications/com.webos.app.home/glasshouse-home']);
lifecycle.view(4000);
assert.strictEqual(subs.length, 2);
assert.ok(subs[0].stopped, 'the old registration is stopped');
assert.deepEqual(signals, [], 'the old view is left to sam');

// The registration lost: the view is ended, so sam starts it afresh.
subs[1].handlers.message({ returnValue: true, message: 'registered' });
subs[1].handlers.message({ returnValue: false, errorText: 'gone' });
assert.deepEqual(signals, ['4000 SIGTERM']);
assert.ok(subs[1].stopped);
assert.deepEqual(lifecycle.state(), { pid: 0, registered: false });
signals = [];

// The luna-send ending does the same.
alive[4100] = true;
proc(4100, ['/usr/palm/applications/com.webos.app.home/glasshouse-home']);
lifecycle.view(4100);
subs[2].handlers.message({ returnValue: true, message: 'registered' });
subs[2].handlers.close();
assert.deepEqual(signals, ['4100 SIGTERM']);
signals = [];

// Refused before it was registered: the view is left as sam started it.
alive[4200] = true;
proc(4200, ['/usr/palm/applications/com.webos.app.home/glasshouse-home']);
lifecycle.view(4200);
subs[3].handlers.message({ returnValue: false, errorText: 'refused' });
assert.deepEqual(signals, []);

// A view that has gone takes its registration with it.
alive[4300] = true;
proc(4300, ['/usr/palm/applications/com.webos.app.home/glasshouse-home']);
lifecycle.view(4300);
subs[4].handlers.message({ returnValue: true, message: 'registered' });
fs.writeFileSync(path.join(procDir, '4300', 'cmdline'), '/usr/bin/node\0');
setTimeout(function () {
  assert.ok(subs[4].stopped, 'a reused PID cannot keep the view registered');
  assert.deepEqual(signals, [], 'the unrelated process that reused its PID is not killed');
  alive[4400] = true;
  proc(4400, ['/usr/palm/applications/com.webos.app.home/glasshouse-home']);
  lifecycle.view(4400);
  subs[5].handlers.message({ returnValue: true, message: 'registered' });
  fs.writeFileSync(path.join(procDir, '4400', 'cmdline'), '/usr/bin/node\0');
  subs[5].handlers.message({ returnValue: true, message: 'relaunch' });
  assert.ok(subs[5].stopped, 'a relaunch checks identity without waiting for the timer');
  assert.deepEqual(signals, [], 'a relaunch cannot signal a reused PID');
  lifecycle.stop();
  console.log('All home lifecycle tests passed.');
}, 2300);
