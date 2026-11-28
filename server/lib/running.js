'use strict';
/*
 * lib/running.js - one subscription to the apps the TV has running, for
 * every module that follows them
 *
 * Glasshouse Bar (lib/homebar.js), the Home Assistant bar (lib/habar.js) and
 * the input bar (lib/inputbar.js) each preload their app again once it stops
 * running, and each had its own applicationManager/running subscription,
 * that is its own luna-send process, all three answered with the same list.
 * They now share one. A module that starts watching after the first answer
 * gets the latest list straight away, as its own subscription's first
 * answer would have given it.
 *
 * Strict ES5: runs on node 0.12.
 */
var luna = require('./luna');

var URI = 'com.webos.applicationManager/running';
var watchers = [];
var sub = null;
var last = null;

function tell(r) {
  last = r;
  watchers.slice().forEach(function (fn) {
    try { fn(r); } catch (e) { console.error('running: ' + (e && e.message)); }
  });
}

/**
 * Calls fn with each answer to the subscription, started on the first call.
 * Returns a handle the module can keep, as it kept its own subscription.
 * @param {function(Object): void} fn
 * @param {any} [Subscription] the class to subscribe with (the tests' stand-in); luna's otherwise
 */
function watch(fn, Subscription) {
  watchers.push(fn);
  if (!sub) {
    var Sub = Subscription || luna.Subscription;
    sub = new Sub(URI, { subscribe: true }, null, {});
    sub.handlers.message = tell;
    sub.start();
  } else if (last) {
    var r = last;
    process.nextTick(function () { if (watchers.indexOf(fn) !== -1) fn(r); });
  }
  return { uri: URI };
}

// For the tests: no subscription, no one watching.
function reset() {
  watchers = [];
  sub = null;
  last = null;
}

module.exports = { watch: watch, reset: reset, URI: URI };
