/*
 * LG's idle screen saver where the panel care service holds it back.
 *
 * On a G3 (webOS 9.2.2), eplmanager refuses screen savers for 30 minutes
 * after each key or app change while it dims static parts of the picture.
 * An app handed over with supportScreenSaverPolicy true and a delay of
 * 1 to 3 minutes has no hold. Restore screenmanager's setting after the
 * screen saver closes or fails, so the dimming continues during viewing.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var names = require('./names');
var readTrimmed = require('./util').readTrimmed;
var unlinkQuiet = require('./util').unlinkQuiet;
var SET_APP_INFO = 'com.webos.service.oledepl/setEplAppInfo';
var POWER = 'com.webos.service.tvpower/power/';
// Survives a server crash, but not a TV reboot, which resets LG's policy.
var LIFTED_MARKER = '/var/run/tvweb-idlesaver';
// eplmanager starts no hold for 3 minutes or less, and reads 0 as not set.
var NO_HOLD_DELAY = 1;
// A refusing service answers "Screen On" within 10 to 30 ms (G3).
var REFUSAL_MS = 2000;
var OWN_REQUEST_MS = 5000;

var lunaFn = null;
/** @type {function(function(?{state: string, fullScreen: boolean}): void, boolean=): void} */
var mediaStateFn = function (cb) { cb(null); };
var requestSeenAt = 0;
var ownRequestAt = 0;
var lastState = '';
var powerGeneration = 0;
var policyGeneration = 0;
var liftedApp = '';
var lifting = false;
var restoring = false;
var restoreWanted = false;
var recovering = false;
var retryTimer = null;
var unsupported = false;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  mediaStateFn = opts.mediaState || function (cb) { cb(null); };
  liftedApp = readTrimmed(LIFTED_MARKER) || '';
  recovering = !!liftedApp;
}

function foregroundApp(cb) {
  lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
    cb(fg && fg.returnValue !== false && fg.appId ? String(fg.appId) : '');
  });
}

function setPolicy(appId, lifted, cb) {
  var params = lifted
    ? { appId: appId, supportScreenSaverPolicy: true, screenSaverDelay: NO_HOLD_DELAY }
    : { appId: appId, supportScreenSaverPolicy: false };
  lunaFn(SET_APP_INFO, params, function (r) {
    var ok = !!(r && r.returnValue);
    if (!ok && /unknown method|service does not exist/i.test(String((r && r.errorText) || ''))) unsupported = true;
    cb(ok);
  });
}

function forgetLift() {
  liftedApp = '';
  restoreWanted = false;
  unlinkQuiet(LIFTED_MARKER);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function retryRestore() {
  restoring = false;
  if (retryTimer) return;
  retryTimer = setTimeout(function () {
    retryTimer = null;
    restore();
  }, 1000);
}

// A failed lookup or write leaves the policy outstanding, including across
// a restart. Only a confirmed restore or change of app clears it.
function restore() {
  if (!liftedApp || !lunaFn) return;
  restoreWanted = true;
  if (lifting || restoring) return;
  restoring = true;
  var appId = liftedApp;
  foregroundApp(function (current) {
    if (!current) return retryRestore();
    if (current !== appId) {
      restoring = false;
      return forgetLift();
    }
    setPolicy(appId, false, function (ok) {
      if (!ok) return retryRestore();
      restoring = false;
      forgetLift();
      console.log('idlesaver: panel care holds the screen saver again for ' + appId);
    });
  });
}

function checkRequest(generation) {
  if (!liftedApp || generation !== policyGeneration) return;
  lunaFn(POWER + 'getPowerState', {}, function (pw) {
    if (!liftedApp || generation !== policyGeneration) return;
    if (!pw || pw.returnValue === false || pw.state !== 'Screen Saver') restore();
  });
}

// Journal before changing LG's policy: even a lost reply can mean it changed.
function lift(cb) {
  ownRequestAt = Date.now();
  if (!lunaFn || unsupported || liftedApp || lifting || restoring) return cb(false);
  var powerAtStart = powerGeneration;
  lifting = true;
  foregroundApp(function (appId) {
    var key = names.shortAppId(appId);
    if (!appId || names.isHdmiKey(key) || key === 'livetv' || powerAtStart !== powerGeneration) {
      lifting = false;
      return cb(false);
    }
    try { fs.writeFileSync(LIFTED_MARKER, appId + '\n', 'utf8'); }
    catch (e) {
      lifting = false;
      return cb(false);
    }
    liftedApp = appId;
    var generation = ++policyGeneration;
    setPolicy(appId, true, function (ok) {
      lifting = false;
      if (unsupported) forgetLift();
      else if (!ok || restoreWanted || powerAtStart !== powerGeneration) restore();
      else {
        // Also covers a dashboard request with a lost reply or a slow start
        // that never reaches Screen Saver, without relying on its callback.
        setTimeout(function () { checkRequest(generation); }, OWN_REQUEST_MS);
        return cb(true);
      }
      cb(false);
    });
  });
}

function idleRequestRefused() {
  var generation = powerGeneration;
  mediaStateFn(function (media) {
    if (!media || media.state === 'playing' || lastState !== 'Active' || generation !== powerGeneration) return;
    lift(function (ok) {
      if (!ok) return;
      if (lastState !== 'Active' || generation !== powerGeneration) return restore();
      console.log('idlesaver: panel care refused the idle screen saver; asking again without its hold on ' + liftedApp);
      var policy = policyGeneration;
      lunaFn(POWER + 'turnOnScreenSaver', {}, function () {
        setTimeout(function () { checkRequest(policy); }, 1500);
      });
    });
  }, true);
}

// Every reply of the power state subscription, "processing" steps included.
function powerReply(response) {
  var state = response && response.state;
  if (!state) return;
  var wasScreenSaver = lastState === 'Screen Saver';
  if (state !== lastState) powerGeneration++;
  lastState = state;
  if (recovering) {
    recovering = false;
    if (state !== 'Screen Saver') restore();
  }
  if (wasScreenSaver && state !== 'Screen Saver') restore();
  if (state !== 'Active') {
    requestSeenAt = 0;
    if (state !== 'Screen Saver') restore();
    return;
  }
  if (response.processing === 'Request Screen Saver') {
    requestSeenAt = Date.now();
    return;
  }
  var refused = requestSeenAt && response.processing === 'Screen On' &&
    Date.now() - requestSeenAt < REFUSAL_MS;
  if (!refused) return;
  requestSeenAt = 0;
  if (!lunaFn || unsupported || Date.now() - ownRequestAt < OWN_REQUEST_MS) return;
  idleRequestRefused();
}

module.exports = {
  init: init,
  lift: lift,
  restore: restore,
  powerReply: powerReply
};
