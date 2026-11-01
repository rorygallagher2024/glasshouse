/*
 * A separate, read-only calibration archive. Never enters calibration mode,
 * switches inputs, loads a LUT, writes picture settings or opens an I2C device.
 * Strict ES5 for node 0.10/0.12. Missing coverage never becomes restore support.
 */
var fs = require('fs');
var crypto = require('crypto');
var say = require('./say');
var msg = say.msg;
var FORMAT = 'glasshouse-calibration-archive';
var VERSION = 2;
var MAX_BYTES = 8 * 1024 * 1024;
var MAX_FILE = 2 * 1024 * 1024;
var MAX_FILES = 128;
var MAX_ARCHIVE = 12 * 1024 * 1024;
var WB_KEYS = ['redGain', 'greenGain', 'blueGain', 'redOffset', 'greenOffset', 'blueOffset'];
var ROOTS = { external_pqldb: '/mnt/lg/cmn_data/external_pqldb', dolby: '/mnt/lg/cmn_data/dolby' };
var SYSTEM = 'com.webos.service.tv.systemproperty/getSystemProperties';
var SETTINGS = 'com.webos.service.settings/getSystemSettings';
var WB = 'com.webos.service.tv.systemproperty/getWhiteBalance';
var PICTURE_KEYS = [
  'backlight', 'contrast', 'brightness', 'color', 'tint', 'gamma', 'colorGamut',
  'colorTemperature', 'whiteBalanceColorTemperature', 'whiteBalanceMethod',
  'whiteBalanceIre', 'whiteBalanceRed', 'whiteBalanceGreen', 'whiteBalanceBlue',
  'whiteBalanceRedGain', 'whiteBalanceRedOffset', 'whiteBalanceGreenGain',
  'whiteBalanceGreenOffset', 'whiteBalanceBlueGain', 'whiteBalanceBlueOffset',
  'whiteBalanceLuminance', 'dynamicContrast', 'hdrDynamicToneMapping', 'blackLevel',
  'peakBrightness', 'energySaving', 'dynamicColor',
  // These C9 declarations affect which stored calibration and WB controls
  // are selected. Keep them as evidence; capture never applies their values.
  'externalPqlDbType', 'whiteBalanceActive', 'whiteBalanceApplyAllInputs',
  'whiteBalancePoint', 'whiteBalanceCodeValue', 'whiteBalanceCodeValue10pt',
  'whiteBalanceIre10pt', 'whiteBalanceRed10pt', 'whiteBalanceGreen10pt',
  'whiteBalanceBlue10pt', 'wb10PointsGammaValue', 'wb22PointsGammaValue',
  'pictureModeSettingsActivePerApp', 'pictureSettingModified', 'pcMode'
];
['Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow'].forEach(function (colour) {
  ['Saturation', 'Hue', 'Luminance'].forEach(function (part) { PICTURE_KEYS.push('colorManagement' + part + colour); });
});
var LEGACY_MODES = [
  ['sdr', 'expert1'], ['sdr', 'expert2'], ['hdr', 'hdr_cinema'],
  ['hdr', 'hdr_cinema_bright'], ['dolbyHdr', 'dolby_cinema_dark'], ['dolbyHdr', 'dolby_cinema_bright']
];
// Settings-service identifiers differ from the underscore names used by the
// calibration API and stored LUT files. These are the C9's described values.
var MODES = [
  ['sdr', 'expert1'], ['sdr', 'expert2'], ['hdr', 'hdrCinema'],
  ['hdr', 'hdrCinemaBright'], ['dolbyHdr', 'dolbyHdrCinema'], ['dolbyHdr', 'dolbyHdrCinemaBright']
];
var lunaFn = null;
var io = fs;
var busy = false;

