// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var msg = require('./say').msg;
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var execFile = require('child_process').execFile;
var fetch = require('./fetch');
var probeFetch = fetch.probeFetch;
var execErr = fetch.execErr;

var UPDATE_REPO = 'rorygallagher2024/lg-webos-dashboard';
var UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';
var UPDATE_TARBALL = 'https://codeload.github.com/' + UPDATE_REPO + '/tar.gz/refs/tags/v';
var BOOT_HOOK = '/var/lib/webosbrew/init.d/50-tvweb';

var installDir = path.resolve(__dirname, '..');
var stageDir = path.join(installDir, '.update');
var prevDir = path.join(installDir, '.previous');

var UPDATE = {
  state: 'idle',   // idle | checking | available | current | downloading | installing | installed | offline | error
  latest: null,
  url: null,
  notes: null,
  checked: 0,       // last check that got an answer
  attempted: 0,     // last check, answered or not
  error: null,
  busy: false
};

var config = {};
var currentVersion = '';
var writeSettingsFn = null;
var publishUpdateFn = null;
var publishDiscoveryFn = null;
// True when the Homebrew Channel installed the server. It updates it then: a
// release installed here would be taken back to the app's own copy.
var viaHomebrewChannel = function () { return false; };
var installerBusy = function () { return false; };
var updateFirstTimer = null;
var updateEveryTimer = null;

function num(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e) {}
}

function setUpdateState(state, err) {
  UPDATE.state = state;
  UPDATE.error = err || null;
  if (publishUpdateFn) publishUpdateFn();
}

function verParts(v) {
  var a = String(v || '').replace(/^v/i, '').split('.');
  return [num(a[0], 0), num(a[1], 0), num(a[2], 0), num(a[3], 0)];
}

function verNewer(a, b) {
  var x = verParts(a), y = verParts(b);
  for (var i = 0; i < 4; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

function declaredVersion(file) {
  try {
    var m = /TVWEB_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(file, 'utf8').slice(0, 4096));
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
    installed: currentVersion,
    latest: UPDATE.latest,
    available: !!(UPDATE.latest && verNewer(UPDATE.latest, currentVersion)),
    url: UPDATE.url,
    notes: UPDATE.notes,
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
    var rel = null;
    try { rel = JSON.parse(body); } catch (e) {}
    if (!rel || !rel.tag_name) {
      var why = (rel && rel.message) ? rel.message : 'GitHub did not return a release';
      setUpdateState('error', why);
      return cb(new Error(why), updateSummary());
    }
    UPDATE.latest = String(rel.tag_name).replace(/^v/i, '');
    UPDATE.url = rel.html_url || null;
    UPDATE.notes = rel.body ? String(rel.body).slice(0, 800) : null;
    UPDATE.checked = Date.now();
    setUpdateState(verNewer(UPDATE.latest, currentVersion) ? 'available' : 'current');
    console.log('update: installed v' + currentVersion + ', latest v' + UPDATE.latest +
                ' (' + UPDATE.state + ', via ' + fetch.client() + ')');
    cb(null, updateSummary());
  });
}

function scheduleUpdateChecks(firstMs) {
  if (updateFirstTimer) { clearTimeout(updateFirstTimer); updateFirstTimer = null; }
  if (updateEveryTimer) { clearInterval(updateEveryTimer); updateEveryTimer = null; }
  if (!(config.update && config.update.check)) return;
  var everyH = num(config.update.intervalHours, 24);
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

function inflate(buf, cb) {
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

function installUpdate(cb) {
  if (installerBusy()) return cb({ ok: false, error: msg('srv.install.busy.update', 'an app install is in progress; update when it has finished') });
  if (UPDATE.busy) return cb({ ok: false, error: msg('srv.update.busy', 'an update is already running') });
  if (viaHomebrewChannel()) return cb({ ok: false, error: msg('srv.update.viaHbc', 'updates for this install come from the Homebrew Channel') });

  if (fs.existsSync(path.join(installDir, '..', '.git'))) {
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
    if (!verNewer(ver, currentVersion)) {
      return done({ ok: true, updated: false, installed: currentVersion, latest: ver,
                    note: msg('srv.update.latest', 'already on the latest release') });
    }

    setUpdateState('downloading');
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
                console.log('update: installed v' + ver + ' over v' + currentVersion +
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

function rollbackUpdate(cb) {
  if (installerBusy()) return cb({ ok: false, error: msg('srv.install.busy.update', 'an app install is in progress; update when it has finished') });
  if (viaHomebrewChannel()) return cb({ ok: false, error: msg('srv.update.viaHbc', 'updates for this install come from the Homebrew Channel') });
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
  if (opts.version) currentVersion = opts.version;
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
  verParts: verParts
};
