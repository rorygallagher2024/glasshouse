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
 * not). Home, Back, volume, mute and power are not offered: the first two are
 * what the dashboard's own controls depend on, and the rest the microcontroller
 * handles before any filter sees them. The channel keys are offered where a
 * filter names them (appLaunch.js does on an OLED48C56LB, webOS 10.3.0); a key
 * that is set is accepted by the filter, so only As LG has it keeps LG's channel
 * change. Where no filter names them, as on a B8 (webOS 4.4), the TV's WebOS
 * module defining them is enough (fromPlugin). On webOS 11 they are offered
 * through lib/guidepatch (blockCode) instead, since the native filters do not
 * carry them.
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
 * reads what a key does from two of LG's own values and takes up a change there
 * at once, though after a wake it can act on a list of its own (nudgedList): the streaming buttons and Apps from the settings
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
var guidePatch = require('./guidepatch');
var levelBar = require('./levelbar');
var remotes = require('./remotes');

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
// LG's Home, which opens Glasshouse Home while that holds its place. Not a tile
// on the Home screen, so not among the apps, and offered on its own.
var HOME_APP = 'com.webos.app.home';
// Glasshouse's input bar, an overlay app (assets/inputbar-app/).
var INPUT_BAR = 'com.tvweb.inputbar';
var HOME_BAR = 'com.tvweb.homebar';
var INPUT_BAR_DIR = '/media/developer/apps/usr/palm/applications/' + INPUT_BAR;
// The separate app earlier Glasshouse Home builds installed, now removed; a key
// still set to it opened nothing, and is moved to HOME_APP at start.
var LEGACY_HOME_APP = 'com.tvweb.home';
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
 * 10.2.2). OK is KEY_ENTER, which opened the tile in focus in Glasshouse Bar
 * on a C2 (webOS 9.2.2): for a remote whose OK is the scroll wheel's press
 * (#1513). A play/pause toggle, asking acb what was playing first, did
 * nothing there, so none is offered. webOS 11's native filters launch apps
 * only, so they are not offered there.
 */
var MEDIA_PREFIX = 'media:';
var MEDIA_CODES = {
  ok: 28,
  play: 207, pause: 119, stop: 128, rewind: 168, fastForward: 208,
  volumeUp: 115, volumeDown: 114, mute: 113
};
var MEDIA_ACTIONS = ['ok', 'play', 'pause', 'stop', 'rewind', 'fastForward', 'volumeUp', 'volumeDown', 'mute'];
var MEDIA_REPEATS = { volumeUp: true, volumeDown: true };
/*
 * Screen off, as the dashboard's: tvpower's turnOffScreen blanks the panel and
 * any key brings the picture back (#1085). The key's own release brought it
 * back on a C2 (webOS 9.2.2) when the press blanked it, so it is blanked on the
 * release, and only where the press found the picture on: a press while it is
 * off wakes it, and its release must not blank it again. The state is followed
 * through a tvpower subscription, as asking at the press answered after the
 * TV had woken.
 */
var SCREEN_OFF = 'action:screenOff';
/*
 * Panel brightness (OLED light, or the backlight on an LCD) up or down one
 * step per press. Where the JavaScript filter runs, it steps it itself and
 * repeats while the key is held; on webOS 11 it is offered beside Screen off
 * and answered from the system log the same way, one step per press.
 */
var BRIGHTNESS_UP = 'action:brightnessUp';
var BRIGHTNESS_DOWN = 'action:brightnessDown';
var BRIGHTNESS_DEFAULT_STEP = 10;
var BRIGHTNESS_MAX_STEP = 50;
var BRIGHTNESS_DELTAS = {};
BRIGHTNESS_DELTAS[BRIGHTNESS_UP] = 1;
BRIGHTNESS_DELTAS[BRIGHTNESS_DOWN] = -1;
function isBrightnessAction(id) {
  return Object.prototype.hasOwnProperty.call(BRIGHTNESS_DELTAS, id);
}
/*
 * PicCap capture on or off: toggles org.webosbrew.piccap.service between
 * start and stop. Offered where PicCap is installed on webOS 3 and later.
 */
var PICCAP_TOGGLE = 'action:piccap';
// The actions webOS 11 answers from the log: LG's own action for the key is off.
function isLoggedAction(id) {
  return id === SCREEN_OFF || id === PICCAP_TOGGLE || Object.prototype.hasOwnProperty.call(BRIGHTNESS_DELTAS, id);
}
// Wait for release to avoid sending more key events as standby starts.
var POWER_OFF = 'action:powerOff';
/*
 * Home Assistant: the key does nothing on the TV, and its press reaches Home
 * Assistant as a Remote Button event, which lib/remotebuttons reads from the
 * remote's own device whatever the filter does (#1088). Offered for the keys
 * that are reported, where MQTT is on.
 */
var HOME_ASSISTANT = 'action:homeAssistant';
/*
 * Glasshouse Home's Internet TV guide: the key opens Home as the Home key
 * does, with { glasshouse: 'guide' }, and the view opens its guide. LG's
 * filters otherwise take the Guide key for LG's own broadcast guide, and the
 * page never sees it (G3, webOS 9.2.2). Offered while Glasshouse Home is on
 * with an IPTV playlist (lib/iptv), where the JavaScript filter runs.
 */
var HOME_GUIDE = 'action:homeGuide';
var reportedButtons = require('./remotebuttons').buttonNames;

// webOS 11's native key filters; see the header.
var NATIVE_FILTERS_KEY = 'com.webos.surfacemanager.keyFiltersCpp';
var KEY_ACTION_PREFIX = 'com.webos.keyaction.';
// Keys whose action is a configd value there, by the value's name.
var NATIVE_ACTIONS = { guide: 'tvGuide', homehub: 'inputHub' };
// Keys whose action is one of the settings service's, by the setting's name.
var NATIVE_SETTINGS = { multikey: 'customShortPress', multikeyhold: 'customLongPress' };
var COLOR_CODES = { red: 398, green: 399, yellow: 400, blue: 401 };
var colorTargets = {};
var colorButtonsSupported = function () { return false; };
/** @type {function(boolean): void} */
var watchColorButtons = function () {};
var colorLaunch = null;
// Where lib/guidepatch has no build for this library, the channel keys as
// lib/remotebuttons reports them (its own evdev codes, KEY_CHANNELUP and
// KEY_CHANNELDOWN), observed the same way as the color keys above: without
// taking the key from LG or the foreground app.
var CHANNEL_EVDEV_CODES = { channelup: 402, channeldown: 403 };
var channelTargets = {};
var channelButtonsSupported = function () { return false; };
/** @type {function(boolean): void} */
var watchChannelButtons = function () {};
var channelLaunch = null;
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
/*
 * Apps sam would not block, from this start: a C3 (11.2.0) answers the block
 * of amazon.alexa.view, which has a launch point there, with errorCode 1
 * "exist in listLaunchPoint: amazon.alexa.view" (#1498). Its button cannot be
 * changed there, so it is not offered, and the refusal does not fail the rest
 * of a write, which carries the Home key's starting notice.
 */
var refusedBlocks = {};
var MESSAGES_LOG = '/var/log/messages';
var OTHER_CATEGORY = 'other';
var MAPPING_KEY = 'mapping_info';

/*
 * The keys that can be changed, in the order shown. Each is a symbol the
 * compositor's filters match on; the title is what the remote prints. The
 * Amazon button is Alexa on some remotes, and the Prime Video button on most.
 */
/*
 * lg: LG's name for the button in its key table (/usr/share/X11/xkb/keycodes/lg),
 * where the TV's code is the Linux input code + 8 and the comment names the Qt
 * key the filters see. log: the button_type lginput2 logs for a press, where
 * seen. keyTable: offered only where the TV's key table maps lg to the
 * symbol. docs/development/remote-keys.md is made from these (scripts/gen-remote-keys-doc.js).
 *
 * regions: the countries (smartServiceCountryCode2) whose remotes have the
 * key. LG ships one filter set to many regions, so a UK C2 names Hulu and Sling
 * TV too; the dashboard keeps a key from elsewhere out of the way.
 */
var KEYS = [
  { key: 'netflix', lg: 'IR_KEY_NETFLIX', log: 'KEY_NETFLIX', symbol: 'WebOS.Key_webOS_Netflix', title: 'Netflix' },
  { key: 'amazon', lg: 'IR_KEY_AMAZON', log: 'KEY_AMAZON', symbol: 'WebOS.Key_webOS_Amazon', title: 'Prime Video' },
  { key: 'disneyplus', lg: 'IR_KEY_DISNEYPLUS', log: 'KEY_DISNEY', symbol: 'WebOS.Key_webOS_Disneyplus', title: 'Disney+' },
  { key: 'lgchannels', lg: 'IR_KEY_LGCHANNELS', symbol: 'WebOS.Key_webOS_LGChannels', title: 'LG Channels' },
  { key: 'rakutentv', lg: 'IR_KEY_RAKUTENTV', symbol: 'WebOS.Key_webOS_RakutenTV', title: 'Rakuten TV' },
  // The Movies button on 2020 remotes (the MR20's white MOVIES key). LG's
  // filters open whichever film store the region has from it, a hotkey id
  // from the settings service, under the key it called USP on 2019 sets.
  { key: 'movies', lg: 'IR_KEY_USP', symbol: 'WebOS.Key_webOS_USP', title: 'Movies' },
  { key: 'hulu', lg: 'IR_KEY_HULU', symbol: 'WebOS.Key_webOS_Hulu', title: 'Hulu', regions: ['us'] },
  { key: 'iplayer', lg: 'IR_KEY_IPLAYER', symbol: 'WebOS.Key_webOS_IPlayer', title: 'BBC iPlayer', regions: ['gb'] },
  { key: 'freeviewplay', lg: 'IR_KEY_FREEVIEWPLAY', symbol: 'WebOS.Key_webOS_FreeviewPlay', title: 'Freeview Play', regions: ['gb'] },
  { key: 'slingtv', lg: 'IR_KEY_SLINGTV', symbol: 'WebOS.Key_webOS_SlingTV', title: 'Sling TV', regions: ['us'] },
  { key: 'globoplay', lg: 'IR_KEY_GLOBOPLAY', symbol: 'WebOS.Key_webOS_Globoplay', title: 'Globoplay', regions: ['br'] },
  { key: 'shahid', lg: 'IR_KEY_SHAHID', symbol: 'WebOS.Key_webOS_Shahid', title: 'Shahid', regions: ['ae'] },
  // Verified in a C3's webOS 11 mapping_info; older Qt key symbols are unverified.
  { key: 'ivi', title: 'Ivi', nativeMapping: true },
  { key: 'okko', title: 'Okko', nativeMapping: true },
  { key: 'kinopoisk', title: 'Kinopoisk', nativeMapping: true },
  { key: 'shop', title: 'LG Shop', nativeMapping: true },
  // Verified in an OLED48C6PSA's webOS 11 mapping_info (#1738); older Qt key symbols are unverified.
  { key: 'stan', title: 'Stan', nativeMapping: true },
  { key: 'youtube', title: 'YouTube', nativeMapping: true },
  // The voice assistants' own buttons on recent Magic Remotes: LG's filters
  // launch Alexa or the Google Assistant on a press, as for a streaming
  // button. The microphone button (Key_webOS_Voice) drives voice control; set
  // to anything else, a press and a hold both do that instead, and voice
  // control comes back with LG's own (a CX, webOS 5.5).
  { key: 'alexa', lg: 'IR_KEY_ALEXA', log: 'KEY_ALEXAVOICE', symbol: 'WebOS.Key_webOS_ALEXA', title: 'Alexa' },
  { key: 'googleassistant', lg: 'IR_KEY_GOOGLEVOICE', symbol: 'WebOS.Key_webOS_GoogleVoice', title: 'Google Assistant' },
  { key: 'voice', lg: 'RF_KEY_VOICE', log: 'KEY_VOICE', symbol: 'WebOS.Key_webOS_Voice', title: 'Microphone', replacesVoice: true },
  { key: 'apps', lg: 'IR_KEY_APPS', symbol: 'WebOS.Key_webOS_Apps', title: 'Apps' },
  // webOS 11's native filters change these (NATIVE_ACTIONS, NATIVE_SETTINGS).
  // Home Hub is the MR25's house-in-a-circle button (IR 1031); the ? button
  // (IR 1132) is LG's custom button, with an action of its own when held.
  //
  // Home Hub and ? are also filter keys where LG's JavaScript filters name
  // them, as appLaunch.js does on an OLED48C56LB (webOS 10.3.0): Home Hub as
  // Qt.Key_Video, opening the app LG sets for it (inputHubAction) or the input
  // picker; ? opening the accessibility menu on a press and its overlay on a
  // 2 s hold. Set there, a key takes both press and hold, as the microphone
  // does, and only webOS 11's native setting cannot be left doing nothing.
  //
  // Qt.Key_Video is a plain Qt key that another firmware could give another
  // button, so Home Hub is offered only where LG's key table
  // (/usr/share/X11/xkb/keycodes/lg) gives it to the Home Hub button, named
  // lg: keyTable.
  { key: 'homehub', log: 'KEY_HOMEDASHBOARD', symbol: 'Qt.Key_Video', lg: 'IR_KEY_INPUT_HUB', keyTable: true, title: 'Home Hub' },
  // The MR25's AI button reads no value: see NATIVE_SERVICE_KEYS.
  { key: 'ai', title: 'AI', nativeOnly: true, turnsOffVoice: true },
  { key: 'multikey', lg: 'IR_KEY_MULTIKEY', log: 'KEY_MULTIKEY', symbol: 'WebOS.Key_webOS_Multikey', title: '? button', noNothing: true },
  { key: 'multikeyhold', title: '? button, held', nativeOnly: true, noNothing: true },
  // The 123 button, a filter key only: appLaunch.js on an OLED48C56LB (webOS
  // 10.3.0) shows LG's on-screen remote on a press (systemUIManager,
  // com.webos.app.screenremote: user manual, Sport, Quick Help and the colour
  // keys), hands it to YouTube and apps that ask for it, and a hold toggles
  // audio description. Set, the filter takes all of that.
  { key: 'screenremote', lg: 'IR_KEY_SCREEN_REMOTE', log: 'KEY_SCREEN_REMOTE', symbol: 'WebOS.Key_webOS_ScreenRemote', title: '123 button', filterOnly: true },
  // The channel rocker. On webOS 10 and below the JavaScript key filter names
  // it (symbol), where a key that is set is accepted and so no longer changes
  // the channel. On webOS 11 the filter does not carry it; lib/guidepatch has
  // LG's first key filter take the key (blockCode, the Linux key code) and the
  // press is answered from that filter's own log line (KEY_EVENT).
  // fromPlugin: offered too where LG's filters leave the key out but the
  // TV's WebOS module defines it, as on a B8 (webOS 4.4), whose filters name
  // no channel key though every LG remote has them.
  { key: 'channelup', lg: 'IR_KEY_CH_UP', log: 'KEY_CHANNELUP', symbol: 'WebOS.Key_webOS_ChannelUp', title: 'Channel up', blockCode: 402, fromPlugin: true },
  { key: 'channeldown', lg: 'IR_KEY_CH_DOWN', log: 'KEY_CHANNELDOWN', symbol: 'WebOS.Key_webOS_ChannelDown', title: 'Channel down', blockCode: 403, fromPlugin: true },
  { key: 'guide', lg: 'IR_KEY_GUIDE', log: 'KEY_GUIDE', symbol: 'WebOS.Key_webOS_TVGuide', title: 'Guide' },
  { key: 'input', lg: 'IR_KEY_TV_VIDEO', symbol: 'WebOS.Key_webOS_InputSource', title: 'Input' },
  { key: 'livetv', lg: 'IR_KEY_TV', symbol: 'WebOS.Key_webOS_InputTV', title: 'TV' },
  { key: 'search', lg: 'IR_KEY_SEARCH', symbol: 'Qt.Key_Search', title: 'Search' },
  { key: 'info', lg: 'IR_KEY_INFO', symbol: 'WebOS.Key_webOS_Info', title: 'Info' },
  { key: 'help', lg: 'IR_KEY_EMANUAL', symbol: 'Qt.Key_Help', title: 'Help' },
  { key: 'red', lg: 'IR_KEY_RED', symbol: 'WebOS.Key_webOS_Red', title: 'Red', color: true },
  { key: 'green', lg: 'IR_KEY_GREEN', symbol: 'WebOS.Key_webOS_Green', title: 'Green', color: true },
  { key: 'yellow', lg: 'IR_KEY_YELLOW', symbol: 'WebOS.Key_webOS_Yellow', title: 'Yellow', color: true },
  { key: 'blue', lg: 'IR_KEY_BLUE', symbol: 'WebOS.Key_webOS_Blue', title: 'Blue', color: true }
];

var lunaFn = null;
// Told when a key is set to open the input bar (lib/inputbar.js preloads it).
var keySetFn = null;
// Installs or removes the input bar's app, (action, cb) as tvweb.js's tvApp;
// null where this server cannot.
var barAppFn = null;
// Whether this TV is offered the input bar (lib/inputbar.js allowed).
var barAllowedFn = function () { return false; };
/*
 * Glasshouse Bar on a key, beside Glasshouse Home (#1499): its app installed
 * or removed as the input bar's, offered where the bars are, lib/homebar told
 * when a key is set to it so it keeps it loaded, and its app left on the TV
 * while the Bar is the launcher.
 */
var homeBarAppFn = null;
var homeBarAllowedFn = function () { return false; };
var homeBarKeySetFn = null;
var homeBarLauncherFn = function () { return false; };
// Whether the bar's app can be put on this TV and kept loaded, which the brightness keys' on-screen level needs.
function barAvailable() { return !!barAppFn && barAllowedFn(); }
var inputNames = null;
var stateDir = '/var/lib/tvweb';
var filtersDir = LG_FILTERS_DIR;
// The QML module that defines WebOS.Key_webOS_*, for keys LG's own filters do
// not name (fromPlugin).
var WEBOS_PLUGIN = '/usr/lib/qt5/qml/WebOS/Global/libwebosglobalplugin.so';
var webosPlugin = WEBOS_PLUGIN;
var tvKeys = null;      // the symbols this TV's filters name, read once
var LG_KEY_TABLE = '/usr/share/X11/xkb/keycodes/lg';
var keyTablePath = LG_KEY_TABLE;
var nativeFilters = null; // whether configd names native filters, once answered
var switcherFound = null; // whether the TV has INPUT_SWITCHER, once answered
var SubscriptionCtor = null; // luna.Subscription, to follow LG's settings
/** @type {typeof import('./services') | null} */
var servicesModule = null;  // to switch LG's voice assistant off and on
// Whether MQTT is on, for the Home Assistant choice.
var homeAssistantOn = function () { return false; };
// Glasshouse Home on, with an IPTV playlist: its guide is a key's choice.
/** @type {function(): boolean} */
var homeGuideOn = function () { return false; };
// PicCap installed on webOS 3+: Ambient light toggle is a key's choice.
/** @type {function(): boolean} */
var piccapOn = function () { return false; };
var piccapToggleFn = null;
var piccapToggleBusy = false;
// Told when the compositor was restarted for a change to LG's key handler, so Glasshouse Home's view can be opened again.
var compositorRestartedFn = function () {};
var messagesPath = MESSAGES_LOG;
var reapplyDelayMs = 1000;
// The LG remotes in use, as cb({ auto: catalogue entries (null for one not catalogued), detected: what lib/remotedetect found }).
var detectRemotesFn = null;

function init(opts) {
  opts = opts || {};
  watchColorButtons(false);
  colorTargets = {};
  colorButtonsSupported = opts.colorButtonsSupported || function () { return false; };
  watchColorButtons = opts.watchColorButtons || function () {};
  colorLaunch = opts.lunaUrgent || opts.luna || null;
  watchChannelButtons(false);
  channelTargets = {};
  channelButtonsSupported = opts.channelButtonsSupported || function () { return false; };
  watchChannelButtons = opts.watchChannelButtons || function () {};
  channelLaunch = opts.lunaUrgent || opts.luna || null;
  lunaFn = opts.luna || null;
  refusedBlocks = {};
  keySetFn = typeof opts.onInputBarKey === 'function' ? opts.onInputBarKey : null;
  barAppFn = typeof opts.inputBarApp === 'function' ? opts.inputBarApp : null;
  barAllowedFn = typeof opts.inputBarAllowed === 'function' ? opts.inputBarAllowed : function () { return false; };
  homeBarAppFn = typeof opts.homeBarApp === 'function' ? opts.homeBarApp : null;
  homeBarAllowedFn = typeof opts.homeBarAllowed === 'function' ? opts.homeBarAllowed : function () { return false; };
  homeBarKeySetFn = typeof opts.onHomeBarKey === 'function' ? opts.onHomeBarKey : null;
  homeBarLauncherFn = typeof opts.homeBarLauncher === 'function' ? opts.homeBarLauncher : function () { return false; };
  inputNames = opts.inputNames || {};
  if (opts.stateDir) stateDir = opts.stateDir;
  guidePatch.init({ stateDir: stateDir, library: opts.guideLibrary, systemUiLibrary: opts.systemUiLibrary, preProcessLibrary: opts.preProcessLibrary,
    exec: opts.guideExec, mounts: opts.guideMounts, mountInfo: opts.guideMountInfo, luna: lunaFn,
    profileOverrideDir: opts.profileOverrideDir, profileWaitMs: opts.profileWaitMs, profilePollMs: opts.profilePollMs });
  filtersDir = opts.filtersDir || LG_FILTERS_DIR;
  keyTablePath = opts.keyTablePath || LG_KEY_TABLE;
  webosPlugin = opts.webosPlugin || WEBOS_PLUGIN;
  tvKeys = null;
  nativeFilters = null;
  switcherFound = null;
  watchLg(false);
  reapplied = [];
  SubscriptionCtor = opts.subscription || null;
  levelBar.init({ luna: lunaFn, subscription: SubscriptionCtor, readStyle: brightnessBarStyle, idleMs: opts.backlightIdleMs });
  followPresses({});
  if (toastsTimer) { clearTimeout(toastsTimer); toastsTimer = null; }
  servicesModule = opts.services || null;
  homeAssistantOn = opts.homeAssistant || function () { return false; };
  homeGuideOn = opts.homeGuide || function () { return false; };
  piccapOn = typeof opts.piccap === 'function' ? opts.piccap : function () { return false; };
  piccapToggleFn = typeof opts.togglePiccap === 'function' ? opts.togglePiccap : null;
  piccapToggleBusy = false;
  compositorRestartedFn = opts.compositorRestarted || function () {};
  messagesPath = opts.messagesPath || MESSAGES_LOG;
  detectRemotesFn = typeof opts.detectRemotes === 'function' ? opts.detectRemotes : null;
  if (typeof opts.reapplyDelayMs === 'number') reapplyDelayMs = opts.reapplyDelayMs;
  muteToastsMs = opts.muteToastsMs || 0;
  powerTimers.forEach(function (t) { clearTimeout(t); });
  powerTimers = [];
  lastPowerState = null;
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

// Every key that can be set, by name, with the title it has on the Remote tab: what the remote catalogue's key ids refer to.
function keyTitles() {
  var out = {};
  KEYS.forEach(function (k) { out[k.key] = k.title; });
  return out;
}

function keyByName(name) {
  for (var i = 0; i < KEYS.length; i++) if (KEYS[i].key === name) return KEYS[i];
  return null;
}

/*
 * The keys this TV's filters name. The compositor's enum may know more, but
 * a key its filters never match on is not one its remotes send. The four
 * colour keys are offered together when any one of them is named: webOS 4's
 * filters only have cases for Yellow and Blue, passing Red and Green straight
 * to the app in front.
 */
// A filter symbol as LG's key table names its Qt key: Qt.Key_Video is Key_Video, WebOS.Key_webOS_Guide Key_webOS_Guide.
function qtName(symbol) {
  return String(symbol || '').replace(/^(Qt|WebOS)\./, '');
}

/*
 * LG's key table, as { button name: { code, qt } }: lines such as
 * "<IR_KEY_INPUT_HUB> = 1031; // Qt::Key_Video=0x010000f3". Empty where the
 * file cannot be read.
 */
function readKeyTable(file) {
  var out = {};
  var text = '';
  try { text = fs.readFileSync(file || keyTablePath, 'utf8'); } catch (e) { return out; }
  text.split('\n').forEach(function (line) {
    var m = /<([A-Za-z0-9_]+)>\s*=\s*(\d+)\s*;\s*\/\/\s*Qt::(\w+)\s*=/.exec(line);
    if (m) out[m[1]] = { code: parseInt(m[2], 10), qt: m[3] };
  });
  return out;
}

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
  var hasColor = KEYS.some(function (k) { return k.color && src.indexOf(k.symbol) !== -1; });
  var plugin = null;
  // Whether the WebOS module defines a key's name, read once and only if needed.
  function inPlugin(symbol) {
    if (plugin === null) {
      try { plugin = fs.readFileSync(webosPlugin).toString('binary'); } catch (e) { plugin = ''; }
    }
    return plugin.indexOf(symbol.replace(/^WebOS\./, '') + '\u0000') !== -1;
  }
  var table = null;
  tvKeys = KEYS.filter(function (k) {
    if (k.nativeOnly || k.nativeMapping) return false;
    if (k.keyTable) {
      // A plain Qt key: only where this firmware gives it to that button.
      if (src.indexOf(k.symbol) === -1) return false;
      if (!table) table = readKeyTable();
      return !!(table[k.lg] && table[k.lg].qt === qtName(k.symbol));
    }
    if ((k.color && hasColor) || src.indexOf(k.symbol) !== -1) return true;
    return !!k.fromPlugin && inPlugin(k.symbol);
  });
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

// The points one brightness press moves, as set on the Remote tab, or 0 where it was not set.
function readStoredBrightnessStep() {
  try {
    var j = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    var n = j && j.brightnessStep;
    return typeof n === 'number' && n >= 1 && n <= BRIGHTNESS_MAX_STEP ? n : 0;
  } catch (e) {
    return 0;
  }
}

function brightnessStep() {
  return readStoredBrightnessStep() || BRIGHTNESS_DEFAULT_STEP;
}

/*
 * How the level bar looks: 'lg', a vertical bar at the right edge laid out like
 * the TV's own volume bar, 'horizontal', a pill low on the screen, 'vertical',
 * the same pill upright at the right edge, or 'none', no bar at all. All but
 * 'lg' are kept in the file, so a TV left on the default holds none.
 */
function readStoredBarStyle() {
  try {
    var j = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    return j && (j.brightnessBarStyle === 'horizontal' || j.brightnessBarStyle === 'vertical' || j.brightnessBarStyle === 'none') ? j.brightnessBarStyle : '';
  } catch (e) {
    return '';
  }
}

function brightnessBarStyle() {
  return readStoredBarStyle() || 'lg';
}

// A Brightness key shows a level bar unless the style is 'none'.
function levelBarShown() {
  return brightnessBarStyle() !== 'none';
}

// Whether a key set to id needs the bar's app: it opens the bar, or shows a
// level bar, which only a TV offered the input bar shows (not webOS 11).
function needsBarApp(id) {
  return id === INPUT_BAR || (isBrightnessAction(id) && levelBarShown() && barAvailable());
}

/*
 * Which remotes the Remote tab is for: { mode: 'auto' } (the remote paired or
 * seen in use lately, folding what it does not have) or { mode: 'all' }
 * (every key shown). Kept in the map's file, as `remotes`, only when it is
 * not automatic.
 */
function readRemoteSelection() {
  try {
    var j = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    var r = j && j.remotes;
    if (r && r.mode === 'all') return { mode: 'all' };
  } catch (e) { /* none kept */ }
  return { mode: 'auto' };
}

// step, style and selection are kept as they were in the file unless one is given ('' for the default step or style).
function writeMap(map, home, starting, step, style, selection) {
  levelBar.forgetStyle();
  if (step === undefined) step = readStoredBrightnessStep();
  if (style === undefined) style = readStoredBarStyle();
  if (selection === undefined) selection = readRemoteSelection();
  if (!Object.keys(map).length && !home && !starting && !step && !style && selection.mode === 'auto') {
    try { fs.unlinkSync(mapFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  var j = { keys: map, updated: new Date().toISOString() };
  if (home) j.home = home;
  if (starting) j.starting = starting;
  if (step) j.brightnessStep = step;
  if (style) j.brightnessBarStyle = style;
  if (selection.mode !== 'auto') j.remotes = selection;
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
    '/* Written by Glasshouse: the remote keys set on its Remote tab, read from the',
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
    '// tvpower\'s state, and whether the Screen off key went down with the picture on.',
    'var glasshousePowerState = "Active";',
    'var glasshouseScreenOffArmed = false;',
    'var glasshousePowerOffArmed = {};',
    'var glasshouseBarPress = 0;',
    'var glasshouseBrightnessStep = ' + BRIGHTNESS_DEFAULT_STEP + ';',
    'var glasshousePiccapBusy = false;',
    'var glasshousePiccapRun = 0;',
    '',
    '// Key code by name; a name this firmware lacks is left out.',
    'function glasshouseKeyCodes() {',
    '    var codes = {};'
  ];
  KEYS.forEach(function (k) {
    if (k.nativeOnly || k.nativeMapping) return;
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
    '        glasshousePowerOffArmed = {};',
    '        glasshouseStarting = typeof value.starting === "string" ? value.starting : "";',
    levelBar.filterConfig(),
    '        glasshouseBrightnessStep = typeof value.brightnessStep === "number" && value.brightnessStep >= 1 ? value.brightnessStep : ' + BRIGHTNESS_DEFAULT_STEP + ';',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e + "; keys left as they were");',
    '    }',
    '}',
    '',
    // Whether the input bar is the window in front, by the compositor's own
    // helpers as LG's appLaunch.js uses them on webOS 6. Where they are missing
    // the bar is opened again, and the page moves on at the relaunch instead.
    'function glasshouseBarInFront() {',
    '    try {',
    '        return typeof global !== "undefined" && typeof global.isForegroundApp === "function" &&',
    '            typeof global.sendKeyToFocusWindow === "function" && global.isForegroundApp(' + JSON.stringify(INPUT_BAR) + ') === true;',
    '    } catch (e) {',
    '        return false;',
    '    }',
    '}',
    '',
    // One step of the panel brightness, as lib/remotekeys.js's stepBrightness does it.
    // The streaming buttons send no auto-repeat (a press and a release only, read
    // from the remote's input device on an MR25GA), so a held key repeats here:
    // the next step follows 0.4 s after the first and then every 0.1 s, each only
    // once the last is written, until the release or the end of the range.
    'var glasshouseBrightnessBusy = false;',
    'var glasshouseBrightnessHeld = 0;',
    'var glasshouseBrightnessSteps = 0;',
    'var glasshouseBrightnessRun = 0;',
    'var glasshouseBrightnessPress = 0;',
    'var glasshouseBrightnessPending = [];',
    // The level this press last wrote, so its repeats while the key is held skip the read (-1: none).
    'var glasshouseBrightnessLevel = -1;',
    // The bar's app shows the new level (assets/inputbar-app), opened once for each press (lib/levelbar.js):
    levelBar.filterShow(INPUT_BAR),
    'function glasshouseBrightnessKey(direction, pressed, autoRepeat) {',
    '    if (!pressed) { glasshouseBrightnessHeld = 0; glasshouseBrightnessLevel = -1; return; }',
    '    if (autoRepeat) return;',
    '    glasshouseBrightnessHeld = direction;',
    '    glasshouseBrightnessSteps = 0;',
    '    glasshouseBrightnessLevel = -1;',
    '    glasshouseBrightnessRequest(direction, ++glasshouseBrightnessPress);',
    '}',
    // A press while a step is still being written waits its turn, so quick taps each count.
    'function glasshouseBrightnessRequest(direction, press) {',
    '    if (glasshouseBrightnessBusy) {',
    '        if (glasshouseBrightnessPending.length < 5) glasshouseBrightnessPending.push({ direction: direction, press: press });',
    '        return;',
    '    }',
    '    glasshouseBrightness(direction, press);',
    '}',
    // Goes on while this press is still the key held down, a held key being
    // stopped after 6 s should its release never arrive. A timer left from an
    // earlier press finds another press current and does nothing.
    'function glasshouseBrightnessNext(direction, atEnd, press) {',
    '    glasshouseBrightnessBusy = false;',
    '    if (glasshouseBrightnessPending.length) {',
    '        var queued = glasshouseBrightnessPending.shift();',
    '        glasshouseBrightness(queued.direction, queued.press);',
    '        return;',
    '    }',
    '    if (atEnd || glasshouseBrightnessHeld !== direction || press !== glasshouseBrightnessPress || ++glasshouseBrightnessSteps > 60) return;',
    '    try {',
    '        genericTimer.set(glasshouseBrightnessSteps === 1 ? 400 : 100, function () {',
    '            if (glasshouseBrightnessHeld === direction && press === glasshouseBrightnessPress) glasshouseBrightnessRequest(direction, press);',
    '        });',
    '    } catch (e) {}',
    '}',
    'function glasshouseBrightness(direction, press) {',
    '    var delta = direction * glasshouseBrightnessStep;',
    '    glasshouseBrightnessBusy = true;',
    '    var run = ++glasshouseBrightnessRun;',
    '    try { genericTimer.set(1500, function () { if (run === glasshouseBrightnessRun) glasshouseBrightnessBusy = false; }); } catch (e) {}',
    // A repeat of the press still held goes on from the level it wrote; the press itself, and each new one, reads.
    '    if (glasshouseBrightnessLevel >= 0 && glasshouseBrightnessSteps > 0 && press === glasshouseBrightnessPress) {',
    '        glasshouseBrightnessWrite(direction, press, delta, glasshouseBrightnessLevel);',
    '        return;',
    '    }',
    '    lunaCall.send("com.webos.service.settings", "/getSystemSettings", JSON.stringify({ "category": "picture", "keys": ["backlight"] }), function (payload) {',
    '        try {',
    '            var r = typeof payload === "string" ? JSON.parse(payload) : payload;',
    '            glasshouseBrightnessWrite(direction, press, delta, r && r.settings ? Math.round(parseFloat(r.settings.backlight)) : NaN);',
    '        } catch (e) {',
    '            glasshouseBrightnessBusy = false;',
    '            console.warn("glasshouse keyfilter: " + e);',
    '        }',
    '    });',
    '}',
    'function glasshouseBrightnessWrite(direction, press, delta, current) {',
    '    try {',
    '        var level = Math.max(0, Math.min(100, current + delta));',
    '        if (isNaN(current)) { glasshouseBrightnessLevel = -1; glasshouseBrightnessNext(direction, true, press); return; }',
    '        if (level === current) { glasshouseBrightnessLevel = current; glasshouseBrightnessShow(current, press); glasshouseBrightnessNext(direction, true, press); return; }',
    '        lunaCall.send("com.webos.service.settings", "/setSystemSettings", JSON.stringify({ "category": "picture", "settings": { "backlight": String(level) } }), function () {',
    '            glasshouseBrightnessLevel = level;',
    '            glasshouseBrightnessShow(level, press);',
    '            glasshouseBrightnessNext(direction, level === 0 || level === 100, press);',
    '        });',
    '    } catch (e) {',
    '        glasshouseBrightnessBusy = false;',
    '        console.warn("glasshouse keyfilter: " + e);',
    '    }',
    '}',
    '',
    'function glasshousePowerChanged(payload) {',
    '    try {',
    '        var r = typeof payload === "string" ? JSON.parse(payload) : payload;',
    '        if (r && typeof r.state === "string") glasshousePowerState = r.state;',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e);',
    '    }',
    '}',
    '',
    '// Down with the picture on, the release blanks it; down with it off, the key only wakes it.',
    'function glasshouseScreenOffKey(pressed, autoRepeat) {',
    '    if (pressed) {',
    '        if (!autoRepeat) glasshouseScreenOffArmed = glasshousePowerState === "Active";',
    '        return;',
    '    }',
    '    if (!glasshouseScreenOffArmed) return;',
    '    glasshouseScreenOffArmed = false;',
    '    lunaCall.send("com.webos.service.tvpower", "/power/turnOffScreen", "{}", function () {});',
    '}',
    '',
    'function glasshouseTogglePiccap() {',
    '    if (glasshousePiccapBusy) return;',
    '    glasshousePiccapBusy = true;',
    '    var run = ++glasshousePiccapRun;',
    '    try { genericTimer.set(2000, function () { if (run === glasshousePiccapRun) glasshousePiccapBusy = false; }); } catch (e) {}',
    '    lunaCall.send("org.webosbrew.piccap.service", "/status", "{}", function (payload) {',
    '        try {',
    '            var r = typeof payload === "string" ? JSON.parse(payload) : payload;',
    '            if (!r || r.returnValue === false || typeof r.isRunning !== "boolean") {',
    '                glasshousePiccapBusy = false;',
    '                return;',
    '            }',
    '            lunaCall.send("org.webosbrew.piccap.service", r.isRunning ? "/stop" : "/start", "{}", function () {',
    '                glasshousePiccapBusy = false;',
    '            });',
    '        } catch (e) {',
    '            glasshousePiccapBusy = false;',
    '            console.warn("glasshouse keyfilter: " + e);',
    '        }',
    '    });',
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
    '    try {',
    '        lunaCall.subscribe("com.webos.service.tvpower", "/power/getPowerState",',
    '            JSON.stringify({ "subscribe": true }), glasshousePowerChanged, true);',
    '    } catch (e) {',
    '        console.warn("glasshouse keyfilter: " + e + "; power state not followed");',
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
    '        } else if (id === ' + JSON.stringify(HOME_ASSISTANT) + ') {',
    '            // Nothing on the TV: Glasshouse reads the press from the remote itself.',
    '        } else if (id === ' + JSON.stringify(HOME_GUIDE) + ') {',
    '            if (pressed && !autoRepeat) {',
    '                console.info("glasshouse keyfilter: key", key, "opens Glasshouse Home\'s guide");',
    // webOS 4 uses Glasshouse Home's standalone app, named by the Home key.
    '                applicationManager.launch(glasshouseKeyIds[Qt.Key_Super_L] || ' + JSON.stringify(HOME_APP) + ', JSON.stringify({ "activateType": "home", "launchType": "homeKey", "glasshouse": "guide" }));',
    '            }',
    '        } else if (id === ' + JSON.stringify(SCREEN_OFF) + ') {',
    '            if (!pressed && glasshouseScreenOffArmed) console.info("glasshouse keyfilter: key", key, "turns the screen off");',
    '            glasshouseScreenOffKey(pressed, autoRepeat);',
    '        } else if (id === ' + JSON.stringify(BRIGHTNESS_UP) + ' || id === ' + JSON.stringify(BRIGHTNESS_DOWN) + ') {',
    '            glasshouseBrightnessKey(id === ' + JSON.stringify(BRIGHTNESS_UP) + ' ? 1 : -1, pressed, autoRepeat);',
    '        } else if (id === ' + JSON.stringify(PICCAP_TOGGLE) + ') {',
    '            if (pressed && !autoRepeat) {',
    '                console.info("glasshouse keyfilter: key", key, "toggles PicCap");',
    '                glasshouseTogglePiccap();',
    '            }',
    '        } else if (id === ' + JSON.stringify(POWER_OFF) + ') {',
    '            if (pressed && !autoRepeat) {',
    '                var state = glasshousePowerState.toLowerCase().replace(/[\\s_-]/g, "");',
    '                glasshousePowerOffArmed[key] = state === "active" || state === "on" || state === "screenoff" || state === "screensaver";',
    '            } else if (!pressed && glasshousePowerOffArmed[key]) {',
    '                delete glasshousePowerOffArmed[key];',
    '                lunaCall.send("com.webos.service.tvpower", "/power/powerOff", JSON.stringify({ "reason": "remoteKey" }), function () {});',
    '            }',
    '        } else if (id === ' + JSON.stringify(INPUT_BAR) + ' && glasshouseBarInFront()) {',
    // Relaunching a window already on screen redraws it, which shows as a
    // flash, so a further press goes to the bar as Right (Linux KEY_RIGHT 106,
    // as LG's appLaunch.js names it), which moves it to the next input.
    '            if (!autoRepeat) global.sendKeyToFocusWindow(Qt.Key_Right, pressed, 106);',
    '        } else if (pressed && !autoRepeat && id) {',
    '            console.info("glasshouse keyfilter: key", key, "opens", id);',
    // Home opened as the Home key opens it, so Glasshouse Home opens as Home;
    // Glasshouse Bar carries a per-press sequence number so duplicate relaunches
    // can be dropped without swallowing rapid open/close toggles.
    '            applicationManager.launch(id, id === ' + JSON.stringify(HOME_APP),
    '                ? JSON.stringify({ "activateType": "home", "launchType": "homeKey" })',
    '                : (id === ' + JSON.stringify(HOME_BAR) + ' ? JSON.stringify({ "glasshouse": "bar", "press": ++glasshouseBarPress }) : "{}"));',
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
  var value = { keys: inEffect(map) };
  if (home) value.home = home;
  if (starting) value.starting = starting;
  var step = readStoredBrightnessStep();
  if (step) value.brightnessStep = step;
  if (levelBarShown() && barAvailable() && Object.keys(map).some(function (k) { return isBrightnessAction(map[k]); })) value.osd = true;
  var barStyle = readStoredBarStyle();
  if (barStyle === 'horizontal' || barStyle === 'vertical') value.osdStyle = barStyle;
  configs[MAP_KEY] = value;
  lunaFn('com.webos.service.config/setConfigs', { configs: configs }, function (r) {
    cb(!!(r && r.returnValue));
  });
}

/*
 * The keys as the filter is to act on them: one set to Glasshouse Home's
 * guide is left to LG while Glasshouse Home is off or has no playlist, as it
 * would only open Home, and an Ambient light key is left alone when PicCap is
 * removed. The choice stays saved, and acts again once it is back (availabilityChanged).
 */
function inEffect(map) {
  var out = {}, on = null, piccap = null;
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (map[k] === HOME_GUIDE) {
      if (on === null) on = homeGuideOn();
      if (!on) continue;
    }
    if (map[k] === PICCAP_TOGGLE) {
      if (piccap === null) piccap = piccapOn();
      if (!piccap) continue;
    }
    out[k] = map[k];
  }
  return out;
}

// Glasshouse Home, its playlists, or PicCap came or went: keys set to them follow.
var lastHomeGuide = null;
var lastPiccap = null;
function availabilityChanged() {
  var on = homeGuideOn(), pOn = piccapOn();
  if (on === lastHomeGuide && pOn === lastPiccap) return;
  var firstGuide = lastHomeGuide === null && on !== lastHomeGuide;
  var guideChanged = on !== lastHomeGuide;
  lastHomeGuide = on;
  lastPiccap = pOn;
  var map = readMap(), setGuide = false, setPiccap = false;
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (map[k] === HOME_GUIDE) setGuide = true;
    if (map[k] === PICCAP_TOGGLE) setPiccap = true;
  }
  if ((!setGuide && !setPiccap) || !lunaFn) return;
  applyAny(function (ok) {
    if (guideChanged && !(firstGuide && on && ok)) {
      console.log('remotekeys: Guide ' + (on ? 'opens Glasshouse Home\'s guide' : 'left to LG while Glasshouse Home\'s guide is unavailable') + (ok ? '' : ' (not applied)'));
    }
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
    if (!Object.keys(map).length && !home && !starting && !inChain) return applyFilterTable(function () { cb(true); });
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
      // LG's list of streaming buttons follows; a failure there is logged, and does not undo the filter.
      var withTable = function (ok2) {
        applyFilterTable(function (okTable) {
          if (!okTable) console.log('remotekeys: LG\'s list of streaming buttons could not be set');
          cb(ok2);
        });
      };
      var done = function (ok2) {
        if (ok2) console.log('remotekeys: filter first in the chain');
        withTable(ok2);
      };
      if (!inChain) return writeChain(full, done);
      if (!changed) return withTable(true);
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
  var colorsAvailable = colorButtonsSupported();
  return KEYS.filter(function (k) {
    if (k.key === 'input') return guidePatch.status().supported;
    if (k.blockCode) return guidePatch.status().channel || (!!CHANNEL_EVDEV_CODES[k.key] && channelButtonsSupported());
    if (NATIVE_ACTIONS[k.key]) return !!(tv.actions && tv.actions[NATIVE_ACTIONS[k.key]]);
    if (NATIVE_SETTINGS[k.key]) return !!(tv.settings && tv.settings[NATIVE_SETTINGS[k.key]]);
    if (NATIVE_SERVICE_KEYS[k.key]) return !!(servicesModule && servicesModule.available(NATIVE_SERVICE_KEYS[k.key]));
    if (NATIVE_BLOCK_KEYS[k.key]) {
      var appId = NATIVE_BLOCK_KEYS[k.key];
      if (refusedBlocks[appId] && !lg.blocks[appId]) return false;
      return !!((tv.apps && tv.apps[appId]) || lg.blocks[appId]);
    }
    if (COLOR_CODES[k.key]) return colorsAvailable;
    if (k.nativeOnly || k.filterOnly) return false;
    var entry = lg.mapping[k.key] || mappingEntry(tv.list, k.key);
    return !!(entry && typeof entry === 'object' && entry.isActive !== false);
  });
}

// What a streaming button's entry becomes, from LG's own, or undefined for LG's.
function mappingWanted(map, key, lgEntry) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  if (!map[key] || isLoggedAction(map[key])) {
    var off = copyValue(lgEntry);
    off.isActive = false;
    return off;
  }
  return { launch_param: null, app_id: map[key], isActive: true };
}

/*
 * Where the JavaScript filter runs, a streaming button set here is answered by
 * the filter while the picture is on, and LG's own handler never sees it. With
 * the screen off the press goes to LG's wake path instead: about 200 ms after
 * it, as the screen wakes, sam logs a launch of the app LG's list names for the
 * button, from com.webos.platformstarfish with mode hotKey, whatever the filter
 * would have done (a C5, webOS 10.3.0, Nothing set for LG Channels). With that
 * entry switched off the same press only woke the TV. So the list is set to
 * match: an app or an input the key opens is launched from it, and any other
 * choice (Nothing, an action, a media key, one of Glasshouse's bars) switches
 * the entry off.
 */
function opensApp(id) {
  if (!id) return false;
  if (id.indexOf('action:') === 0 || id.indexOf(MEDIA_PREFIX) === 0) return false;
  return id !== INPUT_BAR && id !== HOME_BAR && id !== INPUT_SWITCHER;
}

function filterMappingWanted(map, key, lgEntry) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  if (opensApp(map[key])) return { launch_param: null, app_id: map[key], isActive: true };
  var off = copyValue(lgEntry);
  off.isActive = false;
  return off;
}

function actionWanted(map, key, lgValue) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  if (map[key] === HOME_GUIDE) {
    // Home with the guide asked for (lib/guidepatch), the inputs that take Guide for their own kept as LG has them.
    var open = { action: 'launch', id: HOME_APP };
    if (lgValue && lgValue.fgAppIdsForByPass) open.fgAppIdsForByPass = copyValue(lgValue.fgAppIdsForByPass);
    return open;
  }
  return map[key] && !isLoggedAction(map[key]) ? { action: 'launch', id: map[key] } : { action: 'ignore', accept: true };
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
function applyNative(cb, mapOverride, refresh) {
  applyQueue.push({ cb: cb, map: mapOverride, refresh: !!refresh });
  if (applyQueue.length === 1) applyNext();
}

function applyNext() {
  var job = applyQueue[0];
  if (!job) return;
  applyNativeNow(function (ok, wrote) {
    if (ok) {
      followColorButtons(job.map || readMap());
      followChannelButtons(job.map || readMap());
    }
    applyQueue.shift();
    applyNext();
    job.cb(ok, !!wrote);
  }, job.map, job.refresh);
}

/*
 * A Guide key set to Glasshouse Home's guide and an Input key set to an app,
 * an input or the input bar need LG's key handler changed first (lib/guidepatch), which
 * restarts the compositor once, and again when one is set back. Where it
 * cannot be, or Glasshouse Home has no guide, the Guide key is left to LG.
 */
function applyNativeNow(cb, mapOverride, refresh) {
  var map = mapOverride || readMap();
  var wantGuide = map.guide === HOME_GUIDE && homeGuideOn();
  var rest = {};
  Object.keys(map).forEach(function (k) { if (map[k] !== HOME_GUIDE) rest[k] = map[k]; });
  var st = guidePatch.status();
  if (!st.supported && !st.bar && !st.channel) return applyNativeMap(cb, rest, refresh);
  var want = { guide: st.supported && wantGuide, input: st.supported && guidePatch.validId(map.input) ? map.input : '',
    bar: st.bar && !mapOverride && homeBarLauncherFn(), blocked: st.channel ? blockedCodes(map) : [] };
  guidePatch.apply(want, function (r) {
    if (!r.ok) console.log('remotekeys: LG\'s key handler could not be changed: ' + r.error);
    if (r.restarted) compositorRestartedFn();
    if (r.ok && want.guide) rest.guide = HOME_GUIDE;
    applyNativeMap(cb, rest, refresh);
  });
}

/*
 * After a wake, LG's launch library can act on a list of its own rather than
 * the one the settings service holds: on a C6 (webOS 11, 43.11.77) a Netflix
 * button set to Nothing opened Netflix after some hours in standby, though
 * mapping_info still said Nothing, until the key was changed and changed back
 * (#1671). So the list is written twice: each button Glasshouse holds with its
 * launch_param changed, then as it should be, both changes the library is told
 * of. A button set to Nothing stays off in both. The list as first written, or
 * null where Glasshouse holds none of its buttons.
 */
function nudgedList(list, lg) {
  var held = false;
  var out = copyValue(list);
  (out || []).forEach(function (entry) {
    Object.keys(entry || {}).forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(lg.mappingWritten, name)) return;
      var e = entry[name];
      if (!e || typeof e !== 'object') return;
      e.launch_param = e.launch_param === null ? '' : null;
      held = true;
    });
  });
  return held ? out : null;
}

