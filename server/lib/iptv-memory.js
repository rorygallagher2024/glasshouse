/*
 * lib/iptv-memory.js - how much memory an Internet TV job asks of the TV
 *
 * Two modes:
 *   - normal uses the set figures: a job needs 210 MB available and may keep
 *     running down to 150 MB, with the full heap and batch of logos. With less
 *     than that available, the job runs in economy instead.
 *   - economy, the default on a TV under 1.5 GB, asks only for what the job
 *     needs. The floor follows the TV's size, as a TV with about 1 GB often sits
 *     near 150 MB available with its usual apps loaded. The cost is what the job
 *     last used on this playlist, or an estimate from the size of the list until
 *     that is known; the heap follows the cost, and fewer logos come in a batch.
 *     An edit the owner is waiting to see asks only for a small margin over the
 *     floor, as the once-a-second measure still stops it if memory runs short.
 *
 * MemAvailable moves by tens of MB within seconds on such a TV, so in either
 * mode a running job is stopped when it stays under the floor, or falls well
 * below it at once.
 *
 * Strict ES5: runs on node 0.12.
 */
var MB = 1024 * 1024;

var NORMAL = 'normal';
var ECONOMY = 'economy';
var LOW_RAM = 1536 * MB;

var NORMAL_FLOOR = 150 * MB;
var NORMAL_COST = 60 * MB;
var FULL_HEAP_MB = 64;

var FLOOR_MIN = 90 * MB;
var FLOOR_SHARE = 0.12;
// Under the floor by this much, a job stops at the next measure.
var HARD_GAP = 30 * MB;
// Measures in a row under the floor, one a second, before a job stops.
var SUSTAINED = 3;
var USER_MARGIN = 20 * MB;

var UNKNOWN_COST = 60 * MB;
var MIN_COST = 24 * MB;
var PEAK_MARGIN = 1.25;
// From the worker's peak on a list of 100,008 M3U entries: 100 MB.
var BASE_COST = 30 * MB;
var COST_PER_1000 = 0.7 * MB;
// The heap as a share of the cost, which also counts node itself and curl.
var HEAP_SHARE = 0.6;
var MIN_HEAP_MB = 24;
var ECONOMY_LOGOS = 40;
// A peak noted for a worker that died in economy: its next run has the full heap.
var DIED_PEAK = 128 * MB;

function defaultMode(total) {
  return total > 0 && total < LOW_RAM ? ECONOMY : NORMAL;
}

function floor(total, mode) {
  if (mode === NORMAL || !(total > 0)) return NORMAL_FLOOR;
  return Math.max(FLOOR_MIN, Math.min(NORMAL_FLOOR, Math.round(total * FLOOR_SHARE)));
}

/* What a job should use: its last peak (RSS, bytes) or an estimate from the channels. */
function cost(peak, channels) {
  if (peak > 0) return Math.max(MIN_COST, Math.round(peak * PEAK_MARGIN));
  if (channels > 0) return BASE_COST + Math.round(channels / 1000 * COST_PER_1000);
  return UNKNOWN_COST;
}

function heapMb(c) {
  return Math.max(MIN_HEAP_MB, Math.min(FULL_HEAP_MB, Math.ceil(c / MB * HEAP_SHARE)));
}

/*
 * How a queued job should run. opts: { mode, total, available, peak, channels,
 * user }; available null when it could not be read. Returns { start, mode,
 * fallback, needed, heapMb, logos }; logos 0 is the worker's own batch.
 */
function plan(opts) {
  var known = opts.available !== null && opts.available !== undefined;
  var normalNeeds = NORMAL_FLOOR + NORMAL_COST;
  if (opts.mode === NORMAL && (!known || opts.available >= normalNeeds)) {
    return { start: true, mode: NORMAL, fallback: false, needed: normalNeeds, heapMb: FULL_HEAP_MB, logos: 0 };
  }
  var c = cost(opts.peak, opts.channels);
  var needed = floor(opts.total, ECONOMY) + (opts.user ? Math.min(c, USER_MARGIN) : c);
  return { start: !known || opts.available >= needed, mode: ECONOMY, fallback: opts.mode === NORMAL,
    needed: needed, heapMb: heapMb(c), logos: ECONOMY_LOGOS };
}

/*
 * One measure of a running job. count is the measures in a row under the floor
 * so far; returns the new count, and whether the job should stop.
 */
function pressure(available, total, count, mode) {
  var f = floor(total, mode);
  if (available >= f) return { count: 0, stop: false };
  var next = (count || 0) + 1;
  return { count: next, stop: next >= SUSTAINED || available < f - HARD_GAP };
}

module.exports = {
  NORMAL: NORMAL,
  ECONOMY: ECONOMY,
  DIED_PEAK: DIED_PEAK,
  defaultMode: defaultMode,
  floor: floor,
  cost: cost,
  plan: plan,
  pressure: pressure
};
