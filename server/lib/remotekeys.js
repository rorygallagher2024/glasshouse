/*
 * lib/remotekeys.js - what the remote's keys do: a key opens an app or an
 * input, sends a media key, does nothing, or stays as LG has it
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
 * Home: earlier builds of Glasshouse Home pointed it at their own app, kept
 * beside the keys as `home`; lib/home.js clears it. Glasshouse Home now runs
 * under LG's Home's id, mounted by the boot hook about 25 s into a cold start,
 * so while it is on `starting` holds a message instead: until the app manager
 * reports LG's Home as Glasshouse Home's web app, the filter keeps the Home key
 * from LG's filters and shows the message as a toast, and once it does it
 * opens Home. The filter loads from configd before any of Glasshouse's own
 * code runs, so this is the earliest Glasshouse can answer a key.
 *
 * webOS 11 (a C5 on 11.2.0) has a Weston compositor whose key filters are
 * native libraries, named by com.webos.surfacemanager.keyFiltersCpp: there is
 * no KeyFilters directory and no JavaScript to put first. LG's launch library
 * reads what a key does at each press from two of LG's own values, so a change
 * there applies at once: the streaming buttons and Apps from the settings
 * service's other.mapping_info, a list of { name: { app_id, launch_param,
 * isActive } } that LG's server sends, Guide and Home Hub from the configd
 * values com.webos.keyaction.*, and the ? button from LG's custom button
 * settings. What each held before Glasshouse changed it is
 * kept in remotekeys-lg.json and put back for As LG has it, beside what was
 * last written: a value found different from that is LG's own new one, as its
 * server resends mapping_info, and becomes the one to put back. With isActive
 * false a streaming button opens nothing and LG shows a toast. On Live TV and
 * the HDMI inputs LG's filter hands Guide to the input, which opens its own
 * guide whatever the value says. LG writes its list back at each switch off
 * and on, so it is followed and set again; see watchLg. Home is not offered
 * there.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var msg = require('./say').msg;
var allocBuffer = require('./util').allocBuffer;

var CONFIG_KEY = 'com.webos.surfacemanager.keyFilters';
// What each key does, read by the filter; see the header.
var MAP_KEY = 'glasshouse.remoteKeys';
var LG_FILTERS_DIR = '/usr/lib/qt5/qml/KeyFilters';
var HANDLER = 'handleGlasshouseKeys';
/*
 * How long after the filter loads Home is held for Glasshouse Home. A cold
 * start on a G3 (webOS 9.2.2) has it in place by about 28 s. After this Home
 * goes on to LG's filters, which open whatever has LG's Home's id, so a TV
 * where Glasshouse no longer runs still reaches a Home. Counted with the
 * compositor's genericTimer: the clock jumps from 2023 when the TV sets it.
 */
var HOLD_LIMIT_MS = 90000;
var LIVE_TV = 'com.webos.app.livetv';
// LG's input switcher, as the remote's Input and ? buttons open it (a C5,
// webOS 11.2.0): a choice of its own where the TV has it. Launched with no
// parameters it shows the same list.
var INPUT_SWITCHER = 'com.webos.app.quickinputpicker';
var APP_PREFIX = 'com.webos.app.';
/*
 * A key set to a media control holds MEDIA_PREFIX and the control's name in
 * place of an app id: no app id has a colon. The filter sends the control's
 * Linux key code through the network input service, whose keys go through the
 * filter chain like the remote's own (TV-RESEARCH.md), so the app in front
 * gets it as a play or pause key; no media key is one this filter takes. The
 * codes are controls.js's RCU_KEY_CODES, measured on a B8. Volume up and down
 * are the codes controls.js sends for one step, which a receiver on HDMI ARC
 * follows too; they repeat while the key is held, as the remote's own do.
 * Mute is KEY_MUTE, a toggle like the remote's. Each worked on a C3 (webOS
 * 10.2.2). A play/pause toggle, asking acb what was playing first, did
 * nothing there, so none is offered. webOS 11's native filters launch apps
 * only, so they are not offered there.
 */
var MEDIA_PREFIX = 'media:';
var MEDIA_CODES = {
  play: 207, pause: 119, stop: 128, rewind: 168, fastForward: 208,
  volumeUp: 115, volumeDown: 114, mute: 113
};
var MEDIA_ACTIONS = ['play', 'pause', 'stop', 'rewind', 'fastForward', 'volumeUp', 'volumeDown', 'mute'];
var MEDIA_REPEATS = { volumeUp: true, volumeDown: true };

// webOS 11's native key filters; see the header.
var NATIVE_FILTERS_KEY = 'com.webos.surfacemanager.keyFiltersCpp';
var KEY_ACTION_PREFIX = 'com.webos.keyaction.';
// Keys whose action is a configd value there, by the value's name.
var NATIVE_ACTIONS = { guide: 'tvGuide', homehub: 'inputHub' };
// Keys whose action is one of the settings service's, by the setting's name.
var NATIVE_SETTINGS = { multikey: 'customShortPress', multikeyhold: 'customLongPress' };
/*
 * Keys LG's own service answers, by that service's id in lib/services.js. The
 * MR25's AI button goes from lginput2 straight to voiceconductor, which reads
 * no value for it (a C5, webOS 11.2.0). Set here, the service is switched off,
 * so nothing of LG's opens, and the press is answered from the system log,
 * where lginput2 logs every press as NL_BUTTON_CLICK. With the service
 * running, its voice screen and terms opened over the app; with it off, the
 * app opened 0.7 s after the press and nothing else did.
 */
var NATIVE_SERVICE_KEYS = { ai: 'voiceconductor' };
/*
 * Keys whose press LG hands to an app's own service, by the app it opens. The
 * Alexa button goes to Amazon's adapter, which the hub starts on demand and
 * which opens amazon.alexa.view and its terms, whether or not voiceconductor
 * runs (a C5, webOS 11.2.0). With the view blocked through blockSystemApp it
 * no longer opens; the adapter's "Amazon Alexa is loading" toast still shows
 * for 5 s, and closeToast does not shorten it. Answered from the log too.
 */
