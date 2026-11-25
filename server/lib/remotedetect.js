/*
 * lib/remotedetect.js - which LG remotes the TV is used with
 *
 * A Magic Remote announces its model as its Bluetooth name when it pairs
 * ("LGE MR25GA" on an OLED48C56LB, webOS 10.3.0, matching its label), and the
 * TV keeps that name. This gathers it, cheaply and only when asked:
 *
 *  - the pairing file's name, which telemetry already reads for the battery
 *    (the remote the TV is paired with now);
 *  - the remote_type lginput2 logs with every press (NL_BUTTON_CLICK in
 *    /var/log/messages), from the end of the log: it also finds a second
 *    remote in use, which the pairing file, holding one, cannot;
 *  - the names of the remote input devices, which only tell a family of remote
 *    (LGE M-RCU), never a model, and so stay a hint.
 *
 * What was seen is kept in remotes-seen.json, names and times only (no
 * addresses), so a remote used last week still counts while another is in use.
 * A name the catalogue (lib/remotes.js) does not know is listed with no id: it
 * is an unknown remote, not a guess.
 *
 * The log's timestamps are the TV's clock, which sits in 2023 until the TV has
 * the time: a press from before that is kept as it is read.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var remotes = require('./remotes');
var util = require('./util');
var allocBuffer = util.allocBuffer;

var MESSAGES_LOG = '/var/log/messages';
var INPUT_DEVICES = '/proc/bus/input/devices';
// How much of the end of the log is read: a press from a few hours of use.
var LOG_TAIL_BYTES = 256 * 1024;
// A reading is reused for this long.
var CACHE_MS = 30000;
// The most names kept, and how much later a sighting must be to be written again.
var SEEN_MAX = 20;
var SEEN_REWRITE_MS = 10 * 60 * 1000;
// The input devices a remote's presses arrive on (lib/remotebuttons.js has the same names).
var REMOTE_DEVICE = /LGE RCU|LGE M-RCU|Smart Remote RCU Input|LGE Simple Premium|LGE W-RCU|LGE TONE\+/i;
var BUTTON_CLICK = /NL_BUTTON_CLICK\b.*"remote_type"\s*:\s*"([^"]+)"/;

var pairingFn = function () { return null; };
var messagesPath = MESSAGES_LOG;
var devicesPath = INPUT_DEVICES;
var stateDir = path.join(__dirname, '..');
var nowFn = function () { return Date.now(); };
var cached = null;
var cachedAt = 0;

/*
 * opts: pairing() the paired remote's { model } or null (telemetry.remoteInfo),
 * stateDir, messagesPath, devicesPath, now() for the tests.
 */
function init(opts) {
  opts = opts || {};
  pairingFn = typeof opts.pairing === 'function' ? opts.pairing : function () { return null; };
  if (opts.stateDir) stateDir = opts.stateDir;
  messagesPath = opts.messagesPath || MESSAGES_LOG;
  devicesPath = opts.devicesPath || INPUT_DEVICES;
  nowFn = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  cached = null;
  cachedAt = 0;
}

function seenFile() { return path.join(stateDir, 'remotes-seen.json'); }

// { name: time of the last sighting }.
function readSeen() {
  try {
    var j = JSON.parse(fs.readFileSync(seenFile(), 'utf8'));
    var out = {};
    var names = j && typeof j.remotes === 'object' ? j.remotes : {};
    Object.keys(names).forEach(function (n) {
      if (typeof names[n] === 'number' && isFinite(names[n])) out[n] = names[n];
    });
    return out;
  } catch (e) {
    return {};
  }
}

function writeSeen(seen) {
  var names = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; }).slice(0, SEEN_MAX);
  var out = {};
  names.forEach(function (n) { out[n] = seen[n]; });
  try {
    util.writeJsonAtomic(seenFile(), { remotes: out });
  } catch (e) {
    console.error('remotedetect: could not keep the remotes seen: ' + e.message);
  }
}

// The last `bytes` of a file as text, from a whole line; '' where there is none.
function tailFile(file, bytes, cb) {
  fs.stat(file, function (err, st) {
    if (err || !st.size) return cb('');
    var start = Math.max(0, st.size - bytes);
    var length = st.size - start;
    fs.open(file, 'r', function (err2, fd) {
      if (err2) return cb('');
      var buf = allocBuffer(length);
      fs.read(fd, buf, 0, length, start, function (err3, read) {
        fs.close(fd, function () {});
        if (err3 || !read) return cb('');
        var text = buf.toString('utf8', 0, read);
        // A read that began mid-line starts at the next line.
        if (start > 0) {
          var nl = text.indexOf('\n');
          text = nl === -1 ? '' : text.substring(nl + 1);
        }
        cb(text);
      });
    });
  });
}

