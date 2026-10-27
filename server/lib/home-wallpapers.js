/* Home wallpapers: personal images uploaded from the browser, one for each
 * time of day, or the example set fetched on request. None are packaged; a
 * slot without one is black.
 * Kept outside assets so updates do not carry them into the rollback copy.
 * Strict ES5 for the TV's Node 0.10/0.12. */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var util = require('./util');
var installer = require('./installer');
var msg = require('./say').msg;
var fetchMod = require('./fetch');

var SLOTS = ['morning', 'afternoon', 'evening', 'night'];
// webOS web apps render at 1920x1080 (home-app/appinfo.json), so larger adds nothing on screen.
var MAX_WIDTH = 1920, MAX_HEIGHT = 1080;
var uploadsDir = '/var/lib/tvweb/home-wallpaper-uploads';
var uploading = false;
var MAX_UPLOAD = 5 * 1024 * 1024;
// The example set, from a tag of its own repo so that it is not in every
// release's download. A tag's files never change: each is pinned here.
var EXAMPLES_BASE = 'https://raw.githubusercontent.com/rorygallagher2024/glasshouse-wallpapers/v1/';
var EXAMPLES = {
  morning: '07b116a4e124b5fa7021638c4653fab3ee1ad55dedeaed75dbcb3cd31cb13cc5',
  afternoon: '5c55ec973573e88f37805a65536ec1a07b5950de40ff19f9e54a30ef808f221c',
  evening: '651cf5c2123d35b4c06b2d317d3dc13e66806eea16a1d5e82c9e060eb8a1a743',
  night: '710be1cc3b9fb79f574f256eda6c64bb28e429c58e3a9d123ff6d5d40e8466eb'
};

function init(stateDir) {
  uploadsDir = path.join(stateDir, 'home-wallpaper-uploads');
}

function status() {
  var slots = {}, revision = [];
  SLOTS.forEach(function (key) {
    var file = image(key), st = null;
    try { if (file) st = fs.statSync(file); } catch (e) {}
    slots[key] = !!st;
    revision.push(st ? String(Number(st.mtime)) + '-' + st.size : '0');
  });
  return { available: SLOTS.some(function (key) { return slots[key]; }),
    uploading: uploading, slots: slots, revision: revision.join('.') };
}

function image(key) {
  if (SLOTS.indexOf(key) === -1) return null;
  var file = path.join(uploadsDir, key + '.jpg');
  try { if (fs.statSync(file).isFile()) return file; } catch (e) {}
  return null;
}