var NATIVE_BLOCK_KEYS = { alexa: 'amazon.alexa.view' };
var MESSAGES_LOG = '/var/log/messages';
var OTHER_CATEGORY = 'other';
var MAPPING_KEY = 'mapping_info';

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
  // The Movies button on 2020 remotes (the MR20's white MOVIES key). LG's
  // filters open whichever film store the region has from it, a hotkey id
  // from the settings service, under the key it called USP on 2019 sets.
  { key: 'movies', symbol: 'WebOS.Key_webOS_USP', title: 'Movies' },
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
  // Only webOS 11's native filters let these be changed (NATIVE_ACTIONS,
  // NATIVE_SETTINGS); the JavaScript filter leaves them out, so its file is
  // unchanged. Home Hub is the MR25's house-in-a-circle button (IR 1031); the
  // ? button (IR 1132) is LG's custom button, with an action of its own when held.
  { key: 'homehub', title: 'Home Hub', nativeOnly: true },
  // The MR25's AI button reads no value: see NATIVE_SERVICE_KEYS.
  { key: 'ai', title: 'AI', nativeOnly: true, turnsOffVoice: true },
  { key: 'multikey', title: '? button', nativeOnly: true, noNothing: true },
  { key: 'multikeyhold', title: '? button, held', nativeOnly: true, noNothing: true },
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
var nativeFilters = null; // whether configd names native filters, once answered
var switcherFound = null; // whether the TV has INPUT_SWITCHER, once answered
var SubscriptionCtor = null; // luna.Subscription, to follow LG's settings
/** @type {typeof import('./services') | null} */
var servicesModule = null;  // to switch LG's voice assistant off and on
var messagesPath = MESSAGES_LOG;
var reapplyDelayMs = 1000;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  inputNames = opts.inputNames || {};
  if (opts.stateDir) stateDir = opts.stateDir;
  filtersDir = opts.filtersDir || LG_FILTERS_DIR;
  tvKeys = null;
  nativeFilters = null;
  switcherFound = null;
  watchLg(false);
  reapplied = [];
  SubscriptionCtor = opts.subscription || null;
  followPresses({});
  if (toastsTimer) { clearTimeout(toastsTimer); toastsTimer = null; }
  servicesModule = opts.services || null;
  messagesPath = opts.messagesPath || MESSAGES_LOG;
  if (typeof opts.reapplyDelayMs === 'number') reapplyDelayMs = opts.reapplyDelayMs;
  muteToastsMs = opts.muteToastsMs || 0;
  powerTimers.forEach(function (t) { clearTimeout(t); });
  powerTimers = [];
  powerRechecksMs = opts.powerRechecksMs || POWER_RECHECKS_MS;
  if (lunaFn && fs.existsSync(toastsMarker())) unmuteToasts();
}

// The TV's country as privacy.js learns it, or '' before it has.
function country() {
  try { return fs.readFileSync(path.join(stateDir, 'country'), 'utf8').trim().toLowerCase(); } catch (e) { return ''; }
}

function mapFile() { return path.join(stateDir, 'remotekeys.json'); }
function filterFile() { return path.join(stateDir, 'remotekeys-filter.js'); }
function lgFile() { return path.join(stateDir, 'remotekeys-lg.json'); }

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
  tvKeys = KEYS.filter(function (k) { return !k.nativeOnly && src.indexOf(k.symbol) !== -1; });
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

// The toast for Home while Glasshouse Home is not yet in place, or ''.
function readStarting() {
  try {
    var j = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    return j && typeof j.starting === 'string' ? j.starting : '';
  } catch (e) {
    return '';
  }
}

