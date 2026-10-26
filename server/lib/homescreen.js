/*
 * lib/homescreen.js - what LG's Home screen shows: its parts, and HDMI inputs
 * as tiles on it
 *
 * Each home app that can be changed has a module in LAYOUTS, and the first
 * whose supported() says yes is used; a TV with none has no Home screen
 * section. A module gives parts() as [{ id, title, desc, shown }], setPart(id,
 * shown, cb) and restore(cb), and says with inputTiles whether HDMI inputs can
 * be added as tiles there. One marked experimental is offered only once its
 * allowed() says yes (allowHomeLayout in config.json), and one with reapply()
 * has it called when the server starts. Supporting another webOS is a new
 * module in the list, with nothing else to change.
 *
 * An input tile is LG's own launch point for the input's app
 * (com.webos.app.hdmi1 and so on), added as a saved web page is. The ones
 * added here are recorded, so putting LG's Home screen back removes those and
 * not one added on the TV.
 *
 * Run as `node homescreen.js --restore` (tvwebctl restore-home), it puts LG's
 * Home screen back before Glasshouse is uninstalled.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;

var LAYOUTS = [require('./homescreen-webos9'), require('./homescreen-webos10')];
var INPUTS = ['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4'];
var APP_PREFIX = 'com.webos.app.';

var lunaFn = null;
var inputNames = {};
var stateFile = null;
var layout = null;
var refreshingTitles = false;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  inputNames = opts.inputNames || {};
  stateFile = opts.stateDir ? path.join(opts.stateDir, 'home-inputs.json') : null;
  layout = null;
  refreshingTitles = false;
  LAYOUTS.some(function (l) {
    l.init(opts);
    if (l.supported()) { layout = l; return true; }
    return false;
  });
}

// { hdmi1: launchPointId } for the tiles added here.
function readAdded() {
  if (!stateFile) return {};
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (e) { return {}; }
}

function writeAdded(map) {
  if (!stateFile) return;
  try {
    if (Object.keys(map).length) fs.writeFileSync(stateFile, JSON.stringify(map) + '\n', 'utf8');
    else fs.unlinkSync(stateFile);
  } catch (e) {}
}

function inputTitle(id) {
  return inputNames[id] || msg('srv.home.hdmi', 'HDMI {n}', { n: id.slice(4) });
}

function cecInputTitle(id, device) {
  var names = [];
  var list = Array.isArray(device.subList) ? device.subList : [];
  list.forEach(function (sub) {
    if (!sub || sub.id !== 'SIMPLINK' || typeof sub.osdName !== 'string') return;
    var name = sub.osdName.replace(/\s+/g, ' ').trim();
    if (name && names.indexOf(name) === -1) names.push(name);
  });
  var port = msg('srv.home.hdmi', 'HDMI {n}', { n: id.slice(4) });
  // With no CEC names, the TV's own current name for the input, where it has
  // one beyond the port's ("Mac" while a Mac is connected).
  var label = typeof device.label === 'string' ? device.label.trim() : '';
  if (!names.length && label && label !== port && label !== device.id) names.push(label);
  if (names.length) return msg('srv.home.hdmiDevices', '{devices} — {port}', { port: port, devices: names.join(' / ') });
  return port;
}

/*
 * webOS 9 hides bookmark titles unless titleVisible is set. Only tiles recorded
 * in home-inputs.json are changed; an input added on the TV stays its owner's.
 * EIM has no subscription for input changes, so tvweb.js calls this when the
 * Home screen opens, when the TV switches on and at start, never in standby.
 */
