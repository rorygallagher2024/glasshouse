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
 * restarted, and only while no input with a picture is on screen, as
 * restarting it blanks the input in front for a moment. A mount does not
 * outlive a reboot; the server mounts it again at start. A TV boots onto its
 * last input with the input app started before the server (5 s into a C2's
 * boot, 7 s into a B8's), so an input with nothing coming in does not hold the
 * restart back: its No Signal screen is drawn again, plain, with nothing lost.
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
var HEADER_START = /\n([ \t]*)ScreensaverMainText \{\s*\n[ \t]*id: headerText(?=\n)/g;
var HEADER_ID = /(\n([ \t]*)id: headerText)(?=\n)/g;

function iconBlock(indent) {
  var pad = indent + '    ';
  var body = pad + '    ';
  var lines = [
    indent + 'Canvas {',
    pad + 'id: glasshouseNoSignalIcon',
    pad + 'anchors.horizontalCenter: parent.horizontalCenter',
    pad + 'width: Math.round(128 * screensaverRoot.height / 1080)',
    pad + 'height: Math.round(64 * screensaverRoot.height / 1080)',
    pad + 'visible: currentKey === "noSignal"',
    pad + 'onVisibleChanged: if (visible) requestPaint();',
    pad + 'onWidthChanged: requestPaint();',
    pad + 'onHeightChanged: requestPaint();',
    pad + 'onPaint: {',
    body + 'if (width <= 0 || height <= 0) return;',
    body + 'var ctx = getContext("2d");',
    body + 'var s = width / 128;',
    body + 'ctx.clearRect(0, 0, width, height);',
    body + 'ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";',
    body + 'ctx.lineWidth = Math.max(2, 2.6 * s);',
    body + 'ctx.lineCap = "round";',
    body + 'ctx.lineJoin = "round";',
    body + 'ctx.beginPath();',
    body + 'ctx.moveTo(20 * s, 32 * s);',
    body + 'ctx.lineTo(34 * s, 32 * s);',
    body + 'ctx.moveTo(42 * s, 26 * s);',
    body + 'ctx.lineTo(34 * s, 26 * s);',
    body + 'ctx.lineTo(34 * s, 38 * s);',
    body + 'ctx.lineTo(42 * s, 38 * s);',
    body + 'ctx.moveTo(42 * s, 24 * s);',
    body + 'ctx.lineTo(48 * s, 18 * s);',
    body + 'ctx.lineTo(66 * s, 18 * s);',
    body + 'ctx.lineTo(66 * s, 46 * s);',
    body + 'ctx.lineTo(48 * s, 46 * s);',
    body + 'ctx.lineTo(42 * s, 40 * s);',
    body + 'ctx.closePath();',
    body + 'ctx.moveTo(52 * s, 24 * s);',
    body + 'ctx.lineTo(52 * s, 40 * s);',
    body + 'ctx.moveTo(57 * s, 24 * s);',
    body + 'ctx.lineTo(57 * s, 40 * s);',
    body + 'ctx.moveTo(66 * s, 23 * s);',
    body + 'ctx.lineTo(79 * s, 23 * s);',
    body + 'ctx.lineTo(79 * s, 41 * s);',
    body + 'ctx.lineTo(66 * s, 41 * s);',
    body + 'ctx.moveTo(72.5 * s, 27.5 * s);',
    body + 'ctx.lineTo(72.5 * s, 29.5 * s);',
    body + 'ctx.moveTo(72.5 * s, 34.5 * s);',
    body + 'ctx.lineTo(72.5 * s, 36.5 * s);',
    body + 'ctx.moveTo(95 * s, 12 * s);',
    body + 'ctx.lineTo(95 * s, 23 * s);',
    body + 'ctx.lineTo(108 * s, 23 * s);',
    body + 'ctx.lineTo(108 * s, 41 * s);',
    body + 'ctx.lineTo(95 * s, 41 * s);',
    body + 'ctx.lineTo(95 * s, 52 * s);',
    body + 'ctx.moveTo(101.5 * s, 28 * s);',
    body + 'ctx.lineTo(101.5 * s, 36 * s);',
    body + 'ctx.stroke();',
    pad + '}',
    indent + '}'
  ];
  return lines.join('\n');
}
// An input on screen, which restarting the input app would blank.
var INPUT_IN_FRONT = /^com\.webos\.app\.(hdmi|externalinput|livetv|inputcommon|livemenuplayer|livezoom|acrhdmi|adhdmi)/;
var RETRY_MS = 60000;

var luna = null;
var execFn = execFile;
var stateDir = '/var/lib/tvweb';
var appQml = APP_QML;
var retryMs = RETRY_MS;
var mountinfo = '/proc/self/mountinfo';
// A restart still owed, kept where a reboot clears it, so a server restart takes it up again.
var pendingFile = '/var/run/tvweb-nosignal-restart';
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
  pendingFile = opts.pendingFile || '/var/run/tvweb-nosignal-restart';
  restartPending = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function flagFile() { return path.join(stateDir, 'nosignal_plain'); }
function ownDir() { return path.join(stateDir, 'nosignal'); }
function ownFile() { return path.join(ownDir(), 'Screensaver.qml'); }
function origFile() { return path.join(ownDir(), 'Screensaver.lg.qml'); }

function normalizeMode(val) {
  if (val === 'icon') return 'icon';
  if (val === 'plain' || val === true || val === 'on' || val === 'true') return 'plain';
  return 'lg';
}

function wanted() {
  if (!fs.existsSync(flagFile())) return 'lg';
  try {
    return fs.readFileSync(flagFile(), 'utf8').trim() === 'icon' ? 'icon' : 'plain';
  } catch (e) {
    return 'plain';
  }
}

function modeLabel(mode) {
  if (mode === 'icon') return 'disconnected-cable';
  if (mode === 'plain') return 'plain';
  return 'LG\'s';
}

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
 * The TV's own file patched for the requested mode ('plain' or 'icon'), or
 * null where a line this looks for is not there exactly once.
 */
function patch(text, mode) {
  var out = String(text || '');
  for (var i = 0; i < PATCHES.length; i++) {
    var found = out.match(PATCHES[i].find);
    if (!found || found.length !== 1) return null;
    out = out.replace(PATCHES[i].find, '$1' + PATCHES[i].add);
  }
  if (mode === 'icon') {
    var heads = out.match(HEADER_START);
    if (!heads || heads.length !== 1) return null;
    out = out.replace(HEADER_START, function (match, indent) {
      return '\n' + iconBlock(indent) + match;
    });
    var ids = out.match(HEADER_ID);
    if (!ids || ids.length !== 1) return null;
    out = out.replace(HEADER_ID, function (match, line, indent) {
      return line + '\n' + indent + 'visible: currentKey !== "noSignal"';
    });
  }
  return out;
}

function problem(text) {
  if (text !== lastProblem) console.error('nosignal: ' + text);
  lastProblem = text;
}

/*
 * Whether the input an app shows has nothing coming in: the input manager's
 * `activate` for it is false (an empty HDMI port on a B8 and a C2, and a C2's
 * port with a device connected but sending nothing). Anything else, a failed
 * call included, counts as a picture.
 */
function nothingComingIn(reply, appId) {
  var devices = reply && Array.isArray(reply.devices) ? reply.devices : [];
  for (var i = 0; i < devices.length; i++) {
    if (devices[i] && devices[i].appId === appId) return devices[i].activate === false;
  }
  return false;
}

/*
 * Restarts the input app: now if no input is in front or the one in front has
 * nothing coming in, otherwise once that is so.
 */
function restartWhenFree() {
  restartPending = true;
  try { fs.writeFileSync(pendingFile, '1\n', 'utf8'); } catch (e) { /* asked again only until the server restarts */ }
  if (retryTimer) return;
  var ask = luna ? luna : function (uri, params, cb) { cb(null); };
  var later = function () {
    retryTimer = setTimeout(check, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  };
  // reopen: the input in front. On webOS 9 (a C2) the input closes with the
  // input app and Home opens; on webOS 4 (a B8) it stays, and opening it again
  // changes nothing.
  var restart = function (reopen) {
    restartPending = false;
    try { fs.unlinkSync(pendingFile); } catch (e) { /* not there */ }
    execFn('/usr/bin/killall', [INPUT_APP], { timeout: 5000 }, function () {
      console.log('nosignal: the input app restarted, so its No Signal screen is ' + modeLabel(wanted()));
      if (reopen) ask('com.webos.applicationManager/launch', { id: reopen }, function () {});
    });
  };
  var check = function () {
    retryTimer = null;
    if (!restartPending) return;
    ask('com.webos.applicationManager/getForegroundAppInfo', {}, function (r) {
      var appId = r && typeof r.appId === 'string' ? r.appId : '';
      if (!INPUT_IN_FRONT.test(appId)) return restart(null);
      ask('com.webos.service.eim/getAllInputStatus', {}, function (inputs) {
        if (!restartPending) return;
        if (nothingComingIn(inputs, appId)) restart(appId);
        else later();
      });
    });
  };
  check();
}

/*
 * Mounts the copy, or takes it away, to match the setting. cb({ ok, ... }) once
 * the mount is done; the input app's restart may follow later.
 */
function writePatched(text, mode, saveOrig) {
  var next = patch(text, mode);
  if (!next) {
    problem('this firmware\'s No Signal screen is not the one known, so it is left as LG made it');
    return null;
  }
  try {
    util.mkdirp(ownDir());
    if (saveOrig) fs.writeFileSync(origFile(), text, 'utf8');
    fs.writeFileSync(ownFile(), next, 'utf8');
  } catch (e) {
    problem('could not write the ' + modeLabel(mode) + ' No Signal screen: ' + e.message);
    return null;
  }
  return next;
}

function mountOwn(file, mode, cb) {
  execFn('/bin/mount', ['--bind', ownFile(), file], { timeout: 5000 }, function (err) {
    if (err) problem('could not mount the ' + modeLabel(mode) + ' No Signal screen: ' + err.message);
    else {
      lastProblem = '';
      console.log('nosignal: the ' + modeLabel(mode) + ' No Signal screen is mounted');
      restartWhenFree();
    }
    cb(status());
  });
}

function apply(cb) {
  cb = cb || function () {};
  var file = target();
  if (!file) return cb(status());
  var mode = wanted(), on = mode !== 'lg', isMounted = mounted(file);
  if (on && !isMounted) {
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      problem('could not read the No Signal screen: ' + e.message);
      return cb(status());
    }
    if (!writePatched(text, mode, true)) return cb(status());
    return mountOwn(file, mode, cb);
  }
  if (on && isMounted) {
    if (!fs.existsSync(origFile())) {
      // Upgraded while plain was mounted: recover LG's copy before re-patching.
      return execFn('/bin/umount', [file], { timeout: 5000 }, function (err) {
        if (err) {
          problem('could not unmount the No Signal screen: ' + err.message);
          return cb(status());
        }
        var raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
          problem('could not read the No Signal screen: ' + e.message);
          return cb(status());
        }
        if (!writePatched(raw, mode, true)) return cb(status());
        mountOwn(file, mode, cb);
      });
    }
    var origText, currentOwn = '';
    try { origText = fs.readFileSync(origFile(), 'utf8'); } catch (e2) {
      problem('could not read the saved No Signal screen: ' + e2.message);
      return cb(status());
    }
    try { currentOwn = fs.readFileSync(ownFile(), 'utf8'); } catch (e3) { /* rewrite */ }
    var targetOwn = patch(origText, mode);
    if (!targetOwn) {
      problem('this firmware\'s No Signal screen is not the one known, so it is left as LG made it');
      return cb(status());
    }
    if (currentOwn !== targetOwn) {
      if (!writePatched(origText, mode, false)) return cb(status());
      lastProblem = '';
      console.log('nosignal: switched to the ' + modeLabel(mode) + ' No Signal screen');
      restartWhenFree();
    } else if (!restartPending && fs.existsSync(pendingFile)) {
      restartWhenFree();
    }
    return cb(status());
  }
  if (!on && isMounted) {
    return execFn('/bin/umount', [file], { timeout: 5000 }, function (err) {
      if (err) problem('could not unmount the No Signal screen: ' + err.message);
      else { lastProblem = ''; console.log('nosignal: LG\'s No Signal screen is back'); restartWhenFree(); }
      cb(status());
    });
  }
  if (!restartPending && fs.existsSync(pendingFile)) restartWhenFree();
  cb(status());
}

function set(val, cb) {
  var mode = normalizeMode(val);
  try {
    if (mode === 'lg') {
      if (fs.existsSync(flagFile())) fs.unlinkSync(flagFile());
    } else {
      fs.writeFileSync(flagFile(), mode + '\n', 'utf8');
    }
  } catch (e) { return cb({ ok: false, error: e.message }); }
  apply(cb);
}

// What the dashboards show: offered where the TV has the screen this knows.
function status() {
  var file = target(), mode = wanted(), available = false;
  if (file) {
    var isMounted = mounted(file);
    if (isMounted) available = true;
    else {
      try { available = !!patch(fs.readFileSync(file, 'utf8'), 'icon'); } catch (e) { available = false; }
    }
    return { ok: true, available: available, on: mode !== 'lg', mode: mode, applied: isMounted, restartPending: restartPending };
  }
  return { ok: true, available: false, on: mode !== 'lg', mode: mode, applied: false, restartPending: false };
}

module.exports = { init: init, apply: apply, set: set, status: status, patch: patch };
