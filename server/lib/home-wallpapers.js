/* Optional Home wallpapers. No download happens until requested by an owner.
 * Kept outside assets so updates do not carry them into the rollback copy.
 * Strict ES5 for the TV's Node 0.10/0.12. */
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var util = require('./util');
var installer = require('./installer');
var fetch = require('./fetch');
var msg = require('./say').msg;

// Immutable source and independently checked bytes; never accept a URL from a request.
var SOURCE = 'https://raw.githubusercontent.com/Nutcasey/glasshouse/45816061619243e1be44a7dceda671aa753749b8/server/assets/home/wallpapers/';
var FILES = {
  morning: { size: 4610197, sha256: '76a605da632aad4f3d06437ffe9ecf7266b8d23c7225470dc59bcc1c4492dade' },
  afternoon: { size: 6352521, sha256: '3a94e01ac9298c57fd0065531630fc5fb2fc361a377582c6fa077334dbbb7119' },
  evening: { size: 4546106, sha256: '52d3e14d674eb66bfeec2b4c1ba3d2c3c93c630014c87e66d073bf8da476904f' },
  night: { size: 3587026, sha256: '9436aa3f385c16c5f69ef543356ff841aaf095c4001b3ccff205d4680d498740' }
};
var dir = '/var/lib/tvweb/home-wallpapers';
var downloading = false, error = null;
var total = Object.keys(FILES).reduce(function (n, key) { return n + FILES[key].size; }, 0);

function init(stateDir) { dir = path.join(stateDir, 'home-wallpapers'); }

function available() {
  return Object.keys(FILES).every(function (key) {
    try { return fs.statSync(path.join(dir, key + '.png')).size === FILES[key].size; }
    catch (e) { return false; }
  });
}

function status() { return { available: available(), downloading: downloading, error: error, bytes: total }; }

function image(key) {
  return Object.prototype.hasOwnProperty.call(FILES, key) && available() ? path.join(dir, key + '.png') : null;
}

function clear(folder) {
  Object.keys(FILES).forEach(function (key) { util.unlinkQuiet(path.join(folder, key + '.png')); });
  try { fs.rmdirSync(folder); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// A background job: both dashboards can poll, even on a slow connection.
function download(cb) {
  if (downloading || available()) return cb({ ok: true, wallpapers: status() });
  downloading = true;
  error = null;
  cb({ ok: true, wallpapers: status() });
  var staging = dir + '.part';
  function fail(e) {
    try { clear(staging); } catch (cleanupError) { console.error('home wallpapers: ' + cleanupError.message); }
    downloading = false;
    error = e.message;
    console.error('home wallpapers: ' + error);
  }
  try { clear(staging); fs.mkdirSync(staging); } catch (e) { return fail(e); }
  execFile('df', ['-k', staging], { timeout: 5000 }, function (err, out) {
    var free = err ? null : installer.parseDf(out);
    if (free === null || free < total + 5 * 1024 * 1024) {
      return fail(new Error(msg('srv.home.wallSpace', 'The wallpapers need 24 MB of free space. Free space could not be confirmed.')));
    }
    var keys = Object.keys(FILES), index = 0;
    function next() {
      if (index === keys.length) {
        try { clear(dir); fs.renameSync(staging, dir); } catch (e) { return fail(e); }
        downloading = false;
        return;
      }
      var key = keys[index++], file = path.join(staging, key + '.png');
      fetch.download(SOURCE + key + '.png', file, { expectedSize: FILES[key].size }, function (fetchError) {
        if (fetchError) return fail(fetchError);
        var size = 0;
        try { size = fs.statSync(file).size; } catch (e) { return fail(e); }
        if (size !== FILES[key].size) return fail(new Error(msg('srv.home.wallIncomplete', 'The wallpaper download is incomplete. Try again.')));
        installer.hashFile(file, function (hashError, hash) {
          if (hashError) return fail(hashError);
          if (hash !== FILES[key].sha256) return fail(new Error(msg('srv.home.wallHash', 'The wallpaper does not match its published checksum. Try again.')));
          next();
        });
      });
    }
    next();
  });
}

function remove(cb) {
  if (downloading) return cb({ ok: false, error: msg('srv.home.wallBusy', 'Wait for the wallpaper download to finish.') });
  try { clear(dir); clear(dir + '.part'); } catch (e) { return cb({ ok: false, error: e.message }); }
  error = null;
  cb({ ok: true, wallpapers: status() });
}

module.exports = { init: init, status: status, image: image, download: download, remove: remove };
