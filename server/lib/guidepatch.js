/*
 * lib/guidepatch.js - the remote's Guide and Input keys on webOS 11, for
 * Glasshouse Home's guide and for an app or input of the owner's choice
 *
 * webOS 11's key filters are native: libappLaunch.so reads the configd value
 * com.webos.keyaction.tvGuide and launches its app with no launch parameters,
 * so Glasshouse Home cannot be told to open its guide, and with Home already
 * in front it launches nothing at all (isForegroundApp). The Input key has no
 * value to read: the library opens LG's input picker, named in a text of its
 * own. A few bytes of the library's code and literals give each key what it
 * needs:
 *   guide  the launch passes {"glasshouse":"guide"} where it passed {}, and
 *          Home being in front no longer ends the key
 *   input  the text both of the input picker's launches pass, which names the
 *          picker, names the app or input chosen instead (an id of up to 30
 *          characters, as the text is 41 bytes long)
 *
 * Nothing of LG's is shipped: the library on the TV is read, found to be a
 * build listed here by its SHA-256 with the places changed put back, changed
 * in memory and written beside Glasshouse's own files. The copy is bind
 * mounted over LG's, which stays as it is on the read-only rootfs, and the
 * compositor (surface-manager), the only process that loads it, is restarted
 * once to read the copy. A key's change is made only while it is set: setting
 * it back changes the copy again. A restart of the TV puts LG's library back
 * until the next start of Glasshouse. A build not listed here, or one changed
 * anywhere else, is left alone.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var util = require('./util');

var LIBRARY = '/usr/lib/libappLaunch.so.1';
var COMPOSITOR = 'surface-manager-daemon.service';
var COPY_PREFIX = 'libappLaunch.so.1.glasshouse-';
var EXEC_MS = 30000;
// The longest id the input key's text can hold.
var MAX_ID = 30;
var ID_RE = /^[A-Za-z0-9._-]{1,30}$/;
var PICKER_TEXT_RE = /^\{"id": "([A-Za-z0-9._-]{1,30})"\}\0*$/;

/*
 * The builds known to take the changes, by the SHA-256 of LG's library. An
 * edit is the bytes at an offset as LG has them (was), and as they become
 * (now), both in hex. picker is the text the Input key's launches pass, at its
 * offset, as LG has it. A library is a build when it hashes to the key with
 * every place changed put back, so a change anywhere else refuses it.
 */
var GUIDE_PARAMS = '7b22676c617373686f757365223a226775696465227d00';
var BUILDS = {
  '6a409d5c7eea92c56aca3894c2652595f2ed241df61267063c3feefecf37ca66': {
    tv: 'OLED48C31LA, webOS 11.2.0, firmware 44.00.92',
    guide: [
      // The Guide key's launch reads its parameters from a literal: now the text below, kept in unused padding.
      { at: 0x53958, was: new Array(24).join('00'), now: GUIDE_PARAMS },
      { at: 0x2fa9c, was: '66ce01', now: 'd64502' },
      // bne to the end of the key when the app to open is already in front: a nop.
      { at: 0x2f2a6, was: '7ff4d1ae', now: 'aff30080' }
    ],
    picker: { at: 0x4e724, was: '7b226964223a2022636f6d2e7765626f732e6170702e717569636b696e7075747069636b6572227d00' }
  }
};

var library = LIBRARY;
var stateDir = '/var/lib/tvweb';
var execFn = execFile;
var cached = null;
var copyNumber = 0;

