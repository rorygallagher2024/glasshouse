// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
// The Homebrew Channel catalog, merged with what is installed on the TV.
var url = require('url');
var net = require('net');
var validateUrl = require('./fetch').validateUrl;
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

function safeSourceUrl(value) {
  if (validateUrl(value) || value.slice(0, 8).toLowerCase() !== 'https://') return '';
  if (value.indexOf('\\') !== -1) return '';
  try {
    // The legacy parser moves malformed host/port characters into the path.
    var authority = value.slice(8).split(/[\/?#]/)[0];
    var parsed = url.parse('https://' + authority);
    if (!parsed.hostname || parsed.auth !== null) return '';
    if (parsed.pathname !== '/' || Number(parsed.port) > 65535) return '';

    // Browsers interpret a numeric final host label as an IPv4 address.
    var lastLabel = parsed.hostname.split('.').filter(Boolean).pop();
    var numericLabel = /^[0-9]+$/.test(lastLabel) || /^0x[0-9a-f]+$/i.test(lastLabel);
    if ((authority.charAt(0) === '[' || numericLabel) && !net.isIP(parsed.hostname)) return '';

    // Some manifests use a package download as sourceUrl.
    var pathname = url.parse(value).pathname || '';
    var parts = pathname.split('/');
    if (parsed.hostname === 'github.com' && parts[1] && parts[2]) {
      var releaseDownload = parts[3] === 'releases' &&
        (parts[4] === 'download' || (parts[4] === 'latest' && parts[5] === 'download'));
      if (releaseDownload || parts[3] === 'archive') {
        return 'https://' + parsed.host + '/' + parts[1] + '/' + parts[2];
      }
    }
    if (/\.ipk$/i.test(pathname)) return '';
    return value;
  } catch (e) {
    return '';
  }
}

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
    sourceUrl: safeSourceUrl(m.sourceUrl),
    version: version,
    ipkUrl: ipkUrl,
    sha256: hash,
    size: size,
    category: stringOrEmpty(item.category) || stringOrEmpty(m.category),
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
        if (p) { p.vetted = base === DEFAULT_REPO; p.repo = base; apps.push(p); }
      }
      var max = parseInt(doc.paging && doc.paging.maxPage, 10) || 1;
      if (n < max && n < MAX_PAGES) return page(n + 1);
      cb(null, apps);
    });
  })(1);
}

/*
 * cb(results), one { url, apps, error } per catalog in repoUrls() order. A
 * catalog that fails keeps the list it last gave, with the error, and a
 * package listed twice in one catalog is shown once.
 */
function fetchAll(cb) {
  var urls = repoUrls(), i = 0, results = [];
  var before = {};
  ((cache && cache.repos) || []).forEach(function (r) { before[r.url] = r; });
  (function next() {
    if (i >= urls.length) return cb(results);
    var base = urls[i++];
    fetchRepo(base, function (err, list) {
      if (err) {
        var old = before[base];
        results.push({ url: base, apps: old && old.apps, error: err.message });
        return next();
      }
      var byId = {}, apps = [];
      for (var k = 0; k < list.length; k++) {
        if (byId[list[k].id]) continue;
        byId[list[k].id] = 1;
        apps.push(list[k]);
      }
      results.push({ url: base, apps: apps, error: null });
      next();
    });
  })();
}

/*
 * A short name for a catalog: owner/repository for one on GitHub, the host
 * otherwise.
 */
