/*
 * lib/guidepatch.js - the remote's Guide, Input, Home and channel keys on
 * webOS 11, for Glasshouse Home's guide, an app or input of the owner's
 * choice, Glasshouse Bar, and a channel key of the owner's choosing
 *
 * webOS 11's key filters are native. libappLaunch.so reads the configd value
 * com.webos.keyaction.tvGuide and launches its app with no launch parameters,
 * so Glasshouse Home cannot be told to open its guide, and with Home already
 * in front it launches nothing at all (isForegroundApp). The Input key has no
 * value to read: the library opens LG's input picker, named in a text of its
 * own. The Home key, in libsystemUI.so, asks the application manager for the
 * default app of the category home, which is LG's Home whatever the settings
 * or the system profile say. A few bytes of those libraries' code and
 * literals give each key what it needs:
 *   guide  the launch passes {"glasshouse":"guide"} where it passed {}, and
 *          Home being in front no longer ends the key
 *   input  the text both of the input picker's launches pass, which names the
 *          picker, names the app or input chosen instead (an id of up to 30
 *          characters, as the text is 41 bytes long)
 *   bar    the Home key launches Glasshouse Bar's app, through the call that
 *          opens LG's settings for an always-on display, with its id and
 *          parameters changed
 *   channel  libpreProcess.so's first filter, which takes the keys the system
 *          profile lists, reads a list of Glasshouse's (BLOCK_PROFILE) in
 *          place of LG's, so the channel keys set reach nothing of LG's
 *
 * Nothing of LG's is shipped: a library on the TV is read, found to be a
 * build listed here by its SHA-256 with the places changed put back, changed
 * in memory and written beside Glasshouse's own files. The copy is bind
 * mounted over LG's, which stays as it is on the read-only rootfs, and the
 * compositor (surface-manager), the only process that loads them, is
 * restarted once to read the copies. A change is made only while its key is
 * set: setting it back mounts a copy without it in place of the last, and with
 * everything as LG has it nothing is mounted at all. Where the compositor does
 * not restart, the copies are taken off and it is restarted on LG's own. A
 * restart of the TV puts LG's libraries back until the next start of
 * Glasshouse. A build not listed here, or one changed anywhere else, is left
 * alone.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var util = require('./util');

var COMPOSITOR = 'surface-manager-daemon.service';
var COPY_PREFIX = 'libguidepatch-';
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
/*
 * native/keyfilter-log/channel-keys.s as native/keyfilter-log/build.py makes
 * it: code for the zeros after .eh_frame in libpreProcess.so that logs the
 * channel keys' presses, releases and every fourth repeat, so a held key is
 * seen as it repeats, a line every 200 ms.
 */
var CHANNEL_STUB = '70b582b0d9f82440d9f8285040f29216a41b012c26d8022d24d8134e7e44022d04d0002d08d10021316005e031684a1c' +
  '326011f0030f15d10ff2300001a9ebf7f0ef019870b104eb44042c440ff2400303eb44130ff218020ff22c0100910621' +
  'ebf740ef02b070bd481a00004c534d004e4c5f494e5055545f4b455946494c5445525f55534500000000bf00bf00bf00' +
  '7b22676c617373686f7573655f6b6579223a3430322c226576223a307d0000007b22676c617373686f7573655f6b6579' +
  '223a3430322c226576223a317d0000007b22676c617373686f7573655f6b6579223a3430322c226576223a327d000000' +
  '7b22676c617373686f7573655f6b6579223a3430332c226576223a307d0000007b22676c617373686f7573655f6b6579' +
  '223a3430332c226576223a317d0000007b22676c617373686f7573655f6b6579223a3430332c226576223a327d000000';