// The key codes LG's filter is to take: the channel keys set to anything, Nothing included.
function blockedCodes(map) {
  return KEYS.filter(function (k) { return k.blockCode && Object.prototype.hasOwnProperty.call(map, k.key); })
    .map(function (k) { return k.blockCode; });
}

function applyNativeMap(cb, map, refresh) {
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
        if (!def || def.nativeOnly || def.blockCode || COLOR_CODES[name] || NATIVE_ACTIONS[name] || NATIVE_SETTINGS[name]) return;
        var v = reconcile(name, entry[name], function (lgEntry) { return mappingWanted(map, name, lgEntry); },
          lg.mapping, lg.mappingWritten);
        if (v !== undefined) { entry[name] = v; listChanged = true; }
      });
    });
    if (listChanged) settings[MAPPING_KEY] = nextList;
    var nudged = refresh && !listChanged ? nudgedList(nextList, lg) : null;
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
      var v = reconcile(name, tv.actions[name], function (lgValue) { return actionWanted(map, key, lgValue); },
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
    if (nudged) {
      // Both writes are changes, so LG's launch library takes the list up again.
      var both = {};
      both[MAPPING_KEY] = nudged;
      return writeSettings(both, function (ok) {
        if (!ok) return cb(false, false);
        settings[MAPPING_KEY] = nextList;
        writeSettings(settings, function (ok2) {
          if (!ok2) return cb(false, true);
          refreshed = true;
          writeActions();
        });
      });
    }
    if (!Object.keys(settings).length) return writeActions();
    writeSettings(settings, function (ok) {
      if (!ok) return cb(false, wrote);
      writeActions();
    });
  });
}