function refreshInputTitles(cb) {
  cb = typeof cb === 'function' ? cb : function () {};
  var added = readAdded();
  if (!layout || layout.id !== 'webos9' || !lunaFn || refreshingTitles || !Object.keys(added).length) return cb();
  refreshingTitles = true;
  function finish() { refreshingTitles = false; cb(); }
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    if (!res || res.returnValue === false || !Array.isArray(res.devices)) return finish();
    var devices = {};
    res.devices.forEach(function (device) {
      if (!device || typeof device.id !== 'string') return;
      var match = /^HDMI_([1-4])$/.exec(device.id);
      if (match) devices['hdmi' + match[1]] = device;
    });
    lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (res) {
      if (!res || res.returnValue === false || !Array.isArray(res.launchPoints)) return finish();
      var changes = [];
      res.launchPoints.forEach(function (point) {
        if (!point || typeof point.id !== 'string' || point.id.indexOf(APP_PREFIX) !== 0) return;
        var id = point.id.slice(APP_PREFIX.length);
        if (INPUTS.indexOf(id) === -1 || added[id] !== point.launchPointId || !devices[id]) return;
        var title = cecInputTitle(id, devices[id]);
        if (point.title !== title || point.titleVisible !== true) {
          changes.push({ launchPointId: point.launchPointId, title: title, titleVisible: true });
        }
      });
      var next = 0;
      (function update() {
        if (next === changes.length) return finish();
        lunaFn('com.webos.applicationManager/updateLaunchPoint', changes[next++], function (res) {
          if (!res || res.returnValue !== true) console.error('homescreen: could not update an HDMI tile title');
          update();
        });
      })();
    });
  });
}

// Launch points for each input, as { hdmi1: [launchPointId, ...] }.
function inputLaunchPoints(cb) {
  lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
    var lps = r && Array.isArray(r.launchPoints) ? r.launchPoints : null;
    if (!lps) return cb(null);
    var out = {};
    lps.forEach(function (p) {
      var id = p && typeof p.id === 'string' && p.id.indexOf(APP_PREFIX) === 0 ? p.id.slice(APP_PREFIX.length) : '';
      if (INPUTS.indexOf(id) === -1) return;
      (out[id] = out[id] || []).push(p.launchPointId);
    });
    cb(out);
  });
}

/*
 * cb(null) where the Home screen cannot be changed, otherwise { parts, inputs }
 * with inputs as [{ id, title, onHome }], or null where the TV did not list
 * its tiles.
 */
// Whether this TV's Home screen layout can be changed from here at all.
function supported() { return !!layout; }

function getHomeScreen(cb) {
  if (!layout || !lunaFn) return cb(null);
  var out = {
    parts: layout.parts(),
    inputs: null,
    // null, or whether the experimental feature has been switched on.
    experimental: layout.experimental ? { allowed: layout.allowed() } : null
  };
  if (!layout.inputTiles) return cb(out);
  inputLaunchPoints(function (lps) {
    if (lps) {
      out.inputs = INPUTS.map(function (id) {
        return { id: id, title: inputTitle(id), onHome: !!(lps[id] && lps[id].length) };
      });
    }
    cb(out);
  });
}

function setPart(id, shown, cb) {
  if (!layout) return cb({ ok: false, error: msg('srv.home.unsupported', 'This TV\'s Home screen cannot be changed from here') });
  layout.setPart(id, shown, cb);
}

/*
 * Adds the input's tile, or takes off every tile it has. cb({ ok, error }).
 */
function setInput(id, onHome, cb) {
  if (!layout || !layout.inputTiles) return cb({ ok: false, error: msg('srv.home.unsupported', 'This TV\'s Home screen cannot be changed from here') });
  if (layout.experimental && !layout.allowed()) return cb({ ok: false, error: msg('srv.home.notAllowed', 'Switch on Home screen layout first. It is experimental on this TV.') });
  if (INPUTS.indexOf(id) === -1) return cb({ ok: false, error: msg('srv.home.unknownInput', 'There is no such input') });
  inputLaunchPoints(function (lps) {
    if (!lps) return cb({ ok: false, error: msg('srv.home.noTiles', 'Could not read the TV\'s Home screen tiles. Try again in a moment.') });
    var have = lps[id] || [];
    var added = readAdded();
    if (onHome) {
      if (have.length) return refreshInputTitles(function () { cb({ ok: true }); });
      var point = { id: APP_PREFIX + id, title: inputTitle(id), params: {} };
      if (layout.id === 'webos9') point.titleVisible = true;
      return lunaFn('com.webos.applicationManager/addLaunchPoint',
                    point, function (r) {
        if (!r || r.returnValue !== true) return cb({ ok: false, error: msg('srv.apps.addRefused', 'the TV would not add it') });
        added[id] = r.launchPointId;
        writeAdded(added);
        console.log('homescreen: ' + id + ' added to Home');
        inputsFirst(function () { refreshInputTitles(function () { cb({ ok: true }); }); });
      });
    }
    removeLaunchPoints(have, function () {
      delete added[id];
      writeAdded(added);
      console.log('homescreen: ' + id + ' taken off Home');
      cb({ ok: true });
    });
  });
}