// Every slot's image, or with only, that slot's alone.
function removeUploads(cb, only) {
  if (uploading) return cb({ ok: false, error: msg('srv.home.wallUploading', 'Wait for the wallpaper upload to finish.') });
  if (only !== undefined && SLOTS.indexOf(only) === -1) return cb({ ok: false, error: msg('srv.home.wallSlot', 'unknown wallpaper slot') });
  try {
    (only !== undefined ? [only] : SLOTS).forEach(function (key) {
      [key + '.jpg', key + '.jpg.part'].forEach(function (name) {
        try { fs.unlinkSync(path.join(uploadsDir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      });
    });
  } catch (e) { return cb({ ok: false, error: e.message }); }
  cb({ ok: true, wallpapers: status() });
}

// The browser re-encodes uploads as JPEG. Check the format and frame bounds
// again here; no filename or image metadata becomes a filesystem path.
function validJpeg(buf) {
  if (buf.length < 12 || buf.readUInt16BE(0) !== 65496 || buf.readUInt16BE(buf.length - 2) !== 65497) return false;
  var at = 2, components = 0, scanned = false, quantised = false, huffman = false;
  while (at + 2 <= buf.length) {
    if (buf[at++] !== 255) return false;
    while (buf[at] === 255) at++;
    var marker = buf[at++];
    if (marker === 217) return at === buf.length && !!components && scanned && quantised && huffman;
    if (at + 2 > buf.length) return false;
    var len = buf.readUInt16BE(at);
    if (len < 2 || at + len > buf.length) return false;
    if (marker === 192 || marker === 194) {
      if (len < 8) return false;
      var height = buf.readUInt16BE(at + 3), width = buf.readUInt16BE(at + 5);
      var count = buf[at + 7];
      if (components || buf[at + 2] !== 8 || (count !== 1 && count !== 3) || len !== 8 + 3 * count ||
          !width || !height || width > MAX_WIDTH || height > MAX_HEIGHT) return false;
      components = count;
    }
    if (marker === 219) { if (len < 67) return false; quantised = true; }
    if (marker === 196) { if (len < 20) return false; huffman = true; }
    if (marker === 218) {
      var scanComponents = buf[at + 2];
      if (!components || !quantised || !huffman || !scanComponents || scanComponents > components || len !== 6 + 2 * scanComponents) return false;
      at += len;
      var start = at;
      // Entropy data may contain escaped FF bytes and restart markers.
      // A scan must reach another marker, not merely end in a claimed EOI.
      while (at < buf.length) {
        if (buf[at] !== 255) { at++; continue; }
        var next = buf[at + 1];
        if (next === 0 || (next >= 208 && next <= 215)) { at += 2; continue; }
        break;
      }
      if (at === start) return false;
      scanned = true;
      continue;
    }
    at += len;
  }
  return false;
}

function upload(key, req, cb) {
  function refused(text, code) { cb({ ok: false, error: text, status: code || 400 }); }
  if (SLOTS.indexOf(key) === -1) return refused('unknown wallpaper slot');
  if (uploading) return refused(msg('srv.home.wallUploading', 'Wait for the wallpaper upload to finish.'), 409);
  var length = String(req.headers['content-length'] || '');
  if (req.headers['transfer-encoding'] || !/^\d{1,8}$/.test(length) || +length < 1 || +length > MAX_UPLOAD) {
    return refused(msg('srv.home.wallUploadSize', 'The uploaded JPEG must be at most 5 MB and state its size.'), 413);
  }
  uploading = true;
  var chunks = [], got = 0, ended = false, finished = false;
  var file = path.join(uploadsDir, key + '.jpg'), staging = file + '.part';
  var timer = setTimeout(function () { finish(msg('srv.home.wallUploadTimeout', 'The wallpaper upload timed out.'), 408); }, 30000);
  function finish(text, code, abandoned) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    chunks = [];
    uploading = false;
    if (abandoned) return;
    if (text) return refused(text, code);
    cb({ ok: true, wallpapers: status() });
  }
  req.on('aborted', function () { if (!ended) finish(null, null, true); });
  req.on('error', function () { if (!ended) finish(null, null, true); });
  req.on('close', function () { if (!ended) finish(null, null, true); });
  req.on('data', function (chunk) {
    if (finished) return;
    got += chunk.length;
    if (got > +length) return finish(msg('srv.home.wallUploadSize', 'The uploaded JPEG must be at most 5 MB and state its size.'), 413);
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (finished) return;
    ended = true;
    clearTimeout(timer);
    var buf = Buffer.concat(chunks);
    chunks = [];
    if (got !== +length || !validJpeg(buf)) {
      return finish(msg('srv.home.wallUploadImage', 'Choose a valid JPEG up to 1920 × 1080 pixels.'));
    }
    try { if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir); }
    catch (e) { return finish(e.message, 500); }
    execFile('df', ['-k', uploadsDir], { timeout: 5000 }, function (err, out) {
      var free = err ? null : installer.parseDf(out);
      if (free === null || free < buf.length + 5 * 1024 * 1024) {
        return finish(msg('srv.home.wallUploadSpace', 'Not enough confirmed free space for the wallpaper.'), 507);
      }
      fs.writeFile(staging, buf, { mode: parseInt('600', 8) }, function (writeError) {
        if (writeError) { util.unlinkQuiet(staging); return finish(writeError.message, 500); }
        fs.rename(staging, file, function (renameError) {
          if (renameError) util.unlinkQuiet(staging);
          finish(renameError && renameError.message, renameError ? 500 : null);
        });
      });
    });
  });
}

// The example set into every slot without a picture; the owner's own are kept.
function addExamples(cb) {
  if (uploading) return cb({ ok: false, error: msg('srv.home.wallUploading', 'Wait for the wallpaper upload to finish.'), status: 409 });
  var empty = SLOTS.filter(function (key) { return !image(key); });
  if (!empty.length) return cb({ ok: true, added: 0, wallpapers: status() });
  try { if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir); }
  catch (e) { return cb({ ok: false, error: e.message }); }
  uploading = true;
  var added = 0;
  function done(error) {
    uploading = false;
    if (error) return cb({ ok: false, error: error, added: added, wallpapers: status() });
    cb({ ok: true, added: added, wallpapers: status() });
  }
  execFile('df', ['-k', uploadsDir], { timeout: 5000 }, function (err, out) {
    var free = err ? null : installer.parseDf(out);
    if (free === null || free < empty.length * MAX_UPLOAD + 5 * 1024 * 1024) {
      return done(msg('srv.home.wallUploadSpace', 'Not enough confirmed free space for the wallpaper.'));
    }
    (function next(i) {
      if (i >= empty.length) return done(null);
      var key = empty[i], file = path.join(uploadsDir, key + '.jpg'), staging = file + '.part';
      fetchMod.download(EXAMPLES_BASE + key + '.jpg', staging, {}, function (fetchError) {
        if (fetchError) { util.unlinkQuiet(staging); return done(fetchError.message); }
        fs.readFile(staging, function (readError, buf) {
          if (readError) { util.unlinkQuiet(staging); return done(readError.message); }
          if (buf.length > MAX_UPLOAD || crypto.createHash('sha256').update(buf).digest('hex') !== EXAMPLES[key] || !validJpeg(buf)) {
            util.unlinkQuiet(staging);
            return done(msg('srv.home.wallExampleBad', 'An example wallpaper did not download intact. Try again later.'));
          }
          try { fs.chmodSync(staging, parseInt('600', 8)); } catch (e) {}
          fs.rename(staging, file, function (renameError) {
            if (renameError) { util.unlinkQuiet(staging); return done(renameError.message); }
            added++;
            next(i + 1);
          });
        });
      });
    })(0);
  });
}

module.exports = { init: init, status: status, image: image, upload: upload, removeUploads: removeUploads,
  addExamples: addExamples, EXAMPLES: EXAMPLES };