/*
 * Sets LG's streaming button list to the keys set here, where the JavaScript
 * filter runs, and puts back what LG had for a key no longer set. LG's own
 * entries are kept in remotekeys-lg.json, and the list is followed (watchLg), as
 * on webOS 11. A TV with no such list has nothing to wake into an app, and is
 * left alone. mapOverride {} puts LG's all back. One runs at a time, as each
 * reads the list and writes it whole. cb(ok, wrote).
 */
var tableQueue = [];
function applyFilterTable(cb, mapOverride) {
  tableQueue.push({ cb: cb, map: mapOverride });
  if (tableQueue.length === 1) applyFilterTableNext();
}

function applyFilterTableNext() {
  var job = tableQueue[0];
  if (!job) return;
  applyFilterTableNow(function (ok, wrote) {
    tableQueue.shift();
    applyFilterTableNext();
    job.cb(ok, !!wrote);
  }, job.map);
}

function applyFilterTableNow(cb, mapOverride) {
  var map = mapOverride || readMap();
  var lg = readLg();
  if (!Object.keys(map).length && !Object.keys(lg.mapping).length) {
    watchLg(false);
    return cb(true, false);
  }
  readMapping(function (list) {
    if (!list) return cb(true, false);
    var nextList = copyValue(list);
    var changed = [];
    nextList.forEach(function (entry) {
      Object.keys(entry || {}).forEach(function (name) {
        var def = keyByName(name);
        if (!def || def.nativeOnly || def.blockCode || NATIVE_ACTIONS[name]) return;
        var v = reconcile(name, entry[name], function (lgEntry) { return filterMappingWanted(map, name, lgEntry); },
          lg.mapping, lg.mappingWritten);
        if (v !== undefined) { entry[name] = v; changed.push(name); }
      });
    });
    var finish = function (ok) {
      if (!ok) return cb(false, changed.length > 0);
      try {
        writeLg(lg);
      } catch (e) {
        console.log('remotekeys: could not write ' + lgFile() + ': ' + e.message);
        return cb(false, changed.length > 0);
      }
      watchLg(lgHolds(lg, ['mapping']));
      if (changed.length) console.log('remotekeys: LG\'s list of streaming buttons changed for ' + changed.join(', ') + ', which it opens an app from while the screen is off');
      cb(true, changed.length > 0);
    };
    if (!changed.length) return finish(true);
    var settings = {};
    settings[MAPPING_KEY] = nextList;
    writeSettings(settings, finish);
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
 * answered "already blocked", which is as good; one sam will not make
 * (refusedBlocks) is left, and not asked again. cb(ok, switched).
 */
function switchBlocks(map, lg, cb) {
  var todo = [];
  Object.keys(NATIVE_BLOCK_KEYS).forEach(function (key) {
    var id = NATIVE_BLOCK_KEYS[key];
    var wanted = Object.prototype.hasOwnProperty.call(map, key);
    if (wanted && !refusedBlocks[id]) todo.push({ id: id, block: true, was: !!lg.blocks[id] });
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
      var answer = String((r && r.errorText) || raw || '');
      var done = !!(r && r.returnValue) || /already\s*blocked/i.test(answer);
      if (!done && job.block && /exist in listLaunchPoint/i.test(answer)) {
        refusedBlocks[job.id] = true;
        console.log('remotekeys: the TV will not block ' + job.id + ' (it has a launch point), so its button stays as LG has it');
        return next(i + 1);
      }
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
/*
 * Keys that can turn the screen off on webOS 11, by lginput2's name for them
 * on an MR25GA (a C5, 11.2.0). There is no filter to run it in, so LG's action
 * is switched off as for Nothing, and the press is answered from the log.
 * Not Guide: on an HDMI input the input's app takes it and opens its own guide.
 */
var SCREEN_OFF_BUTTONS = { netflix: 'KEY_NETFLIX', amazon: 'KEY_AMAZON', homehub: 'KEY_HOMEDASHBOARD' };
var BUTTON_CLICK = /NL_BUTTON_CLICK\b.*"button_type"\s*:\s*"([A-Z0-9_]+)"/;
/*
 * The channel rocker. LG's first key filter takes the key while it is set, so
 * only what is chosen here happens, and the copy lib/guidepatch mounts logs
 * it as LSM NL_INPUT_KEYFILTER_USE, { glasshouse_key: code, ev }: 0 pressed,
 * 1 released, 2 repeated, the key repeating every 50 ms from half a second
 * held and every fourth repeat logged, one every 200 ms, as fast as the panel
 * was seen to follow (a C5, 11.2.0). lginput2 logs a press as
 * NL_NON_LIST_BUTTON_CLICK as well, but a held key only now and then, so its
 * line is not read. Each press is answered; set to a Brightness action, quick
 * presses each count and each repeat logged is a step; anything else is
 * answered once within half a second.
 */
var CHANNEL_BUTTONS = { channelup: 'KEY_CHANNELUP', channeldown: 'KEY_CHANNELDOWN' };
var CHANNEL_CODES = { 402: 'KEY_CHANNELUP', 403: 'KEY_CHANNELDOWN' };
var REPEATING_BUTTONS = { KEY_CHANNELUP: true, KEY_CHANNELDOWN: true };
var KEY_EVENT = /\bLSM NL_INPUT_KEYFILTER_USE\b.*"glasshouse_key"\s*:\s*(\d+)\s*,\s*"ev"\s*:\s*(\d+)/;
var KEY_PRESSED = 0;
var KEY_REPEATED = 2;
var PRESS_DEBOUNCE_MS = 500;
var POLL_MS = 200;
// One read at most this much, as the syslog forwarder's: a log that has grown
// a lot is skipped ahead rather than read whole.
var READ_CHUNK = 64 * 1024;
var pressTargets = {};
var following = false;
var logPoll = null;
var logStatPending = false;
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
  Object.keys(SCREEN_OFF_BUTTONS).forEach(function (key) {
    if (isLoggedAction(map[key])) targets[SCREEN_OFF_BUTTONS[key]] = map[key];
  });
  // Only while LG's filter takes the key, so a press is never answered twice.
  var blocked = guidePatch.status().applied.blocked;
  Object.keys(CHANNEL_BUTTONS).forEach(function (key) {
    if (map[key] && blocked.indexOf(keyByName(key).blockCode) !== -1) targets[CHANNEL_BUTTONS[key]] = map[key];
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
    // fs.watchFile takes its first sample asynchronously and can miss a press
    // logged before that sample. Our saved byte offset is the starting point.
    logPoll = setInterval(function () {
      if (logStatPending) return;
      logStatPending = true;
      var file = messagesPath;
      fs.stat(file, function (err, st) {
        logStatPending = false;
        if (!err && file === messagesPath) logChanged(st);
      });
    }, POLL_MS);
    if (logPoll.unref) logPoll.unref();
  } else if (!wanted && following) {
    following = false;
    clearInterval(logPoll);
    logPoll = null;
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
        if (m) return buttonPressed(m[1]);
        var k = KEY_EVENT.exec(line);
        if (k) keyEvent(Number(k[1]), Number(k[2]));
      });
    });
  });
}

// An event of a key LG's filter takes: a press as any button's, and a repeat
// of a key set to a Brightness action a step. The filter paces the repeats.
function keyEvent(code, ev) {
  var button = CHANNEL_CODES[code];
  if (!button) return;
  if (ev === KEY_PRESSED) return buttonPressed(button);
  if (ev !== KEY_REPEATED || !lunaFn || !Object.prototype.hasOwnProperty.call(pressTargets, button)) return;
  var id = pressTargets[button];
  if (Object.prototype.hasOwnProperty.call(BRIGHTNESS_DELTAS, id)) stepBrightness(BRIGHTNESS_DELTAS[id] * brightnessStep());
}

// lginput2 logs a press once; a second within half a second is the same one,
// but for a channel key stepping the brightness, where quick presses each count.
function buttonPressed(button) {
  if (!Object.prototype.hasOwnProperty.call(pressTargets, button)) return;
  var id = pressTargets[button];
  var repeats = REPEATING_BUTTONS[button] && Object.prototype.hasOwnProperty.call(BRIGHTNESS_DELTAS, id);
  var now = Date.now();
  if (!repeats && now >= (lastPress[button] || 0) && now - (lastPress[button] || 0) < PRESS_DEBOUNCE_MS) return;
  lastPress[button] = now;
  if (MUTE_TOASTS_MS[button]) muteToasts(muteToastsMs || MUTE_TOASTS_MS[button]);
  if (!id || !lunaFn) return;
  if (id === SCREEN_OFF) return screenOffFromPress(button);
  if (id === PICCAP_TOGGLE) return togglePiccapFromPress();
  if (Object.prototype.hasOwnProperty.call(BRIGHTNESS_DELTAS, id)) return stepBrightness(BRIGHTNESS_DELTAS[id] * brightnessStep());
  lunaFn('com.webos.applicationManager/launch', { id: id }, function (r) {
    if (!(r && r.returnValue)) console.log('remotekeys: ' + button + ' could not open ' + id);
  });
}

function togglePiccapFromPress() {
  if (piccapToggleBusy) return;
  piccapToggleBusy = true;
  function done(r) {
    piccapToggleBusy = false;
    if (!r || !r.ok) console.log('remotekeys: could not toggle PicCap' + (r && r.error ? ': ' + r.error : ''));
  }
  if (piccapToggleFn) return piccapToggleFn(done);
  lunaFn('org.webosbrew.piccap.service/status', {}, function (r) {
    if (!r || r.returnValue === false || typeof r.isRunning !== 'boolean') {
      return done({ ok: false, error: 'PicCap did not answer' });
    }
    lunaFn('org.webosbrew.piccap.service/' + (r.isRunning ? 'stop' : 'start'), {}, function (w) {
      done({ ok: !!(w && w.returnValue !== false) });
    });
  });
}

/*
 * One step of the current picture mode's brightness, read first since the
 * settings service keeps one value per mode and input (controls.js's
 * backlight). A channel key's presses and repeats can come faster than one is
 * read and written, so one runs at a time and those meanwhile are added up for the
 * next, never past the whole range.
 */
var brightnessBusy = false;
var brightnessPending = 0;
function stepBrightness(delta) {
  if (brightnessBusy) {
    brightnessPending = Math.max(-100, Math.min(100, brightnessPending + delta));
    return;
  }
  brightnessBusy = true;
  function next() {
    brightnessBusy = false;
    var more = brightnessPending;
    brightnessPending = 0;
    if (more) stepBrightness(more);
  }
  lunaFn('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['backlight'] }, function (r) {
    var current = r && r.settings ? parseFloat(r.settings.backlight) : NaN;
    if (isNaN(current)) { console.log('remotekeys: brightness not changed: the TV did not give its level'); return next(); }
    var level = Math.max(0, Math.min(100, Math.round(current) + delta));
    if (level === Math.round(current)) return next();
    lunaFn('com.webos.service.settings/setSystemSettings', { category: 'picture', settings: { backlight: String(level) } }, function (w) {
      if (!(w && w.returnValue)) console.log('remotekeys: brightness could not be set to ' + level);
      next();
    });
  });
}

