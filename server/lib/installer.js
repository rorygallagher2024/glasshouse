/**
 * installer.js - Install an .ipk package on the TV: stage, verify, inspect,
 * preview, install through the developer install service, optionally elevate.
 *
 * One job at a time. The package is never buffered or unpacked to disk: it is
 * read as a stream and only the few bytes that matter are kept.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4 (LG OLED B8).
 */

var msg = require('./say').msg;
var fs = require('fs');
var mkdirp = require('./util').mkdirp;
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var childProcess = require('child_process');

var DEFAULT_CAPS = {
  controlBytes: 1024 * 1024,
  appinfoBytes: 64 * 1024,
  entries: 20000,
  dataBytes: 2 * 1024 * 1024 * 1024,
  uploadBytes: 512 * 1024 * 1024
};

// Package ids of the Homebrew Channel and of this dashboard's own HBC package.
// dev/install SIGKILLs a package's services and rewrites its files, which for
// these two drops root, so they update themselves instead.
var SELF_UPDATING = ['org.webosbrew.hbchannel', 'io.github.rorygallagher2024.lg-webos-dashboard'];
var SYSTEM_PREFIXES = ['com.webos.', 'com.palm.', 'com.lge.'];
var UNFINISHED = { downloading: 1, verifying: 1, 'awaiting-confirm': 1, installing: 1, elevating: 1 };
// An open preview only holds a staged file; what must not be interrupted is
// work in progress.
var WORKING = { downloading: 1, verifying: 1, installing: 1, elevating: 1 };
var GZIP_MIN = 18;
var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
var VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+~:_-]{0,63}$/;
var ELF_MACHINES = { 3: 'x86', 8: 'mips', 40: 'arm', 62: 'x86_64', 183: 'aarch64', 243: 'riscv' };

var lunaFn = null;
/** @type {typeof import('./apps')} */
var appsMod = null;
/** @type {typeof import('./fetch')} */
var fetchMod = null;
/** @type {Object.<string, number>} */
var caps = DEFAULT_CAPS;
var stateDir = '/var/lib/tvweb';
var stagingDir = '/media/developer/temp/glasshouse-install';
var lunaSendPath = process.env.TVWEB_LUNA_SEND || '/usr/bin/luna-send';
var elevatePath = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service';
var storeAppsDir = '/media/cryptofs/apps/usr/palm/applications';
var dfPath = 'df';
var tvMachine = null;
var updaterBusy = function () { return false; };
// Told when an install finishes, so the app list is read again at once.
var onInstalled = function () {};
var previewMs = 10 * 60 * 1000;
var installTimeoutMs = 120000;
var elevateTimeoutMs = 60000;

var job = null;
// An upload is streaming into the staging directory; a job's cleanup must not touch it.
var uploadHeld = 0;
var UPLOAD_HOLD_MS = 30 * 60 * 1000;
var installChild = null;
var exitHooked = false;

function noop() {}

function allocBuf(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}

function errText(e) {
  return (e && e.message) || String(e || '') || unknownError();
}

// A failure with text the page may show, thrown through the walkers.
function reject(text) {
  /** @type {any} */
  var e = new Error(text);
  e.userMessage = text;
  return e;
}

function userText(e, fallback) {
  return (e && e.userMessage) || fallback;
}

function unreadable(e) {
  return msg('srv.install.ipk.unreadable', 'the ipk could not be read: {error}', { error: errText(e) });
}

function unknownError() {
  return msg('srv.install.unknownError', 'unknown error');
}

function installFailed(text) {
  return msg('srv.install.failed', 'the install failed: {error}', { error: text });
}

function noSpace(need, free) {
  return msg('srv.install.noSpace', 'not enough free space: {need} needed, {free} free', { need: formatMb(need), free: formatMb(free) });
}

function tooBig() {
  return msg('srv.install.tooBig', 'the package is larger than the {limit} limit', { limit: formatMb(caps.uploadBytes) });
}

// Why nothing else may start now, or null.
function busyText() {
  if (isBusy()) return msg('srv.install.busy', 'an install is already in progress');
  if (updaterBusy()) return msg('srv.install.busy.updater', 'a dashboard update is running; install when it has finished');
  return null;
}

function formatMb(n) {
  return (Math.round(n / 104857.6) / 10) + ' MB';
}

/* ---------------------------------------------------------------- ELF */

function machineName(buf) {
  if (buf.length < 20 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return null;
  var code = buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
  return ELF_MACHINES[code] || ('e_machine ' + code);
}

// The TV's own CPU is read from one of its binaries, not uname: some models
// report aarch64 with a 32-bit armhf userspace.
function detectTvMachine() {
  var files = [lunaSendPath, process.execPath];
  for (var i = 0; i < files.length; i++) {
    try {
      var fd = fs.openSync(files[i], 'r');
      var b = allocBuf(20);
      var n = fs.readSync(fd, b, 0, 20, 0);
      fs.closeSync(fd);
      var m = n === 20 ? machineName(b) : null;
      if (m) return m;
    } catch (e) {}
  }
  return null;
}

/* ---------------------------------------------------------------- tar */

function octal(buf, from, to) {
  var s = buf.toString('binary', from, to).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) return NaN;
  return parseInt(s, 8);
}

function cString(buf, from, to) {
  var end = from;
  while (end < to && buf[end] !== 0) end++;
  return buf.toString('binary', from, end);
}

/*
 * Package-relative path with no leading "./" and no "..". Returns null for
 * anything that could leave the package root.
 */
function cleanPath(name) {
  var segs = String(name).split('/');
  var out = [];
  for (var i = 0; i < segs.length; i++) {
    if (segs[i] === '' || segs[i] === '.') continue;
    if (segs[i] === '..') return null;
    out.push(segs[i]);
  }
  if (name.charAt(0) === '/') return null;
  return out;
}

/*
 * Walks tar headers in a stream of chunks, handing each entry to onEntry,
 * which returns how many leading body bytes to keep (0 for none), and kept
 * bodies to onFile. Throws reject() errors on anything it will not read.
 */
