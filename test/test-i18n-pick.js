/**
 * test/test-i18n-pick.js - which language server/assets/i18n.js picks: the
 * browser's, unless it is translated only in part and does not cover the page
 * (PARTIAL), and one chosen or asked for in the address whatever it covers
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-i18n-pick.js ...');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'i18n.js'), 'utf8');

// i18n.js run as a page would, with the browser's language, its stored choice
// and the page's address; it returns the I18N it sets up.
function load(opts) {
  var store = {};
  if (opts.stored) store.lang = opts.stored;
  var win = {
    navigator: { languages: [opts.browser], language: opts.browser },
    location: { pathname: opts.page, search: opts.search || '' },
    localStorage: {
      getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    document: {
      readyState: 'complete',
      documentElement: { setAttribute: function () {} },
      querySelectorAll: function () { return []; },
      addEventListener: function () {}
    },
    XMLHttpRequest: function () {
      this.open = function () {};
      this.send = function () { this.status = 200; this.responseText = '{}'; };
    }
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  return win.I18N;
}

var HOME = '/assets/home.html', TV = '/assets/dashboard.html', WEB = '/';

// German covers Glasshouse Home in full and nothing else.
assert.strictEqual(load({ browser: 'de-DE', page: HOME }).lang(), 'de', 'Glasshouse Home, which German covers');
assert.strictEqual(load({ browser: 'de-DE', page: WEB }).lang(), 'en', 'not the dashboard, which it does not');
assert.strictEqual(load({ browser: 'de-DE', page: TV }).lang(), 'en', 'nor the TV app');
console.log('  ✓ a partial language is picked from the browser only on the pages it covers');

assert.strictEqual(load({ browser: 'de-DE', page: WEB, stored: 'de' }).lang(), 'de', 'chosen in the list');
assert.strictEqual(load({ browser: 'en-US', page: WEB, search: '?lang=de' }).lang(), 'de', 'asked for in the address');
console.log('  ✓ chosen, or asked for in the address, it is used on every page');

// A complete language follows the browser on every page.
[HOME, TV, WEB].forEach(function (p) {
  assert.strictEqual(load({ browser: 'es-ES', page: p }).lang(), 'es', p);
});
assert.strictEqual(load({ browser: 'fr-FR', page: WEB }).lang(), 'en', 'a language without a file');
console.log('  ✓ a complete language follows the browser everywhere');

var web = load({ browser: 'en-GB', page: WEB });
assert.strictEqual(web.complete('de'), false, 'the list marks German as partial on the dashboard');
assert.strictEqual(web.complete('es'), true);
assert.strictEqual(web.names.de, 'Deutsch');
console.log('  ✓ the list knows which languages are partial');

console.log('ALL test-i18n-pick.js assertions passed!');