function init(opts) {
  opts = opts || {};
  library = opts.library || LIBRARY;
  if (opts.stateDir) stateDir = opts.stateDir;
  execFn = opts.exec || execFile;
  cached = null;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function hex(buf, at, length) { return buf.slice(at, at + length).toString('hex'); }

function copyOf(buf) {
  var copy = util.allocBuffer(buf.length);
  buf.copy(copy);
  return copy;
}

function put(buf, at, hexText) { util.toBuffer(hexText, 'hex').copy(buf, at); }

// The text the Input key's launches pass for an app or input, padded with zeros to the length of LG's.
function pickerText(build, id) {
  var size = build.picker.was.length / 2;
  var text = '{"id": "' + id + '"}';
  while (text.length < size) text += '\0';
  return util.toBuffer(text, 'latin1');
}

// Which of the guide's changes a library has: true, false, or null where it has some of them or other bytes.
function guideState(buf, build) {
  var on = 0, off = 0;
  build.guide.forEach(function (e) {
    var current = hex(buf, e.at, e.was.length / 2);
    if (current === e.now) on++;
    else if (current === e.was) off++;
  });
  if (on === build.guide.length) return true;
  if (off === build.guide.length) return false;
  return null;
}

// The id the Input key opens, '' for LG's picker, or null where the text is neither.
function pickerState(buf, build) {
  var size = build.picker.was.length / 2;
  if (hex(buf, build.picker.at, size) === build.picker.was) return '';
  var m = PICKER_TEXT_RE.exec(buf.slice(build.picker.at, build.picker.at + size).toString('latin1'));
  return m ? m[1] : null;
}

/*
 * The build a library is, with what it has changed, or null: its changed
 * places put back must hash to a listed build.
 */
function buildOf(buf) {
  for (var id in BUILDS) {
    if (!BUILDS.hasOwnProperty(id)) continue;
    var build = BUILDS[id];
    var plain = copyOf(buf);
    build.guide.forEach(function (e) { put(plain, e.at, e.was); });
    put(plain, build.picker.at, build.picker.was);
    if (sha256(plain) !== id) continue;
    var guide = guideState(buf, build), input = pickerState(buf, build);
    if (guide === null || input === null) return null;
    return { id: id, build: build, on: { guide: guide, input: input } };
  }
  return null;
}

/*
 * What this TV's library is: { supported, applied: { guide, input }, tv }, with
 * input the id the Input key opens, or ''. Read once, then again after a change.
 */
function status() {
  if (cached) return cached;
  var buf;
  try { buf = fs.readFileSync(library); } catch (e) { return { supported: false, applied: {} }; }
  var found = buildOf(buf);
  cached = found ? { supported: true, applied: found.on, tv: found.build.tv } : { supported: false, applied: {} };
  return cached;
}

// Whether an id can be put in the Input key's text.
function validId(id) { return ID_RE.test(String(id || '')); }

function setKey(want) { return (want.guide ? 'g' : '-') + (want.input ? 'i' : '-'); }

function run(file, args, cb) {
  execFn(file, args, { timeout: EXEC_MS }, function (err) { cb(err || null); });
}

// The copies of an earlier change, which nothing needs once another is mounted over them. One still mounted stays until the TV restarts.
function dropOldCopies(keep) {
  try {
    fs.readdirSync(stateDir).forEach(function (f) {
      if (f.indexOf(COPY_PREFIX) === 0 && f !== keep) util.unlinkQuiet(path.join(stateDir, f));
    });
  } catch (e) {}
}

/*
 * Mounts the library with the changes wanted ({ guide: whether, input: an id
 * or '' }) over LG's, and restarts the compositor once to read it. Where it is
 * as wanted already nothing is done. cb({ ok, restarted, error }).
 */
function apply(want, cb) {
  var st = status();
  if (!st.supported) return cb({ ok: false, error: 'unsupported' });
  var input = want.input || '';
  if (input && !validId(input)) return cb({ ok: false, error: 'id' });
  if (!!st.applied.guide === !!want.guide && st.applied.input === input) return cb({ ok: true, restarted: false });
  var buf;
  try { buf = fs.readFileSync(library); } catch (e) { return cb({ ok: false, error: 'read' }); }
  var found = buildOf(buf);
  if (!found) return cb({ ok: false, error: 'mismatch' });
  var copy = copyOf(buf), build = found.build;
  build.guide.forEach(function (e) { put(copy, e.at, want.guide ? e.now : e.was); });
  (input ? pickerText(build, input) : util.toBuffer(build.picker.was, 'hex')).copy(copy, build.picker.at);
  // A name of its own each time: a copy mounted earlier cannot be written over, and one of the same set may be.
  var name = COPY_PREFIX + setKey(want) + '-' + Date.now().toString(36) + (++copyNumber).toString(36);
  var file = path.join(stateDir, name), tmp = file + '.tmp';
  try {
    util.mkdirp(stateDir);
    fs.writeFileSync(tmp, copy, { mode: parseInt('755', 8) });
    fs.renameSync(tmp, file);
  } catch (e) {
    return cb({ ok: false, error: 'write' });
  }
  run('mount', ['--bind', file, library], function (mountErr) {
    if (mountErr) return cb({ ok: false, error: 'mount' });
    cached = null;
    var after = status();
    if (!after.supported || !!after.applied.guide !== !!want.guide || after.applied.input !== input) return cb({ ok: false, error: 'mount' });
    dropOldCopies(name);
    console.log('guidepatch: the key handler is changed on ' + build.tv + ' (' + setKey(want) + '), restarting the compositor');
    run('systemctl', ['restart', COMPOSITOR], function (restartErr) {
      if (restartErr) console.log('guidepatch: the compositor did not restart: ' + restartErr.message);
      cb({ ok: !restartErr, restarted: true, error: restartErr ? 'restart' : undefined });
    });
  });
}

module.exports = {
  init: init,
  status: status,
  apply: apply,
  validId: validId,
  MAX_ID: MAX_ID,
  BUILDS: BUILDS
};
