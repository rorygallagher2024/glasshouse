/*
 * lib/remotekeys.js - what the remote's keys do: a key opens an app or an
 * input, does nothing, or stays as LG has it
 *
 * The compositor (surface-manager) turns remote keys into actions through a
 * chain of JavaScript filters named by the configd key
 * com.webos.surfacemanager.keyFilters: an ordered list of { file, handler }
 * pairs, with LG's own in /usr/lib/qt5/qml/KeyFilters/. Each handler is called
 * with the key, whether it is pressed, and whether it is auto-repeating, and
 * returns KeyPolicy.NextPolicy to let the next filter see the key, Accepted to
 * consume it, or NotAccepted to pass it to the app in front. The Netflix and
 * Prime Video buttons, Guide, Input, Live TV and the rest are those filters'
 * cases, so this is where a key is changed, in JavaScript, with nothing
 * injected into any process.
 *
 * Changing the chain makes the compositor destroy every loaded filter and
 * build them again, LG's included, and as LG's set themselves up again the
 * quick settings open: on a TV in Game mode, the Game Dashboard appears on
 * screen (a C2, webOS 9.2.2). So the chain is written only to put this
 * filter in or take it out. Which key does what is the configd value
 * glasshouse.remoteKeys, { keys: { name: id } }, which the filter subscribes
 * to: a change there applies at once, with nothing reloaded. configd keeps
 * both values across reboots, so the keys work from boot, before the server
 * starts. configd cannot delete a value, so after restore-keys an empty
 * glasshouse.remoteKeys stays, read by nothing.
 *
 * The keys set here are kept in /var/lib/tvweb/remotekeys.json and copied to
 * configd. The filter, the same file whatever is set, is put first in the chain
 * when a key is first set and stays there while Glasshouse is installed: a key
 * not set falls through to LG's filters untouched, so with every key as LG has
 * it the TV behaves as LG made it. A key that is set never reaches LG's
 * handler: pressed, it opens what was chosen, or nothing; its release is
 * consumed too, as some of LG's handlers act on the release. `node
 * remotekeys.js --restore` (tvwebctl restore-keys) takes the filter out of the
 * chain and deletes it.
 *
 * A key is offered only where this TV's own filter files name it, since LG's
 * key names differ by model and region (a C5 has a Disney+ button, a CX does
 * not). Home, Back, volume, mute, channel and power are not offered: the first
 * two are what the dashboard's own controls depend on, and the rest the
 * microcontroller handles before any filter sees them.
 *
 * Home is set only by Glasshouse Home (lib/home.js), to open its own app:
 * webOS 9 opens LG's Home on the Home key whatever general.defaultApps says,
 * so without this LG's Home shows for a moment first. It is kept beside the
 * keys, as `home`, and passes the key to LG's filters while it is empty.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;

var CONFIG_KEY = 'com.webos.surfacemanager.keyFilters';
// What each key does, read by the filter; see the header.
var MAP_KEY = 'glasshouse.remoteKeys';
var LG_FILTERS_DIR = '/usr/lib/qt5/qml/KeyFilters';
var HANDLER = 'handleGlasshouseKeys';
var LIVE_TV = 'com.webos.app.livetv';
var APP_PREFIX = 'com.webos.app.';

/*
 * The keys that can be changed, in the order shown. Each is a symbol the
 * compositor's filters match on; the title is what the remote prints. The
 * Amazon button is Alexa on some remotes, and the Prime Video button on most.
 */
/*
 * regions: the countries (smartServiceCountryCode2) whose remotes have the
 * key. LG ships one filter set to many regions, so a UK C2 names Hulu and Sling
 * TV too; the dashboard keeps a key from elsewhere out of the way.
 */
