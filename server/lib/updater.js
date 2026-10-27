// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var msg = require('./say').msg;
var fs = require('fs');
var toInt = require('./util').toInt;
var mkdirp = require('./util').mkdirp;
var readJson = require('./util').readJson;
var path = require('path');
var zlib = require('zlib');
var execFile = require('child_process').execFile;
var fetch = require('./fetch');
var hashFile = require('./installer').hashFile;
var probeFetch = fetch.probeFetch;
var execErr = fetch.execErr;

var UPDATE_REPO = 'rorygallagher2024/glasshouse';
// The recent releases rather than only the latest, for what each one since
// the installed version brings.
var UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases?per_page=10';
var WHATS_NEW_MAX = 5;
var UPDATE_TARBALL = 'https://codeload.github.com/' + UPDATE_REPO + '/tar.gz/refs/tags/v';
// The Homebrew Channel package each release carries, and the manifest naming
// its file and sha256 (.github/workflows/homebrew-channel.yml).
var PACKAGE_ID = 'io.github.rorygallagher2024.lg-webos-dashboard';
var RELEASE_DOWNLOAD = 'https://github.com/' + UPDATE_REPO + '/releases/download/v';
var BOOT_HOOK = '/var/lib/webosbrew/init.d/50-tvweb';

var installDir = path.resolve(__dirname, '..');
var stageDir = path.join(installDir, '.update');
var prevDir = path.join(installDir, '.previous');

var UPDATE = {
  state: 'idle',   // idle | checking | available | current | downloading | installing | installed | offline | error
  latest: null,
  url: null,
  notes: null,
  whatsNew: [],
  whatsNewMore: 0,
  checked: 0,       // last check that got an answer
  attempted: 0,     // last check, answered or not
  error: null,
  busy: false
};

var config = {};
// Compared against releases. shownVersion is what a person reads, the same
// version with build metadata when deploy.sh left a build.json.
var currentVersion = '';
var shownVersion = '';
var writeSettingsFn = null;
var publishUpdateFn = null;
var publishDiscoveryFn = null;
// True when the Homebrew Channel installed the server. A release's server
// files installed here would be taken back to the app's own copy, so the
// release's package is installed instead and the app brings the server along.
var viaHomebrewChannel = function () { return false; };
var installerBusy = function () { return false; };
// installPackage(file, version, cb(err)) puts an .ipk in place with the TV's
// app installer; afterPackage(version) runs the app's own installer, which
// moves the server over and restarts it.
var installPackageFn = null;
/** @type {(version: string) => void} */
var afterPackageFn = function () {};
var packageStageDir = '/media/developer/temp/glasshouse-update';
var updateFirstTimer = null;
var updateEveryTimer = null;

function setUpdateState(state, err) {
  UPDATE.state = state;
  UPDATE.error = err || null;
  if (publishUpdateFn) publishUpdateFn();
}

function verParts(v) {
  var a = String(v || '').replace(/^v/i, '').split('.');
  return [toInt(a[0], 0), toInt(a[1], 0), toInt(a[2], 0), toInt(a[3], 0)];
}

