/* One-shot screenshots. Strict ES5 for Node 0.10 and 0.12. */
var fs = require('fs');
var path = require('path');
var constants = require('constants');
var msg = require('./say').msg;
var FILE_RE = /^capture_[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/;
var DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
var maxBytes = DEFAULT_MAX_BYTES;
// Remote captures bypass busy; allow the capture call's 15 s wait for writes.
var WRITE_GRACE_MS = 15000;
var directory = '/tmp';
var lunaFn = null;
var notifyFn = null;
var busy = false;
var cleaning = false;
var nowFn = Date.now;

function init(opts) {
  var bytes = typeof opts.maxMiB === 'number' ? opts.maxMiB * 1024 * 1024 : 0;
  maxBytes = isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_MAX_BYTES;
  directory = opts.directory || '/tmp';
  lunaFn = opts.luna;
  notifyFn = opts.notify || null;
  nowFn = opts.now || Date.now;
  busy = false;
}

function filePath(id) {
  return typeof id === 'string' && FILE_RE.test(id) ? path.join(directory, id) : null;
}

function missing() {
  return { ok: false, error: msg('srv.screenshots.missing', 'Screenshot not found') };
}

function list(cb) {
  fs.readdir(directory, function (err, names) {
    if (err) return cb({ ok: false, error: msg('srv.screenshots.listFailed', 'Could not list screenshots') });
    var images = [];
    names.forEach(function (id) {
      var file = filePath(id);
      if (!file) return;
      try {
        var st = fs.lstatSync(file);
        if (st.isFile() && st.size > 0) images.push({ id: id, size: st.size, modified: st.mtime.toISOString() });
      } catch (e) {} // A capture or deletion can finish during the scan.
    });
    images.sort(function (a, b) {
      return a.modified === b.modified ? (a.id < b.id ? 1 : -1) : (a.modified < b.modified ? 1 : -1);
    });
    cb({ ok: true, screenshots: images, maxBytes: maxBytes });
  });
}

// Hold the descriptor through serving so replacing the path cannot expose another file.
function openImage(id, cb) {
  var file = filePath(id);
  if (!file) return cb(missing());
  fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, function (err, fd) {
    if (err) return cb(missing());
    fs.fstat(fd, function (statErr, st) {
      if (statErr || !st.isFile() || !st.size) return fs.close(fd, function () { cb(missing()); });
      cb({ ok: true, fd: fd, path: file, size: st.size });
    });
  });
}

function remove(id, cb) {
  var file = filePath(id);
  if (!file) return cb(missing());
  fs.lstat(file, function (err, st) {
    if (err || !st.isFile() || !st.size) return cb(missing());
    // unlink removes only the directory entry if it becomes a symlink after lstat.
    fs.unlink(file, function (unlinkErr) {
      cb(unlinkErr ? { ok: false, error: msg('srv.screenshots.deleteFailed', 'Could not delete screenshot') } : { ok: true });
    });
  });
}

function clear(cb) {
  list(function (result) {
    if (!result.ok) return cb(result);
    function next() {
      if (!result.screenshots.length) return cb({ ok: true });
      remove(result.screenshots.pop().id, function (removed) {
        if (!removed.ok) return cb(removed);
        next();
      });
    }
    next();
  });
}

function cleanup(cb) {
  cb = cb || function () {};
  if (busy || cleaning) return cb({ ok: true });
  cleaning = true;
  function finish(result) {
    cleaning = false;
    if (!result.ok) console.warn('screenshots: cleanup failed: ' + result.error);
    cb(result);
  }
  list(function (result) {
    if (!result.ok) return finish(result);
    var total = result.screenshots.reduce(function (sum, image) { return sum + image.size; }, 0);
    var cutoff = nowFn() - WRITE_GRACE_MS;
    function next() {
      // Keep the newest capture, even if it alone exceeds the budget.
      if (busy || total <= maxBytes || result.screenshots.length < 2) return finish({ ok: true });
      var image = result.screenshots.pop();
      if (new Date(image.modified).getTime() > cutoff) return finish({ ok: true });
      remove(image.id, function (removed) {
        if (!removed.ok) return finish(removed);
        total -= image.size;
        next();
      });
    }
    next();
  });
}

function capture(method, cb, resolution) {
  if (resolution === undefined) resolution = '1920x1080';
  if (['DISPLAY', 'VIDEO', 'GRAPHIC'].indexOf(method) === -1) return cb({ ok: false, error: 'DISPLAY, VIDEO or GRAPHIC expected' });
  if (['3840x2160', '1920x1080', '960x540'].indexOf(resolution) === -1) return cb({ ok: false, error: '3840x2160, 1920x1080 or 960x540 expected' });
  if (busy) return cb({ ok: false, error: msg('srv.screenshots.busy', 'A screenshot is already being taken') });
  if (!lunaFn) return cb({ ok: false, error: msg('srv.screenshots.unavailable', 'Screenshot capture is unavailable') });
  // shortcut: same-millisecond captures share a filename, add a suffix if observed.
  var id = 'capture_' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
  var file = path.join(directory, id);
  var size = resolution.split('x');
  busy = true;
  function finish(result) {
    busy = false;
    cleanup(function () {
      if (result.ok && notifyFn) {
        try {
          notifyFn(msg('srv.screenshots.saved', 'Screenshot saved.'), function (notice) {
            if (!notice || !notice.ok) console.warn('screenshots: could not show saved notification');
          });
        } catch (e) { console.warn('screenshots: could not show saved notification: ' + e.message); }
      }
      cb(result);
    });
  }
  function failed(error) {
    // A failed capture can leave partial output; remove only this request's file.
    fs.unlink(file, function () {
      finish({ ok: false, error: msg('srv.screenshots.captureFailed', 'Could not take screenshot: {error}', { error: error }) });
    });
  }
  try {
    lunaFn('com.webos.service.capture/executeOneShot', {
      path: file, method: method, format: 'PNG', width: Number(size[0]), height: Number(size[1])
    }, function (reply) {
      try { if (typeof reply === 'string') reply = JSON.parse(reply); }
      catch (e) { reply = null; }
      if (!reply || reply.returnValue !== true) return failed((reply && reply.errorText) || msg('srv.remoteKeys.noCaptureResult', 'No capture result'));
      openImage(id, function (image) {
        if (!image.ok) return failed(msg('srv.screenshots.noFile', 'The TV did not write an image'));
        fs.close(image.fd, function () { finish({ ok: true, id: id }); });
      });
    });
  } catch (e) { failed(e.message); }
}

module.exports = { init: init, capture: capture, list: list, openImage: openImage, remove: remove, clear: clear, cleanup: cleanup };
