/**
 * test/test-dashboard-view.js - Unit tests for TV dashboard view builders
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-dashboard-view.js ...');

var htmlPath = path.join(__dirname, '..', 'server', 'assets', 'dashboard.html');
var html = fs.readFileSync(htmlPath, 'utf8');
var scriptMatch = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'Expected inline script in dashboard.html');

var dummyEl = {
  style: {},
  classList: { add: function () {}, remove: function () {} },
  children: [],
  scrollLeft: 0,
  getBoundingClientRect: function () { return { left: 0, width: 0 }; }
};
for (var i = 0; i < 10; i++) {
  dummyEl.children.push({
    style: {},
    classList: { add: function () {}, remove: function () {} },
    getBoundingClientRect: function () { return { left: 0, width: 0 }; }
  });
}

var sandbox = {
  t: function (k, d) { return d; },
  fetch: function () {
    var p = { then: function () { return p; }, catch: function () { return p; } };
    return p;
  },
  document: {
    getElementById: function () { return dummyEl; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}
  },
  window: { location: { search: '' }, addEventListener: function () {} },
  location: { search: '' },
  setInterval: function () {},
  setTimeout: function () {}
};

// In Node 0.10, runInNewContext copies sandbox properties in once before execution
// and copies globals out once after execution. Assigning sandbox.rows or reading
// sandbox.sel from outside after execution does not observe the context's internal
// variables. Running the paging scenario inside the context ensures it works across
// all node versions (0.10 through 24).
var testPagingSnippet = [
  'var __testPagingResults = (function () {',
  '  rows = [',
  '    { label: "Row 0" },',
  '    { label: "Row 1" },',
  '    { label: "Row 2" },',
  '    { label: "Header A", head: true },',
  '    { label: "Row 4" },',
  '    { label: "Row 5" },',
  '    { label: "Row 6" },',
  '    { label: "Row 7" },',
  '    { label: "Row 8" },',
  '    { label: "Row 9" },',
  '    { label: "Row 10" }',
  '  ];',
  '  sel = 0;',
  '  var res = [];',
  '  page(1); res.push(sel);',
  '  page(1); res.push(sel);',
  '  page(1); res.push(sel);',
  '  page(-1); res.push(sel);',
  '  page(-1); res.push(sel);',
  '  page(-1); res.push(sel);',
  '  return res;',
  '})();'
].join('\n');

// runInNewContext rather than createContext and runInContext: node 0.10's
// createContext returns a copy instead of the sandbox itself.
vm.runInNewContext(scriptMatch[1] + '\n;' + testPagingSnippet, sandbox);

// 1. sysRows omits eMMC health when emmcWear is false or health is unknown
(function testEmmcHealthVisibility() {
  var rowsNoWear = sandbox.sysRows({
    ok: true,
    emmc: { health: 'unknown' },
    capabilities: { emmcWear: false }
  });
  assert.strictEqual(
    rowsNoWear.some(function (r) { return r.label === 'eMMC health'; }),
    false,
    'eMMC health omitted when emmcWear is false'
  );

  var rowsUnknown = sandbox.sysRows({
    ok: true,
    emmc: { health: 'unknown' }
  });
  assert.strictEqual(
    rowsUnknown.some(function (r) { return r.label === 'eMMC health'; }),
    false,
    'eMMC health omitted when health is unknown'
  );

  var rowsHealthy = sandbox.sysRows({
    ok: true,
    emmc: { health: '>90% (Healthy)' },
    capabilities: { emmcWear: true }
  });
  assert.strictEqual(
    rowsHealthy.some(function (r) { return r.label === 'eMMC health'; }),
    true,
    'eMMC health included when wear is available and healthy'
  );

  console.log('  ✓ sysRows omits eMMC health when unavailable or unknown');
})();

// 2. OLED Care is dropped on a TV without an OLED panel, as Game and Screen
// Saver are where the TV has neither
(function testOledTabOptional() {
  var oledTab = sandbox.TABS.filter(function (s) { return s.key === 'oled'; })[0];
  assert.ok(oledTab, 'the OLED Care tab exists');
  assert.strictEqual(oledTab.optional, true, 'and is dropped when /api/oledcare says it is unavailable');
  assert.deepEqual(sandbox.oledRows({ ok: true, isOled: false }), [], 'no rows on an LCD TV');
  console.log('  ✓ the OLED Care tab is optional, with no rows on a TV without an OLED panel');
})();

// 3. optionRows groups Power & standby and Timers with separate headers
(function testOptionRowsGrouping() {
  var rows = sandbox.optionRows({
    ok: true,
    quickBoot: true,
    wakeOnLan: true,
    powerTimers: {
      on: { enabled: true, time: '07:00', days: [1, 2, 3, 4, 5] },
      off: { enabled: false, time: '23:00', days: [] }
    }
  });
  var headers = rows.filter(function (r) { return r.head; }).map(function (r) { return r.label; });
  assert.ok(headers.indexOf('Power & standby') !== -1, 'has Power & standby section');
  assert.ok(headers.indexOf('Timers') !== -1, 'has separate Timers section');
  console.log('  ✓ optionRows groups Power & standby and Timers with distinct headers');
})();

// 4. page() jumps through rows skipping headers and clamps to bounds
(function testPagePaging() {
  assert.strictEqual(typeof sandbox.page, 'function', 'page function exists');
  var res = sandbox.__testPagingResults;
  assert.ok(res && res.length === 6, 'paging results recorded');
  // Page down by 6 selectable rows: 0 -> 1 -> 2 -> (skip 3) -> 4 -> 5 -> 6 -> 7
  assert.strictEqual(res[0], 7, 'pages down 6 selectable rows skipping header');
  // Page down again: from 7, only 8, 9, 10 remain (3 rows) -> clamps to last row 10
  assert.strictEqual(res[1], 10, 'clamps to last row at bottom');
  // Page down again when already at bottom: stays at 10
  assert.strictEqual(res[2], 10, 'stays at last row when already at bottom');
  // Page up by 6 selectable rows: from 10 -> 9 -> 8 -> 7 -> 6 -> 5 -> 4
  assert.strictEqual(res[3], 4, 'pages up 6 selectable rows');
  // Page up again: from 4 -> (skip 3) -> 2 -> 1 -> 0 -> clamps to 0
  assert.strictEqual(res[4], 0, 'clamps to first row at top');
  // Page up again: stays at 0
  assert.strictEqual(res[5], 0, 'stays at first row when already at top');
  console.log('  ✓ page() jumps 6 rows, skips headers, and respects list bounds');
})();

// 5. updateRows includes server health info when provided
(function testUpdateRowsServerHealth() {
  assert.strictEqual(typeof sandbox.updateRows, 'function', 'updateRows function exists');
  var rows = sandbox.updateRows({
    ok: true,
    installed: '0.92.0',
    daemon: {
      uptime: 3600,
      port: 8080,
      rss: 20971520
    }
  });
  var healthRow = rows.filter(function (r) { return r.label === 'Server health'; })[0];
  assert.ok(healthRow, 'has Server health row');
  assert.strictEqual(healthRow.value, '1h 0m · 20 MB RAM', 'formats server health value correctly');
  console.log('  ✓ updateRows includes Server health row');
})();

// 6. dashboard.html includes -webkit- flexbox and transform rules for webOS 2 WebKit (#746)
(function testWebos2FlexboxPrefixes() {
  assert.ok(/#main\{[^}]*display:-webkit-flex/.test(html), '#main has display:-webkit-flex');
  assert.ok(/#main\{[^}]*-webkit-flex:1 1 auto/.test(html), '#main has -webkit-flex:1 1 auto');
  assert.ok(/#list\{[^}]*-webkit-flex:1 1 62%/.test(html), '#list has -webkit-flex:1 1 62%');
  // A percentage height collapses #list to 0 px on WebKit 538.2 and Chromium 53.
  assert.ok(!/#list\{[^}]*height:/.test(html), '#list has no height of its own, so it is stretched');
  assert.ok(/if \(!list\.clientHeight\) list\.style\.height = /.test(html), 'a list still at 0 px is given #main\'s height');
  assert.ok(/else if \(d\.version !== pageVersion\) return reloadPage\(\);/.test(html), 'the TV app reloads when the server version changes');
  assert.ok(/#hint\{[^}]*-webkit-flex:0 0 31%/.test(html), '#hint has -webkit-flex:0 0 31%');
  assert.ok(/#hint\{[^}]*-webkit-align-self:center/.test(html), '#hint has -webkit-align-self:center');
  assert.ok(/\.row\{[^}]*display:-webkit-flex/.test(html), '.row has display:-webkit-flex');
  assert.ok(/\.row\{[^}]*-webkit-align-items:baseline/.test(html), '.row has -webkit-align-items:baseline');
  assert.ok(/\.val\.st\{[^}]*display:-webkit-inline-flex/.test(html), '.val.st has display:-webkit-inline-flex');
  assert.ok(/#rows\{[^}]*-webkit-transition:-webkit-transform/.test(html), '#rows transitions -webkit-transform');
  assert.ok(html.indexOf('rowsEl.style.webkitTransform = rowsEl.style.transform =') !== -1, 'position() sets webkitTransform');
  console.log('  ✓ dashboard.html layout includes -webkit- flexbox and transform prefixes for webOS 2 WebKit');
})();

// 7. Promise and fetch polyfills activate when missing (webOS 2 WebKit #746)
(function testPromiseAndFetchPolyfill() {
  var xhrs = [];
  function FakeXHR() {
    this.headers = {};
    this.status = 200;
    this.responseText = '{"ok":true,"test":123}';
    xhrs.push(this);
  }
  FakeXHR.prototype.open = function (m, u) { this.method = m; this.url = u; };
  FakeXHR.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
  FakeXHR.prototype.send = function (b) {
    this.body = b;
    if (this.onload) this.onload();
  };

  var webos2Sandbox = {
    t: function (k, d) { return d; },
    XMLHttpRequest: FakeXHR,
    TypeError: TypeError,
    Promise: undefined,
    fetch: undefined,
    document: {
      getElementById: function () { return dummyEl; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {}
    },
    location: { search: '' },
    setInterval: function () {},
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    addEventListener: function () {}
  };
  webos2Sandbox.window = webos2Sandbox;

  vm.runInNewContext(scriptMatch[1], webos2Sandbox);
  assert.strictEqual(typeof webos2Sandbox.window.Promise, 'function', 'polyfilled window.Promise');
  assert.strictEqual(typeof webos2Sandbox.window.fetch, 'function', 'polyfilled window.fetch');

  // Verify Promise chaining and resolution
  var pResolved = false;
  var fetchResolved = false;
  var safetyTimer = setTimeout(function () {
    assert.strictEqual(pResolved, true, 'Promise chaining resolved before timeout');
    assert.strictEqual(fetchResolved, true, 'Fetch over XHR resolved before timeout');
  }, 3000);

  function checkDone() {
    if (pResolved && fetchResolved) {
      clearTimeout(safetyTimer);
      console.log('  ✓ Promise and fetch polyfills support webOS 2 WebKit without native ES6');
      console.log('ALL test-dashboard-view.js assertions passed!\n');
    }
  }

  webos2Sandbox.window.Promise.resolve('webos2')
    .then(function (val) {
      return webos2Sandbox.window.Promise.resolve(val + '-ok');
    })
    .then(function (val) {
      assert.strictEqual(val, 'webos2-ok');
      pResolved = true;
      checkDone();
    });

  // Verify fetch over FakeXHR
  webos2Sandbox.window.fetch('/api/test')
    .then(function (res) {
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 200);
      return res.json();
    })
    .then(function (data) {
      assert.deepEqual(data, { ok: true, test: 123 });
      fetchResolved = true;
      checkDone();
    });
})();