/*
 * Input tiles at the front of the app list, in HDMI order, where LG adds a
 * new tile at the end. The home app shows a moved tile only once it starts
 * again (a C2, webOS 9.2.2), so it is restarted, and only when one moved.
 */
function inputsFirst(cb) {
  lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
    var lps = r && Array.isArray(r.launchPoints) ? r.launchPoints : [];
    var order = lps.map(function (p) { return p && p.launchPointId; });
    var want = [];
    INPUTS.forEach(function (id) {
      for (var i = 0; i < lps.length; i++) {
        if (lps[i] && lps[i].id === APP_PREFIX + id) { want.push(lps[i].launchPointId); return; }
      }
    });
    var inPlace = want.every(function (lp, i) { return order[i] === lp; });
    if (inPlace) return cb();
    var n = 0;
    (function next() {
      if (n >= want.length) {
        console.log('homescreen: input tiles moved before the apps');
        return layout.restartHome ? layout.restartHome(cb) : cb();
      }
      var lp = want[n];
      lunaFn('com.webos.applicationManager/moveLaunchPoint', { launchPointId: lp, position: n++ }, function () { next(); });
    })();
  });
}

function removeLaunchPoints(ids, cb) {
  var i = 0;
  (function next() {
    if (i >= ids.length) return cb();
    lunaFn('com.webos.applicationManager/removeLaunchPoint', { launchPointId: ids[i++] }, function () { next(); });
  })();
}

// null where the TV's Home screen layout is not experimental, else { allowed }.
function experimental() {
  return layout && layout.experimental ? { allowed: layout.allowed() } : null;
}

// Called once allowHomeLayout has been saved: switched off, LG's Home is put back.
function allowChanged(allow, cb) {
  if (allow || !layout || !layout.experimental) return cb({ ok: true });
  restore(cb);
}

// At start: a layout that does not outlast a restart of the TV, put back.
function reapply(cb) {
  cb = cb || function () {};
  if (!layout || !layout.reapply) return cb();
  layout.reapply(cb);
}

/*
 * LG's Home screen back: its own layout, and none of the input tiles added
 * here. cb({ ok }).
 */
function restore(cb) {
  var added = readAdded();
  var ids = Object.keys(added).map(function (k) { return added[k]; });
  function layoutBack() {
    if (!layout) return cb({ ok: true });
    layout.restore(function (r) { cb({ ok: !!(r && r.ok), error: r && r.error }); });
  }
  if (!ids.length || !lunaFn) return layoutBack();
  removeLaunchPoints(ids, function () {
    writeAdded({});
    layoutBack();
  });
}

module.exports = {
  init: init,
  supported: supported,
  getHomeScreen: getHomeScreen,
  setPart: setPart,
  setInput: setInput,
  restore: restore,
  allowChanged: allowChanged,
  experimental: experimental,
  reapply: reapply,
  refreshInputTitles: refreshInputTitles,
  INPUTS: INPUTS
};

// tvwebctl restore-home: no server running, so luna and the version are found here.
if (require.main === module && process.argv[2] === '--restore') {
  var luna = require('./luna');
  var call = luna.call || luna;
  var dir = path.join(__dirname, '..');
  var issue = '';
  try { issue = fs.readFileSync('/etc/issue', 'utf8'); } catch (e) {}
  var ver = (issue.match(/webOS(?:\s+TV)?\s+([\d.]+)/i) || [])[1] || '';
  // Any layout module that finds a file of its own puts LG's back, whatever
  // the version reads as.
  init({ luna: call, stateDir: dir, webosVersion: ver });
  restore(function () {
    LAYOUTS.forEach(function (l) { if (l !== layout) l.init({ luna: call }); });
    var i = 0;
    (function next() {
      if (i >= LAYOUTS.length) { console.log('homescreen: default layout restored'); return process.exit(0); }
      var l = LAYOUTS[i++];
      if (l === layout) return next();
      l.restore(function () { next(); });
    })();
  });
}
