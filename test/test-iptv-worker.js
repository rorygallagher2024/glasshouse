/*
 * The worker recovers an aborted downloader without replaying a partial body.
 * Real processes and a local provider; the shell simulates webOS's SIGABRT
 * before curl runs. The native libuv fault itself needs a Node 8 webOS TV.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var spawn = require('child_process').spawn;

console.log('Running test-iptv-worker.js ...');

var curl = ['/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl'].filter(function (p) { return fs.existsSync(p); })[0];
if (!curl || !fs.existsSync('/bin/sh')) {
  console.log('  - skipped: needs curl and /bin/sh');
  process.exit(0);
}

var dir = path.join(os.tmpdir(), 'iptv-worker-' + process.pid + '-' + Date.now());
fs.mkdirSync(dir);
var providerHits = 0;
var provider = http.createServer(function (req, res) {
  providerHits++;
  res.end('#EXTM3U\n#EXTINF:-1 group-title="News",Test News\nhttp://example.test/live.m3u8\n');
});

function quote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function remove(p) {
  if (fs.statSync(p).isDirectory()) {
    fs.readdirSync(p).forEach(function (n) { remove(path.join(p, n)); });
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

var cases = [
  { name: 'an early abort is retried', fault: 'if [ ! -e aborted ]; then touch aborted; kill -ABRT $$; fi', attempts: 2, ok: true },
  { name: 'a second abort fails without a third attempt', fault: 'kill -ABRT $$', attempts: 2, code: 'aborted' },
  { name: 'a partial body is never replayed', fault: 'printf "#EXTM3U\\n#EXTINF:-1,Partial\\nhttp://example.test/partial\\n"\nkill -ABRT $$', attempts: 1 },
  { name: 'an ordinary network failure is not retried', fault: 'exit 7', attempts: 1 },
  { name: 'another signal is not treated as an early abort', fault: 'kill -TERM $$', attempts: 1 }
];

function run(i) {
  if (i === cases.length) {
    assert.equal(providerHits, 1, 'only the recovered attempt reaches the provider');
    return provider.close(function () {
      remove(dir);
      console.log('ALL test-iptv-worker.js assertions passed!\n');
    });
  }
  var test = cases[i];
  var work = path.join(dir, String(i));
  fs.mkdirSync(work);
  var client = path.join(work, 'curl');
  fs.writeFileSync(client, '#!/bin/sh\nulimit -c 0\ncd ' + quote(work) + ' || exit 1\necho attempt >> attempts\n' +
    test.fault + '\nexec ' + quote(curl) + ' "$@"\n');
  fs.chmodSync(client, 493);
  var candidate = path.join(work, 'candidate');
  var worker = spawn(process.execPath, [path.join(__dirname, '../server/lib/iptv-worker.js')]);
  var stdout = '', stderr = '';
  worker.stdout.on('data', function (d) { stdout += d; });
  worker.stderr.on('data', function (d) { stderr += d; });
  worker.on('error', function (err) { throw err; });
  var timer = setTimeout(function () { worker.kill('SIGKILL'); }, 15000);
  worker.on('close', function (code, signal) {
    clearTimeout(timer);
    assert.strictEqual(signal, null, stderr);
    assert.equal(code, test.ok ? 0 : 1, stderr);
    var replies = stdout.split('\n').filter(Boolean).map(function (s) { return JSON.parse(s); });
    var results = replies.filter(function (r) { return r.done || r.error; });
    assert.equal(results.length, 1, 'one final answer');
    if (test.ok) {
      assert.strictEqual(results[0].done, true, test.name);
      assert.equal(results[0].channels, 1, 'no duplicate channel');
      var meta = JSON.parse(fs.readFileSync(path.join(candidate, 'meta.json'), 'utf8'));
      assert.equal(meta.channels, 1);
      assert.equal(fs.readFileSync(path.join(candidate, 'index.tsv'), 'utf8').trim().split('\n').length, 1);
    } else {
      assert.equal(results[0].error.code, test.code || 'network', test.name);
      assert.ok(!fs.existsSync(candidate), 'no partial snapshot survives');
    }
    var attempts = fs.readFileSync(path.join(work, 'attempts'), 'utf8').trim().split('\n').length;
    assert.equal(attempts, test.attempts, test.name);
    console.log('  ✓ ' + test.name);
    run(i + 1);
  });
  worker.stdin.write(JSON.stringify({ type: 'playlist', tmp: candidate, clients: [client],
    source: { kind: 'm3u', url: 'http://127.0.0.1:' + provider.address().port + '/playlist.m3u' } }) + '\n');
}

provider.listen(0, '127.0.0.1', function () { run(0); });