var GUIDE_PARAMS = '7b22676c617373686f757365223a226775696465227d00';
var LIBRARIES = {
  appLaunch: {
    file: '/usr/lib/libappLaunch.so.1',
    builds: {
      '6a409d5c7eea92c56aca3894c2652595f2ed241df61267063c3feefecf37ca66': {
        tv: 'OLED48C31LA, webOS 11.2.0, firmware 44.00.92',
        sets: {
          guide: [
            // The Guide key's launch reads its parameters from a literal: now the text below, kept in unused padding.
            { at: 0x53958, was: new Array(24).join('00'), now: GUIDE_PARAMS },
            { at: 0x2fa9c, was: '66ce01', now: 'd64502' },
            // bne to the end of the key when the app to open is already in front: a nop.
            { at: 0x2f2a6, was: '7ff4d1ae', now: 'aff30080' }
          ]
        },
        picker: { at: 0x4e724, was: '7b226964223a2022636f6d2e7765626f732e6170702e717569636b696e7075747069636b6572227d00' }
      }
    }
  },
  systemUI: {
    file: '/usr/lib/libsystemUI.so.1',
    builds: {
      '7a5d1576cf6686a6e6a8beb61bddaec496bc726e5abdae3bd4e90325b9fce736': {
        tv: 'OLED48C31LA, webOS 11.2.0, firmware 44.00.92',
        sets: {
          bar: [
            // launchHomeApp: where it builds the call to the default app of the category home, a call
            // to the function after it (bl) and a jump to its end (b.w). That function launches
            // LG's settings for an always-on display, by an id of 21 characters and parameters of 29.
            { at: 0xc9da, was: '3046f9f7c8e9b149', now: '00f08ff900f050b8' },
            // Its id and its parameters are shorter now, the lengths made 17 and 20 and the text
            // read from the padding after .eh_frame, where the literals point.
            { at: 0xcd2a, was: '15', now: '11' },
            { at: 0xcd35, was: '75', now: '74' },
            { at: 0xcd62, was: '1d2380f81d', now: '142380f814' },
            { at: 0xce48, was: '228301000483', now: 'd6ea0100c0ea' },
            { at: 0x2b810, was: '0000000000000000000000000000000000', now: '636f6d2e74767765622e686f6d65626172' },
            { at: 0x2b830, was: '0000000000000000000000000000000000000000', now: '7b22676c617373686f757365223a22626172227d' },
            // handleHomeKeys: with the home app already in front, the key goes to that app and nothing is
            // launched (the id in front equals the home app's: beq to the end). A nop, so LG's Home
            // in front opens the bar as any other app does.
            { at: 0x18ab2, was: '3ff4d8aa', now: 'aff30080' }
          ]
        }
      }
    }
  },
  preProcess: {
    file: '/usr/lib/libpreProcess.so.1',
    builds: {
      'cd34040641bd737db5da2bc198713def8cf1010d6bfbd85221b687a46752b867': {
        tv: 'OLED48C54LA, webOS 11.2.0, firmware 43.21.77',
        sets: {
          channel: [
            // handleKeyBlockByApp takes every key named in the system profile's blockedKeys, which
            // the profile generator works out from LG's own feature files and nothing else can add
            // to. The name it reads in getProfiles' answer and the one it asks for become
            // BLOCK_PROFILE, a value Glasshouse's override file sets.
            { at: 0x152a8, was: '626c6f636b65644b657973', now: '7476776562426c6f636b73' },
            { at: 0x1533f, was: '626c6f636b65644b657973', now: '7476776562426c6f636b73' },
            // A key found in the list shows LG's "This button is not available" toast (createToast
            // with message 0x2b) before it is taken, at every event of the key. That call (blx), whose
            // result nothing reads, is a bl to CHANNEL_STUB instead, which logs the event.
            { at: 0xb7b8, was: 'f8f748ef', now: '0df04ef8' },
            { at: 0x18858, was: new Array(CHANNEL_STUB.length / 2 + 1).join('00'), now: CHANNEL_STUB }
          ]
        }
      }
    }
  }
};

/*
 * The keys the changed key filter takes, by Linux key code, as a value of the
 * system profile's: an override file read by LG's profile generator, which
 * copies a value it does not know into the profile as it is. The filter asks
 * for it once, as it loads, so a change takes a restart of the compositor.
 */
var BLOCK_PROFILE = 'tvwebBlocks';
var PROFILE_OVERRIDE_DIR = '/var/webos-profile/override';
var PROFILE_OVERRIDE_FILE = 'glasshouse_keys.json';
// How long the profile service is given to read the file again, asked every PROFILE_POLL_MS.
var PROFILE_WAIT_MS = 6000;
var PROFILE_POLL_MS = 500;