function init(opts) { lunaFn = opts.luna; io = opts.fs || fs; busy = false; }
function fail(message) { throw new Error(message); }
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sameContext(a, b) {
  return object(a) && object(b) && Object.keys(a).length === 3 &&
    a.input === b.input && a.pictureMode === b.pictureMode && a.dynamicRange === b.dynamicRange;
}
function nativeDimension(context) {
  return { input: context.input, pictureMode: context.pictureMode, _3dStatus: '2d' };
}
function sameNativeContext(a, b) {
  return object(a) && object(b) && Object.keys(a).length === 3 &&
    a.input === b.input && a.pictureMode === b.pictureMode && a._3dStatus === b._3dStatus;
}
function reportedContextMatches(reported, context) {
  if (!object(reported)) return false;
  var native = nativeDimension(context);
  var keys = Object.keys(reported);
  return keys.length >= 3 && keys.length <= 4 &&
    keys.every(function (key) { return ['input', 'pictureMode', '_3dStatus', 'dynamicRange'].indexOf(key) !== -1; }) &&
    reported.input === native.input && reported.pictureMode === native.pictureMode && reported._3dStatus === '2d' &&
    (reported.dynamicRange === undefined || reported.dynamicRange === context.dynamicRange);
}
function call(method, args, cb) {
  if (!lunaFn) return cb(null);
  lunaFn(method, args, function (reply) { cb(reply && reply.returnValue === true ? reply : null); });
}

/* Read identity from the TV, not editable Glasshouse config. The binding is
 * private; a MAC change invalidates matching rather than claiming a new panel.
 * A mainboard identity cannot prove that a panel has never been replaced.
 */
function identity(cb) {
  call(SYSTEM, { keys: ['modelName', 'firmwareVersion', 'boardType', 'sdkVersion'] }, function (r) {
    if (!r || !['modelName', 'firmwareVersion', 'boardType', 'sdkVersion'].every(function (key) {
      return typeof r[key] === 'string' && r[key].length > 0 && r[key].length <= 128;
    })) return cb(null);
    var mac = null;
    ['/sys/class/net/eth0/address', '/sys/class/net/wlan0/address'].some(function (p) {
      try {
        var value = String(io.readFileSync(p, 'utf8')).trim().toLowerCase();
        if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(value) && value !== '00:00:00:00:00:00') mac = value;
      } catch (e) {}
      return !!mac;
    });
    if (!mac) return cb(null);
    cb({ model: r.modelName, firmware: r.firmwareVersion, board: r.boardType, sdk: r.sdkVersion,
      binding: hash('glasshouse-calibration-v1\n' + r.modelName + '\n' + r.boardType + '\n' + mac) });
  });
}
function supported(id) { return object(id) && typeof id.model === 'string' && /^OLED\d{2}C9[A-Z0-9]+$/.test(id.model) && id.firmware === '05.50.00'; }
function status(cb) {
  identity(function (id) {
    cb({ ok: true, captureSupported: !!supported(id), restoreSupported: false,
      model: id ? id.model : null, firmware: id ? id.firmware : null });
  });
}

