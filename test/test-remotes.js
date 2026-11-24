/**
 * test/test-remotes.js - the remote catalogue (server/lib/remotes.json): its
 * keys are ones the Remote tab can set, its names find the remote, and what it
 * points at exists
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var remotes = require('../server/lib/remotes');
var remoteKeys = require('../server/lib/remotekeys');

console.log('Running test-remotes.js ...');

var EVIDENCE = ['measured', 'documented', 'assumed'];
var all = remotes.all();
var keyNames = Object.keys(remoteKeys.keyTitles());
var assetsDir = path.join(__dirname, '..', 'server', 'assets', 'remotes');

// 1. The catalogue is there and each entry is whole
assert.ok(all.length > 0, 'the catalogue has remotes');
var ids = {};
var names = {};
all.forEach(function (r) {
  assert.ok(/^[A-Z0-9]+$/.test(r.id), r.id + ': an id of capitals and digits');
  assert.ok(!ids[r.id], r.id + ' is listed once');
  ids[r.id] = true;
  assert.ok(r.title && Array.isArray(r.names) && r.names.length > 0, r.id + ': a title and the names the TV reports');
  assert.ok(EVIDENCE.indexOf(r.nameEvidence) !== -1, r.id + ': nameEvidence is one of ' + EVIDENCE.join(', '));
  r.names.forEach(function (n) {
    var norm = remotes.normalizeName(n);
    assert.ok(!names[norm], n + ' names one remote only');
    names[norm] = r.id;
  });
  assert.ok(r.numberKeys === null || typeof r.numberKeys === 'boolean', r.id + ': numberKeys is true, false or null');
  assert.strictEqual(typeof r.complete, 'boolean', r.id + ': complete is true or false');
  assert.ok(Array.isArray(r.sources) && r.sources.length > 0, r.id + ': says where its facts come from');
});
console.log('  ✓ every remote has an id, the names the TV reports, and its sources');

// 2. Keys are ones the Remote tab has, with a known kind of evidence
all.forEach(function (r) {
  remotes.keysOf(r).forEach(function (key) {
    assert.ok(keyNames.indexOf(key) !== -1, r.id + ': ' + key + ' is not a key the Remote tab can set');
    assert.ok(EVIDENCE.indexOf(r.keys[key]) !== -1, r.id + ': ' + key + ' has evidence ' + r.keys[key]);
  });
  if (r.complete) assert.ok(remotes.keysOf(r).length > 0, r.id + ' is complete with no keys');
  Object.keys(r.labels || {}).forEach(function (key) {
    assert.ok(remotes.hasKey(r, key), r.id + ': a label for ' + key + ', which it does not list');
    assert.ok(typeof r.labels[key] === 'string' && r.labels[key].trim(), r.id + ': the label for ' + key + ' is a name');
  });
});
console.log('  ✓ each key is one the Remote tab can set, with measured, documented or assumed evidence');

// 3. Pictures exist
assert.ok(fs.existsSync(path.join(assetsDir, remotes.GENERIC_IMAGE)), 'the generic picture is there');
all.forEach(function (r) {
  if (r.image) assert.ok(fs.existsSync(path.join(assetsDir, r.image)), r.id + ': ' + r.image + ' is not in server/assets/remotes');
  assert.ok(/\.png$/.test(remotes.imageFile(r)));
});
console.log('  ✓ every picture named exists, and a remote without one shows the generic outline');

// 4. A name the TV reports finds its remote
assert.strictEqual(remotes.find('LGE MR25GA').id, 'MR25GA');
assert.strictEqual(remotes.find('lge  mr25ga').id, 'MR25GA', 'case and spacing do not matter');
assert.strictEqual(remotes.find('MR25GA').id, 'MR25GA', 'nor does the LGE prefix');
assert.strictEqual(remotes.find('LGE MR99'), null, 'a remote not catalogued is not guessed');
assert.strictEqual(remotes.find(''), null);
assert.strictEqual(remotes.find(null), null);
assert.ok(remotes.hasKey(remotes.find('MR25GA'), 'channelup'));
assert.ok(!remotes.hasKey(remotes.find('MR25GA'), 'hulu'), 'a key not listed is not claimed');
assert.deepEqual(remotes.keysOf(null), []);
console.log('  ✓ names find their remote whatever their case, spacing or prefix, and an unknown one is not guessed');

// 5. Which keys fold away: only where every selected remote is known, with a finished list
var finished = { id: 'A', complete: true, keys: { netflix: 'measured', amazon: 'measured' } };
var finishedToo = { id: 'B', complete: true, keys: { amazon: 'documented', red: 'documented' } };
var unfinished = { id: 'C', complete: false, keys: { netflix: 'measured' } };
var offered = ['netflix', 'amazon', 'red', 'hulu'];
assert.deepEqual(remotes.keysOffRemotes([finished], offered), ['red', 'hulu'], 'keys the one remote lacks');
assert.deepEqual(remotes.keysOffRemotes([finished, finishedToo], offered), ['hulu'], 'a key either has stays');
assert.deepEqual(remotes.keysOffRemotes([finished, unfinished], offered), [], 'one unfinished list folds nothing');
assert.deepEqual(remotes.keysOffRemotes([finished, null], offered), [], 'nor does an unknown remote');

// 6. A key under the name the remote prints on it, where the selected remotes agree
var printsAi = { id: 'D', complete: true, keys: { voice: 'measured' }, labels: { voice: 'AI' } };
var printsAiToo = { id: 'E', complete: true, keys: { voice: 'measured', netflix: 'measured' }, labels: { voice: 'AI' } };
var plainMic = { id: 'F', complete: true, keys: { voice: 'measured' } };
assert.strictEqual(remotes.labelFor([printsAi], 'voice'), 'AI');
assert.strictEqual(remotes.labelFor([printsAi, printsAiToo], 'voice'), 'AI', 'two remotes printing the same name');
assert.strictEqual(remotes.labelFor([printsAi, finished], 'voice'), 'AI', 'a remote without the key does not count');
assert.strictEqual(remotes.labelFor([printsAi, plainMic], 'voice'), null, 'one remote with the plain name keeps it');
assert.strictEqual(remotes.labelFor([printsAi, null], 'voice'), null, 'an unknown remote keeps it too');
assert.strictEqual(remotes.labelFor([printsAiToo], 'netflix'), null, 'a key without a label');
assert.strictEqual(remotes.labelFor([], 'voice'), null, 'all buttons: no remote');
assert.strictEqual(remotes.labelFor([remotes.find('MR25GA')], 'voice'), 'AI', "the MR25GA's microphone key is its AI button");
console.log('  ✓ a key takes the name printed on the selected remotes only where they all agree');
assert.deepEqual(remotes.keysOffRemotes([], offered), [], 'nor does no remote at all');
assert.deepEqual(remotes.keysOffRemotes(null, offered), []);
console.log('  ✓ keys fold away only where every remote in use is known with a finished list');

console.log('test-remotes.js passed');