var files = {};
var stateDir = '/var/lib/tvweb';
var execFn = execFile;
// Where the mounts are read from, and how many of our mounts sit on a library where a test passes its own count.
var mountInfoFile = '/proc/self/mountinfo';
var mountsFn = null;
var cached = null;
var copyNumber = 0;
var lunaFn = null;
var overrideDir = PROFILE_OVERRIDE_DIR;
var profileWaitMs = PROFILE_WAIT_MS;
var profilePollMs = PROFILE_POLL_MS;

function init(opts) {
  opts = opts || {};
  files = {
    appLaunch: opts.library || LIBRARIES.appLaunch.file,
    systemUI: opts.systemUiLibrary || LIBRARIES.systemUI.file,
    preProcess: opts.preProcessLibrary || LIBRARIES.preProcess.file
  };
  if (opts.stateDir) stateDir = opts.stateDir;
  execFn = opts.exec || execFile;
  mountInfoFile = opts.mountInfo || '/proc/self/mountinfo';
  mountsFn = opts.mounts || null;
  lunaFn = opts.luna || null;
  overrideDir = opts.profileOverrideDir || PROFILE_OVERRIDE_DIR;
  profileWaitMs = typeof opts.profileWaitMs === 'number' ? opts.profileWaitMs : PROFILE_WAIT_MS;
  profilePollMs = typeof opts.profilePollMs === 'number' ? opts.profilePollMs : PROFILE_POLL_MS;
  cached = null;
}
init();


function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function hex(buf, at, length) { return buf.slice(at, at + length).toString('hex'); }

function copyOf(buf) {
  var copy = util.allocBuffer(buf.length);
  buf.copy(copy);
  return copy;
}

function put(buf, at, hexText) { util.toBuffer(hexText, 'hex').copy(buf, at); }

// The text the Input key's launches pass for an app or input, padded with zeros to the length of LG's.
// 'binary' as node 0.12 has no 'latin1'.
function pickerText(build, id) {
  var size = build.picker.was.length / 2;
  var text = '{"id": "' + id + '"}';
  while (text.length < size) text += '\0';
  return util.toBuffer(text, 'binary');
}

// Whether a library has all of a set's changes (true), none (false), or some or other bytes (null).
function setState(buf, edits) {
  var on = 0, off = 0;
  edits.forEach(function (e) {
    var current = hex(buf, e.at, e.was.length / 2);
    if (current === e.now) on++;
    else if (current === e.was) off++;
  });
  if (on === edits.length) return true;
  if (off === edits.length) return false;
  return null;
}

// The id the Input key opens, '' for LG's picker, or null where the text is neither.
function pickerState(buf, build) {
  var size = build.picker.was.length / 2;
  if (hex(buf, build.picker.at, size) === build.picker.was) return '';
  var m = PICKER_TEXT_RE.exec(buf.slice(build.picker.at, build.picker.at + size).toString('binary'));
  return m ? m[1] : null;
}

// Whether every place a build changes is inside the library: a shorter one is another build, and node 0.10 refuses a copy past its end.
function reaches(buf, build) {
  var ends = [];
  Object.keys(build.sets).forEach(function (name) {
    build.sets[name].forEach(function (e) { ends.push(e.at + e.was.length / 2); });
  });
  if (build.picker) ends.push(build.picker.at + build.picker.was.length / 2);
  return Math.max.apply(null, ends) <= buf.length;
}

/*
 * The build a library is, with what it has changed, or null: its changed
 * places put back must hash to a listed build.
 */
function buildOf(name, buf) {
  var builds = LIBRARIES[name].builds;
  for (var id in builds) {
    if (!builds.hasOwnProperty(id)) continue;
    var build = builds[id];
    if (!reaches(buf, build)) continue;
    var plain = copyOf(buf);
    Object.keys(build.sets).forEach(function (set) {
      build.sets[set].forEach(function (e) { put(plain, e.at, e.was); });
    });
    if (build.picker) put(plain, build.picker.at, build.picker.was);
    if (sha256(plain) !== id) continue;
    var on = {}, bad = false;
    Object.keys(build.sets).forEach(function (set) {
      on[set] = setState(buf, build.sets[set]);
      if (on[set] === null) bad = true;
    });
    if (build.picker) {
      on.input = pickerState(buf, build);
      if (on.input === null) bad = true;
    }
    return bad ? null : { id: id, build: build, on: on };
  }
  return null;
}

