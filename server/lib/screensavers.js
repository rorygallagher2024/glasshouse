/**
 * screensavers.js - Screensaver subsystem for webOS
 *
 * Manages custom QML screensavers, directory staging, appinfo.json patching,
 * runner compatibility between Flutter and QML on newer webOS versions,
 * and bind mounting over /usr/palm/applications/com.webos.app.screensaver.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var samrescan = require('./samrescan');
var msg = require('./say').msg;
var fs = require('fs');
var mkdirp = require('./util').mkdirp;
var readTrimmed = require('./util').readTrimmed;
var unlinkQuiet = require('./util').unlinkQuiet;
var path = require('path');
var execFile = require('child_process').execFile;
var power = require('./power');
var names = require('./names');

var SCREENSAVER_APP_ID = 'com.webos.app.screensaver';
var SCREENSAVER_APP_DIR = '/usr/palm/applications/' + SCREENSAVER_APP_ID;
var SCREENSAVER_DIR = '/var/lib/tvweb/screensaver';
var SCREENSAVER_MARKER = '.tvweb-screensaver';
var SCREENSAVER_LEVEL_MARKER = '.tvweb-brightness';
// Survives a server restart, but not a TV reboot. sam also retains native
// screen savers after dismissal, so its running list alone cannot prove ours.
var LAUNCHED_MARKER = '/var/run/tvweb-screensaver-launched';
// Outside the staged directory, which is bind-mounted over the app and so hides
// the stock manifest whenever one of ours is in use.
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

// Once set while sam restarted for a switch; sam is no longer restarted, so it
// stays clear, and the dashboards' notice for it does not show.
var SWITCH_TIMEOUT_MS = 150000;
var SWITCHING_ERROR = msg('srv.saver.switching', 'The TV is still switching screen savers. Try again in a minute.');
var HELD_ERROR = msg('srv.saver.held', 'Custom screen savers are turned off on this TV for now, as they have not been tried on its webOS version. Before 0.98.1, on webOS 10, they could leave the picture, the sound and HDMI control off until the TV was unplugged. One already in use stays until the TV is next fully restarted.');
// The switch is undone rather than sam restarted, the step behind #366.
var LOST_ERROR = msg('srv.saver.lost', 'The TV has lost track of its screen saver app and did not find it again. Restarting the TV brings it back.');
var NOT_TAKEN_ERROR = msg('srv.saver.notTaken', 'The TV did not take the new screen saver without restarting its app manager, which has left the picture or sound off on some TVs, so LG\'s screen saver is kept.');
var STOCK_LATER_ERROR = msg('srv.saver.stockLater', 'LG\'s screen saver is set, and the TV uses it from its next restart: it did not take the change without restarting its app manager, which has left the picture or sound off on some TVs.');

var SCREENSAVERS = {
  stock: {
    label: msg('srv.saver.stock', 'LG default'),
    description: msg('srv.saver.stock.desc', 'The screen saver the TV shipped with.')
  },
  clock: {
    label: msg('srv.saver.clock', 'Clock'),
    description: msg('srv.saver.clock.desc', 'A digital clock on black, moving to a new position every minute.'),
    qml: 'screensavers/clock.qml'
  },
  starfield: {
    label: msg('srv.saver.starfield', 'Starfield'),
    description: msg('srv.saver.starfield.desc', 'A drifting cosmic starscape with occasional shooting stars.'),
    qml: 'screensavers/starfield.qml'
  },
  fireworks: {
    label: msg('srv.saver.fireworks', 'Fireworks'),
    description: msg('srv.saver.fireworks.desc', 'Bursts of colour on black, a few seconds apart.'),
    qml: 'screensavers/fireworks.qml'
  },
  bokeh: {
    label: msg('srv.saver.bokeh', 'Bokeh'),
    description: msg('srv.saver.bokeh.desc', 'Soft circles of light drifting in and out on black.'),
    qml: 'screensavers/bokeh.qml'
  },
  harmonograph: {
    label: msg('srv.saver.harmonograph', 'Harmonograph'),
    description: msg('srv.saver.harmonograph.desc', 'Pendulum ribbons of light weaving and fading on black.'),
    qml: 'screensavers/harmonograph.qml'
  },
  vitals: {
    label: msg('srv.saver.vitals', 'Panel vitals'),
    description: msg('srv.saver.vitals.desc', 'The TV\'s own readings - panel hours, pixel refresher countdown, temperature.'),
    qml: 'screensavers/vitals.qml'
  }
};

var webosVersion = null;  // as the TV reports it
var lunaFn = null;
var assetPathFn = null;
var configObj = null;
var injectKeyFn = null;
var keyBackVal = null;
// An app id's short id, an HDMI input's port key (hdmi3) under any app id.
var inputKeyFn = names.shortAppId;
var switchingSince = 0;
// True while a screen saver started by launching its app may be showing:
// tvpower stays Active under one started that way, so it cannot tell.
var launchedDirectly = false;
var launchGeneration = 0;
var closeCallbacks = [];
/** @type {function(boolean): void} */
var watchKeysFn = function () {};
/** @type {function(function(?{state: string, fullScreen: boolean}): void, boolean=): void} */
var mediaStateFn = function (cb) { cb(null); };