function writeMap(map, home, starting) {
  if (!Object.keys(map).length && !home && !starting) {
    try { fs.unlinkSync(mapFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  var j = { keys: map, updated: new Date().toISOString() };
  if (home) j.home = home;
  if (starting) j.starting = starting;
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
    '// Glasshouse Home: the toast for Home until it is in place, and whether it is.',
    'var glasshouseStarting = "";',
    'var glasshouseHomeReady = false;',
    'var glasshouseHoldingHome = false;',
    'var glasshouseHoldOver = false;',
    'var glasshouseMediaCodes = ' + JSON.stringify(MEDIA_CODES) + ';',
    'var glasshouseMediaRepeats = ' + JSON.stringify(MEDIA_REPEATS) + ';',
    '',
    '// Key code by name; a name this firmware lacks is left out.',
    'function glasshouseKeyCodes() {',
    '    var codes = {};'
  ];
  KEYS.forEach(function (k) {
    if (k.nativeOnly) return;
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
    '        glasshouseStarting = typeof value.starting === "string" ? value.starting : "";',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e + "; keys left as they were");',
    '    }',
    '}',
    '',
    'function glasshouseSendKey(code) {',
    '    lunaCall.send("com.webos.service.networkinput", "/test/sendKeyCode", JSON.stringify({ "keyCode": code }), function () {});',
    '}',
    '',
    '// Sends the media key a key is set to, by its name after ' + JSON.stringify(MEDIA_PREFIX) + '.',
    'function glasshouseMedia(name) {',
    '    if (glasshouseMediaCodes.hasOwnProperty(name)) glasshouseSendKey(glasshouseMediaCodes[name]);',
    '}',
    '',
    '// Opens Home once the app manager runs Glasshouse Home under its id, and',
    '// says it is starting until then. The key has been kept from LG\'s filters.',
    'function glasshouseHomePressed() {',
    '    lunaCall.send("com.webos.applicationManager", "/getAppInfo", JSON.stringify({ "id": "com.webos.app.home" }), function (payload) {',
    '        try {',
    '            var r = typeof payload === "string" ? JSON.parse(payload) : payload;',
    '            if (r && r.appInfo && r.appInfo.type === "web") {',
    '                glasshouseHomeReady = true;',
    '                applicationManager.launch("com.webos.app.home", JSON.stringify({ "activateType": "home", "launchType": "homeKey" }));',
    '                return;',
    '            }',
    '            lunaCall.send("com.webos.notification", "/createToast",',
    '                JSON.stringify({ "sourceId": lunaCall.appId, "message": glasshouseStarting }), function () {});',
    '        } catch (e) {',
    '            console.warn("glasshouse keyfilter: " + e);',
    '        }',
    '    });',
    '}',
    '',
    'function init() {',
    '    try {',
    '        genericTimer.set(' + HOLD_LIMIT_MS + ', function () { glasshouseHoldOver = true; });',
    '    } catch (e) {',
    '        glasshouseHoldOver = true;',
    '        console.warn("glasshouse keyfilter: " + e + "; Home not held");',
    '    }',
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
    '        // LG\'s filters open Home on the release, so a release whose press was kept',
    '        // here is kept too, even where Home has opened in between.',
    '        if (key === Qt.Key_Super_L && !pressed && glasshouseHoldingHome) {',
    '            glasshouseHoldingHome = false;',
    '            return KeyPolicy.Accepted;',
    '        }',
    '        if (key === Qt.Key_Super_L && pressed && glasshouseStarting && !glasshouseHomeReady && !glasshouseHoldOver) {',
    '            glasshouseHoldingHome = true;',
    '            if (!autoRepeat) glasshouseHomePressed();',
    '            return KeyPolicy.Accepted;',
    '        }',
    '        if (!glasshouseKeyIds.hasOwnProperty(key)) return KeyPolicy.NextPolicy;',
    '        var id = glasshouseKeyIds[key];',
    '        if (id.indexOf(' + JSON.stringify(MEDIA_PREFIX) + ') === 0) {',
    '            var media = id.substring(' + MEDIA_PREFIX.length + ');',
    '            if (pressed && (!autoRepeat || glasshouseMediaRepeats.hasOwnProperty(media))) {',
    '                if (!autoRepeat) console.info("glasshouse keyfilter: key", key, "sends", id);',
    '                glasshouseMedia(media);',
    '            }',
    '        } else if (pressed && !autoRepeat && id) {',
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
function writeKeys(map, cb, home, starting) {
  var configs = {};
  // The whole value is replaced on each write, so leaving one out clears it.
  var value = { keys: map };
  if (home) value.home = home;
  if (starting) value.starting = starting;
  configs[MAP_KEY] = value;
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
  var starting = readStarting();
  readChain(function (list) {
    if (!list) return cb(false);
    var inChain = list.some(ours);
    // Nothing set and nothing installed: configd is not written, as it can
    // never forget the value again, and a TV that never sets a key keeps none.
    if (!Object.keys(map).length && !home && !starting && !inChain) return cb(true);
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
    }, home, starting);
  });
}

// Whether configd names native key filters (webOS 11). cb(found).
function hasNativeFilters(cb) {
  if (nativeFilters !== null) return cb(nativeFilters);
  lunaFn('com.webos.service.config/getConfigs', { configNames: [NATIVE_FILTERS_KEY] }, function (r) {
    var list = r && r.configs && r.configs[NATIVE_FILTERS_KEY];
    var found = Array.isArray(list) && list.length > 0;
    // A failed call is asked again; an answer without the value is kept.
    if (r && r.returnValue) nativeFilters = found;
    cb(found);
  });
}

// LG's values as they were before Glasshouse changed them, and what it last
// wrote over each, by kind: mapping (the streaming buttons), actions (configd
// key actions) and settings (the ? button), each beside its ...Written.
// services holds each of LG's services Glasshouse has switched off, and
// blocks each app it has blocked, as true.
var LG_KINDS = ['mapping', 'actions', 'settings', 'services', 'blocks'];

function readLg() {
  var out = {};
  LG_KINDS.forEach(function (k) { out[k] = {}; out[k + 'Written'] = {}; });
  try {
    var j = JSON.parse(fs.readFileSync(lgFile(), 'utf8'));
    Object.keys(out).forEach(function (k) { if (j && j[k] && typeof j[k] === 'object') out[k] = j[k]; });
  } catch (e) {}
  return out;
}

// Whether any of LG's values of these kinds (all by default) is changed.
function lgHolds(lg, kinds) {
  return (kinds || LG_KINDS).some(function (k) { return Object.keys(lg[k]).length > 0; });
}

function writeLg(lg) {
  if (!lgHolds(lg)) {
    try { fs.unlinkSync(lgFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  fs.writeFileSync(lgFile(), JSON.stringify(lg, null, 2) + '\n', 'utf8');
}

// JSON with keys sorted, so two values compare whatever order they came in.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
}

function sameValue(a, b) { return canonical(a) === canonical(b); }

function copyValue(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// The streaming buttons' list, or null.
function readMapping(cb) {
  lunaFn('com.webos.settingsservice/getSystemSettings', { category: OTHER_CATEGORY, keys: [MAPPING_KEY] }, function (r) {
    var list = r && r.settings && r.settings[MAPPING_KEY];
    cb(Array.isArray(list) ? list : null);
  });
}

/*
 * The ? button's settings by name, or null. Asked apart from the list: a
 * firmware without them must not cost the streaming buttons.
 */
function readSettings(cb) {
  var names = Object.keys(NATIVE_SETTINGS).map(function (k) { return NATIVE_SETTINGS[k]; });
  lunaFn('com.webos.settingsservice/getSystemSettings', { category: OTHER_CATEGORY, keys: names }, function (r) {
    if (!r || !r.settings) return cb(null);
    var out = {};
    names.forEach(function (n) {
      var v = r.settings[n];
      if (v && typeof v === 'object' && typeof v.id === 'string') out[n] = v;
    });
    cb(out);
  });
}

function writeSettings(settings, cb) {
  lunaFn('com.webos.settingsservice/setSystemSettings', { category: OTHER_CATEGORY, settings: settings }, function (r) {
    cb(!!(r && r.returnValue));
  });
}

// The configd key actions Glasshouse can change, by name, or null.
function readActions(cb) {
  var names = Object.keys(NATIVE_ACTIONS).map(function (k) { return KEY_ACTION_PREFIX + NATIVE_ACTIONS[k]; });
  lunaFn('com.webos.service.config/getConfigs', { configNames: names }, function (r) {
    if (!r || !r.configs) return cb(null);
    var out = {};
    Object.keys(NATIVE_ACTIONS).forEach(function (k) {
      var v = r.configs[KEY_ACTION_PREFIX + NATIVE_ACTIONS[k]];
      if (v && typeof v === 'object') out[NATIVE_ACTIONS[k]] = v;
    });
    cb(out);
  });
}

// Everything the native keys are read from: cb({ list, actions, settings }).
function readNative(cb) {
  readMapping(function (list) {
    readActions(function (actions) {
      readSettings(function (settings) {
        readBlockable(function (apps) {
          cb({ list: list, actions: actions, settings: settings, apps: apps });
        });
      });
    });
  });
}

// Which of the apps NATIVE_BLOCK_KEYS names the TV has, by id. A blocked app is
// not found, so lg.blocks counts as well where it is read.
function readBlockable(cb) {
  var ids = Object.keys(NATIVE_BLOCK_KEYS).map(function (k) { return NATIVE_BLOCK_KEYS[k]; });
  var out = {};
  (function next(i) {
    if (i === ids.length) return cb(out);
    lunaFn('com.webos.applicationManager/getAppInfo', { id: ids[i] }, function (r) {
      if (r && r.returnValue) out[ids[i]] = true;
      next(i + 1);
    });
  })(0);
}

// The entry for a streaming button in LG's list, or undefined.
function mappingEntry(list, name) {
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i] && Object.prototype.hasOwnProperty.call(list[i], name)) return list[i][name];
  }
  return undefined;
}

/*
 * The keys a webOS 11 TV offers: Guide and Home Hub where configd has their
 * actions, the ? button where the settings service has it, and each streaming
 * button LG's list has switched on, as LG had it.
 */
function nativeKeys(tv, lg) {
  return KEYS.filter(function (k) {
    if (NATIVE_ACTIONS[k.key]) return !!(tv.actions && tv.actions[NATIVE_ACTIONS[k.key]]);
    if (NATIVE_SETTINGS[k.key]) return !!(tv.settings && tv.settings[NATIVE_SETTINGS[k.key]]);
    if (NATIVE_SERVICE_KEYS[k.key]) return !!(servicesModule && servicesModule.available(NATIVE_SERVICE_KEYS[k.key]));
    if (NATIVE_BLOCK_KEYS[k.key]) return !!((tv.apps && tv.apps[NATIVE_BLOCK_KEYS[k.key]]) || lg.blocks[NATIVE_BLOCK_KEYS[k.key]]);
    if (k.nativeOnly) return false;
    var entry = lg.mapping[k.key] || mappingEntry(tv.list, k.key);
    return !!(entry && typeof entry === 'object' && entry.isActive !== false);
  });
}

// What a streaming button's entry becomes, from LG's own, or undefined for LG's.
function mappingWanted(map, key, lgEntry) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  if (!map[key]) {
    var off = copyValue(lgEntry);
    off.isActive = false;
    return off;
  }
  return { launch_param: null, app_id: map[key], isActive: true };
}

function actionWanted(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  return map[key] ? { action: 'launch', id: map[key] } : { action: 'ignore', accept: true };
}

// The ? button has no setting for nothing: LG opens Accessibility for a type
// it does not know. So it opens an app, or is LG's.
function settingWanted(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key) || !map[key]) return undefined;
  return { id: map[key], type: 'app', params: {} };
}

