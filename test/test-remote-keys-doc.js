// Tests for docs/development/remote-keys.md and the facts it is made from: each
// key's LG button name against LG's key table as read on a TV, and the page
// being up to date with the KEYS list.
var assert = require('assert');
var fs = require('fs');
var rk = require('../server/lib/remotekeys');
var doc = require('../scripts/gen-remote-keys-doc');

console.log('Running test-remote-keys-doc.js ...');

// 1. The key table is read as button name, LG's code and Qt key
var table = rk.readKeyTable(doc.KEY_TABLE);
assert.deepEqual(table.IR_KEY_INPUT_HUB, { code: 1031, qt: 'Key_Video' });
assert.deepEqual(table.IR_KEY_NETFLIX, { code: 1045, qt: 'Key_webOS_Netflix' });
assert.deepEqual(rk.readKeyTable('/nonexistent/keycodes'), {}, 'no file, no table');
assert.strictEqual(rk.qtName('Qt.Key_Video'), 'Key_Video');
assert.strictEqual(rk.qtName('WebOS.Key_webOS_TVGuide'), 'Key_webOS_TVGuide');
console.log('  ✓ the key table is read as button name, code and Qt key');

// 2. Each key's LG name has, in that table, the Qt key of the symbol its filter matches on
rk.KEYS.forEach(function (k) {
  if (k.keyTable) assert.ok(k.lg && k.symbol, k.key + ': a key checked against the key table needs lg and symbol');
  if (!k.lg) return;
  assert.ok(/^(IR|RF)_KEY_[A-Z0-9_]+$/.test(k.lg), k.key + ': lg looks like LG\'s button name');
  assert.ok(table[k.lg], k.key + ': ' + k.lg + ' is not in the key table');
  assert.strictEqual(table[k.lg].qt, rk.qtName(k.symbol), k.key + ': ' + k.lg + ' is ' + table[k.lg].qt + ' there');
  if (k.log) assert.ok(/^KEY_[A-Z0-9_]+$/.test(k.log), k.key + ': log looks like lginput2\'s button_type');
});
console.log('  ✓ each key\'s LG button name has its symbol\'s Qt key in the key table');

// 3. The page is made from them and up to date
assert.strictEqual(fs.readFileSync(doc.OUT, 'utf8'), doc.render(),
  'docs/development/remote-keys.md is out of date: run node scripts/gen-remote-keys-doc.js');
console.log('  ✓ docs/development/remote-keys.md is up to date');

console.log('test-remote-keys-doc.js passed');