/*
 * Only with the picture on: a press while it is off wakes it, and is left to.
 * A press while tvpower is still finishing a change, as just after a wake, or
 * while LG's screen saver is up, which the press ends, is tried again for
 * about 4 s: at 1.6 s about 1 press in 10 was still lost on a C5 (webOS
 * 11.2.0, #1143). Each press left alone is logged, to tell the rest apart.
 * Turning the screen off is a power change, at which LG writes its streaming
 * buttons back, so a quick second press opened LG's app, or its installer,
 * before the key was set again (#1143). For a while after, LG's writes are
 * answered at once, and the keys are set again unasked, as not every write is
 * announced.
 *
 * lginput2 logs the press as the button goes down, so on a press held a little
 * longer the screen goes off before the button is up, and the release brings
 * the picture back: on a C5 (webOS 11.2.0) 2 presses in 6 woke it 21 and 92 ms
 * after it went off, a black blink (#1143). Half a second after, a screen back
 * on with no new press of the button is turned off once more.
 */
var SCREEN_OFF_TRIES = 10;
var SCREEN_OFF_CHECK_MS = 500;
var SCREEN_OFF_RETRY_MS = 400;
var FAST_REAPPLY_MS = 100;
var FAST_REAPPLY_WINDOW_MS = 15000;
var SCREEN_OFF_REAPPLY_MS = [300, 1500];
var screenOffAt = 0;

