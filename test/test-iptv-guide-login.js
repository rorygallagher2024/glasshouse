/*
 * The owner's own guide link may carry a login, as the playlist link may: the
 * worker sends it as HTTP Basic, on curl's standard input rather than its
 * command line, and asks for the address without it. A real worker, a real
 * curl and a local provider that refuses the guide without the login.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var spawn = require('child_process').spawn;

console.log('Running test-iptv-guide-login.js ...');

var curl = ['/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl'].filter(function (p) { return fs.existsSync(p); })[0];
if (!curl || !fs.existsSync('/bin/sh')) {
  console.log('  - skipped: needs curl and /bin/sh');
  process.exit(0);
}

var USER = 'lgtv', PASS = 's@cret/1';
var dir = path.join(os.tmpdir(), 'iptv-guide-login-' + process.pid + '-' + Date.now());
fs.mkdirSync(dir);

function stamp(ms) {
  var d = new Date(ms);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + '00 +0000';
}
var now = Date.now(), hour = 3600000;
var xmltv = '<?xml version="1.0" encoding="utf-8" ?>\n<tv>\n<channel id="ch1"><display-name>One</display-name></channel>\n' +
  '<programme start="' + stamp(now - hour) + '" stop="' + stamp(now + hour) + '" channel="ch1"><title>Now</title></programme>\n' +
  '<programme start="' + stamp(now + hour) + '" stop="' + stamp(now + 2 * hour) + '" channel="ch1"><title>Next</title></programme>\n</tv>\n';

var requests = [];
var provider = http.createServer(function (req, res) {
  requests.push({ url: req.url, auth: req.headers.authorization || '' });
  var want = 'Basic ' + buf(USER + ':' + PASS).toString('base64');
  if (req.headers.authorization !== want) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tvh"' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(xmltv);
});

function buf(s) { return typeof Buffer.from === 'function' ? Buffer.from(s) : new Buffer(s); }
function quote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function remove(p) {
  if (fs.statSync(p).isDirectory()) {
    fs.readdirSync(p).forEach(function (n) { remove(path.join(p, n)); });
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

provider.listen(0, '127.0.0.1', function () {
  var port = provider.address().port;
  var client = path.join(dir, 'curl');
  // Records every argument curl is started with, then runs the real one.
  fs.writeFileSync(client, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + quote(path.join(dir, 'args')) + '\nexec ' + quote(curl) + ' "$@"\n');
  fs.chmodSync(client, 493);
  var candidate = path.join(dir, 'candidate');
  var worker = spawn(process.execPath, [path.join(__dirname, '../server/lib/iptv-worker.js')]);
  var stdout = '', stderr = '';
  worker.stdout.on('data', function (d) { stdout += d; });
  worker.stderr.on('data', function (d) { stderr += d; });
  worker.on('error', function (err) { throw err; });
  var timer = setTimeout(function () { worker.kill('SIGKILL'); }, 15000);
  worker.on('close', function (code, signal) {
    clearTimeout(timer);
    assert.strictEqual(signal, null, stderr);
    var replies = stdout.split('\n').filter(Boolean).map(function (s) { return JSON.parse(s); });
    var results = replies.filter(function (r) { return r.done || r.error; });
    assert.equal(results.length, 1, 'one final answer');
    assert.strictEqual(results[0].done, true, 'the guide behind a login is read: ' + JSON.stringify(results[0]));
    assert.equal(code, 0, stderr);
    assert.equal(results[0].matched, 1, 'the channel is matched by its id');
    var nn = JSON.parse(fs.readFileSync(path.join(candidate, 'nownext.json'), 'utf8'));
    assert.equal(nn.ch.c1[0][2], 'Now', 'the programme on now is written');
    console.log('  ✓ a guide link with a login is read with the login as HTTP Basic');

    assert.equal(requests.length, 1, 'one request reaches the provider');
    assert.equal(requests[0].url, '/guide.xml');
    var args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    assert.equal(args.indexOf(PASS), -1, 'the password is on no command line');
    assert.equal(args.indexOf('@127.0.0.1'), -1, 'the address is asked for without its login');
    console.log('  ✓ the password goes to curl on its standard input, not its command line');

    provider.close(function () {
      remove(dir);
      console.log('ALL test-iptv-guide-login.js assertions passed!\n');
    });
  });
  var url = 'http://' + USER + ':' + encodeURIComponent(PASS) + '@127.0.0.1:' + port + '/guide.xml';
  worker.stdin.write(JSON.stringify({ type: 'guide', tmp: candidate, clients: [client], ua: 'test',
    urls: [url], channels: [{ key: 'c1', epgId: 'ch1', name: 'One', fav: true }] }) + '\n');
});