// A library as it is on the TV, with its build, or null.
function read(name) {
  var buf;
  try { buf = fs.readFileSync(files[name]); } catch (e) { return null; }
  var found = buildOf(name, buf);
  return found ? { buf: buf, found: found } : null;
}

/*
 * What this TV's libraries are: { supported, bar, applied: { guide, input,
 * bar }, tv }. supported says the Guide and Input keys can be changed (the
 * key handler is a listed build), bar that the Home key can, with input the id
 * the Input key opens, or ''. Read once, then again after a change.
 */
function status() {
  if (cached) return cached;
  var app = read('appLaunch'), ui = read('systemUI'), pre = read('preProcess');
  var any = app || ui || pre;
  cached = {
    supported: !!app,
    bar: !!ui,
    channel: !!pre,
    applied: {
      guide: !!(app && app.found.on.guide),
      input: app ? app.found.on.input : '',
      bar: !!(ui && ui.found.on.bar),
      blocked: pre && pre.found.on.channel ? readBlocked() : []
    },
    tv: any ? any.found.build.tv : ''
  };
  return cached;
}

function overridePath() { return path.join(overrideDir, PROFILE_OVERRIDE_FILE); }

// The key codes the override file names, sorted, or [] without one.
function readBlocked() {
  try {
    var j = JSON.parse(fs.readFileSync(overridePath(), 'utf8'));
    return normalCodes(j && j[BLOCK_PROFILE]);
  } catch (e) {
    return [];
  }
}

// Whole key codes, each once, in order.
function normalCodes(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (c) {
    if (typeof c === 'number' && c > 0 && Math.floor(c) === c && out.indexOf(c) === -1) out.push(c);
  });
  return out.sort(function (a, b) { return a - b; });
}

function sameCodes(a, b) { return a.join(',') === b.join(','); }

/*
 * The override file written with these codes, or removed for none, and the
 * profile service told to read its files again; cb(ok) once the profile
 * holds them. The generator copies BLOCK_PROFILE as it is (a C5, webOS 11.2.0).
 */
function writeBlocked(codes, cb) {
  try {
    if (codes.length) {
      var body = {};
      body[BLOCK_PROFILE] = codes;
      util.mkdirp(overrideDir);
      fs.writeFileSync(overridePath() + '.tmp', JSON.stringify(body));
      fs.renameSync(overridePath() + '.tmp', overridePath());
    } else {
      util.unlinkQuiet(overridePath());
    }
  } catch (e) {
    return cb(false);
  }
  if (!lunaFn) return cb(false);
  lunaFn('com.webos.service.systemprofile/debug/rescan', {}, function () {
    waitForProfile(codes, Date.now() + profileWaitMs, cb);
  });
}

function waitForProfile(codes, until, cb) {
  lunaFn('com.webos.service.systemprofile/getProfiles', { names: [BLOCK_PROFILE] }, function (r) {
    var value = r && r.profiles ? r.profiles[BLOCK_PROFILE] : undefined;
    // With no file the name is gone from the profile, or an empty list.
    if (sameCodes(normalCodes(value), codes)) return cb(true);
    if (Date.now() >= until) return cb(false);
    setTimeout(function () { waitForProfile(codes, until, cb); }, profilePollMs);
  });
}

// Whether an id can be put in the Input key's text.
function validId(id) { return ID_RE.test(String(id || '')); }

function run(file, args, cb) {
  execFn(file, args, { timeout: EXEC_MS }, function (err) { cb(err || null); });
}

// The libraries are links to the files /proc names.
function realPath(file) { try { return fs.realpathSync(file); } catch (e) { return file; } }

/*
 * The mounts made from copies of ours, { name, target }, a copy removed from
 * the disk still counting (mountinfo's root then ends in "//deleted"). A
 * mount over a mount whose file is gone fails with ENOENT, and a copy still
 * mounted is never removed.
 */
