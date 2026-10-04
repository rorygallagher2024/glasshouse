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

vm.createContext(sandbox);
vm.runInContext(scriptMatch[1], sandbox);

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

// 2. oled tab is marked optional in TABS
(function testOledTabOptional() {
  var oledTab = null;
  for (var i = 0; i < sandbox.TABS.length; i++) {
    if (sandbox.TABS[i].key === 'oled') {
      oledTab = sandbox.TABS[i];
      break;
    }
  }
  assert.ok(oledTab, 'oled tab must exist in TABS');
  assert.strictEqual(oledTab.optional, true, 'oled tab must be marked optional: true');
  console.log('  ✓ oled tab is marked optional in TABS');
})();

// 3. oledRows renders Panel Care on non-OLED sets with panel hours, or empty if no hours
(function testOledRowsNonOled() {
  // Non-OLED with panel hours
  var rowsWithHours = sandbox.oledRows({
    ok: true,
    isOled: false,
    panelHours: 3500
  });
  assert.strictEqual(rowsWithHours.length, 2, 'Non-OLED with hours must return Panel life head + Total power-on hours');
  assert.strictEqual(rowsWithHours[0].label, 'Panel life');
  assert.strictEqual(rowsWithHours[0].head, true);
  assert.strictEqual(rowsWithHours[1].label, 'Total power-on hours');
  assert.strictEqual(rowsWithHours[1].value, '3,500');
  assert.strictEqual(rowsWithHours[1].hint, 'Hours the display has been lit since new.');
  assert.strictEqual(
    rowsWithHours.some(function (r) { return r.label === 'This is not an OLED panel'; }),
    false,
    'Never show "This is not an OLED panel"'
  );

  // Non-OLED without panel hours (null / undefined)
  var rowsNoHours = sandbox.oledRows({
    ok: true,
    isOled: false,
    panelHours: null
  });
  assert.deepEqual(rowsNoHours, [], 'Non-OLED without hours must return empty array');

  // OLED panel returns full stats and protections
  var oledRows = sandbox.oledRows({
    ok: true,
    isOled: true,
    panelHours: 1200,
    hoursUntilComp: 3.5,
    gsr: true,
    tpc: true,
    screenShift: 'on'
  });
  assert.ok(oledRows.length > 2, 'OLED set must return multiple metrics');
  assert.strictEqual(
    oledRows.some(function (r) { return r.label === 'Global sticky reduction'; }),
    true,
    'OLED set includes protections'
  );

  console.log('  ✓ oledRows renders Panel Care for non-OLED with hours, empty without hours');
})();

console.log('ALL test-dashboard-view.js assertions passed!\n');