// again: the second try after a release woke the screen, which is not checked for once more.
function screenOffFromPress(button, tries, again) {
  tries = tries || 1;
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var state = pw && pw.state;
    if (state === 'Active' && !pw.processing) return screenOff(button, again);
    if (state !== 'Active' && state !== 'Screen Saver') {
      return again ? undefined : console.log('remotekeys: ' + button + ' left alone: the TV is ' + (state || 'not answering'));
    }
    if (tries < SCREEN_OFF_TRIES) return setTimeout(function () { screenOffFromPress(button, tries + 1, again); }, SCREEN_OFF_RETRY_MS);
    console.log('remotekeys: ' + button + ' left alone: the TV was still ' + (pw.processing ? 'busy with ' + pw.processing : state) + ' after ' + tries + ' tries');
  });
}

function screenOff(button, again) {
  lunaFn('com.webos.service.tvpower/power/turnOffScreen', {}, function (r) {
    if (!(r && r.returnValue)) return console.log('remotekeys: ' + button + ' could not turn the screen off');
    screenOffAt = Date.now();
    SCREEN_OFF_REAPPLY_MS.forEach(function (ms) {
      setTimeout(function () { applyNative(function () {}); }, ms);
    });
    if (again) return;
    var pressedAt = lastPress[button];
    setTimeout(function () {
      if (lastPress[button] !== pressedAt) return;
      lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
        if (!pw || pw.state !== 'Active') return;
        console.log('remotekeys: ' + button + ' woke the screen as it was let go; turned off again');
        // Through the press's retries, as tvpower can still be finishing the wake.
        screenOffFromPress(button, 1, true);
      });
    }, SCREEN_OFF_CHECK_MS);
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
  var fast = Date.now() - screenOffAt < FAST_REAPPLY_WINDOW_MS;
  reapplyTimer = setTimeout(function () {
    reapplyTimer = null;
    var now = Date.now();
    reapplied = reapplied.filter(function (t) { return t <= now && now - t < REAPPLY_WINDOW_MS; });
    if (reapplied.length >= REAPPLY_LIMIT) return;
    (keysOnTv() ? applyFilterTable : applyNative)(function (ok, wrote) {
      if (!wrote) return;
      reapplied.push(Date.now());
      console.log('remotekeys: LG put its keys back; set again' + (ok ? '' : ', and the TV did not take it'));
    });
  }, fast ? Math.min(FAST_REAPPLY_MS, reapplyDelayMs) : reapplyDelayMs);
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
    ok: msg('srv.remoteKeys.ok', 'OK'),
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

// Power, screen off and brightness where the JavaScript filter runs, and Home Assistant with MQTT on too.
function actionChoices() {
  var out = [
    { id: SCREEN_OFF, title: msg('srv.remoteKeys.screenOff', 'Screen off'), kind: 'action' },
    { id: POWER_OFF, title: msg('srv.remoteKeys.powerOff', 'Power off'), kind: 'action' },
    { id: BRIGHTNESS_UP, title: msg('srv.remoteKeys.brightnessUp', 'Brightness up'), kind: 'action' },
    { id: BRIGHTNESS_DOWN, title: msg('srv.remoteKeys.brightnessDown', 'Brightness down'), kind: 'action' }
  ];
  if (piccapOn()) out.push({ id: PICCAP_TOGGLE, title: msg('srv.remoteKeys.piccap', 'Ambient light'), kind: 'action' });
  if (homeAssistantOn()) out.push({ id: HOME_ASSISTANT, title: msg('srv.remoteKeys.homeAssistant', 'Home Assistant'), kind: 'ha' });
  if (homeGuideOn()) out.push({ id: HOME_GUIDE, title: msg('srv.remoteKeys.homeGuide', 'Glasshouse Home\'s guide'), kind: 'action' });
  return out;
}

// webOS 11's actions, for the keys in SCREEN_OFF_BUTTONS.
function loggedActionChoices() {
  var out = [
    { id: SCREEN_OFF, title: msg('srv.remoteKeys.screenOff', 'Screen off'), kind: 'action' },
    { id: BRIGHTNESS_UP, title: msg('srv.remoteKeys.brightnessUp', 'Brightness up'), kind: 'action' },
    { id: BRIGHTNESS_DOWN, title: msg('srv.remoteKeys.brightnessDown', 'Brightness down'), kind: 'action' }
  ];
  if (piccapOn()) out.push({ id: PICCAP_TOGGLE, title: msg('srv.remoteKeys.piccap', 'Ambient light'), kind: 'action' });
  return out;
}

// Whether a key's presses reach Home Assistant, so it can be set to send them there.
function reported(key) {
  return reportedButtons().indexOf(key) !== -1;
}

// Home as a choice, where the JavaScript filter opens it as the Home key would.
function homeChoices(native) {
  return native ? [] : [{ id: HOME_APP, title: msg('srv.remoteKeys.home', 'Home'), kind: 'app' }];
}

/*
 * The input bar as a choice, where this TV is offered it. Its app has no
 * tile, so it is not among appChoices; choosing it installs the app, and the
 * last key leaving it removes it. Only the JavaScript filter can hand it the
 * further presses, so webOS 11's native keys never offer it.
 */
function barChoices(native) {
  var out = [];
  if (!native && !!barAppFn && barAllowedFn()) out.push({ id: INPUT_BAR, title: msg('srv.remoteKeys.inputBar', 'Input bar'), kind: 'app' });
  // Opened as the Home key opens it when it is the launcher, with a press number.
  if (!native && !!homeBarAppFn && homeBarAllowedFn()) out.push({ id: HOME_BAR, title: msg('srv.remoteKeys.homeBar', 'Glasshouse Bar'), kind: 'app' });
  return out;
}

// The bar's app, removed once no key opens the bar. Its answer is not waited
// for: the key is already set, and an app left behind does nothing.
function dropBarIfUnused(hadBar) {
  if (!hadBar || opensInputBar() || !barAppFn) return;
  barAppFn('remove', function (r) {
    if (!r || !r.ok) console.log('remotekeys: could not remove the input bar app: ' + ((r && r.error) || 'no answer'));
  });
}

// Glasshouse Bar's app, removed once no key opens it, unless it is the launcher.
function dropHomeBarIfUnused(hadBar) {
  if (!hadBar || opensHomeBar() || !homeBarAppFn || homeBarLauncherFn()) return;
  homeBarAppFn('remove', function (r) {
    if (!r || !r.ok) console.log('remotekeys: could not remove Glasshouse Bar\'s app: ' + ((r && r.error) || 'no answer'));
  });
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

function isSupported(cb) {
  if (!lunaFn) return cb(false);
  offeredKeys(function (keys) { cb(!!(keys && keys.length)); });
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

// webOS 11 has no configurable native action for the color keys. Observe the
// physical press without taking the key away from LG or the foreground app.
function followColorButtons(map) {
  colorTargets = {};
  if (nativeFilters === true && colorButtonsSupported()) {
    Object.keys(COLOR_CODES).forEach(function (key) {
      if (typeof map[key] === 'string' && map[key] && map[key].indexOf(':') === -1) colorTargets[key] = map[key];
    });
  }
  watchColorButtons(Object.keys(colorTargets).length > 0);
}

function startColorButtons() {
  if (!lunaFn || keysOnTv()) return;
  hasNativeFilters(function (yes) { if (yes) followColorButtons(readMap()); });
}

function handleColorButton(key, code) {
  var id = colorTargets[key];
  // inputcommon repeats the same press later with a Qt code. Launch only for
  // evdev's physical code, so a delayed copy cannot select a previous input.
  if (!id || !COLOR_CODES[key] || code !== COLOR_CODES[key] || !colorLaunch) return;
  colorLaunch('com.webos.applicationManager/launch', { id: id }, function (r) {
    if (!r || !r.returnValue) console.log('remotekeys: color key ' + key + ' could not open ' + id);
  });
}

// Where lib/guidepatch has no build for this library, the channel keys are
// observed rather than taken from LG, the same way as the color keys above:
// lib/remotebuttons' own evdev reader, no native library, LG assignment or
// filter chain touched.
function followChannelButtons(map) {
  channelTargets = {};
  if (nativeFilters === true && !guidePatch.status().channel && channelButtonsSupported()) {
    Object.keys(CHANNEL_EVDEV_CODES).forEach(function (key) {
      if (typeof map[key] === 'string' && map[key] && map[key].indexOf(':') === -1) channelTargets[key] = map[key];
    });
  }
  watchChannelButtons(Object.keys(channelTargets).length > 0);
}

function startChannelButtons() {
  if (!lunaFn || keysOnTv()) return;
  hasNativeFilters(function (yes) { if (yes) followChannelButtons(readMap()); });
}

function handleChannelButton(key, code) {
  var id = channelTargets[key];
  // inputcommon repeats the same press later with a Qt code, where one is
  // known. Launch only for evdev's physical code, so a delayed copy cannot
  // select a previous input.
  if (!id || !CHANNEL_EVDEV_CODES[key] || code !== CHANNEL_EVDEV_CODES[key] || !channelLaunch) return;
  channelLaunch('com.webos.applicationManager/launch', { id: id }, function (r) {
    if (!r || !r.returnValue) console.log('remotekeys: ' + key + ' could not open ' + id);
  });
}

// webOS 11's Guide key opens Glasshouse Home's guide, and its Input key the input bar, where lib/guidepatch knows the key handler.
function nativeChoices(def, native) {
  if (!native || !guidePatch.status().supported) return [];
  if (def.key === 'guide' && homeGuideOn()) {
    return [{ id: HOME_GUIDE, title: msg('srv.remoteKeys.homeGuide', 'Glasshouse Home\'s guide'), kind: 'guide' }];
  }
  if (def.key === 'input') return [{ id: INPUT_BAR, title: msg('srv.remoteKeys.inputBar', 'Input bar'), kind: 'inputbar' }];
  return [];
}

// cb({ auto, detected }); empty where nothing says which remotes are in use, or the lookup fails.
function withDetectedRemotes(cb) {
  var none = { auto: [], detected: [] };
  if (!detectRemotesFn) return cb(none);
  var answered = false;
  try {
    detectRemotesFn(function (found) {
      if (answered) return;
      answered = true;
      cb(found && Array.isArray(found.auto) ? { auto: found.auto, detected: found.detected || [] } : none);
    });
  } catch (e) {
    if (!answered) { answered = true; cb(none); }
  }
}

function describeKeys(keys, inChain, cb, native) {
  switcherChoices(function (switchers) {
    listApps(function (apps) {
      var map = readMap();
      var guide = nativeChoices({ key: 'guide' }, native).concat(nativeChoices({ key: 'input' }, native));
      var titles = {};
      (apps || []).forEach(function (a) { if (a && a.id) titles[a.id] = a.title || a.id; });
      var inputs = inputChoices();
      var media = native ? loggedActionChoices() : actionChoices().concat(mediaChoices());
      var cc = country();
      titles[HOME_ASSISTANT] = msg('srv.remoteKeys.homeAssistant', 'Home Assistant');
      titles[HOME_GUIDE] = msg('srv.remoteKeys.homeGuide', 'Glasshouse Home\'s guide');
      titles[INPUT_BAR] = msg('srv.remoteKeys.inputBar', 'Input bar');
      titles[PICCAP_TOGGLE] = msg('srv.remoteKeys.piccap', 'Ambient light');
      switchers.concat(inputs, actionChoices(), loggedActionChoices(), mediaChoices(), homeChoices(false), barChoices(false)).forEach(function (c) { titles[c.id] = c.title; });
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
        if (k.noNothing && native) key.noNothing = true;
        if (k.turnsOffVoice) key.turnsOffVoice = true;
        if (k.replacesVoice) key.replacesVoice = true;
        if (native && COLOR_CODES[k.key]) { key.observedColor = true; key.noNothing = true; }
        if (native && NATIVE_BLOCK_KEYS[k.key]) key.blocksApp = true;
        var channelNative = k.blockCode && guidePatch.status().channel;
        if (native && !SCREEN_OFF_BUTTONS[k.key] && (!k.blockCode || !channelNative)) key.noScreenOff = true;
        if (native && k.blockCode) {
          if (channelNative) key.channelNative = true;
          else if (CHANNEL_EVDEV_CODES[k.key]) { key.observedChannel = true; key.noNothing = true; }
        }
        if (nativeChoices(k, native).length) key[k.key === 'guide' ? 'homeGuide' : 'nativeInput'] = true;
        // The Input key's launch holds an id of so many characters, and cannot do nothing or send a media key.
        if (key.nativeInput) { key.noNothing = true; key.maxIdLength = guidePatch.MAX_ID; }
        if (!native && homeAssistantOn() && reported(k.key)) key.homeAssistant = true;
        return key;
      });
      withDetectedRemotes(function (found) {
        var choice = readRemoteSelection();
        var keyNames = out.map(function (k) { return k.key; });
        var autoOff = remotes.keysOffRemotes(found.auto, keyNames);
        // The remotes in use; all buttons is no remote, which folds nothing.
        var selected = choice.mode === 'all' ? [] : found.auto;
        // Keys on none of the remotes in use, only where every one is known: left off the page
        // entirely while folding (mode 'auto'), or shown apart under Buttons on other remotes
        // while it is off (mode 'all'), so a button a different remote might have stays reachable.
        out.forEach(function (k) { if (autoOff.indexOf(k.key) !== -1) k.offRemote = true; });
        // A key under the name the remote prints on it (the MR25GA's AI button is the microphone key), unless
        // another key already has that name (webOS 11 offers AI as a key of its own).
        var taken = out.map(function (k) { return k.title; });
        out.forEach(function (k) {
          var label = remotes.labelFor(selected, k.key);
          if (label && label !== k.title && taken.indexOf(label) === -1) k.title = label;
        });
        cb({
          ok: true, supported: true, keys: out, brightnessStep: brightnessStep(), brightnessBarStyle: brightnessBarStyle(),
          // Where the JavaScript filter runs and the bar's app can be put on the TV, which the level bar needs.
          brightnessBar: !native && barAvailable(),
          choices: switchers.concat(media, guide, inputs, homeChoices(native), barChoices(native), appChoices(apps)),
          inChain: inChain,
          remotes: {
            mode: choice.mode,
            canFold: autoOff.length > 0,
            folding: choice.mode !== 'all' && autoOff.length > 0,
            // Why nothing is folded where it is not (for the page to say): 'none' no remote is known to be in use,
            // 'unknown' one is not in the catalogue, 'unfinished' one's list of buttons is not finished.
            why: autoOff.length > 0 || choice.mode === 'all' ? '' : !selected.length ? 'none'
              : selected.some(function (r) { return !r; }) ? 'unknown'
              : selected.some(function (r) { return r.complete !== true; }) ? 'unfinished' : '',
            selected: selected.filter(Boolean).map(function (r) {
              return { id: r.id, title: r.title, image: remotes.imageFile(r), numberKeys: typeof r.numberKeys === 'boolean' ? r.numberKeys : null };
            }),
            unknown: selected.filter(function (r) { return !r; }).length,
            // What is in use, for the page to show beside the switch.
            detected: found.detected.map(function (d) {
              return { name: d.name, id: d.id, title: d.title, image: d.image, current: !!d.current };
            })
          }
        });
      });
    });
  });
}

/*
 * Sets a key: action 'lg' puts it back as LG has it, 'nothing' makes it do
 * nothing, 'open' opens id, an input, an app on the Home screen or LG's input
 * switcher, or sends a media control or turns the TV or screen off where the
 * JavaScript filter runs. It takes
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
  var hadBar = needsBarApp(map[def.key]), hadHomeBar = map[def.key] === HOME_BAR;
  function saved(r) {
    if (r && r.ok) { dropBarIfUnused(hadBar); dropHomeBarIfUnused(hadHomeBar); }
    cb(r);
  }
  if (action === 'lg') {
    delete map[def.key];
    return save(map, saved);
  }
  var nativeInput = kind !== 'filter' && def.key === 'input';
  // Observed rather than native-blocked (CHANNEL_EVDEV_CODES, kind 'native'): only open an app or input,
  // the same way as the color keys (#1718).
  var channelObservedOnly = kind === 'native' && def.blockCode && !!CHANNEL_EVDEV_CODES[def.key] && !guidePatch.status().channel;
  if (action === 'nothing') {
    if ((def.noNothing && kind !== 'filter') || nativeInput || (kind === 'native' && COLOR_CODES[def.key]) || channelObservedOnly) {
      return cb({ ok: false, error: msg('srv.remoteKeys.noNothing', 'This key cannot be set to do nothing') });
    }
    map[def.key] = '';
    return save(map, saved);
  }
  if (action !== 'open' || !id) return cb({ ok: false, error: 'lg, nothing or open expected' });
  switcherChoices(function (switchers) {
    listApps(function (apps) {
      if (!apps) return cb({ ok: false, error: msg('srv.remoteKeys.noApps', 'Could not read the TV\'s apps. Try again in a moment.') });
      var media = kind === 'filter' ? actionChoices().concat(mediaChoices()) : (SCREEN_OFF_BUTTONS[def.key] || (def.blockCode && !channelObservedOnly)) ? loggedActionChoices() : [];
      // On webOS 11 the Input key opens an app, an input or the input bar, by an id its launch can hold.
      var nativeInputOk = nativeInput && guidePatch.validId(id) &&
        inputChoices().concat(appChoices(apps), nativeChoices(def, true)).some(function (c) { return c.id === id; });
      if (nativeInput && !nativeInputOk) {
        return cb({ ok: false, error: msg('srv.remoteKeys.inputOnlyApps', 'On this TV the Input key can open an app, an input or the input bar') });
      }
      var allowed = switchers.concat(media, nativeChoices(def, kind !== 'filter'), inputChoices(), homeChoices(kind !== 'filter'), barChoices(kind !== 'filter'), appChoices(apps))
        .some(function (c) { return c.id === id; });
      if (id === HOME_ASSISTANT && !reported(def.key)) {
        return cb({ ok: false, error: msg('srv.remoteKeys.notReported', 'Home Assistant does not receive this key\'s presses') });
      }
      if (!allowed) return cb({ ok: false, error: msg('srv.remoteKeys.unknownApp', 'That app is not on this TV') });
      // The bar's app also shows the level a Brightness key has set, where the filter can open it.
      var wantsBar = id === INPUT_BAR || (isBrightnessAction(id) && kind === 'filter' && barAvailable() && levelBarShown());
      function store() {
        map[def.key] = id;
        save(map, function (r) {
          if (r && r.ok && wantsBar && keySetFn) keySetFn();
          if (r && r.ok && id === HOME_BAR && homeBarKeySetFn) homeBarKeySetFn();
          if (wantsBar) { if (r && r.ok) dropHomeBarIfUnused(hadHomeBar); return cb(r); }
          if (id === HOME_BAR) { if (r && r.ok) dropBarIfUnused(hadBar); return cb(r); }
          saved(r);
        });
      }
      // A bar's app goes on first, so a key is never set to an app that is not there.
      if (wantsBar) {
        return barAppFn('install', function (r) {
          if (!r || !r.ok) return cb({ ok: false, error: msg('srv.remoteKeys.inputBarInstall', 'The input bar could not be put on the TV. Try again in a moment.') });
          store();
        });
      }
      if (id === HOME_BAR && !homeBarLauncherFn()) {
        return homeBarAppFn('install', function (r) {
          if (!r || !r.ok) return cb({ ok: false, error: msg('srv.remoteKeys.homeBarInstall', 'Glasshouse Bar could not be put on the TV. Try again in a moment.') });
          store();
        });
      }
      store();
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
 * The points one press of a Brightness key moves, a whole number from 1 to
 * BRIGHTNESS_MAX_STEP. Kept with the keys and sent to the filter with them.
 * cb({ ok, error }).
 */
function setBrightnessStep(value, cb) {
  var step = Number(value);
  if (!(step >= 1 && step <= BRIGHTNESS_MAX_STEP && Math.floor(step) === step)) {
    return cb({ ok: false, error: msg('srv.remoteKeys.badStep', 'The step must be a whole number from 1 to {max}', { max: BRIGHTNESS_MAX_STEP }) });
  }
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  try {
    // The default is kept as nothing set, so a TV with no key set holds no file.
    writeMap(readMap(), readHome(), readStarting(), step === BRIGHTNESS_DEFAULT_STEP ? 0 : step);
  } catch (e) {
    return cb({ ok: false, error: msg('srv.remoteKeys.saveFailed', 'Could not save the change: {error}', { error: e.message }) });
  }
  applyAny(function (ok) { cb(ok ? { ok: true } : { ok: false, error: msg('srv.remoteKeys.chainFailed', 'The TV did not take the change') }); });
}

// Whether a key is set to a Brightness action.
function brightnessKeySet() {
  var map = readMap();
  return Object.keys(map).some(function (k) { return isBrightnessAction(map[k]); });
}

/*
 * The level bar's look, from the Remote tab. cb({ ok, error }). 'none' takes
 * the bar's app off the TV where no other key needs it; a style that shows a
 * bar again puts it back first, so a Brightness key is never left to open an
 * app that is not there.
 */
function setBrightnessBarStyle(value, cb) {
  if (!levelBar.isStyle(value)) {
    return cb({ ok: false, error: msg('srv.remoteKeys.badBarStyle', 'The level bar style must be lg, horizontal, vertical or none') });
  }
  if (!lunaFn) return cb({ ok: false, error: 'no luna wrapper' });
  var wasShown = levelBarShown();
  var willShow = value !== 'none';
  function save() {
    try {
      writeMap(readMap(), readHome(), readStarting(), undefined, value === 'lg' ? '' : value);
    } catch (e) {
      return cb({ ok: false, error: msg('srv.remoteKeys.saveFailed', 'Could not save the change: {error}', { error: e.message }) });
    }
    applyAny(function (ok) {
      if (ok && wasShown && !willShow) dropBarIfUnused(true);
      if (ok && !wasShown && willShow && keySetFn && barAvailable() && brightnessKeySet()) keySetFn();
      cb(ok ? { ok: true } : { ok: false, error: msg('srv.remoteKeys.chainFailed', 'The TV did not take the change') });
    });
  }
  if (!wasShown && willShow && barAppFn && barAvailable() && brightnessKeySet()) {
    return barAppFn('install', function (r) {
      if (!r || !r.ok) return cb({ ok: false, error: msg('srv.remoteKeys.inputBarInstall', 'The input bar could not be put on the TV. Try again in a moment.') });
      save();
    });
  }
  save();
}

/*
 * The app the Home key opens, for Glasshouse Home, or '' to give Home back to
 * LG's filters. cb({ ok, error }).
 */
/*
 * Which remotes the tab is for: mode 'auto' or 'all'. Only the tab's own
 * choice changes: nothing is written to the TV. cb({ ok, error }).
 */
function setRemoteSelection(mode, cb) {
  var selection;
  if (mode === 'all') {
    selection = { mode: 'all' };
  } else if (mode === 'auto') {
    selection = { mode: 'auto' };
  } else {
    return cb({ ok: false, error: msg('srv.remoteKeys.badRemotes', 'Choose whether to show every button') });
  }
  try {
    writeMap(readMap(), readHome(), readStarting(), undefined, undefined, selection);
  } catch (e) {
    return cb({ ok: false, error: msg('srv.remoteKeys.saveFailed', 'Could not save the change: {error}', { error: e.message }) });
  }
  cb({ ok: true });
}

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
  moveLegacyHome();
  if (keysOnTv()) return apply(cb);
  hasNativeFilters(function (yes) {
    if (!yes) return cb(false);
    applyNative(cb);
  });
}

