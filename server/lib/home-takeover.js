/*
 * lib/home-takeover.js - Glasshouse Home in LG's Home's place, under its id
 *
 * LG's Home app, com.webos.app.home, is what the TV opens for everything that
 * means Home: the Home button (surface-manager, mode hotKey), Back out of the
 * last app (sam's last_input_handler), waking from standby (bootManager) and
 * nothing left in front. A copy of Glasshouse Home's app with that id, bind
 * mounted over LG's app directory, is opened by all of them, with nothing to
 * correct afterwards. On a G3 (webOS 9.2.2) sam took the web app's manifest
 * under that id on a rescan (systemApp true), the Home button opened it 0.08 s
 * after the press and LG's Home never drew. Nothing on the TV calls LG's Home
 * as a luna service.
 *
 * sam reads an appinfo.json only when it scans, and tells a native app from
 * a web one by it. Switching while the old app runs leaves sam with the new
 * type and the old instance, which it can then neither close nor replace: a
 * native close sent to the web page answered "Message status unknown", and
 * the next launch hung with the screen black. So the files are changed and
 * sam rereads them first, and then the old instance is stopped: LG's process
 * killed, or the web page killed through WebAppMgr (closeByAppId leaves it in
 * the background). Where that instance was in front, sam's last_input_handler
 * opens Home again about a second later, as the new app.
 *
 * Mounted from the boot hook too (50-tvweb.sh), about 25 s into a cold start;
 * LG's Home has started by then, in the background, and is stopped the same
 * way. Until then the TV shows LG's Home for anything that opens it. Where the
 * owner chooses, LG's Home is given an empty layout to start with: it reads
 * /mnt/lg/cmn_data/manifest at its start, 5 s into boot, before anything of
 * Glasshouse's runs, and draws a black screen (a G3, webOS 9.2.2). That file
 * outlives Glasshouse: a TV where it no longer runs keeps a black LG Home until
 * the file is removed over SSH, so it is off unless chosen. The files there
 * before, LG's or the Home screen layout feature's (lib/homescreen-webos9.js),
 * are kept aside and put back, with LG's Home's checkpoints cleared so it
 * starts fresh and reads them, whenever LG's Home gets its place back or the
 * choice is undone.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var mkdirp = require('./util').mkdirp;

var LG_HOME = 'com.webos.app.home';
var APP_DIR = '/usr/palm/applications/' + LG_HOME;
var LG_HOME_EXE = '/usr/bin/' + LG_HOME;
// Marks the empty layout; lib/homescreen-webos9.js leaves a file with it alone.
var BLANK_MARK = '<!-- glasshouse-home-starting -->';
var LAYOUT_FILES = ['home_layoutShelfView.xml', 'home_layout.xml'];
var BLANK_LAYOUT = '<?xml version="1.0" encoding="utf-8"?>\n' + BLANK_MARK + '\n' +
  '<home version="2.0">\n    <layout type="ShelfView" bgColor="#000000">\n        <firstPage>\n' +
  '        </firstPage>\n    </layout>\n</home>\n';

var lunaFn = null;
var samrescan = null;
var stageDir = '/var/lib/tvweb/home-takeover';
var sourceDir = path.join(__dirname, '..', 'assets', 'home-app');
// The dashboard's port, filled into the page when it is staged.
var serverPort = 8080;
var PORT_LINE = /(var PORT = )\d+(;\s*\/\/ tvweb:port)/;
var appDir = APP_DIR;
var procDir = '/proc';
var layoutDir = '/mnt/lg/cmn_data/manifest';
var keptDir = '/var/lib/tvweb/home-takeover-lg-layout';
var checkpointDirs = ['/tmp/checkpoint', '/mnt/lg/cmn_data/checkpoint'];
var execFn = execFile;
var killFn = function (pid) { process.kill(pid, 'SIGTERM'); };
var blankWanted = function () { return false; };
var blockFirst = function () { return false; };

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  samrescan = opts.samrescan || null;
  if (opts.stageDir) stageDir = opts.stageDir;
  if (opts.sourceDir) sourceDir = opts.sourceDir;
  serverPort = opts.port ? Number(opts.port) : 8080;
  if (opts.appDir) appDir = opts.appDir;
  if (opts.procDir) procDir = opts.procDir;
  if (opts.layoutDir) layoutDir = opts.layoutDir;
  if (opts.keptDir) keptDir = opts.keptDir;
  if (opts.checkpointDirs) checkpointDirs = opts.checkpointDirs;
  if (opts.exec) execFn = opts.exec;
  if (opts.kill) killFn = opts.kill;
  if (opts.blankAtStart) blankWanted = opts.blankAtStart;
  if (opts.blockFirst) blockFirst = opts.blockFirst;
}

function luna(uri, payload, cb) {
  if (!lunaFn) return cb(null);
  lunaFn(uri, payload, function (r) { cb(r || null); });
}

/*
 * The manifest sam reads for LG's Home while it is mounted. LG's own keeps
 * visible false, so neither LG's app list nor Glasshouse Home's lists it.
 * appCategory home as LG's has it: on webOS 10 the Home key opens the default
 * app of that category, and without it sam has none and the key does nothing
 * (a G5, webOS 10.3.1).
 */
