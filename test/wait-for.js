/**
 * test/wait-for.js - waiting for what a step is about, not for a time
 *
 * waitFor(check, cb, what, ms) calls cb as soon as check() holds, polling every
 * 10 ms, and fails the suite naming what never happened after ms (5 s by
 * default). A fixed wait either runs short on a slow runner or makes every
 * run wait its full length.
 *
 * Strict ES5: runs on node 0.10.
 */
function waitFor(check, cb, what, ms) {
  var end = Date.now() + (ms || 5000);
  (function poll() {
    if (check()) return cb();
    if (Date.now() >= end) throw new Error('timed out waiting for ' + (what || 'a condition'));
    setTimeout(poll, 10);
  })();
}

module.exports = { waitFor: waitFor };