// Keys an earlier build set to its separate Home app, set to LG's Home instead.
function moveLegacyHome() {
  var map = readMap(), moved = [];
  Object.keys(map).forEach(function (k) {
    if (map[k] === LEGACY_HOME_APP) { map[k] = HOME_APP; moved.push(k); }
  });
  if (!moved.length) return;
  try {
    writeMap(map, readHome(), readStarting());
    console.log('remotekeys: ' + moved.join(', ') + ' set to Home, from the Glasshouse Home app earlier builds installed');
  } catch (e) {
    console.error('remotekeys: could not move ' + moved.join(', ') + ' to Home: ' + e.message);
  }
}

/*
 * LG writes its list back as the TV goes into standby and as it comes back
 * on, and not every write reaches a subscriber: around one switch off and on
 * of a C5 (11.2.0) it wrote nine times, five of them unannounced, the last a
 * minute after the TV came on. So each change of power state is followed by
 * checks at once and from a few seconds to ten minutes after it, beside the
 * subscription.
 */
var POWER_RECHECKS_MS = [0, 3000, 15000, 60000, 180000, 600000];
var powerRechecksMs = POWER_RECHECKS_MS;
var powerTimers = [];
var lastPowerState = null;
// Set when a write after a wake has gone through, for its one log line.
var refreshed = false;