function tarWalker(maxEntries, onEntry, onFile) {
  var hdr = allocBuf(512);
  var hdrLen = 0;
  var mode = 'header';          // header | body | pad | end
  var entries = 0;
  var entry = null, left = 0, padLeft = 0, keep = null, keepLen = 0, junk = false;

  function zeroBlock() {
    for (var i = 0; i < 512; i++) if (hdr[i] !== 0) return false;
    return true;
  }

  function header() {
    if (zeroBlock()) { mode = 'end'; return; }
    var sum = 0, i;
    for (i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : hdr[i];
    if (sum !== octal(hdr, 148, 156)) {
      throw reject(msg('srv.install.ipk.badTar', 'the ipk holds a damaged package archive'));
    }
    if (++entries > maxEntries) {
      throw reject(msg('srv.install.ipk.tooMany', 'the ipk holds too many files'));
    }
    var type = String.fromCharCode(hdr[156] || 48);
    // Long names and extended attributes would need parsing that decides
    // which path an entry really has; refusing them is safer than guessing.
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g' || type === 'X' ||
        (hdr[124] & 0x80)) {
      throw reject(msg('srv.install.ipk.unsupported', 'the ipk uses a file format this installer does not read'));
    }
    var size = octal(hdr, 124, 136);
    if (isNaN(size)) {
      throw reject(msg('srv.install.ipk.badTar', 'the ipk holds a damaged package archive'));
    }
    var name = cString(hdr, 0, 100);
    if (cString(hdr, 257, 262) === 'ustar') {
      var prefix = cString(hdr, 345, 500);
      if (prefix) name = prefix + '/' + name;
    }
    entry = { name: name, type: type, size: size, link: cString(hdr, 157, 257) };
    var want = onEntry(entry);
    keepLen = 0;
    keep = want > 0 ? allocBuf(want) : null;
    left = size;
    padLeft = (512 - size % 512) % 512;
    if (left === 0) bodyDone(); else mode = 'body';
  }

  function bodyDone() {
    if (keep) onFile(entry, keep);
    keep = null;
    mode = padLeft ? 'pad' : 'header';
  }

  return {
    push: function (chunk) {
      var pos = 0, n;
      while (pos < chunk.length) {
        if (mode === 'end') {
          // Nothing but zero bytes may follow the end-of-archive blocks; a
          // reader that stops here must not hide a second archive.
          for (var z = pos; z < chunk.length; z++) {
            if (chunk[z] !== 0) { junk = true; break; }
          }
          return;
        }
        if (mode === 'header') {
          n = Math.min(512 - hdrLen, chunk.length - pos);
          chunk.copy(hdr, hdrLen, pos, pos + n);
          hdrLen += n; pos += n;
          if (hdrLen === 512) { hdrLen = 0; header(); }
        } else if (mode === 'body') {
          n = Math.min(left, chunk.length - pos);
          if (keep && keepLen < keep.length) {
            var take = Math.min(n, keep.length - keepLen);
            chunk.copy(keep, keepLen, pos, pos + take);
            keepLen += take;
          }
          left -= n; pos += n;
          if (left === 0) bodyDone();
        } else {
          n = Math.min(padLeft, chunk.length - pos);
          padLeft -= n; pos += n;
          if (padLeft === 0) mode = 'header';
        }
      }
    },
    finish: function () {
      if (junk) {
        throw reject(msg('srv.install.ipk.badTar', 'the ipk holds a damaged package archive'));
      }
      if (mode === 'body' || mode === 'pad' || (mode === 'header' && hdrLen > 0)) {
        throw reject(msg('srv.install.ipk.truncated', 'the ipk is truncated'));
      }
    }
  };
}

/*
 * Gunzips region [start, start+len) of the file into a walker, stopping with
 * an error once more than cap bytes come out.
 */
function streamTar(file, start, len, cap, walker, cb) {
  var finished = false, total = 0;
  var rs = fs.createReadStream(file, { start: start, end: start + len - 1 });
  var gz = zlib.createGunzip();

  function done(err) {
    if (finished) return;
    finished = true;
    try { rs.unpipe(gz); } catch (e) {}
    try { if (rs.destroy) rs.destroy(); } catch (e2) {}
    gz.removeAllListeners('data');
    gz.on('error', noop);
    cb(err);
  }

  rs.on('error', function (e) {
    done(reject(unreadable(e)));
  });
  gz.on('error', function () {
    done(reject(msg('srv.install.ipk.truncated', 'the ipk is truncated')));
  });
  gz.on('data', function (chunk) {
    if (finished) return;
    total += chunk.length;
    if (total > cap) {
      return done(reject(msg('srv.install.ipk.tooBig', 'the ipk unpacks to more than it may')));
    }
    try { walker.push(chunk); } catch (e) { done(e); }
  });
  gz.on('end', function () {
    if (finished) return;
    try { walker.finish(); } catch (e) { return done(e); }
    done(null);
  });
  rs.pipe(gz);
}

/* ----------------------------------------------------------------- ar */

function readAt(fd, pos, len, cb) {
  var buf = allocBuf(len), got = 0;
  (function next() {
    if (got >= len) return cb(null, buf);
    fs.read(fd, buf, got, len - got, pos + got, function (err, n) {
      if (err) return cb(err);
      if (n === 0) return cb(reject(msg('srv.install.ipk.truncated', 'the ipk is truncated')));
      got += n;
      next();
    });
  })();
}

/*
 * Reads the ar members: exactly debian-binary, control.tar.gz and
 * data.tar.gz, each once, each wholly inside the file.
 */
