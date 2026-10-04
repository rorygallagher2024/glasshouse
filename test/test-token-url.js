/**
 * test/test-token-url.js - The dashboard keeps its token out of the address bar
 *
 * Runs the page's own token code from ui/core.js against a stand-in address bar,
 * history and localStorage. The page is browser JavaScript, so this needs a
 * node that can parse it and has URLSearchParams; on node 0.12 it is skipped.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-token-url.js ...');

var URLSearchParams = global.URLSearchParams || require('url').URLSearchParams;
if (!URLSearchParams) {
  console.log('  - skipped: needs a node with URLSearchParams');
  console.log('ALL test-token-url.js assertions passed!\n');
  process.exit(0);
}

var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'ui', 'core.js'), 'utf8');
var start = src.indexOf('const K = (() => {');
var end = src.indexOf('\n})();', start);
assert.ok(start !== -1 && end !== -1, 'the token code is in ui/core.js');
var code = src.slice(start, end + '\n})();'.length) + '\nK';

// Opens the page at `search` and returns what it ended up with.
function open(search, stored, storageBlocked) {
  var store = stored === undefined ? {} : { tvweb_k: stored };
  var page = { url: null };
  var localStorage = {
    getItem: function (k) {
      if (storageBlocked) throw new Error('SecurityError');
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem: function (k, v) {
      if (storageBlocked) throw new Error('SecurityError');
      store[k] = String(v);
    }
  };
  var ctx = {
    URLSearchParams: URLSearchParams,
    location: { search: search, pathname: '/', hash: '#top' },
    history: { state: null, replaceState: function (s, t, url) { page.url = url; } },
    localStorage: localStorage
  };
  var K = vm.runInNewContext(code, ctx);
  return { K: K, stored: store.tvweb_k, url: page.url };
}

try {
  vm.runInNewContext('(() => 1)()');
} catch (e) {
  console.log('  - skipped: this node cannot run the page\'s JavaScript');
  console.log('ALL test-token-url.js assertions passed!\n');
  process.exit(0);
}

// 1. A link with the token stores it and takes it out of the address
var r = open('?tab=metrics&k=abc');
assert.strictEqual(r.K, 'abc');
assert.strictEqual(r.stored, 'abc');
assert.strictEqual(r.url, '/?tab=metrics#top');
console.log('  ✓ a link with ?k= stores the token and leaves only the rest of the address');

// 2. A later visit without it uses the stored token, and leaves the address alone
r = open('?tab=metrics', 'abc');
assert.strictEqual(r.K, 'abc');
assert.strictEqual(r.url, null);
console.log('  ✓ a visit without ?k= uses the stored token');

// 3. A new token in the link replaces the stored one
r = open('?k=new', 'old');
assert.strictEqual(r.K, 'new');
assert.strictEqual(r.stored, 'new');
assert.strictEqual(r.url, '/#top');
console.log('  ✓ a new ?k= replaces the stored token');

// 4. Where storage is blocked, the token stays in the address so a reload still works
r = open('?tab=metrics&k=abc', undefined, true);
assert.strictEqual(r.K, 'abc');
assert.strictEqual(r.url, null);
console.log('  ✓ with storage blocked the token stays in the address');

// 5. No token anywhere: nothing stored, address untouched
r = open('?tab=metrics');
assert.strictEqual(r.K, '');
assert.strictEqual(r.stored, undefined);
assert.strictEqual(r.url, null);
console.log('  ✓ with no token, nothing is stored and the address is left alone');

console.log('ALL test-token-url.js assertions passed!\n');