function mountedCopies() {
  var text = '';
  try { text = fs.readFileSync(mountInfoFile, 'utf8'); } catch (e) { return []; }
  var out = [];
  text.split('\n').forEach(function (line) {
    var f = line.split(' ');
    if (f.length < 5) return;
    var name = path.basename(f[3].replace(/\/\/deleted$/, ''));
    if (name.indexOf(COPY_PREFIX) === 0) out.push({ name: name, target: f[4] });
  });
  return out;
}

// How many of our mounts sit on a library (a test passes its own count).
function mountsOn(file) {
  if (mountsFn) return mountsFn(file);
  var target = realPath(file);
  return mountedCopies().filter(function (m) { return m.target === target; }).length;
}

/*
 * Every copy mounted over a library taken off, so they do not pile up one on
 * another and a dead one does not block the next. Lazily: the compositor
 * still has the copy open until it restarts. cb(err).
 */
function unmountAll(file, cb) {
  (function next(left) {
    if (left <= 0) { cached = null; return cb(null); }
    run('umount', ['-l', realPath(file)], function (err) {
      if (err) { cached = null; return cb(err); }
      next(left - 1);
    });
  })(mountsOn(file));
}

function restartCompositor(cb) {
  run('systemctl', ['restart', COMPOSITOR], cb);
}

// The copies of an earlier change, which nothing needs once another is mounted over them. A copy still mounted (the other library's) stays, as its mount would go dead.
function dropOldCopies(keep) {
  var mounted = mountedCopies().map(function (m) { return m.name; });
  try {
    fs.readdirSync(stateDir).forEach(function (f) {
      if (f.indexOf(COPY_PREFIX) === 0 && keep.indexOf(f) === -1 && mounted.indexOf(f) === -1) util.unlinkQuiet(path.join(stateDir, f));
    });
  } catch (e) {}
}

// The library with the changes wanted, written under a name of its own, or null. A name of its own each time: a copy mounted earlier cannot be written over.
function writeCopy(name, found, buf, want) {
  var copy = copyOf(buf), build = found.build;
  Object.keys(build.sets).forEach(function (set) {
    build.sets[set].forEach(function (e) { put(copy, e.at, want[set] ? e.now : e.was); });
  });
  if (build.picker) (want.input ? pickerText(build, want.input) : util.toBuffer(build.picker.was, 'hex')).copy(copy, build.picker.at);
  var file = COPY_PREFIX + name + '-' + Date.now().toString(36) + (++copyNumber).toString(36);
  var full = path.join(stateDir, file), tmp = full + '.tmp';
  try {
    util.mkdirp(stateDir);
    fs.writeFileSync(tmp, copy, { mode: parseInt('755', 8) });
    fs.renameSync(tmp, full);
  } catch (e) {
    return null;
  }
  return { file: file, full: full };
}

// Whether a library's wanted changes are none: LG's own is used then.
function isPlain(name, want) {
  if (name === 'appLaunch') return !want.guide && !want.input;
  if (name === 'preProcess') return !want.channel;
  return !want.bar;
}

// Every library's copies taken off, one after another. cb().
function unmountEvery(cb) {
  var names = Object.keys(files);
  (function next(i) {
    if (i === names.length) return cb();
    unmountAll(files[names[i]], function () { next(i + 1); });
  })(0);
}

/*
 * Mounts the libraries with the changes wanted ({ guide: whether, input: an
 * id or '', bar: whether, blocked: key codes }) over LG's, and restarts the
 * compositor once to read them. Where they are as wanted already nothing is
 * done. cb({ ok, restarted, error }).
 */
