/*
 * lib/catalog.js - Community catalog client and installer for screen savers and
 * custom launchers. Fetches validated JSON catalogs over HTTPS, checks
 * SHA-256 checksums before unpacking, verifies QML/web rules on-TV, and keeps
 * third-party add-ons isolated under /var/lib/tvweb/.
 *
 * Strict ES5: runs on node 0.12 (0.10 on webOS 2).
 */
var fs = require('fs');
var path = require('path');
var url = require('url');
var net = require('net');
var msg = require('./say').msg;
var util = require('./util');
var cmpVer = require('./installer').cmpVer;
var hashFile = require('./installer').hashFile;

var DEFAULT_CATALOG = 'https://rorygallagher2024.github.io/glasshouse-catalog/catalog.json';
var CACHE_MS = 3600000;
var RETRY_MS = 10000;
var ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
var SHA_RE = /^[0-9a-f]{64}$/;
var KINDS = { screensaver: true, launcher: true, nosignal: true };
var MAX_SAVER_FILES = 200;
var MAX_SAVER_BYTES = 5 * 1024 * 1024;
var MAX_LAUNCHER_ZIP = 50 * 1024 * 1024;

var config = {};
/** @type {typeof import('./fetch') | null} */
var fetchLib = null;
/** @type {typeof import('./screensavers') | null} */
var screensaversModule = null;
/** @type {typeof import('./home-launcher') | null} */
var homeLauncherModule = null;
/** @type {typeof import('./nosignal') | null} */
var nosignalModule = null;
var stateDir = '/var/lib/tvweb';
var userSaversDir = '/var/lib/tvweb/screensavers';
var userNoSignalsDir = '/var/lib/tvweb/nosignals';
var clock = Date.now;
var cache = null;   // { items: [...], revoked: {}, fetchedAt, error }
var attempted = 0;
var waiting = null;
var busy = false;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.fetch) fetchLib = opts.fetch;
  if (opts.screensavers) screensaversModule = opts.screensavers;
  if (opts.homeLauncher) homeLauncherModule = opts.homeLauncher;
  if (opts.nosignal) nosignalModule = opts.nosignal;
  if (opts.stateDir) stateDir = opts.stateDir;
  userSaversDir = opts.userSaversDir || (screensaversModule && screensaversModule.USER_SAVERS_DIR) || '/var/lib/tvweb/screensavers';
  userNoSignalsDir = opts.userNoSignalsDir || (nosignalModule && nosignalModule.USER_NOSIGNALS_DIR) || '/var/lib/tvweb/nosignals';
  clock = opts.now || Date.now;
  cache = null;
  attempted = 0;
  waiting = null;
  busy = false;
}

function metaFile() { return path.join(stateDir, 'community.json'); }

function readMeta() {
  var d = util.readJson(metaFile(), null);
  if (!d || typeof d !== 'object') d = {};
  if (!d.screensaver || typeof d.screensaver !== 'object') d.screensaver = {};
  if (!d.launcher || typeof d.launcher !== 'object') d.launcher = {};
  if (!d.nosignal || typeof d.nosignal !== 'object') d.nosignal = {};
  return d;
}

function writeMeta(m) {
  util.mkdirp(stateDir);
  util.writeJsonAtomic(metaFile(), m, 384);
}

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    var entries = fs.readdirSync(p);
    for (var i = 0; i < entries.length; i++) rmTree(path.join(p, entries[i]));
    fs.rmdirSync(p);
  } else util.unlinkQuiet(p);
}

function catalogUrls() {
  var list = [DEFAULT_CATALOG];
  var extra = config.community && config.community.catalogs;
  if (Object.prototype.toString.call(extra) === '[object Array]') {
    for (var i = 0; i < extra.length; i++) {
      if (typeof extra[i] === 'string' && list.indexOf(extra[i]) < 0) list.push(extra[i]);
    }
  }
  return list;
}

