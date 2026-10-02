/**
 * test/test-fetch.js - URL validation, client arguments and the download handle
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var fetch = require('../server/lib/fetch');

console.log('Running test-fetch.js ...');

/*
 * Fake curls that record the address family flag they were given. Runs after
 * the other tests, since the fetch module remembers the client that last worked.
 */
function retries(done) {
  var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ip-')) :
    (function () { var d = path.join(os.tmpdir(), 'fetch-ip-' + process.pid); fs.mkdirSync(d); return d; })();
  var log = path.join(dir, 'log');
  var cfg = {};
  function install(name, body) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho "$*" >> "' + log + '"\n' + body);
    fs.chmodSync(path.join(dir, name), parseInt('755', 8));
  }
  // The family flag of each call, '' for none.
  function calls() {
    var text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    return text.split('\n').filter(Boolean).map(function (l) {
      return l.split(' ').filter(function (a) { return a === '-4' || a === '-6'; })[0] || '';
    });
  }
  function reset() { try { fs.unlinkSync(log); } catch (e) {} }
  // Connects only when given `flag`, else exits 7 (no connection).
  function curlWorking(flag) {
    install('curl', 'for a in "$@"; do [ "$a" = "' + flag + '" ] && { echo \'{"ok":1}\'; exit 0; }; done\n' +
                    'echo "curl: (7) Failed to connect" >&2\nexit 7\n');
  }
  function init() { fetch.init({ clientDirs: [dir], config: cfg }); }
  init();

  curlWorking('-6');
  fetch.getJson('https://example.org/a.json', function (err, doc) {
    assert.ifError(err);
    assert.strictEqual(doc.ok, 1);
    assert.deepEqual(calls(), ['', '-6']);
    console.log('  ✓ a curl that cannot connect is retried with -6');

    reset();
    curlWorking('-4');
    fetch.getJson('https://example.org/a.json', function (err2) {
      assert.ifError(err2);
      assert.deepEqual(calls(), ['', '-6', '-4']);
      console.log('  ✓ then with -4');

      reset();
      curlWorking('-x');
      fetch.getJson('https://example.org/a.json', function (err3) {
        assert.ok(err3 && err3.offline, 'every attempt failing is offline');
        assert.ok(/could not reach example\.org/.test(err3.message));
        assert.deepEqual(calls(), ['', '-6', '-4']);
        console.log('  ✓ when every attempt fails the TV is reported offline');

        reset();
        install('curl', 'echo "curl: (28) Connection timed out" >&2\nexit 28\n');
        fetch.getJson('https://example.org/a.json', function (err4) {
          assert.ok(err4 && err4.offline);
          assert.strictEqual(calls().length, 3);
          console.log('  ✓ a timeout (28) is retried the same way');

          reset();
          install('curl', 'echo "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n');
          fetch.getJson('https://example.org/a.json', function (err5) {
            assert.ok(err5 && !err5.offline);
            assert.strictEqual(calls().length, 1, 'an HTTP error is not retried');
            console.log('  ✓ an HTTP error is not retried');

            reset();
            cfg.fetch = { ip: '6' };
            curlWorking('-6');
            fetch.getJson('https://example.org/a.json', function (err6) {
              assert.ifError(err6);
              assert.deepEqual(calls(), ['-6']);
              cfg.fetch = { ip: '4' };
              reset();
              fetch.getJson('https://example.org/a.json', function (err7) {
                assert.ifError(err7);
                assert.deepEqual(calls(), ['-4', '-6']);
                console.log('  ✓ fetch.ip names the first family and the other is the retry');
                cfg.fetch = {};
                downloads();
              });
            });
          });
        });
      });
    });
  });

  function downloads() {
    var out = path.join(dir, 'x.ipk');
    // Nothing written yet: the same as a connection that never came up.
    reset();
    curlWorking('-6');
    fetch.download('https://example.org/a.ipk', out, {}, function (err) {
      assert.ifError(err);
      assert.deepEqual(calls(), ['', '-6']);
      console.log('  ✓ a download that never started is retried');

      // Bytes already written: the download is not restarted.
      reset();
      install('curl', 'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done\n' +
                      'printf abc > "$out"\nexit 28\n');
      fetch.download('https://example.org/a.ipk', out, {}, function (err2) {
        assert.ok(err2 && /stalled/.test(err2.message));
        assert.strictEqual(calls().length, 1);
        console.log('  ✓ a download that stalled part-way is not restarted');

        // Our own cancel is not a network failure.
        reset();
        install('curl', 'sleep 30\nexit 7\n');
        var h = fetch.download('https://example.org/a.ipk', out, {}, function (err3) {
          assert.ok(err3 && err3.cancelled);
          setTimeout(function () {
            assert.strictEqual(calls().length, 1, 'a cancelled download is not retried');
            console.log('  ✓ a cancelled download is not retried');
            wgetCase();
          }, 300);
        });
        setTimeout(function () { h.cancel(); }, 300);
      });
    });
  }

  function wgetCase() {
    // busybox wget has no -4 or -6, so it gets one attempt.
    fs.unlinkSync(path.join(dir, 'curl'));
    reset();
    install('wget', 'echo "wget: can\'t connect to remote host" >&2\nexit 1\n');
    fetch.getJson('https://example.org/a.json', function (err) {
      assert.ok(err && err.offline);
      assert.strictEqual(calls().length, 1);
      console.log('  ✓ wget is not retried');
      require('child_process').execFile('/bin/rm', ['-rf', dir], function () {});
      done();
    });
  }
}

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
  assert.strictEqual(text[text.indexOf('--connect-timeout') + 1], '5');
  assert.strictEqual(text[text.indexOf('-o') + 1], '-');
  var file = fetch._fetchArgs('/usr/bin/curl', 'https://h/a', '/tmp/a');
  assert.strictEqual(file[file.indexOf('--max-time') + 1], '30');
  assert.strictEqual(file[file.indexOf('--connect-timeout') + 1], '5');
  assert.strictEqual(big[big.indexOf('--connect-timeout') + 1], '30');
  var v6 = fetch._fetchArgs('/usr/bin/curl', 'https://h/a.json', null, 'text', '-6');
  assert.strictEqual(v6[1], '-6');
  assert.strictEqual(fetch._fetchArgs('/bin/wget', 'https://h/a.json', null, 'text', '-6').indexOf('-6'), -1);
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
            retries(function () {
              console.log('ALL test-fetch.js assertions passed!\n');
            });
          });
        });
        setTimeout(function () { h.cancel(); }, 900);
      });
    });
  });
})();