function apply(want, cb) {
  var st = status();
  var input = want.input || '';
  if (input && !validId(input)) return cb({ ok: false, error: 'id' });
  var blocked = normalCodes(want.blocked);
  var wantApp = { guide: !!want.guide, input: input }, wantUi = { bar: !!want.bar }, wantPre = { channel: blocked.length > 0 };
  var needApp = wantApp.guide || !!input || st.applied.guide || !!st.applied.input;
  var needUi = wantUi.bar || st.applied.bar;
  var needPre = wantPre.channel || st.applied.blocked.length > 0;
  if ((needApp && !st.supported) || (needUi && !st.bar) || (needPre && !st.channel)) return cb({ ok: false, error: 'unsupported' });
  var jobs = [];
  if (st.supported && (!!st.applied.guide !== wantApp.guide || st.applied.input !== input)) jobs.push({ name: 'appLaunch', want: wantApp });
  if (st.bar && !!st.applied.bar !== wantUi.bar) jobs.push({ name: 'systemUI', want: wantUi });
  var patched = st.applied.blocked.length > 0;
  if (st.channel && patched !== wantPre.channel) jobs.push({ name: 'preProcess', want: wantPre });
  // The filter reads the list as it loads: other keys with it changed still take a restart.
  var listChanged = !sameCodes(readBlocked(), blocked);
  var restartForList = listChanged && wantPre.channel;
  if (!jobs.length && !restartForList) {
    // A list nothing reads any more, left by a change that failed half way.
    if (listChanged) writeBlocked(blocked, function () {});
    return cb({ ok: true, restarted: false });
  }
  if (listChanged) {
    return writeBlocked(blocked, function (ok) {
      if (!ok) return cb({ ok: false, error: 'profile' });
      mountJobs(st, jobs, { app: wantApp, ui: wantUi, blocked: blocked }, cb);
    });
  }
  mountJobs(st, jobs, { app: wantApp, ui: wantUi, blocked: blocked }, cb);
}

// apply()'s mounts, then the restart. wanted: { app, ui, blocked } as asked.
function mountJobs(st, jobs, wanted, cb) {
  var wantApp = wanted.app, wantUi = wanted.ui, input = wantApp.input;
  var kept = [];
  // Not restarted on the copies: they are taken off, and the compositor restarted on LG's own.
  function fallBack(restartErr, done) {
    console.log('guidepatch: the compositor did not restart (' + restartErr.message + '), putting LG\'s key handlers back');
    unmountEvery(function () {
      restartCompositor(function (againErr) {
        if (againErr) console.log('guidepatch: the compositor did not restart on LG\'s key handlers either: ' + againErr.message);
        done();
      });
    });
  }
  (function next(i) {
    if (i === jobs.length) {
      cached = null;
      var after = status();
      var right = (!st.supported || (!!after.applied.guide === wantApp.guide && after.applied.input === input)) &&
        (!st.bar || !!after.applied.bar === wantUi.bar) &&
        (!st.channel || sameCodes(after.applied.blocked, wanted.blocked));
      if (!right) return cb({ ok: false, error: 'mount' });
      dropOldCopies(kept);
      var changed = after.applied.guide || !!after.applied.input || after.applied.bar || after.applied.blocked.length > 0;
      console.log('guidepatch: the key handlers are ' + (changed ? 'changed' : 'LG\'s again') + ' on ' + (after.tv || st.tv) + ', restarting the compositor');
      return restartCompositor(function (restartErr) {
        if (!restartErr) return cb({ ok: true, restarted: true });
        fallBack(restartErr, function () { cb({ ok: false, restarted: true, error: 'restart' }); });
      });
    }
    var job = jobs[i], current = read(job.name);
    if (!current) return cb({ ok: false, error: 'mismatch' });
    // Everything as LG has it: no copy at all, LG's own library again.
    if (isPlain(job.name, job.want)) {
      return unmountAll(files[job.name], function (offErr) {
        if (offErr) return cb({ ok: false, error: 'mount' });
        next(i + 1);
      });
    }
    var copy = writeCopy(job.name, current.found, current.buf, job.want);
    if (!copy) return cb({ ok: false, error: 'write' });
    // The copies before taken off first: mounts would otherwise pile up one on another.
    unmountAll(files[job.name], function (offErr) {
      if (offErr) return cb({ ok: false, error: 'mount' });
      run('mount', ['--bind', copy.full, files[job.name]], function (mountErr) {
        if (mountErr) return cb({ ok: false, error: 'mount' });
        kept.push(copy.file);
        cached = null;
        next(i + 1);
      });
    });
  })(0);
}

// Whether Glasshouse's override file is on the TV, for putting everything back.
function holdsKeys() { return fs.existsSync(overridePath()); }

module.exports = {
  init: init,
  status: status,
  apply: apply,
  holdsKeys: holdsKeys,
  validId: validId,
  MAX_ID: MAX_ID,
  LIBRARIES: LIBRARIES
};
