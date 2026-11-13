'use strict';
/*
 * lib/nosignal.js - LG's No Signal screen as just "No Signal"
 *
 * An input with nothing coming in shows LG's No Signal screen, drawn by the
 * input app (com.webos.app.inputcommon, QML) in its Screensaver.qml: an
 * animated picture, the heading and a line of advice under it, drifting over
 * the screen. Switched on, a copy of the TV's own file is mounted over it with
 * two lines changed, so for No Signal only the picture and the line under the
 * heading are not drawn; the other messages it shows (a scrambled channel, no
 * CI module) keep theirs, and the text still drifts.
 *
 * The file is under qml/UserInterfaceLayer/Containers/BgViewLayer on webOS 9
 * (a C2, 9.2.2) and qml/TvComponent/ScreenSaver on webOS 4 (a B8, 4.4.3), with
 * the same two lines. Each must be there exactly once, as on those two, or
 * nothing is mounted: a firmware that changed them keeps LG's screen.
 *
 * The input app holds the file it loaded until it starts again, so it is
 * restarted, and only while no input is on screen, as restarting it blanks
 * the input in front for a moment. A mount does not outlive a reboot; the
 * server mounts it again at start.
 *
 * Strict ES5: runs on node 0.12 (0.10 on webOS 2).
 */
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var util = require('./util');

var INPUT_APP = 'com.webos.app.inputcommon';
var APP_QML = '/usr/palm/applications/' + INPUT_APP + '/qml/';
var CANDIDATES = ['UserInterfaceLayer/Containers/BgViewLayer/Screensaver.qml', 'TvComponent/ScreenSaver/Screensaver.qml'];
var PATCHES = [
  // The animated picture above the heading.
  { find: /(\n[ \t]*visible: element\.isDynamic && \(headerText\.text \|\| bodyText\.text\))(?=\n)/g,
    add: ' && currentKey !== "noSignal"' },
  // The line of advice under it.
  { find: /(\n[ \t]*visible: text\.length > 0)(?=\n)/g,
    add: ' && currentKey !== "noSignal"' }
];
// An input on screen, which restarting the input app would blank.
var INPUT_IN_FRONT = /^com\.webos\.app\.(hdmi|externalinput|livetv|inputcommon|livemenuplayer|livezoom|acrhdmi|adhdmi)/;
var RETRY_MS = 60000;

var luna = null;
var execFn = execFile;
var stateDir = '/var/lib/tvweb';
var appQml = APP_QML;
var retryMs = RETRY_MS;
var mountinfo = '/proc/self/mountinfo';
var retryTimer = null;
var restartPending = false;
var lastProblem = '';

function init(opts) {
  opts = opts || {};
  luna = opts.luna || null;
  execFn = opts.exec || execFile;
  stateDir = opts.stateDir || '/var/lib/tvweb';
  appQml = opts.appQml || APP_QML;
  retryMs = opts.retryMs || RETRY_MS;
  mountinfo = opts.mountinfo || '/proc/self/mountinfo';
  restartPending = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function flagFile() { return path.join(stateDir, 'nosignal_plain'); }
function ownDir() { return path.join(stateDir, 'nosignal'); }
function ownFile() { return path.join(ownDir(), 'Screensaver.qml'); }

function wanted() { return fs.existsSync(flagFile()); }

function target() {
  for (var i = 0; i < CANDIDATES.length; i++) {
    var f = appQml + CANDIDATES[i];
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Whether this server's copy is mounted over the file.
function mounted(file) {
  var info;
  try { info = fs.readFileSync(mountinfo, 'utf8'); } catch (e) { return false; }
  return info.split('\n').some(function (line) {
    var parts = line.split(' ');
    return parts[4] === file && parts[3] && parts[3].indexOf('/nosignal/') !== -1;
  });
}

/*
 * The TV's own file with the two lines changed, or null where either is not
 * there exactly once.
 */
function patch(text) {
  var out = String(text || '');
  for (var i = 0; i < PATCHES.length; i++) {
    var found = out.match(PATCHES[i].find);
    if (!found || found.length !== 1) return null;
    out = out.replace(PATCHES[i].find, '$1' + PATCHES[i].add);
  }
  return out;
}

function problem(text) {
  if (text !== lastProblem) console.error('nosignal: ' + text);
  lastProblem = text;
}

// Restarts the input app, now if no input is in front, otherwise once none is.
function restartWhenFree() {
  restartPending = true;
  if (retryTimer) return;
  var check = function () {
    retryTimer = null;
    if (!restartPending) return;
    var ask = luna ? luna : function (uri, params, cb) { cb(null); };
    ask('com.webos.applicationManager/getForegroundAppInfo', {}, function (r) {
      var appId = r && typeof r.appId === 'string' ? r.appId : '';
      if (INPUT_IN_FRONT.test(appId)) {
        retryTimer = setTimeout(check, retryMs);
        if (retryTimer.unref) retryTimer.unref();
        return;
      }
      restartPending = false;
      execFn('/usr/bin/killall', [INPUT_APP], { timeout: 5000 }, function () {
        console.log('nosignal: the input app restarted, so its No Signal screen is ' + (wanted() ? 'plain' : 'LG\'s'));
      });
    });
  };
  check();
}

/*
 * Mounts the copy, or takes it away, to match the setting. cb({ ok, ... }) once
 * the mount is done; the input app's restart may follow later.
 */
function apply(cb) {
  cb = cb || function () {};
  var file = target();
  if (!file) return cb(status());
  var on = wanted(), isMounted = mounted(file);
  if (on && !isMounted) {
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      problem('could not read the No Signal screen: ' + e.message);
      return cb(status());
    }
    var plain = patch(text);
    if (!plain) {
      problem('this firmware\'s No Signal screen is not the one known, so it is left as LG made it');
      return cb(status());
    }
    try {
      util.mkdirp(ownDir());
      fs.writeFileSync(ownFile(), plain, 'utf8');
    } catch (e2) {
      problem('could not write the plain No Signal screen: ' + e2.message);
      return cb(status());
    }
    return execFn('/bin/mount', ['--bind', ownFile(), file], { timeout: 5000 }, function (err) {
      if (err) problem('could not mount the plain No Signal screen: ' + err.message);
      else { lastProblem = ''; console.log('nosignal: the plain No Signal screen is mounted'); restartWhenFree(); }
      cb(status());
    });
  }
  if (!on && isMounted) {
    return execFn('/bin/umount', [file], { timeout: 5000 }, function (err) {
      if (err) problem('could not unmount the plain No Signal screen: ' + err.message);
      else { lastProblem = ''; console.log('nosignal: LG\'s No Signal screen is back'); restartWhenFree(); }
      cb(status());
    });
  }
  cb(status());
}

function set(on, cb) {
  try {
    if (on) fs.writeFileSync(flagFile(), '1\n', 'utf8');
    else if (fs.existsSync(flagFile())) fs.unlinkSync(flagFile());
  } catch (e) { return cb({ ok: false, error: e.message }); }
  apply(cb);
}

// What the dashboards show: offered where the TV has the screen this knows.
function status() {
  var file = target(), available = false;
  if (file) {
    var isMounted = mounted(file);
    if (isMounted) available = true;
    else {
      try { available = !!patch(fs.readFileSync(file, 'utf8')); } catch (e) { available = false; }
    }
    return { ok: true, available: available, on: wanted(), applied: isMounted, restartPending: restartPending };
  }
  return { ok: true, available: false, on: wanted(), applied: false, restartPending: false };
}

module.exports = { init: init, apply: apply, set: set, status: status, patch: patch };
