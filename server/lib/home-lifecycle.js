/*
 * lib/home-lifecycle.js - Glasshouse Home's view kept running across Home presses
 *
 * sam starts a native app staged as LG's Home afresh for every launch unless
 * the app has registered with it: on a G3 (webOS 9.2.2) each Home press
 * killed the view and started another, its first frame 0.5 s later.
 * Registered (registerNativeApp, lifecycle v1, the interface sam expects of
 * this manifest), sam keeps the process and sends it relaunch instead.
 *
 * The registration is held here, as root, with luna-send acting for LG's
 * Home's id, so the view itself makes no luna calls. Its heartbeat names its
 * process; relaunch is passed on to it as SIGUSR1, with the launch's
 * parameters written to a file first. A registration left with no view
 * behind it would have sam send the Home key to nothing, so when either ends
 * the other is ended too, and sam starts the view afresh at the next press.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');

var LG_HOME = 'com.webos.app.home';
var CHECK_MS = 2000;

/** @type {typeof import('./luna').Subscription | null} */
var Subscription = null;
var signalFn = function (pid, sig) { process.kill(pid, sig); };
var launchFile = '/tmp/glasshouse-home-launch.json';
var sub = null;
var pid = 0;
var registered = false;
var checkTimer = null;
var procDir = '/proc';

function init(opts) {
  opts = opts || {};
  Subscription = opts.Subscription || null;
  if (opts.signal) signalFn = opts.signal;
  if (opts.launchFile) launchFile = opts.launchFile;
  if (opts.procDir) procDir = opts.procDir;
  if (Subscription) endOrphans();
}

/*
 * A luna-send still holding a registration from before this server started
 * passes sam's events to nothing: ended at start, so this server's
 * registration is the only one.
 */
function endOrphans() {
  try {
    fs.readdirSync(procDir).forEach(function (d) {
      if (!/^\d+$/.test(d)) return;
      try {
        var argv = fs.readFileSync(path.join(procDir, d, 'cmdline'), 'utf8').split('\0');
        if (path.basename(argv[0]) !== 'luna-send' || argv.indexOf(LG_HOME) === -1) return;
        if (!argv.some(function (a) { return /registerNativeApp$/.test(a); })) return;
        signalFn(Number(d), 'SIGTERM');
      } catch (e) {}
    });
  } catch (e) {}
}

function alive(p) {
  try {
    var argv0 = fs.readFileSync(path.join(procDir, String(p), 'cmdline'), 'utf8').split('\0')[0];
    if (path.basename(argv0) !== 'glasshouse-home') return false;
    signalFn(p, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function stop() {
  if (sub) sub.stop();
  sub = null;
  registered = false;
  pid = 0;
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}

function end(why) {
  var p = pid, was = registered;
  stop();
  console.error('home: registration with sam ' + why);
  if (was && p && alive(p)) {
    try { signalFn(p, 'SIGTERM'); } catch (e) {}
  }
}

function relaunch(params) {
  if (!alive(pid)) return end('lost its view');
  try { fs.writeFileSync(launchFile, JSON.stringify(params || {})); } catch (e) {}
  try { signalFn(pid, 'SIGUSR1'); } catch (e) { end('lost its view'); }
}

/*
 * The view's heartbeat: a process not yet registered is. Where the
 * registration is refused, sam goes on starting the view per launch, as
 * before.
 */
function view(p) {
  if (!Subscription || typeof p !== 'number' || p <= 0 || p !== Math.floor(p) || !alive(p)) return;
  if (p === pid && sub) return;
  stop();
  pid = p;
  var mine = sub = new Subscription('com.webos.applicationManager/registerNativeApp', {}, LG_HOME, {
    message: function (m) {
      if (sub !== mine) return;
      if (m.returnValue === false) return end('refused: ' + (m.errorText || 'no reason given'));
      var event = m.message || m.event;
      if (event === 'registered') registered = true;
      else if (event === 'relaunch') relaunch(m.parameters);
      else if (event === 'close') end('closed by sam');
    },
    close: function () {
      if (sub === mine) end('ended');
    }
  });
  sub.start();
  checkTimer = setInterval(function () {
    if (pid && !alive(pid)) end('outlived its view');
  }, CHECK_MS);
}

function state() {
  return { pid: pid, registered: registered };
}

module.exports = {
  init: init,
  view: view,
  stop: stop,
  state: state
};
