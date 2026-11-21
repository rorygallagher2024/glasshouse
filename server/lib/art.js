'use strict';
/*
 * lib/art.js - The pictures the Art screen saver shows: the owner's own,
 * uploaded from the browser, and paintings from museum collections in the
 * public domain. Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * The screen saver asks next() for each picture and is handed an address on
 * this server, never the museum's: the TV's own curl or wget fetches it (Qt's
 * network stack on webOS 4 is too old for most sites' TLS), and the file is
 * checked as a JPEG before it is shown.
 *
 * A collection is a query of a museum's open access API. Only the next
 * picture or two and the one on screen are kept, in CACHE_DIR, so a run never
 * waits on the network once the first has come; the rest are deleted.
 *
 * Nothing is fetched until a collection is picked, and then only while the
 * screen saver asks for pictures, one at a time.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var util = require('./util');
var installer = require('./installer');
var msg = require('./say').msg;
var fetchMod = require('./fetch');
var wallpapers = require('./home-wallpapers');

var stateDir = '/var/lib/tvweb';
var uploadsDir, cacheDir, settingsFile, queueFile;

// The owner's own: re-encoded by the browser at 1920 x 1080 or less.
var MAX_PICTURES = 100;
var MAX_UPLOAD = 5 * 1024 * 1024;
// A museum's print size is 3400 pixels on its long side, a few MB.
var MAX_FETCH = 12 * 1024 * 1024;
var MAX_FETCH_SIDE = 4096;
// Pictures fetched ahead, and how many recent ones are not picked again.
var QUEUE = 2;
var RECENT = 60;
// Long scrolls and folios are tiny on a 16:9 screen: their ratio is outside these.
var MIN_RATIO = 0.45, MAX_RATIO = 2.6;
var PICK_TRIES = 5;

var MINUTES = [5, 10, 15, 30, 60];
var FITS = ['fit', 'fill'];
var CAPTIONS = ['brief', 'always', 'off'];
var DEFAULTS = { mine: true, collections: [], minutes: 10, fit: 'fit', caption: 'brief' };

var CLEVELAND_API = 'https://openaccess-api.clevelandart.org/api/artworks/';
var CLEVELAND_CDN = /^https:\/\/openaccess-cdn\.clevelandart\.org\/[A-Za-z0-9._\/-]+\.jpg$/;
var CLEVELAND = msg('srv.art.cleveland', 'The Cleveland Museum of Art');

/*
 * The collections, each one query. Every work in them is CC0: free to show
 * with no conditions, so the credit is a courtesy.
 */
var COLLECTIONS = [
  { id: 'cma-european', departments: ['European Painting and Sculpture'],
    label: msg('srv.art.cmaEuropean', 'European paintings'),
    detail: msg('srv.art.cmaEuropeanDesc', 'Old masters, from the 1300s to the 1700s.') },
  { id: 'cma-modern', departments: ['Modern European Painting and Sculpture'],
    label: msg('srv.art.cmaModern', 'European paintings of the 1800s'),
    detail: msg('srv.art.cmaModernDesc', 'From Romanticism to Monet, Cézanne and Van Gogh.') },
  { id: 'cma-american', departments: ['American Painting and Sculpture'],
    label: msg('srv.art.cmaAmerican', 'American paintings'),
    detail: msg('srv.art.cmaAmericanDesc', 'Portraits and landscapes from the 1700s to the early 1900s.') },
  { id: 'cma-asian', departments: ['Japanese Art', 'Chinese Art'],
    label: msg('srv.art.cmaAsian', 'Japanese and Chinese paintings'),
    detail: msg('srv.art.cmaAsianDesc', 'Screens, hanging scrolls and album leaves.') }
];

