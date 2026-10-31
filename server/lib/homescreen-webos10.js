/*
 * lib/homescreen-webos10.js - the parts of LG's Home screen on webOS 10,
 * switched off through an overlay on the home app's own layout
 *
 * webOS 10's home app (Flutter) lays out its first screen from home.xml in its
 * assets folder, on the read-only system, and looks nowhere writable for it:
 * its compiled code names no such path (a C4 on 11.2.0, #612). So a changed
 * home.xml is laid over LG's folder with an overlay mount (the TV's kernel has
 * overlayfs), which leaves every other file LG's, and the home app is
 * restarted to read it. The mount does not survive a restart of the TV, so
 * reapply() puts it back when the server starts.
 *
 * What is offered is what has been shown to work on webOS 10 TVs
 * (github.com/mareklarek/webos10-homescreen-customization): taking out the
 * Quick Cards and the recommended shelf, and shrinking the side icons to
 * nothing, placed after the banner. Taking the side icons out instead left
 * the screen black. Experimental: offered only once allowHomeLayout is set.
 *
 * The banner's picture and its text are files in the same folder (#833): the
 * picture in images/{hd,2k,4k}/bg_banner_img.png, the text in i18n, a symlink
 * to LG's language files elsewhere, so the overlay holds an i18n folder of its
 * own, copied from LG's each time it is mounted.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var msg = require('./say').msg;
var toBuffer = require('./util').toBuffer;

var HOME_ID = 'com.webos.app.home';
var PARTS = [
  { id: 'sideIcons', item: 'globalline' },
  { id: 'quickCards', item: 'qcardList' },
  { id: 'recommended', item: 'recommendedShelf' },
  { id: 'bannerText' }
];
// The banner's headline and button, as keys in each of LG's language files.
var BANNER_STRINGS = ['Start a new experience with webOS.', 'Go to Apps'];
var BANNER_IMAGE = 'bg_banner_img.png';
var BANNER_SIZES = ['hd', '2k', '4k'];
// lg, black or own (the owner's picture, uploaded).
var BANNERS = ['lg', 'black', 'own'];
// 64 x 30, black: the home app scales the banner's picture to the banner.
var BLACK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAeCAIAAAATj48OAAAAHElEQVR42u3BMQEAAADCoPVPbQsvoAAAAAAA4G0WngABFbrsPAAAAABJRU5ErkJggg==';
var MAX_BANNER_BYTES = 5 * 1024 * 1024;
var bannerUploading = false;

var lunaFn = null;
var config = null;
var webosVersion = null;
var assetsDir = '/usr/palm/applications/com.webos.app.home/data/flutter_assets/assets';
var stateDir = '/var/lib/tvweb';
var overlayDir = '/tmp/glasshouse-home';
// Where the i18n symlink points on a C2 (webOS 10.3.1), for when it cannot be read.
var l10nDir = '/mnt/lg/wee/ui_l10n/usr/palm/applications/com.webos.app.home/data/flutter_assets/assets/i18n';
var mountsFile = '/proc/mounts';
var filesystemsFile = '/proc/filesystems';
var checkpointDirs = ['/tmp/checkpoint', '/mnt/lg/cmn_data/checkpoint'];
var procDir = '/proc';
var supportedCache = null;

// Paths are options so test/test-homescreen-webos10.js can use a stand-in.
function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  config = opts.config || null;
  webosVersion = opts.webosVersion || null;
  ['assetsDir', 'stateDir', 'overlayDir', 'l10nDir', 'mountsFile', 'filesystemsFile', 'checkpointDirs', 'procDir'].forEach(function (k) {
    if (opts[k]) setPath(k, opts[k]);
  });
  supportedCache = null;
}

function setPath(k, v) {
  if (k === 'assetsDir') assetsDir = v;
  else if (k === 'stateDir') stateDir = v;
  else if (k === 'overlayDir') overlayDir = v;
  else if (k === 'l10nDir') l10nDir = v;
  else if (k === 'mountsFile') mountsFile = v;
  else if (k === 'filesystemsFile') filesystemsFile = v;
  else if (k === 'checkpointDirs') checkpointDirs = v;
  else if (k === 'procDir') procDir = v;
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function homeXml() { return path.join(assetsDir, 'home.xml'); }
// LG's own home.xml, kept: once the overlay is mounted it cannot be read.
function lgCopy() { return path.join(stateDir, 'home-webos10-lg.xml'); }
function stateFile() { return path.join(stateDir, 'home-webos10.json'); }
function ownBannerFile() { return path.join(stateDir, 'home-webos10-banner.jpg'); }

function mounted() {
  var m = readText(mountsFile) || '';
  return m.split('\n').some(function (l) {
    var f = l.split(' ');
    return f[1] === assetsDir && f[2] === 'overlay';
  });
}

// LG's layout: from the folder while nothing is mounted over it, else the copy.
function lgLayout() {
  return mounted() ? readText(lgCopy()) : readText(homeXml());
}

// The single-line items this module changes, each present once.
function recognised(xml) {
  if (!xml) return false;
  return PARTS.every(function (p) {
    if (!p.item) return true;
    var n = xml.split('\n').filter(function (l) { return l.indexOf('id="' + p.item + '"') !== -1; }).length;
    return n === 1;
  }) && /<item id="herobanner"[^>]*\/>/.test(xml) && /id="container" hasChildren="true"/.test(xml);
}

/*
 * webOS 10 only: webOS 11 adds a second page and drops the side icons, and is
 * left until one has been tried.
 */