var SYSLOG_DATE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\b/;
var SYSLOG_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseLogTime(line, now) {
  var when = Date.parse(line.split(/\s+/)[0]);
  if (!isNaN(when)) return when;
  var sm = SYSLOG_DATE.exec(line);
  if (sm) {
    var d = new Date(now);
    var year = d.getFullYear();
    var mon = SYSLOG_MONTHS[sm[1]];
    var t = new Date(year, mon, parseInt(sm[2], 10), parseInt(sm[3], 10), parseInt(sm[4], 10), parseInt(sm[5], 10)).getTime();
    if (t - now > 24 * 3600 * 1000) {
      t = new Date(year - 1, mon, parseInt(sm[2], 10), parseInt(sm[3], 10), parseInt(sm[4], 10), parseInt(sm[5], 10)).getTime();
    }
    return t;
  }
  return now;
}

// { remote_type: time of its last press } from log text.
function pressesIn(text, now) {
  var out = {};
  text.split('\n').forEach(function (line) {
    var m = BUTTON_CLICK.exec(line);
    if (!m) return;
    var when = parseLogTime(line, now);
    if (!(m[1] in out) || when > out[m[1]]) out[m[1]] = when;
  });
  return out;
}

// The distinct names of the TV's remote input devices, "LGE M-RCU - Builtin [0]" as "LGE M-RCU".
function inputDevices() {
  var out = [];
  try {
    fs.readFileSync(devicesPath, 'utf8').split('\n\n').forEach(function (block) {
      var m = /Name="([^"]+)"/.exec(block);
      if (!m || !REMOTE_DEVICE.test(m[1])) return;
      var name = m[1].replace(/\s*-\s*Builtin\s*\[\d+\]\s*$/i, '');
      if (out.indexOf(name) === -1) out.push(name);
    });
  } catch (e) { /* no such file: no hint */ }
  return out;
}

function describe(name, found) {
  var remote = remotes.find(name);
  return {
    name: name,
    id: remote ? remote.id : null,
    title: remote ? remote.title : name,
    image: remotes.imageFile(remote),
    sources: found.sources,
    current: found.current,
    lastSeen: found.lastSeen
  };
}

/*
 * cb({ remotes: [{ name, id, title, image, sources, current, lastSeen }],
 * devices: [names] }). remotes lists the paired remote first (current), then
 * the others by when they were last seen; sources says how each was found:
 * 'pairing', 'log' and 'seen' (kept from an earlier reading).
 */
function detect(cb, fresh) {
  var now = nowFn();
  if (!fresh && cached && now - cachedAt < CACHE_MS) return cb(cached);
  tailFile(messagesPath, LOG_TAIL_BYTES, function (text) {
    var found = {};
    function add(name, source, when, current) {
      var f = found[name] || (found[name] = { sources: [], current: false, lastSeen: null });
      if (f.sources.indexOf(source) === -1) f.sources.push(source);
      if (current) f.current = true;
      if (when !== null && (f.lastSeen === null || when > f.lastSeen)) f.lastSeen = when;
    }
    var seen = readSeen();
    var paired = null;
    try { paired = pairingFn(); } catch (e) { paired = null; }
    var pairedName = paired && typeof paired.model === 'string' ? paired.model.trim() : '';
    if (pairedName) add(pairedName, 'pairing', now, true);
    var presses = pressesIn(text, now);
    Object.keys(presses).forEach(function (n) { add(n, 'log', presses[n], false); });
    // What this reading learns is kept, before the earlier sightings join it.
    var changed = false;
    Object.keys(found).forEach(function (n) {
      if (!(n in seen) || found[n].lastSeen - seen[n] > SEEN_REWRITE_MS) { seen[n] = found[n].lastSeen; changed = true; }
    });
    if (changed) writeSeen(seen);
    Object.keys(seen).forEach(function (n) {
      if (!(n in found)) add(n, 'seen', seen[n], false);
    });
    var list = Object.keys(found).map(function (n) { return describe(n, found[n]); });
    list.sort(function (a, b) {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
    cached = { remotes: list, devices: inputDevices() };
    cachedAt = now;
    cb(cached);
  });
}

// Automatic selection looks back this far for a remote seen in use.
var AUTO_WINDOW_MS = 30 * 24 * 3600 * 1000;

/*
 * The remotes the Remote tab is for when it is left on Automatic: those paired
 * now and those seen in the last 30 days, as catalogue entries, null for one the
 * catalogue lacks. detected is detect()'s answer.
 */
function autoSelected(detected, now) {
  var out = [];
  ((detected && detected.remotes) || []).forEach(function (r) {
    if (r.current || (r.lastSeen !== null && now - r.lastSeen <= AUTO_WINDOW_MS)) out.push(remotes.find(r.name));
  });
  return out;
}

module.exports = {
  init: init,
  detect: detect,
  autoSelected: autoSelected,
  AUTO_WINDOW_MS: AUTO_WINDOW_MS,
  // For the tests.
  pressesIn: pressesIn,
  CACHE_MS: CACHE_MS,
  SEEN_MAX: SEEN_MAX
};