function clearStagedScreensaver() {
  unlinkQuiet(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER));
  unlinkQuiet(path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER));
  unlinkQuiet(path.join(SCREENSAVER_DIR, 'appinfo.json'));
  try {
    var qmlDir = path.join(SCREENSAVER_DIR, 'qml');
    if (fs.existsSync(qmlDir)) {
      var files = fs.readdirSync(qmlDir);
      for (var i = 0; i < files.length; i++) {
        unlinkQuiet(path.join(qmlDir, files[i]));
      }
      try { fs.rmdirSync(qmlDir); } catch (e) {}
    }
  } catch (e) {}
}

function unmountScreensaver(cb) {
  cb = cb || function () {};
  var qmlFile = path.join(SCREENSAVER_APP_DIR, 'qml', 'main.qml');
  execFile('/bin/umount', ['-l', qmlFile], { timeout: 4000 }, function () {
    execFile('/bin/umount', [SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
      if (err) {
        return execFile('/bin/umount', ['-l', SCREENSAVER_APP_DIR], { timeout: 4000 }, function () {
          cb();
        });
      }
      cb();
    });
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  assetPathFn = opts.assetPath;
  configObj = opts.config;
  webosVersion = opts.webosVersion || null;
  injectKeyFn = opts.injectKey;
  keyBackVal = opts.KEY_BACK;
  if (opts.inputKey) inputKeyFn = opts.inputKey;
  watchKeysFn = opts.watchKeys || function () {};
  mediaStateFn = opts.mediaState || function (cb) { cb(null); };
  launchedDirectly = false;
  launchGeneration++;
  closeCallbacks = [];

  // Auto-heal: If the screensaver is currently stock (no active bind-mount on SCREENSAVER_APP_DIR),
  // but an orphaned marker remains in SCREENSAVER_DIR, remove it so the boot hook does not
  // re-mount a stale screensaver on the next cold reboot.
  if (screensaverMode() === 'stock') {
    clearStagedScreensaver();
    rememberStockType();
  }
}

function manifestType(json) {
  try { return JSON.parse(json).type || null; } catch (e) { return null; }
}

// Only valid while the stock app is showing, i.e. nothing is mounted over it.
function rememberStockType(json) {
  try {
    if (json === undefined) json = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
    var type = manifestType(json);
    if (type) fs.writeFileSync(STOCK_TYPE_FILE, type);
  } catch (e) {}
}

// True where LG's screen saver runs on another runner than ours (Flutter on
// webOS 10), so going to or from it restarts sam. Unknown until the stock
// manifest has been seen once.
function slowSwitch() {
  var t = readTrimmed(STOCK_TYPE_FILE);
  return !!t && t !== 'qml';
}

// Where the stock screen saver is not QML (Flutter on webOS 10 and 11), custom
// screen savers were followed by the picture muted, HDMI-CEC and ARC dead and
// sound on the TV speakers only, until a power cut (#366), when switching to
// one restarted sam. Since 0.98.1 the switch asks sam to reread the one app
// instead (ensureScreensaverRunner), which has held on a C5 (webOS 10.3.1), a
// C2 (webOS 10.3) and a G3 (webOS 11.2, with forceBlockSystemApp), so they are
// on there by default (#768). Later versions are untried and stay held back:
// the boot hook does not apply them and nothing here restarts sam. "allowExperimentalScreensavers": true in config.json turns them on
// anywhere; it does not let sam be restarted.
function heldBack() {
  return slowSwitch() && !onByDefault() && !allowedAnyway();
}

function onByDefault() {
  return slowSwitch() && /^1[01]\./.test(String(webosVersion || ''));
}

// Where custom screen savers are experimental: held back, or turned on anyway.
function experimental() {
  return slowSwitch() && !onByDefault();
}

function allowedAnyway() {
  // The old name, until migrateConfigFile() has renamed it.
  return !!(configObj && (configObj.allowExperimentalScreensavers === true || configObj.allowOnWebos10 === true));
}

// Held back but turned back on, so the dashboards can say so.
function heldOverridden() {
  return experimental() && allowedAnyway();
}

function switching() {
  if (switchingSince && Date.now() - switchingSince > SWITCH_TIMEOUT_MS) switchingSince = 0;
  return !!switchingSince;
}

function screensaverLevel() {
  return readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_LEVEL_MARKER)) === 'bright' ? 'bright' : 'dim';
}