var KEYS = [
  { key: 'netflix', symbol: 'WebOS.Key_webOS_Netflix', title: 'Netflix' },
  { key: 'amazon', symbol: 'WebOS.Key_webOS_Amazon', title: 'Prime Video' },
  { key: 'disneyplus', symbol: 'WebOS.Key_webOS_Disneyplus', title: 'Disney+' },
  { key: 'lgchannels', symbol: 'WebOS.Key_webOS_LGChannels', title: 'LG Channels' },
  { key: 'rakutentv', symbol: 'WebOS.Key_webOS_RakutenTV', title: 'Rakuten TV' },
  { key: 'hulu', symbol: 'WebOS.Key_webOS_Hulu', title: 'Hulu', regions: ['us'] },
  { key: 'iplayer', symbol: 'WebOS.Key_webOS_IPlayer', title: 'BBC iPlayer', regions: ['gb'] },
  { key: 'freeviewplay', symbol: 'WebOS.Key_webOS_FreeviewPlay', title: 'Freeview Play', regions: ['gb'] },
  { key: 'slingtv', symbol: 'WebOS.Key_webOS_SlingTV', title: 'Sling TV', regions: ['us'] },
  // The voice assistants' own buttons on recent Magic Remotes: LG's filters
  // launch Alexa or the Google Assistant on a press, as for a streaming
  // button. The microphone button (Key_webOS_Voice) is not offered: it
  // drives voice control itself.
  { key: 'alexa', symbol: 'WebOS.Key_webOS_ALEXA', title: 'Alexa' },
  { key: 'googleassistant', symbol: 'WebOS.Key_webOS_GoogleVoice', title: 'Google Assistant' },
  { key: 'apps', symbol: 'WebOS.Key_webOS_Apps', title: 'Apps' },
  { key: 'guide', symbol: 'WebOS.Key_webOS_TVGuide', title: 'Guide' },
  { key: 'input', symbol: 'WebOS.Key_webOS_InputSource', title: 'Input' },
  { key: 'livetv', symbol: 'WebOS.Key_webOS_InputTV', title: 'TV' },
  { key: 'search', symbol: 'Qt.Key_Search', title: 'Search' },
  { key: 'info', symbol: 'WebOS.Key_webOS_Info', title: 'Info' },
  { key: 'help', symbol: 'Qt.Key_Help', title: 'Help' },
  { key: 'red', symbol: 'WebOS.Key_webOS_Red', title: 'Red' },
  { key: 'green', symbol: 'WebOS.Key_webOS_Green', title: 'Green' },
  { key: 'yellow', symbol: 'WebOS.Key_webOS_Yellow', title: 'Yellow' },
  { key: 'blue', symbol: 'WebOS.Key_webOS_Blue', title: 'Blue' }
];

var lunaFn = null;
var inputNames = null;
var stateDir = '/var/lib/tvweb';
var filtersDir = LG_FILTERS_DIR;
var tvKeys = null;      // the symbols this TV's filters name, read once

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  inputNames = opts.inputNames || {};
  if (opts.stateDir) stateDir = opts.stateDir;
  filtersDir = opts.filtersDir || LG_FILTERS_DIR;
  tvKeys = null;
}

// The TV's country as privacy.js learns it, or '' before it has.
function country() {
  try { return fs.readFileSync(path.join(stateDir, 'country'), 'utf8').trim().toLowerCase(); } catch (e) { return ''; }
}

function mapFile() { return path.join(stateDir, 'remotekeys.json'); }
function filterFile() { return path.join(stateDir, 'remotekeys-filter.js'); }

function keyByName(name) {
  for (var i = 0; i < KEYS.length; i++) if (KEYS[i].key === name) return KEYS[i];
  return null;
}

/*
 * The keys this TV's filters name. The compositor's enum may know more, but
 * a key its filters never match on is not one its remotes send.
 */
function keysOnTv() {
  if (tvKeys) return tvKeys;
  var src = '';
  try {
    fs.readdirSync(filtersDir).forEach(function (f) {
      if (/\.js$/.test(f)) src += fs.readFileSync(path.join(filtersDir, f), 'utf8') + '\n';
    });
  } catch (e) {
    return null;
  }
  tvKeys = KEYS.filter(function (k) { return src.indexOf(k.symbol) !== -1; });
  return tvKeys;
}

// The app the Home key opens, set by Glasshouse Home, or ''.
function readHome() {
  try {
    var j = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    return j && typeof j.home === 'string' ? j.home : '';
  } catch (e) {
    return '';
  }
}

// What is set, as { key: id } with '' for a key that does nothing.
function readMap() {
  try {
    var j = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    if (!j || typeof j.keys !== 'object') return {};
    var out = {};
    Object.keys(j.keys).forEach(function (k) {
      if (keyByName(k) && typeof j.keys[k] === 'string') out[k] = j.keys[k];
    });
    return out;
  } catch (e) {
    return {};
  }
}