/*
 * One of LG's values as the map wants it. saved and written are lg's records
 * for its kind; wanted(lgValue) is the value wanted, or undefined for LG's
 * own. Returns the value to write, or undefined where it is already right.
 */
function reconcile(name, current, wanted, saved, written) {
  var had = Object.prototype.hasOwnProperty.call(saved, name);
  // Neither as last written nor as wanted: LG has written its own since.
  var lgWrote = had && !sameValue(current, written[name]);
  var lgValue = had && !lgWrote ? saved[name] : current;
  var want = wanted(lgValue);
  if (want === undefined) {
    delete saved[name];
    delete written[name];
    return had && !sameValue(lgValue, current) ? lgValue : undefined;
  }
  if (lgWrote && sameValue(current, want)) return undefined;
  saved[name] = copyValue(lgValue);
  written[name] = copyValue(want);
  return sameValue(want, current) ? undefined : want;
}

/*
 * Puts a webOS 11 TV's keys as the map says, or as LG had them all with
 * mapOverride {}. LG's values are written only where they differ, and the
 * record of them is kept only once every write has gone through. One runs at
 * a time, as each reads LG's values and writes them back whole.
 * cb(ok, wrote).
 */
var applyQueue = [];
function applyNative(cb, mapOverride) {
  applyQueue.push({ cb: cb, map: mapOverride });
  if (applyQueue.length === 1) applyNext();
}

function applyNext() {
  var job = applyQueue[0];
  if (!job) return;
  applyNativeNow(function (ok, wrote) {
    applyQueue.shift();
    applyNext();
    job.cb(ok, !!wrote);
  }, job.map);
}