function safeHttpsUrl(value) {
  if (!fetchLib || typeof value !== 'string') return '';
  if (fetchLib.validateUrl(value) || value.slice(0, 8).toLowerCase() !== 'https://') return '';
  if (value.indexOf('\\') !== -1) return '';
  try {
    var authority = value.slice(8).split(/[\/?#]/)[0];
    var parsed = url.parse('https://' + authority);
    if (!parsed.hostname || parsed.auth !== null || parsed.pathname !== '/' || Number(parsed.port) > 65535) return '';
    var last = parsed.hostname.split('.').filter(Boolean).pop();
    var num = /^[0-9]+$/.test(last) || /^0x[0-9a-f]+$/i.test(last);
    if ((authority.charAt(0) === '[' || num) && !net.isIP(parsed.hostname)) return '';
    return value;
  } catch (e) {
    return '';
  }
}

function manifestText(v) {
  if (typeof v === 'string' && v) return { en: v };
  if (v && typeof v === 'object' && typeof v.en === 'string' && v.en) return v;
  return null;
}

function pickLocalized(map) {
  if (!map || typeof map !== 'object') return typeof map === 'string' ? map : '';
  return map.en || '';
}

function parseEntry(raw, baseUrl) {
  if (!raw || typeof raw !== 'object') return null;
  var kind = raw.kind;
  var id = typeof raw.id === 'string' ? raw.id : '';
  if (!KINDS[kind] || !ID_RE.test(id)) return null;
  var name = manifestText(raw.name);
  var desc = manifestText(raw.description);
  var author = typeof raw.author === 'string' ? raw.author.trim() : '';
  var license = typeof raw.license === 'string' ? raw.license.trim() : '';
  var version = typeof raw.version === 'string' ? raw.version.trim() : '';
  var sha = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (!name || !desc || !author || !license || !version || !SHA_RE.test(sha)) return null;
  var dl = typeof raw.downloadUrl === 'string' ? url.resolve(baseUrl, raw.downloadUrl.trim()) : '';
  if (!safeHttpsUrl(dl)) return null;
  var src = typeof raw.sourceUrl === 'string' ? safeHttpsUrl(raw.sourceUrl.trim()) : '';
  var prev = typeof raw.previewUrl === 'string' ? safeHttpsUrl(url.resolve(baseUrl, raw.previewUrl.trim())) : '';
  return {
    id: id,
    kind: kind,
    nameMap: name,
    title: pickLocalized(name),
    descMap: desc,
    description: pickLocalized(desc),
    author: author,
    license: license,
    version: version,
    downloadUrl: dl,
    sha256: sha,
    size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : null,
    sourceUrl: src,
    previewUrl: prev,
    requires: raw.requires && typeof raw.requires === 'object' ? raw.requires : undefined
  };
}

function fetchCatalogs(force, cb) {
  var now = clock();
  if (!force && cache) {
    var ttl = cache.error ? RETRY_MS : CACHE_MS;
    if (cache.fetchedAt && now - cache.fetchedAt < ttl) return cb(null, cache);
    if (!cache.fetchedAt && attempted && now - attempted < ttl) return cb(null, cache);
  }
  if (waiting) return waiting.push(cb);
  if (!fetchLib) {
    var noFetch = { items: [], revoked: {}, fetchedAt: 0, error: msg('srv.community.fetchMissing', 'Download helper is not available') };
    return cb(null, noFetch);
  }
  waiting = [cb];
  var urls = catalogUrls();
  var items = [], revoked = {}, seen = {}, errors = [];
  (function next(i) {
    if (i >= urls.length) {
      var res = {
        items: items,
        revoked: revoked,
        fetchedAt: items.length || !errors.length ? clock() : (cache ? cache.fetchedAt : 0),
        error: errors.length ? errors[0] : null
      };
      attempted = clock();
      if (!errors.length || !cache || !cache.items.length) cache = res;
      else cache = { items: cache.items, revoked: cache.revoked || {}, fetchedAt: cache.fetchedAt, error: errors[0] };
      var cbs = waiting;
      waiting = null;
      for (var j = 0; j < cbs.length; j++) cbs[j](null, cache);
      return;
    }
    var u = urls[i];
    fetchLib.getJson(u, function (err, doc) {
      if (err) {
        errors.push(err.message);
        return next(i + 1);
      }
      var rawItems = doc && Object.prototype.toString.call(doc.items) === '[object Array]' ? doc.items : null;
      if (!rawItems) {
        errors.push(msg('srv.community.badCatalog', 'Catalog format could not be read.'));
        return next(i + 1);
      }
      for (var k = 0; k < rawItems.length; k++) {
        var parsed = parseEntry(rawItems[k], u);
        if (!parsed) continue;
        var key = parsed.kind + ':' + parsed.id;
        if (!seen[key]) { seen[key] = true; items.push(parsed); }
      }
      var rawRevoked = doc && Object.prototype.toString.call(doc.revoked) === '[object Array]' ? doc.revoked : [];
      for (var r = 0; r < rawRevoked.length; r++) {
        var rev = rawRevoked[r];
        if (!rev || typeof rev !== 'object' || !KINDS[rev.kind] || !ID_RE.test(String(rev.id || ''))) continue;
        var rKey = rev.kind + ':' + rev.id;
        if (!revoked[rKey]) {
          revoked[rKey] = {
            kind: rev.kind,
            id: rev.id,
            reason: typeof rev.reason === 'string' ? rev.reason.trim() : ''
          };
        }
      }
      next(i + 1);
    });
  })(0);
}

function installedLauncherMap() {
  var out = {};
  if (!homeLauncherModule) return out;
  var st = homeLauncherModule.status();
  var list = (st && st.launchers) || [];
  for (var i = 0; i < list.length; i++) {
    var l = list[i];
    if (l && l.id && l.id.indexOf('community-') === 0) {
      out[l.id.slice('community-'.length)] = l;
    }
  }
  return out;
}

function installedSaverMap() {
  var out = {};
  if (screensaversModule) {
    var list = screensaversModule.screensaverList().modes || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m && m.id && m.id.indexOf('user-') === 0) out[m.id.slice(5)] = m;
    }
  }
  return out;
}