function screensaverMode() {
  var m = readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER));
  return SCREENSAVERS[m] && m !== 'stock' ? m : 'stock';
}

function detectExternal() {
  var active = false;
  var hook = false;
  try {
    var info = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
    for (var i = 0; i < info.length; i++) {
      var parts = info[i].split(' ');
      if (parts.length >= 5) {
        var root = parts[3];
        var target = parts[4];
        if (target.indexOf(SCREENSAVER_APP_DIR) === 0 && root.indexOf('/var/lib/tvweb/screensaver') === -1) {
          active = true;
          break;
        }
      }
    }
  } catch (e) {}
  if (!active) {
    try {
      var mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
      for (var m = 0; m < mounts.length; m++) {
        var mparts = mounts[m].split(' ');
        if (mparts.length >= 2 && mparts[1].indexOf(SCREENSAVER_APP_DIR) === 0) {
          if (mparts[0].indexOf('/var/lib/tvweb/screensaver') === -1 && mparts[1] !== SCREENSAVER_APP_DIR) {
            active = true;
            break;
          }
        }
      }
    } catch (e2) {}
  }
  try {
    var initFiles = fs.readdirSync('/var/lib/webosbrew/init.d');
    for (var j = 0; j < initFiles.length; j++) {
      if (/screensaver/i.test(initFiles[j])) {
        hook = true;
        break;
      }
    }
  } catch (e3) {}
  return { active: active, hook: hook };
}

function screensaverList() {
  var cur = screensaverMode();
  var out = [];
  for (var k in SCREENSAVERS) {
    out.push({
      id: k,
      label: SCREENSAVERS[k].label,
      description: SCREENSAVERS[k].description,
      active: k === cur,
      available: k === 'stock' || (!heldBack() && !!(assetPathFn && assetPathFn(SCREENSAVERS[k].qml)))
    });
  }
  return {
    ok: true,
    current: cur,
    level: screensaverLevel(),
    modes: out,
    writable: !!(configObj && configObj.allowControl),
    slowSwitch: slowSwitch(),
    // Always: held back, the tab offers the switch that turns custom screen
    // savers on, with its warning. A hidden tab read as broken (#630, #665).
    available: true,
    held: heldBack(),
    heldOverridden: heldOverridden(),
    switching: switching(),
    external: detectExternal()
  };
}

function stageScreensaverAppinfo() {
  var stock = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
  rememberStockType(stock);
  var out = stock;
  try {
    var info = JSON.parse(stock);
    info.type = 'qml';
    info.main = 'qml/main.qml';
    out = JSON.stringify(info, null, 2);
  } catch (e) {
    console.error('screensaver: stock appinfo.json did not parse, staging it unchanged: ' + e.message);
  }
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'appinfo.json'), out);
}

