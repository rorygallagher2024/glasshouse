/**
 * test/test-oled-detect.js - Panel type detection from model name and pnwash records
 */

var assert = require('assert');
var fs = require('fs');

var PNWASH = '/mnt/lg/cmn_data/pnwash/autoOffRsTime';
var present = {};
var origExists = fs.existsSync;
fs.existsSync = function (p) {
  if (present.hasOwnProperty(p)) return present[p];
  if (String(p).indexOf('/mnt/lg/') === 0 || String(p).indexOf('/var/luna/') === 0) return false;
  return origExists.apply(fs, arguments);
};

var origLog = console.log;
console.log = function () {};

function detect(model, files) {
  present = files || {};
  delete require.cache[require.resolve('../server/lib/oled')];
  var oled = require('../server/lib/oled');
  oled.init({
    config: {},
    luna: function (uri, params, cb) { cb({ returnValue: true, modelName: model }); }
  });
  var result;
  oled.detectOled(function (v) { result = v; });
  return result;
}

var cases = [
  ['OLED65C4PSA', null, true],
  ['OLED77C4PSA.AAUQLJD', null, true],
  ['42LX3Q6LA', null, true],
  ['55LX1QPUA', null, true],
  ['65ART90E6QA', null, true],
  ['27ART10AKPL', null, false],
  ['50UP81006LR', null, false],
  ['55QNED826QB', null, false],
  ['43UH610V-ZB', null, false],
  ['55XY1234', { PNWASH: 1 }, true],
  ['', { PNWASH: 1 }, true],
  ['', null, false]
];

cases.forEach(function (c) {
  var files = {};
  if (c[1]) files[PNWASH] = true;
  var got = detect(c[0], files);
  assert.strictEqual(got, c[2], (c[0] || '(no model)') + (c[1] ? ' with pnwash' : '') +
                     ': expected ' + c[2] + ', got ' + got);
});

console.log = origLog;
console.log('  ✓ OLED detection from model name, known model patterns and pnwash records');