var settings = copy(DEFAULTS);
// Fetched ahead: [{ key, file, info }]. shown: the last few served, kept on disk.
var queue = [], shown = [], recent = [];
var totals = {};          // department -> how many works the query has
var filling = false, lastError = '', uploading = false;
var turn = 0;             // alternates between the owner's own and the collections
var deck = [];            // the owner's own, shuffled, still to show
var downloadFn = function (url, file, cb) { fetchMod.download(url, file, {}, cb); };
var getJsonFn = fetchMod.getJson;
var freeFn = function (dir, cb) {
  execFile('df', ['-k', dir], { timeout: 5000 }, function (err, out) { cb(err ? null : installer.parseDf(out)); });
};

function copy(o) { return JSON.parse(JSON.stringify(o)); }

function paths() {
  uploadsDir = path.join(stateDir, 'art-pictures');
  cacheDir = path.join(stateDir, 'art-cache');
  settingsFile = path.join(stateDir, 'art.json');
  queueFile = path.join(cacheDir, 'queue.json');
}
paths();

function readSettings(raw) {
  var s = copy(DEFAULTS);
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.mine === 'boolean') s.mine = raw.mine;
  if (Array.isArray(raw.collections)) {
    s.collections = raw.collections.filter(function (id, i, all) {
      return collectionById(id) && all.indexOf(id) === i;
    });
  }
  if (MINUTES.indexOf(raw.minutes) !== -1) s.minutes = raw.minutes;
  if (FITS.indexOf(raw.fit) !== -1) s.fit = raw.fit;
  if (CAPTIONS.indexOf(raw.caption) !== -1) s.caption = raw.caption;
  return s;
}

function collectionById(id) {
  for (var i = 0; i < COLLECTIONS.length; i++) if (COLLECTIONS[i].id === id) return COLLECTIONS[i];
  return null;
}

/**
 * opts: stateDir, and for tests download(url, file, cb), getJson(url, cb), free(dir, cb).
 */
function init(opts) {
  opts = opts || {};
  if (opts.stateDir) { stateDir = opts.stateDir; paths(); }
  if (opts.download) downloadFn = opts.download;
  if (opts.getJson) getJsonFn = opts.getJson;
  if (opts.free) freeFn = opts.free;
  queue = []; shown = []; recent = []; totals = {}; deck = [];
  filling = false; lastError = ''; uploading = false; turn = 0;
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {}
  settings = readSettings(raw);
  readQueue();
}

// What was fetched ahead before a restart, where its file is still there.
function readQueue() {
  var saved = null;
  try { saved = JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch (e) {}
  if (saved && Array.isArray(saved.queue)) {
    queue = saved.queue.filter(function (item) {
      return item && /^[a-z0-9-]{1,40}$/.test(String(item.key)) && fs.existsSync(cacheFile(item.key));
    });
  }
  if (saved && Array.isArray(saved.recent)) recent = saved.recent.filter(function (k) { return typeof k === 'string'; }).slice(-RECENT);
  // Anything else in the folder is left from an earlier run.
  var files = [];
  try { files = fs.readdirSync(cacheDir); } catch (e) {}
  var keep = queue.map(function (item) { return item.key + '.jpg'; });
  files.forEach(function (name) {
    if (name !== 'queue.json' && keep.indexOf(name) === -1) util.unlinkQuiet(path.join(cacheDir, name));
  });
}

function saveQueue() {
  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
    util.writeJsonAtomic(queueFile, { queue: queue, recent: recent });
  } catch (e) {}
}

function cacheFile(key) { return path.join(cacheDir, key + '.jpg'); }

var PICTURE_ID = /^[0-9a-z]{8,24}$/;

function pictures() {
  var names = [];
  try { names = fs.readdirSync(uploadsDir); } catch (e) {}
  return names.map(function (n) { return /^([0-9a-z]{8,24})\.jpg$/.exec(n); })
    .filter(Boolean)
    .map(function (m) { return m[1]; })
    .sort();
}

/**
 * For the dashboard: the settings, the owner's pictures and the collections.
 */
function status() {
  return {
    ok: true,
    settings: copy(settings),
    pictures: pictures(),
    maxPictures: MAX_PICTURES,
    uploading: uploading,
    minuteChoices: MINUTES.slice(),
    collections: COLLECTIONS.map(function (c) {
      return { id: c.id, label: c.label, detail: c.detail, source: CLEVELAND, on: settings.collections.indexOf(c.id) !== -1 };
    }),
    fetching: filling,
    error: lastError || undefined
  };
}

