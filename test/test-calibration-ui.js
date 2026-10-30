// Browser-only controls: archive checks never call a restore endpoint.
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var elements = {};
function q(id) { return elements[id] || (elements[id] = { hidden: true, disabled: false, textContent: '', addEventListener: function () {} }); }
var calls = [], downloads = [];
var fixture = { format: 'glasshouse-calibration-archive', source: { model: 'SYNTHETIC-C9' }, created: '2026-01-01T00:00:00Z', files: [{ data: 'AQ==' }] };
var context = {
  q: q, console: console, Blob: function (data) { this.data = data; },
  URL: { createObjectURL: function () { return 'blob:synthetic'; }, revokeObjectURL: function () {} },
  document: { body: { appendChild: function () {} }, createElement: function () {
    return { click: function () { downloads.push(this.download); }, remove: function () {} };
  } },
  setTimeout: function () {}, api: function (p) { return p; },
  t: function (key, text, values) { return text.replace(/\{(\w+)\}/g, function (match, name) { return values && values[name] !== undefined ? values[name] : match; }); },
  fetch: function (url, options) {
    calls.push([url, options]);
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(url.indexOf('export') !== -1 ?
      { ok: true, archive: fixture } : { ok: true, sameTV: true, sameFirmware: true, restoreAllowed: false }); } });
  }
};
// This script runs in current-node CI; the TV never executes browser JS.
if (Number(process.versions.node.split('.')[0]) < 8) {
  console.log('test-calibration-ui.js: skipped on legacy node (modern browser script)');
} else {
  vm.createContext(context);
  var source = fs.readFileSync(require('path').join(__dirname, '../server/assets/ui/update.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('// Calibration archives are deliberately separate')), context);
  context.saveCalibrationArchive().then(function () {
    assert.strictEqual(calls[0][0], '/api/calibration/export');
    assert.strictEqual(calls[0][1].method, 'POST');
    assert.strictEqual(downloads[0], 'glasshouse-calibration-SYNTHETIC-C9-2026-01-01.json');
    assert(/Coverage is partial/.test(q('calibration-msg').textContent));
    assert.strictEqual(q('calibration-save').disabled, false);
    return context.checkCalibrationArchive({ files: [{ size: 200, text: function () { return Promise.resolve(JSON.stringify(fixture)); } }], value: 'chosen' });
  }).then(function () {
    assert.strictEqual(calls[1][0], '/api/calibration/inspect');
    assert(/restoration is not supported/.test(q('calibration-msg').textContent));
    assert(/Do not factory-reset/.test(q('calibration-msg').textContent));
    assert.strictEqual(q('calibration-check').disabled, false);
    context.fetch = function () { return Promise.reject(new Error('offline')); };
    return context.saveCalibrationArchive();
  }).then(function () {
    assert(/offline/.test(q('calibration-msg').textContent));
    assert.strictEqual(q('calibration-save').disabled, false);
    console.log('test-calibration-ui.js passed');
  }).catch(function (error) { console.error(error); process.exit(1); });
}
