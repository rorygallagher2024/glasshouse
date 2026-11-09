/**
 * test/fake-clock.js - timers on a clock of the suite's own
 *
 * install() replaces setTimeout, setInterval, Date.now and process.hrtime
 * (which lib/util's monotonicMs reads) for the process.
 * Whenever nothing else is left to run (process.nextTick and setImmediate
 * callbacks done), the clock jumps to the next timer due and fires it, so
 * timers fire in the order they would in real time but without the waiting:
 * a step that waits out a server's 10 s grace period takes no time, and a
 * wait can never fire a moment before the timer it waits for, however slow
 * the runner. Only for suites whose mocks answer with process.nextTick or
 * timers: real network or file I/O would be overtaken by the clock.
 *
 * Strict ES5: runs on node 0.10.
 */
var real = {
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  setImmediate: setImmediate,
  now: Date.now
};

var now = 0;
var timers = [];
var seq = 0;
var pumping = false;

function Timer(fn, args, ms, every) {
  this.fn = fn;
  this.args = args;
  this.every = every ? Math.max(1, ms) : 0;
  this.at = now + Math.max(every ? 1 : 0, ms);
  this.seq = ++seq;
}
Timer.prototype.ref = function () { return this; };
Timer.prototype.unref = function () { return this; };

function add(fn, ms, args, every) {
  var t = new Timer(fn, args, Math.max(0, Number(ms) || 0), every);
  timers.push(t);
  pump();
  return t;
}

function remove(t) {
  var i = timers.indexOf(t);
  if (i !== -1) timers.splice(i, 1);
}

function earliest() {
  var best = null;
  for (var i = 0; i < timers.length; i++) {
    var t = timers[i];
    if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
  }
  return best;
}

// One timer per turn of the real event loop, after its ticks and immediates.
function pump() {
  if (pumping) return;
  pumping = true;
  real.setImmediate(function fire() {
    var t = earliest();
    if (!t) { pumping = false; return; }
    if (t.at > now) now = t.at;
    if (t.every) { t.at = now + t.every; t.seq = ++seq; } else remove(t);
    t.fn.apply(null, t.args);
    real.setImmediate(fire);
  });
}

function install() {
  now = real.now();
  global.setTimeout = function (fn, ms) { return add(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  global.setInterval = function (fn, ms) { return add(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  global.clearTimeout = global.clearInterval = function (t) { if (t) remove(t); };
  Date.now = function () { return now; };
  process.hrtime = function (since) {
    var s = Math.floor(now / 1000), ns = Math.round((now % 1000) * 1e6);
    if (!since) return [s, ns];
    var d = (s - since[0]) * 1e9 + ns - since[1];
    return [Math.floor(d / 1e9), d % 1e9];
  };
}

module.exports = { install: install, now: function () { return now; } };