function installedNoSignalMap() {
  var out = {};
  if (nosignalModule) {
    var st = nosignalModule.status();
    var list = (st && st.customScreens) || [];
    var curMode = st && st.mode;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s && s.id) {
        out[s.id] = {
          id: s.id,
          label: s.label,
          description: s.description,
          author: s.author,
          license: s.license,
          version: s.version,
          active: curMode === s.localId
        };
      }
    }
  }
  return out;
}

function mergeItems(catalogItems, kindFilter, revokedMap) {
  var meta = readMeta();
  var savers = installedSaverMap();
  var launchers = installedLauncherMap();
  var nosignals = installedNoSignalMap();
  var out = [], seen = {};

  function build(entry, unlisted) {
    var id = entry.id, kind = entry.kind;
    var rec = (meta[kind] && meta[kind][id]) || null;
    var installed = false, installedVersion = '', active = false, localId = '';
    var title = entry.title, description = entry.description, author = entry.author;
    var license = entry.license || '', sourceUrl = entry.sourceUrl || '';
    if (kind === 'screensaver') {
      localId = 'user-' + id;
      var s = savers[id] || null;
      installed = !!s && fs.existsSync(path.join(userSaversDir, id));
      if (installed) {
        installedVersion = s.version || (rec && rec.version) || '';
        active = !!s.active;
        if (unlisted) {
          title = s.label || title;
          description = s.description || description;
          author = s.author || author;
          license = s.license || license;
        }
      }
    } else if (kind === 'nosignal') {
      localId = 'user-' + id;
      var ns = nosignals[id] || null;
      installed = !!ns && fs.existsSync(path.join(userNoSignalsDir, id));
      if (installed) {
        installedVersion = ns.version || (rec && rec.version) || '';
        active = !!ns.active;
        if (unlisted) {
          title = ns.label || title;
          description = ns.description || description;
          author = ns.author || author;
          license = ns.license || license;
        }
      }
    } else {
      localId = 'community-' + id;
      var l = launchers[id] || null;
      installed = !!l;
      if (installed) {
        installedVersion = l.version || (rec && rec.version) || '';
        active = !!l.chosen;
        if (unlisted) {
          title = l.title || title;
          author = l.author || author;
          sourceUrl = l.sourceUrl || sourceUrl;
        }
      }
    }
    var rev = (revokedMap && revokedMap[kind + ':' + id]) || null;
    var updateAvailable = !rev && !!(installed && !unlisted && entry.version && installedVersion && cmpVer(entry.version, installedVersion) > 0);
    return {
      id: id,
      kind: kind,
      localId: localId,
      title: title,
      description: description,
      author: author || (rec && rec.author) || '',
      license: license || (rec && rec.license) || '',
      version: entry.version || installedVersion,
      installedVersion: installed ? installedVersion : '',
      installed: installed,
      active: active,
      updateAvailable: updateAvailable,
      revoked: !!rev,
      revokedReason: rev ? rev.reason : '',
      unlisted: !!unlisted,
      sourceUrl: sourceUrl || (rec && rec.sourceUrl) || '',
      previewUrl: entry.previewUrl || '',
      size: entry.size || null
    };
  }

  for (var i = 0; i < catalogItems.length; i++) {
    var it = catalogItems[i];
    if (kindFilter && it.kind !== kindFilter) continue;
    seen[it.kind + ':' + it.id] = true;
    out.push(build(it, false));
  }

  if (!kindFilter || kindFilter === 'screensaver') {
    for (var sid in savers) {
      if (!Object.prototype.hasOwnProperty.call(savers, sid) || seen['screensaver:' + sid]) continue;
      if (!fs.existsSync(path.join(userSaversDir, sid))) continue;
      var sRec = meta.screensaver[sid] || {};
      var sRev = revokedMap && revokedMap['screensaver:' + sid];
      if (sRec.unlisted || sRec.version || sRev) {
        out.push(build({ id: sid, kind: 'screensaver', title: savers[sid].label, description: savers[sid].description,
          author: savers[sid].author || sRec.author || '', license: savers[sid].license || sRec.license || '',
          version: sRec.version || savers[sid].version || '', sourceUrl: sRec.sourceUrl || '' }, !(sRev && !sRec.unlisted)));
      }
    }
  }
  if (!kindFilter || kindFilter === 'nosignal') {
    for (var nid in nosignals) {
      if (!Object.prototype.hasOwnProperty.call(nosignals, nid) || seen['nosignal:' + nid]) continue;
      if (!fs.existsSync(path.join(userNoSignalsDir, nid))) continue;
      var nRec = meta.nosignal[nid] || {};
      var nRev = revokedMap && revokedMap['nosignal:' + nid];
      if (nRec.unlisted || nRec.version || nRev) {
        out.push(build({ id: nid, kind: 'nosignal', title: nosignals[nid].label, description: nosignals[nid].description,
          author: nosignals[nid].author || nRec.author || '', license: nosignals[nid].license || nRec.license || '',
          version: nRec.version || nosignals[nid].version || '', sourceUrl: nRec.sourceUrl || '' }, !(nRev && !nRec.unlisted)));
      }
    }
  }
  if (!kindFilter || kindFilter === 'launcher') {
    for (var lid in launchers) {
      if (!Object.prototype.hasOwnProperty.call(launchers, lid) || seen['launcher:' + lid]) continue;
      var lRec = meta.launcher[lid] || {};
      var lRev = revokedMap && revokedMap['launcher:' + lid];
      out.push(build({ id: lid, kind: 'launcher', title: launchers[lid].title, description: '',
        author: launchers[lid].author || lRec.author || '', license: lRec.license || '',
        version: lRec.version || launchers[lid].version || '', sourceUrl: launchers[lid].sourceUrl || lRec.sourceUrl || '' }, !(lRev && !lRec.unlisted)));
    }
  }
  return out;
}

