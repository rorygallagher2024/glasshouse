'use strict';
/*
 * lib/palmbus.js - one-shot luna calls through LG's own Node binding for the
 * bus, with no process started
 *
 * Every luna call has been a luna-send child (lib/luna.js). Each costs a
 * fork and an exec, and on the node LG shipped with webOS 4 to 6 a fork can
 * wedge (lib/children.js), so calls are spaced out and run two at a time. The
 * webOS images carry palmbus, the binding LG's own Node services use, and it
 * loads for root: on an OLED65B8SLC (webOS 4.4.3, node 0.12.2) a call took
 * 3 ms against 25 ms for luna-send, and on an OLED42C24LA (webOS 9.2, node
 * 16.19.1) 2 ms against 16 ms.
 *
 * It is not a drop-in. Node has no role of its own on the bus, while
 * luna-send's is privileged, so LG refuses some calls to it: on the
 * OLED65B8SLC com.webos.service.settings and com.webos.audio/getSoundOut
 * answered "Denied method call", and on the OLED42C24LA
 * com.webos.service.audio/master/getVolume did not answer at all. lib/luna.js
 * sends such a call through luna-send instead, and from then on.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');

// Where the images keep it: /usr/lib/nodejs on webOS 9, /usr/palm/nodejs on webOS 4.
var PLACES = (process.env.TVWEB_PALMBUS || '/usr/lib/nodejs/palmbus.js:/usr/palm/nodejs/palmbus.js').split(':');

var lib = null;
var handle = null;
var tried = false;
var why = '';
// The calls waiting on the handle now, each with its finish(err, raw).
var inFlight = [];

function load() {
  if (handle) return handle;
  if (tried && !lib) return null;
  tried = true;
  if (!lib) {
    for (var i = 0; i < PLACES.length; i++) {
      if (!PLACES[i] || !fs.existsSync(PLACES[i])) continue;
      try { lib = require(PLACES[i]); break; } catch (e) { why = PLACES[i] + ': ' + e.message; }
    }
    if (!lib) { if (!why) why = 'not on this TV'; return null; }
  }
  try {
    handle = new lib.Handle('', false);
  } catch (e) {
    why = e.message;
    lib = null;
  }
  return handle;
}

/*
 * A call left unanswered keeps the binding busy: on the OLED42C24LA each one
 * cost 3% of a core for as long as the process ran, cancelled or not, until
 * its handle was unregistered. So a call that times out takes its handle with
 * it, and the next call opens a new one. The others still waiting on the old
 * handle would never hear back, so they end with a retry error, which
 * lib/luna.js makes again on the new handle.
 */
function retire(h) {
  if (h !== handle) return;
  handle = null;
  var waiting = inFlight;
  inFlight = [];
  try { h.unregister(); } catch (e) {}
  waiting.forEach(function (f) {
    var err = /** @type {any} */ (new Error('the handle was renewed'));
    err.retry = true;
    f(err);
  });
}

function available() { return !!load(); }
function unavailableReason() { return load() ? '' : why; }

/**
 * One call: cb(err, raw) with the reply's JSON text, or an error where the
 * call could not be made or nothing came back within waitMs (err.retry where
 * it was cut short by another call's timeout and can simply be made again).
 * @param {string} uri service/method, without luna://
 * @param {string} payload JSON text
 * @param {number} waitMs
 * @param {function(?any, string=): void} cb
 */
function call(uri, payload, waitMs, cb) {
  var h = load();
  if (!h) return process.nextTick(function () { cb(new Error('palmbus ' + why)); });
  var done = false, c, timer;
  function finish(err, raw) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    var at = inFlight.indexOf(finish);
    if (at !== -1) inFlight.splice(at, 1);
    try { if (c) c.cancel(); } catch (e) {}
    cb(err, raw);
  }
  try {
    c = h.call('luna://' + uri, payload);
  } catch (e) {
    return process.nextTick(function () { finish(e); });
  }
  inFlight.push(finish);
  timer = setTimeout(function () {
    // The handle goes first, so a call made from this one's callback opens the new one.
    var at = inFlight.indexOf(finish);
    if (at !== -1) inFlight.splice(at, 1);
    retire(h);
    finish(new Error('no answer in ' + waitMs + ' ms'));
  }, waitMs);
  c.addListener('response', function (m) {
    var raw = '';
    try { raw = String(m.payload()); } catch (e) { return finish(e); }
    finish(null, raw);
  });
}

module.exports = {
  available: available,
  unavailableReason: unavailableReason,
  call: call
};