function readMembers(fd, fileSize, cb) {
  var members = {}, count = 0;
  var allowed = { 'debian-binary': 1, 'control.tar.gz': 1, 'data.tar.gz': 1 };
  var notAr = reject(msg('srv.install.ipk.notAr', 'the file is not an ipk archive'));

  readAt(fd, 0, 8, function (err, magic) {
    if (err) return cb(fileSize < 8 ? notAr : err);
    if (magic.toString('binary') !== '!<arch>\n') return cb(notAr);
    var pos = 8;
    (function next() {
      if (pos === fileSize) {
        if (!members['control.tar.gz'] || !members['data.tar.gz'] || !members['debian-binary']) {
          return cb(reject(msg('srv.install.ipk.parts', 'the ipk is missing a part')));
        }
        return cb(null, members);
      }
      if (pos + 60 > fileSize) return cb(reject(msg('srv.install.ipk.truncated', 'the ipk is truncated')));
      readAt(fd, pos, 60, function (err2, h) {
        if (err2) return cb(err2);
        var name = h.toString('binary', 0, 16).replace(/ +$/, '').replace(/\/$/, '');
        var sizeText = h.toString('binary', 48, 58).replace(/ +$/, '');
        if (h.toString('binary', 58, 60) !== '`\n' || !/^\d{1,12}$/.test(sizeText)) return cb(notAr);
        var size = parseInt(sizeText, 10);
        if (!allowed[name] || members[name] || ++count > 3) {
          return cb(reject(msg('srv.install.ipk.member', 'the ipk holds an unexpected part: {name}', { name: name.slice(0, 40) })));
        }
        var body = pos + 60;
        if (body + size > fileSize) return cb(reject(msg('srv.install.ipk.truncated', 'the ipk is truncated')));
        // A gzip stream is at least 18 bytes; reading an empty region would
        // ask the file stream for end < start, which throws inside node.
        if (name !== 'debian-binary' && size < GZIP_MIN) {
          return cb(reject(msg('srv.install.ipk.badTar', 'the ipk holds a damaged package archive')));
        }
        members[name] = { start: body, size: size };
        // Members are padded to an even length; a last member may omit it.
        pos = body + size + (size % 2);
        if (pos > fileSize) pos = fileSize;
        next();
      });
    })();
  });
}

/* ------------------------------------------------------------ inspect */

function parseControl(text) {
  var out = {};
  var lines = String(text).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*?)\s*$/.exec(lines[i]);
    if (m && out[m[1]] === undefined) out[m[1]] = m[2];
  }
  return out;
}

function short(v, n) {
  return typeof v === 'string' ? v.slice(0, n || 200) : '';
}

/*
 * A link is accepted only inside usr/palm/{applications,services}/<id>/, at
 * least one level below it, and only when its target stays in that <id>
 * directory. A symlink target is relative to the link's directory, a hard
 * link target to the package root.
 */
function linkInsideOwnId(segs, type, target) {
  if (segs.length < 5 || segs[0] !== 'usr' || segs[1] !== 'palm') return false;
  if (segs[2] !== 'applications' && segs[2] !== 'services') return false;
  if (!NAME_RE.test(segs[3])) return false;
  if (typeof target !== 'string' || target.charAt(0) === '/') return false;
  var parts = target.split('/');
  var out = type === '2' ? segs.slice(0, -1) : [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '' || parts[i] === '.') continue;
    if (parts[i] === '..') { if (!out.length) return false; out.pop(); } else out.push(parts[i]);
  }
  if (out.length < 4) return false;
  for (var k = 0; k < 4; k++) if (out[k] !== segs[k]) return false;
  return true;
}

function inspectData(file, member, cb) {
  var apps = {}, appOrder = [], services = [], machines = [];

  function addApp(id) {
    if (!apps[id]) { apps[id] = { id: id, title: id, version: '', icon: null }; appOrder.push(id); }
    return apps[id];
  }

  var links = {};   // joined paths of the link entries seen so far

  var walker = tarWalker(caps.entries, function (e) {
    var segs = cleanPath(e.name);
    if (!segs) {
      throw reject(msg('srv.install.ipk.unsafePath', 'the ipk holds an unsafe path: {path}', { path: short(e.name, 80) }));
    }
    // The rules below look at names, so an entry reached through an earlier
    // link would land somewhere they never saw.
    for (var n = 1; n <= segs.length; n++) {
      if (links['/' + segs.slice(0, n).join('/')]) {
        throw reject(msg('srv.install.ipk.unsafePath', 'the ipk holds an unsafe path: {path}', { path: short(e.name, 80) }));
      }
    }
    if (e.type === '1' || e.type === '2') {
      if (!linkInsideOwnId(segs, e.type, e.link)) {
        throw reject(msg('srv.install.ipk.unsafePath', 'the ipk holds an unsafe path: {path}', { path: short(e.name, 80) }));
      }
      links['/' + segs.join('/')] = true;
    } else if (e.type !== '0' && e.type !== '5') {
      throw reject(msg('srv.install.ipk.unsupported', 'the ipk uses a file format this installer does not read'));
    }
    var regular = e.type === '0';
    if (segs[0] !== 'usr' || segs[1] !== 'palm' || !segs[3]) return 0;
    if (segs[2] !== 'applications' && segs[2] !== 'services') return 0;
    if (!NAME_RE.test(segs[3])) {
      throw reject(msg('srv.install.ipk.unsafePath', 'the ipk holds an unsafe path: {path}', { path: short(e.name, 80) }));
    }
    if (segs[2] === 'services') {
      if (services.indexOf(segs[3]) < 0) services.push(segs[3]);
      if (regular && segs.length >= 5 && e.size >= 20) { e.tag = 'elf'; return 20; }
      return 0;
    }
    addApp(segs[3]);
    if (regular && segs.length === 5 && segs[4] === 'appinfo.json') {
      if (e.size > caps.appinfoBytes) {
        throw reject(msg('srv.install.ipk.badAppinfo', 'the ipk holds an unreadable appinfo.json for {id}', { id: segs[3] }));
      }
      e.tag = 'appinfo';
      e.appId = segs[3];
      return e.size;
    }
    if (regular && segs.length >= 6 && segs[4] === 'bin' && e.size >= 20) { e.tag = 'elf'; return 20; }
    return 0;
  }, function (e, body) {
    if (e.tag === 'elf') {
      var m = machineName(body);
      if (m && machines.indexOf(m) < 0) machines.push(m);
    } else if (e.tag === 'appinfo') {
      var j = null;
      try { j = JSON.parse(body.toString('utf8')); } catch (err) {}
      if (!j || typeof j !== 'object' || j.id !== e.appId) {
        throw reject(msg('srv.install.ipk.badAppinfo', 'the ipk holds an unreadable appinfo.json for {id}', { id: e.appId }));
      }
      var a = addApp(e.appId);
      a.title = short(j.title) || e.appId;
      a.version = short(j.version, 64);
      a.icon = short(j.icon) || null;
    }
  });

  streamTar(file, member.start, member.size, caps.dataBytes, walker, function (err) {
    if (err) return cb(err);
    cb(null, { apps: appOrder.map(function (id) { return apps[id]; }), services: services, machines: machines });
  });
}