function applyNativeNow(cb, mapOverride) {
  var map = mapOverride || readMap();
  var lg = readLg();
  if (!Object.keys(map).length && !lgHolds(lg)) {
    watchLg(false);
    followPresses({});
    return cb(true, false);
  }
  readNative(function (tv) {
    if (!tv.list && !tv.actions && !tv.settings) return cb(false, false);
    var settings = {};
    var nextList = copyValue(tv.list);
    var listChanged = false;
    (nextList || []).forEach(function (entry) {
      Object.keys(entry || {}).forEach(function (name) {
        var def = keyByName(name);
        if (!def || def.nativeOnly || NATIVE_ACTIONS[name]) return;
        var v = reconcile(name, entry[name], function (lgEntry) { return mappingWanted(map, name, lgEntry); },
          lg.mapping, lg.mappingWritten);
        if (v !== undefined) { entry[name] = v; listChanged = true; }
      });
    });
    if (listChanged) settings[MAPPING_KEY] = nextList;
    Object.keys(NATIVE_SETTINGS).forEach(function (key) {
      var name = NATIVE_SETTINGS[key];
      if (!tv.settings || !tv.settings[name]) return;
      var v = reconcile(name, tv.settings[name], function () { return settingWanted(map, key); },
        lg.settings, lg.settingsWritten);
      if (v !== undefined) settings[name] = v;
    });
    var configs = {};
    Object.keys(NATIVE_ACTIONS).forEach(function (key) {
      var name = NATIVE_ACTIONS[key];
      if (!tv.actions || !tv.actions[name]) return;
      var v = reconcile(name, tv.actions[name], function () { return actionWanted(map, key); },
        lg.actions, lg.actionsWritten);
      if (v !== undefined) configs[KEY_ACTION_PREFIX + name] = v;
    });
    var wrote = Object.keys(settings).length > 0 || Object.keys(configs).length > 0;
    var finish = function (ok) {
      if (!ok) return cb(false, wrote);
      switchServices(map, lg, function (okServices, switchedServices) {
        switchBlocks(map, lg, function (okBlocks, switchedBlocks) {
          var switched = switchedServices || switchedBlocks;
          try {
            writeLg(lg);
          } catch (e) {
            console.log('remotekeys: could not write ' + lgFile() + ': ' + e.message);
            return cb(false, wrote || switched);
          }
          watchLg(lgHolds(lg, ['mapping', 'settings']));
          followPresses(loggedTargets(map, lg));
          cb(okServices && okBlocks, wrote || switched);
        });
      });
    };
    var writeActions = function () {
      if (!Object.keys(configs).length) return finish(true);
      lunaFn('com.webos.service.config/setConfigs', { configs: configs }, function (r) { finish(!!(r && r.returnValue)); });
    };
    if (!Object.keys(settings).length) return writeActions();
    writeSettings(settings, function (ok) {
      if (!ok) return cb(false, wrote);
      writeActions();
    });
  });
}

/*
 * Switches off each of LG's services a set key needs off, and back on each
 * one Glasshouse switched off that no set key needs now. lg.services records
 * which, so one the owner had off is never switched on. cb(ok, switched).
 */
function switchServices(map, lg, cb) {
  var todo = [];
  Object.keys(NATIVE_SERVICE_KEYS).forEach(function (key) {
    var id = NATIVE_SERVICE_KEYS[key];
    var wanted = Object.prototype.hasOwnProperty.call(map, key);
    if (wanted && !lg.services[id]) todo.push({ id: id, off: true });
    else if (!wanted && lg.services[id]) todo.push({ id: id, off: false });
    else if (wanted && servicesModule && !servicesModule.isDisabled(id)) todo.push({ id: id, off: true });
  });
  if (!todo.length) return cb(true, false);
  if (!servicesModule) return cb(false, false);
  var ok = true;
  (function next(i) {
    if (i === todo.length) return cb(ok, true);
    var job = todo[i];
    servicesModule.switchHidden(job.id, job.off, function (r) {
      if (r && r.ok) {
        if (job.off) lg.services[job.id] = true;
        else delete lg.services[job.id];
        console.log('remotekeys: ' + job.id + ' switched ' + (job.off ? 'off' : 'back on'));
      } else {
        ok = false;
      }
      next(i + 1);
    });
  })(0);
}

/*
 * Blocks each app a set key needs kept from opening, and releases each one
 * Glasshouse blocked that no set key needs now. A block already in place is
 * answered "already blocked", which is as good. cb(ok, switched).
 */
function switchBlocks(map, lg, cb) {
  var todo = [];
  Object.keys(NATIVE_BLOCK_KEYS).forEach(function (key) {
    var id = NATIVE_BLOCK_KEYS[key];
    var wanted = Object.prototype.hasOwnProperty.call(map, key);
    if (wanted) todo.push({ id: id, block: true, was: !!lg.blocks[id] });
    else if (lg.blocks[id]) todo.push({ id: id, block: false, was: true });
  });
  if (!todo.length) return cb(true, false);
  var ok = true, switched = false;
  (function next(i) {
    if (i === todo.length) return cb(ok, switched);
    var job = todo[i];
    // webOS 11's sam requires forceBlockSystemApp; the release takes the id alone.
    var uri = job.block ? 'com.webos.applicationManager/blockSystemApp' : 'com.webos.applicationManager/releaseBlockSystemApp';
    var params = job.block ? { id: job.id, forceBlockSystemApp: false } : { id: job.id };
    // sam answers a second block "already blocked: <id>" (a C5, 11.2.0).
    lunaFn(uri, params, function (r, raw) {
      var done = !!(r && r.returnValue) || /already\s*blocked/i.test(String((r && r.errorText) || raw || ''));
      if (done) {
        if (job.block) lg.blocks[job.id] = true;
        else delete lg.blocks[job.id];
        if (job.block !== job.was) {
          switched = true;
          console.log('remotekeys: ' + job.id + (job.block ? ' blocked' : ' released'));
        }
      } else {
        ok = false;
      }
      next(i + 1);
    });
  })(0);
}

/*
 * Presses answered from the system log, by lginput2's button name: the id the
 * key opens, or '' for nothing. A key is answered there only while what LG
 * does with it is off, and nothing follows the log while none is. The log is
 * read here rather than by a tail child, which the watchdog's restart would
 * leave running: its size is polled, and only what was added is read. A log
 * found smaller, or another file, is read from its start.
 */
