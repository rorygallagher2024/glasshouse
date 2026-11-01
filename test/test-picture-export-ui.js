var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

if (parseInt(process.versions.node.split('.')[0], 10) < 8) {
  console.log('Picture export browser tests skipped: modern dashboard JavaScript needs Node 8+.');
  process.exit(0);
}

var source = fs.readFileSync(path.join(__dirname, '../server/assets/ui/picture.js'), 'utf8');
var html = fs.readFileSync(path.join(__dirname, '../server/assets/ui.html'), 'utf8');
assert.ok(/id="pic-export"[^>]*onclick="downloadPicture\(\)"/.test(html), 'the button calls the tested handler');
var button = { disabled: false };
var error = { innerHTML: '', hidden: true };
var requests = [], files = [], clicks = [], removed = [], revoked = [], timers = [];
var fetchReply;
var context = {
  Promise: Promise,
  q: function (id) { return id === 'pic-export' ? button : error; },
  t: function (key, text) { return text; },
  esc: function (text) { return text; },
  sentence: function (text) { return text; },
  api: function (url) { return url; },
  fetch: function (url, options) {
    requests.push({ url: url, options: options });
    return fetchReply();
  },
  Blob: function (parts, options) { this.parts = parts; this.type = options.type; },
  URL: {
    createObjectURL: function (blob) { files.push(blob); return 'blob:picture'; },
    revokeObjectURL: function (url) { revoked.push(url); }
  },
  setTimeout: function (fn, delay) { timers.push({ fn: fn, delay: delay }); },
  document: {
    body: { appendChild: function (a) { assert.strictEqual(a.href, 'blob:picture'); } },
    createElement: function (tag) {
      assert.strictEqual(tag, 'a');
      return { click: function () { clicks.push(this.download); }, remove: function () { removed.push(this); } };
    }
  }
};
vm.runInNewContext(source, context, { filename: 'picture.js' });

var data = { format: 'glasshouse-picture-settings', version: 1, created: '2026-10-30T12:00:00.000Z',
  dimension: { input: 'hdmi4', pictureMode: 'cinema', dynamicRange: 'sdr' },
  settings: { contrast: { status: 'available', value: 0 }, gamma: { status: 'unavailable', value: null } } };
var complete;
fetchReply = function () { return new Promise(function (resolve) { complete = resolve; }); };
var first = context.downloadPicture();
assert.strictEqual(button.disabled, true, 'the export button is busy while reading');
context.downloadPicture();
assert.strictEqual(requests.length, 1, 'repeated clicks do not start another export');
complete({ ok: true, json: function () { return Promise.resolve(data); } });

first.then(function () {
  assert.strictEqual(requests[0].url, '/api/picture/export');
  assert.strictEqual(requests[0].options.cache, 'no-store');
  assert.strictEqual(requests[0].options.method, undefined, 'the browser uses GET');
  assert.strictEqual(files[0].type, 'application/json');
  assert.deepEqual(JSON.parse(files[0].parts[0]), data, 'downloaded JSON preserves availability and values');
  assert.deepEqual(clicks, ['glasshouse-picture-2026-10-30.json']);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(error.hidden, true);
  assert.strictEqual(timers[0].delay, 1000, 'the object URL stays alive for the download to start');
  timers[0].fn();
  assert.deepEqual(revoked, ['blob:picture']);

  fetchReply = function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({ error: 'Read failed' }); } }); };
  return context.downloadPicture();
}).then(function () {
  assert.strictEqual(error.hidden, false);
  assert.ok(error.innerHTML.indexOf('Read failed') !== -1);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(files.length, 1, 'a service error does not create a file');

  fetchReply = function () { return Promise.reject(new Error('Offline')); };
  return context.downloadPicture();
}).then(function () {
  assert.ok(error.innerHTML.indexOf('Offline') !== -1);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(files.length, 1);

  fetchReply = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ format: 'another-format', version: 1 }); } }); };
  return context.downloadPicture();
}).then(function () {
  assert.strictEqual(error.hidden, false);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(files.length, 1, 'an unexpected response is not downloaded');
  console.log('Picture export UI downloads JSON through GET, releases its URL, prevents repeated clicks and reports failures.');
}).catch(function (err) {
  console.error(err.stack || err);
  process.exit(1);
});