function verNewer(a, b) {
  var x = verParts(a), y = verParts(b);
  for (var i = 0; i < 4; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/*
 * The version to show: `version` with semver build metadata from the
 * build.json deploy.sh writes when it deploys from a git clone, as in
 * 0.80.1+55e51e5 or 0.80.1+55e51e5.dirty. A file recording another version
 * claims nothing: a release installed over a git build leaves it behind.
 * Build metadata does not count towards precedence, so comparisons keep using
 * the bare version.
 */
function displayVersion(version, dir) {
  var file = path.join(dir, 'build.json');
  var build = readJson(file, null);
  if (!build || !/^[0-9a-f]{4,40}$/.test(build.commit)) return version;
  if (build.version !== version) {
    console.log('update: ignoring stale build metadata from v' + build.version + ' (running v' + version + ')');
    return version;
  }
  return version + '+' + build.commit + (build.dirty ? '.dirty' : '');
}

function declaredVersion(file) {
  try {
    // The whole file: up to 0.82.2 this read only the first 4096 bytes, which
    // missed the line once it moved further down (#586).
    var m = /^var TVWEB_VERSION = '([^']+)';/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function rollbackVersion() {
  try {
    return declaredVersion(path.join(prevDir, 'tvweb.js'));
  } catch (e) { return null; }
}

function updateSummary() {
  return {
    ok: true,
    state: UPDATE.state,
    installed: shownVersion,
    latest: UPDATE.latest,
    available: !!(UPDATE.latest && verNewer(UPDATE.latest, currentVersion)),
    url: UPDATE.url,
    notes: UPDATE.notes,
    whatsNew: UPDATE.whatsNew,
    whatsNewMore: UPDATE.whatsNewMore,
    error: UPDATE.error,
    client: fetch.client(),
    autoCheck: !!(config.update && config.update.check),
    rollbackTo: viaHomebrewChannel() ? null : rollbackVersion(),
    writable: config.allowControl,
    viaHomebrewChannel: viaHomebrewChannel(),
    checkedMs: UPDATE.checked ? Date.now() - UPDATE.checked : null,
    attemptedMs: UPDATE.attempted ? Date.now() - UPDATE.attempted : null
  };
}

function findBin(name) {
  var dirs = fetch.clientDirs();
  for (var i = 0; i < dirs.length; i++) {
    var full = dirs[i] + '/' + name;
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/*
 * Ask GitHub for the latest release, unless a recent enough answer is already
 * held: unauthenticated calls are limited to 60 an hour from one address, so
 * `force` shortens that cache rather than removing it, and a number sets it.
 */
function checkForUpdate(force, cb) {
  cb = cb || function () {};
  if (UPDATE.state === 'checking') return cb(null, updateSummary());
  var minAge = typeof force === 'number' ? force : force ? 10000 : 3600000;
  if (UPDATE.latest && (Date.now() - UPDATE.checked) < minAge) return cb(null, updateSummary());
  // A tab being opened also lets a failed attempt stand, so an offline TV is not
  // tried again every time someone switches back to it.
  if (typeof force === 'number' && (Date.now() - UPDATE.attempted) < minAge) return cb(null, updateSummary());

  UPDATE.attempted = Date.now();
  setUpdateState('checking');
  probeFetch(UPDATE_API, null, function (err, body) {
    if (err) {
      setUpdateState(err.offline ? 'offline' : 'error', err.message);
      return cb(err, updateSummary());
    }
    var parsed = null;
    try { parsed = JSON.parse(body); } catch (e) {}
    var found = readReleases(parsed, currentVersion);
    if (!found) {
      var why = (parsed && parsed.message) ? parsed.message : 'GitHub did not return a release';
      setUpdateState('error', why);
      return cb(new Error(why), updateSummary());
    }
    UPDATE.latest = found.latest;
    UPDATE.url = found.url;
    UPDATE.notes = found.notes;
    UPDATE.whatsNew = found.whatsNew;
    UPDATE.whatsNewMore = found.more;
    UPDATE.checked = Date.now();
    setUpdateState(verNewer(UPDATE.latest, currentVersion) ? 'available' : 'current');
    console.log('update: installed v' + shownVersion + ', latest v' + UPDATE.latest +
                ' (' + UPDATE.state + ', via ' + fetch.client() + ')');
    cb(null, updateSummary());
  });
}

/*
 * A release's notes open with a short summary for people using Glasshouse,
 * above a "## Details" heading with the full notes. The summary, as plain
 * text, or null for a release without one (those before 0.91).
 */
function releaseSummary(body) {
  var text = String(body || '').replace(/\r/g, '');
  var m = /^##[ \t]+Details[ \t]*$/m.exec(text);
  if (!m) return null;
  var s = text.slice(0, m.index)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\x60([^\x60]*)\x60/g, '$1')
    .trim();
  return s ? s.slice(0, 600) : null;
}

/*
 * From GitHub's release list (newest first): the latest release, and the
 * summaries of those newer than `installed`, newest first, as { latest, url,
 * notes, whatsNew: [{ version, summary, url }], more }. more counts the newer
 * ones beyond WHATS_NEW_MAX or without a summary. null for no release.
 */
function linkOf(r) {
  return typeof r.html_url === 'string' && /^https:\/\//.test(r.html_url) ? r.html_url : null;
}

function readReleases(list, installed) {
  if (list && !Array.isArray(list) && list.tag_name) list = [list];
  if (!Array.isArray(list)) return null;
  // Only tags that are versions, so a stray tag cannot pose as the latest.
  var stable = list.filter(function (r) {
    return r && /^v?\d+\.\d+/.test(String(r.tag_name || '')) && !r.draft && !r.prerelease;
  });
  if (!stable.length) return null;
  var newer = [];
  stable.forEach(function (r) {
    var v = String(r.tag_name).replace(/^v/i, '');
    if (verNewer(v, installed)) newer.push({ version: v, summary: releaseSummary(r.body), url: linkOf(r) });
  });
  var shown = newer.filter(function (r) { return r.summary; }).slice(0, WHATS_NEW_MAX);
  return {
    latest: String(stable[0].tag_name).replace(/^v/i, ''),
    url: linkOf(stable[0]),
    notes: releaseSummary(stable[0].body),
    whatsNew: shown,
    more: newer.length - shown.length
  };
}

function scheduleUpdateChecks(firstMs) {
  if (updateFirstTimer) { clearTimeout(updateFirstTimer); updateFirstTimer = null; }
  if (updateEveryTimer) { clearInterval(updateEveryTimer); updateEveryTimer = null; }
  if (!(config.update && config.update.check)) return;
  var everyH = toInt(config.update.intervalHours, 24);
  if (!(everyH >= 1 && everyH <= 168)) everyH = 24;
  if (firstMs) {
    updateFirstTimer = setTimeout(function () {
      updateFirstTimer = null;
      checkForUpdate(false);
    }, firstMs);
  }
  updateEveryTimer = setInterval(function () { checkForUpdate(false); }, everyH * 3600000);
  console.log('update: checking for new releases every ' + everyH + 'h');
}

function setAutoCheck(on, cb) {
  if (!writeSettingsFn) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettingsFn({ update: { check: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.update = config.update || {};
    config.update.check = on;
    scheduleUpdateChecks(0);
    if (publishDiscoveryFn) publishDiscoveryFn();
    console.log('update: daily check switched ' + (on ? 'on' : 'off'));
    if (!on) return cb(updateSummary());
    checkForUpdate(false, function () { cb(updateSummary()); });
  });
}

function copyFile(src, dst) {
  fs.writeFileSync(dst, fs.readFileSync(src));
}

function listFiles(dir, base, out) {
  base = base || dir;
  out = out || [];
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    var st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function rmrf(dir, cb) {
  if (!fs.existsSync(dir)) return cb();
  execFile('/bin/rm', ['-rf', dir], { timeout: 20000 }, function () { cb(); });
}

function tarballTop(dir) {
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    try {
      if (fs.statSync(full).isDirectory()) return full;
    } catch (e) {}
  }
  return null;
}

// zlib's sync calls arrived in node 0.11.12; webOS 2 runs 0.10, which has
// only the async one.
function inflate(buf, cb) {
  if (typeof zlib.gunzipSync !== 'function') return zlib.gunzip(buf, cb);
  var out;
  try { out = zlib.gunzipSync(buf); } catch (e) { return cb(e); }
  cb(null, out);
}

function installFile(src, dst, exec) {
  mkdirp(path.dirname(dst));
  var tmp = dst + '.new';
  copyFile(src, tmp);
  fs.chmodSync(tmp, exec ? parseInt('755', 8) : parseInt('644', 8));
  fs.renameSync(tmp, dst);
}

function isExecutable(rel) {
  return rel === 'tvwebctl' || /\.sh$/.test(rel);
}

function isBusy() { return !!UPDATE.busy; }

function installBusy(cb) {
  if (!installerBusy()) return false;
  cb({ ok: false, error: msg('srv.install.busy.update', 'an app install is in progress; update when it has finished') });
  return true;
}

/*
 * A Homebrew Channel install updates by the release's package, as the Homebrew
 * Channel itself would: the TV's app installer puts it in place, then the
 * app's installer moves the server over and restarts it. Glasshouse is not in
 * the Homebrew Channel's catalog, so nothing else would offer the update.
 */
function installReleasePackage(ver, done) {
  var fail = function (reason) {
    setUpdateState('error', reason);
    console.error('update: ' + reason);
    rmrf(packageStageDir, function () { done({ ok: false, error: reason }); });
  };
  probeFetch(RELEASE_DOWNLOAD + ver + '/' + PACKAGE_ID + '.manifest.json', null, function (err, body) {
    if (err) return fail(err.message);
    var man = null;
    try { man = JSON.parse(body); } catch (e) {}
    var file = man && String(man.ipkUrl || '');
    var sha = man && man.ipkHash && String(man.ipkHash.sha256 || '').toLowerCase();
    if (!man || man.id !== PACKAGE_ID || man.version !== ver ||
        !/^[A-Za-z0-9._+-]+\.ipk$/.test(file) || !/^[0-9a-f]{64}$/.test(sha)) {
      return fail(msg('srv.update.badManifest', 'the release v{version} has no usable package manifest', { version: ver }));
    }
    rmrf(packageStageDir, function () {
      try { mkdirp(packageStageDir); } catch (e) { return fail('could not create ' + packageStageDir + ': ' + e.message); }
      var ipk = path.join(packageStageDir, file);
      console.log('update: downloading the v' + ver + ' package');
      fetch.download(RELEASE_DOWNLOAD + ver + '/' + file, ipk, {}, function (e2) {
        if (e2) return fail(e2.message);
        hashFile(ipk, function (e3, got) {
          if (e3) return fail('could not read the download: ' + e3.message);
          if (got !== sha) return fail(msg('srv.update.badHash', 'the downloaded package does not match the release\'s checksum'));
          setUpdateState('installing');
          installPackageFn(ipk, ver, function (e4) {
            if (e4) return fail(String(e4.message || e4));
            rmrf(packageStageDir, function () {
              setUpdateState('installed');
              console.log('update: installed the v' + ver + ' package over v' + shownVersion);
              afterPackageFn(ver);
              done({ ok: true, updated: true, installed: currentVersion, latest: ver, restarting: true });
            });
          });
        });
      });
    });
  });
}

function installUpdate(opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  if (installBusy(cb)) return;
  if (UPDATE.busy) return cb({ ok: false, error: msg('srv.update.busy', 'an update is already running') });
  var asPackage = viaHomebrewChannel() && !opts.force;
  if (asPackage && !installPackageFn) {
    return cb({ ok: false, error: msg('srv.update.viaHbc', 'updates for this install come from the Homebrew Channel (or sideload the latest .ipk from GitHub releases)') });
  }

  if (!asPackage && fs.existsSync(path.join(installDir, '..', '.git'))) {
    return cb({ ok: false, error: msg('srv.update.gitCheckout', 'this is a git checkout - update it with git, not from here') });
  }

  UPDATE.busy = true;
  var done = function (r) {
    UPDATE.busy = false;
    if (publishUpdateFn) publishUpdateFn();
    cb(r);
  };
  var fail = function (reason) {
    setUpdateState('error', reason);
    console.error('update: ' + reason);
    rmrf(stageDir, function () { done({ ok: false, error: reason }); });
  };

  checkForUpdate(true, function (err) {
    if (err) return done({ ok: false, error: err.message });
    var ver = UPDATE.latest;
    if (!ver) return done({ ok: false, error: msg('srv.update.noInfo', 'no release information yet - check first') });
    if (!verNewer(ver, currentVersion) && !opts.force) {
      return done({ ok: true, updated: false, installed: currentVersion, latest: ver,
                    note: msg('srv.update.latest', 'already on the latest release') });
    }

    setUpdateState('downloading');
    if (asPackage) return installReleasePackage(ver, done);
    rmrf(stageDir, function () {
      try { mkdirp(stageDir); } catch (e) { return fail('could not create ' + stageDir + ': ' + e.message); }
      var gz = path.join(stageDir, 'release.tar.gz');
      console.log('update: downloading v' + ver);
      probeFetch(UPDATE_TARBALL + ver, gz, function (e2) {
        if (e2) return fail(e2.message);

        var gzBuf;
        try { gzBuf = fs.readFileSync(gz); } catch (e) { return fail('could not read the download: ' + e.message); }
        inflate(gzBuf, function (e3, tarBuf) {
          if (e3) return fail('the download did not arrive complete (' + e3.message + ')');
          var tarBin = findBin('tar');
          if (!tarBin) return fail('no tar on this TV to unpack the release with');
          var tarFile = path.join(stageDir, 'release.tar');
          try { fs.writeFileSync(tarFile, tarBuf); } catch (e) { return fail('could not stage the release: ' + e.message); }

          setUpdateState('installing');
          execFile(tarBin, ['-xf', tarFile, '-C', stageDir], { timeout: 120000 }, function (e4, so, se) {
            if (e4) return fail('could not unpack the release: ' + execErr(e4, se));
            var top = tarballTop(stageDir);
            var src = top ? path.join(top, 'server') : null;
            if (!src || !fs.existsSync(path.join(src, 'tvweb.js'))) {
              return fail('the release tarball has no server directory in it');
            }

            var decl;
            try { decl = declaredVersion(path.join(src, 'tvweb.js')); } catch (e) { decl = null; }
            if (decl !== ver) {
              return fail('the downloaded release declares v' + decl + ', not v' + ver);
            }

            var files = listFiles(src), installed = [], bad = null;
            rmrf(prevDir, function () {
              for (var i = 0; i < files.length; i++) {
                var rel = files[i];
                if (rel === 'deploy.sh' || rel === '50-tvweb.sh') continue;
                var dst = path.join(installDir, rel);
                try {
                  if (fs.existsSync(dst)) {
                    var keep = path.join(prevDir, rel);
                    mkdirp(path.dirname(keep));
                    copyFile(dst, keep);
                  }
                  installFile(path.join(src, rel), dst, isExecutable(rel));
                  installed.push(rel);
                } catch (e) { bad = rel + ': ' + e.message; break; }
              }
              if (bad) return fail('could not install ' + bad + ' (v' + currentVersion + ' is in .previous)');

              if (fs.existsSync(BOOT_HOOK) && fs.existsSync(path.join(src, '50-tvweb.sh'))) {
                try {
                  installFile(path.join(src, '50-tvweb.sh'), BOOT_HOOK, true);
                } catch (e) {
                  console.error('update: could not refresh the boot hook: ' + e.message);
                }
              }

              var devAppIdx = '/media/developer/apps/usr/palm/applications/com.tvweb.dashboard/index.html';
              if (fs.existsSync(devAppIdx) && fs.existsSync(path.join(src, 'assets/dashboard-app/index.html'))) {
                try {
                  installFile(path.join(src, 'assets/dashboard-app/index.html'), devAppIdx, false);
                } catch (e) {
                  console.error('update: could not refresh the installed app wrapper: ' + e.message);
                }
              }

              rmrf(stageDir, function () {
                setUpdateState('installed');
                console.log('update: installed v' + ver + ' over v' + shownVersion +
                            ' (' + installed.length + ' files)');
                done({ ok: true, updated: true, installed: currentVersion, latest: ver,
                       files: installed.length });
              });
            });
          });
        });
      });
    });
  });
}

function rollbackUpdate(opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  if (installBusy(cb)) return;
  if (viaHomebrewChannel() && !opts.force) {
    return cb({ ok: false, error: msg('srv.update.viaHbc', 'updates for this install come from the Homebrew Channel (or sideload the latest .ipk from GitHub releases)') });
  }
  var was = rollbackVersion();
  if (!was) return cb({ ok: false, error: msg('srv.update.noRollback', 'nothing to roll back to') });
  var files = listFiles(prevDir);
  for (var i = 0; i < files.length; i++) {
    try {
      installFile(path.join(prevDir, files[i]), path.join(installDir, files[i]),
                  isExecutable(files[i]));
    } catch (e) {
      return cb({ ok: false, error: msg('srv.update.restoreFailed', 'could not restore {file}: {error}', { file: files[i], error: e.message }) });
    }
  }
  console.log('update: rolled back to v' + was + ' (' + files.length + ' files)');
  cb({ ok: true, restored: was, files: files.length });
}

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.version) currentVersion = shownVersion = opts.version;
  if (opts.displayVersion) shownVersion = opts.displayVersion;
  fetch.init({ config: opts.config, version: opts.version });
  if (opts.installDir) {
    installDir = opts.installDir;
    stageDir = path.join(installDir, '.update');
    prevDir = path.join(installDir, '.previous');
  }
  if (opts.writeSettings) writeSettingsFn = opts.writeSettings;
  if (opts.onUpdateChange) publishUpdateFn = opts.onUpdateChange;
  if (opts.onDiscoveryChange) publishDiscoveryFn = opts.onDiscoveryChange;
  if (opts.viaHomebrewChannel) viaHomebrewChannel = opts.viaHomebrewChannel;
  if (opts.installerBusy) installerBusy = opts.installerBusy;
  if (opts.installPackage) installPackageFn = opts.installPackage;
  if (opts.afterPackage) afterPackageFn = opts.afterPackage;
  if (opts.packageStageDir) packageStageDir = opts.packageStageDir;
}

function setPublishHandler(pubUpdate, pubDiscovery) {
  publishUpdateFn = pubUpdate;
  publishDiscoveryFn = pubDiscovery;
}

module.exports = {
  init: init,
  UPDATE: UPDATE,
  setPublishHandler: setPublishHandler,
  updateSummary: updateSummary,
  checkForUpdate: checkForUpdate,
  installUpdate: installUpdate,
  isBusy: isBusy,
  rollbackUpdate: rollbackUpdate,
  scheduleUpdateChecks: scheduleUpdateChecks,
  setAutoCheck: setAutoCheck,
  verNewer: verNewer,
  readReleases: readReleases,
  releaseSummary: releaseSummary,
  declaredVersion: declaredVersion,
  displayVersion: displayVersion
};
