/*
 * lib/guidepatch.js - the remote's Guide key opening Glasshouse Home's guide
 * on webOS 11
 *
 * webOS 11's key filters are native: libappLaunch.so reads the configd value
 * com.webos.keyaction.tvGuide and launches its app with no launch parameters,
 * so Glasshouse Home cannot be told to open its guide, and with Home already
 * in front it launches nothing at all (isForegroundApp). Two changes in
 * LG's library give the key what it needs: the launch passes
 * {"glasshouse":"guide"} where it passed {}, and Home being in front no longer
 * ends the key. Each is a few bytes in the library's code and literals.
 *
 * Nothing of LG's is shipped: the library on the TV is read, checked against
 * the builds listed here by its SHA-256, changed in memory and written beside
 * Glasshouse's own files. The copy is bind mounted over LG's, which stays as
 * it is on the read-only rootfs, and the compositor (surface-manager), the
 * only process that loads it, is restarted once to read the copy. A restart of
 * the TV puts LG's back until the next start of Glasshouse. A build not listed
 * here is left alone.
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
var PATCHED_NAME = 'libappLaunch.so.1.glasshouse';
var EXEC_MS = 30000;

/*
 * The builds known to take the change, by the SHA-256 of LG's library. An
 * edit is the bytes at an offset as LG has them (was), and as they become
 * (now), both in hex: a library that differs anywhere an edit looks is refused.
 * The text is the launch parameters of the Guide key, with its end.
 */
var GUIDE_PARAMS = '7b22676c617373686f757365223a226775696465227d00';
var BUILDS = {
  '6a409d5c7eea92c56aca3894c2652595f2ed241df61267063c3feefecf37ca66': {
    tv: 'OLED48C31LA, webOS 11.2.0, firmware 44.00.92',
    patched: '7fd5f96a581341a0211b1e1ea32bc91bbde12725892d1824bbaf156ff4ee810e',
    edits: [
      // The Guide key's launch reads its parameters from a literal: now the text below, kept in unused padding.
      { at: 0x53958, was: new Array(24).join('00'), now: GUIDE_PARAMS },
      { at: 0x2fa9c, was: '66ce01', now: 'd64502' },
      // bne to the end of the key when the app to open is already in front: a nop.
      { at: 0x2f2a6, was: '7ff4d1ae', now: 'aff30080' }
    ]
  }
};

var library = LIBRARY;
var stateDir = '/var/lib/tvweb';
var execFn = execFile;
var cached = null;

function init(opts) {
  opts = opts || {};
  library = opts.library || LIBRARY;
  if (opts.stateDir) stateDir = opts.stateDir;
  execFn = opts.exec || execFile;
  cached = null;
}

function patchedFile() { return path.join(stateDir, PATCHED_NAME); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function hex(buf, at, length) { return buf.slice(at, at + length).toString('hex'); }

function buildOf(digest) {
  if (BUILDS.hasOwnProperty(digest)) return { id: digest, build: BUILDS[digest], applied: false };
  for (var id in BUILDS) {
    if (BUILDS.hasOwnProperty(id) && BUILDS[id].patched === digest) return { id: id, build: BUILDS[id], applied: true };
  }
  return null;
}

/*
 * What this TV's library is: { supported, applied, tv }. Read until it is
 * known to be unlisted or changed: a mount changes what is read.
 */
function status() {
  if (cached) return cached;
  var buf;
  try { buf = fs.readFileSync(library); } catch (e) { return { supported: false, applied: false }; }
  var found = buildOf(sha256(buf));
  var out = found ? { supported: true, applied: found.applied, tv: found.build.tv } : { supported: false, applied: false };
  if (!found || found.applied) cached = out;
  return out;
}

// The library with the build's edits, or an error where it is not what the edit expects.
function edited(buf, build) {
  var copy = util.allocBuffer(buf.length);
  buf.copy(copy);
  for (var i = 0; i < build.edits.length; i++) {
    var e = build.edits[i];
    var size = e.was.length / 2;
    if (hex(copy, e.at, size) !== e.was) return null;
    util.toBuffer(e.now, 'hex').copy(copy, e.at);
  }
  return sha256(copy) === build.patched ? copy : null;
}

function run(file, args, cb) {
  execFn(file, args, { timeout: EXEC_MS }, function (err) { cb(err || null); });
}

/*
 * Mounts the changed library over LG's, and restarts the compositor once to
 * read it. Where it is mounted already nothing is done. cb({ ok, restarted,
 * error }).
 */
function apply(cb) {
  var st = status();
  if (!st.supported) return cb({ ok: false, error: 'unsupported' });
  if (st.applied) return cb({ ok: true, restarted: false });
  var buf;
  try { buf = fs.readFileSync(library); } catch (e) { return cb({ ok: false, error: 'read' }); }
  var found = buildOf(sha256(buf));
  var copy = found && edited(buf, found.build);
  if (!copy) return cb({ ok: false, error: 'mismatch' });
  var file = patchedFile(), tmp = file + '.tmp';
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
    if (!status().applied) return cb({ ok: false, error: 'mount' });
    console.log('guidepatch: Guide opens Glasshouse Home\'s guide: the key handler is changed on ' + found.build.tv + ', restarting the compositor');
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
  BUILDS: BUILDS
};