// cb(samRestarted, notTaken): notTaken where sam still holds the other type.
// sam is never restarted for a screen saver: that restart is the step behind
// #366, so a switch it does not take is undone instead.
function ensureScreensaverRunner(cb) {
  var staged;
  try {
    staged = JSON.parse(fs.readFileSync(
      path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8')).type;
  } catch (e) {
    return cb(false);
  }
  if (!lunaFn) return cb(false);
  lunaFn('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (r) {
    var cached = r && r.appInfo && r.appInfo.type;
    // No answer means the bus is not up yet. Leave the service alone.
    if (!cached || cached === staged) return cb(false);
    console.log('screensaver: sam holds the app as "' + cached + '" and it is now "'
                + staged + '" - making sam read the manifest again');
    // A block and release of this one app first (webOS 10 and later), then
    // the nudge where the TV has one, then the restart (lib/samrescan, #366).
    // Neither of the first two stops a running screen saver, so cb(false) has
    // the caller restart the app.
    function samHasIt(done) {
      lunaFn('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (a) {
        done(!!(a && a.appInfo && a.appInfo.type === staged));
      });
    }
    samrescan.rereadApp('com.webos.app.screensaver', samHasIt, function (reread) {
      if (reread) {
        console.log('screensaver: sam read the manifest again after a block and release, without a restart');
        return cb(false);
      }
      samrescan.refresh(samHasIt, function (nudged) {
        if (nudged) {
          console.log('screensaver: sam read the manifest again, without a restart');
          return cb(false);
        }
        console.log('screensaver: sam did not read the manifest again, and is not restarted (#366)');
        cb(false, true);
      });
    });
  });
}

// cb(notTaken), as ensureScreensaverRunner gives it.
function settleScreensaverApp(cb) {
  ensureScreensaverRunner(function (samRestarted, notTaken) {
    if (samRestarted || notTaken) return cb(!!notTaken);
    restartScreensaverApp(function () { cb(false); });
  });
}

function writeScreensaverQml(src, level) {
  var port = (configObj && configObj.port) || 8080;
  var token = configObj && configObj.token;
  var qml = fs.readFileSync(src, 'utf8')
    .replace(/__TVWEB_URL__/g,
      'http://127.0.0.1:' + port + '/api/stats' +
      (token ? '?k=' + encodeURIComponent(token) : ''))
    .replace(/__TVWEB_LEVEL__/g, level === 'bright' ? '1' : '0')
    // The hour cycle the clock screen savers draw, from clock.hour12.
    .replace(/__TVWEB_CLOCK12__/g,
      configObj && configObj.clock && configObj.clock.hour12 === true ? 'true' : 'false');
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', 'main.qml'), qml);

  try {
    var from = path.dirname(src);
    var files = fs.readdirSync(from);
    for (var i = 0; i < files.length; i++) {
      if (/\.qml$/i.test(files[i])) continue;
      fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', files[i]),
                       fs.readFileSync(path.join(from, files[i])));
    }
  } catch (e) {
    console.error('screensaver: could not stage its files: ' + e.message);
  }
  fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER), level === 'bright' ? 'bright' : 'dim');
}

function setScreensaver(mode, level, cb) {
  if (!SCREENSAVERS[mode]) return cb({ ok: false, error: 'unknown screen saver: ' + mode });
  if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
  if (mode !== 'stock' && heldBack()) return cb({ ok: false, error: HELD_ERROR });
  level = (level === 'bright') ? 'bright' : 'dim';

  unmountScreensaver(function () {
    if (mode === 'stock') {
      clearStagedScreensaver();
      return settleScreensaverApp(function (notTaken) {
        cb({ ok: !notTaken && screensaverMode() === 'stock', current: screensaverMode(), level: screensaverLevel(),
             switching: switching(), error: notTaken ? STOCK_LATER_ERROR : undefined });
      });
    }

    var src = assetPathFn ? assetPathFn(SCREENSAVERS[mode].qml) : null;
    if (!src) return cb({ ok: false, error: 'screen saver asset missing: ' + SCREENSAVERS[mode].qml });

    try {
      mkdirp(path.join(SCREENSAVER_DIR, 'qml'));
      stageScreensaverAppinfo();
      writeScreensaverQml(src, level);
      fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), mode);
    } catch (e) {
      return cb({ ok: false, error: msg('srv.saver.stageFailed', 'could not stage the screen saver: {error}', { error: e.message }) });
    }

    execFile('/bin/mount', ['--bind', SCREENSAVER_DIR, SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
      settleScreensaverApp(function (notTaken) {
        if (notTaken) {
          // sam still runs LG's: put LG's files back under it, so they agree.
          return unmountScreensaver(function () {
            clearStagedScreensaver();
            cb({ ok: false, current: screensaverMode(), level: screensaverLevel(), switching: switching(), error: NOT_TAKEN_ERROR });
          });
        }
        var now = screensaverMode();
        cb({
          ok: !err && now === mode,
          current: now,
          level: screensaverLevel(),
          switching: switching(),
          error: (!err && now === mode) ? undefined : 'the mount did not take'
        });
      });
    });
  });
}

