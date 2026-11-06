/*
 * lib/home-launcher.js - a launcher of the owner's own in Glasshouse Home's place
 *
 * Chosen as the TV's Home, a custom launcher opens where Glasshouse Home's
 * view would: the same app holds LG's Home's place (lib/home-takeover, or
 * com.tvweb.home on webOS 4), so the Home button, Back, waking and the ways
 * back to LG's Home all work as they do for Glasshouse Home. Only the page
 * that app opens differs.
 *
 * Minimal, Glasshouse's own plainest home screen (assets/home-minimal.html),
 * is always offered. The owner's own is a web app uploaded as an .ipk, a .zip
 * of its folder or a single HTML file, or a web address. Launchers are kept by
 * id, one of them chosen. An uploaded one is unpacked to
 * /var/lib/tvweb/home-launcher/apps/<id>, the chosen one served from
 * /home/launcher/, with
 * /assets/home-kit.js added to its start page: the heartbeat that tells the
 * server the page is up, and window.Glasshouse for its apps and inputs. A web
 * address opens in a frame of assets/home-web.html, which carries the same
 * script, so another site's page never runs as LG's Home app.
 *
 * Archives are read here rather than with unzip, which not every webOS has.
 *
 * Strict ES5: runs on node 0.12 (0.10 on webOS 2).
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var execFile = require('child_process').execFile;
var msg = require('./say').msg;
var util = require('./util');
var installer = require('./installer');

var archive = installer.archive;
var MAX_UPLOAD = 50 * 1024 * 1024;
var MAX_UNPACKED = 100 * 1024 * 1024;
var MAX_FILE = 50 * 1024 * 1024;
var MAX_FILES = 5000;
// A zip's central directory: 5000 entries with long names fit well inside this.
var MAX_DIRECTORY = 4 * 1024 * 1024;
var MAX_ADDRESS = 2000;
var MAX_TITLE = 80;
// The owner's own launcher, uploaded or a web address.
var OWN = 'own';
// Launchers that come with Glasshouse, served from its assets and never removed.
var BUILTIN = { minimal: { title: 'Minimal', page: 'home-minimal.html' } };
// The release in its address, so a TV holding an older copy loads this one.
var KIT_SRC = '/assets/home-kit.js';
var KIT_TAG_PLAIN = '<script src="' + KIT_SRC + '"></script>';
var kitTag = KIT_TAG_PLAIN;
// Left out of a zip: what macOS adds to one made in the Finder.
var JUNK = /^(__MACOSX|\.DS_Store|Thumbs\.db)$/;
var NATIVE_TYPES = ['native', 'native_builtin', 'native_appshell', 'qml'];
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm'
};

var dir = '/var/lib/tvweb/home-launcher';
var assetsDir = path.join(__dirname, '..', 'assets');
var webPagePath = path.join(assetsDir, 'home-web.html');
var dfFn = function (target, cb) {
  execFile('df', ['-k', target], { timeout: 5000 }, function (err, out) { cb(err ? null : installer.parseDf(out)); });
};
var busy = false;
var meta = null;

function init(opts) {
  opts = opts || {};
  if (opts.dir) dir = opts.dir;
  else if (opts.stateDir) dir = path.join(opts.stateDir, 'home-launcher');
  if (opts.webPage) webPagePath = opts.webPage;
  if (opts.assetsDir) assetsDir = opts.assetsDir;
  if (opts.df) dfFn = opts.df;
  kitTag = opts.version ? '<script src="' + KIT_SRC + '?v=' + encodeURIComponent(opts.version) + '"></script>' : KIT_TAG_PLAIN;
  meta = null;
  busy = false;
}

function metaFile() { return path.join(dir, 'launcher.json'); }
function appDir(id) { return path.join(dir, 'apps', id); }

/*
 * { chosen: id or null, rev, launchers: { id: { kind, title, ... } } }. The
 * first release kept one launcher, in app/ and at the top of launcher.json;
 * it becomes the owner's own.
 */
