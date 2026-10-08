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
var STARTUP_MS = 30000;
/*
 * Monotonic, not Date.now(): the wall clock can step back, and a start due
 * "later" by the old clock then waited out the whole step, every child start
 * with it, while the heartbeat carried on.
 */
function monotonicMs() {
  var t = process.hrtime();
  return t[0] * 1000 + t[1] / 1e6;
}
var bornAt = monotonicMs();
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
  launches.shift()();
  drainLaunches();
}

/**
 * Calls fn once it is this start's turn.
 * @param {function(): void} fn starts the child
 */
function launch(fn) {
  launches.push(fn);
  drainLaunches();
}

module.exports = {
  launch: launch
};
