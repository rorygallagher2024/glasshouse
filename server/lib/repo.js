// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
// The Homebrew Channel catalog, merged with what is installed on the TV.
var url = require('url');
var msg = require('./say').msg;
var PROTECTED_APP_IDS = require('./apps').PROTECTED_APP_IDS;
var SELF_UPDATING = require('./installer').SELF_UPDATING;
var NAME_RE = require('./installer').NAME_RE;
var cmpVer = require('./installer').cmpVer;

var DEFAULT_REPO = 'https://repo.webosbrew.org/api/apps.json';
var MAX_PAGES = 50;
var CACHE_MS = 3600000;
// A failure is never remembered for longer than this, whatever the cache age,
// so one timeout does not leave the tab saying "unavailable" for an hour.
var RETRY_MS = 10000;
var config = {};
var lunaFn = null;
/** @type {typeof import('./fetch')} */
var fetchLib = null;
var cache = null;       // { apps: [...], fetchedAt, error }
var attempted = 0;      // when the last fetch ended
var clock = Date.now;
var waiting = null;     // callbacks for the fetch in flight

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.luna) lunaFn = opts.luna;
  if (opts.fetch) fetchLib = opts.fetch;
  clock = opts.now || Date.now;
  cache = null;
  attempted = 0;
}

function repoUrls() {
  var list = [DEFAULT_REPO];
  var extra = config.apps && config.apps.repos;
  if (Object.prototype.toString.call(extra) === '[object Array]') {
    for (var i = 0; i < extra.length; i++) {
      if (typeof extra[i] === 'string' && list.indexOf(extra[i]) < 0) list.push(extra[i]);
    }
  }
  return list;
}

// Page 1 is apps.json, page n is apps/n.json beside it.
function pageUrl(base, n) {
  return n <= 1 ? base : base.replace(/\.json$/, '') + '/' + n + '.json';
}

function stringOrEmpty(v) { return typeof v === 'string' ? v : ''; }

function parsePackage(item, pageBase) {
  if (!item || typeof item !== 'object') return null;
  var m = item.manifest;
  if (!m || typeof m !== 'object') return null;
  var id = stringOrEmpty(item.id) || stringOrEmpty(m.id);
  var version = stringOrEmpty(m.version);
  var hash = m.ipkHash && stringOrEmpty(m.ipkHash.sha256).toLowerCase();
  // The installer's own rule for a package name: an id it would refuse, or one
  // carrying characters the dashboards would have to escape, is not listed.
  if (!NAME_RE.test(id)) return null;
  if (!version || !m.ipkUrl || !hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  // The manifest's own ipkUrl may be a file name beside the manifest.
  var ipkUrl = url.resolve(stringOrEmpty(item.manifestUrl) || pageBase, stringOrEmpty(m.ipkUrl));
  if (!/^https:\/\//i.test(ipkUrl)) return null;
  var icon = stringOrEmpty(item.iconUri) || stringOrEmpty(m.iconUri);
  var size = (typeof m.ipkSize === 'number' && m.ipkSize > 0) ? m.ipkSize
           : (typeof item.ipkSize === 'number' && item.ipkSize > 0) ? item.ipkSize
           : (typeof m.size === 'number' && m.size > 0) ? m.size
           : null;
  return {
    id: id,
    title: stringOrEmpty(item.title) || stringOrEmpty(m.title) || id,
    description: stringOrEmpty(item.shortDescription) || stringOrEmpty(m.appDescription),
    iconUri: /^https:\/\//i.test(icon) ? icon : '',
    version: version,
    ipkUrl: ipkUrl,
    sha256: hash,
    size: size,
    rootRequired: m.rootRequired === true ? true : m.rootRequired === 'optional' ? 'optional' : false
  };
}

// cb(err, apps) for one repository, following its pages.
function fetchRepo(base, cb) {
  var apps = [];
  (function page(n) {
    var u = pageUrl(base, n);
    fetchLib.getJson(u, function (err, doc) {
      if (err) return cb(err);
      var list = doc && doc.packages;
      if (!doc || Object.prototype.toString.call(list) !== '[object Array]') {
        return cb(new Error(msg('srv.repo.notCatalog', 'not a package catalog: {url}', { url: u })));
      }
      for (var i = 0; i < list.length; i++) {
        var p = parsePackage(list[i], u);
        // Only the Homebrew Channel's own catalog is vetted. An apps.repos
        // catalog is trusted to list packages, not to have them run as root.
        if (p) { p.vetted = base === DEFAULT_REPO; apps.push(p); }
      }
      var max = parseInt(doc.paging && doc.paging.maxPage, 10) || 1;
      if (n < max && n < MAX_PAGES) return page(n + 1);
      cb(null, apps);
    });
  })(1);
}

function fetchAll(cb) {
  var urls = repoUrls(), i = 0, byId = {}, apps = [], errors = [], okCount = 0;
  (function next() {
    if (i >= urls.length) {
      if (!okCount) return cb(new Error(errors.join('; ')));
      return cb(null, apps, errors.length ? errors.join('; ') : null);
    }
    var base = urls[i++];
    fetchRepo(base, function (err, list) {
      if (err) {
        errors.push(err.message);
        return next();
      }
      okCount++;
      for (var k = 0; k < list.length; k++) {
        if (byId[list[k].id]) continue;
        byId[list[k].id] = 1;
        apps.push(list[k]);
      }
      next();
    });
  })();
}

function isHbc(id) {
  return SELF_UPDATING.indexOf(id) >= 0 || !!PROTECTED_APP_IDS[id];
}

function withInstalled(apps, installed) {
  var out = [];
  for (var i = 0; i < apps.length; i++) {
    var a = {};
    for (var k in apps[i]) a[k] = apps[i][k];
    var have = installed[a.id];
    a.installedVersion = have === undefined ? null : have;
    if (isHbc(a.id)) a.state = 'hbc';
    else if (have === undefined) a.state = 'none';
    // The preview's own comparison, so the list and the preview agree: the
    // updater's stops at four parts and drops anything after a hyphen.
    else a.state = cmpVer(a.version, have) > 0 ? 'update' : 'installed';
    out.push(a);
  }
  return out;
}

function listInstalled(cb) {
  if (!lunaFn) return cb({});
  lunaFn('com.webos.applicationManager/listApps', {}, function (res) {
    var raw = (res && res.apps) || [];
    var map = {};
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && raw[i].id) map[raw[i].id] = String(raw[i].version || '');
    }
    cb(map);
  });
}

