'use strict';
/*
 * lib/art.js - The pictures the Picture frame screen saver (id "art") shows: the owner's own,
 * uploaded from the browser, paintings from museum collections in the public
 * domain, and folders on the home network's media servers (lib/dlna).
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * The screen saver asks next() for each picture and is handed an address on
 * this server, never the museum's: the TV's own curl or wget fetches it (Qt's
 * network stack on webOS 4 is too old for most sites' TLS), and the file is
 * checked as a JPEG before it is shown.
 *
 * A collection is a query of a museum's open access API: the Cleveland Museum
 * of Art's by department, the Rijksmuseum's by year. A network folder is a
 * folder of a media server, its pictures listed again every few minutes.
 * Only the next
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
var dlna = require('./dlna');

var stateDir = '/var/lib/tvweb';
var uploadsDir, cacheDir, settingsFile, queueFile;

// The owner's own: re-encoded by the browser at 1920 x 1080 or less.
var MAX_PICTURES = 100;
var MAX_UPLOAD = 5 * 1024 * 1024;
// A museum's print size is 3400 pixels on its long side, a few MB; a camera's
// photo on a media server may be 6000. The screen saver decodes either at the
// screen's size.
var MAX_FETCH = 12 * 1024 * 1024;
var MAX_FETCH_SIDE = 8192;
// Network folders: how many, and how long a folder's listing is used.
var MAX_FOLDERS = 10;
var LISTING_MS = 10 * 60 * 1000;
// Pictures fetched ahead, and how many recent ones are not picked again.
var QUEUE = 2;
var RECENT = 60;
// Long scrolls and folios are tiny on a 16:9 screen: their ratio is outside these.
var MIN_RATIO = 0.45, MAX_RATIO = 2.6;
var PICK_TRIES = 5;

// How long each picture stays, in seconds.
var SECONDS = [30, 60, 120, 300, 600, 900, 1800, 3600];
var FITS = ['fit', 'fill'];
var CAPTIONS = ['brief', 'always', 'off'];
var DEFAULTS = { mine: true, collections: [], folders: [], seconds: 600, fit: 'fit', caption: 'brief' };

var CLEVELAND_API = 'https://openaccess-api.clevelandart.org/api/artworks/';
var CLEVELAND_CDN = /^https:\/\/openaccess-cdn\.clevelandart\.org\/[A-Za-z0-9._\/-]+\.jpg$/;
var CLEVELAND = msg('srv.art.cleveland', 'The Cleveland Museum of Art');
var RIJKS_SEARCH = 'https://data.rijksmuseum.nl/search/collection?type=painting&imageAvailable=true&creationDate=';
var RIJKS_ID = /^https:\/\/id\.rijksmuseum\.nl\/\d{1,15}$/;
var RIJKS_IIIF = /^https:\/\/iiif\.micr\.io\/[A-Za-z0-9]{1,40}\/full\/max\/0\/default\.jpg$/;
// IIIF's best fit within this: room for Fill's crop, a few hundred KB.
var RIJKS_SIZE = '!2400,1400';
var RIJKS = msg('srv.art.rijks', 'Rijksmuseum');
// ESA/Webb and ESA/Hubble: CC BY 4.0, each image with its own credit line,
// which has to stay visible and unaltered (esawebb.org/copyright).
var ESA_ID = /^[a-z0-9_-]{1,60}$/i;
var ESA_PAGE = 50;
// Titles of what is not a picture to hang: diagrams, annotated or labelled
// versions, artists' impressions, the telescope itself and its tests.
var ESA_NOT_A_PICTURE = /compass|annotated|label|diagram|illustration|artist|impression|infographic|graph|chart|spectrum|comparison|sharpness|alignment|mirror|segment|test|instrument|telescope|spacecraft|launch|engineering|scale/i;
// Wikimedia Commons: the licences shown, all free to show with their credit.
var COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
var COMMONS_LICENCE = /^(pd|cc0|cc-by-\d(\.\d)?|cc-by-sa-\d(\.\d)?)$/;
var COMMONS_URL = /^https:\/\/(upload|thumb)\.wikimedia\.org\/[^\s"<>?]+\.jpe?g(\?[^\s"<>]*)?$/i;
var COMMONS = msg('srv.art.commons', 'Wikimedia Commons');
// Linked Art's English, and a name that is the title.
var AAT_ENGLISH = 'http://vocab.getty.edu/aat/300388277';
var AAT_PREFERRED = 'http://vocab.getty.edu/aat/300404670';
var AAT_CREATOR = 'http://vocab.getty.edu/aat/300435417';

/*
 * The collections, each one query. Every work in them is CC0 or in the public
 * domain: free to show with no conditions, so the credit is a courtesy.
 */