function restageScreensaver() {
  var mode = screensaverMode();
  if (mode === 'stock') return;
  var src = assetPathFn ? assetPathFn(SCREENSAVERS[mode].qml) : null;
  if (!src) return;
  try {
    var staged = path.join(SCREENSAVER_DIR, 'qml', 'main.qml');
    var before = fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : '';
    writeScreensaverQml(src, screensaverLevel());
    if (fs.readFileSync(staged, 'utf8') !== before) {
      console.log('screensaver: restaged "' + mode + '" from a newer asset');
    }
  } catch (e) {
    console.error('screensaver: could not restage ' + mode + ': ' + e.message);
  }
}

function restartScreensaverApp(cb) {
  if (!lunaFn) return cb();
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var isSS = power.isScreenSaver(power.mapState(pw && pw.state));
    if (!isSS) {
      return lunaFn('com.webos.applicationManager/closeByAppId',
                    { id: 'com.webos.app.screensaver' }, function () { cb(); });
    }
    if (!injectKeyFn || !keyBackVal) {
      return cb();
    }
    injectKeyFn(keyBackVal, function () {
      setTimeout(function () {
        lunaFn('com.webos.applicationManager/closeByAppId', { id: 'com.webos.app.screensaver' }, function () {
          setTimeout(function () {
            lunaFn('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function () { cb(); });
          }, 1500);
        });
      }, 1500);
    });
  });
}

/*
 * cb(true) once sam knows the screen saver app, rereading its apps first if
 * it has lost it. A C2 (webOS 9.2.2) once answered getAppInfo for it with
 * "Invalid appId specified" while the app's files were in place, and the
 * screen saver then did not start, with no error, until a nudge brought it
 * back. cb(true) also where getAppInfo gave no answer at all, so a slow bus
 * does not stop a start that may well work.
 */
function ensureScreensaverKnown(cb) {
  var id = 'com.webos.app.screensaver';
  function known(done) {
    lunaFn('com.webos.applicationManager/getAppInfo', { id: id }, function (r) {
      done(!!(r && r.appInfo), r);
    });
  }
  known(function (ok, r) {
    if (ok || !r || r.returnValue !== false) return cb(true);
    console.log('screensaver: sam does not know the screen saver app (' + (r.errorText || 'no info') + ') - making it read its apps again');
    samrescan.refresh(known, function (nudged) {
      if (nudged) {
        console.log('screensaver: sam knows the screen saver app again');
        return cb(true);
      }
      samrescan.rereadApp(id, known, function (reread) {
        if (reread) console.log('screensaver: sam knows the screen saver app again, after a block and release');
        else console.log('screensaver: sam still does not know the screen saver app');
        cb(reread);
      });
    });
  });
}

function screensaverRunning(cb) {
  lunaFn('com.webos.applicationManager/running', {}, function (r) {
    if (!r || !r.running) return cb(null);
    for (var i = 0; i < r.running.length; i++) {
      if (r.running[i].id === SCREENSAVER_APP_ID) return cb(true);
    }
    cb(false);
  });
}

/*
 * Whether a screen saver started by launching its app is showing, as last
 * seen. Answers at once, for the stats, and checks sam behind it so it clears
 * a poll after the screen saver closes, whether by the remote or the dashboard.
 */
function launchedShowing() {
  if (launchedDirectly && lunaFn) {
    var generation = launchGeneration;
    screensaverRunning(function (running) {
      if (running === false && generation === launchGeneration) setLaunched(false);
    });
  }
  return launchedDirectly;
}