function reply(cb) {
  listInstalled(function (installed) {
    var r = { ok: !!cache.apps, apps: withInstalled(cache.apps || [], installed), fetchedAt: cache.fetchedAt };
    if (cache.error) r.error = cache.error;
    cb(r);
  });
}

/*
 * `force` shortens the cache rather than removing it, as the updater's check
 * does, so a tab being opened repeatedly does not hit the catalog each time.
 */
function getCatalog(force, cb) {
  var minAge = typeof force === 'number' ? force : force ? 10000 : CACHE_MS;
  var now = clock();
  // No list, or the last attempt failed in whole or in part: retry soon.
  var failed = !cache || !cache.apps || !!cache.error;
  if (!failed && now - cache.fetchedAt < minAge) return reply(cb);
  if (waiting) { waiting.push(cb); return; }
  // A failed attempt stands for a short time, so an offline TV is not retried per request.
  if (cache && attempted && now - attempted < Math.min(minAge, failed ? RETRY_MS : minAge)) return reply(cb);
  if (!fetchLib) return cb({ ok: false, apps: [], fetchedAt: 0, error: 'no fetch module configured' });

  waiting = [cb];
  fetchAll(function (err, apps, partial) {
    attempted = clock();
    if (err) {
      // Keep the last good list, if there is one, and say why it is old.
      cache = cache && cache.apps ? { apps: cache.apps, fetchedAt: cache.fetchedAt, error: err.message }
                                  : { apps: null, fetchedAt: 0, error: err.message };
    } else {
      cache = { apps: apps, fetchedAt: attempted, error: partial };
    }
    var cbs = waiting;
    waiting = null;
    var done = 0;
    reply(function (r) {
      // One merge answers every caller that queued behind the fetch.
      if (done++) return;
      for (var i = 0; i < cbs.length; i++) cbs[i](r);
    });
  });
}

function findPackage(id, cb) {
  getCatalog(false, function (r) {
    if (!r.ok) return cb(new Error(r.error || msg('srv.repo.unavailable', 'catalog unavailable')));
    for (var i = 0; i < r.apps.length; i++) {
      if (r.apps[i].id === id) return cb(null, r.apps[i]);
    }
    cb(new Error(msg('srv.repo.notInCatalog', 'not in the catalog: {id}', { id: id })));
  });
}

module.exports = {
  init: init,
  getCatalog: getCatalog,
  findPackage: findPackage,
  _parsePackage: parsePackage
};
