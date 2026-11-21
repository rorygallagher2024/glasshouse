/**
 * test/test-lutslots.js - The stored picture calibration files, by size and checksum
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var lutslots = require('../server/lib/lutslots');

console.log('Running test-lutslots.js ...');

var c = lutslots.classify('hdr_filmMaker_profile0_BT2020_3D_LUT_DATA');
assert.strictEqual(c.mode, 'hdr_filmMaker');
assert.strictEqual(c.profile, 'profile0');
assert.strictEqual(c.kind, '3d-lut');
assert.strictEqual(lutslots.classify('cinema_profile0_1D_DPG_DATA').kind, '1d-lut');
assert.strictEqual(lutslots.classify('cinema_profile0_1D_2_2_EN').kind, 'enable-flag');
assert.strictEqual(lutslots.classify('cinema_profile0_BT709_3BY3_GAMUT_DATA').kind, 'gamut-matrix');
assert.strictEqual(lutslots.classify('notes.txt'), null);

var tmp = path.join(os.tmpdir(), 'lutslots-' + process.pid);
fs.mkdirSync(tmp);
var lut = new Buffer(6144);
lut.fill(1);
fs.writeFileSync(path.join(tmp, 'cinema_profile0_1D_DPG_DATA'), lut);
fs.writeFileSync(path.join(tmp, 'cinema_profile0_1D_DPG_EN'), 'x');
fs.writeFileSync(path.join(tmp, 'readme'), 'ignored');

lutslots.init({ dir: tmp });
lutslots.readSlots(function (r) {
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.slots.length, 2);
  assert.strictEqual(r.slots[0].file, 'cinema_profile0_1D_DPG_DATA');
  assert.strictEqual(r.slots[0].bytes, 6144);
  assert.strictEqual(r.slots[0].sizeMatches, true);
  assert.strictEqual(r.slots[0].sha256.length, 64);
  assert.strictEqual(r.slots[1].sizeMatches, false);
  assert.ok(!r.slots[0].hasOwnProperty('data'));
  fs.writeFileSync(path.join(tmp, 'cinema_profile0_3D_LUT_DATA'), new Buffer(215622));
  fs.writeFileSync(path.join(tmp, 'hdr_profile0_3D_LUT_DATA'), new Buffer(10));
  var NO_FILE = 'no file path from tvservice';
  lutslots.readTable('GET_3D_LUT_DATA', 'cinema', 0, undefined, function (t) {
    assert.strictEqual(t.returnValue, true);
    assert.strictEqual(t.dataCount, 107811);
    assert.strictEqual(t.dataType, 'unsigned integer16');
    assert.strictEqual(t.source, 'stored');
    assert.strictEqual(new Buffer(t.data, 'base64').length, 215622);
    var cases = [
      ['GET_1D_DPG_DATA', 'cinema', 0], ['GET_CHARACTERISTICS', 'cinema', 0],
      ['hasOwnProperty', 'cinema', 0], ['GET_3D_LUT_DATA', undefined, 0],
      ['GET_3D_LUT_DATA', '../x', 0], ['GET_3D_LUT_DATA', 'cinema', '0/../out'],
      ['GET_3D_LUT_DATA', 'cinema', -1], ['GET_3D_LUT_DATA', 'cinema', 1.5],
      ['GET_3D_LUT_DATA', 'hdr', 0],
      ['GET_3D_LUT_DATA', 'filmMaker', 0],
      ['GET_3D_LUT_DATA', 'filmMaker', 0, 'BT2020x'], ['GET_3D_LUT_DATA', 'filmMaker', 0, '../x']
    ];
    var b709 = new Buffer(215622), b2020 = new Buffer(215622);
    b709.fill(197); b2020.fill(228);
    fs.writeFileSync(path.join(tmp, 'filmMaker_profile0_BT709_3D_LUT_DATA'), b709);
    fs.writeFileSync(path.join(tmp, 'filmMaker_profile0_BT2020_3D_LUT_DATA'), b2020);
    fs.writeFileSync(path.join(tmp, 'hdr_cinema_profile0_BT2020_3D_LUT_DATA'), b2020);
    fs.writeFileSync(path.join(tmp, 'hdr_filmMaker_profile0_BT2020_3D_LUT_DATA'), b2020);
    fs.writeFileSync(path.join(tmp, 'dolby_cinema_dark_profile0_BT2020_3D_LUT_DATA'), b2020);
    lutslots.readTable('GET_3D_LUT_DATA', 'filmMaker', 0, 'BT709', function (v) {
      assert.strictEqual(v.file, 'filmMaker_profile0_BT709_3D_LUT_DATA');
      assert.strictEqual(new Buffer(v.data, 'base64')[0], 197);
      lutslots.readTable('GET_3D_LUT_DATA', 'hdrCinema', 0, undefined, function (h) {
        assert.strictEqual(h.returnValue, true);
        assert.strictEqual(h.file, 'hdr_cinema_profile0_BT2020_3D_LUT_DATA');
        lutslots.readTable('GET_3D_LUT_DATA', 'hdrFilmMaker', 0, undefined, function (f) {
          assert.strictEqual(f.file, 'hdr_filmMaker_profile0_BT2020_3D_LUT_DATA');
          lutslots.readTable('GET_3D_LUT_DATA', 'dolbyCinemaDark', 0, undefined, function (d) {
            assert.strictEqual(d.file, 'dolby_cinema_dark_profile0_BT2020_3D_LUT_DATA');
            runCases();
          });
        });
      });
    });
    function runCases() {
    (function next(i) {
      if (i === cases.length) return finish();
      lutslots.readTable(cases[i][0], cases[i][1], cases[i][2], cases[i][3], function (bad) {
        assert.strictEqual(bad.returnValue, false, 'case ' + i);
        assert.strictEqual(bad.errorText, NO_FILE, 'case ' + i);
        next(i + 1);
      });
    })(0);
    }
  });
  function finish() {
    lutslots.init({ dir: path.join(tmp, 'absent') });
    lutslots.readSlots(function (none) {
      assert.strictEqual(none.available, false);
      fs.readdirSync(tmp).forEach(function (n) { fs.unlinkSync(path.join(tmp, n)); });
      fs.rmdirSync(tmp);
      console.log('  PASS test-lutslots.js');
    });
  }
});