function repoLabel(u) {
  var m = /^https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\//i.exec(u) ||
          /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\//i.exec(u);
  // A GitHub Pages repository is named for its owner: its name alone says both.
  if (m) return m[2].toLowerCase() === m[1].toLowerCase() + '.github.io' ? m[2] : m[1] + '/' + m[2];
  m = /^https:\/\/([^\/.]+)\.github\.io\/([^\/]+)\//i.exec(u);
  if (m) return m[1] + '/' + m[2];
  m = /^https?:\/\/([^\/?#:]+)/i.exec(u);
  return m ? m[1] : u;
}

function isHbc(id) {
  return SELF_UPDATING.indexOf(id) >= 0 || !!PROTECTED_APP_IDS[id];
}

function withInstalled(apps, installed, fromStore) {
  var out = [];
  for (var i = 0; i < apps.length; i++) {
    var a = {};
    for (var k in apps[i]) a[k] = apps[i][k];
    var have = installed[a.id];
    a.installedVersion = have === undefined ? null : have;
    if (isHbc(a.id)) a.state = 'hbc';
    else if (have === undefined) a.state = 'none';
    // The LG store's own copy under the same id, as YouTube is for YouTube
    // AdFree, is a different app with LG's version numbers: the catalog's is
    // not installed, and installing it replaces the store's, which the
    // install preview confirms.
    else if (fromStore[a.id]) a.state = 'store';
    // The preview's own comparison, so the list and the preview agree: the
    // updater's stops at four parts and drops anything after a hyphen.
    else a.state = cmpVer(a.version, have) > 0 ? 'update' : 'installed';
    out.push(a);
  }
  return out;
}

function listInstalled(cb) {
  if (!lunaFn) return cb({}, {});
  lunaFn('com.webos.applicationManager/listApps', {}, function (res) {
    var raw = (res && res.apps) || [];
    var map = {}, fromStore = {};
    for (var i = 0; i < raw.length; i++) {
      if (!raw[i] || !raw[i].id) continue;
      map[raw[i].id] = String(raw[i].version || '');
      // The copy that is installed now: the LG store's lives under cryptofs.
      if (/^\/media\/cryptofs\//.test(String(raw[i].folderPath || ''))) fromStore[raw[i].id] = true;
    }
    cb(map, fromStore);
  });
}

/*
 * apps is the Homebrew Channel's catalog, with ok and error for it alone.
 * others is every added catalog's apps together, each naming its catalog in
 * repo, and repos says how each added catalog fared.
 */
function reply(cb) {
  listInstalled(function (installed, fromStore) {
    var repos = cache.repos || [];
    var main = repos[0] || { apps: null, error: cache.error };
    var r = { ok: !!main.apps, apps: withInstalled(main.apps || [], installed, fromStore), fetchedAt: cache.fetchedAt };
    if (main.error) r.error = main.error;
    r.others = [];
    r.repos = [];
    for (var i = 1; i < repos.length; i++) {
      r.others = r.others.concat(withInstalled(repos[i].apps || [], installed, fromStore));
      var info = { url: repos[i].url, label: repoLabel(repos[i].url), count: (repos[i].apps || []).length };
      if (repos[i].error) info.error = repos[i].error;
      r.repos.push(info);
    }
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
  fetchAll(function (results) {
    attempted = clock();
    var errors = [], any = false, fresh = false;
    results.forEach(function (r) {
      if (r.error) errors.push(r.error);
      if (r.apps) any = true;
      if (r.apps && !r.error) fresh = true;
    });
    // A list kept from before keeps its date, so it is shown as old. Any
    // error, in whole or in part, has it retried soon.
    cache = { repos: results, fetchedAt: fresh ? attempted : (cache && cache.fetchedAt) || 0,
              apps: any ? true : null, error: errors.length ? errors.join('; ') : null };
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

// repo picks the catalog when more than one lists the id; the Homebrew Channel's by default.
function findPackage(id, repo, cb) {
  if (typeof repo === 'function') { cb = repo; repo = null; }
  repo = repo || DEFAULT_REPO;
  getCatalog(false, function (r) {
    var list = repo === DEFAULT_REPO ? r.apps : r.others;
    if (repo === DEFAULT_REPO && !r.ok) return cb(new Error(r.error || msg('srv.repo.unavailable', 'catalog unavailable')));
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id && list[i].repo === repo) return cb(null, list[i]);
    }
    cb(new Error(msg('srv.repo.notInCatalog', 'not in the catalog: {id}', { id: id })));
  });
}

// The catalog's own address for one a person pasted, which may be the page of
// a GitHub repository that keeps its catalog as repo.json, as the Homebrew
// Channel's instructions for a catalog suggest.
function catalogCandidates(input) {
  var u = String(input || '').trim();
  var m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(u);
  if (m) return ['https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/HEAD/repo.json'];
  return [u];
}

/*
 * cb(err, url) with the address of a catalog that answered as one, for an
 * address a person gave. It is read first, so a page that is not a catalog
 * is refused rather than saved.
 */
function checkCatalog(input, cb) {
  if (!fetchLib) return cb(new Error('no fetch module configured'));
  var u = catalogCandidates(input)[0];
  var bad = fetchLib.validateUrl ? fetchLib.validateUrl(u) : null;
  if (!bad && !/^https:\/\//i.test(u)) bad = msg('srv.fetch.needHttps', 'the address must start with https://');
  if (bad) return cb(new Error(bad));
  fetchLib.getJson(u, function (err, doc) {
    if (err) return cb(new Error(msg('srv.repo.unreachable', 'could not read {url}: {error}', { url: u, error: err.message })));
    var list = doc && doc.packages;
    if (Object.prototype.toString.call(list) !== '[object Array]') {
      return cb(new Error(msg('srv.repo.notCatalog', 'not a package catalog: {url}', { url: u })));
    }
    cb(null, u);
  });
}

// Forgets the cached lists, so the next request reads the catalogs as they now are.
function forget() {
  cache = null;
  attempted = 0;
}

module.exports = {
  init: init,
  getCatalog: getCatalog,
  findPackage: findPackage,
  checkCatalog: checkCatalog,
  forget: forget,
  repoUrls: repoUrls,
  DEFAULT_REPO: DEFAULT_REPO,
  _repoLabel: repoLabel,
  _parsePackage: parsePackage
};
