/* One-shot capture payloads, output verification and failure cleanup. ES5. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var screenshots = require('../server/lib/screenshots');
var directory = path.join(os.tmpdir(), 'tvweb-screenshots-' + process.pid);
fs.mkdirSync(directory);
var mode = '', calls = [], pending = null;
function luna(uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  if (mode === 'throw') throw new Error('capture threw');
  function answer() {
    if (mode !== 'missing') fs.writeFileSync(payload.path, mode === 'empty' ? '' : 'png');
    cb(mode === 'malformed' ? 'not json' : mode === 'failure' ? { returnValue: false, errorText: 'No video is playing' } : JSON.stringify({ returnValue: true, capturedWidth: 0 }));
  }
  if (mode === 'pending') pending = answer;
  else process.nextTick(answer);
}
screenshots.init({ directory: directory, luna: luna });
var methods = ['DISPLAY', 'VIDEO', 'GRAPHIC'];
var resolutions = ['3840x2160', '1920x1080', '960x540'];
var cases = [];
methods.forEach(function (method) {
  resolutions.forEach(function (resolution) { cases.push([method, resolution]); });
});
function captureSizes() {
  if (!cases.length) return captureDefault();
  var pair = cases.shift();
  screenshots.capture(pair[0], function (result) {
    assert.strictEqual(result.ok, true);
    assert.ok(/^capture_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png$/.test(result.id));
    var call = calls[calls.length - 1];
    var size = pair[1].split('x');
    assert.strictEqual(call.uri, 'com.webos.service.capture/executeOneShot');
    assert.deepEqual(call.payload, { path: path.join(directory, result.id), method: pair[0], format: 'PNG', width: +size[0], height: +size[1] });
    captureSizes();
  }, pair[1]);
}
function captureDefault() {
  screenshots.capture('DISPLAY', function (result) {
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls[calls.length - 1].payload.width, 1920);
    assert.strictEqual(calls[calls.length - 1].payload.height, 1080);
    var count = calls.length;
    screenshots.capture('INVALID', function (r) { assert.strictEqual(r.ok, false); });
    screenshots.capture('DISPLAY', function (r) { assert.strictEqual(r.ok, false); }, '1280x720');
    assert.strictEqual(calls.length, count);
    captureFailures();
  });
}
var failures = ['failure', 'malformed', 'missing', 'empty', 'throw'];
function captureFailures() {
  if (!failures.length) return captureOverlap();
  mode = failures.shift();
  screenshots.capture('VIDEO', function (result) {
    assert.strictEqual(result.ok, false, mode);
    assert.strictEqual(fs.existsSync(calls[calls.length - 1].payload.path), false, mode);
    captureFailures();
  });
}
function captureOverlap() {
  mode = 'pending';
  screenshots.capture('DISPLAY', function (r) {
    assert.strictEqual(r.ok, true);
    screenshots.init({ directory: directory, luna: null });
    screenshots.capture('DISPLAY', function (missing) { assert.strictEqual(missing.ok, false); });
    captureNotifications();
  });
  screenshots.capture('DISPLAY', function (r) { assert.strictEqual(r.ok, false); });
  mode = '';
  pending();
}

function captureNotifications() {
  var controls = require('../server/lib/controls');
  var notices = [], noticeMode = '', pendingNotice = null;
  controls.init({ config: { allowControl: true }, toastSource: 'com.webos.app.home',
    luna: function (uri, payload, cb, appId) {
      assert.ok(fs.statSync(calls[calls.length - 1].payload.path).size > 0, 'notification follows verified output');
      assert.strictEqual(uri, 'com.webos.notification/createToast');
      assert.strictEqual(payload.sourceId, 'com.webos.app.home');
      assert.strictEqual(appId, 'com.webos.app.home');
      assert.strictEqual(payload.message, 'Screenshot saved.');
      notices.push(payload);
      if (noticeMode === 'throw') throw new Error('notification threw');
      if (noticeMode === 'pending') { pendingNotice = cb; return; }
      cb({ returnValue: noticeMode !== 'refuse' });
    }
  });
  screenshots.init({ directory: directory, luna: luna,
    notify: function (message, cb) { controls.doControl('toast', message, cb); }
  });
  var noticeModes = ['success', 'refuse', 'pending', 'throw'];
  (function check() {
    if (!noticeModes.length) {
      mode = 'failure';
      return screenshots.capture('DISPLAY', function (result) {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(notices.length, 4, 'failed captures send no success notice');
        fs.readdirSync(directory).forEach(function (name) { fs.unlinkSync(path.join(directory, name)); });
        fs.rmdirSync(directory);
        console.log('test-screenshots.js passed');
      });
    }
    noticeMode = noticeModes.shift();
    var timeout = setTimeout(function () { throw new Error('capture waited for notification delivery'); }, 5000);
    screenshots.capture('DISPLAY', function (result) {
      clearTimeout(timeout);
      assert.strictEqual(result.ok, true, 'notification failure or delay cannot fail or hold a capture');
      if (pendingNotice) { pendingNotice({ returnValue: false }); pendingNotice = null; }
      check();
    });
  })();
}
captureSizes();