/*
 * state: the TV's power state now. Coming back on from standby, each check
 * writes the streaming buttons again even where they read as they should
 * (nudgedList).
 */
function powerChanged(state) {
  var woke = state === 'Active' && !!lastPowerState && lastPowerState !== 'Active' && lastPowerState !== 'Screen Saver';
  if (state) lastPowerState = state;
  powerTimers.forEach(function (t) { clearTimeout(t); });
  var logged = false;
  powerTimers = powerRechecksMs.map(function (ms) {
    return setTimeout(function () {
      refreshed = false;
      recheckNative(function (ok, wrote) {
        if (refreshed && !logged) {
          logged = true;
          console.log('remotekeys: streaming buttons written again after the wake' + (ok ? '' : ', and the TV did not take it'));
        } else if (wrote && !refreshed) {
          console.log('remotekeys: LG put its keys back at a power change; set again' + (ok ? '' : ', and the TV did not take it'));
        }
      }, woke);
    }, ms);
  });
}

/*
 * Every half hour: LG's server can send the streaming buttons' list again,
 * which puts back LG's apps. Reads only, unless a key set here has been changed
 * back. cb(ok).
 */
var RECHECK_MS = 30 * 60 * 1000;
function recheckNative(cb, refresh) {
  cb = cb || function () {};
  if (!lunaFn) return cb(false);
  if (keysOnTv()) return applyFilterTable(cb);
  hasNativeFilters(function (yes) {
    if (!yes) return cb(false);
    applyNative(cb, undefined, refresh);
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
function restore(done) {
  if (lunaFn && !keysOnTv() && nativeFilters === null) {
    return hasNativeFilters(function (yes) { restoreKeys(done, yes); });
  }
  restoreKeys(done, nativeFilters === true);
}

function restoreKeys(done, native) {
  // The input bar's app goes with the keys that opened it, where it is on the
  // TV. Best effort: an app left behind has no tile and nothing opens it.
  var barThere = opensInputBar() || fs.existsSync(INPUT_BAR_DIR);
  // Glasshouse Bar's app stays while it is the launcher: lib/homebar removes it then.
  var homeBarGoes = opensHomeBar() && !homeBarLauncherFn();
  function cb(ok) {
    if (ok) {
      followColorButtons({});
      followChannelButtons({});
    }
    if (!lunaFn || (!barThere && !homeBarGoes)) return done(ok);
    var left = (barThere ? 1 : 0) + (homeBarGoes ? 1 : 0);
    var one = function () { if (--left === 0) done(ok); };
    if (barThere) lunaFn('com.webos.appInstallService/dev/remove', { id: INPUT_BAR }, one);
    if (homeBarGoes) lunaFn('com.webos.appInstallService/dev/remove', { id: HOME_BAR }, one);
  }
  if (native || fs.existsSync(lgFile()) || guidePatch.holdsKeys()) {
    if (!lunaFn) return cb(false);
    return (keysOnTv() ? applyFilterTable : applyNative)(function (ok) {
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

/*
 * Every key set to the input bar back to LG's, and its app removed: the
 * experimental switch turned off (lib/inputbar.js). cb(ok).
 */
function dropInputBar(cb) {
  var map = readMap();
  var keys = Object.keys(map).filter(function (k) { return map[k] === INPUT_BAR; });
  if (!keys.length) {
    if (barAppFn) return barAppFn('remove', function () { cb(true); });
    return cb(true);
  }
  keys.forEach(function (k) { delete map[k]; });
  save(map, function (r) {
    dropBarIfUnused(true);
    cb(!!(r && r.ok));
  });
}

// Whether a key is set to open the input bar, which lib/inputbar.js keeps loaded.
// Whether a key needs the bar's app: it opens the bar, or shows a Brightness key's level.
function opensInputBar() {
  var map = readMap();
  return Object.keys(map).some(function (k) { return needsBarApp(map[k]); });
}

// Whether a key is set to open Glasshouse Bar, which lib/homebar.js keeps loaded.
function opensHomeBar() {
  var map = readMap();
  return Object.keys(map).some(function (k) { return map[k] === HOME_BAR; });
}

module.exports = {
  init: init,
  opensInputBar: opensInputBar,
  nativeInputBar: function () { return guidePatch.status().supported; },
  // Glasshouse Bar through the Home key of webOS 11, where the library is one lib/guidepatch lists.
  nativeHomeBar: function () { return guidePatch.status().bar; },
  nativeHomeBarOn: function () { return guidePatch.status().applied.bar; },
  opensHomeBar: opensHomeBar,
  dropInputBar: dropInputBar,
  availabilityChanged: availabilityChanged,
  getRemoteKeys: getRemoteKeys,
  keyTitles: keyTitles,
  startColorButtons: startColorButtons,
  handleColorButton: handleColorButton,
  startChannelButtons: startChannelButtons,
  handleChannelButton: handleChannelButton,
  isSupported: isSupported,
  setRemoteKey: setRemoteKey,
  setHome: setHome,
  setBrightnessStep: setBrightnessStep,
  setBrightnessBarStyle: setBrightnessBarStyle,
  getBrightness: levelBar.getBrightness,
  setRemoteSelection: setRemoteSelection,
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
  readKeyTable: readKeyTable,
  qtName: qtName,
  // For docs/development/remote-keys.md and its test.
  NATIVE_ACTIONS: NATIVE_ACTIONS,
  NATIVE_SETTINGS: NATIVE_SETTINGS,
  NATIVE_SERVICE_KEYS: NATIVE_SERVICE_KEYS,
  NATIVE_BLOCK_KEYS: NATIVE_BLOCK_KEYS,
  COLOR_CODES: COLOR_CODES,
  CHANNEL_EVDEV_CODES: CHANNEL_EVDEV_CODES,
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