function allowed(area, name) {
  if (area === 'dolby') return name === 'DolbyVision_UserDisplayConfiguration.txt';
  return area === 'external_pqldb' &&
    /^(expert[12]|hdr_cinema(?:_bright)?|dolby_cinema_(?:dark|bright))_profile0_(?:1D_(?:0_45_EN|2_2_EN|DPG_DATA|TONEMAP_PARAM)|BT(?:709|2020)_(?:3BY3_GAMUT_DATA|3D_LUT_DATA)|DOLBY_CFG_DATA)$/.test(name);
}
function safeRoot(area) {
  var root = ROOTS[area];
  var s = io.lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || io.realpathSync(root) !== root) fail(msg('srv.calibration.unsafeDirectory', 'Calibration directory is not a real directory'));
  return root;
}
function readFile(area, name) {
  var root = safeRoot(area);
  var path = root + '/' + name;
  var s = io.lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > MAX_FILE) fail(msg('srv.calibration.unsafeFile', 'Unsafe calibration file'));
  var fd = io.openSync(path, 'r');
  try {
    var opened = io.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== s.ino || opened.dev !== s.dev) fail(msg('srv.calibration.fileChangedBeforeRead', 'Calibration file changed before read'));
    // A bounded descriptor read avoids unbounded allocation if the file grows.
    var buffer = new Buffer(MAX_FILE + 1);
    var size = 0, got;
    while ((got = io.readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
      size += got;
      if (size > MAX_FILE) fail(msg('srv.calibration.fileTooLarge', 'Calibration file is too large'));
    }
    var after = io.fstatSync(fd);
    var final = io.lstatSync(path);
    if (size !== s.size || after.size !== s.size || after.mtime.getTime() !== s.mtime.getTime() ||
        final.ino !== s.ino || final.dev !== s.dev || final.isSymbolicLink()) fail(msg('srv.calibration.fileChangedDuringRead', 'Calibration file changed during read'));
    return buffer.slice(0, size);
  } finally { io.closeSync(fd); }
}
function captureFiles() {
  var files = [], skipped = [], bytes = 0;
  Object.keys(ROOTS).sort().forEach(function (area) {
    var root;
    try { root = safeRoot(area); } catch (e) {
      if (e.code === 'ENOENT') { skipped.push(area + ': directory absent'); return; }
      throw e;
    }
    var names = io.readdirSync(root).sort();
    if (names.length > MAX_FILES) fail(msg('srv.calibration.tooManyEntries', 'Too many calibration entries'));
    names.forEach(function (name) {
      if (!allowed(area, name)) { skipped.push(area + '/' + String(name).slice(0, 128)); return; }
      var data = readFile(area, name);
      bytes += data.length;
      if (bytes > MAX_BYTES || files.length >= MAX_FILES) fail(msg('srv.calibration.archiveTooLarge', 'Calibration archive is too large'));
      files.push({ area: area, name: name, size: data.length, sha256: hash(data), data: data.toString('base64') });
    });
  });
  return { files: files, skipped: skipped };
}
function contexts(version) {
  var result = [];
  ['default', 'hdmi1', 'hdmi2', 'hdmi3', 'hdmi4'].forEach(function (input) {
    (version === 1 ? LEGACY_MODES : MODES).forEach(function (mode) { result.push({ input: input, dynamicRange: mode[0], pictureMode: mode[1] }); });
  });
  return result;
}
function pick(values) {
  var result = {};
  if (!object(values)) return result;
  PICTURE_KEYS.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key]; });
  return result;
}
function readings(cb, active) {
  var out = { factoryWhiteBalance: {}, pictureContexts: [], oledProtection: null };
  var temperatures = ['cool', 'medium', 'warm'];
  var wanted = contexts();
  function nextTemperature() {
    if (!active()) return;
    var t = temperatures.shift();
    if (!t) return nextContext();
    call(WB, { colorTemp: t }, function (r) {
      // The raw reply is evidence for this getter, not a restorable LUT.
      out.factoryWhiteBalance[t] = r && object(r.setting) ? r.setting : null;
      nextTemperature();
    });
  }
  function nextContext() {
    if (!active()) return;
    var dimension = wanted.shift();
    if (!dimension) {
      return call('com.webos.service.tv.systemproperty/getProperties', { keys: ['OledTPC', 'OledGSR'] }, function (r) {
        out.oledProtection = r ? { OledTPC: r.OledTPC, OledGSR: r.OledGSR } : null;
        cb(out);
      });
    }
    // On the C9, adjustment keys use input/pictureMode/_3dStatus. The
    // pictureMode selector alone uses dynamicRange instead of pictureMode.
    var queryDimension = nativeDimension(dimension);
    // A named key absent on this firmware makes the C9 refuse the entire
    // read. Read the category, then retain only the calibration allowlist.
    call(SETTINGS, { category: 'picture', dimension: queryDimension }, function (r) {
      var values = pick(r && r.settings);
      var echoed = r && object(r.dimension) ? r.dimension : null;
      out.pictureContexts.push({ requested: dimension, queryDimension: queryDimension, reported: echoed, settings: values,
        contextVerified: !!(reportedContextMatches(echoed, dimension) && Object.keys(values).length) });
      nextContext();
    });
  }
  nextTemperature();
}
function coverage(archive) {
  var rows = archive.readings.pictureContexts;
  var verified = rows.filter(function (r) { return r.contextVerified; }).length;
  var gaps = ['EEPROM is not captured', 'Coverage is limited to allowlisted settings in six named 2D profiles per input',
    'Only allowlisted stored calibration files are captured', 'Factory-reset restore is not qualified'];
  ['cool', 'medium', 'warm'].forEach(function (t) {
    var values = archive.readings.factoryWhiteBalance[t];
    if (!object(values) || !WB_KEYS.every(function (key) { return typeof values[key] === 'number' && isFinite(values[key]); })) gaps.push('Factory white balance unavailable or incomplete: ' + t);
  });
  if (verified !== rows.length) gaps.push('One or more picture contexts were not confirmed by the TV');
  return { complete: false, integrity: 'verified', restoreSupported: false,
    files: archive.files.length, verifiedContexts: verified, requestedContexts: rows.length,
    gaps: gaps };
}
function manifestHash(archive) {
  var manifest = { created: archive.created, source: archive.source,
    files: archive.files.map(function (f) { return { area: f.area, name: f.name, size: f.size, sha256: f.sha256 }; }),
    skippedFiles: archive.skippedFiles, readings: archive.readings };
  if (archive.version >= 2) { manifest.format = archive.format; manifest.version = archive.version; }
  return hash(JSON.stringify(manifest));
}

