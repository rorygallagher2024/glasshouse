/**
 * test/test-home-date.js - Glasshouse Home writes the date in the page's language
 *
 * Runs dateText from home.html as the TV's browser would: webOS leaves the
 * default locale at en-US whatever the TV's language, so only the page's own
 * language gives the right words. The line starts with a capital, as a
 * Russian or Spanish weekday on its own does not. Needs a node with full
 * ICU; skipped otherwise.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-home-date.js ...');

function hasRussian() {
  try { return new Date(2026, 9, 24).toLocaleDateString('ru', { month: 'long' }) === 'октябрь'; } catch (e) { return false; }
}
if (!hasRussian()) {
  console.log('  - skipped: needs a node with full ICU');
  console.log('ALL test-home-date.js assertions passed!\n');
  process.exit(0);
}

var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'home.html'), 'utf8');
var start = src.indexOf('  function dateText(d) {');
var end = src.indexOf('\n  }\n', start);
assert.ok(start !== -1 && end !== -1, 'dateText is in home.html');
var code = src.slice(start, end + '\n  }\n'.length) + '\ndateText';

// The TV's default locale, used wherever the page does not name one.
function tvLocale(l) { return l === undefined ? 'en-US' : l; }

// A Saturday, 24 October 2026, as the TV's browser formats it.
function tvDate() {
  var d = new Date(2026, 9, 24);
  var own = d.toLocaleDateString;
  d.toLocaleDateString = function (l, opts) { return own.call(d, tvLocale(l), opts); };
  return d;
}

// The browser's Intl, at the TV's default locale; `old` drops formatToParts,
// which webOS 4's browser does not have.
function tvIntl(old) {
  function DateTimeFormat(l, opts) {
    var f = new Intl.DateTimeFormat(tvLocale(l), opts);
    return old ? { format: f.format.bind(f) } : f;
  }
  return { DateTimeFormat: DateTimeFormat };
}

function dateIn(lang, old) {
  var ctx = {
    Intl: tvIntl(old),
    I18N: { lang: function () { return lang; } },
    t: function (_key, english, vars) {
      return english.replace(/\{(\w+)\}/g, function (_m, name) { return vars[name]; });
    }
  };
  ctx.window = ctx;
  return vm.runInNewContext(code, ctx)(tvDate());
}

// 1. A Russian page gets Russian words, the month as it reads after a number
assert.strictEqual(dateIn('ru'), 'Суббота 24 октября');
console.log('  ✓ Russian page: weekday and month in Russian, month after its day, line capitalised');

// 2. An English page reads as before
assert.strictEqual(dateIn('en'), 'Saturday 24 October');
console.log('  ✓ English page unchanged');

// 3. Without formatToParts the words are still the page's language
assert.strictEqual(dateIn('es', true), 'Sábado 24 octubre');
console.log('  ✓ older browser: page language, month on its own');

console.log('ALL test-home-date.js assertions passed!\n');