var LOGGED_BUTTONS = { ai: 'KEY_VOICE', alexa: 'KEY_ALEXAVOICE' };
var BUTTON_CLICK = /NL_BUTTON_CLICK\b.*"button_type"\s*:\s*"([A-Z0-9_]+)"/;
var PRESS_DEBOUNCE_MS = 500;
var POLL_MS = 200;
// One read at most this much, as the syslog forwarder's: a log that has grown
// a lot is skipped ahead rather than read whole.
var READ_CHUNK = 64 * 1024;
var pressTargets = {};
var following = false;
var logOffset = 0;
var logIno = null;
var reading = false;
var partialLine = '';
var lastPress = {};

/*
 * Amazon's adapter still shows "Amazon Alexa is loading" a second after the
 * press, for 5 s, and closeToast does not shorten it. So toasts are switched
 * off for a few seconds from the press: the notification service then refuses
 * a new one ("Toast is blocked"), rather than showing it later (a C5, 11.2.0).
 * A toast anything else sends in that time is refused too. While they are
 * off a marker file says so, and init() switches them back on from it, so a
 * restart in between does not leave toasts off.
 */
var MUTE_TOASTS_MS = { KEY_ALEXAVOICE: 4000 };
var toastsTimer = null;
var muteToastsMs = 0;      // for tests: the time toasts stay off, in place of the above

function toastsMarker() { return path.join(stateDir, 'remotekeys-toasts-off'); }

function muteToasts(ms) {
  if (!lunaFn) return;
  if (toastsTimer) clearTimeout(toastsTimer);
  else {
    try { fs.writeFileSync(toastsMarker(), '', 'utf8'); } catch (e) {}
    lunaFn('com.webos.notification/disable', {}, function () {});
  }
  toastsTimer = setTimeout(unmuteToasts, ms);
}

function unmuteToasts() {
  toastsTimer = null;
  lunaFn('com.webos.notification/enable', {}, function (r) {
    if (r && r.returnValue) {
      try { fs.unlinkSync(toastsMarker()); } catch (e) {}
    } else {
      console.log('remotekeys: toasts could not be switched back on; trying again');
      toastsTimer = setTimeout(unmuteToasts, 5000);
    }
  });
}

// The buttons to answer, from what is set and what LG's side has off.
function loggedTargets(map, lg) {
  var targets = {};
  Object.keys(LOGGED_BUTTONS).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) return;
    var off = (NATIVE_SERVICE_KEYS[key] && lg.services[NATIVE_SERVICE_KEYS[key]]) ||
      (NATIVE_BLOCK_KEYS[key] && lg.blocks[NATIVE_BLOCK_KEYS[key]]);
    if (off) targets[LOGGED_BUTTONS[key]] = map[key];
  });
  return targets;
}

function followPresses(targets) {
  pressTargets = targets || {};
  var wanted = Object.keys(pressTargets).length > 0;
  if (wanted && !following) {
    following = true;
    // From the end: a press logged before the key was set is not answered.
    try {
      var st = fs.statSync(messagesPath);
      logOffset = st.size;
      logIno = st.ino;
    } catch (e) {
      logOffset = 0;
      logIno = null;
    }
    partialLine = '';
    fs.watchFile(messagesPath, { interval: POLL_MS, persistent: false }, logChanged);
  } else if (!wanted && following) {
    following = false;
    fs.unwatchFile(messagesPath, logChanged);
  }
}

function logChanged(cur) {
  if (!following || reading || !cur) return;
  if ((logIno !== null && cur.ino !== logIno) || cur.size < logOffset) {
    logOffset = 0;
    partialLine = '';
  }
  logIno = cur.ino;
  if (cur.size <= logOffset) return;
  var start = Math.max(logOffset, cur.size - READ_CHUNK);
  var length = cur.size - start;
  // A line cut by the last read goes on only where this one carries on from it.
  var carried = start === logOffset ? partialLine : '';
  reading = true;
  fs.open(messagesPath, 'r', function (err, fd) {
    if (err) { reading = false; return; }
    var buf = allocBuffer(length);
    fs.read(fd, buf, 0, length, start, function (err2, bytes) {
      fs.close(fd, function () {});
      reading = false;
      if (err2 || !bytes) return;
      logOffset = start + bytes;
      var lines = (carried + buf.toString('utf8', 0, bytes)).split('\n');
      partialLine = lines.pop();
      lines.forEach(function (line) {
        var m = BUTTON_CLICK.exec(line);
        if (m) buttonPressed(m[1]);
      });
    });
  });
}

// lginput2 logs a press once; a second within half a second is the same one.
function buttonPressed(button) {
  if (!Object.prototype.hasOwnProperty.call(pressTargets, button)) return;
  var now = Date.now();
  if (now >= (lastPress[button] || 0) && now - (lastPress[button] || 0) < PRESS_DEBOUNCE_MS) return;
  lastPress[button] = now;
  if (MUTE_TOASTS_MS[button]) muteToasts(muteToastsMs || MUTE_TOASTS_MS[button]);
  var id = pressTargets[button];
  if (!id || !lunaFn) return;
  lunaFn('com.webos.applicationManager/launch', { id: id }, function (r) {
    if (!(r && r.returnValue)) console.log('remotekeys: ' + button + ' could not open ' + id);
  });
}

/*
 * LG writes its own streaming buttons' list back as the TV goes into standby
 * (a C5 on 11.2.0, 60 ms after Active Standby, and twice more as it comes
 * back on), and the settings service tells its subscribers. While one of LG's
 * settings is changed, Glasshouse subscribes and puts its own back a second
 * after any change. More than twelve such writes in a minute are left to the
 * half-hourly check, so Glasshouse and LG never take turns without end.
 */
var REAPPLY_LIMIT = 12;
var REAPPLY_WINDOW_MS = 60000;
var watcher = null;
var reapplyTimer = null;
var reapplied = [];