function manifest() {
  return {
    id: LG_HOME,
    version: '1.0.0',
    vendor: 'tvweb',
    type: 'web',
    main: 'index.html',
    title: 'Home',
    icon: 'assets/icon80.png',
    largeIcon: 'assets/icon130.png',
    iconColor: '#000000',
    bgColor: '#000000',
    resolution: '1920x1080',
    visible: false,
    disableBackHistoryAPI: true,
    appCategory: ['home']
  };
}

function copyFile(from, to, transform) {
  var data = fs.readFileSync(from);
  if (transform) data = new Buffer(transform(data.toString('utf8')), 'utf8');
  var had = null;
  try { had = fs.readFileSync(to); } catch (e) {}
  if (had && had.toString('base64') === data.toString('base64')) return false;
  fs.writeFileSync(to, data);
  return true;
}

/*
 * The app's files as this release has them. Written in place: while mounted,
 * the next page load reads them, so a new release needs no remount.
 */
function stage() {
  try {
    mkdirp(path.join(stageDir, 'assets'));
    // The page cannot read config.json, so it carries the port the server is on.
    var changed = copyFile(path.join(sourceDir, 'index.html'), path.join(stageDir, 'index.html'), function (html) {
      return html.replace(PORT_LINE, '$1' + serverPort + '$2');
    });
    fs.readdirSync(path.join(sourceDir, 'assets')).forEach(function (f) {
      if (copyFile(path.join(sourceDir, 'assets', f), path.join(stageDir, 'assets', f))) changed = true;
    });
    var json = JSON.stringify(manifest(), null, 2) + '\n';
    var file = path.join(stageDir, 'appinfo.json');
    var had = '';
    try { had = fs.readFileSync(file, 'utf8'); } catch (e) {}
    if (had !== json) {
      fs.writeFileSync(file, json);
      changed = true;
    }
    return { ok: true, changed: changed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function blankInPlace() {
  return LAYOUT_FILES.some(function (f) {
    var t = readText(path.join(layoutDir, f));
    return t !== null && t.indexOf(BLANK_MARK) !== -1;
  });
}

/*
 * The empty layout in place, what was there kept aside first: a file each, or
 * a .none marker where there was none. Kept once, so a second take does not
 * keep the empty layout as LG's.
 */
function blankLayout() {
  try {
    if (!blankInPlace()) {
      mkdirp(keptDir);
      LAYOUT_FILES.forEach(function (f) {
        // A previous partial restore still owns this backup.
        if (fs.existsSync(path.join(keptDir, f)) || fs.existsSync(path.join(keptDir, f + '.none'))) return;
        var t = null;
        try { t = fs.readFileSync(path.join(layoutDir, f), 'utf8'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (t === null) fs.writeFileSync(path.join(keptDir, f + '.none'), '');
        else fs.writeFileSync(path.join(keptDir, f), t);
      });
    }
    mkdirp(layoutDir);
    LAYOUT_FILES.forEach(function (f) { fs.writeFileSync(path.join(layoutDir, f), BLANK_LAYOUT); });
    return true;
  } catch (e) {
    console.error('home: could not give LG\'s Home its starting layout: ' + e.message);
    return false;
  }
}

/*
 * LG's layout back, and its checkpoints gone: the copy made when it started at
 * boot holds the empty layout, and a restore from it would show that again.
 */
function restoreLayout() {
  if (!blankInPlace() && !fs.existsSync(keptDir)) return { ok: true };
  try {
    LAYOUT_FILES.forEach(function (f) {
      var target = path.join(layoutDir, f);
      var kept = path.join(keptDir, f);
      if (fs.existsSync(kept)) fs.writeFileSync(target, fs.readFileSync(kept));
      else if (fs.existsSync(kept + '.none')) {
        try { fs.unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      } else if ((readText(target) || '').indexOf(BLANK_MARK) !== -1) {
        throw new Error('no saved layout for ' + f);
      }
    });
    try { fs.rmdirSync(layoutDir); } catch (e) {} // only goes if empty
  } catch (e) {
    return { ok: false, error: 'LG\'s Home layout could not be put back: ' + e.message };
  }
  LAYOUT_FILES.forEach(function (f) {
    try { fs.unlinkSync(path.join(keptDir, f)); } catch (e) {}
    try { fs.unlinkSync(path.join(keptDir, f + '.none')); } catch (e) {}
  });
  try { fs.rmdirSync(keptDir); } catch (e) {}
  clearCheckpoints();
  return { ok: true };
}

/*
 * The layout LG's Home starts on while Glasshouse Home has its place: the
 * empty one where it is chosen, LG's own otherwise. LG's Home is not running
 * then, so either can be written under it. { ok, error, blank }.
 */
function startLayout() {
  if (!blankWanted()) {
    var r = restoreLayout();
    r.blank = false;
    return r;
  }
  if (blankLayout()) return { ok: true, blank: true };
  return { ok: false, blank: true, error: 'could not prepare LG\'s Home\'s starting layout' };
}

/*
 * Taking the place fails only where the empty layout was wanted and could not
 * be written. LG's that could not be put back stays kept aside, and is tried
 * again whenever LG's Home gets its place back.
 */
function layoutForTake() {
  var r = startLayout();
  if (!r.ok && !r.blank) {
    console.error('home: ' + r.error);
    return { ok: true };
  }
  return r;
}

// The empty layout, or LG's kept aside from it, is still on the TV.
function blankKept() {
  return blankInPlace() || fs.existsSync(keptDir);
}

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
    try { fs.rmdirSync(p); } catch (e) {}
  } else {
    try { fs.unlinkSync(p); } catch (e) {}
  }
}

function clearCheckpoints() {
  checkpointDirs.forEach(function (d) {
    rmrf(path.join(d, LG_HOME));
    rmrf(path.join(d, 'hash_check_' + LG_HOME));
  });
}

// Mounted when LG's app directory is the staged one.
function mounted() {
  try {
    var a = fs.statSync(appDir);
    var b = fs.statSync(stageDir);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (e) {
    return false;
  }
}

// The type sam has for LG's Home: 'web' while it runs Glasshouse Home's.
function samType(cb) {
  luna('com.webos.applicationManager/getAppInfo', { id: LG_HOME }, function (r) {
    cb(r && r.appInfo && r.appInfo.type ? String(r.appInfo.type) : null);
  });
}

// Whether sam has this release's manifest, appCategory included.
function samHasManifest(cb) {
  luna('com.webos.applicationManager/getAppInfo', { id: LG_HOME }, function (r) {
    var info = r && r.appInfo;
    cb(!!info && info.type === 'web' &&
       JSON.stringify(info.appCategory || null) === JSON.stringify(manifest().appCategory));
  });
}

/*
 * sam reads the directory again and reports the type wanted. webOS 10 and 11
 * ignore the nudge, which costs its 8 s of polls before the block and release
 * there, so they go to the block and release first.
 */
function reread(wantWeb, cb, check) {
  if (!samrescan) return cb(false);
  check = check || function (done) {
    samType(function (type) { done(type !== null && (type === 'web') === wantWeb); });
  };
  var first = blockFirst() ? 'rereadApp' : 'refresh';
  var then = first === 'refresh' ? 'rereadApp' : 'refresh';
  function call(name, next) {
    if (name === 'refresh') samrescan.refresh(check, next);
    else samrescan.rereadApp(LG_HOME, check, next);
  }
  call(first, function (ok) {
    if (ok) return cb(true);
    call(then, cb);
  });
}

/*
 * LG's Home: its own executable on webOS 9, and on webOS 10 and 11 the Flutter
 * runner given its id, "/usr/bin/flutter-client -i com.webos.app.home" on a C2
 * (webOS 10.3.1), as other Flutter apps run too (#612).
 */
function isLgHome(argv) {
  if (argv[0] === LG_HOME_EXE) return true;
  if (path.basename(argv[0] || '') !== 'flutter-client') return false;
  var i = argv.indexOf('-i');
  return i !== -1 && argv[i + 1] === LG_HOME;
}

function lgHomePids() {
  var pids = [];
  try {
    fs.readdirSync(procDir).forEach(function (d) {
      if (!/^\d+$/.test(d)) return;
      try {
        var argv = fs.readFileSync(path.join(procDir, d, 'cmdline'), 'utf8').split('\0');
        if (isLgHome(argv)) pids.push(Number(d));
      } catch (e) {}
    });
  } catch (e) {}
  return pids;
}

function stopLgHome() {
  var pids = lgHomePids();
  pids.forEach(function (pid) {
    try { killFn(pid); } catch (e) {}
  });
  return pids.length;
}

/*
 * Glasshouse Home in LG's Home's place. cb({ ok }); where sam does not take
 * it, LG's files are put back under sam, so the two agree.
 */
function take(cb) {
  var st = stage();
  if (!st.ok) return giveBack('could not stage the app: ' + st.error);
  function settle() {
    reread(true, function (ok) {
      if (ok) {
        var layout = layoutForTake();
        if (!layout.ok) return giveBack(layout.error);
        var stopped = stopLgHome();
        return cb({ ok: true, stoppedLg: stopped > 0 });
      }
      giveBack('sam did not take Glasshouse Home as Home');
    }, samHasManifest);
  }
  function giveBack(error) {
    release(function (r) { cb({ ok: false, error: r.ok ? error : error + '; ' + r.error }); });
  }
  if (mounted()) {
    // The files can be current while sam still has an earlier manifest,
    // after a restart between staging and rereading, or a failed reread.
    return samHasManifest(function (ok) {
      if (!ok) return settle();
      var layout = layoutForTake();
      if (!layout.ok) return giveBack(layout.error);
      stopLgHome();
      cb({ ok: true, already: true });
    });
  }
  execFn('/bin/mount', ['--bind', stageDir, appDir], { timeout: 4000 }, function (err) {
    if (err || !mounted()) return giveBack('the mount did not take');
    settle();
  });
}

function unmount(cb) {
  if (!mounted()) return cb();
  execFn('/bin/umount', [appDir], { timeout: 4000 }, function (err) {
    if (!err && !mounted()) return cb();
    execFn('/bin/umount', ['-l', appDir], { timeout: 4000 }, function () { cb(); });
  });
}

/*
 * LG's Home back in its own place. Glasshouse Home's page is closed last,
 * once sam has LG's manifest: where it was in front, the TV opens LG's Home.
 */
function release(cb) {
  var restored = restoreLayout();
  if (!restored.ok) return cb(restored);
  unmount(function () {
    if (mounted()) return cb({ ok: false, error: 'LG\'s Home could not be put back: the mount is held' });
    samType(function (type) {
      function closePage() {
        luna('com.palm.webappmanager/killApp', { appId: LG_HOME }, function () { cb({ ok: true }); });
      }
      if (type !== 'web') return closePage();
      reread(false, function (ok) {
        if (!ok) return cb({ ok: false, error: 'sam did not take LG\'s Home back' });
        closePage();
      });
    });
  });
}

module.exports = {
  LG_HOME: LG_HOME,
  init: init,
  stage: stage,
  mounted: mounted,
  samType: samType,
  take: take,
  release: release,
  stopLgHome: stopLgHome,
  startLayout: startLayout,
  blankKept: blankKept,
  BLANK_MARK: BLANK_MARK
};

/*
 * tvwebctl, with the server stopped or not coming back: LG's Home back in its
 * place, while home.json keeps Glasshouse Home switched on for the server's
 * next start to take the place again.
 */
if (require.main === module && process.argv[2] === '--release') {
  var lunaTransport = require('./luna');
  var rescan = require('./samrescan');
  var remoteKeys = require('./remotekeys');
  var releaseStateDir = path.join(__dirname, '..');
  rescan.init({ luna: lunaTransport.call });
  remoteKeys.init({ luna: lunaTransport.call, stateDir: releaseStateDir });
  init({ luna: lunaTransport.call, samrescan: rescan, stageDir: path.join(releaseStateDir, 'home-takeover') });
  remoteKeys.setStarting('', function (keys) {
    function finish(r) {
      if (!keys || !keys.ok) r = { ok: false, error: 'the Home key\'s starting notice could not be cleared' };
      console.log(r.ok ? 'home: LG\'s Home is in its place' : 'home: ' + r.error);
      process.exit(r.ok ? 0 : 1);
    }
    if (!mounted()) return finish(restoreLayout());
    release(finish);
  });
}