var COLLECTIONS = [
  { id: 'webb', museum: 'esa', group: 'space', site: 'esawebb.org', categories: ['pictureofthemonth', 'nebulae', 'galaxies'],
    label: msg('srv.art.webb', 'James Webb Space Telescope'),
    detail: msg('srv.art.webbDesc', 'Nebulae, galaxies and planets in infrared, from ESA/Webb.') },
  // Hubble's Picture of the Week, chosen by ESA, rather than its archive,
  // which holds diagrams and test charts among the pictures.
  { id: 'hubble', museum: 'esa', group: 'space', site: 'esahubble.org', list: '/images/potw/', perPage: 20,
    label: msg('srv.art.hubble', 'Hubble Space Telescope'),
    detail: msg('srv.art.hubbleDesc2', 'Picture of the Week: nebulae, galaxies and star clusters, from ESA/Hubble.') },
  { id: 'commons-landscapes', museum: 'commons', group: 'photos', category: 'Featured pictures of landscapes',
    label: msg('srv.art.landscapes', 'Landscapes'),
    detail: msg('srv.art.landscapesDesc', 'Mountains, coasts and countryside.') },
  { id: 'commons-phenomena', museum: 'commons', group: 'photos', category: 'Featured pictures of natural phenomena',
    label: msg('srv.art.phenomena', 'Skies and weather'),
    detail: msg('srv.art.phenomenaDesc', 'Sunsets, storms, auroras and rainbows.') },
  { id: 'commons-astronomy', museum: 'commons', group: 'photos', category: 'Featured pictures of astronomy',
    label: msg('srv.art.nightSky', 'The night sky'),
    detail: msg('srv.art.nightSkyDesc', 'The Milky Way, the Moon and eclipses, from the ground.') },
  { id: 'commons-animals', museum: 'commons', group: 'photos', category: 'Featured pictures of animals',
    label: msg('srv.art.animals', 'Animals'),
    detail: msg('srv.art.animalsDesc', 'Birds, mammals, insects and sea life, wild and tame.') },
  { id: 'commons-plants', museum: 'commons', group: 'photos', category: 'Featured pictures of plants',
    label: msg('srv.art.plants', 'Plants and flowers'),
    detail: msg('srv.art.plantsDesc', 'Flowers, trees and fungi, close up.') },
  { id: 'commons-architecture', museum: 'commons', group: 'photos', category: 'Featured pictures of architecture',
    label: msg('srv.art.architecture', 'Architecture'),
    detail: msg('srv.art.architectureDesc', 'Buildings, interiors and bridges.') },
  { id: 'rijks-golden', museum: 'rijks', group: 'paintings', years: [1600, 1699],
    label: msg('srv.art.rijksGolden', 'Dutch Golden Age paintings'),
    detail: msg('srv.art.rijksGoldenDesc', 'Rembrandt, Vermeer, Hals and their contemporaries.') },
  { id: 'rijks-later', museum: 'rijks', group: 'paintings', years: [1700, 1899],
    label: msg('srv.art.rijksLater', 'Dutch paintings of the 1700s and 1800s'),
    detail: msg('srv.art.rijksLaterDesc', 'From Dutch interiors to the Hague School and Breitner.') },
  { id: 'cma-european', museum: 'cma', group: 'paintings', departments: ['European Painting and Sculpture'],
    label: msg('srv.art.cmaEuropean', 'European paintings'),
    detail: msg('srv.art.cmaEuropeanDesc', 'Old masters, from the 1300s to the 1700s.') },
  { id: 'cma-modern', museum: 'cma', group: 'paintings', departments: ['Modern European Painting and Sculpture'],
    label: msg('srv.art.cmaModern', 'European paintings of the 1800s'),
    detail: msg('srv.art.cmaModernDesc', 'From Romanticism to Monet, Cézanne and Van Gogh.') },
  { id: 'cma-american', museum: 'cma', group: 'paintings', departments: ['American Painting and Sculpture'],
    label: msg('srv.art.cmaAmerican', 'American paintings'),
    detail: msg('srv.art.cmaAmericanDesc', 'Portraits and landscapes from the 1700s to the early 1900s.') },
  { id: 'cma-asian', museum: 'cma', group: 'paintings', departments: ['Japanese Art', 'Chinese Art'],
    label: msg('srv.art.cmaAsian', 'Japanese and Chinese paintings'),
    detail: msg('srv.art.cmaAsianDesc', 'Screens, hanging scrolls and album leaves.') }
];

var settings = copy(DEFAULTS);
// Fetched ahead: [{ key, collection, info }]. history: the last HISTORY shown,
// [{ id, info, key }], the one on screen at pos; a fetched one's file is kept
// while it is in it, so Previous can go back to it.
var queue = [], history = [], pos = -1, recent = [];
var HISTORY = 5;
// Next and Previous from the dashboard or the remote: each a new seq, which
// the screen saver and the No Signal screen ask for every couple of seconds.
var command = { seq: 0, dir: 'next' };
// When each view last asked: a view asking within VIEW_MS is on screen.
var viewedAt = {};
var VIEW_MS = 6000;
// The remote's left and right, watched while the No Signal screen shows.
var KEY_LEFT = 105, KEY_RIGHT = 106;
/** @type {function(boolean): void} */
var watchKeysFn = function () {};
var watching = false;
var watchTimer = null;
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
  if (Array.isArray(raw.folders)) {
    raw.folders.forEach(function (f) {
      var one = readFolder(f);
      if (one && s.folders.length < MAX_FOLDERS && !s.folders.some(function (o) { return o.key === one.key; })) s.folders.push(one);
    });
  }
  if (SECONDS.indexOf(raw.seconds) !== -1) s.seconds = raw.seconds;
  // Saved before seconds, by a build that offered minutes.
  else if (SECONDS.indexOf(raw.minutes * 60) !== -1) s.seconds = raw.minutes * 60;
  if (FITS.indexOf(raw.fit) !== -1) s.fit = raw.fit;
  if (CAPTIONS.indexOf(raw.caption) !== -1) s.caption = raw.caption;
  return s;
}