function urlInstallAllowed(via) {
  return !!(config && config.allowControl && (via || (config.apps && config.apps.sideload === true) || config.token));
}

function list(opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  var kind = opts.kind && KINDS[opts.kind] ? opts.kind : null;
  fetchCatalogs(!!opts.refresh, function (err, snap) {
    if (err) return cb({ ok: false, error: err.message });
    cb({
      ok: true,
      items: mergeItems(snap.items, kind, snap.revoked),
      fetchedAt: snap.fetchedAt,
      installedOnly: !!(snap.error && !snap.items.length),
      error: snap.error || null,
      writable: !!(config && config.allowControl),
      urlInstallAllowed: urlInstallAllowed(opts.sideloadVia)
    });
  });
}

function findSingleSubdir(root) {
  var entries = fs.readdirSync(root).filter(function (n) { return n.charAt(0) !== '.' && n !== '__MACOSX'; });
  if (entries.length !== 1) return null;
  var sub = path.join(root, entries[0]);
  try {
    return fs.statSync(sub).isDirectory() ? sub : null;
  } catch (e) { return null; }
}

function installQMLPackageArchive(opts, cb) {
  if (!homeLauncherModule || !opts.available) {
    return cb({ ok: false, error: opts.unavailableMsg });
  }
  var id = opts.id;
  var tmpRoot = path.join(stateDir, '.community-stage');
  var unpackDir = path.join(tmpRoot, 'unpack');
  var candParent = path.join(tmpRoot, 'validate');
  var candDir = path.join(candParent, id);
  try { rmTree(tmpRoot); util.mkdirp(unpackDir); util.mkdirp(candParent); }
  catch (e) { return cb({ ok: false, error: e.message }); }

  function fail(text) {
    try { rmTree(tmpRoot); } catch (x) {}
    cb({ ok: false, error: text });
  }

  homeLauncherModule.unpackZip(opts.archivePath, unpackDir, { maxFiles: MAX_SAVER_FILES, maxBytes: MAX_SAVER_BYTES }, function (err) {
    if (err) return fail(err.userMessage || err.message);
    var srcDir = unpackDir;
    if (!fs.existsSync(path.join(srcDir, opts.manifestName))) {
      var inner = findSingleSubdir(unpackDir);
      if (inner && fs.existsSync(path.join(inner, opts.manifestName))) srcDir = inner;
    }
    try { fs.renameSync(srcDir, candDir); }
    catch (e2) { return fail(e2.message); }

    var checked = opts.validateFn(candDir, id);
    if (!checked.ok) return fail(checked.error || opts.invalidMsg);

    var target = path.join(opts.targetDir, id);
    var backup = target + '.old';
    try {
      util.mkdirp(opts.targetDir);
      rmTree(backup);
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(candDir, target);
      rmTree(backup);
      rmTree(tmpRoot);
    } catch (e3) {
      if (!fs.existsSync(target) && fs.existsSync(backup)) {
        try { fs.renameSync(backup, target); } catch (x) {}
      }
      return fail(e3.message);
    }

    var itemMeta = checked.entry || {};
    var stored = readMeta();
    stored[opts.storeKey][id] = {
      id: id,
      version: opts.meta.version || itemMeta.version || '',
      author: opts.meta.author || itemMeta.author || '',
      license: opts.meta.license || itemMeta.license || '',
      sourceUrl: opts.meta.sourceUrl || '',
      unlisted: !!opts.meta.unlisted,
      installedAt: clock()
    };
    writeMeta(stored);
    var localId = 'user-' + id;
    opts.onInstalled(localId);
    cb({ ok: true, kind: opts.kind, id: id, localId: localId });
  });
}

