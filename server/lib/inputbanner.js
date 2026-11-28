/*
 * lib/inputbanner.js - closes LG's input banner when an HDMI input with a
 * SIMPLINK device comes to the front
 *
 * Switching to an HDMI input shows LG's banner, "HDMI 1 / Formuler Z11 P",
 * for 5 seconds (10 with audio guidance). While it is up the remote's keys
 * stay with the input app instead of going to the device over HDMI-CEC:
 * com.webos.app.inputcommon passes a key to its SIMPLINK handler only
 * `simplinkEnabled && !isFocusableViewExist`, and the banner is a focusable
 * view. Back closes it. With **Close the input banner** switched on on the
 * Inputs tab, Glasshouse sends that Back itself, so the remote works on the
 * device at once.
 *
 * Back is sent 2 seconds after the input comes to the front, while the banner
 * is still up, and only to an HDMI input that has a SIMPLINK device; without
 * one, or with only a sound bar on it, Back would go to the input app and
 * could leave it. A Back that came
 * after the banner had gone would go to the device as one step back, which is
 * why it is sent once and never later.
 *
 * Strict ES5: runs on node 0.12.
 */
var msg = require('./say').msg;

// After the input comes to the front: its banner is up by then.
var DELAY_MS = 2000;
// LG's Back as the network input service takes it (see RCU_KEYS in controls).
var BACK_KEYCODE = 412;
var HDMI_APP = /^com\.webos\.app\.hdmi(\d)$/;

var config = {};
var lunaFn = null;
var writeSettings = null;
var delayMs = DELAY_MS;
var front = '';
var timer = null;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.luna) lunaFn = opts.luna;
  if (opts.writeSettings) writeSettings = opts.writeSettings;
  delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : DELAY_MS;
  front = '';
  clearTimeout(timer);
  timer = null;
}

function enabled() {
  return !!(config.inputs && config.inputs.closeBanner);
}

/*
 * Whether eim lists a SIMPLINK device on the input appId opens that takes the
 * remote's keys: a player or set-top box, not an audio system (CEC device
 * type 5), such as a sound bar on the ARC port.
 */
function hasSimplinkDevice(appId, cb) {
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (r) {
    var list = r && Object.prototype.toString.call(r.devices) === '[object Array]' ? r.devices : [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      if (d.appId !== appId) continue;
      var subs = Object.prototype.toString.call(d.subList) === '[object Array]' ? d.subList : [];
      for (var k = 0; k < subs.length; k++) {
        if (subs[k] && subs[k].id === 'SIMPLINK' && subs[k].cecpDevType !== 5) return cb(true);
      }
      return cb(false);
    }
    cb(false);
  });
}

function closeBanner(appId) {
  hasSimplinkDevice(appId, function (yes) {
    // Gone from the front while eim answered, or nothing on it to control.
    if (!yes || front !== appId || !enabled()) return;
    lunaFn('com.webos.service.networkinput/test/sendKeyCode', { keyCode: BACK_KEYCODE }, function (r) {
      if (r && r.returnValue) console.log('inputs: closed the input banner on ' + appId);
      else console.error('inputs: could not close the input banner on ' + appId);
    });
  });
}

/*
 * The app in front changed. snapshot: the state as it was when the server
 * started, not a switch someone made.
 */
function onAppChanged(appId, snapshot) {
  var was = front;
  front = String(appId || '');
  if (front === was) return;
  clearTimeout(timer);
  timer = null;
  if (snapshot || !enabled() || !lunaFn || !HDMI_APP.test(front)) return;
  var opened = front;
  timer = setTimeout(function () {
    timer = null;
    if (front === opened) closeBanner(opened);
  }, delayMs);
  if (timer.unref) timer.unref();
}

function setEnabled(on, cb) {
  if (!writeSettings) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettings({ inputs: { closeBanner: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.inputs = config.inputs || {};
    config.inputs.closeBanner = on;
    console.log('inputs: closing the input banner switched ' + (on ? 'on' : 'off'));
    cb({ ok: true });
  });
}

function summary() {
  return { closeBanner: enabled() };
}

module.exports = {
  DELAY_MS: DELAY_MS,
  BACK_KEYCODE: BACK_KEYCODE,
  init: init,
  enabled: enabled,
  onAppChanged: onAppChanged,
  setEnabled: setEnabled,
  summary: summary
};
