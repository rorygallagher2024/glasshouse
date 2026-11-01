/*
 * lib/home-recent.js - when each tile on Glasshouse Home was last opened,
 * for the rows set to Last opened (lib/home)
 *
 * One time per tile id and row, in /var/lib/tvweb/home-recent.json. Only the
 * rows that use it are kept: lib/home records nothing for a row in its own
 * order, and forgets a row once it goes back to it.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var writeJsonAtomic = require('./util').writeJsonAtomic;

var ROWS = ['app', 'dev', 'ch', 'iptv'];
// Ids kept per row; the oldest go first. A row holds a few dozen tiles.
var MAX_IDS = 100;
// Opening several tiles in a row writes the file once.
var SAVE_DELAY_MS = 5000;

var file = '/var/lib/tvweb/home-recent.json';
var nowMs = Date.now;
var times = null;
var saveTimer = null;

function init(stateDir, now) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  file = path.join(stateDir, 'home-recent.json');
  nowMs = now || Date.now;
  times = null;
}

function empty() { return { app: {}, dev: {}, ch: {}, iptv: {} }; }

function load() {
  if (times) return times;
  times = empty();
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  ROWS.forEach(function (r) {
    var row = raw && typeof raw === 'object' && raw[r];
    if (!row || typeof row !== 'object') return;
    for (var id in row) {
      if (Object.prototype.hasOwnProperty.call(row, id) && typeof row[id] === 'number' && id.length <= 200) times[r][id] = row[id];
    }
  });
  return times;
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!times) return;
  try {
    writeJsonAtomic(file, times, 384);
  } catch (e) {
    console.error('home: could not save home-recent.json: ' + e.message);
  }
}

function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

function stamp(row, id) {
  if (ROWS.indexOf(row) === -1 || typeof id !== 'string' || !id || id.length > 200) return;
  var t = load()[row];
  t[id] = nowMs();
  var ids = Object.keys(t);
  if (ids.length > MAX_IDS) {
    ids.sort(function (a, b) { return t[a] - t[b]; });
    ids.slice(0, ids.length - MAX_IDS).forEach(function (old) { delete t[old]; });
  }
  saveSoon();
}

// { id: ms } for a row: a copy, so a caller cannot change what is kept.
function of(row) {
  var t = load()[row] || {}, out = {};
  for (var id in t) if (Object.prototype.hasOwnProperty.call(t, id)) out[id] = t[id];
  return out;
}

function forget(row) {
  var t = load();
  if (!t[row] || !Object.keys(t[row]).length) return;
  t[row] = {};
  if (!ROWS.some(function (r) { return Object.keys(t[r]).length; })) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try { fs.unlinkSync(file); } catch (e) {}
    return;
  }
  save();
}

module.exports = {
  init: init,
  stamp: stamp,
  of: of,
  forget: forget,
  flush: function () { if (saveTimer) save(); }
};
