'use strict';
/*
 * The turn every child process start waits for.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * Node 0.12 on a B8 (webOS 4) has frozen in its first second at start: a
 * luna-send child stuck between fork and exec on a lock it inherited held,
 * the server waiting on it, and every later child the same.
 */

/*
 * Every process start, a luna-send call or subscription or the syslog
 * forwarder's dmesg, waits its turn here, with a gap between starts. Starting
 * a child is the moment the freeze above can happen, and it is likeliest while
 * node's own threads are busy, as they are just after start: 6 of 11 wedges a
 * B8 logged in a fortnight came within 5 minutes of the server starting. The first 30s get a wider gap, so the
 * start-up calls and subscriptions spread out instead of landing together.
 */
var GAP_MS = 50;
// Not wider: a stats read makes about a dozen calls, and at 400ms apart it ran
// past its 4.5s limit and came back incomplete during start-up.
var STARTUP_GAP_MS = 150;
/*
 * Both hazards are of the node LG shipped with webOS 4 to 6: 0.12's inherited
 * lock and 8.12's fork handler (below). Neither has been seen on a later node,
 * where the gaps only held the start back: a C2 (webOS 9.2, node 16) answered
 * its start-up calls in 27 ms each, started 150 ms apart, 131 of them. There a
 * start waits only a little, so starts still come from a timer, one by one.
 */
var OLD_NODE = /^v(0|[1-9])\./.test(process.version);
if (!OLD_NODE) {
  GAP_MS = 10;
  STARTUP_GAP_MS = 25;
}
var STARTUP_MS = 30000;
/*
 * Monotonic, not Date.now(): the wall clock can step back, and a start due
 * "later" by the old clock then waited out the whole step, every child start
 * with it, while the heartbeat carried on.
 */
var monotonicMs = require('./util').monotonicMs;
var bornAt = monotonicMs();
// { fn, level }: urgent starts (a remote key press, 2) wait at the front, then
// the first ones (what the start needs soonest, 1), then the rest, each in turn.
var launches = [];
var launchTimer = null;
var nextLaunchAt = 0;

function drainLaunches() {
  if (launchTimer || !launches.length) return;
  var now = monotonicMs();
  var gap = now - bornAt < STARTUP_MS ? STARTUP_GAP_MS : GAP_MS;
  var wait = nextLaunchAt - now;
  if (wait > 0) {
    launchTimer = setTimeout(function () { launchTimer = null; drainLaunches(); }, wait);
    return;
  }
  nextLaunchAt = now + gap;
  /*
   * Always from a timer. LG's node 8.12.0 (webOS 5 and 6) runs a fork handler
   * in the child that calls uv_close on the default loop's handles, and aborts
   * the child (see diedEarly) when one is already closing: the process handle
   * of a child that just exited is, until the loop's closing phase. The luna
   * queue starts its next call from an exit, so starts often came then. A
   * timer runs after that phase; setImmediate runs before it and does not help.
   * Of 900 starts, three at a time, on an OLED55CX3LA: 9 aborted started at
   * once, 8 from setImmediate, none from setTimeout.
   */
  setTimeout(launches.shift().fn, 0);
  drainLaunches();
}

/**
 * Calls fn once it is this start's turn, from a timer of its own. An
 * urgent start goes ahead of the others waiting, behind earlier urgent ones,
 * and a first one ahead of the rest; the gap still applies.
 * @param {function(): void} fn starts the child
 * @param {boolean} [urgent]
 * @param {boolean} [first]
 */
function launch(fn, urgent, first) {
  var level = urgent ? 2 : first ? 1 : 0;
  var at = launches.length;
  while (at > 0 && launches[at - 1].level < level) at--;
  launches.splice(at, 0, { fn: fn, level: level });
  drainLaunches();
}

/*
 * A child killed by a signal it was not sent by the timeout died before
 * answering. On a 50UP81006LR (webOS 6.5, node v8.12.0) children aborted with
 * libuv's "uv_close: Assertion `!uv__is_closing(handle)' failed" at start and
 * the model name was lost; run by hand, the same call answered. Such a child
 * never reached the program it was to run, so running it again is safe,
 * writes included.
 */
function diedEarly(err) {
  return !!(err && err.signal && !err.killed);
}

/*
 * The gaps, for the fake TV the browser checks start: its luna-send is a node
 * script with no lock to inherit, and the start-up gap held each tab's 59
 * calls 150 ms apart. Never called on a TV.
 */
function setGaps(gap, startupGap) {
  GAP_MS = gap;
  STARTUP_GAP_MS = startupGap;
}

module.exports = {
  OLD_NODE: OLD_NODE,
  launch: launch,
  diedEarly: diedEarly,
  setGaps: setGaps
};