// A network folder as saved: its server and the folder, under a key of its own.
function readFolder(f) {
  if (!f || typeof f !== 'object') return null;
  var udn = String(f.udn || ''), id = String(f.id || ''), location = String(f.location || '');
  if (!udn || udn.length > 200 || !id || id.length > 500 || !/^http:\/\//.test(location) || location.length > 500) return null;
  return {
    key: folderKey(udn, id), udn: udn, id: id, location: location,
    server: String(f.server || '').slice(0, 120), title: String(f.title || '').slice(0, 300)
  };
}

function folderKey(udn, id) {
  return 'nf-' + crypto.createHash('sha1').update(udn + '\n' + id).digest('hex').slice(0, 12);
}

function folderByKey(key) {
  for (var i = 0; i < settings.folders.length; i++) if (settings.folders[i].key === key) return settings.folders[i];
  return null;
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
  if (opts.getText) getTextFn = opts.getText;
  if (opts.free) freeFn = opts.free;
  queue = []; history = []; pos = -1; recent = []; totals = {}; deck = [];
  command = { seq: 0, dir: 'next' }; viewedAt = {};
  if (opts.watchKeys) watchKeysFn = opts.watchKeys;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null; watching = false;
  filling = false; lastError = ''; uploading = false; turn = 0;
  servers = {}; listings = {};
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {}
  settings = readSettings(raw);
  readQueue();
}

// What was fetched ahead before a restart, where its file is still there.
function readQueue() {
  var saved = null;
  try { saved = JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch (e) {}
  // Only those of a source still picked: settings may have changed since.
  var picked = sources();
  if (saved && Array.isArray(saved.queue)) {
    queue = saved.queue.filter(function (item) {
      return item && /^[a-z0-9-]{1,40}$/.test(String(item.key)) && picked.indexOf(item.collection) !== -1 &&
        fs.existsSync(cacheFile(item.key));
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
    secondChoices: SECONDS.slice(),
    showing: viewing(),
    current: pos >= 0 && history[pos] ? { id: history[pos].id, info: history[pos].info } : null,
    canGoBack: pos > 0,
    collections: COLLECTIONS.map(function (c) {
      return { id: c.id, group: c.group, label: c.label, detail: c.detail, source: sourceName(c), on: settings.collections.indexOf(c.id) !== -1 };
    }),
    folders: settings.folders.map(function (f) { return { key: f.key, server: f.server, title: f.title }; }),
    maxFolders: MAX_FOLDERS,
    fetching: filling,
    error: lastError || undefined
  };
}

function save(patch, cb) {
  if (!patch || typeof patch !== 'object') return cb({ ok: false, error: 'settings must be an object' });
  var next = copy(settings);
  ['mine', 'collections', 'seconds', 'fit', 'caption'].forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  });
  var read = readSettings(next);
  // Something sent that was not taken would otherwise pass silently.
  for (var k in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    if (JSON.stringify(read[k]) !== JSON.stringify(next[k])) return cb({ ok: false, error: 'invalid ' + k });
  }
  commit(read, cb);
}

// The collections and network folders pictures are fetched from.
function sources() {
  return settings.collections.concat(settings.folders.map(function (f) { return f.key; }));
}

/*
 * New settings saved; pictures fetched from a source no longer picked go, and
 * the first picture of a new one is fetched by the time the screen saver asks.
 */
function commit(next, cb) {
  var before = sources();
  settings = next;
  try { util.writeJsonAtomic(settingsFile, settings); }
  catch (e) { return cb({ ok: false, error: e.message }); }
  var now = sources();
  var dropped = before.filter(function (id) { return now.indexOf(id) === -1; });
  if (dropped.length) {
    queue = queue.filter(function (item) {
      if (dropped.indexOf(item.collection) === -1) return true;
      util.unlinkQuiet(cacheFile(item.key));
      return false;
    });
    saveQueue();
  }
  lastError = '';
  fill();
  cb(status());
}

/*
 * The media servers on the network, found again each time: [{ udn, name }].
 * Those found are remembered, so a folder can be added from one by its udn.
 */
var servers = {};
function findServers(cb) {
  dlna.discover(function (err, list) {
    (list || []).forEach(function (sv) { servers[sv.udn] = sv; });
    cb({ ok: true, servers: (list || []).map(function (sv) { return { udn: sv.udn, name: sv.name }; }) });
  });
}

/*
 * One folder of a server found: its subfolders, and how many pictures it holds.
 */
function browseFolder(udn, id, cb) {
  var sv = servers[udn];
  if (!sv) return cb({ ok: false, error: msg('srv.art.serverGone', 'Look for media servers again: this one was not found.') });
  dlna.browse(sv.control, id || '0', MAX_FETCH_SIDE, function (err, r) {
    if (err) return cb({ ok: false, error: msg('srv.art.browseFailed', 'Could not open the folder: {error}', { error: err.message }) });
    cb({ ok: true, folders: r.folders, pictures: r.pictures.length, total: r.total });
  });
}

// A folder of a server found, added as a source.
function addFolder(udn, id, title, cb) {
  var sv = servers[udn];
  if (!sv) return cb({ ok: false, error: msg('srv.art.serverGone', 'Look for media servers again: this one was not found.') });
  if (settings.folders.length >= MAX_FOLDERS) {
    return cb({ ok: false, error: msg('srv.art.foldersFull', 'The picture frame takes up to {max} network folders. Remove one to add another.', { max: MAX_FOLDERS }) });
  }
  var f = readFolder({ udn: udn, id: id, location: sv.location, server: sv.name, title: title });
  if (!f) return cb({ ok: false, error: 'invalid folder' });
  if (folderByKey(f.key)) return cb(status());
  var next = copy(settings);
  next.folders.push(f);
  commit(readSettings(next), cb);
}

function removeFolder(key, cb) {
  if (!folderByKey(key)) return cb({ ok: false, error: 'unknown folder' });
  var next = copy(settings);
  next.folders = next.folders.filter(function (f) { return f.key !== key; });
  delete listings[key];
  commit(readSettings(next), cb);
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
    return refused(msg('srv.art.full', 'The picture frame holds {max} of your pictures. Remove one to add another.', { max: MAX_PICTURES }), 409);
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
function pickCleveland(collection, cb) {
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
  for (var j = 0; j < history.length; j++) if (history[j].key === key) return true;
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
// Linked Art's English name of a kind, else the first.
function englishName(names, kind) {
  var list = (Array.isArray(names) ? names : []).filter(function (n) {
    return n && n.type === 'Name' && typeof n.content === 'string' && (!kind || (n.classified_as || []).some(function (c) { return c && c.id === kind; }));
  });
  var en = list.filter(function (n) { return (n.language || []).some(function (l) { return l && l.id === AAT_ENGLISH; }); });
  return ((en[0] || list[0] || {}).content || '').trim();
}

function englishNotation(notation) {
  var list = Array.isArray(notation) ? notation : [];
  for (var i = 0; i < list.length; i++) if (list[i] && list[i]['@language'] === 'en') return String(list[i]['@value'] || '');
  return list[0] ? String(list[0]['@value'] || '') : '';
}

/*
 * A Rijksmuseum object (Linked Art) as a picture to fetch, or null: its IIIF
 * image, where it is marked public domain, at a size for the screen.
 */
function rijksPick(obj, collection) {
  if (!obj || typeof obj.id !== 'string' || !RIJKS_ID.test(obj.id)) return null;
  /** @type {string|null} */
  var image = null;
  (obj.subject_of || []).forEach(function (so) {
    (so && so.digitally_carried_by || []).forEach(function (dobj) {
      var free = (dobj.referred_to_by || []).some(function (r) { return /publicdomain/.test(String(r && r.content || '')); });
      (dobj.access_point || []).forEach(function (ap) {
        if (!image && free && ap && RIJKS_IIIF.test(String(ap.id || ''))) image = ap.id;
      });
    });
  });
  if (!image) return null;
  var made = obj.produced_by || {};
  var artist = '';
  [made].concat(made.part || []).forEach(function (part) {
    (part && part.carried_out_by || []).forEach(function (who) {
      if (!artist && who) artist = englishNotation(who.notation) || englishName(who.identified_by);
    });
  });
  // An attribution names its painter only in a statement: "Geo Poggenbeek (mentioned on object)".
  [made].concat(made.part || []).forEach(function (part) {
    (part && part.referred_to_by || []).forEach(function (r) {
      var says = r && typeof r.content === 'string' && (r.classified_as || []).some(function (c) { return c && c.id === AAT_CREATOR; }) &&
        (r.language || []).some(function (l) { return l && l.id === AAT_ENGLISH; });
      if (!artist && says) artist = r.content.replace(/\s*\(.*$/, '').trim();
    });
  });
  var date = made.timespan ? englishName(made.timespan.identified_by) : '';
  return {
    key: 'rk-' + obj.id.split('/').pop(),
    collection: collection.id,
    url: image.replace('/full/max/', '/full/' + RIJKS_SIZE + '/'),
    info: {
      title: (englishName(obj.identified_by, AAT_PREFERRED) || englishName(obj.identified_by)).slice(0, 200),
      artist: artist.slice(0, 120),
      date: date.slice(0, 60),
      credit: RIJKS
    }
  };
}

/*
 * One painting of a Rijksmuseum collection: the paintings of a random year in
 * its span, and one of those not shown lately.
 */
function pickRijks(collection, cb) {
  var tries = 0;
  (function attempt() {
    if (tries++ >= PICK_TRIES) return cb(null, null);
    var year = collection.years[0] + Math.floor(Math.random() * (collection.years[1] - collection.years[0] + 1));
    getJsonFn(RIJKS_SEARCH + year, function (err, doc) {
      if (err) return cb(err);
      var ids = (doc && Array.isArray(doc.orderedItems) ? doc.orderedItems : [])
        .map(function (o) { return o && String(o.id || ''); })
        .filter(function (id) { return RIJKS_ID.test(id) && recent.indexOf('rk-' + id.split('/').pop()) === -1 && !inQueue('rk-' + id.split('/').pop()); });
      if (!ids.length) return attempt();
      getJsonFn(ids[Math.floor(Math.random() * ids.length)], function (err2, obj) {
        if (err2) return cb(err2);
        var pick = rijksPick(obj, collection);
        if (!pick) return attempt();
        cb(null, pick);
      });
    });
  })();
}

// What each network folder holds, listed again after LISTING_MS: key -> { at, pictures }.
var listings = {};

/*
 * A folder's pictures, from its listing; where the server does not answer at
 * the address it had, it is looked for again by its udn, as a server's
 * address can change.
 */
function folderPictures(f, cb) {
  var l = listings[f.key];
  if (l && Date.now() - l.at < LISTING_MS) return cb(null, l.pictures);
  function list(control, again) {
    dlna.browse(control, f.id, MAX_FETCH_SIDE, function (err, r) {
      if (!err) {
        listings[f.key] = { at: Date.now(), pictures: r.pictures };
        return cb(null, r.pictures);
      }
      if (!again) return cb(err);
      dlna.discover(function (e2, found) {
        var sv = (found || []).filter(function (o) { return o.udn === f.udn; })[0];
        if (!sv) return cb(err);
        servers[sv.udn] = sv;
        f.location = sv.location;
        try { util.writeJsonAtomic(settingsFile, settings); } catch (e) {}
        list(sv.control, false);
      });
    });
  }
  dlna.describe(f.location, function (err, d) {
    if (err || d.udn !== f.udn) return list(null, true);
    list(d.control, true);
  });
}

function pickFolder(f, cb) {
  folderPictures(f, function (err, list) {
    if (err) return cb(err);
    var fresh = (list || []).filter(function (p) {
      var key = itemKey(f, p.id);
      return recent.indexOf(key) === -1 && !inQueue(key);
    });
    // All shown lately: any but those waiting or on screen.
    if (!fresh.length) fresh = (list || []).filter(function (p) { return !inQueue(itemKey(f, p.id)); });
    if (!fresh.length) return cb(null, null);
    var p = fresh[Math.floor(Math.random() * fresh.length)];
    var year = /^\d{4}/.exec(p.date || '');
    cb(null, {
      key: itemKey(f, p.id),
      collection: f.key,
      url: p.url,
      local: true,
      info: { title: p.title, artist: '', date: year ? year[0] : '', credit: [f.title, f.server].filter(Boolean).join(' \u00b7 ') }
    });
  });
}

function itemKey(f, id) {
  return 'dl-' + crypto.createHash('sha1').update(f.key + '\n' + id).digest('hex').slice(0, 16);
}

function sourceName(c) {
  if (c.museum === 'rijks') return RIJKS;
  if (c.museum === 'esa') return c.site === 'esawebb.org' ? 'ESA/Webb' : 'ESA/Hubble';
  if (c.museum === 'commons') return COMMONS;
  return CLEVELAND;
}

/*
 * A page fetched over HTTPS: cb(err, text). Through a file, as a download:
 * ESA/Hubble's deeper archive pages take 20 s to come, past a text fetch's
 * 10 s; a download gives up only once nothing has come for 30 s. getText is
 * the tests'.
 */
var getTextFn = function (url, cb) {
  try { if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir); } catch (e) { return cb(e); }
  var file = path.join(cacheDir, 'page-' + process.pid + '.part');
  fetchMod.download(url, file, {}, function (err) {
    var text = null;
    if (!err) {
      try {
        if (fs.statSync(file).size > 4 * 1024 * 1024) err = new Error('the page was too large');
        else text = fs.readFileSync(file, 'utf8');
      } catch (e) { err = e; }
    }
    util.unlinkQuiet(file);
    cb(err, text);
  });
};

function plain(htmlText) {
  return String(htmlText || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/\s+/g, ' ').trim();
}

/*
 * An ESA archive page's images: [{ id, title, width, height }], and how many
 * the category holds, from "Showing 1 to 50 of 710".
 */
function readEsaArchive(page) {
  var text = String(page || '');
  var total = /Showing \d+ to \d+ of (\d+)/.exec(text);
  var list = [], re = /\{\s*id:\s*'([^']*)',\s*title:\s*'((?:[^'\\]|\\.)*)',\s*width:\s*(\d+),\s*height:\s*(\d+)/g, m;
  while ((m = re.exec(text)) !== null) {
    list.push({ id: m[1], title: plain(m[2].replace(/\\(.)/g, '$1')), width: +m[3], height: +m[4] });
  }
  return { total: total ? +total[1] : list.length, images: list };
}

// A Picture of the Week page: its images' ids and titles, and how many there are.
function readEsaList(page) {
  var text = String(page || '');
  var total = /Showing \d+ to \d+ of (\d+)/.exec(text);
  var list = [], seen = {}, re = /<a href="\/images\/([a-z0-9_-]+)\/">\s*<div class="news-wrapper">[\s\S]*?alt="([^"]*)"/gi, m;
  while ((m = re.exec(text)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = true;
    list.push({ id: m[1], title: plain(m[2]), width: 0, height: 0 });
  }
  return { total: total ? +total[1] : list.length, images: list };
}

// An image page's size, "4000 x 2750 px", or null.
function readEsaSize(page) {
  var m = /(\d[\d,]*) x (\d[\d,]*) px/.exec(String(page || ''));
  return m ? [+m[1].replace(/,/g, ''), +m[2].replace(/,/g, '')] : null;
}

// An image page's credit line, as ESA asks it to be shown, word for word.
function readEsaCredit(page) {
  var m = /class="credit">([\s\S]*?)<\/div>/.exec(String(page || ''));
  // Whole or not at all: it is to be shown unaltered.
  var credit = m ? plain(m[1]) : '';
  return credit.length <= 400 ? credit : '';
}

/*
 * One image of an ESA collection: a random page of one of its categories, an
 * image of a shape for the screen not shown lately, and its credit from its
 * own page. Fetched at "publicationjpg", 4000 pixels on its long side.
 */
function pickEsa(collection, cb) {
  var tries = 0;
  (function attempt() {
    if (tries++ >= PICK_TRIES) return cb(null, null);
    var cat = collection.list ? 'potw' : collection.categories[Math.floor(Math.random() * collection.categories.length)];
    var base = 'https://' + collection.site + (collection.list || '/images/archive/category/' + cat + '/');
    var perPage = collection.perPage || ESA_PAGE;
    var known = totals[collection.site + '/' + cat];
    var pageNo = known ? 1 + Math.floor(Math.random() * Math.ceil(known / perPage)) : 1;
    getTextFn(pageNo > 1 ? base + 'page/' + pageNo + '/' : base, function (err, text) {
      if (err) return cb(err);
      var archive = collection.list ? readEsaList(text) : readEsaArchive(text);
      totals[collection.site + '/' + cat] = archive.total;
      // The first ask only learns the size, where there is more than a page.
      if (!known && archive.total > perPage) return attempt();
      var fit = archive.images.filter(function (im) {
        var key = 'esa-' + im.id.toLowerCase();
        // A list gives no size; the image's page does, below.
        var sized = !im.width || (im.width / im.height >= MIN_RATIO && im.width / im.height <= MAX_RATIO && Math.max(im.width, im.height) >= 1600);
        return ESA_ID.test(im.id) && sized && !ESA_NOT_A_PICTURE.test(im.title) &&
          recent.indexOf(key) === -1 && !inQueue(key);
      });
      if (!fit.length) return attempt();
      var im = fit[Math.floor(Math.random() * fit.length)];
      getTextFn('https://' + collection.site + '/images/' + im.id + '/', function (err2, pageText) {
        if (err2) return cb(err2);
        var credit = readEsaCredit(pageText);
        // No credit line found: not shown, as it could not be credited.
        if (!credit) return attempt();
        if (!im.width) {
          var size = readEsaSize(pageText);
          if (!size || size[0] / size[1] < MIN_RATIO || size[0] / size[1] > MAX_RATIO || Math.max(size[0], size[1]) < 1600) return attempt();
          im.width = size[0];
          im.height = size[1];
        }
        cb(null, {
          key: ('esa-' + im.id.toLowerCase()).slice(0, 40),
          collection: collection.id,
          url: 'https://cdn.' + collection.site + '/archives/images/publicationjpg/' + im.id + '.jpg',
          // Older images have no publicationjpg; their "large" is the original,
          // which is fetched only where it is of a modest size.
          also: Math.max(im.width, im.height) <= 6000 ? ['https://cdn.' + collection.site + '/archives/images/large/' + im.id + '.jpg'] : [],
          info: { title: im.title.slice(0, 200), artist: '', date: '', credit: credit, mustCredit: true }
        });
      });
    });
  })();
}

/*
 * A Commons file's details as a picture to fetch, or null: a JPEG under a
 * licence that lets it be shown with its credit, of a shape for the screen,
 * at a size that fills it.
 */
function commonsPick(page, collection) {
  var ii = page && page.imageinfo && page.imageinfo[0];
  if (!ii || !/^image\/jpeg$/.test(ii.mime || '')) return null;
  var meta = ii.extmetadata || {};
  function val(k) { return meta[k] && typeof meta[k].value === 'string' ? meta[k].value : ''; }
  var licence = val('License').toLowerCase();
  if (!COMMONS_LICENCE.test(licence)) return null;
  if (!(ii.width > 0 && ii.height > 0) || ii.width / ii.height < MIN_RATIO || ii.width / ii.height > MAX_RATIO) return null;
  if (Math.max(ii.width, ii.height) < 1600) return null;
  var url = ii.thumburl || ii.url;
  if (!COMMONS_URL.test(String(url || ''))) return null;
  var title = plain(val('ObjectName')) || String(page.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/_/g, ' ');
  var artist = plain(val('Artist')).slice(0, 100);
  var shortName = plain(val('LicenseShortName')) || licence.toUpperCase();
  var year = /\b(1[89]\d\d|20\d\d)\b/.exec(plain(val('DateTimeOriginal')));
  if (!/^\d{1,12}$/.test(String(page.pageid))) return null;
  return {
    key: 'wc-' + page.pageid,
    collection: collection.id,
    url: url,
    info: {
      title: title.slice(0, 200),
      artist: artist,
      date: year ? year[1] : '',
      credit: [shortName, COMMONS].join(' \u00b7 '),
      mustCredit: licence !== 'pd' && licence !== 'cc0'
    }
  };
}

function commonsSearch(collection, offset, limit) {
  return COMMONS_API + '?action=query&format=json&generator=search&gsrnamespace=6' +
    '&gsrsearch=' + encodeURIComponent('deepcat:"' + collection.category + '" filetype:bitmap') +
    '&gsroffset=' + offset + '&gsrlimit=' + limit +
    // Wikimedia serves thumbnails at set widths; 1920 is one, a few hundred KB.
    '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1920' +
    '&iiextmetadatafilter=' + encodeURIComponent('License|LicenseShortName|Artist|ObjectName|DateTimeOriginal');
}

/*
 * One featured picture of a Commons topic, its subcategories too: ten from a
 * random place in the search, and one of those that pass, not shown lately.
 */
function pickCommons(collection, cb) {
  var tries = 0;
  (function attempt() {
    if (tries++ >= PICK_TRIES) return cb(null, null);
    var total = totals[collection.id];
    // Search goes no further than its first 10,000.
    var offset = total ? Math.floor(Math.random() * Math.max(1, Math.min(total, 9990) - 10)) : 0;
    // The first ask only counts the topic's pictures.
    var ask = total ? commonsSearch(collection, offset, 10)
      : COMMONS_API + '?action=query&format=json&list=search&srnamespace=6&srlimit=1&srinfo=totalhits&srsearch=' +
        encodeURIComponent('deepcat:"' + collection.category + '" filetype:bitmap');
    getJsonFn(ask, function (err, doc) {
      if (err) return cb(err);
      if (!total) {
        var hits = doc && doc.query && doc.query.searchinfo && doc.query.searchinfo.totalhits;
        if (!hits) return cb(new Error('the topic has no pictures'));
        totals[collection.id] = hits;
        return attempt();
      }
      var pages = doc && doc.query && doc.query.pages ? Object.keys(doc.query.pages).map(function (k) { return doc.query.pages[k]; }) : [];
      var fit = pages.map(function (pg) { return commonsPick(pg, collection); }).filter(function (pick) {
        return pick && recent.indexOf(pick.key) === -1 && !inQueue(pick.key);
      });
      if (!fit.length) return attempt();
      cb(null, fit[Math.floor(Math.random() * fit.length)]);
    });
  })();
}

// A picture from one source: a collection's id or a network folder's key.
function pickFrom(source, cb) {
  var c = collectionById(source);
  if (c && c.museum === 'esa') return pickEsa(c, cb);
  if (c && c.museum === 'commons') return pickCommons(c, cb);
  if (c) return c.museum === 'rijks' ? pickRijks(c, cb) : pickCleveland(c, cb);
  var f = folderByKey(source);
  if (f) return pickFolder(f, cb);
  cb(null, null);
}

function fetchTo(pick, part, cb) {
  if (!pick.local) {
    var urls = [pick.url].concat(pick.also || []);
    return (function attempt(i, lastErr) {
      if (i >= urls.length) return cb(lastErr);
      downloadFn(urls[i], part, function (err) {
        if (err) { util.unlinkQuiet(part); return attempt(i + 1, err); }
        cb(null);
      });
    })(0, null);
  }
  dlna.fetchFile(pick.url, MAX_FETCH, function (err, buf) {
    if (err) return cb(err);
    fs.writeFile(part, buf, cb);
  });
}

function fill() {
  var all = sources();
  if (filling || !all.length || queue.length >= QUEUE) return;
  filling = true;
  var source = all[Math.floor(Math.random() * all.length)];
  var folder = folderByKey(source);
  function done(err) {
    filling = false;
    if (err) {
      var detail = String(err.message || err);
      lastError = folder
        ? msg('srv.art.folderFailed', 'Could not fetch a picture from {folder}: {error}', { folder: folder.title || folder.server, error: detail })
        : msg('srv.art.fetchFailed', 'Could not fetch a painting: {error}', { error: detail });
      return;
    }
    lastError = '';
    fill();
  }
  pickFrom(source, function (err, pick) {
    if (err) return done(err);
    if (!pick) {
      return done(new Error(folder ? msg('srv.art.folderEmpty', 'it holds no JPEG pictures') : 'no painting of a size for the screen was found'));
    }
    try { if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir); }
    catch (e) { return done(e); }
    freeFn(cacheDir, function (free) {
      if (free === null || free < MAX_FETCH + 20 * 1024 * 1024) {
        return done(new Error(msg('srv.art.space', 'The TV does not have enough free space for the picture.')));
      }
      var file = cacheFile(pick.key), part = file + '.part';
      fetchTo(pick, part, function (err2) {
        if (err2 || !readJpegFile(part)) {
          util.unlinkQuiet(part);
          return done(err2 || new Error('the picture was not a JPEG the TV can show'));
        }
        try { fs.renameSync(part, file); }
        catch (e) { util.unlinkQuiet(part); return done(e); }
        // A source dropped while this one came.
        if (sources().indexOf(pick.collection) === -1) { util.unlinkQuiet(file); return done(); }
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

function nextCollection() {
  if (!queue.length) return null;
  var item = queue.shift();
  recent.push(item.key);
  if (recent.length > RECENT) recent = recent.slice(-RECENT);
  saveQueue();
  return { id: 'c-' + item.key, info: item.info, key: item.key };
}

/*
 * A new picture shown: after any gone back past, which are dropped, and with
 * the oldest let go past HISTORY, its file with it.
 */
function remember(pick) {
  history = history.slice(0, pos + 1);
  history.push({ id: pick.id, info: pick.info, key: pick.key || null });
  while (history.length > HISTORY) {
    var old = history.shift();
    if (old.key && !inQueueOnly(old.key)) util.unlinkQuiet(cacheFile(old.key));
  }
  pos = history.length - 1;
}

function inQueueOnly(key) {
  for (var i = 0; i < queue.length; i++) if (queue[i].key === key) return true;
  return false;
}

// A picture of the history still there to show: an upload not removed since.
function stillThere(item) {
  return !!image(item.id);
}

/**
 * The next picture for the screen saver, with the settings it draws by:
 * { ok, id, info, seconds, fit, caption }, or { ok: false, empty } with
 * nothing to show, or { ok: false, waiting } while the first is fetched.
 * dir 'prev' goes back one, where there is one; after going back, 'next'
 * comes forward through those shown before a new one is picked.
 * @param {function(Object): void} cb
 * @param {string=} dir
 */
function next(cb, dir) {
  var base = { seconds: settings.seconds, fit: settings.fit, caption: settings.caption, seq: command.seq };
  if (dir === 'prev' || (pos < history.length - 1 && pos >= 0)) {
    var step = dir === 'prev' ? -1 : 1;
    var at = pos + step;
    while (at >= 0 && at < history.length && !stillThere(history[at])) at += step;
    if (at >= 0 && at < history.length) {
      pos = at;
      return cb(merge({ ok: true, id: history[at].id, info: history[at].info }, base));
    }
    // Nothing further back: the one on screen again.
    if (dir === 'prev' && pos >= 0 && history[pos] && stillThere(history[pos])) {
      return cb(merge({ ok: true, id: history[pos].id, info: history[pos].info }, base));
    }
  }
  var own = settings.mine && pictures().length > 0;
  var online = sources().length > 0;
  function answer(pick) {
    fill();
    if (pick) remember(pick);
    if (!pick) {
      if (online) return cb(merge({ ok: false, waiting: true, error: lastError || undefined }, base));
      return cb(merge({ ok: false, empty: true, message: msg('srv.art.empty2', 'Add pictures or pick a collection for the picture frame on the Screensaver tab.') }, base));
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

/*
 * Next or Previous, from the dashboard or the remote: the views on screen
 * take it up within a couple of seconds. cb(status) where given.
 */
function go(dir, cb) {
  if (dir !== 'next' && dir !== 'prev') return cb && cb({ ok: false, error: 'dir must be next or prev' });
  command = { seq: command.seq + 1, dir: dir };
  if (cb) cb(status());
}

/*
 * A view asking whether there is a command: 'saver' or 'nosignal'. The No
 * Signal screen showing has the remote's left and right watched.
 */
function poll(view) {
  if (view === 'saver' || view === 'nosignal') viewedAt[view] = Date.now();
  if (view === 'nosignal') watchArrows();
  return { ok: true, seq: command.seq, dir: command.dir };
}

function viewing() {
  var now = Date.now();
  return Object.keys(viewedAt).some(function (v) { return now - viewedAt[v] < VIEW_MS; });
}

function watchArrows() {
  if (!watching) { watching = true; watchKeysFn(true); }
  if (watchTimer) return;
  watchTimer = setInterval(function () {
    if (Date.now() - (viewedAt.nosignal || 0) < VIEW_MS) return;
    clearInterval(watchTimer);
    watchTimer = null;
    watching = false;
    watchKeysFn(false);
  }, 2000);
  if (watchTimer.unref) watchTimer.unref();
}

// A remote key: left and right step the pictures while the No Signal screen shows.
function keyPressed(code) {
  if (!watching || Date.now() - (viewedAt.nosignal || 0) >= VIEW_MS) return;
  if (code === KEY_LEFT) go('prev');
  else if (code === KEY_RIGHT) go('next');
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
  go: go,
  poll: poll,
  keyPressed: keyPressed,
  fill: fill,
  clevelandPick: clevelandPick,
  rijksPick: rijksPick,
  commonsPick: commonsPick,
  readEsaArchive: readEsaArchive,
  readEsaCredit: readEsaCredit,
  readEsaList: readEsaList,
  readEsaSize: readEsaSize,
  findServers: findServers,
  browseFolder: browseFolder,
  addFolder: addFolder,
  removeFolder: removeFolder,
  COLLECTIONS: COLLECTIONS,
  MAX_PICTURES: MAX_PICTURES
};
