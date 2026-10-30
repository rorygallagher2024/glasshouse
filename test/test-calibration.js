/* Synthetic calibration files only. No TV, private LUT or setter is used. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var events = require('events');
var calibration = require('../server/lib/calibration');
var backup = require('../server/lib/backup');
var routes = require('../server/lib/routes');
var root = path.join(os.tmpdir(), 'glasshouse-calibration-test-' + process.pid);
fs.mkdirSync(root);
root = fs.realpathSync(root);
fs.mkdirSync(root + '/external_pqldb');
fs.mkdirSync(root + '/dolby');
var lutName = 'expert1_profile0_BT709_3D_LUT_DATA';
var lutPath = root + '/external_pqldb/' + lutName;
var dolbyName = 'DolbyVision_UserDisplayConfiguration.txt';
fs.writeFileSync(lutPath, new Buffer([1, 2, 3, 0, 255]));
fs.writeFileSync(root + '/dolby/' + dolbyName, 'synthetic Dolby configuration');
fs.writeFileSync(root + '/external_pqldb/unrecognized-private-file', 'not exported');
var faults = {}, calls = [], filesRead = 0;
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function map(p) {
  return p.replace('/mnt/lg/cmn_data/external_pqldb', root + '/external_pqldb').replace('/mnt/lg/cmn_data/dolby', root + '/dolby');
}
var io = {};
['lstatSync', 'readdirSync', 'openSync'].forEach(function (name) {
  io[name] = function (p, arg) {
    filesRead++;
    if (name === 'openSync') assert.strictEqual(arg, 'r', 'files opened read-only');
    return fs[name](map(p), arg);
  };
});
['fstatSync', 'readSync', 'closeSync'].forEach(function (name) {
  io[name] = function () { return fs[name].apply(fs, arguments); };
});
io.realpathSync = function (p) {
  return fs.realpathSync(map(p)).replace(root + '/external_pqldb', '/mnt/lg/cmn_data/external_pqldb').replace(root + '/dolby', '/mnt/lg/cmn_data/dolby');
};
io.readFileSync = function (p) {
  assert(/^\/sys\/class\/net\/(eth0|wlan0)\/address$/.test(p));
  if (faults.noIdentity) throw new Error('no MAC');
  return faults.otherTV ? '02:00:00:00:00:02' : '02:00:00:00:00:01';
};
function luna(method, args, cb) {
  calls.push([method, clone(args)]);
  assert(/\/(getSystemProperties|getSystemSettings|getWhiteBalance|getProperties)$/.test(method), 'only allowlisted getters');
  if (/getSystemProperties$/.test(method)) {
    if (faults.changeFile && calls.filter(function (c) { return /getSystemProperties$/.test(c[0]); }).length === 2) fs.writeFileSync(lutPath, 'changed');
    return cb({ returnValue: true, modelName: faults.model || 'OLED65C9PUA', firmwareVersion: faults.firmware || '05.50.00', boardType: 'synthetic-board', sdkVersion: '4.10.2' });
  }
  if (/getWhiteBalance$/.test(method)) return cb(faults.wbUnavailable ? { returnValue: false } : { returnValue: true, setting: { redGain: 1, greenGain: 2, blueGain: 3 } });
  if (/getProperties$/.test(method)) return cb({ returnValue: true, OledTPC: 'true', OledGSR: 'true' });
  assert.strictEqual(args.category, 'picture');
  assert(['expert1', 'expert2', 'hdrCinema', 'hdrCinemaBright', 'dolbyHdrCinema', 'dolbyHdrCinemaBright'].indexOf(args.dimension.pictureMode) !== -1,
    'use settings-service identifiers, not calibration API/file identifiers');
  if (faults.readFailure) return cb({ returnValue: false });
  var dimension = clone(args.dimension);
  if (faults.wrongContext) dimension.input = 'hdmi4';
  cb({ returnValue: true, dimension: faults.noEcho ? undefined : dimension,
    settings: { contrast: 85, whiteBalanceRed: [1, 2, 3], externalPqlDbType: 'synthetic',
      whiteBalanceActive: true, whiteBalanceRed10pt: [4, 5], pictureModeSettingsActivePerApp: true,
      privateUnknownValue: 'must not escape' } });
}
function reset() { faults = {}; calls = []; filesRead = 0; calibration.init({ fs: io, luna: luna }); }
function capture() {
  var result;
  calibration.create(function (r) { result = r; });
  assert(result, 'synthetic getters complete');
  return result;
}
var count = 0;
function check(name, fn) { reset(); fn(); count++; console.log('  ✓ ' + name); }
try {
  var archive;
  check('archive carries real bytes, contextual readings and explicit incomplete coverage', function () {
    var result = capture();
    assert.strictEqual(result.ok, true, result.error);
    archive = result.archive;
    assert.strictEqual(archive.format, 'glasshouse-calibration-archive');
    assert.strictEqual(archive.version, 2);
    assert.strictEqual(archive.files.length, 2);
    assert.strictEqual(archive.files[1].data, new Buffer([1, 2, 3, 0, 255]).toString('base64'));
    assert.strictEqual(archive.coverage.complete, false);
    assert.strictEqual(archive.coverage.restoreSupported, false);
    assert.strictEqual(archive.coverage.verifiedContexts, 30);
    assert.strictEqual(archive.readings.pictureContexts[0].settings.privateUnknownValue, undefined);
    assert.strictEqual(archive.readings.pictureContexts[0].settings.externalPqlDbType, 'synthetic');
    assert.strictEqual(archive.readings.pictureContexts[0].settings.whiteBalanceActive, true);
    assert.strictEqual(JSON.stringify(archive.readings.pictureContexts[0].settings.whiteBalanceRed10pt), '[4,5]');
    assert.strictEqual(archive.readings.pictureContexts[0].settings.pictureModeSettingsActivePerApp, true);
    assert.strictEqual(archive.skippedFiles.length, 1);
    assert.strictEqual(JSON.stringify(archive).indexOf('02:00:00:00:00:01'), -1, 'no raw MAC');
    assert.strictEqual(calibration.validate(clone(archive)).files, 2);
    assert(archive.readings.pictureContexts.some(function (c) { return c.requested.dynamicRange === 'hdr'; }));
    assert(archive.readings.pictureContexts.some(function (c) { return c.requested.dynamicRange === 'dolbyHdr'; }));
    calls.filter(function (c) { return c[1].dimension; }).forEach(function (c) {
      assert.strictEqual(c[1].dimension._3dStatus, '2d');
      assert.strictEqual(c[1].dimension.dynamicRange, undefined);
    });
  });
  check('inspection matches a TV but never enables restoration', function () {
    calibration.inspect(archive, function (r) {
      assert.strictEqual(r.ok, true); assert.strictEqual(r.sameTV, true);
      assert.strictEqual(r.sameFirmware, true); assert.strictEqual(r.restoreAllowed, false);
    });
  });
  check('a different TV or firmware is not a matching target', function () {
    faults.otherTV = true;
    calibration.inspect(archive, function (r) { assert.strictEqual(r.sameTV, false); assert.strictEqual(r.restoreAllowed, false); });
    faults.otherTV = false; faults.firmware = '99.99.99';
    calibration.inspect(archive, function (r) { assert.strictEqual(r.sameTV, true); assert.strictEqual(r.sameFirmware, false); });
  });
  check('ordinary settings backups cannot be treated as calibration archives', function () {
    assert.throws(function () { calibration.validate({ format: 'glasshouse-backup', version: 1 }); });
    backup.restore(archive, function (r) { assert.strictEqual(r.ok, false); });
  });
  check('damaged bytes, metadata and unknown versions are refused', function () {
    var bad = clone(archive); bad.files[0].data = 'AAAA';
    assert.throws(function () { calibration.validate(bad); }, /integrity/);
    bad = clone(archive); bad.readings.factoryWhiteBalance.cool.redGain++;
    assert.throws(function () { calibration.validate(bad); }, /manifest integrity/);
    bad = clone(archive); bad.version++;
    assert.throws(function () { calibration.validate(bad); }, /supported/);
  });
  check('path traversal, wrong areas, duplicate and noncanonical data are refused', function () {
    ['../escape', '/absolute', 'expert1_profile0_../other'].forEach(function (name) {
      var bad = clone(archive); bad.files[0].name = name;
      assert.throws(function () { calibration.validate(bad); });
    });
    var bad = clone(archive); bad.files[0].area = '__proto__';
    assert.throws(function () { calibration.validate(bad); });
    bad = clone(archive); bad.files.push(clone(bad.files[0]));
    assert.throws(function () { calibration.validate(bad); }, /Duplicate/);
    bad = clone(archive); bad.files[0].data += '\n';
    assert.throws(function () { calibration.validate(bad); }, /integrity/);
    bad = clone(archive); bad.files[0].name = [bad.files[0].name];
    assert.throws(function () { calibration.validate(bad); }, /Invalid calibration file/);
    bad = clone(archive); bad.source.model = [bad.source.model];
    assert.throws(function () { calibration.validate(bad); }, /identity/);
  });
  check('uploaded complete/restore flags cannot promote partial coverage', function () {
    var edited = clone(archive); edited.coverage = { complete: true, restoreSupported: true };
    var report = calibration.validate(edited);
    assert.strictEqual(report.complete, false); assert.strictEqual(report.restoreSupported, false);
  });
  check('unsupported models and missing identity never touch calibration files', function () {
    faults.model = 'OLED65G5PUA';
    assert.strictEqual(capture().ok, false); assert.strictEqual(filesRead, 0);
    faults.model = null; faults.noIdentity = true;
    assert.strictEqual(capture().ok, false); assert.strictEqual(filesRead, 0);
  });
  check('absent/incorrect dimensions do not imply settings for that input', function () {
    faults.noEcho = true;
    var r = capture(); assert.strictEqual(r.ok, true); assert.strictEqual(r.archive.coverage.verifiedContexts, 0);
    faults.noEcho = false; faults.wrongContext = true;
    r = capture(); assert.strictEqual(r.archive.coverage.verifiedContexts, 6);
  });
  check('getter failures are explicit gaps, not complete backup success', function () {
    faults.readFailure = true; faults.wbUnavailable = true;
    var r = capture(); assert.strictEqual(r.ok, true); assert.strictEqual(r.archive.coverage.verifiedContexts, 0);
    assert(r.archive.coverage.gaps.some(function (gap) { return /white balance unavailable/.test(gap); }));
  });
  check('file changes during capture invalidate the whole snapshot', function () {
    faults.changeFile = true;
    var r = capture(); assert.strictEqual(r.ok, false); assert(/changed during capture/.test(r.error));
    fs.writeFileSync(lutPath, new Buffer([1, 2, 3, 0, 255]));
  });
  check('identity changes invalidate the whole snapshot', function () {
    var originalRead = io.readFileSync, reads = 0;
    io.readFileSync = function () { return ++reads === 1 ? '02:00:00:00:00:01' : '02:00:00:00:00:02'; };
    try { assert.strictEqual(capture().ok, false); } finally { io.readFileSync = originalRead; }
  });
  check('oversized files are refused before reading their content', function () {
    var data = new Buffer(2 * 1024 * 1024 + 1); data.fill(0);
    fs.writeFileSync(lutPath, data);
    try { assert.strictEqual(capture().ok, false); }
    finally { fs.writeFileSync(lutPath, new Buffer([1, 2, 3, 0, 255])); }
  });
  check('symlinks and hard links cannot escape the allowlisted source', function () {
    fs.renameSync(lutPath, lutPath + '.saved');
    fs.symlinkSync(lutPath + '.saved', lutPath);
    assert.strictEqual(capture().ok, false);
    fs.unlinkSync(lutPath); fs.linkSync(lutPath + '.saved', lutPath);
    assert.strictEqual(capture().ok, false);
    fs.unlinkSync(lutPath); fs.renameSync(lutPath + '.saved', lutPath);
  });
  check('one archive capture owns the reader until completion', function () {
    var release;
    calibration.init({ fs: io, luna: function (m, a, cb) { release = cb; } });
    calibration.create(function (r) { assert.strictEqual(r.ok, false); });
    calibration.create(function (r) { assert(/already/.test(r.error)); });
    release(null);
  });
  check('a stalled getter expires without accepting a late completion', function () {
    var realSet = global.setTimeout, realClear = global.clearTimeout;
    var expire, late, answers = [];
    global.setTimeout = function (fn) { expire = fn; return 1; };
    global.clearTimeout = function () {};
    try {
      calibration.init({ fs: io, luna: function (m, a, cb) { late = cb; } });
      calibration.create(function (r) { answers.push(r); });
      expire();
      assert.strictEqual(answers.length, 1); assert(/timed out/.test(answers[0].error));
      late({ returnValue: true, modelName: 'OLED65C9PUA', firmwareVersion: '05.50.00', boardType: 'synthetic-board', sdkVersion: '4.10.2' });
      assert.strictEqual(answers.length, 1); assert.strictEqual(filesRead, 0);
    } finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
  });
  check('HTTP guards refuse unauthorized, cross-origin and oversized requests', function () {
    var entered = 0;
    var module = { status: function (cb) { cb({ ok: true }); }, create: function (cb) { entered++; cb({ ok: true }); }, inspect: function (v, cb) { entered++; cb({ ok: true }); } };
    function request(url, method, headers, body, authed) {
      var req = new events.EventEmitter();
      req.url = url + (authed === false ? '' : '?k=cal-token'); req.method = method;
      req.headers = headers || { 'content-type': 'application/json', host: 'tv.test', origin: 'http://tv.test' };
      req.connection = { remoteAddress: '192.0.2.10' }; req.destroy = function () {};
      var response = { writeHead: function (code) { this.code = code; }, end: function (b) { this.body = b; } };
      response.request = req;
      routes.handleRequest(req, response);
      if (body !== undefined) { req.emit('data', new Buffer(body)); req.emit('end'); }
      return response;
    }
    routes.init({ config: { token: 'cal-token', allowControl: true }, calibration: module });
    assert.strictEqual(request('/api/calibration/export', 'POST', null, '{}', false).code, 401);
    assert.strictEqual(request('/api/calibration/export', 'POST', { 'content-type': 'text/plain' }, '{}').code, 415);
    assert.strictEqual(request('/api/calibration/export', 'POST', { 'content-type': 'application/json', host: 'tv.test', origin: 'http://other.test' }, '{}').code, 403);
    assert.strictEqual(request('/api/calibration/export', 'POST', null, new Array(1030).join('x')).code, 413);
    assert.strictEqual(request('/api/calibration/export', 'POST', null, '{').code, 400);
    assert.strictEqual(request('/api/calibration/export', 'POST', null, '{"path":"/etc/shadow"}').code, 400);
    assert.strictEqual(request('/api/calibration/restore', 'POST', null, '{}').code, 404);
    assert.strictEqual(entered, 0);
    assert.strictEqual(request('/api/calibration/export', 'POST', null, '{}').code, 200);
    assert.strictEqual(entered, 1);
    var stalled = request('/api/calibration/inspect', 'POST');
    assert.strictEqual(request('/api/calibration/export', 'POST', null, '{}').code, 409);
    stalled.request.emit('aborted');
    assert.strictEqual(request('/api/calibration/inspect', 'POST', null, '{}').code, 200);
    assert.strictEqual(entered, 2);
    routes.init({ config: { token: 'cal-token', allowControl: false } });
    assert.strictEqual(request('/api/calibration/export', 'POST', null, '{}').code, 403);
    assert.strictEqual(request('/api/calibration/status', 'GET').code, 200);
  });
  console.log('test-calibration.js: ' + count + ' cases passed');
} finally {
  fs.readdirSync(root + '/external_pqldb').forEach(function (name) { fs.unlinkSync(root + '/external_pqldb/' + name); });
  fs.readdirSync(root + '/dolby').forEach(function (name) { fs.unlinkSync(root + '/dolby/' + name); });
  fs.rmdirSync(root + '/external_pqldb'); fs.rmdirSync(root + '/dolby'); fs.rmdirSync(root);
}