/*
 * LG's screen saver answers a key by asking tvpower to turnOnScreen, and
 * leaves closing it to tvpower. Under one tvpower did not start, tvpower is
 * Active and refuses ("The current sub state must be 'screen off'"), so the
 * remote cannot close it (G3, webOS 9.2.2). The remote's keys are watched
 * while it shows, and any of them closes it.
 */
function setLaunched(on) {
  if (on) {
    try { fs.writeFileSync(LAUNCHED_MARKER, '1\n', 'utf8'); }
    catch (e) { console.error('screensaver: could not record the launched screen saver: ' + e.message); }
  } else {
    unlinkQuiet(LAUNCHED_MARKER);
  }
  if (launchedDirectly === on) return;
  launchedDirectly = on;
  launchGeneration++;
  watchKeysFn(on);
}

function closeLaunched(cb) {
  closeCallbacks.push(cb);
  if (closeCallbacks.length > 1) return;
  var generation = launchGeneration;
  lunaFn('com.webos.applicationManager/closeByAppId', { id: SCREENSAVER_APP_ID }, function (r) {
    if (r && r.returnValue && generation === launchGeneration) setLaunched(false);
    var callbacks = closeCallbacks;
    closeCallbacks = [];
    for (var i = 0; i < callbacks.length; i++) callbacks[i](r);
  });
}

function keyPressed() {
  if (!launchedDirectly || !lunaFn) return;
  console.log('screensaver: a remote key closes the screen saver');
  closeLaunched(function () {});
}

// At start: one an earlier run launched may still be showing, which only
// this server can close.
function adoptLaunched() {
  if (!lunaFn || !fs.existsSync(LAUNCHED_MARKER)) return;
  var generation = launchGeneration;
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    if (!pw || pw.returnValue === false || generation !== launchGeneration) return;
    if (power.isScreenSaver(power.mapState(pw.state))) return setLaunched(false);
    screensaverRunning(function (running) {
      if (running !== null && generation === launchGeneration) setLaunched(running);
    });
  });
}

function launchScreensaverApp(cb) {
  // tvpower's refusal also protects playback. An unavailable media service
  // is not evidence that nothing is playing, including on older firmware.
  mediaStateFn(function (media) {
    if (!media) return cb(false, msg('srv.saver.unknownPlayback', 'the TV could not check whether anything is playing'));
    if (media.state === 'playing' && media.fullScreen) {
      return cb(false, msg('srv.saver.playing', 'the TV does not start a screen saver while something is playing'));
    }
    // The request and media checks can take seconds. Do not cover an input
    // or undo Screen Off if the source or power changed in the meantime.
    lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
      var currentPower = power.mapState(pw && pw.state);
      if (power.isScreenSaver(currentPower)) return cb(true);
      if (!pw || pw.returnValue === false || !currentPower.screenOn ||
          (pw.processing && pw.processing !== 'Screen On')) return cb(false);
      lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
        var fgId = fg && fg.returnValue !== false && fg.appId ? inputKeyFn(fg.appId) : '';
        if (!fgId || names.isHdmiKey(fgId) || fgId === 'livetv') return cb(false);
        console.log('screensaver: launching the screen saver app after a refused request');
        lunaFn('com.webos.applicationManager/launch', { id: SCREENSAVER_APP_ID }, function (r) {
          var ok = !!(r && r.returnValue);
          if (ok) setLaunched(true);
          cb(ok);
        });
      });
    });
  }, true);
}

/*
 * cb(true) where the screen saver tvpower agreed to start was then refused.
 * On a G3 (webOS 9.2.2) turnOnScreenSaver returned true, tvpower showed
 * "Request Screen Saver" and then "Screen On" 30 ms later, and went back to
 * Active with nothing started, from Home and from an app alike: one of the
 * services registered to answer screen saver requests said no, and none of
 * them logs why. Launching the app itself still brought the screen saver up.
 * cb(false) once it is showing, or while tvpower is still working on it after
 * the last look, so a slow start is not given a second one.
 */