function supported() {
  if (supportedCache !== null) return supportedCache;
  supportedCache = /^10\./.test(String(webosVersion || '')) &&
    /\boverlay\b/.test(readText(filesystemsFile) || '') && recognised(lgLayout());
  return supportedCache;
}

function allowed() { return !!(config && config.allowHomeLayout === true); }

function readState() {
  var st;
  try { st = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch (e) { st = {}; }
  var hidden = Array.isArray(st.hidden) ? st.hidden.filter(function (id) { return PARTS.some(function (p) { return p.id === id; }); }) : [];
  var banner = BANNERS.indexOf(st.banner) !== -1 ? st.banner : 'lg';
  if (banner === 'own' && !fs.existsSync(ownBannerFile())) banner = 'lg';
  return { hidden: hidden, banner: banner };
}

function readHidden() { return readState().hidden; }

function changed(st) { return st.hidden.length > 0 || st.banner !== 'lg'; }

function writeState(st) {
  if (changed(st)) fs.writeFileSync(stateFile(), JSON.stringify(st) + '\n', 'utf8');
  else if (fs.existsSync(stateFile())) fs.unlinkSync(stateFile());
}

function parts() {
  var hidden = readHidden();
  return PARTS.map(function (p) {
    return { id: p.id, title: partTitle(p.id), desc: partDesc(p.id), shown: hidden.indexOf(p.id) === -1 };
  });
}

function partTitle(id) {
  switch (id) {
    case 'sideIcons': return msg('srv.home.sideIcons', 'Side buttons');
    case 'quickCards': return msg('srv.home.quickCards', 'Quick Cards');
    case 'recommended': return msg('srv.home.recommended', 'Recommended shelf');
    case 'bannerText': return msg('srv.home.bannerText', 'Banner text');
  }
  return id;
}

function partDesc(id) {
  switch (id) {
    case 'sideIcons': return msg('srv.home.sideIcons.desc', 'The profile, notifications, settings and search buttons beside the banner. Settings and search stay on the remote\'s own buttons.');
    case 'quickCards': return msg('srv.home.quickCards.desc', 'The coloured buttons for LG\'s offers, Sports, Gaming, Music and others.');
    case 'recommended': return msg('srv.home.recommended.desc', 'The row of programmes and films LG recommends, below the apps.');
    case 'bannerText': return msg('srv.home.bannerText.desc', 'The line inviting a new experience with webOS, and the Go to Apps button, over the banner\'s picture.');
  }
  return '';
}

// LG's layout with the hidden parts taken out, or the side icons shrunk to
// nothing and moved after the banner.
function itemHeight(l) {
  var m = /itemHeight="(\d+)"/.exec(l);
  return m ? Number(m[1]) : 0;
}

// The home app lays the rows out top to bottom from their heights, so a row
// that is only removed pulls the apps row up to the middle of the screen
// (#612). The banner takes over the height of each removed row and the gap
// above it, keeping the apps row where LG puts it. With the side buttons
// hidden the banner also takes their width and the gap above the container,
// as LG's 3492-wide banner left a strip of black down the right and along the
// top (#833); the rows add up to LG's height as before.
function buildLayout(lg, hidden) {
  var lines = lg.split('\n');
  var sideHidden = hidden.indexOf('sideIcons') !== -1;
  var sideLine = null;
  var freed = 0;
  var top = 0;
  var fullWidth = 0;
  var inContainer = false;
  var out = [];
  lines.forEach(function (l) {
    if ((hidden.indexOf('quickCards') !== -1 && l.indexOf('id="qcardList"') !== -1) ||
        (hidden.indexOf('recommended') !== -1 && l.indexOf('id="recommendedShelf"') !== -1)) {
      freed += itemHeight(l);
      // The gap after the apps row stays: it keeps the row off the bottom edge.
      var prev = out[out.length - 1];
      if (l.indexOf('qcardList') !== -1 && prev && prev.indexOf('id="margin"') !== -1) freed += itemHeight(out.pop());
      return;
    }
    if (sideHidden && l.indexOf('id="globalline"') !== -1) {
      sideLine = l.replace(/itemWidth="\d+"/, 'itemWidth="0"').replace(/itemHeight="\d+"/, 'itemHeight="0"');
      return;
    }
    if (/id="container"/.test(l)) {
      inContainer = true;
      fullWidth = itemWidth(l);
    }
    // The gap above the banner, where it is the first row.
    if (sideHidden && !inContainer && !top && /id="margin"/.test(l) && itemHeight(l)) {
      top = itemHeight(l);
      l = l.replace(/itemHeight="\d+"/, 'itemHeight="0"');
    }
    if (sideHidden && fullWidth && /<item id="herobanner"/.test(l)) l = l.replace(/itemWidth="\d+"/, 'itemWidth="' + fullWidth + '"');
    out.push(l);
    if (sideLine && /<item id="herobanner"/.test(l)) {
      out.push(sideLine);
      sideLine = null;
    }
  });
  var grow = freed + top;
  if (grow) {
    out = out.map(function (l) {
      if (!/id="(container|herobanner|globalline)"/.test(l) || !itemHeight(l)) return l;
      return l.replace(/itemHeight="\d+"/, 'itemHeight="' + (itemHeight(l) + grow) + '"');
    });
  }
  return out.join('\n');
}

function itemWidth(l) {
  var m = /itemWidth="(\d+)"/.exec(l);
  return m ? Number(m[1]) : 0;
}

function sh(cmd, cb) {
  execFile('/bin/sh', ['-c', cmd], { timeout: 8000 }, function (err, out, errOut) {
    cb(err ? (String(errOut || '').trim() || err.message) : null);
  });
}

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/*
 * The overlay on top of LG's folder, replacing any before: our home.xml, and
 * the banner's text and picture where they are changed. The files are written
 * once the old overlay is off, so LG's language files can be read.
 */
function mountLayout(xml, st, cb) {
  var upper = path.join(overlayDir, 'upper');
  var work = path.join(overlayDir, 'work');
  sh('umount ' + q(assetsDir) + ' 2>/dev/null; rm -rf ' + q(overlayDir) + ' && mkdir -p ' + q(upper) + ' ' + q(work), function (err) {
    if (err) return cb(err);
    try {
      mkdirp(upper);
      fs.writeFileSync(path.join(upper, 'home.xml'), xml, 'utf8');
      if (st.hidden.indexOf('bannerText') !== -1) writeLanguageFiles(path.join(upper, 'i18n'));
      if (st.banner !== 'lg') writeBanner(upper, st.banner);
    } catch (e) {
      return cb(e.message);
    }
    sh('mount -t overlay overlay -o ' + q('lowerdir=' + assetsDir + ',upperdir=' + upper + ',workdir=' + work) + ' ' + q(assetsDir), cb);
  });
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

// LG's language files: where the i18n symlink points, or the folder itself.
function languageSource() {
  var link = path.join(assetsDir, 'i18n');
  try {
    if (fs.lstatSync(link).isSymbolicLink()) return path.resolve(assetsDir, fs.readlinkSync(link));
    return link;
  } catch (e) {
    return l10nDir;
  }
}

/*
 * A copy of LG's language files with the banner's strings blank, added where a
 * file lacks them: the text is looked up by its English, which a language
 * without the key shows as it is.
 */
function writeLanguageFiles(dest) {
  var src = languageSource();
  var names = fs.readdirSync(src);
  mkdirp(dest);
  names.forEach(function (name) {
    var from = path.join(src, name), to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) return;
    var text = fs.readFileSync(from, 'utf8');
    if (/\.json$/i.test(name)) {
      try {
        var strings = JSON.parse(text);
        if (strings && typeof strings === 'object' && !Array.isArray(strings)) {
          BANNER_STRINGS.forEach(function (k) { if (typeof strings[k] === 'string' || !(k in strings)) strings[k] = ''; });
          text = JSON.stringify(strings);
        }
      } catch (e) {}
    }
    fs.writeFileSync(to, text, 'utf8');
  });
}

// The picture in each size folder LG has, linked rather than copied: /tmp is memory.
function writeBanner(upper, banner) {
  var data = banner === 'own' ? fs.readFileSync(ownBannerFile()) : toBuffer(BLACK_PNG, 'base64');
  var first = null;
  BANNER_SIZES.forEach(function (size) {
    if (!fs.existsSync(path.join(assetsDir, 'images', size))) return;
    var dir = path.join(upper, 'images', size);
    mkdirp(dir);
    var file = path.join(dir, BANNER_IMAGE);
    if (first) {
      try { return fs.linkSync(first, file); } catch (e) {}
    }
    fs.writeFileSync(file, data);
    first = first || file;
  });
}

function unmountLayout(cb) {
  sh('umount ' + q(assetsDir) + ' 2>/dev/null; rm -rf ' + q(overlayDir) + '; true', function () { cb(); });
}

/*
 * Applies the choices: the overlay when anything is changed, none otherwise,
 * and the home app restarted to read it.
 */
function apply(st, cb) {
  if (!changed(st)) {
    return unmountLayout(function () { restartHome(cb); });
  }
  var lg = lgLayout();
  if (!recognised(lg)) return cb(msg('srv.home.noLayout', 'Could not read LG\'s Home screen layout'));
  try { fs.writeFileSync(lgCopy(), lg, 'utf8'); } catch (e) { return cb(e.message); }
  mountLayout(buildLayout(lg, st.hidden), st, function (err) {
    if (err) return cb(err);
    restartHome(cb);
  });
}

// cb's refusal where the layout cannot be changed now, or null.
function refusal() {
  if (!supported()) return { ok: false, error: msg('srv.home.unsupported', 'This TV\'s Home screen cannot be changed from here') };
  if (!allowed()) return { ok: false, error: msg('srv.home.notAllowed', 'Switch on Home screen layout first. It is experimental on this TV.') };
  return null;
}

function save(st, cb) {
  try { writeState(st); } catch (e) { return cb({ ok: false, error: e.message }); }
  apply(st, function (err) { cb(err ? { ok: false, error: err } : { ok: true }); });
}

function setPart(id, shown, cb) {
  var refused = refusal();
  if (refused) return cb(refused);
  if (!PARTS.some(function (p) { return p.id === id; })) return cb({ ok: false, error: msg('srv.home.unknownPart', 'There is no such part of the Home screen') });
  var st = readState();
  st.hidden = st.hidden.filter(function (h) { return h !== id; });
  if (!shown) st.hidden.push(id);
  console.log('homescreen: ' + id + (shown ? ' shown' : ' hidden') + ' (webOS 10)');
  save(st, cb);
}

/*
 * The banner's picture: { choice, own, width, height }, the size being the
 * banner's in the layout's units (3840 across), which grows with the rows
 * hidden.
 */
function banner() {
  var st = readState();
  var lg = lgLayout();
  var m = recognised(lg) && /<item id="herobanner"[^>]*itemWidth="(\d+)"[^>]*itemHeight="(\d+)"/.exec(buildLayout(lg, st.hidden));
  return { choice: st.banner, own: fs.existsSync(ownBannerFile()),
           width: m ? Number(m[1]) : 3492, height: m ? Number(m[2]) : 900 };
}

// LG's picture, black, or the owner's uploaded one.
function setBanner(choice, cb) {
  var refused = refusal();
  if (refused) return cb(refused);
  if (BANNERS.indexOf(choice) === -1) return cb({ ok: false, error: msg('srv.home.unknownBanner', 'There is no such banner picture') });
  if (choice === 'own' && !fs.existsSync(ownBannerFile())) return cb({ ok: false, error: msg('srv.home.noOwnBanner', 'Upload a picture first') });
  var st = readState();
  st.banner = choice;
  console.log('homescreen: banner picture ' + choice + ' (webOS 10)');
  save(st, cb);
}

/*
 * The owner's picture, a JPEG the browser has cropped to the banner, kept in
 * the state folder and chosen by uploading it. cb({ ok, error, status }).
 */
function uploadBanner(req, cb) {
  function refused(text, code) { cb({ ok: false, error: text, status: code || 400 }); }
  var notNow = refusal();
  if (notNow) return refused(notNow.error, 409);
  if (bannerUploading) return refused(msg('srv.home.bannerUploading', 'Wait for the picture to finish uploading.'), 409);
  bannerUploading = true;
  require('./home-wallpapers').receiveJpeg(req, { maxBytes: MAX_BANNER_BYTES, maxWidth: 3840, maxHeight: 2160 }, function (kind, buf) {
    function done(r) { bannerUploading = false; cb(r); }
    if (kind === 'aborted') { bannerUploading = false; return; }
    if (kind === 'size') return done({ ok: false, status: 413, error: msg('srv.home.bannerSize', 'The picture must be at most 5 MB and state its size.') });
    if (kind === 'timeout') return done({ ok: false, status: 408, error: msg('srv.home.bannerTimeout', 'The picture upload timed out.') });
    if (kind) return done({ ok: false, status: 400, error: msg('srv.home.bannerImage', 'Choose a valid JPEG up to 3840 × 2160 pixels.') });
    var staging = ownBannerFile() + '.part';
    try {
      fs.writeFileSync(staging, buf, { mode: parseInt('600', 8) });
      fs.renameSync(staging, ownBannerFile());
    } catch (e) {
      try { fs.unlinkSync(staging); } catch (e2) {}
      return done({ ok: false, status: 500, error: e.message });
    }
    var st = readState();
    st.banner = 'own';
    console.log('homescreen: banner picture uploaded (webOS 10)');
    save(st, done);
  });
}

// LG's Home screen back: the overlay off, the choices forgotten.
function restore(cb) {
  var had = mounted() || changed(readState());
  try { if (fs.existsSync(stateFile())) fs.unlinkSync(stateFile()); } catch (e) {}
  try { if (fs.existsSync(ownBannerFile())) fs.unlinkSync(ownBannerFile()); } catch (e) {}
  if (!had) return cb({ ok: true, changed: false });
  console.log('homescreen: LG\'s layout put back (webOS 10)');
  unmountLayout(function () {
    restartHome(function (err) { cb(err ? { ok: false, error: err } : { ok: true, changed: true }); });
  });
}

/*
 * At start: the overlay back where anything is changed and it is gone, as after
 * a restart of the TV. Nothing where it is still mounted, such as after the
 * server alone restarted.
 */
function reapply(cb) {
  cb = cb || function () {};
  if (!supported() || !allowed() || mounted()) return cb();
  var st = readState();
  if (!changed(st)) return cb();
  console.log('homescreen: putting the Home screen layout back (webOS 10)');
  apply(st, function (err) {
    if (err) console.error('homescreen: could not put the layout back: ' + err);
    cb();
  });
}

/*
 * The home app reads its layout when it starts. Killed, the TV may restore it
 * from a CRIU checkpoint with the old layout, so those go first (as on webOS
 * 9; harmless where there are none).
 */
function restartHome(cb) {
  var cmd = checkpointDirs.map(function (d) {
    return 'rm -rf ' + q(d + '/' + HOME_ID) + ' ' + q(d + '/hash_check_' + HOME_ID);
  }).join('; ');
  foreground(function (wasHome) {
    sh(cmd, function (err) {
      if (err) return cb(err);
      var failed = homePids().filter(function (pid) {
        // Checked again: the process may have gone and its id been reused.
        if (!isHome(pid)) return false;
        try { process.kill(pid, 'SIGTERM'); return false; } catch (e) { return e.code !== 'ESRCH'; }
      });
      if (failed.length) return cb(msg('srv.home.noRestart', 'Could not restart the Home screen'));
      if (!wasHome || !lunaFn) return cb(null);
      setTimeout(function () {
        lunaFn('com.webos.applicationManager/launch', { id: HOME_ID }, function () { cb(null); });
      }, 2000);
    });
  });
}

/*
 * The home app's processes. On a C2 (webOS 10.3.1) it runs as
 * "/usr/bin/flutter-client -i com.webos.app.home", so pidof finds nothing
 * (#612); other Flutter apps run as flutter-client too, so only the -i pair
 * marks it. Read from /proc rather than matched with pkill -f, whose pattern
 * would match this server's own shell.
 */
function homePids() {
  var names;
  try { names = fs.readdirSync(procDir); } catch (e) { return []; }
  return names.filter(function (n) { return /^\d+$/.test(n); }).map(Number).filter(isHome);
}

function isHome(pid) {
  var args = (readText(path.join(procDir, String(pid), 'cmdline')) || '').split('\0');
  if (path.basename(args[0]) === HOME_ID) return true;
  for (var i = 1; i < args.length - 1; i++) if (args[i] === '-i' && args[i + 1] === HOME_ID) return true;
  return false;
}

function foreground(cb) {
  if (!lunaFn) return cb(false);
  lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (r) {
    cb(!!(r && r.appId === HOME_ID));
  });
}

module.exports = {
  id: 'webos10',
  experimental: true,
  init: init,
  supported: supported,
  allowed: allowed,
  parts: parts,
  setPart: setPart,
  banner: banner,
  setBanner: setBanner,
  uploadBanner: uploadBanner,
  restore: restore,
  reapply: reapply,
  restartHome: restartHome,
  inputTiles: true,
  PARTS: PARTS,
  buildLayout: buildLayout
};