function readMeta() {
  if (meta) return meta;
  var m = util.readJson(metaFile(), null);
  if (m && (m.kind === 'app' || m.kind === 'web')) {
    var own = JSON.parse(JSON.stringify(m));
    delete own.chosen; delete own.rev;
    own.source = OWN;
    m = { chosen: m.chosen === true ? OWN : null, rev: m.rev || 0, launchers: {} };
    m.launchers[OWN] = own;
    try {
      if (own.kind === 'app') {
        util.mkdirp(path.join(dir, 'apps'));
        fs.renameSync(path.join(dir, 'app'), appDir(OWN));
      }
      saveMeta(m);
      console.log('home: custom launcher kept as the owner\'s own');
    } catch (e) { console.error('home: could not move the custom launcher: ' + e.message); }
  }
  if (!m || typeof m.launchers !== 'object' || !m.launchers) m = { chosen: null, rev: 0, launchers: {} };
  if (m.chosen && !m.launchers[m.chosen] && !BUILTIN[m.chosen]) m.chosen = null;
  meta = m;
  return meta;
}

function saveMeta(m) {
  util.mkdirp(dir);
  util.writeJsonAtomic(metaFile(), m, 384);
  meta = m;
}

function copyMeta() { return JSON.parse(JSON.stringify(readMeta())); }

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmTree(path.join(p, f)); });
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

function describeOne(id, l, chosenId) {
  var out = { id: id, kind: l.kind, title: l.title, source: l.source || OWN, chosen: id === chosenId, at: l.at };
  if (l.kind === 'web') out.address = l.address;
  else { out.files = l.files; out.bytes = l.bytes; }
  if (l.version) out.version = l.version;
  if (l.author) out.author = l.author;
  return out;
}

// What the dashboards show: Glasshouse's own launchers, then each kept, the owner's own first.
function status() {
  var m = readMeta();
  var ids = Object.keys(m.launchers).filter(function (id) { return !BUILTIN[id]; }).sort(function (a, b) {
    if (a === OWN || b === OWN) return a === OWN ? -1 : 1;
    return String(m.launchers[a].title).localeCompare(String(m.launchers[b].title));
  });
  var builtin = Object.keys(BUILTIN).map(function (id) {
    return { id: id, kind: 'builtin', title: BUILTIN[id].title, source: 'builtin', chosen: id === m.chosen };
  });
  return { chosen: m.chosen, launchers: builtin.concat(ids.map(function (id) { return describeOne(id, m.launchers[id], m.chosen); })) };
}

// True while one is chosen in Glasshouse Home's place.
function chosen() {
  return !!readMeta().chosen;
}

/*
 * What the page in Home's place compares on each heartbeat: empty for
 * Glasshouse Home, otherwise changing with every new launcher, so either
 * page reloads into the one now chosen.
 */
function revision() {
  var m = readMeta();
  return m.chosen ? 'custom-' + m.chosen + '-' + (m.rev || 0) : '';
}

function fail(text) { return { ok: false, error: text }; }

function cleanTitle(v, fallback) {
  var s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim() : '';
  return (s || fallback).slice(0, MAX_TITLE);
}

/* ------------------------------------------------------------ choosing */

// id: one kept, to put in Glasshouse Home's place; false for Glasshouse Home.
function choose(id, cb) {
  var next = copyMeta();
  if (id !== false && !next.launchers[id] && !BUILTIN[id]) return cb(fail(msg('srv.home.launcher.none', 'Upload a launcher or give a web address first.')));
  next.chosen = id === false ? null : id;
  try { saveMeta(next); } catch (e) { return cb(fail(e.message)); }
  console.log('home: ' + (id === false ? 'Glasshouse Home chosen over the custom launcher' : 'custom launcher ' + id + ' chosen'));
  cb({ ok: true, launchers: status() });
}

/*
 * A launcher put in, in place of any with its id: the files at root moved to
 * its folder (none for a web address), and the change counted, so a page
 * showing the one replaced reloads.
 */