function create(cb) {
  if (busy) return cb({ ok: false, error: msg('srv.calibration.busy', 'A calibration archive is already being read') });
  busy = true;
  var finished = false;
  var timer = setTimeout(function () { done({ ok: false, error: msg('srv.calibration.timeout', 'Calibration capture timed out; no archive was created') }); }, 40000);
  function active() { return !finished; }
  function done(r) { if (finished) return; finished = true; clearTimeout(timer); busy = false; cb(r); }
  identity(function (before) {
    if (!active()) return;
    if (!supported(before)) return done({ ok: false, error: msg('srv.calibration.unsupported', 'Calibration archives currently require a C9 on firmware 05.50.00 with a readable TV identity') });
    var first;
    try { first = captureFiles(); } catch (e) { return done({ ok: false, error: e.message }); }
    if (!first.files.length) return done({ ok: false, error: msg('srv.calibration.noFiles', 'No supported stored calibration files were found') });
    readings(function (a) {
      readings(function (b) {
        identity(function (after) {
          if (!active()) return;
          try {
            var second = captureFiles();
            if (!same(first, second) || !same(a, b) || !same(before, after)) fail(msg('srv.calibration.unstableSnapshot', 'Calibration data changed during capture; try again without changing picture settings'));
            var archive = { format: FORMAT, version: VERSION, created: new Date().toISOString(),
              source: before, files: first.files, skippedFiles: first.skipped, readings: a };
            archive.coverage = coverage(archive);
            archive.manifestSha256 = manifestHash(archive);
            if (Buffer.byteLength(JSON.stringify(archive), 'utf8') > MAX_ARCHIVE) fail(msg('srv.calibration.inspectionLimit', 'Calibration archive exceeds the inspection size limit'));
            done({ ok: true, archive: archive });
          } catch (e) { done({ ok: false, error: e.message }); }
        });
      }, active);
    }, active);
  });
}

/* Untrusted archive inspection has no filesystem target and no setter. Its
 * coverage is recomputed, never trusted from an uploaded "complete" flag.
 */