function writeMap(map, home) {
  if (!Object.keys(map).length && !home) {
    try { fs.unlinkSync(mapFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  var j = { keys: map, updated: new Date().toISOString() };
  if (home) j.home = home;
  fs.writeFileSync(mapFile(), JSON.stringify(j, null, 2) + '\n', 'utf8');
}

/*
 * The filter the compositor loads. The same file whatever is set: it names
 * every key that can be set, and learns which are set, and to what, from
 * configd. Plain ES5, as the compositor's own filters are, using only what
 * they use (lunaCall, applicationManager, KeyPolicy and the key enums).
 */
function filterSource() {
  var lines = [
    '/* Written by Glasshouse: the remote keys set on its Apps tab, read from the',
    ' * configd value ' + MAP_KEY + '. First in ' + CONFIG_KEY + ',',
    ' * so a key set there never reaches LG\'s filters. */',
    'var glasshouseKeyIds = {};',
    '',
    '// Key code by name; a name this firmware lacks is left out.',
    'function glasshouseKeyCodes() {',
    '    var codes = {};'
  ];
  KEYS.forEach(function (k) {
    lines.push('    try { codes[' + JSON.stringify(k.key) + '] = ' + k.symbol + '; } catch (e) {}');
  });
  lines.push(
    '    return codes;',
    '}',
    '',
    'function glasshouseKeysChanged(payload) {',
    '    try {',
    '        var r = typeof payload === "string" ? JSON.parse(payload) : payload;',
    '        var value = (r && r.configs && r.configs[' + JSON.stringify(MAP_KEY) + ']) || {};',
    '        var set = value.keys || {};',
    '        var codes = glasshouseKeyCodes(), ids = {};',
    '        for (var name in set) {',
    '            if (set.hasOwnProperty(name) && codes[name] !== undefined && typeof set[name] === "string") ids[codes[name]] = set[name];',
    '        }',
    '        // Home, only while Glasshouse Home sets it.',
    '        if (typeof value.home === "string" && value.home) ids[Qt.Key_Super_L] = value.home;',
    '        glasshouseKeyIds = ids;',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e + "; keys left as they were");',
    '    }',
    '}',
    '',
    'function init() {',
    '    try {',
    '        lunaCall.subscribe("com.webos.service.config", "/getConfigs",',
    '            JSON.stringify({ "configNames": [' + JSON.stringify(MAP_KEY) + '], "subscribe": true }), glasshouseKeysChanged, true);',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e + "; no keys set");',
    '    }',
    '}',
    '',
    // First in the chain, it sees every key, the arrows and OK included: an
    // error here must hand the key on to LG's filters, never stop the chain.
    'function ' + HANDLER + '(key, pressed, autoRepeat) {',
    '    try {',
    '        if (!glasshouseKeyIds.hasOwnProperty(key)) return KeyPolicy.NextPolicy;',
    '        var id = glasshouseKeyIds[key];',
    '        if (pressed && !autoRepeat && id) {',
    '            console.info("glasshouse keyfilter: key", key, "opens", id);',
    '            applicationManager.launch(id, "{}");',
    '        }',
    '        return KeyPolicy.Accepted;',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e + "; key passed on");',
    '        return KeyPolicy.NextPolicy;',
    '    }',
    '}',
    ''
  );
  return lines.join('\n');
}

function readChain(cb) {
  lunaFn('com.webos.service.config/getConfigs', { configNames: [CONFIG_KEY] }, function (r) {
    var list = r && r.configs && r.configs[CONFIG_KEY];
    cb(Array.isArray(list) ? list : null);
  });
}

// What each key does, for the filter. cb(ok).
function writeKeys(map, cb, home) {
  var configs = {};
  // The whole value is replaced on each write, so leaving home out clears it.
  configs[MAP_KEY] = home ? { keys: map, home: home } : { keys: map };
  lunaFn('com.webos.service.config/setConfigs', { configs: configs }, function (r) {
    cb(!!(r && r.returnValue));
  });
}

function writeChain(list, cb) {
  var configs = {};
  configs[CONFIG_KEY] = list;
  lunaFn('com.webos.service.config/setConfigs', { configs: configs }, function (r) {
    cb(!!(r && r.returnValue));
  });
}

function ours(entry) {
  return !!entry && entry.file === filterFile();
}

function withoutOurs(list) {
  return list.filter(function (e) { return !ours(e); });
}