function refusedAfterRequest(cb) {
  var looks = 0;
  (function look() {
    setTimeout(function () {
      lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
        if (!pw || power.isScreenSaver(power.mapState(pw.state))) return cb(false);
        var settled = power.mapState(pw.state).screenOn &&
          (!pw.processing || pw.processing === 'Screen On');
        if (settled) return cb(true);
        if (++looks < 6) return look();
        cb(false);
      });
    }, 500);
  })();
}

function trigger(cb) {
  if (!lunaFn) return cb({ ok: false, error: 'luna bus not available' });
  // Asking tvpower for a screen saver while sam is down can park it at
  // "Screen Saver Ready" until a reboot.
  if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var isSS = power.isScreenSaver(power.mapState(pw && pw.state));
    if (isSS) {
      if (!injectKeyFn || !keyBackVal) {
        return cb({ ok: false, error: 'key injection not available' });
      }
      return injectKeyFn(keyBackVal, function (ok) {
        cb(ok ? { ok: true } : { ok: false, error: msg('srv.saver.noRemote', 'could not reach the remote input device') });
      });
    }
    if (launchedDirectly) {
      return screensaverRunning(function (running) {
        // Closed already: start one. No answer is not closed.
        if (running === false) {
          setLaunched(false);
          return trigger(cb);
        }
        closeLaunched(function (r) {
          cb(r && r.returnValue ? { ok: true } : {
            ok: false,
            error: msg('srv.saver.noClose', 'the TV would not close the screen saver: {error}', { error: (r && r.errorText) || 'no answer' })
          });
        });
      });
    }

    lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
      var fgId = (fg && fg.appId) ? inputKeyFn(fg.appId) : '';
      if (names.isHdmiKey(fgId) || fgId === 'livetv') {
        return cb({ ok: false, error: msg('srv.saver.onlyInApps', 'the screen saver is only available from an app, not from {source}', { source: fgId }) });
      }
      ensureScreensaverKnown(function (known) {
        if (!known) return cb({ ok: false, error: LOST_ERROR });
        lunaFn('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function (r) {
          if (r && r.returnValue) {
            return refusedAfterRequest(function (refused) {
              if (!refused) return cb({ ok: true });
              launchScreensaverApp(function (ok, error) {
                cb(ok ? { ok: true } : {
                  ok: false,
                  error: error || (fgId ? msg('srv.saver.refusedFrom', 'the TV would not start a screen saver from {source}', { source: fgId })
                    : msg('srv.saver.refusedHere', 'the TV would not start a screen saver from this source'))
                });
              });
            });
          }
          if (r && r.errorText === 'Invalid State change Request') {
            return launchScreensaverApp(function (launched, error) {
              if (launched) return cb({ ok: true });
              cb({
                ok: false,
                error: error || msg('srv.saver.refused', 'the TV would not start a screen saver here: {error}', { error: r.errorText })
              });
            });
          }
          cb({
            ok: false,
            error: (r && r.errorText)
              ? msg('srv.saver.refused', 'the TV would not start a screen saver here: {error}', { error: r.errorText })
              : fgId ? msg('srv.saver.refusedFrom', 'the TV would not start a screen saver from {source}', { source: fgId })
              : msg('srv.saver.refusedHere', 'the TV would not start a screen saver from this source')
          });
        });
      });
    });
  });
}

module.exports = {
  SCREENSAVER_APP_DIR: SCREENSAVER_APP_DIR,
  SCREENSAVER_DIR: SCREENSAVER_DIR,
  SCREENSAVERS: SCREENSAVERS,
  init: init,
  clearStagedScreensaver: clearStagedScreensaver,
  unmountScreensaver: unmountScreensaver,
  screensaverLevel: screensaverLevel,
  screensaverMode: screensaverMode,
  screensaverList: screensaverList,
  switching: switching,
  detectExternal: detectExternal,
  heldBack: heldBack,
  heldOverridden: heldOverridden,
  experimental: experimental,
  onByDefault: onByDefault,
  slowSwitch: slowSwitch,
  allowedAnyway: allowedAnyway,
  setScreensaver: setScreensaver,
  restageScreensaver: restageScreensaver,
  launchedShowing: launchedShowing,
  keyPressed: keyPressed,
  adoptLaunched: adoptLaunched,
  trigger: trigger
};
