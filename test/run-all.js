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
var os = require('os');

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
function headerOf(suite) {
  try { return fs.readFileSync(path.join(testDir, suite), 'utf8').slice(0, 3000); } catch (e) { return ''; }
}

function isSlow(suite) { return /@slow\b/.test(headerOf(suite)); }

function shardsOf(suite) {
  var head = '';
  try { head = fs.readFileSync(path.join(testDir, suite), 'utf8').slice(0, 3000); } catch (e) {}
  var m = /@shards (\d+)/.exec(head);
  return m ? Number(m[1]) : 1;
}

/*
 * Each suite runs in its own process, with its own temporary files and ports,
 * and the slow ones (the server start-up, MQTT reconnects, the watchdog) spend
 * their time waiting on real timers, so several run side by side. Not all at
 * once: 136 node processes on a 4-CPU GitHub runner starved it until GitHub
 * lost the runner ("lost communication with the server") and the job hung for
 * 45 minutes, and the CPU starvation made timing-based steps flaky. Output is
 * held per suite and printed in name order once all have finished.
 */
var runs = [];
suites.forEach(function (suite) {
  var count = shardsOf(suite);
  var slow = isSlow(suite);
  for (var i = 0; i < count; i++) runs.push({ suite: suite, shard: count > 1 ? i + '/' + count : '', slow: slow });
});
// The suites whose header says "@slow" start first, so the longest (the server
// start-up, 40 s) runs alongside the rest rather than after them, and capping
// the number at once leaves the total where the slowest suite puts it.
runs.sort(function (a, b) { return (b.slow ? 1 : 0) - (a.slow ? 1 : 0) || (a.suite < b.suite ? -1 : a.suite > b.suite ? 1 : 0); });
var left = runs.length;
var startedAt = Date.now();
var defaultTimeoutSecs = Number(process.env.TEST_TIMEOUT_SECS) || 60;
var concurrency = Number(process.env.TEST_CONCURRENCY) || Math.max(4, os.cpus().length * 2);
var nextRun = 0;

var progressTimer = setInterval(function () {
  if (left <= 0) { clearInterval(progressTimer); return; }
  var elapsed = Math.round((Date.now() - startedAt) / 1000);
  var running = runs.filter(function (r) { return r.started && !r.finished; }).map(function (r) { return r.suite; });
  if (running.length <= 4) {
    console.log('[' + elapsed + 's] ' + (runs.length - left) + '/' + runs.length + ' done; running: ' + running.join(', '));
  } else {
    console.log('[' + elapsed + 's] ' + (runs.length - left) + '/' + runs.length + ' done (' + running.length + ' running)');
  }
}, 10000);
if (progressTimer.unref) progressTimer.unref();

function startNext() {
  if (nextRun >= runs.length) return;
  startRun(runs[nextRun++]);
}

function startRun(run) {
  run.started = true;
  var env = {};
  for (var k in process.env) env[k] = process.env[k];
  if (run.shard) env.TEST_SHARD = run.shard;
  var proc = child.fork(path.join(testDir, run.suite), [], { silent: true, env: env });
  run.out = { stdout: '', stderr: '', code: null };
  run.finished = false;
  run.startedAt = Date.now();
  proc.stdout.on('data', function (d) { run.out.stdout += d; });
  proc.stderr.on('data', function (d) { run.out.stderr += d; });

  var closeTimer = null;
  var timer = null;

  function finish(code) {
    if (run.finished) return;
    run.finished = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    run.out.code = code;
    run.ms = Date.now() - run.startedAt;
    if (--left === 0) report();
    else startNext();
  }

  proc.on('exit', function (code, sig) {
    var exitCode = (code !== null) ? code : (sig ? 128 : 1);
    // SIGKILL from outside: in CI, the memory cap on the unit tests.
    if (sig) run.out.signal = sig;
    closeTimer = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (e) {}
      finish(exitCode);
    }, 500);
  });

  proc.on('close', function (code) {
    finish(code !== null ? code : 0);
  });

  var suiteTimeoutMs = (run.suite.indexOf('boot') !== -1 ? Math.max(90, defaultTimeoutSecs) : defaultTimeoutSecs) * 1000;
  timer = setTimeout(function () {
    if (run.finished) return;
    run.out.stderr += '\nFAIL: ' + run.suite + (run.shard ? ' (shard ' + run.shard + ')' : '') +
      ' timed out after ' + Math.round(suiteTimeoutMs / 1000) + 's\n';
    try { proc.kill('SIGTERM'); } catch (e) {}
    setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, 1000);
    finish(124);
  }, suiteTimeoutMs);
}

function report() {
  clearInterval(progressTimer);
  var failed = {};
  runs.forEach(function (run) {
    process.stdout.write(run.out.stdout);
    if (run.out.stderr) process.stderr.write(run.out.stderr);
    if (run.out.code !== 0) {
      console.error('FAIL: ' + run.suite + (run.shard ? ' (shard ' + run.shard + ')' : '') +
        (run.out.signal ? ' was killed by ' + run.out.signal : ' exited with code ' + run.out.code));
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

console.log('Running ' + suites.length + ' test suite(s), ' + concurrency + ' at a time...\n');
for (var startAt = 0; startAt < concurrency; startAt++) startNext();