function watchLg(on) {
  if (!SubscriptionCtor) return;
  if (on && !watcher) {
    watcher = new SubscriptionCtor('com.webos.settingsservice/getSystemSettings',
      { category: OTHER_CATEGORY, keys: [MAPPING_KEY], subscribe: true }, null, { message: lgChanged });
    watcher.start();
  } else if (!on && watcher) {
    watcher.stop();
    watcher = null;
    if (reapplyTimer) { clearTimeout(reapplyTimer); reapplyTimer = null; }
  }
}

function lgChanged() {
  if (reapplyTimer) return;
  reapplyTimer = setTimeout(function () {
    reapplyTimer = null;
    var now = Date.now();
    reapplied = reapplied.filter(function (t) { return t <= now && now - t < REAPPLY_WINDOW_MS; });
    if (reapplied.length >= REAPPLY_LIMIT) return;
    applyNative(function (ok, wrote) {
      if (!wrote) return;
      reapplied.push(Date.now());
      console.log('remotekeys: LG put its keys back; set again' + (ok ? '' : ', and the TV did not take it'));
    });
  }, reapplyDelayMs);
}

/*
 * The keys this TV offers and how it changes them: cb(keys, kind) with kind
 * 'filter' for the JavaScript filter chain, 'native' for webOS 11's values,
 * or cb(null) where it can change none.
 */
function offeredKeys(cb) {
  var onTv = keysOnTv();
  if (onTv && onTv.length) return cb(onTv, 'filter');
  hasNativeFilters(function (yes) {
    if (!yes) return cb(null);
    readNative(function (tv) {
      var keys = nativeKeys(tv, readLg());
      cb(keys.length ? keys : null, 'native');
    });
  });
}

// The inputs a key can open: each HDMI input the TV names, then Live TV.
function inputChoices() {
  var out = Object.keys(inputNames || {}).filter(function (k) { return /^hdmi[1-4]$/.test(k); }).sort()
    .map(function (k) { return { id: APP_PREFIX + k, title: inputNames[k] || k.toUpperCase(), kind: 'input' }; });
  out.push({ id: LIVE_TV, title: msg('srv.remoteKeys.liveTv', 'Live TV'), kind: 'input' });
  return out;
}

// LG's input switcher as a choice, where the TV has it: cb([choice]) or cb([]).
function switcherChoices(cb) {
  var choice = function () {
    return switcherFound ? [{ id: INPUT_SWITCHER, title: msg('srv.remoteKeys.inputSwitcher', 'Input switcher'), kind: 'switcher' }] : [];
  };
  if (switcherFound !== null) return cb(choice());
  lunaFn('com.webos.applicationManager/getAppInfo', { id: INPUT_SWITCHER }, function (r) {
    // An answer either way is kept; no answer is asked again.
    if (r) switcherFound = !!r.returnValue;
    cb(choice());
  });
}

// The media controls a key can send, where the JavaScript filter runs.
function mediaChoices() {
  var titles = {
    play: msg('srv.remoteKeys.play', 'Play'),
    pause: msg('srv.remoteKeys.pause', 'Pause'),
    stop: msg('srv.remoteKeys.stop', 'Stop'),
    rewind: msg('srv.remoteKeys.rewind', 'Rewind'),
    fastForward: msg('srv.remoteKeys.fastForward', 'Fast forward'),
    volumeUp: msg('srv.remoteKeys.volumeUp', 'Volume up'),
    volumeDown: msg('srv.remoteKeys.volumeDown', 'Volume down'),
    mute: msg('srv.remoteKeys.mute', 'Mute')
  };
  return MEDIA_ACTIONS.map(function (a) { return { id: MEDIA_PREFIX + a, title: titles[a], kind: 'media' }; });
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
  offeredKeys(function (keys, kind) {
    if (!keys) return cb({ ok: true, supported: false });
    if (kind === 'native') return describeKeys(keys, false, cb, true);
    readChain(function (list) {
      if (!list) return cb({ ok: true, supported: false });
      describeKeys(keys, list.some(ours), cb);
    });
  });
}

function describeKeys(keys, inChain, cb, native) {
  switcherChoices(function (switchers) {
    listApps(function (apps) {
      var map = readMap();
      var titles = {};
      (apps || []).forEach(function (a) { if (a && a.id) titles[a.id] = a.title || a.id; });
      var inputs = inputChoices();
      var media = native ? [] : mediaChoices();
      var cc = country();
      switchers.concat(inputs, mediaChoices()).forEach(function (c) { titles[c.id] = c.title; });
      var out = keys.map(function (k) {
        var set = Object.prototype.hasOwnProperty.call(map, k.key);
        var id = set ? map[k.key] : null;
        var key = {
          key: k.key,
          title: k.title,
          action: !set ? 'lg' : (id ? 'open' : 'nothing'),
          id: id || '',
          opens: id ? (titles[id] || id) : '',
          elsewhere: !!(cc && k.regions && k.regions.indexOf(cc) === -1)
        };
        if (k.noNothing) key.noNothing = true;
        if (k.turnsOffVoice) key.turnsOffVoice = true;
        if (native && NATIVE_BLOCK_KEYS[k.key]) key.blocksApp = true;
        return key;
      });
      cb({
        ok: true, supported: true, keys: out,
        choices: switchers.concat(media, inputs, appChoices(apps)),
        inChain: inChain
      });
    });
  });
}

/*
 * Sets a key: action 'lg' puts it back as LG has it, 'nothing' makes it do
 * nothing, 'open' opens id, an input, an app on the Home screen or LG's input
 * switcher, or sends a media control where the JavaScript filter runs. It takes
 * effect at once, through the filter's configd subscription or, on webOS 11,
 * LG's own values. cb({ ok, error }).
 */
