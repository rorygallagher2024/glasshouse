/**
 * test/test-fetch.js - URL validation, client arguments and the download handle
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var fetch = require('../server/lib/fetch');

console.log('Running test-fetch.js ...');

(function testValidateUrl() {
  assert.strictEqual(fetch.validateUrl('https://example.org/a.ipk'), null);
  assert.strictEqual(fetch.validateUrl('http://10.0.0.2:8080/a.ipk?x=1'), null);
  assert.ok(fetch.validateUrl('-K/etc/x'));
  assert.ok(fetch.validateUrl('file:///etc/passwd'));
  assert.ok(fetch.validateUrl('ftp://example.org/a'));
  assert.ok(fetch.validateUrl('https://example.org/a b'));
  assert.ok(fetch.validateUrl('https://example.org/a\nb'));
  assert.ok(fetch.validateUrl('https://example.org/a\u0000b'));
  assert.ok(fetch.validateUrl('https://example.org/' + new Array(2100).join('a')));
  assert.ok(fetch.validateUrl(null));
  console.log('  ✓ validateUrl accepts http(s) and rejects options, other schemes, control characters and long input');
})();

(function testArgs() {
  fetch.init({ version: '1.2.3' });
  var big = fetch._fetchArgs('/usr/bin/curl', 'https://h/x.ipk', '/tmp/x', 'big');
  assert.strictEqual(big[big.length - 2], '--');
  assert.strictEqual(big[big.length - 1], 'https://h/x.ipk');
  assert.ok(big.join(' ').indexOf('--speed-limit 1024 --speed-time 30') > 0);
  assert.ok(big.join(' ').indexOf('--proto =http,https --proto-redir =http,https') > 0);
  assert.strictEqual(big.indexOf('--max-time'), -1);
  var wget = fetch._fetchArgs('/bin/wget', 'https://h/x.ipk', '/tmp/x', 'big');
  assert.strictEqual(wget.join(' '), '-q -T 30 -U tvweb/1.2.3 -O /tmp/x -- https://h/x.ipk');
  var text = fetch._fetchArgs('/usr/bin/curl', 'https://h/a.json', null);
  assert.strictEqual(text[text.indexOf('--max-time') + 1], '10');
  assert.strictEqual(text[text.indexOf('-o') + 1], '-');
  var file = fetch._fetchArgs('/usr/bin/curl', 'https://h/a', '/tmp/a');
  assert.strictEqual(file[file.indexOf('--max-time') + 1], '30');
  console.log('  ✓ client arguments end options before the URL and use stall limits for downloads');
})();

(function testClients() {
  var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-')) :
    (function () { var d = path.join(os.tmpdir(), 'fetch-' + process.pid); fs.mkdirSync(d); return d; })();
  // The last argument is the URL, the one before it '--', and -o names the file.
  var script = '#!/bin/sh\n' +
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done\n' +
    'echo "$out" > "' + dir + '/seen"\n' +
    'printf "0123456789" > "$out"\n' +
    'if [ -f "' + dir + '/hang" ]; then sleep 30; fi\n';
  fs.writeFileSync(path.join(dir, 'curl'), script);
  fs.chmodSync(path.join(dir, 'curl'), parseInt('755', 8));
  fetch.init({ clientDirs: [dir] });

  var out = path.join(dir, 'out.ipk');
  var ticks = [];
  fetch.download('https://example.org/a.ipk', out, { expectedSize: 10, onProgress: function (n) { ticks.push(n); } }, function (err) {
    assert.ifError(err);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), '0123456789');
    console.log('  ✓ download writes the file through the client');

    fetch.download('https://example.org/a.ipk', out, { expectedSize: 99 }, function (err2) {
      assert.ok(err2 && /expected 99/.test(err2.message));
      assert.ok(!fs.existsSync(out), 'a short file is removed');
      console.log('  ✓ download refuses a file of the wrong size');

      fetch.download('-K/etc/x', out, {}, function (err3) {
        assert.ok(err3);
        fs.writeFileSync(path.join(dir, 'hang'), '');
        var polled = [];
        var h = fetch.download('https://example.org/a.ipk', out, { onProgress: function (n) { polled.push(n); } }, function (err4) {
          assert.ok(err4 && err4.cancelled);
          assert.ok(polled.length > 0 && polled[0] === 10, 'progress followed the file size');
          assert.ok(!fs.existsSync(out), 'a cancelled download leaves no file');
          console.log('  ✓ progress follows the file and cancel kills the client');
          fetch.getJson('http://example.org/a.json', function (err5) {
            assert.ok(err5 && /https/.test(err5.message));
            console.log('  ✓ getJson refuses plain http');
            require('child_process').execFile('/bin/rm', ['-rf', dir], function () {});
            console.log('ALL test-fetch.js assertions passed!\n');
          });
        });
        setTimeout(function () { h.cancel(); }, 900);
      });
    });
  });
})();