function save(patch, cb) {
  if (!patch || typeof patch !== 'object') return cb({ ok: false, error: 'settings must be an object' });
  var next = copy(settings);
  ['mine', 'collections', 'minutes', 'fit', 'caption'].forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  });
  var read = readSettings(next);
  // Something sent that was not taken would otherwise pass silently.
  for (var k in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    if (JSON.stringify(read[k]) !== JSON.stringify(next[k])) return cb({ ok: false, error: 'invalid ' + k });
  }
  var dropped = settings.collections.filter(function (id) { return read.collections.indexOf(id) === -1; });
  settings = read;
  try { util.writeJsonAtomic(settingsFile, settings); }
  catch (e) { return cb({ ok: false, error: e.message }); }
  // Pictures fetched from a collection no longer picked go.
  if (dropped.length) {
    queue = queue.filter(function (item) {
      if (dropped.indexOf(item.collection) === -1) return true;
      util.unlinkQuiet(cacheFile(item.key));
      return false;
    });
    saveQueue();
  }
  lastError = '';
  // The first picture is ready by the time the screen saver first asks.
  fill();
  cb(status());
}

function newPictureId() {
  return (Date.now().toString(36) + crypto.randomBytes(4).toString('hex')).slice(0, 24);
}

/*
 * One more picture of the owner's own, a JPEG the browser made at 1920 x 1080
 * or less, under a name made here.
 */
function upload(req, cb) {
  function refused(text, code) { cb({ ok: false, error: text, status: code || 400 }); }
  if (uploading) return refused(msg('srv.art.uploading', 'Wait for the last picture to finish uploading.'), 409);
  if (pictures().length >= MAX_PICTURES) {
    return refused(msg('srv.art.full', 'Art holds {max} of your pictures. Remove one to add another.', { max: MAX_PICTURES }), 409);
  }
  uploading = true;
  function finish(text, code) {
    uploading = false;
    if (text) return refused(text, code);
    deck = [];
    cb(status());
  }
  wallpapers.receiveJpeg(req, { maxBytes: MAX_UPLOAD }, function (kind, buf) {
    if (kind === 'size') return finish(msg('srv.art.uploadSize', 'A picture must be a JPEG of at most 5 MB that states its size.'), 413);
    if (kind === 'timeout') return finish(msg('srv.art.uploadTimeout', 'The picture took too long to upload.'), 408);
    if (kind === 'image') return finish(msg('srv.art.uploadImage', 'Choose a JPEG of at most 1920 × 1080 pixels.'));
    if (kind === 'aborted') { uploading = false; return; }
    try { if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir); }
    catch (e) { return finish(e.message, 500); }
    freeFn(uploadsDir, function (free) {
      if (free === null || free < buf.length + 20 * 1024 * 1024) {
        return finish(msg('srv.art.space', 'The TV does not have enough free space for the picture.'), 507);
      }
      var file = path.join(uploadsDir, newPictureId() + '.jpg'), staging = file + '.part';
      fs.writeFile(staging, buf, { mode: parseInt('600', 8) }, function (err) {
        if (err) { util.unlinkQuiet(staging); return finish(err.message, 500); }
        fs.rename(staging, file, function (err2) {
          if (err2) util.unlinkQuiet(staging);
          finish(err2 && err2.message, err2 ? 500 : null);
        });
      });
    });
  });
}