function setRemoteKey(key, action, id, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  var def = keyByName(String(key || ''));
  offeredKeys(function (onTv, kind) {
    if (!def || !onTv || onTv.indexOf(def) === -1) {
      return cb({ ok: false, error: msg('srv.remoteKeys.badKey', 'This TV does not have that key') });
    }
    setOfferedKey(def, action, String(id || '').trim(), kind, cb);
  });
}

function setOfferedKey(def, action, id, kind, cb) {
  var map = readMap();
  if (action === 'lg') {
    delete map[def.key];
    return save(map, cb);
  }
  if (action === 'nothing') {
    if (def.noNothing) return cb({ ok: false, error: msg('srv.remoteKeys.noNothing', 'This key cannot be set to do nothing') });
    map[def.key] = '';
    return save(map, cb);
  }
  if (action !== 'open' || !id) return cb({ ok: false, error: 'lg, nothing or open expected' });
  switcherChoices(function (switchers) {
    listApps(function (apps) {
      if (!apps) return cb({ ok: false, error: msg('srv.remoteKeys.noApps', 'Could not read the TV\'s apps. Try again in a moment.') });
      var media = kind === 'filter' ? mediaChoices() : [];
      var allowed = switchers.concat(media, inputChoices(), appChoices(apps)).some(function (c) { return c.id === id; });
      if (!allowed) return cb({ ok: false, error: msg('srv.remoteKeys.unknownApp', 'That app is not on this TV') });
      map[def.key] = id;
      save(map, cb);
    });
  });
}

function save(map, cb, home, starting) {
  try {
    writeMap(map, home === undefined ? readHome() : home, starting === undefined ? readStarting() : starting);
  } catch (e) {
    return cb({ ok: false, error: msg('srv.remoteKeys.saveFailed', 'Could not save the change: {error}', { error: e.message }) });
  }
  applyAny(function (ok) {
    if (!ok) return cb({ ok: false, error: msg('srv.remoteKeys.chainFailed', 'The TV did not take the change') });
    cb({ ok: true });
  });
}

// apply() where this TV's filters are JavaScript, applyNative() on webOS 11.
function applyAny(cb) {
  if (keysOnTv()) return apply(cb);
  hasNativeFilters(function (yes) {
    if (yes) return applyNative(cb);
    apply(cb);
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
  if (keysOnTv()) return apply(cb);
  hasNativeFilters(function (yes) {
    if (!yes) return cb(false);
    applyNative(cb);
  });
}

/*
 * LG writes its list back as the TV goes into standby and as it comes back
 * on, and not every write reaches a subscriber: around one switch off and on
 * of a C5 (11.2.0) it wrote nine times, five of them unannounced, the last a
 * minute after the TV came on. So each change of power state is followed by
 * checks from a few seconds to ten minutes after it, beside the subscription.
 */
var POWER_RECHECKS_MS = [3000, 15000, 60000, 180000, 600000];
var powerRechecksMs = POWER_RECHECKS_MS;
var powerTimers = [];

function powerChanged() {
  powerTimers.forEach(function (t) { clearTimeout(t); });
  powerTimers = powerRechecksMs.map(function (ms) {
    return setTimeout(function () {
      recheckNative(function (ok, wrote) {
        if (wrote) console.log('remotekeys: LG put its keys back at a power change; set again' + (ok ? '' : ', and the TV did not take it'));
      });
    }, ms);
  });
}

/*
 * On webOS 11, every half hour: LG's server can send the streaming buttons'
 * list again, which puts back LG's apps. Reads only, unless a key set here has
 * been changed back. Nothing elsewhere, where the filter's values are
 * Glasshouse's own. cb(ok).
 */
var RECHECK_MS = 30 * 60 * 1000;
function recheckNative(cb) {
  cb = cb || function () {};
  if (!lunaFn || keysOnTv()) return cb(false);
  hasNativeFilters(function (yes) {
    if (!yes) return cb(false);
    applyNative(cb);
  });
}

/*
 * The toast for Home while Glasshouse Home is not yet in place after a cold
 * start, or '' while it is off. An unchanged map still reconciles configd:
 * the previous write may have failed after the map was saved. cb({ ok, error }).
 */
function setStarting(text, cb) {
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  text = String(text || '');
  if (!text && !fs.existsSync(mapFile()) && !fs.existsSync(filterFile())) return cb({ ok: true, unchanged: true });
  if (text === readStarting()) return applyAny(function (ok) { cb({ ok: ok }); });
  save(readMap(), cb, undefined, text);
}

// Everything as LG has it: the map deleted, the keys emptied in configd (it
// cannot delete the value), and the filter out of the chain and deleted. On
// webOS 11, LG's values put back instead, and the map deleted once they are.
function restore(cb) {
  if (fs.existsSync(lgFile())) {
    if (!lunaFn) return cb(false);
    return applyNative(function (ok) {
      if (!ok) return cb(false);
      try { fs.unlinkSync(mapFile()); } catch (e) { if (e.code !== 'ENOENT') return cb(false); }
      if (!fs.existsSync(filterFile())) return cb(true);
      restoreFilter(cb);
    }, {});
  }
  // A TV that never used the filter has nothing to restore, even without configd.
  if (!fs.existsSync(mapFile()) && !fs.existsSync(filterFile())) return cb(true);
  if (!lunaFn) return cb(false);
  restoreFilter(cb);
}

function restoreFilter(cb) {
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
  setStarting: setStarting,
  homeApp: readHome,
  ensure: ensure,
  recheckNative: recheckNative,
  powerChanged: powerChanged,
  isFollowingLog: function () { return following; },
  RECHECK_MS: RECHECK_MS,
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
  var servicesLib = require('./services');
  servicesLib.init({ stateDir: path.join(__dirname, '..') });
  init({ luna: lunaLib.call || lunaLib, services: servicesLib, stateDir: path.join(__dirname, '..') });
  restore(function (ok) {
    console.log(ok ? 'remotekeys: keys as LG has them' : 'remotekeys: could not reach configd; the map file is deleted');
    process.exit(ok ? 0 : 1);
  });
}
