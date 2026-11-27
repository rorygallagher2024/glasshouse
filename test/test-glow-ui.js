// The screen glow says why it is paused while PicCap or Hue Sync captures the screen (#1776).
var fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
if (Number(process.versions.node.split('.')[0]) < 8) {
  console.log('test-glow-ui.js: browser script skipped on legacy node');
} else {
  function el(id) {
    var classes = {};
    return { id: id, hidden: true, textContent: '', title: '', attrs: {},
      setAttribute: function (k, v) { this.attrs[k] = v; },
      classList: { toggle: function (c, on) { classes[c] = on === undefined ? !classes[c] : !!on; }, add: function (c) { classes[c] = true; },
        remove: function (c) { delete classes[c]; }, contains: function (c) { return !!classes[c]; } } };
  }
  var els = { 'glow-toggle': el('glow-toggle'), 'nav-pref-glow': el('nav-pref-glow'), 'nav-pref-glow-note': el('nav-pref-glow-note'), state: el('state') };
  els.state.classList.add('on');
  var answer = { ok: false, busy: 'piccap' };
  var store = { 'glasshouse.glow': '1' };
  var context = {
    q: function (id) { return els[id] || null; },
    t: function (key, text) { return text; },
    api: function (u) { return u; },
    location: { search: '' },
    localStorage: { getItem: function (k) { return store[k] || null; }, setItem: function (k, v) { store[k] = v; }, removeItem: function (k) { delete store[k]; } },
    document: { hidden: false, querySelectorAll: function () { return []; }, addEventListener: function () {},
      createElement: function () { return el('x'); }, body: { prepend: function () {} },
      documentElement: { classList: el('root').classList, style: { setProperty: function () {} } } },
    window: { CSS: { registerProperty: function () {} } },
    CSS: { registerProperty: function () {} },
    setTimeout: function () { return 1; }, clearTimeout: function () {},
    fetch: function () { return Promise.resolve({ json: function () { return Promise.resolve(answer); } }); },
    Promise: Promise,
    URLSearchParams: require('url').URLSearchParams
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui/glow.js'), 'utf8'), context);
  vm.runInContext('glowAllowed(true);', context);
  assert.strictEqual(els['nav-pref-glow-note'].hidden, true, 'nothing said before a reading');
  vm.runInContext('glowTick()', context).then(function () {
    assert.strictEqual(els['nav-pref-glow-note'].hidden, false);
    assert.strictEqual(els['nav-pref-glow-note'].textContent, 'Paused while PicCap is capturing the screen.');
    assert.strictEqual(els['glow-toggle'].title, 'Screen glow: paused while PicCap is capturing the screen (click to switch off)');
    assert.ok(els['glow-toggle'].classList.contains('glow-paused'));
    answer = { ok: false, busy: 'huesync' };
    return vm.runInContext('glowTick()', context);
  }).then(function () {
    assert.strictEqual(els['nav-pref-glow-note'].textContent, 'Paused while Hue Sync is capturing the screen.');
    answer = { ok: true, left: [200, 40, 40], right: [40, 40, 200], light: 0.5 };
    return vm.runInContext('glowTick()', context);
  }).then(function () {
    assert.strictEqual(els['nav-pref-glow-note'].hidden, true, 'said no more once the glow reads again');
    assert.ok(!els['glow-toggle'].classList.contains('glow-paused'));
    vm.runInContext('toggleGlow()', context);
    answer = { ok: false, busy: 'piccap' };
    return vm.runInContext('glowTick()', context);
  }).then(function () {
    assert.strictEqual(els['nav-pref-glow-note'].hidden, true, 'switched off: nothing to say');
    console.log('test-glow-ui.js passed');
  }).catch(function (e) { console.error(e); process.exit(1); });
}