function installSaverArchive(id, archivePath, meta, cb) {
  installQMLPackageArchive({
    kind: 'screensaver',
    id: id,
    archivePath: archivePath,
    meta: meta,
    targetDir: userSaversDir,
    manifestName: 'saver.json',
    storeKey: 'screensaver',
    available: !!screensaversModule,
    unavailableMsg: msg('srv.community.saverUnavailable', 'Screen saver installation is not available.'),
    invalidMsg: msg('srv.community.invalidSaver', 'This package is not a valid screen saver.'),
    validateFn: function (candDir, pkgId) {
      var res = screensaversModule.validateFolder(candDir, pkgId);
      return { ok: res.ok, entry: res.saver, error: res.error };
    },
    onInstalled: function (localId) {
      screensaversModule.invalidateCatalog();
      if (screensaversModule.stagedScreensaver() === localId || screensaversModule.screensaverMode() === localId) {
        screensaversModule.restageScreensaver();
      }
    }
  }, cb);
}

function installNoSignalArchive(id, archivePath, meta, cb) {
  installQMLPackageArchive({
    kind: 'nosignal',
    id: id,
    archivePath: archivePath,
    meta: meta,
    targetDir: userNoSignalsDir,
    manifestName: 'nosignal.json',
    storeKey: 'nosignal',
    available: !!nosignalModule,
    unavailableMsg: msg('srv.community.nosignalUnavailable', 'No Signal screen installation is not available.'),
    invalidMsg: msg('srv.community.invalidNoSignal', 'This package is not a valid No Signal screen.'),
    validateFn: function (candDir, pkgId) {
      var res = nosignalModule.validateFolder(candDir, pkgId);
      return { ok: res.ok, entry: res.screen, error: res.error };
    },
    onInstalled: function (localId) {
      nosignalModule.invalidateCatalog();
      if (nosignalModule.status().mode === localId) {
        nosignalModule.apply();
      }
    }
  }, cb);
}

