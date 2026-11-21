/**
 * test/test-compat.js - lib/compat's table: each webOS version tried, untried
 * or not offered, the report links filled in from the TV, and the docs'
 * compatibility table saying the same as the code.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var compat = require('../server/lib/compat');

console.log('Running test-compat.js ...');

assert.strictEqual(compat.standing('home', '9.2.2'), 'tried');
assert.strictEqual(compat.standing('home', '8.3.0'), 'untried');
assert.strictEqual(compat.standing('home', '12.0.1'), 'untried');
assert.strictEqual(compat.standing('home', '2.2.3'), 'untried', 'no version is known not to run Glasshouse Home');
assert.strictEqual(compat.standing('inputBar', '11.2.0'), 'unsupported');
assert.strictEqual(compat.standing('inputBar', '3.9.3'), 'unsupported');
assert.strictEqual(compat.standing('inputBar', null), 'untried', 'a version not read is untried, not refused');
console.log('  ✓ each version is tried, untried or not offered');

var tv = { webos: '8.3.0', model: 'OLED55C34LA', firmware: '33.20.75', glasshouse: '0.151.0' };
var untried = compat.info('home', tv);
assert.strictEqual(untried.reason, undefined);
var body = decodeURIComponent(untried.report.problem.split('&body=')[1]);
assert.ok(untried.report.problem.indexOf(compat.REPO + '/issues/new?title=') === 0);
['webOS: 8.3.0', 'Model: OLED55C34LA', 'Firmware: 33.20.75', 'Glasshouse: 0.151.0'].forEach(function (line) {
  assert.ok(body.indexOf(line) !== -1, 'the report says ' + line);
});
assert.ok(decodeURIComponent(untried.report.works).indexOf(' works on webOS 8.3.0 (OLED55C34LA)') !== -1);
assert.strictEqual(compat.info('home', { webos: '9.2.2' }).report, undefined, 'no links where it is tried');
assert.ok(/remote key filters/.test(compat.info('inputBar', { webos: '3.9.3' }).reason));
assert.ok(/webOS 11/.test(compat.info('inputBar', { webos: '11.2.0' }).reason));
var bar = compat.info('inputBar', tv, 'Glasshouse Bar').report;
assert.ok(decodeURIComponent(bar.problem).indexOf('title=Glasshouse Bar does not work on webOS 8.3.0') !== -1, 'names the bar it came from');
assert.ok(decodeURIComponent(bar.works).indexOf('Feature: Glasshouse Bar\n') !== -1);
assert.ok(decodeURIComponent(compat.issueUrl('inputBar', true, tv)).indexOf('Glasshouse Bar and the input bar work on') !== -1, 'both together, plural');
assert.strictEqual(untried.report.details, 'Feature: Glasshouse Home\nwebOS: 8.3.0\nModel: OLED55C34LA\nFirmware: 33.20.75\nGlasshouse: 0.151.0', 'the details to copy');
assert.strictEqual(body.indexOf(untried.report.details), 0, 'the issue opens with the same details');
console.log('  ✓ report links carry the TV\'s webOS, model, firmware and Glasshouse version, and which bar');

// docs/tested-tvs.md's table, row by row, against the code: each cell lists
// versions as "N", "N and later" or "N and earlier".
function covers(cell, v) {
  return cell.split(',').some(function (part) {
    var m = /(\d+)( and later| and earlier)?/.exec(part);
    if (!m) return false;
    var n = parseInt(m[1], 10);
    return m[2] === ' and later' ? v >= n : m[2] === ' and earlier' ? v <= n : v === n;
  });
}
var docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tested-tvs.md'), 'utf8');
var rows = { home: 'Glasshouse Home, Minimal and custom launchers', inputBar: 'Glasshouse Bar and the input bar' };
var STANDINGS = ['tried', 'untried', 'unsupported'];
Object.keys(rows).forEach(function (id) {
  var line = docs.split('\n').filter(function (l) { return l.indexOf('| ' + rows[id] + ' |') === 0; })[0];
  assert.ok(line, 'the docs have a row for ' + rows[id]);
  var cells = line.split('|').slice(2, 5);
  for (var v = 1; v <= 14; v++) {
    var want = STANDINGS.indexOf(compat.standing(id, v + '.0'));
    var said = -1;
    cells.forEach(function (cell, i) { if (covers(cell, v)) said = i; });
    assert.strictEqual(said, want, rows[id] + ': the docs put webOS ' + v + ' under ' + STANDINGS[said] + ', the code under ' + STANDINGS[want]);
  }
});
console.log('  ✓ the docs\' table says the same as lib/compat');
console.log('test-compat.js passed');