/**
 * Reads what an ipk contains without unpacking it.
 * cb(errText|null, { package, version, apps, services, machines, cpuMismatch })
 */
function inspectIpk(file, cb) {
  var closed = false, fd = null;
  function finish(err, info) {
    if (closed) return;
    closed = true;
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
    if (err) return cb(userText(err, unreadable(err)));
    cb(null, info);
  }

  fs.open(file, 'r', function (err, handle) {
    if (err) return finish(reject(unreadable(err)));
    fd = handle;
    fs.fstat(fd, function (err2, st) {
      if (err2) return finish(err2);
      readMembers(fd, st.size, function (err3, members) {
        if (err3) return finish(err3);
        var control = null;
        var cw = tarWalker(caps.entries, function (e) {
          var segs = cleanPath(e.name);
          if (segs && segs.length === 1 && segs[0] === 'control' && e.type === '0') {
            if (e.size > caps.controlBytes) throw reject(msg('srv.install.ipk.tooBig', 'the ipk unpacks to more than it may'));
            return e.size;
          }
          return 0;
        }, function (e, body) { control = parseControl(body.toString('utf8')); });
        var cm = members['control.tar.gz'];
        streamTar(file, cm.start, cm.size, caps.controlBytes, cw, function (err4) {
          if (err4) return finish(err4);
          if (!control || !NAME_RE.test(control.Package || '') || !VERSION_RE.test(control.Version || '')) {
            return finish(reject(msg('srv.install.ipk.noControl', 'the ipk has no usable control file')));
          }
          inspectData(file, members['data.tar.gz'], function (err5, data) {
            if (err5) return finish(err5);
            if (!data.apps.length && !data.services.length) {
              return finish(reject(msg('srv.install.ipk.empty', 'the ipk contains no app or service')));
            }
            var tv = tvMachine;
            var mismatch = false;
            if (tv && data.machines.length > 0) {
              mismatch = data.machines.indexOf(tv) < 0;
            }
            finish(null, {
              package: control.Package,
              version: control.Version,
              apps: data.apps,
              services: data.services,
              machines: data.machines,
              cpuMismatch: mismatch
            });
          });
        });
      });
    });
  });
}

/* ----------------------------------------------------------- id rules */

function selfUpdating(name) {
  for (var i = 0; i < SELF_UPDATING.length; i++) {
    if (name === SELF_UPDATING[i] || name.indexOf(SELF_UPDATING[i] + '.') === 0) return true;
  }
  return false;
}

function systemHas(id) {
  var bases = (appsMod && appsMod.APP_BASES) || [];
  for (var i = 0; i < bases.length; i++) {
    if (fs.existsSync(path.join(bases[i], id))) return true;
  }
  return false;
}

/**
 * Every id in the package must be the package name or sit under it, and none
 * may belong to the TV system or to the two packages that update themselves.
 * Returns null, or the reason as text.
 */
function checkIds(info) {
  var pkg = info.package;
  var names = [pkg];
  var i, id;
  for (i = 0; i < info.apps.length; i++) names.push(info.apps[i].id);
  for (i = 0; i < info.services.length; i++) names.push(info.services[i]);

  for (i = 0; i < names.length; i++) {
    id = names[i];
    if (id !== pkg && id.indexOf(pkg + '.') !== 0) {
      return msg('srv.install.id.prefix', '{id} does not begin with the package name {package}', { id: id, package: pkg });
    }
    if (selfUpdating(id)) {
      return msg('srv.install.id.self', '{id} must be updated from the Homebrew Channel', { id: id });
    }
    var sys = (appsMod && appsMod.isProtected(id)) || false;
    for (var p = 0; p < SYSTEM_PREFIXES.length; p++) {
      if (id.indexOf(SYSTEM_PREFIXES[p]) === 0) sys = true;
    }
    if (sys) {
      return msg('srv.install.id.protected', '{id} belongs to the TV system and cannot be installed', { id: id });
    }
    if (systemHas(id)) {
      return msg('srv.install.id.exists', '{id} is already part of the TV system', { id: id });
    }
  }
  return null;
}

/* ----------------------------------------------------------- helpers */

function hashFile(file, cb) {
  var h = crypto.createHash('sha256');
  var done = false;
  var rs = fs.createReadStream(file);
  rs.on('data', function (c) { h.update(c); });
  rs.on('error', function (e) { if (!done) { done = true; cb(e); } });
  rs.on('end', function () { if (!done) { done = true; cb(null, h.digest('hex')); } });
}

/*
 * Free bytes from df output. BusyBox prints one line per filesystem; GNU df
 * wraps a long device name onto its own line, so everything after the header
 * is joined and the available column is the one before the use% column.
 */
function parseDf(out) {
  var lines = String(out || '').split('\n');
  lines.shift();
  var tok = lines.join(' ').split(/\s+/).filter(function (s) { return s; });
  for (var i = 2; i < tok.length; i++) {
    if (/^\d+%$/.test(tok[i]) && /^\d+$/.test(tok[i - 1])) return parseInt(tok[i - 1], 10) * 1024;
  }
  return null;
}