/*
 * Puts the TV as the map says. The keys go to configd, where the filter reads
 * them at once. The chain is written only when the filter has to go in (the
 * first key set, or after a configd reset) or its file has changed (a
 * Glasshouse update): each chain write reloads every filter, LG's included,
 * which opens the Game Dashboard on a TV in Game mode. With no key set and the
 * filter not in the chain, it is not put in. cb(ok).
 */
function apply(cb) {
  var map = readMap();
  var home = readHome();
  readChain(function (list) {
    if (!list) return cb(false);
    var inChain = list.some(ours);
    // Nothing set and nothing installed: configd is not written, as it can
    // never forget the value again, and a TV that never sets a key keeps none.
    if (!Object.keys(map).length && !home && !inChain) return cb(true);
    var src = filterSource();
    var current = null;
    try { current = fs.readFileSync(filterFile(), 'utf8'); } catch (e) {}
    var changed = current !== src;
    if (changed) {
      try {
        fs.writeFileSync(filterFile(), src, 'utf8');
      } catch (e) {
        console.log('remotekeys: could not write ' + filterFile() + ': ' + e.message);
        return cb(false);
      }
    }
    writeKeys(map, function (ok) {
      if (!ok) return cb(false);
      var rest = withoutOurs(list);
      var full = [{ file: filterFile(), handler: HANDLER }].concat(rest);
      var done = function (ok2) {
        if (ok2) console.log('remotekeys: filter first in the chain');
        cb(ok2);
      };
      if (!inChain) return writeChain(full, done);
      if (!changed) return cb(true);
      // configd tells the compositor nothing when the same list is written
      // again, so a changed file takes the entry out and back in (a CX kept
      // running the old file through two rewrites of it).
      writeChain(rest, function (ok2) {
        if (!ok2) return cb(false);
        writeChain(full, done);
      });
    }, home);
  });
}

// The inputs a key can open: each HDMI input the TV names, then Live TV.
function inputChoices() {
  var out = Object.keys(inputNames || {}).filter(function (k) { return /^hdmi[1-4]$/.test(k); }).sort()
    .map(function (k) { return { id: APP_PREFIX + k, title: inputNames[k] || k.toUpperCase(), kind: 'input' }; });
  out.push({ id: LIVE_TV, title: msg('srv.remoteKeys.liveTv', 'Live TV'), kind: 'input' });
  return out;
}

// The apps a key can open: those on the Home screen, by title.
function appChoices(apps) {
  var seen = {};
  return (apps || []).filter(function (a) {
    if (!a || !a.id || seen[a.id] || a.visible === false) return false;
    if (a.id === LIVE_TV || /^com\.webos\.app\.(hdmi|container)/.test(a.id)) return false;
    seen[a.id] = true;
    return true;
  }).map(function (a) { return { id: a.id, title: a.title || a.id, kind: 'app' }; })
    .sort(function (x, y) { return x.title.toLowerCase() < y.title.toLowerCase() ? -1 : 1; });
}

function listApps(cb) {
  lunaFn('com.webos.applicationManager/listApps', {}, function (r) {
    cb((r && Array.isArray(r.apps) && r.apps.length) ? r.apps : null);
  });
}

/*
 * The keys this TV has and what each does. cb({ ok, supported, keys, choices,
 * inChain }). A key's action is 'lg', 'nothing' or 'open' with the id and its
 * title; inChain says whether the compositor has the filter right now.
 */
function getRemoteKeys(cb) {
  if (!lunaFn) return cb({ ok: true, supported: false });
  var keys = keysOnTv();
  if (!keys || !keys.length) return cb({ ok: true, supported: false });
  readChain(function (list) {
    if (!list) return cb({ ok: true, supported: false });
    listApps(function (apps) {
      var map = readMap();
      var titles = {};
      (apps || []).forEach(function (a) { if (a && a.id) titles[a.id] = a.title || a.id; });
      var inputs = inputChoices();
      var cc = country();
      inputs.forEach(function (c) { titles[c.id] = c.title; });
      var out = keys.map(function (k) {
        var set = Object.prototype.hasOwnProperty.call(map, k.key);
        var id = set ? map[k.key] : null;
        return {
          key: k.key,
          title: k.title,
          action: !set ? 'lg' : (id ? 'open' : 'nothing'),
          id: id || '',
          opens: id ? (titles[id] || id) : '',
          elsewhere: !!(cc && k.regions && k.regions.indexOf(cc) === -1)
        };
      });
      cb({
        ok: true, supported: true, keys: out,
        choices: inputs.concat(appChoices(apps)),
        inChain: list.some(ours)
      });
    });
  });
}

