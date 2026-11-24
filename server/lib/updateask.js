/*
 * lib/updateask.js - asks on the TV whether to install a new release
 *
 * With **Ask on the TV** switched on on the Server tab, a release the daily
 * update check has found is put to whoever switched the TV on, with the
 * question dialog (lib/ask): Update now installs it as the tab's Install
 * does, Later leaves it. It asks only after a wake, so never in the middle of
 * something being watched, and not while another question is up. A release
 * is asked about once: once answered, it is not asked again, and the next
 * release is. One left unanswered is asked again after the next wake.
 *
 * Strict ES5: runs on node 0.12.
 */
var msg = require('./say').msg;

var ASK_ID = 'glasshouse-update';
// After a wake the Home screen, and LG's own, are still coming up.
var WAKE_DELAY_MS = 20000;
// Another question on screen: looked at again this often, this many times.
var BUSY_RETRY_MS = 30000;
var BUSY_RETRIES = 10;
var TIMEOUT_S = 60;

var config = {};
/** @type {any} */
var updater = null;
/** @type {any} */
var askModule = null;
var writeSettings = null;
var installFn = null;
/** @type {function(string): void} */
var toastFn = function () {};
var screenOnFn = function () { return false; };
var asking = null;   // the version being asked about
var wakeTimer = null;
var wakeDelayMs = WAKE_DELAY_MS;
var busyRetryMs = BUSY_RETRY_MS;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.updater) updater = opts.updater;
  if (opts.ask) askModule = opts.ask;
  if (opts.writeSettings) writeSettings = opts.writeSettings;
  if (opts.install) installFn = opts.install;
  if (opts.toast) toastFn = opts.toast;
  if (opts.screenOn) screenOnFn = opts.screenOn;
  wakeDelayMs = typeof opts.wakeDelayMs === 'number' ? opts.wakeDelayMs : WAKE_DELAY_MS;
  busyRetryMs = typeof opts.busyRetryMs === 'number' ? opts.busyRetryMs : BUSY_RETRY_MS;
  asking = null;
  clearTimeout(wakeTimer);
  wakeTimer = null;
}

function enabled() {
  return !!(config.update && config.update.askOnTv);
}

// The release to ask about, or null.
function due() {
  if (!enabled() || !config.update.check || !config.allowControl || !updater || !askModule) return null;
  if (updater.isBusy()) return null;
  var s = updater.updateSummary();
  if (!s.available || !s.latest) return null;
  if (config.update.askedVersion === s.latest) return null;
  return s;
}

// The release's own summary, cut at a sentence where it can be, to fit the card.
function summaryOf(s) {
  var text = String(s.notes || '').replace(/\s+/g, ' ').trim();
  if (text.length <= 190) return text;
  var cut = text.slice(0, 190);
  var end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

// 'asked', 'busy' (another question is up) or 'no'.
function maybeAsk() {
  var s = due();
  if (!s || asking || !screenOnFn()) return 'no';
  if (askModule.busy && askModule.busy()) return 'busy';
  asking = s.latest;
  askModule.ask({
    id: ASK_ID,
    title: msg('srv.updateAsk.title', 'Glasshouse {version} is out', { version: s.latest }),
    message: summaryOf(s),
    options: [
      { id: 'install', label: msg('srv.updateAsk.install', 'Update now') },
      { id: 'later', label: msg('srv.updateAsk.later', 'Later') }
    ],
    // Later has the focus, so an OK pressed for something else installs nothing.
    focus: 1,
    timeout: TIMEOUT_S
  }, function (r) {
    if (!r || !r.ok) asking = null;
  });
  console.log('update: asking on the TV about v' + s.latest);
  return 'asked';
}

function remember(version) {
  config.update = config.update || {};
  config.update.askedVersion = version;
  if (writeSettings) {
    writeSettings({ update: { askedVersion: version } }, function (err) {
      if (err) console.error('update: could not save the answered version: ' + err.message);
    });
  }
}

function install(version) {
  console.log('update: installing v' + version + ', as answered on the TV');
  toastFn(msg('srv.updateAsk.installing', 'Updating Glasshouse to {version}. It restarts when done.', { version: version }));
  installFn(function (r) {
    if (r && r.ok === false) {
      var error = r.error || msg('srv.updateAsk.noReason', 'no reason given');
      console.error('update: install failed: ' + error);
      toastFn(msg('srv.updateAsk.failed', 'Glasshouse could not update: {error}', { error: error }));
    }
  });
}

/*
 * An event from the question dialog. True when it was this module's question,
 * which then goes no further (it is not Home Assistant's).
 */
function onAskEvent(ev) {
  if (!ev || ev.id !== ASK_ID) return false;
  var version = asking;
  asking = null;
  if (!version) return true;
  // Unanswered, or pushed aside by another question: asked again after the next wake.
  if (ev.event_type !== 'answer' && ev.event_type !== 'dismissed') return true;
  remember(version);
  if (ev.event_type === 'answer' && ev.choice === 'install' && installFn) install(version);
  return true;
}

// The TV woken: a release waiting is asked about once Home is up.
function onWake() {
  clearTimeout(wakeTimer);
  wakeTimer = null;
  if (!due()) return;
  var tries = 0;
  function later(ms) {
    wakeTimer = setTimeout(function () {
      wakeTimer = null;
      if (maybeAsk() === 'busy' && ++tries <= BUSY_RETRIES) later(busyRetryMs);
    }, ms);
    if (wakeTimer.unref) wakeTimer.unref();
  }
  later(wakeDelayMs);
}

function setEnabled(on, cb) {
  if (!writeSettings) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettings({ update: { askOnTv: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.update = config.update || {};
    config.update.askOnTv = on;
    console.log('update: asking on the TV switched ' + (on ? 'on' : 'off'));
    cb({ ok: true });
  });
}

module.exports = {
  ASK_ID: ASK_ID,
  WAKE_DELAY_MS: WAKE_DELAY_MS,
  init: init,
  enabled: enabled,
  maybeAsk: maybeAsk,
  onAskEvent: onAskEvent,
  onWake: onWake,
  setEnabled: setEnabled,
  summaryOf: summaryOf
};