function freeBytes(cb) {
  childProcess.execFile(dfPath, ['-k', stagingDir], { timeout: 5000 }, function (err, stdout) {
    cb(err ? null : parseDf(stdout));
  });
}

function cmpVer(a, b) {
  var x = String(a || '').match(/\d+/g) || [];
  var y = String(b || '').match(/\d+/g) || [];
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10);
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

function listInstalled(cb) {
  if (!lunaFn) return cb(null);
  lunaFn('com.webos.applicationManager/listApps', {}, function (res) {
    var list = res && (res.apps || res.launchPoints);
    cb(list instanceof Array ? list : null);
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, obj) {
  try {
    mkdirp(path.dirname(file));
    fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {}
}

function jobFile() { return path.join(stateDir, 'install-job.json'); }
function elevatedFile() { return path.join(stateDir, 'elevated.json'); }

function persist(j) {
  writeJson(jobFile(), {
    jobId: j.id,
    state: j.state,
    package: j.info ? j.info.package : (j.pkg && j.pkg.id) || null,
    version: j.info ? j.info.version : null,
    updated: Date.now()
  });
}

function clearStaging() {
  var names = [];
  try { names = fs.readdirSync(stagingDir); } catch (e) {}
  names.forEach(function (n) {
    try { fs.unlinkSync(path.join(stagingDir, n)); } catch (e) {}
  });
}

function isCurrentJob(j) { return job === j && !j.cancelled; }

function setState(j, state, err) {
  j.state = state;
  j.error = err || null;
  persist(j);
}

function fail(j, text) {
  if (!isCurrentJob(j)) return;
  if (j.timer) { clearTimeout(j.timer); j.timer = null; }
  clearStaging();
  setState(j, 'error', text);
}

function snapshot() {
  if (!job) return { state: 'idle', jobId: null, source: null, appId: null, progress: null, preview: null, error: null, result: null };
  return {
    state: job.state,
    jobId: job.id,
    // Which catalog row it belongs to, so the dashboard can show it there.
    source: job.source,
    appId: job.pkg ? job.pkg.id : null,
    progress: job.progress,
    preview: job.preview,
    error: job.error,
    result: job.result
  };
}

// Another install may not start: a job is working or waiting for confirmation.
function isBusy() {
  return !!(job && UNFINISHED[job.state]);
}

// Something is being downloaded, verified or installed: settings saves,
// restarts and updates wait; an unconfirmed preview does not hold them.
function isWorking() {
  return !!(job && WORKING[job.state]);
}

/* -------------------------------------------------------------- start */

function proceedVerify(j) {
  setState(j, 'verifying');
  fs.stat(j.file, function (err, st) {
    if (!isCurrentJob(j)) return;
    if (err) return fail(j, unreadable(err));
    if (st.size > caps.uploadBytes) {
      return fail(j, tooBig());
    }
    j.size = st.size;
    hashFile(j.file, function (err2, digest) {
      if (!isCurrentJob(j)) return;
      if (err2) return fail(j, unreadable(err2));
      if (j.sha256 && digest.toLowerCase() !== j.sha256.toLowerCase()) {
        return fail(j, msg('srv.install.hashMismatch', 'the download does not match its sha256 hash'));
      }
      j.digest = digest;
      inspectIpk(j.file, function (err3, info) {
        if (!isCurrentJob(j)) return;
        if (err3) return fail(j, err3);
        var idErr = checkIds(info);
        if (idErr) return fail(j, idErr);
        if (j.pkg) {
          var found = info.package === j.pkg.id;
          for (var i = 0; i < info.apps.length; i++) if (info.apps[i].id === j.pkg.id) found = true;
          if (!found) {
            return fail(j, msg('srv.install.idMismatch', 'the package is {found}, not {expected}', { found: info.package, expected: j.pkg.id }));
          }
        }
        j.info = info;
        buildPreview(j);
      });
    });
  });
}

function buildPreview(j) {
  var info = j.info;
  listInstalled(function (list) {
    if (!isCurrentJob(j)) return;
    var primary = info.package;
    var ids = info.apps.map(function (a) { return a.id; });
    if (ids.indexOf(primary) < 0 && ids.length) primary = ids[0];
    var installed = null, i;
    for (i = 0; list && i < list.length; i++) {
      if (list[i] && list[i].id === primary) installed = list[i].version || '';
    }
    var direction = 'new';
    if (installed !== null) {
      var c = cmpVer(info.version, installed);
      direction = c > 0 ? 'up' : c < 0 ? 'down' : 'same';
    }
    var store = false;
    ids.concat([info.package]).forEach(function (id) {
      if (fs.existsSync(path.join(storeAppsDir, id, 'appinfo.json'))) store = true;
    });
    freeBytes(function (free) {
      if (!isCurrentJob(j)) return;
      // The staged file is already on disk; unpacking and the installed copy
      // still need room.
      var need = j.size * 2;
      if (free !== null && free < need) {
        return fail(j, noSpace(need, free));
      }
      var isSaver = isScreensaverPackage(info.package);
      for (var sIdx = 0; sIdx < info.apps.length; sIdx++) {
        if (isScreensaverPackage(info.apps[sIdx].id)) isSaver = true;
      }
      j.preview = {
        jobId: j.id,
        package: info.package,
        version: info.version,
        installedVersion: installed,
        direction: direction,
        apps: info.apps,
        services: info.services,
        rootRequired: !!(j.pkg && j.pkg.rootRequired),
        willElevate: reelevated(j).length > 0,
        // The services that get root back whether or not root is ticked, so
        // the dashboards can say so before anything is installed.
        reelevate: reelevated(j),
        cpuMismatch: info.cpuMismatch,
        storeInstalled: store,
        isScreensaver: isSaver,
        source: j.source,
        vetted: vetted(j),
        freeBytes: free,
        needBytes: need,
        sha256: j.digest
      };
      setState(j, 'awaiting-confirm');
      if (j.auto && !needsReview(j.preview)) {
        var autoErr = null;
        var autoReq = { jobId: j.id };
        var asked = j.preview.willElevate;
        if (j.preview.rootRequired && fs.existsSync(elevatePath)) {
          autoReq.elevate = true;
          j.preview.willElevate = true;
        }
        // confirm() answers synchronously; if it refuses, the preview stays up.
        confirm(autoReq, function (e) { autoErr = e; });
        if (!autoErr) return;
        j.preview.willElevate = asked;
      }
      j.timer = setTimeout(function () {
        j.timer = null;
        fail(j, msg('srv.install.expired', 'the preview expired; start the install again'));
      }, previewMs);
      if (j.timer.unref) j.timer.unref();
    });
  });
}

function isScreensaverPackage(id) {
  if (!id || typeof id !== 'string') return false;
  return /screensaver/i.test(id);
}

/*
 * What a one-click catalog install still stops for: a choice to make (root for
 * an unvetted package's services, replacing an LG store copy) or a warning to
 * read (a different processor, an older version, or a custom screensaver).
 * Vetted catalog packages with root services auto-elevate on single-click.
 */
function needsReview(pv) {
  var unvettedRoot = !pv.vetted && pv.rootRequired && pv.services && pv.services.length && fs.existsSync(elevatePath);
  return !!(unvettedRoot ||
            pv.storeInstalled || pv.cpuMismatch || pv.direction === 'down' ||
            pv.isScreensaver);
}

/*
 * The download is cut off once it passes a third of the free space (the
 * staged file, its unpacked copy and the installed copy all need room) or the
 * upload cap. The catalog's size is not held to exactly: it is the listing's
 * figure, not the server's, and the hash already decides.
 */
function startDownload(j, url, free) {
  var limit = caps.uploadBytes, why = null;
  if (free !== null && free / 3 < limit) limit = free / 3;
  j.dl = fetchMod.download(url, j.file, {
    onProgress: function (bytes) {
      if (!isCurrentJob(j)) return;
      j.progress.bytes = bytes;
      if (why || bytes <= limit) return;
      why = limit < caps.uploadBytes
        ? msg('srv.install.noSpace.download', 'not enough free space for this download: {free} free, and the package needs about three times its size', { free: formatMb(free) })
        : tooBig();
      var d = j.dl;
      if (d) d.cancel();
      fail(j, why);
    }
  }, function (err) {
    j.dl = null;
    if (!isCurrentJob(j)) return;
    if (err) return fail(j, msg('srv.install.downloadFailed', 'the download failed: {error}', { error: errText(err) }));
    proceedVerify(j);
  });
}

/**
 * Starts a job and calls back at once with its snapshot; later steps show in
 * status(). Sources: { source: 'catalog', pkg, auto? }, { source: 'url', url, sha256? },
 * { source: 'file', path } (a file already inside the staging directory).
 * With auto, a catalog install whose preview needs no review installs at once.
 */
function start(req, cb) {
  cb = cb || noop;
  req = req || {};
  var busy = busyText();
  if (busy) return cb(busy);
  if (req.source !== 'file' && uploadHeld && Date.now() - uploadHeld < UPLOAD_HOLD_MS) {
    return cb(msg('srv.install.busy.upload', 'an upload is in progress'));
  }

  var url = null, sha = null, size = 0, pkg = null, file = null;
  var id = crypto.randomBytes(8).toString('hex');
  var err;

  if (req.source === 'catalog') {
    pkg = req.pkg || {};
    if (typeof pkg.id !== 'string' || typeof pkg.version !== 'string' ||
        typeof pkg.ipkUrl !== 'string' || !/^[0-9a-f]{64}$/i.test(pkg.sha256 || '')) {
      return cb(msg('srv.install.catalogIncomplete', 'the catalog entry is incomplete'));
    }
    if (!/^https:\/\//i.test(pkg.ipkUrl)) return cb(msg('srv.install.needHttps', 'the download must use https'));
    err = fetchMod.validateUrl(pkg.ipkUrl);
    if (err) return cb(err);
    url = pkg.ipkUrl;
    sha = pkg.sha256;
    size = pkg.size > 0 ? pkg.size : 0;
  } else if (req.source === 'url') {
    err = fetchMod.validateUrl(req.url);
    if (err) return cb(err);
    if (req.sha256 && !/^[0-9a-f]{64}$/i.test(req.sha256)) return cb(msg('srv.install.badHash', 'the sha256 hash must be 64 hexadecimal digits'));
    url = req.url;
    sha = req.sha256 || null;
  } else if (req.source === 'file') {
    file = typeof req.path === 'string' ? path.resolve(req.path) : '';
    // The staged file is deleted afterwards, so only the staging directory is accepted.
    if (!file || path.dirname(file) !== path.resolve(stagingDir)) return cb(msg('srv.install.notStaged', 'the file is not in the staging directory'));
    uploadHeld = 0;
  } else {
    return cb(msg('srv.install.badSource', 'unknown install source'));
  }

  mkdirp(stagingDir);
  var j = {
    id: id, state: url ? 'downloading' : 'verifying', source: req.source, pkg: pkg, sha256: sha,
    file: file || path.join(stagingDir, id + '.ipk'), progress: { bytes: 0, total: size || null },
    preview: null, error: null, result: null, cancelled: false, dl: null, timer: null, info: null,
    size: 0, digest: null,
    // URL and file installs always stop at the preview: nothing else vouches for them.
    auto: req.source === 'catalog' && req.auto === true
  };
  job = j;
  persist(j);
  cb(null, snapshot());

  if (!url) return proceedVerify(j);
  freeBytes(function (free) {
    if (!isCurrentJob(j)) return;
    if (size && free !== null && free < size * 3) {
      return fail(j, noSpace(size * 3, free));
    }
    startDownload(j, url, free);
  });
}

/*
 * Checks an upload of `len` bytes before any of it is read, and reserves a
 * file for it in the staging directory. cb(errText, null, httpStatus) or
 * cb(null, path). Three times the size must be free: the staged file, its
 * unpacked copy and the installed copy.
 */
function prepareUpload(len, cb) {
  if (len > caps.uploadBytes) {
    return cb(tooBig(), null, 413);
  }
  var held = uploadHeld && Date.now() - uploadHeld < UPLOAD_HOLD_MS;
  var busy = busyText() || (held ? msg('srv.install.busy', 'an install is already in progress') : null);
  if (busy) return cb(busy, null, 409);
  uploadHeld = Date.now();
  // df reads the directory, so it has to exist before the first upload too.
  mkdirp(stagingDir);
  freeBytes(function (free) {
    if (free !== null && free < len * 3) {
      uploadHeld = 0;
      return cb(noSpace(len * 3, free), null, 507);
    }
    clearStaging();
    cb(null, path.join(stagingDir, 'upload-' + crypto.randomBytes(8).toString('hex') + '.ipk'));
  });
}

/** Called as upload data arrives, so a slow upload keeps its hold. */
function touchUpload() {
  if (uploadHeld && Date.now() - uploadHeld < UPLOAD_HOLD_MS) uploadHeld = Date.now();
}

/** Drops a reserved upload file, finished or not. */
function releaseUpload(file) {
  uploadHeld = 0;
  try { fs.unlinkSync(file); } catch (e) {}
}

/* ------------------------------------------------------------ confirm */

function killChild() {
  var c = installChild;
  installChild = null;
  if (c) { try { c.kill(); } catch (e) {} }
}

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', killChild);
}

/*
 * Runs dev/install with luna-send spawned directly, not through
 * luna.Subscription: its close handler reconnects, which would issue the
 * install again. cb(errText|null).
 */
/*
 * The app list shows the package at the new version. The version an app lists
 * is the one in its appinfo.json, which need not equal the control file's.
 */
function installedAtVersion(list, info) {
  for (var i = 0; list && i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item.version !== 'string') continue;
    if (item.id === info.package && item.version === info.version) return true;
    for (var k = 0; k < info.apps.length; k++) {
      var a = info.apps[k];
      if (a.id === item.id && (item.version === info.version || (a.version && item.version === a.version))) return true;
    }
  }
  return false;
}

function runInstall(j, cb) {
  var info = j.info;
  var settled = false, finishing = false, buf = '', timer = null, child;

  function end(err) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    killChild();
    cb(err);
  }

  // The install service carries on after luna-send gives up, so a slow eMMC
  // can finish after the timeout; ask the app list before calling it failed.
  function settleWith(text) {
    if (settled || finishing) return;
    finishing = true;
    killChild();
    listInstalled(function (list) {
      end(installedAtVersion(list, info) ? null : text);
    });
  }

  function handle(line) {
    var r = null;
    try { r = JSON.parse(line); } catch (e) { return; }
    if (!r || typeof r !== 'object' || settled || finishing) return;
    var d = r.details && typeof r.details === 'object' ? r.details : {};
    if (r.returnValue === false) {
      return end(installFailed(short(r.errorText) || short(d.reason) || unknownError()));
    }
    if (d.errorCode) {
      return end(installFailed(short(d.reason) || short(r.errorText) || String(d.errorCode)));
    }
    var sv = r.statusValue !== undefined ? r.statusValue : d.statusValue;
    if ((sv === 30 && d.packageId) || r.state === 'installed' || d.state === 'installed') end(null);
  }

  hookExit();
  try {
    child = childProcess.spawn(lunaSendPath, ['-i', 'luna://com.webos.appInstallService/dev/install',
      JSON.stringify({ id: info.package, ipkUrl: j.file, subscribe: true })]);
  } catch (e) {
    return end(installFailed(errText(e)));
  }
  installChild = child;
  child.stdout.on('data', function (chunk) {
    buf += String(chunk);
    var lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(handle);
  });
  child.stderr.on('data', noop);
  child.on('error', function (e) {
    end(installFailed(errText(e)));
  });
  child.on('close', function () {
    if (buf) handle(buf);
    buf = '';
    settleWith(msg('srv.install.closed', 'the install service stopped answering'));
  });
  timer = setTimeout(function () {
    settleWith(msg('srv.install.timeout', 'the install did not finish in time; check the app list'));
  }, installTimeoutMs);
}

/*
 * A package from the Homebrew Channel's own catalog. Anything else - a URL, a
 * file, or a catalog added under apps.repos - has root confirmed service by
 * service, and never gets it back on its own.
 */
function vetted(j) {
  return j.source === 'catalog' && !!(j.pkg && j.pkg.vetted);
}

/*
 * Services that get root again without being asked: only for a vetted
 * package, and only those recorded the last time it was elevated.
 */
function reelevated(j) {
  if (!vetted(j) || !fs.existsSync(elevatePath)) return [];
  var rec = readJson(elevatedFile()) || {};
  var was = Object.prototype.hasOwnProperty.call(rec, j.info.package) ? rec[j.info.package] : null;
  if (!(was instanceof Array)) return [];
  return j.info.services.filter(function (s) { return was.indexOf(s) >= 0; });
}

function sameNames(a, b) {
  if (!(a instanceof Array) || a.length !== b.length) return false;
  var x = a.slice().sort(), y = b.slice().sort();
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function elevateAll(services, cb) {
  var done = [], failed = [];
  (function next() {
    if (!services.length) return cb({ done: done, failed: failed });
    var name = services.shift();
    childProcess.execFile(elevatePath, [name], { timeout: elevateTimeoutMs }, function (err, stdout, stderr) {
      if (err) {
        failed.push({
          service: name,
          error: msg('srv.install.elevateFailed', 'could not give {service} root access: {error}',
                     { service: name, error: short(String(stderr || '').trim().split('\n')[0]) || errText(err) })
        });
      } else {
        done.push(name);
      }
      next();
    });
  })();
}

function appTitle(j) {
  var first = j.info.apps[0];
  if (first && first.title && first.title !== first.id) return first.title;
  return (j.pkg && j.pkg.title) || j.info.package;
}

function finishJob(j, elevation) {
  if (!isCurrentJob(j)) return;
  clearStaging();
  j.result = {
    package: j.info.package,
    // What the home screen calls it: the app's own title, else the catalog's.
    title: appTitle(j),
    version: j.info.version,
    apps: j.info.apps.map(function (a) { return a.id; }),
    elevation: elevation
  };
  setState(j, 'installed');
  onInstalled();
}

/**
 * Installs the previewed package. cb(errText|null, snapshot) returns once the
 * install is under way; progress shows in status().
 */
function confirm(req, cb) {
  cb = cb || noop;
  req = req || {};
  var j = job;
  if (!j || j.id !== req.jobId || j.state !== 'awaiting-confirm') {
    return cb(msg('srv.install.noJob', 'there is no install waiting for confirmation'));
  }
  if (j.preview.storeInstalled && !req.replaceStore) {
    return cb(msg('srv.install.storeReplace', 'this app came from the LG store; replacing it stops store updates and needs separate confirmation'));
  }
  if (updaterBusy()) return cb(msg('srv.install.busy.updater', 'a dashboard update is running; install when it has finished'));
  var wantRoot = req.elevate === true;
  if (wantRoot && !fs.existsSync(elevatePath)) {
    return cb(msg('srv.install.noElevate', 'root access needs the Homebrew Channel, which is not installed'));
  }
  // Root for a package nobody vetted has to be confirmed for the services the
  // preview listed, so a client cannot ask for it blind.
  if (wantRoot && !vetted(j) && !sameNames(req.confirmRoot, j.info.services)) {
    return cb(msg('srv.install.rootConfirm', 'root access for a package from outside the catalog must be confirmed for the services listed in its preview'));
  }
  // A reinstall rewrites the service files that elevation changed.
  var services = wantRoot ? j.info.services.slice() : reelevated(j);

  if (j.timer) { clearTimeout(j.timer); j.timer = null; }
  setState(j, 'installing');
  cb(null, snapshot());

  runInstall(j, function (err) {
    if (!isCurrentJob(j)) return;
    if (err) return fail(j, err);
    if (!services.length) return finishJob(j, null);
    setState(j, 'elevating');
    elevateAll(services, function (res) {
      if (!isCurrentJob(j)) return;
      if (res.done.length) {
        var rec = readJson(elevatedFile()) || {};
        rec[j.info.package] = res.done;
        writeJson(elevatedFile(), rec);
      }
      finishJob(j, res);
    });
  });
}

/** Drops the job before it starts installing. cb(errText|null). */
function cancel(jobId, cb) {
  cb = cb || noop;
  var j = job;
  if (!j || j.id !== jobId) return cb(msg('srv.install.noJob', 'there is no install waiting for confirmation'));
  if (j.state !== 'downloading' && j.state !== 'verifying' && j.state !== 'awaiting-confirm') {
    return cb(msg('srv.install.cannotCancel', 'the install is already running and cannot be cancelled'));
  }
  j.cancelled = true;
  if (j.timer) { clearTimeout(j.timer); j.timer = null; }
  if (j.dl && j.dl.cancel) { try { j.dl.cancel(); } catch (e) {} }
  clearStaging();
  job = null;
  try { fs.unlinkSync(jobFile()); } catch (e2) {}
  cb(null);
}

/** At boot: a job the last run left unfinished is reported, not resumed. */
function recover() {
  // Leftovers from an upload or a job that ended in a restart.
  clearStaging();
  var rec = readJson(jobFile());
  // A preview waiting for confirmation had installed nothing, and a restart may
  // come during one, so it is not reported as an interrupted install.
  if (!rec || !WORKING[rec.state]) return;
  job = {
    id: rec.jobId || '', state: 'interrupted',
    error: msg('srv.install.interrupted', 'the TV restarted during an install; check the app list'),
    progress: null, preview: null, result: null, info: null, pkg: null, cancelled: false
  };
  persist(job);
}

/* --------------------------------------------------------------- init */

function init(opts) {
  opts = opts || {};
  if (job && job.timer) clearTimeout(job.timer);
  killChild();
  job = null;
  uploadHeld = 0;
  lunaFn = opts.luna || null;
  appsMod = opts.apps || require('./apps');
  fetchMod = opts.fetch || null;
  stateDir = opts.stateDir || '/var/lib/tvweb';
  stagingDir = opts.stagingDir || '/media/developer/temp/glasshouse-install';
  lunaSendPath = opts.lunaSendPath || process.env.TVWEB_LUNA_SEND || '/usr/bin/luna-send';
  elevatePath = opts.elevatePath ||
    '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service';
  storeAppsDir = opts.storeAppsDir || '/media/cryptofs/apps/usr/palm/applications';
  dfPath = opts.dfPath || 'df';
  previewMs = opts.previewMs || 10 * 60 * 1000;
  installTimeoutMs = opts.installTimeoutMs || 120000;
  elevateTimeoutMs = opts.elevateTimeoutMs || 60000;
  caps = {};
  for (var k in DEFAULT_CAPS) caps[k] = (opts.caps && opts.caps[k]) || DEFAULT_CAPS[k];
  tvMachine = opts.tvMachine || detectTvMachine();
  updaterBusy = opts.updaterBusy || function () { return false; };
  onInstalled = opts.onInstalled || function () {};
}

module.exports = {
  init: init,
  inspectIpk: inspectIpk,
  checkIds: checkIds,
  start: start,
  confirm: confirm,
  cancel: cancel,
  status: snapshot,
  isBusy: isBusy,
  isWorking: isWorking,
  prepareUpload: prepareUpload,
  releaseUpload: releaseUpload,
  touchUpload: touchUpload,
  recover: recover,
  SELF_UPDATING: SELF_UPDATING,
  NAME_RE: NAME_RE,
  cmpVer: cmpVer,
  hashFile: hashFile,
  parseDf: parseDf
};
