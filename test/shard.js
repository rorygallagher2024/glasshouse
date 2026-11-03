/**
 * test/shard.js - the share of a suite's steps this process runs
 *
 * run-all.js starts a suite marked "@shards N" N times, with TEST_SHARD set to
 * 0/N, 1/N and so on; each copy runs every Nth step. Run on its own, a suite
 * runs all of them. Each step has to set up what it needs, as no copy sees
 * the steps another runs.
 *
 * Strict ES5: runs on node 0.12.
 */
function pick(steps) {
  var m = /^(\d+)\/(\d+)$/.exec(process.env.TEST_SHARD || '');
  if (!m) return steps;
  var index = Number(m[1]);
  var count = Number(m[2]);
  return steps.filter(function (s, i) { return i % count === index; });
}

module.exports = { pick: pick };