function keep(id, entry, root) {
  var next = copyMeta();
  var target = appDir(id), old = target + '.old';
  rmTree(old);
  if (fs.existsSync(target)) fs.renameSync(target, old);
  if (root) {
    util.mkdirp(path.join(dir, 'apps'));
    fs.renameSync(root, target);
  }
  rmTree(old);
  entry.at = Date.now();
  next.launchers[id] = entry;
  next.rev = (next.rev || 0) + 1;
  saveMeta(next);
}

function setAddress(address, cb) {
  var a = typeof address === 'string' ? address.trim() : '';
  if (a.length > MAX_ADDRESS || !/^https?:\/\/[^\s\/?#]+[^\s]*$/i.test(a)) {
    return cb(fail(msg('srv.home.launcher.address', 'Give a web address starting with http:// or https://.')));
  }
  if (busy) return cb(fail(msg('srv.home.launcher.busy', 'Wait for the launcher upload to finish.')));
  try {
    keep(OWN, { kind: 'web', address: a, source: OWN, title: cleanTitle(a.replace(/^https?:\/\//i, '').split(/[\/?#]/)[0], a) }, null);
  } catch (e) { return cb(fail(e.message)); }
  console.log('home: custom launcher set to a web address');
  cb({ ok: true, launchers: status() });
}

// Removed while chosen, Glasshouse Home has the place again.
function remove(id, cb) {
  if (busy) return cb(fail(msg('srv.home.launcher.busy', 'Wait for the launcher upload to finish.')));
  var next = copyMeta();
  if (!next.launchers[id] || BUILTIN[id]) return cb({ ok: true, launchers: status() });
  try {
    rmTree(appDir(id));
    delete next.launchers[id];
    if (next.chosen === id) next.chosen = null;
    next.rev = (next.rev || 0) + 1;
    saveMeta(next);
  } catch (e) { return cb(fail(e.message)); }
  console.log('home: custom launcher ' + id + ' removed');
  cb({ ok: true, launchers: status() });
}

/* ------------------------------------------------------------ reading */

function readAt(fd, pos, len, cb) {
  var buf = util.allocBuffer(len), got = 0;
  (function next() {
    if (got >= len) return cb(null, buf);
    fs.read(fd, buf, got, len - got, pos + got, function (err, n) {
      if (err) return cb(err);
      if (n === 0) return cb(archive.reject(msg('srv.home.launcher.damaged', 'The file is damaged or not a launcher.')));
      got += n;
      next();
    });
  })();
}

function damaged() { return archive.reject(msg('srv.home.launcher.damaged', 'The file is damaged or not a launcher.')); }
function tooLarge() { return archive.reject(msg('srv.home.launcher.tooBig', 'The launcher unpacks to more than 100 MB or 5,000 files.')); }

// A path inside the launcher, or null: no "..", no absolute path, no empty name.
function safeSegments(name) {
  if (typeof name !== 'string' || !name || /[\u0000]/.test(name)) return null;
  var segs = archive.cleanPath(name.replace(/\\/g, '/'));
  return segs && segs.length ? segs : null;
}

function writeFileIn(root, segs, data) {
  var file = path.join.apply(path, [root].concat(segs));
  util.mkdirp(path.dirname(file));
  fs.writeFileSync(file, data, { mode: parseInt('644', 8) });
}

/*
 * The entries of a zip from its central directory: { segs, method, csize,
 * size, local }. Neither zip64 nor encryption is read: a launcher stays far
 * below 4 GB and has nothing to hide from its owner.
 */
function zipEntries(fd, size, cb) {
  var tailLen = Math.min(size, 22 + 65535);
  if (size < 22) return cb(damaged());
  readAt(fd, size - tailLen, tailLen, function (err, tail) {
    if (err) return cb(err);
    var at = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
    }
    if (at < 0) return cb(damaged());
    var count = tail.readUInt16LE(at + 10);
    var cdSize = tail.readUInt32LE(at + 12);
    var cdStart = tail.readUInt32LE(at + 16);
    if (tail.readUInt16LE(at + 4) !== 0 || count === 0xffff || cdStart === 0xffffffff) return cb(damaged());
    if (count > MAX_FILES || cdSize > MAX_DIRECTORY) return cb(tooLarge());
    if (cdStart + cdSize > size) return cb(damaged());
    readAt(fd, cdStart, cdSize, function (err2, cd) {
      if (err2) return cb(err2);
      var out = [], pos = 0;
      for (var n = 0; n < count; n++) {
        if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) return cb(damaged());
        var flags = cd.readUInt16LE(pos + 8);
        var method = cd.readUInt16LE(pos + 10);
        var csize = cd.readUInt32LE(pos + 20);
        var usize = cd.readUInt32LE(pos + 24);
        var nameLen = cd.readUInt16LE(pos + 28);
        var skip = nameLen + cd.readUInt16LE(pos + 30) + cd.readUInt16LE(pos + 32);
        var unixMode = cd.readUInt32LE(pos + 38) >>> 16;
        var local = cd.readUInt32LE(pos + 42);
        if (pos + 46 + skip > cd.length) return cb(damaged());
        var name = cd.toString('utf8', pos + 46, pos + 46 + nameLen);
        pos += 46 + skip;
        if (/\/$/.test(name.replace(/\\/g, '/'))) continue;
        if (flags & 1) return cb(archive.reject(msg('srv.home.launcher.encrypted', 'The zip is password-protected.')));
        // A link would point anywhere once unpacked, so it is left out.
        if ((unixMode & 0xf000) === 0xa000) continue;
        if (method !== 0 && method !== 8) return cb(archive.reject(msg('srv.home.launcher.zipMethod', 'The zip is compressed in a way that cannot be read. Make it again with standard (Deflate) compression.')));
        var segs = safeSegments(name);
        if (!segs) return cb(archive.reject(msg('srv.home.launcher.unsafe', 'The file holds a path outside its own folder: {path}', { path: name.slice(0, 80) })));
        if (usize > MAX_FILE || csize > size) return cb(tooLarge());
        out.push({ segs: segs, method: method, csize: csize, size: usize, local: local });
      }
      cb(null, out);
    });
  });
}

function zipData(fd, e, cb) {
  readAt(fd, e.local, 30, function (err, h) {
    if (err) return cb(err);
    if (h.readUInt32LE(0) !== 0x04034b50) return cb(damaged());
    var start = e.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    readAt(fd, start, e.csize, function (err2, raw) {
      if (err2) return cb(err2);
      if (e.method === 0) return cb(raw.length === e.size ? null : damaged(), raw);
      zlib.inflateRaw(raw, function (err3, data) {
        if (err3 || data.length !== e.size) return cb(damaged());
        cb(null, data);
      });
    });
  });
}

/*
 * Where the launcher's files start inside what was unpacked: the top, or the
 * one folder everything is in, as a zip of a folder has it.
 */
function launcherRoot(paths) {
  var kept = paths.filter(function (segs) { return !segs.some(function (s) { return JUNK.test(s); }); });
  var top = kept.some(function (segs) { return segs.length === 1 && /^(index\.html?|appinfo\.json)$/i.test(segs[0]); });
  if (top || !kept.length) return { strip: 0, kept: kept };
  var first = kept[0][0];
  var shared = kept.every(function (segs) { return segs.length > 1 && segs[0] === first; });
  return { strip: shared ? 1 : 0, kept: kept };
}

function unpackZip(file, into, cb) {
  fs.open(file, 'r', function (err, fd) {
    if (err) return cb(err);
    function done(e, info) { try { fs.closeSync(fd); } catch (x) {} cb(e, info); }
    fs.fstat(fd, function (err2, st) {
      if (err2) return done(err2);
      zipEntries(fd, st.size, function (err3, entries) {
        if (err3) return done(err3);
        var root = launcherRoot(entries.map(function (e) { return e.segs; }));
        var todo = entries.filter(function (e) { return root.kept.indexOf(e.segs) !== -1; });
        var total = 0, files = 0;
        (function next(i) {
          if (i >= todo.length) return done(null, { files: files, bytes: total });
          var e = todo[i];
          total += e.size;
          if (total > MAX_UNPACKED) return done(tooLarge());
          zipData(fd, e, function (err4, data) {
            if (err4) return done(err4);
            try { writeFileIn(into, e.segs.slice(root.strip), data); } catch (x) { return done(x); }
            files++;
            next(i + 1);
          });
        })(0);
      });
    });
  });
}

/*
 * An ipk's web apps, from usr/palm/applications/<id>/, each unpacked to a
 * folder of its id. Services, links and anything elsewhere are left out.
 */
function unpackIpk(file, into, cb) {
  fs.open(file, 'r', function (err, fd) {
    if (err) return cb(err);
    function done(e, info) { try { fs.closeSync(fd); } catch (x) {} cb(e, info); }
    fs.fstat(fd, function (err2, st) {
      if (err2) return done(err2);
      archive.readMembers(fd, st.size, function (err3, members) {
        if (err3) return done(err3);
        var total = 0, files = 0, ids = [];
        var walker = archive.tarWalker(MAX_FILES * 2, function (e) {
          var segs = safeSegments(e.name);
          if (!segs) throw archive.reject(msg('srv.home.launcher.unsafe', 'The file holds a path outside its own folder: {path}', { path: String(e.name).slice(0, 80) }));
          if (e.type !== '0' || segs.length < 5 || segs[0] !== 'usr' || segs[1] !== 'palm' || segs[2] !== 'applications') return 0;
          if (!installer.NAME_RE.test(segs[3])) return 0;
          if (e.size > MAX_FILE || ++files > MAX_FILES) throw tooLarge();
          total += e.size;
          if (total > MAX_UNPACKED) throw tooLarge();
          if (ids.indexOf(segs[3]) === -1) ids.push(segs[3]);
          e.segs = segs.slice(3);
          // An empty file is kept too: the walker hands over only what it kept.
          if (e.size === 0) writeFileIn(into, e.segs, util.allocBuffer(0));
          return e.size;
        }, function (e, body) { writeFileIn(into, e.segs, body); });
        var dm = members['data.tar.gz'];
        archive.streamTar(file, dm.start, dm.size, MAX_UNPACKED + MAX_FILES * 1024, walker, function (err4) {
          if (err4) return done(err4);
          done(null, { files: files, bytes: total, ids: ids });
        });
      });
    });
  });
}

function readAppinfo(root) {
  var raw = null;
  try { raw = fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'); } catch (e) { return null; }
  try { return JSON.parse(raw.replace(/^﻿/, '')) || {}; } catch (e) { return {}; }
}

function readHead(file) {
  try {
    var fd = fs.openSync(file, 'r');
    var b = util.allocBuffer(4096);
    var n = fs.readSync(fd, b, 0, 4096, 0);
    fs.closeSync(fd);
    return b.toString('utf8', 0, n);
  } catch (e) { return ''; }
}

// The start page and title of what was unpacked to root, or an error's text.
function describe(root, fallbackTitle) {
  var info = readAppinfo(root);
  if (info && NATIVE_TYPES.indexOf(String(info.type || '').toLowerCase()) !== -1) {
    return { error: msg('srv.home.launcher.native', 'This launcher is a native app. Only web launchers can be used.') };
  }
  var main = info && typeof info.main === 'string' ? info.main : '';
  var segs = main ? safeSegments(main) : null;
  if (!segs) {
    var found = ['index.html', 'index.htm'].filter(function (f) { return fs.existsSync(path.join(root, f)); })[0];
    if (!found) return { error: msg('srv.home.launcher.noIndex', 'The launcher has no index.html, and no appinfo.json naming its start page.') };
    segs = [found];
  }
  if (!/\.html?$/i.test(segs[segs.length - 1]) || !fs.existsSync(path.join.apply(path, [root].concat(segs)))) {
    return { error: msg('srv.home.launcher.noMain', 'The start page appinfo.json names is not in the launcher.') };
  }
  var title = info && info.title;
  // Without an appinfo.json title, the start page's own <title>.
  if (!title) {
    var m = /<title[^>]*>([^<]*)<\/title>/i.exec(readHead(path.join.apply(path, [root].concat(segs))));
    if (m) title = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return { main: segs.join('/'), title: cleanTitle(title, fallbackTitle) };
}

function kindOf(head) {
  if (head.length >= 8 && head.toString('binary', 0, 8) === '!<arch>\n') return 'ipk';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  // A zip with nothing in it: the end record alone.
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip';
  if (/^(﻿)?\s*</.test(head.toString('utf8'))) return 'html';
  return null;
}

/*
 * Unpacks the upload at file to the owner's own launcher's folder, in place of
 * the one there, keeping whether it is chosen.
 */
function install(file, name, cb) {
  var id = OWN;
  var fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return cb(fail(e.message)); }
  var head = util.allocBuffer(512);
  var n = 0;
  try { n = fs.readSync(fd, head, 0, 512, 0); } catch (e) {}
  try { fs.closeSync(fd); } catch (e) {}
  var kind = kindOf(head.slice(0, n));
  if (!kind) return cb(fail(msg('srv.home.launcher.kind', 'Choose an .ipk, a .zip or an .html file.')));
  var fallbackTitle = cleanTitle(String(name || '').replace(/\.(ipk|zip|html?)$/i, ''), 'Custom launcher');
  var staging = path.join(dir, 'apps.new');
  try { rmTree(staging); util.mkdirp(staging); } catch (e) { return cb(fail(e.message)); }

  function finished(err, info) {
    if (err) {
      try { rmTree(staging); } catch (x) {}
      return cb(fail(err.userMessage || msg('srv.home.launcher.damaged', 'The file is damaged or not a launcher.')));
    }
    var root = staging;
    if (kind === 'ipk') {
      var web = (info.ids || []).filter(function (id) {
        var a = readAppinfo(path.join(staging, id));
        return a && NATIVE_TYPES.indexOf(String(a.type || '').toLowerCase()) === -1;
      });
      if (!web.length) {
        try { rmTree(staging); } catch (x) {}
        return cb(fail(info.ids && info.ids.length
          ? msg('srv.home.launcher.native', 'This launcher is a native app. Only web launchers can be used.')
          : msg('srv.home.launcher.noApp', 'The package holds no app.')));
      }
      root = path.join(staging, web[0]);
    }
    var d = describe(root, fallbackTitle);
    if (d.error) {
      try { rmTree(staging); } catch (x) {}
      return cb(fail(d.error));
    }
    var entry = { kind: 'app', title: d.title, main: d.main, files: info.files, bytes: info.bytes, source: OWN };
    try {
      keep(id, entry, root);
      if (root !== staging) rmTree(staging);
    } catch (e) { return cb(fail(e.message)); }
    console.log('home: custom launcher uploaded, ' + info.files + ' files');
    cb({ ok: true, launchers: status() });
  }

  if (kind === 'zip') return unpackZip(file, staging, finished);
  if (kind === 'ipk') return unpackIpk(file, staging, finished);
  try {
    fs.writeFileSync(path.join(staging, 'index.html'), fs.readFileSync(file));
    finished(null, { files: 1, bytes: fs.statSync(file).size });
  } catch (e) { finished(e); }
}

/*
 * An upload, as the dashboard sends it: the file's bytes with its size stated.
 * Saved to a file first rather than held in memory, then unpacked.
 */
function upload(req, name, cb) {
  function refused(text, code) { cb({ ok: false, error: text, status: code || 400 }); }
  var length = String(req.headers['content-length'] || '');
  if (req.headers['transfer-encoding'] || !/^\d{1,9}$/.test(length) || +length < 1) {
    return refused(msg('srv.home.launcher.length', 'The upload must state its size.'), 411);
  }
  if (+length > MAX_UPLOAD) return refused(msg('srv.home.launcher.uploadSize', 'A launcher can be at most 50 MB.'), 413);
  if (busy) return refused(msg('srv.home.launcher.busy', 'Wait for the launcher upload to finish.'), 409);
  busy = true;
  var part = path.join(dir, 'upload.part');
  var ended = false, finished = false, got = 0, ws = null;
  function finish(r) {
    if (finished) return;
    finished = true;
    if (ws) { try { ws.destroy(); } catch (e) {} }
    util.unlinkQuiet(part);
    busy = false;
    if (r) cb(r);
  }
  req.on('aborted', function () { if (!ended) finish(null); });
  req.on('close', function () { if (!ended) finish(null); });
  // Held until the free space is known, so nothing is lost meanwhile.
  if (typeof req.pause === 'function') req.pause();
  try { util.mkdirp(dir); } catch (e) { return finish({ ok: false, error: e.message, status: 500 }); }
  dfFn(dir, function (free) {
    if (finished) return;
    if (free === null || free < 2 * +length + 20 * 1024 * 1024) {
      return finish({ ok: false, error: msg('srv.home.launcher.space', 'There is not enough free space on the TV for this launcher.'), status: 507 });
    }
    ws = fs.createWriteStream(part, { mode: parseInt('600', 8) });
    ws.on('error', function (e) { finish({ ok: false, error: e.message, status: 500 }); });
    ws.on('finish', function () {
      if (finished) return;
      if (got !== +length) return finish({ ok: false, error: msg('srv.home.launcher.length', 'The upload must state its size.'), status: 400 });
      install(part, name, function (r) { finish(r); });
    });
    req.on('data', function (chunk) {
      if (finished) return;
      got += chunk.length;
      if (got > +length) return finish({ ok: false, error: msg('srv.home.launcher.length', 'The upload must state its size.'), status: 400 });
      if (!ws.write(chunk) && typeof req.pause === 'function') {
        req.pause();
        ws.once('drain', function () { if (!finished) req.resume(); });
      }
    });
    req.on('end', function () { ended = true; if (!finished) ws.end(); });
    if (typeof req.resume === 'function') req.resume();
  });
}

/* ------------------------------------------------------------ serving */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The script added first in the start page's head, so window.Glasshouse is there for the page's own.
function withKit(html) {
  var head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + kitTag + html.slice(head.index + head[0].length);
  var top = /<html(\s[^>]*)?>/i.exec(html);
  if (top) return html.slice(0, top.index + top[0].length) + kitTag + html.slice(top.index + top[0].length);
  var doctype = /^(﻿)?\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + kitTag + html.slice(doctype[0].length);
  return kitTag + html;
}

/*
 * What /home/launcher/<rel> answers, rel decoded already:
 * { redirect } to the start page, { body, type } for a page made here, or
 * { file, type, body? } for one of the launcher's files. Null is a 404.
 */
function resolve(rel) {
  var all = readMeta();
  var id = all.chosen;
  if (id && BUILTIN[id]) {
    if (rel && rel !== 'index.html') return null;
    var own;
    try { own = fs.readFileSync(path.join(assetsDir, BUILTIN[id].page), 'utf8'); } catch (e) { return null; }
    return { type: TYPES['.html'], body: withKit(own) };
  }
  var m = id ? all.launchers[id] : null;
  if (!m) return null;
  if (m.kind === 'web') {
    if (rel) return null;
    var page;
    try { page = fs.readFileSync(webPagePath, 'utf8'); } catch (e) { return null; }
    return { type: TYPES['.html'], body: page.replace(KIT_TAG_PLAIN, kitTag)
      .replace('src="about:blank" data-launcher', 'src="' + escapeHtml(m.address) + '" data-launcher') };
  }
  if (!rel) return { redirect: '/home/launcher/' + m.main.split('/').map(encodeURIComponent).join('/') };
  var segs = safeSegments(rel);
  if (!segs) return null;
  var file = path.join.apply(path, [appDir(id)].concat(segs));
  var st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  if (!st.isFile()) return null;
  var type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  if (segs.join('/') !== m.main) return { file: file, type: type };
  var html;
  try { html = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  return { type: TYPES['.html'], body: withKit(html) };
}

module.exports = {
  init: init,
  status: status,
  chosen: chosen,
  revision: revision,
  choose: choose,
  setAddress: setAddress,
  remove: remove,
  upload: upload,
  install: install,
  resolve: resolve,
  withKit: withKit,
  MAX_UPLOAD: MAX_UPLOAD
};
