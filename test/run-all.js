/**
 * test/run-all.js - Offline test runner
 *
 * Runs every test suite under test/, all at once, and exits non-zero if any
 * assertion fails.
 * Each suite may contain async tests; the runner waits for process.exit or an
 * uncaught exception to determine the outcome.
 *
 * Usage:  node test/run-all.js [word ...]
 *
 * With words, only the suites whose file name contains one of them run, as
 * `node test/run-all.js home luna` while working on those. --times lists the
 * slowest suites after the results.
 */

var child = require('child_process');
var path = require('path');
var fs = require('fs');

var testDir = __dirname;
var args = process.argv.slice(2);
var showTimes = args.indexOf('--times') !== -1;
var words = args.filter(function (a) { return a !== '--times'; });
var suites = fs.readdirSync(testDir)
  .filter(function (f) { return /^test-.*\.js$/.test(f); })
  .filter(function (f) { return !words.length || words.some(function (w) { return f.indexOf(w) !== -1; }); })
  .sort();

if (suites.length === 0) {
  console.error('No test suites found in ' + testDir + (words.length ? ' matching ' + words.join(', ') : ''));
  process.exit(1);
}

/*
 * A suite whose header says "@shards N" is started N times, each copy running
 * every Nth step (test/shard.js), as its steps wait on real timers one after
 * another.
 */
function shardsOf(suite) {
  var head = '';
  try { head = fs.readFileSync(path.join(testDir, suite), 'utf8').slice(0, 3000); } catch (e) {}
  var m = /@shards (\d+)/.exec(head);
  return m ? Number(m[1]) : 1;
}

/*
 * All suites at once: each runs in its own process, with its own temporary
 * files and ports, and the slow ones (the server start-up, MQTT reconnects,
 * the watchdog) spend their time waiting on real timers. Output is held per
 * suite and printed in name order once all have finished.
 */
var runs = [];
suites.forEach(function (suite) {
  var count = shardsOf(suite);
  for (var i = 0; i < count; i++) runs.push({ suite: suite, shard: count > 1 ? i + '/' + count : '' });
});
var left = runs.length;
var startedAt = Date.now();

runs.forEach(function (run) {
  var env = {};
  for (var k in process.env) env[k] = process.env[k];
  if (run.shard) env.TEST_SHARD = run.shard;
  var proc = child.fork(path.join(testDir, run.suite), [], { silent: true, env: env });
  run.out = { stdout: '', stderr: '', code: null };
  proc.stdout.on('data', function (d) { run.out.stdout += d; });
  proc.stderr.on('data', function (d) { run.out.stderr += d; });
  proc.on('close', function (code) {
    run.out.code = code;
    run.ms = Date.now() - startedAt;
    if (--left === 0) report();
  });
});

function report() {
  var failed = {};
  runs.forEach(function (run) {
    process.stdout.write(run.out.stdout);
    if (run.out.stderr) process.stderr.write(run.out.stderr);
    if (run.out.code !== 0) {
      console.error('FAIL: ' + run.suite + (run.shard ? ' (shard ' + run.shard + ')' : '') + ' exited with code ' + run.out.code);
      failed[run.suite] = true;
    }
  });
  var failures = Object.keys(failed).length;
  // Again at the end, where the last lines of a long CI log show them.
  runs.forEach(function (run) {
    if (run.out.code === 0) return;
    console.log('═════ ' + run.suite + (run.shard ? ' (shard ' + run.shard + ')' : '') + ' failed: its output ═════');
    process.stdout.write(run.out.stdout.split('\n').slice(-40).join('\n') + '\n');
    if (run.out.stderr) process.stdout.write(run.out.stderr.split('\n').slice(-40).join('\n') + '\n');
  });
  if (showTimes) {
    console.log('─────────────────────────');
    runs.slice().sort(function (a, b) { return b.ms - a.ms; }).slice(0, 10).forEach(function (run) {
      console.log((run.ms / 1000).toFixed(1) + 's  ' + run.suite + (run.shard ? ' (shard ' + run.shard + ')' : ''));
    });
  }
  console.log('─────────────────────────');
  console.log((suites.length - failures) + ' suite(s) passed, ' + failures + ' suite(s) failed, in ' +
    Math.round((Date.now() - startedAt) / 1000) + 's.');
  process.exit(failures > 0 ? 1 : 0);
}

console.log('Running ' + suites.length + ' test suite(s)...\n');