/*
 * Sets a key: action 'lg' puts it back as LG has it, 'nothing' makes it do
 * nothing, 'open' opens id, an input or an app on the Home screen. It takes
 * effect at once, through the filter's configd subscription. cb({ ok, error }).
 */
function setRemoteKey(key, action, id, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  var def = keyByName(String(key || ''));
  var onTv = keysOnTv();
  if (!def || !onTv || onTv.indexOf(def) === -1) {
    return cb({ ok: false, error: msg('srv.remoteKeys.badKey', 'This TV does not have that key') });
  }
  id = String(id || '').trim();
  var map = readMap();
  if (action === 'lg') {
    delete map[def.key];
    return save(map, cb);
  }
  if (action === 'nothing') {
    map[def.key] = '';
    return save(map, cb);
  }
  if (action !== 'open' || !id) return cb({ ok: false, error: 'lg, nothing or open expected' });
  listApps(function (apps) {
    if (!apps) return cb({ ok: false, error: msg('srv.remoteKeys.noApps', 'Could not read the TV\'s apps. Try again in a moment.') });
    var allowed = inputChoices().concat(appChoices(apps)).some(function (c) { return c.id === id; });
    if (!allowed) return cb({ ok: false, error: msg('srv.remoteKeys.unknownApp', 'That app is not on this TV') });
    map[def.key] = id;
    save(map, cb);
  });
}

function save(map, cb, home) {
  try {
    writeMap(map, home === undefined ? readHome() : home);
  } catch (e) {
    return cb({ ok: false, error: msg('srv.remoteKeys.saveFailed', 'Could not save the change: {error}', { error: e.message }) });
  }
  apply(function (ok) {
    if (!ok) return cb({ ok: false, error: msg('srv.remoteKeys.chainFailed', 'The TV did not take the change') });
    cb({ ok: true });
  });
}

/*
 * The app the Home key opens, for Glasshouse Home, or '' to give Home back to
 * LG's filters. cb({ ok, error }).
 */
function setHome(id, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  save(readMap(), cb, String(id || ''));
}

/*
 * At the server's start: puts back what a configd reset or a missing file has
 * lost, and moves an older version of the filter to this one. Where all is in
 * place nothing is written to the chain, as a write would reload the
 * compositor's filters for nothing. cb(ok).
 */
function ensure(cb) {
  cb = cb || function () {};
  if (!lunaFn) return cb(false);
  if (!keysOnTv()) return cb(false);
  apply(cb);
}

// Everything as LG has it: the map deleted, the keys emptied in configd (it
// cannot delete the value), and the filter out of the chain and deleted.
function restore(cb) {
  // A TV that never used the filter has nothing to restore, even without configd.
  if (!fs.existsSync(mapFile()) && !fs.existsSync(filterFile())) return cb(true);
  if (!lunaFn) return cb(false);
  try { fs.unlinkSync(mapFile()); } catch (e) { if (e.code !== 'ENOENT') return cb(false); }
  writeKeys({}, function (okKeys) {
    readChain(function (list) {
      if (!list) return cb(false);
      var rest = withoutOurs(list);
      var finish = function (ok) {
        if (ok) { try { fs.unlinkSync(filterFile()); } catch (e) {} }
        cb(ok && okKeys);
      };
      if (rest.length === list.length) return finish(true);
      writeChain(rest, function (ok) {
        if (ok) console.log('remotekeys: filter taken out of the chain');
        finish(ok);
      });
    });
  });
}

module.exports = {
  init: init,
  getRemoteKeys: getRemoteKeys,
  setRemoteKey: setRemoteKey,
  setHome: setHome,
  ensure: ensure,
  restore: restore,
  filterSource: filterSource,
  KEYS: KEYS,
  CONFIG_KEY: CONFIG_KEY,
  MAP_KEY: MAP_KEY,
  HANDLER: HANDLER
};

// tvwebctl restore-keys: no server running, so luna is found here.
if (require.main === module && process.argv[2] === '--restore') {
  var lunaLib = require('./luna');
  init({ luna: lunaLib.call || lunaLib, stateDir: path.join(__dirname, '..') });
  restore(function (ok) {
    console.log(ok ? 'remotekeys: keys as LG has them' : 'remotekeys: could not reach configd; the map file is deleted');
    process.exit(ok ? 0 : 1);
  });
}