function installLauncherArchive(id, archivePath, meta, cb) {
  if (!homeLauncherModule) {
    return cb({ ok: false, error: msg('srv.community.launcherUnavailable', 'Launcher installation is not available.') });
  }
  homeLauncherModule.install(archivePath, id + '.zip', {
    id: 'community-' + id,
    source: 'community',
    title: meta.title || id,
    author: meta.author || '',
    version: meta.version || '',
    sourceUrl: meta.sourceUrl || ''
  }, function (r) {
    if (!r || !r.ok) return cb(r || { ok: false, error: msg('srv.home.launcher.damaged', 'The file is damaged or not a launcher.') });
    var stored = readMeta();
    stored.launcher[id] = {
      id: id,
      version: meta.version || '',
      author: meta.author || '',
      license: meta.license || '',
      sourceUrl: meta.sourceUrl || '',
      unlisted: !!meta.unlisted,
      installedAt: clock()
    };
    writeMeta(stored);
    cb({ ok: true, kind: 'launcher', id: id, localId: 'community-' + id, launchers: r.launchers });
  });
}

function downloadAndInstall(kind, id, downloadUrl, expectedSha, meta, cb) {
  if (!fetchLib) return cb({ ok: false, error: msg('srv.community.fetchMissing', 'Download helper is not available') });
  var tmpDir = path.join(stateDir, '.community-tmp');
  var tmpFile = path.join(tmpDir, kind + '-' + id + '.download');
  try { util.mkdirp(tmpDir); util.unlinkQuiet(tmpFile); } catch (e) { return cb({ ok: false, error: e.message }); }

  function done(r) {
    util.unlinkQuiet(tmpFile);
    cb(r);
  }

  var maxBytes = kind === 'launcher' ? MAX_LAUNCHER_ZIP : MAX_SAVER_BYTES * 2;
  fetchLib.download(downloadUrl, tmpFile, { maxBytes: maxBytes }, function (err) {
    if (err) return done({ ok: false, error: err.message });
    hashFile(tmpFile, function (hErr, gotSha) {
      if (hErr) return done({ ok: false, error: hErr.message });
      if (expectedSha && gotSha !== expectedSha) {
        return done({ ok: false, error: msg('srv.community.badHash', 'The downloaded package does not match the catalog checksum.') });
      }
      if (kind === 'screensaver') installSaverArchive(id, tmpFile, meta, done);
      else if (kind === 'nosignal') installNoSignalArchive(id, tmpFile, meta, done);
      else installLauncherArchive(id, tmpFile, meta, done);
    });
  });
}

