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
var KINDS = { screensaver: true, launcher: true };
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
var stateDir = '/var/lib/tvweb';
var userSaversDir = '/var/lib/tvweb/screensavers';
var clock = Date.now;
var cache = null;   // { items: [...], fetchedAt, error }
var attempted = 0;
var waiting = null;
var busy = false;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.fetch) fetchLib = opts.fetch;
  if (opts.screensavers) screensaversModule = opts.screensavers;
  if (opts.homeLauncher) homeLauncherModule = opts.homeLauncher;
  if (opts.stateDir) stateDir = opts.stateDir;
  userSaversDir = opts.userSaversDir || (screensaversModule && screensaversModule.USER_SAVERS_DIR) || '/var/lib/tvweb/screensavers';
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
    var noFetch = { items: [], fetchedAt: 0, error: msg('srv.community.fetchMissing', 'Download helper is not available') };
    return cb(null, noFetch);
  }
  waiting = [cb];
  var urls = catalogUrls();
  var items = [], seen = {}, errors = [];
  (function next(i) {
    if (i >= urls.length) {
      var res = {
        items: items,
        fetchedAt: items.length || !errors.length ? clock() : (cache ? cache.fetchedAt : 0),
        error: errors.length ? errors[0] : null
      };
      attempted = clock();
      if (!errors.length || !cache || !cache.items.length) cache = res;
      else cache = { items: cache.items, fetchedAt: cache.fetchedAt, error: errors[0] };
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

function mergeItems(catalogItems, kindFilter) {
  var meta = readMeta();
  var savers = installedSaverMap();
  var launchers = installedLauncherMap();
  var out = [], seen = {};

  function build(entry, unlisted) {
    var id = entry.id, kind = entry.kind;
    var rec = meta[kind][id] || null;
    var installed = false, installedVersion = '', active = false, localId = '';
    var title = entry.title, description = entry.description, author = entry.author, sourceUrl = entry.sourceUrl || '';
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
    var updateAvailable = !!(installed && !unlisted && entry.version && installedVersion && cmpVer(entry.version, installedVersion) > 0);
    return {
      id: id,
      kind: kind,
      localId: localId,
      title: title,
      description: description,
      author: author || (rec && rec.author) || '',
      license: entry.license || (rec && rec.license) || '',
      version: entry.version || installedVersion,
      installedVersion: installed ? installedVersion : '',
      installed: installed,
      active: active,
      updateAvailable: updateAvailable,
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
      if (sRec.unlisted || sRec.version) {
        out.push(build({ id: sid, kind: 'screensaver', title: savers[sid].label, description: savers[sid].description,
          author: savers[sid].author || sRec.author || '', license: savers[sid].license || sRec.license || '',
          version: sRec.version || savers[sid].version || '', sourceUrl: sRec.sourceUrl || '' }, true));
      }
    }
  }
  if (!kindFilter || kindFilter === 'launcher') {
    for (var lid in launchers) {
      if (!Object.prototype.hasOwnProperty.call(launchers, lid) || seen['launcher:' + lid]) continue;
      var lRec = meta.launcher[lid] || {};
      out.push(build({ id: lid, kind: 'launcher', title: launchers[lid].title, description: '',
        author: launchers[lid].author || lRec.author || '', license: lRec.license || '',
        version: lRec.version || launchers[lid].version || '', sourceUrl: launchers[lid].sourceUrl || lRec.sourceUrl || '' }, true));
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
      items: mergeItems(snap.items, kind),
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

function installSaverArchive(id, archivePath, meta, cb) {
  if (!homeLauncherModule || !screensaversModule) {
    return cb({ ok: false, error: msg('srv.community.saverUnavailable', 'Screen saver installation is not available.') });
  }
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

  homeLauncherModule.unpackZip(archivePath, unpackDir, { maxFiles: MAX_SAVER_FILES, maxBytes: MAX_SAVER_BYTES }, function (err) {
    if (err) return fail(err.userMessage || err.message);
    var srcDir = unpackDir;
    if (!fs.existsSync(path.join(srcDir, 'saver.json'))) {
      var inner = findSingleSubdir(unpackDir);
      if (inner && fs.existsSync(path.join(inner, 'saver.json'))) srcDir = inner;
    }
    try { fs.renameSync(srcDir, candDir); }
    catch (e2) { return fail(e2.message); }

    var checked = screensaversModule.validateFolder(candDir, id);
    if (!checked.ok) return fail(checked.error || msg('srv.community.invalidSaver', 'This package is not a valid screen saver.'));

    var target = path.join(userSaversDir, id);
    var backup = target + '.old';
    try {
      util.mkdirp(userSaversDir);
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

    var stored = readMeta();
    stored.screensaver[id] = {
      id: id,
      version: meta.version || checked.saver.version || '',
      author: meta.author || checked.saver.author || '',
      license: meta.license || checked.saver.license || '',
      sourceUrl: meta.sourceUrl || '',
      unlisted: !!meta.unlisted,
      installedAt: clock()
    };
    writeMeta(stored);
    screensaversModule.invalidateCatalog();
    var localId = 'user-' + id;
    if (screensaversModule.stagedScreensaver() === localId || screensaversModule.screensaverMode() === localId) {
      screensaversModule.restageScreensaver();
    }
    cb({ ok: true, kind: 'screensaver', id: id, localId: localId });
  });
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

  var maxBytes = kind === 'screensaver' ? MAX_SAVER_BYTES * 2 : MAX_LAUNCHER_ZIP;
  fetchLib.download(downloadUrl, tmpFile, { maxBytes: maxBytes }, function (err) {
    if (err) return done({ ok: false, error: err.message });
    hashFile(tmpFile, function (hErr, gotSha) {
      if (hErr) return done({ ok: false, error: hErr.message });
      if (expectedSha && gotSha !== expectedSha) {
        return done({ ok: false, error: msg('srv.community.badHash', 'The downloaded package does not match the catalog checksum.') });
      }
      if (kind === 'screensaver') installSaverArchive(id, tmpFile, meta, done);
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
  if (!KINDS[kind]) return cb({ ok: false, error: msg('srv.community.badKind', 'Choose screensaver or launcher.') });
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