function validate(archive) {
  if (!object(archive) || archive.format !== FORMAT || [1, VERSION].indexOf(archive.version) === -1) fail(msg('srv.calibration.invalidArchive', 'Not a supported calibration archive'));
  if (typeof archive.created !== 'string' || !Array.isArray(archive.skippedFiles)) fail(msg('srv.calibration.invalidMetadata', 'Invalid calibration metadata'));
  var id = archive.source;
  if (!supported(id) || typeof id.binding !== 'string' || !/^[0-9a-f]{64}$/.test(id.binding) ||
      !['board', 'sdk'].every(function (key) { return typeof id[key] === 'string' && id[key].length > 0 && id[key].length <= 128; })) fail(msg('srv.calibration.invalidIdentity', 'Invalid calibration identity'));
  if (!Array.isArray(archive.files) || !archive.files.length || archive.files.length > MAX_FILES) fail(msg('srv.calibration.invalidFileList', 'Invalid calibration file list'));
  var seen = {}, total = 0;
  archive.files.forEach(function (f) {
    if (!object(f) || typeof f.area !== 'string' || typeof f.name !== 'string' || !allowed(f.area, f.name) || typeof f.data !== 'string' || f.data.length > 4 * Math.ceil(MAX_FILE / 3)) fail(msg('srv.calibration.invalidFile', 'Invalid calibration file'));
    var key = f.area + '/' + f.name;
    if (seen[key]) fail(msg('srv.calibration.duplicateFile', 'Duplicate calibration file'));
    seen[key] = true;
    var data = new Buffer(f.data, 'base64');
    total += data.length;
    if (data.toString('base64') !== f.data || data.length !== f.size || data.length > MAX_FILE || total > MAX_BYTES || hash(data) !== f.sha256) fail(msg('srv.calibration.fileIntegrity', 'Calibration file integrity failed'));
  });
  var readingsValue = archive.readings;
  if (!object(readingsValue) || !object(readingsValue.factoryWhiteBalance) || !Array.isArray(readingsValue.pictureContexts) || readingsValue.pictureContexts.length !== contexts(archive.version).length) fail(msg('srv.calibration.invalidReadings', 'Invalid calibration readings'));
  var expected = contexts(archive.version);
  readingsValue.pictureContexts.forEach(function (r, index) {
    var query = nativeDimension(expected[index]);
    var dimensionVerified = object(r) && (r.queryDimension
      ? sameNativeContext(r.queryDimension, query) && reportedContextMatches(r.reported, r.requested)
      : sameContext(r.reported, r.requested));
    if (!object(r) || !sameContext(r.requested, expected[index]) || !object(r.settings) || Object.keys(r.settings).some(function (key) { return PICTURE_KEYS.indexOf(key) === -1; }) ||
        (r.queryDimension && !sameNativeContext(r.queryDimension, query)) ||
        typeof r.contextVerified !== 'boolean' || (r.contextVerified && (!dimensionVerified || !Object.keys(r.settings).length))) fail(msg('srv.calibration.invalidContext', 'Invalid picture context'));
  });
  if (archive.manifestSha256 !== manifestHash(archive)) fail(msg('srv.calibration.manifestIntegrity', 'Calibration manifest integrity failed'));
  return coverage(archive);
}
function inspect(archive, cb) {
  var report;
  try { report = validate(archive); } catch (e) { return cb({ ok: false, error: e.message }); }
  identity(function (current) {
    cb({ ok: true, coverage: report, sameTV: !!(current && current.binding === archive.source.binding),
      sameFirmware: !!(current && same(current, archive.source)), restoreAllowed: false,
      reason: msg('srv.calibration.noRestore', 'Archive integrity can be checked; calibration restoration is not supported yet. Do not factory-reset the TV relying on this archive alone.') });
  });
}
module.exports = { init: init, status: status, create: create, inspect: inspect, validate: validate, FORMAT: FORMAT, MAX_BYTES: MAX_BYTES };