function installFromCatalog(kind, id, cb) {
  if (!config || !config.allowControl) return cb({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') });
  if (!KINDS[kind] || !ID_RE.test(String(id || ''))) {
    return cb({ ok: false, error: msg('srv.community.unknown', 'Unknown community item.') });
  }
  if (busy) return cb({ ok: false, error: msg('srv.community.busy', 'Wait for the current installation to finish.') });
  busy = true;
  function finish(r) { busy = false; cb(r); }

  fetchCatalogs(false, function (err, snap) {
    if (err) return finish({ ok: false, error: err.message });
    if (snap.revoked && snap.revoked[kind + ':' + id]) {
      return finish({ ok: false, error: msg('srv.community.revoked', 'This community add-on has been removed for safety reasons.') });
    }
    var entry = null;
    for (var i = 0; i < snap.items.length; i++) {
      if (snap.items[i].kind === kind && snap.items[i].id === id) { entry = snap.items[i]; break; }
    }
    if (!entry) return finish({ ok: false, error: msg('srv.community.unknown', 'Unknown community item.') });
    downloadAndInstall(kind, id, entry.downloadUrl, entry.sha256, {
      title: entry.title,
      author: entry.author,
      version: entry.version,
      license: entry.license,
      sourceUrl: entry.sourceUrl,
      unlisted: false
    }, finish);
  });
}

function slugOf(text, fallback) {
  var s = String(text || '').toLowerCase().replace(/\.(zip|ipk|git)$/i, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!ID_RE.test(s)) return fallback || 'custom';
  return s;
}

function resolveGithubDownload(repoOwner, repoName, kind, cb) {
  var apiUrl = 'https://api.github.com/repos/' + encodeURIComponent(repoOwner) + '/' + encodeURIComponent(repoName) + '/releases/latest';
  var zipFallback = 'https://codeload.github.com/' + encodeURIComponent(repoOwner) + '/' + encodeURIComponent(repoName) + '/zip/HEAD';
  fetchLib.getJson(apiUrl, function (err, rel) {
    if (!err && rel && Object.prototype.toString.call(rel.assets) === '[object Array]') {
      for (var i = 0; i < rel.assets.length; i++) {
        var a = rel.assets[i];
        var n = a && typeof a.name === 'string' ? a.name.toLowerCase() : '';
        var u = a && typeof a.browser_download_url === 'string' ? safeHttpsUrl(a.browser_download_url) : '';
        if (u && (/\.zip$/.test(n) || (kind === 'launcher' && /\.ipk$/.test(n)))) {
          return cb(u, typeof rel.tag_name === 'string' ? rel.tag_name.replace(/^v/i, '') : '');
        }
      }
    }
    cb(zipFallback, '');
  });
}

function installFromUrl(kind, rawUrl, cb) {
  if (!config || !config.allowControl) return cb({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') });
  if (!KINDS[kind]) return cb({ ok: false, error: msg('srv.community.badKind', 'Choose screensaver, launcher or nosignal.') });
  var safe = safeHttpsUrl(typeof rawUrl === 'string' ? rawUrl.trim() : '');
  if (!safe) return cb({ ok: false, error: msg('srv.community.badUrl', 'Give an https:// link to a GitHub repository or archive.') });
  if (busy) return cb({ ok: false, error: msg('srv.community.busy', 'Wait for the current installation to finish.') });
  if (!fetchLib) return cb({ ok: false, error: msg('srv.community.fetchMissing', 'Download helper is not available') });
  busy = true;
  function finish(r) { busy = false; cb(r); }

  var gh = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(safe);
  if (gh) {
    var owner = gh[1], repoName = gh[2];
    var id = slugOf(repoName, 'custom');
    return resolveGithubDownload(owner, repoName, kind, function (dlUrl, ver) {
      downloadAndInstall(kind, id, dlUrl, null, {
        title: repoName,
        author: owner,
        version: ver,
        sourceUrl: 'https://github.com/' + owner + '/' + repoName,
        unlisted: true
      }, finish);
    });
  }

  var pathname = url.parse(safe).pathname || '';
  var base = path.basename(pathname) || 'custom';
  var directId = slugOf(base, 'custom');
  downloadAndInstall(kind, directId, safe, null, {
    title: directId,
    author: '',
    version: '',
    sourceUrl: safe,
    unlisted: true
  }, finish);
}

function remove(kind, id, cb) {
  if (!config || !config.allowControl) return cb({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') });
  if (!KINDS[kind] || !ID_RE.test(String(id || ''))) {
    return cb({ ok: false, error: msg('srv.community.unknown', 'Unknown community item.') });
  }
  if (busy) return cb({ ok: false, error: msg('srv.community.busy', 'Wait for the current installation to finish.') });
  busy = true;
  function finish(r) { busy = false; cb(r); }

  if (kind === 'launcher') {
    if (!homeLauncherModule) return finish({ ok: false, error: msg('srv.community.launcherUnavailable', 'Launcher installation is not available.') });
    return homeLauncherModule.remove('community-' + id, function (r) {
      if (r && r.ok) {
        var stored = readMeta();
        delete stored.launcher[id];
        writeMeta(stored);
      }
      finish(r);
    });
  }

  var localId = 'user-' + id;
  if (kind === 'nosignal') {
    var nsTarget = path.join(userNoSignalsDir, id);
    function wipeNoSignal() {
      try { rmTree(nsTarget); } catch (e) { return finish({ ok: false, error: e.message }); }
      var stored = readMeta();
      delete stored.nosignal[id];
      writeMeta(stored);
      if (nosignalModule) nosignalModule.invalidateCatalog();
      finish({ ok: true, kind: 'nosignal', id: id });
    }
    if (nosignalModule && nosignalModule.status().mode === localId) {
      return nosignalModule.set('lg', function () {
        wipeNoSignal();
      });
    }
    return wipeNoSignal();
  }

  var target = path.join(userSaversDir, id);
  function wipeFolder() {
    try { rmTree(target); } catch (e) { return finish({ ok: false, error: e.message }); }
    var stored = readMeta();
    delete stored.screensaver[id];
    writeMeta(stored);
    if (screensaversModule) screensaversModule.invalidateCatalog();
    finish({ ok: true, kind: 'screensaver', id: id });
  }

  if (screensaversModule && (screensaversModule.screensaverMode() === localId || screensaversModule.stagedScreensaver() === localId)) {
    return screensaversModule.setScreensaver('stock', 'dim', function (r) {
      if (!r || !r.ok) return finish({ ok: false, error: (r && r.error) || 'could not switch off screen saver' });
      wipeFolder();
    });
  }
  wipeFolder();
}

module.exports = {
  init: init,
  list: list,
  installFromCatalog: installFromCatalog,
  installFromUrl: installFromUrl,
  remove: remove,
  DEFAULT_CATALOG: DEFAULT_CATALOG
};