// One of the owner's pictures, or with id omitted, all of them.
function remove(id, cb) {
  if (uploading) return cb({ ok: false, error: msg('srv.art.uploading', 'Wait for the last picture to finish uploading.') });
  var all = pictures();
  if (id !== undefined && all.indexOf(id) === -1) return cb({ ok: false, error: 'unknown picture' });
  try {
    (id !== undefined ? [id] : all).forEach(function (one) {
      try { fs.unlinkSync(path.join(uploadsDir, one + '.jpg')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    });
  } catch (e) { return cb({ ok: false, error: e.message }); }
  deck = [];
  cb(status());
}

/**
 * The file behind a picture's address, or null: "p-<id>" one of the owner's,
 * "c-<key>" one fetched from a collection.
 * @param {string} id
 * @returns {string|null}
 */
function image(id) {
  var m = /^(p|c)-([0-9a-z-]{1,40})$/.exec(String(id || ''));
  if (!m) return null;
  var file;
  if (m[1] === 'p') {
    if (!PICTURE_ID.test(m[2])) return null;
    file = path.join(uploadsDir, m[2] + '.jpg');
  } else {
    file = cacheFile(m[2]);
  }
  try { if (fs.statSync(file).isFile()) return file; } catch (e) {}
  return null;
}

// "Claude Monet (French, 1840–1926)" as "Claude Monet".
function artistName(creators) {
  if (!Array.isArray(creators) || !creators.length) return '';
  var d = String((creators[0] && creators[0].description) || '');
  return d.replace(/\s*\(.*$/, '').trim().slice(0, 120);
}

/*
 * A Cleveland record as a picture to fetch, or null where it has no print
 * image, or one too long and thin for the screen.
 */
function clevelandPick(rec, collection) {
  var print = rec && rec.images && rec.images.print;
  if (!print || !CLEVELAND_CDN.test(String(print.url || ''))) return null;
  var w = +print.width, h = +print.height, size = +print.filesize;
  if (!(w > 0 && h > 0) || w / h < MIN_RATIO || w / h > MAX_RATIO) return null;
  if (size && size > MAX_FETCH) return null;
  if (!/^\d{1,9}$/.test(String(rec.id))) return null;
  return {
    key: 'cma-' + rec.id,
    collection: collection.id,
    url: print.url,
    info: {
      title: String(rec.title || '').slice(0, 200),
      artist: artistName(rec.creators),
      date: String(rec.creation_date || '').slice(0, 60),
      credit: CLEVELAND
    }
  };
}

function clevelandUrl(department, skip, limit) {
  return CLEVELAND_API + '?cc0=1&has_image=1&type=Painting&fields=id,title,creators,creation_date,images' +
    '&department=' + encodeURIComponent(department) + '&skip=' + skip + '&limit=' + limit;
}

/*
 * One work from a collection that has not been shown lately: a random place
 * in one of its departments, its size learnt from the first answer.
 * cb(err, pick).
 */
function pickFrom(collection, cb) {
  var tries = 0;
  (function attempt() {
    if (tries++ >= PICK_TRIES) return cb(null, null);
    var dept = collection.departments[Math.floor(Math.random() * collection.departments.length)];
    var total = totals[dept];
    var skip = total ? Math.floor(Math.random() * total) : 0;
    getJsonFn(clevelandUrl(dept, skip, 1), function (err, doc) {
      if (err) return cb(err);
      if (!doc || !doc.info || !Array.isArray(doc.data)) return cb(new Error('the museum sent something unexpected'));
      if (typeof doc.info.total === 'number') {
        var first = !total;
        totals[dept] = doc.info.total;
        if (!doc.info.total) return attempt();
        // The first ask only learns the size; the work comes from a random place.
        if (first && doc.info.total > 1) return attempt();
      }
      var pick = clevelandPick(doc.data[0], collection);
      if (!pick || recent.indexOf(pick.key) !== -1 || inQueue(pick.key)) return attempt();
      cb(null, pick);
    });
  })();
}

function inQueue(key) {
  for (var i = 0; i < queue.length; i++) if (queue[i].key === key) return true;
  for (var j = 0; j < shown.length; j++) if (shown[j].key === key) return true;
  return false;
}

function readJpegFile(file) {
  var buf;
  try {
    var st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FETCH) return false;
    buf = fs.readFileSync(file);
  } catch (e) { return false; }
  return wallpapers.validJpeg(buf, MAX_FETCH_SIDE, MAX_FETCH_SIDE);
}

/*
 * Fetches ahead until QUEUE pictures from the picked collections are waiting,
 * one at a time. A failure stops it until the next ask, and is shown on the
 * dashboard.
 */
function fill() {
  if (filling || !settings.collections.length || queue.length >= QUEUE) return;
  filling = true;
  var picked = settings.collections;
  var collection = collectionById(picked[Math.floor(Math.random() * picked.length)]);
  function done(err) {
    filling = false;
    if (err) {
      lastError = msg('srv.art.fetchFailed', 'Could not fetch a painting: {error}', { error: String(err.message || err) });
      return;
    }
    lastError = '';
    fill();
  }
  pickFrom(collection, function (err, pick) {
    if (err) return done(err);
    if (!pick) return done(new Error('no painting of a size for the screen was found'));
    try { if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir); }
    catch (e) { return done(e); }
    freeFn(cacheDir, function (free) {
      if (free === null || free < MAX_FETCH + 20 * 1024 * 1024) {
        return done(new Error(msg('srv.art.space', 'The TV does not have enough free space for the picture.')));
      }
      var file = cacheFile(pick.key), part = file + '.part';
      downloadFn(pick.url, part, function (err2) {
        if (err2 || !readJpegFile(part)) {
          util.unlinkQuiet(part);
          return done(err2 || new Error('the picture was not a JPEG the TV can show'));
        }
        try { fs.renameSync(part, file); }
        catch (e) { util.unlinkQuiet(part); return done(e); }
        // A collection dropped while this one came.
        if (settings.collections.indexOf(pick.collection) === -1) { util.unlinkQuiet(file); return done(); }
        queue.push({ key: pick.key, collection: pick.collection, info: pick.info });
        saveQueue();
        done();
      });
    });
  });
}

function shuffled(list) {
  var a = list.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function nextOwn() {
  var all = pictures();
  if (!all.length) return null;
  deck = deck.filter(function (id) { return all.indexOf(id) !== -1; });
  if (!deck.length) deck = shuffled(all);
  return { id: 'p-' + deck.shift(), info: null };
}

// Keeps the one on screen and the one before it, which is still fading out.
function served(item) {
  shown.push(item);
  while (shown.length > 2) util.unlinkQuiet(cacheFile(shown.shift().key));
  recent.push(item.key);
  if (recent.length > RECENT) recent = recent.slice(-RECENT);
  saveQueue();
}

function nextCollection() {
  if (!queue.length) return null;
  var item = queue.shift();
  served(item);
  return { id: 'c-' + item.key, info: item.info };
}

/**
 * The next picture for the screen saver, with the settings it draws by:
 * { ok, id, info, minutes, fit, caption }, or { ok: false, empty } with
 * nothing to show, or { ok: false, waiting } while the first is fetched.
 * @param {function(Object): void} cb
 */
function next(cb) {
  var own = settings.mine && pictures().length > 0;
  var online = settings.collections.length > 0;
  var base = { minutes: settings.minutes, fit: settings.fit, caption: settings.caption };
  function answer(pick) {
    fill();
    if (!pick) {
      if (online) return cb(merge({ ok: false, waiting: true, error: lastError || undefined }, base));
      return cb(merge({ ok: false, empty: true, message: msg('srv.art.empty', 'Add pictures or pick a collection for Art on the Screensaver tab.') }, base));
    }
    cb(merge({ ok: true, id: pick.id, info: pick.info }, base));
  }
  if (own && online) {
    // Each in turn, the owner's first; a collection still fetching gives way.
    turn = (turn + 1) % 2;
    var first = turn === 1 ? nextOwn() : nextCollection();
    return answer(first || (turn === 1 ? nextCollection() : nextOwn()));
  }
  if (own) return answer(nextOwn());
  answer(nextCollection());
}

function merge(a, b) {
  for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
  return a;
}

module.exports = {
  init: init,
  status: status,
  save: save,
  upload: upload,
  remove: remove,
  image: image,
  next: next,
  fill: fill,
  clevelandPick: clevelandPick,
  COLLECTIONS: COLLECTIONS,
  MAX_PICTURES: MAX_PICTURES
};
