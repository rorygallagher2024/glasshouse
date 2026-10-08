/**
 * test/test-names.js - Each raw value the TV reports has its display name and
 * its Prometheus label from the one table
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var names = require('../server/lib/names');

console.log('Running test-names.js ...');

function phy(raw, clock) {
  var m = names.hdmiPhyMode(raw, clock);
  return [m.display, m.label, m.bitsPerSecond];
}

assert.deepEqual(phy('FRL 12G 4L(R6)', null), ['FRL 48 Gbps', 'frl_48', 48e9]);
assert.deepEqual(phy('FRL 10G 4L', null), ['FRL 40 Gbps', 'frl_40', 40e9]);
assert.deepEqual(phy('FRL 8G 4L', null), ['FRL 32 Gbps', 'frl_32', 32e9]);
assert.deepEqual(phy('FRL 6G 4L', null), ['FRL 24 Gbps', 'frl_24', 24e9]);
assert.deepEqual(phy('FRL 6G 3L', null), ['FRL 18 Gbps', 'frl_18', 18e9]);
assert.deepEqual(phy('FRL 3G 3L', null), ['FRL 9 Gbps', 'frl_9', 9e9]);
console.log('  ✓ FRL is the lane rate times the lanes');

assert.deepEqual(phy('6G', 594000), ['TMDS (6G)', 'tmds_6g', 594000 * 1000 * 10 * 3]);
assert.deepEqual(phy('3G', 148500), ['TMDS (3G)', 'tmds_3g', 148500 * 1000 * 10 * 3]);
assert.deepEqual(phy('6G', null), ['TMDS (6G)', 'tmds_6g', null]);
assert.deepEqual(phy('3G', 0), ['TMDS (3G)', 'tmds_3g', null]);
console.log('  ✓ TMDS is the character clock on three channels, with no rate without a clock');

assert.deepEqual(phy('FRL CTS', null), ['FRL CTS', 'other', null]);
console.log('  ✓ an unknown PHY mode is shown as given and labelled other');

function both(m) { return [m.display, m.label]; }

assert.deepEqual(both(names.hdmiChroma('R444')), ['RGB 4:4:4', 'rgb_444']);
assert.deepEqual(both(names.hdmiChroma('Y444')), ['YCbCr 4:4:4', 'ycbcr_444']);
assert.deepEqual(both(names.hdmiChroma('Y422')), ['YCbCr 4:2:2', 'ycbcr_422']);
assert.deepEqual(both(names.hdmiChroma('Y420')), ['YCbCr 4:2:0', 'ycbcr_420']);
assert.deepEqual(both(names.hdmiChroma('Y440')), ['Y440', 'y440']);
console.log('  ✓ chroma, and an unknown one shown as given');

assert.deepEqual(both(names.hdmiHdcp('HDCP23')), ['HDCP 2.3', '2_3']);
assert.deepEqual(both(names.hdmiHdcp('HDCP22')), ['HDCP 2.2', '2_2']);
assert.deepEqual(both(names.hdmiHdcp('HDCP14')), ['HDCP 1.4', '1_4']);
assert.deepEqual(both(names.hdmiHdcp('HDCP0')), ['None', 'none']);
assert.deepEqual(both(names.hdmiHdcp('HDCP2X')), ['HDCP2X', 'hdcp2_x']);
console.log('  ✓ HDCP, and an unknown version shown as given');

function range(raw) {
  var r = names.dynamicRange(raw);
  return [r.display, r.label, r.lowLatency];
}

assert.deepEqual(range('sdr'), ['SDR', 'sdr', false]);
assert.deepEqual(range('hdr'), ['HDR', 'hdr', false]);
assert.deepEqual(range('dolbyHdr'), ['Dolby Vision', 'dolby_vision', false]);
assert.deepEqual(range('technicolorHdr'), ['Technicolor HDR', 'technicolor', false]);
assert.deepEqual(range('hdrALLM'), ['HDR · Low latency', 'hdr', true]);
assert.deepEqual(range('dolbyHdrALLM'), ['Dolby Vision · Low latency', 'dolby_vision', true]);
assert.deepEqual(range('technicolorHdrALLM'), ['Technicolor HDR · Low latency', 'technicolor', true]);
console.log('  ✓ dynamic range, with ALLM read off as low latency');

assert.deepEqual(range('hdr10Plus'), ['HDR10 Plus', 'hdr10_plus', false]);
assert.deepEqual(range('hlgALLM'), ['HLG · Low latency', 'hlg', true]);
console.log('  ✓ an unknown dynamic range is shown readably and keeps its own label');

assert.strictEqual(names.signalHdrType('NONE').label, 'sdr');
assert.strictEqual(names.signalHdrType('HDR10').label, 'hdr10');
assert.strictEqual(names.signalHdrType('DOLBY_VISION').label, 'dolby_vision');
assert.strictEqual(names.signalHdrType('DOLBY_LL').label, 'dolby_vision_low_latency');
assert.strictEqual(names.signalHdrType('HdrTypeNew').label, 'hdr_type_new');
console.log('  ✓ HDR type, snake-cased where the table has no name');

assert.deepEqual([0, 1, 2, 3].map(function (c) { return names.signalEotf(c).label; }), ['sdr', 'hdr', 'pq', 'hlg']);
assert.strictEqual(names.signalEotf(4), null);
console.log('  ✓ EOTF, with no name for a reserved code');

assert.strictEqual(names.signalColorimetry('BT2020_RGBORYCbCr').label, 'bt2020_rgb_or_ycbcr');
assert.strictEqual(names.signalColorimetry('BT709').label, 'bt709');
assert.strictEqual(names.signalEncoding('RGB').label, 'rgb_444');
assert.strictEqual(names.signalEncoding('YCbCr444').label, 'ycbcr_444');
assert.strictEqual(names.signalEncoding('YCbCr422').label, 'ycbcr_422');
assert.strictEqual(names.signalEncoding('YCbCr420').label, 'ycbcr_420');
assert.strictEqual(names.signalEncoding('YCbCr440').label, 'ycb_cr440');
console.log('  ✓ colorimetry and pixel encoding, and unknown ones in snake case');

function mode(raw) { return both(names.pictureMode(raw)); }

assert.deepEqual(mode('normal'), ['Standard', 'standard']);
assert.deepEqual(mode('hdrCinemaBright'), ['HDR Cinema Bright', 'cinema_bright']);
assert.deepEqual(mode('dolbyHdrCinemaBright'), ['Dolby Vision Cinema Bright', 'cinema_bright']);
assert.deepEqual(mode('hdrFilmMaker'), ['HDR Filmmaker', 'filmmaker']);
assert.deepEqual(mode('expert1'), ['ISF Expert (Bright)', 'expert_bright']);
assert.deepEqual(mode('hdrEffect'), ['HDR Effect', 'hdr_effect']);
console.log('  ✓ picture mode, labelled by its base mode');

assert.deepEqual(mode('hdrExternal'), ['HDR External', 'standard']);
assert.deepEqual(mode('dolbyHdrDarkAmazon'), ['Dolby Vision Dark Amazon', 'cinema_bright']);
assert.deepEqual(mode('dolbyHdrCinemaHome'), ['Dolby Vision Cinema Home', 'dolby_hdr_cinema_home']);
console.log('  ✓ a picture mode named one way only is named the other as an unknown one');

assert.deepEqual(mode('dolbyHdrSomethingNew'), ['Dolby Vision Something New', 'dolby_hdr_something_new']);
assert.deepEqual(mode('hdrSomethingNew'), ['HDR Something New', 'hdr_something_new']);
assert.deepEqual(mode('somethingNew'), ['Something New', 'something_new']);
console.log('  ✓ an unknown picture mode is spelled out and keeps its own label');
