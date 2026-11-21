/*
 * lib/levelbar.js - what the level bar of a Brightness key shows, and where it gets it
 *
 * A Brightness key (lib/remotekeys.js) opens the input bar's app
 * (assets/inputbar-app) with the level it has set, and the app's page asks the
 * server for the panel's level every 120 ms while the key is held. This module
 * answers those asks and holds what the bar's two styles need.
 *
 * The level: each luna call is a fork and exec of luna-send, so the answer
 * comes from a subscription to the settings service's backlight, one
 * long-lived luna-send started by the first ask and stopped idleMs after the
 * last. Until the subscription has answered, or after it has closed, the ask
 * is made of the settings service itself.
 *
 * The style, 'lg' (a vertical bar at the right edge, laid out like the TV's
 * own volume bar), 'horizontal' (a pill low on the screen), 'vertical' (the same
 * pill upright at the right edge) or 'none' (no bar: the keys change the
 * brightness and show nothing), is read through the function remotekeys.js
 * gives, at most every STYLE_CACHE_MS.
 *
 * It also gives the part of the key filter that opens the bar, which the
 * filter's own source (remotekeys.js's filterSource) places in itself.
 *
 * Strict ES5: runs on node 0.12.
 */
var STYLES = ['lg', 'horizontal', 'vertical', 'none'];
var BACKLIGHT_IDLE_MS = 30000;
var STYLE_CACHE_MS = 2000;

var lunaFn = null;
var SubscriptionCtor = null; // luna.Subscription
var readStyleFn = function () { return 'lg'; };
var idleMs = BACKLIGHT_IDLE_MS;

var sub = null;
var level = -1;              // -1: not known
var idleTimer = null;
var styleCache = { value: 'lg', at: 0 };

/*
 * opts.luna: the function that calls a luna service, opts.subscription:
 * luna.Subscription, opts.readStyle: () => 'lg' | 'horizontal' | 'vertical' | 'none' as kept,
 * opts.idleMs: how long the subscription stays after the last ask.
 */
function init(opts) {
  opts = opts || {};
  stop();
  lunaFn = opts.luna || null;
  SubscriptionCtor = opts.subscription || null;
  readStyleFn = typeof opts.readStyle === 'function' ? opts.readStyle : function () { return 'lg'; };
  idleMs = typeof opts.idleMs === 'number' ? opts.idleMs : BACKLIGHT_IDLE_MS;
  styleCache.at = 0;
}

function isStyle(value) {
  return STYLES.indexOf(value) !== -1;
}

// The style changed: the next ask reads it again.
function forgetStyle() {
  styleCache.at = 0;
}

function styleForAsk() {
  var now = Date.now();
  if (now - styleCache.at > STYLE_CACHE_MS || now < styleCache.at) styleCache = { value: readStyleFn(), at: now };
  return styleCache.value;
}

function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (sub) { sub.stop(); sub = null; }
  level = -1;
}

function backlightMessage(r) {
  var n = r && r.returnValue !== false && r.settings ? Math.round(parseFloat(r.settings.backlight)) : NaN;
  level = isNaN(n) ? -1 : n;
}

function watch() {
  if (!SubscriptionCtor) return;
  if (!sub) {
    sub = new SubscriptionCtor('com.webos.settingsservice/getSystemSettings',
      { category: 'picture', keys: ['backlight'], subscribe: true }, null,
      { message: backlightMessage, close: function () { level = -1; } });
    sub.start();
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, idleMs);
  if (idleTimer.unref) idleTimer.unref();
}

// The current picture mode's brightness and the bar's style, for the bar's page to follow while a key is held. cb({ ok, level, style }).
function getBrightness(cb) {
  if (!lunaFn) return cb({ ok: false });
  watch();
  if (level >= 0) return cb({ ok: true, level: level, style: styleForAsk() });
  lunaFn('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['backlight'] }, function (r) {
    var n = r && r.settings ? parseFloat(r.settings.backlight) : NaN;
    cb(isNaN(n) ? { ok: false } : { ok: true, level: Math.round(n), style: styleForAsk() });
  });
}

/*
 * The filter's part. filterConfig() reads the two values of the configd
 * value glasshouse.remoteKeys that the bar needs: osd, whether a Brightness
 * key is set where the bar's app can be shown, and osdStyle. filterShow(app)
 * opens the bar's app once for each press, with the level and the style; its
 * page follows the level itself while the key is held.
 */
function filterConfig() {
  return [
    '        glasshouseOsd = value.osd === true;',
    '        glasshouseOsdStyle = value.osdStyle === "horizontal" || value.osdStyle === "vertical" ? value.osdStyle : "lg";'
  ].join('\n');
}

function filterShow(inputBarId) {
  return [
    'var glasshouseOsd = false;',
    'var glasshouseOsdStyle = "lg";',
    'var glasshouseOsdPress = 0;',
    'function glasshouseBrightnessShow(level, press) {',
    '    if (!glasshouseOsd || press === glasshouseOsdPress) return;',
    '    glasshouseOsdPress = press;',
    '    try { applicationManager.launch(' + JSON.stringify(inputBarId) + ', JSON.stringify({ "glasshouse": "osd", "kind": "brightness", "level": level, "style": glasshouseOsdStyle })); } catch (e) {}',
    '}'
  ].join('\n');
}

module.exports = {
  init: init,
  stop: stop,
  getBrightness: getBrightness,
  forgetStyle: forgetStyle,
  isStyle: isStyle,
  filterConfig: filterConfig,
  filterShow: filterShow,
  STYLES: STYLES,
  BACKLIGHT_IDLE_MS: BACKLIGHT_IDLE_MS
};
