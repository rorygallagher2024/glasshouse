var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

if (Number(process.versions.node.split('.')[0]) < 16) {
  console.log('test-hdmi-earc-ui.js: browser renderer skipped on legacy Node');
  process.exit(0);
}

var context = {
  t: function (key, english, vars) {
    if (!vars) return english;
    return english.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] || ''; });
  },
  esc: function (s) { return String(s || ''); },
  q: function () { return { innerHTML: '', textContent: '', hidden: false }; },
  api: function (p) { return p; },
  document: { getElementById: function () { return null; } }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui/system.js'), 'utf8'), context);

// 1. When earc is explicitly false on port 2 and true on port 3 (B4)
var port2Html = context.renderHdmiPort({ port: 2, label: 'Blu-ray', earc: false, signal: null });
assert.ok(port2Html.indexOf('class="port-cap"') === -1, 'no eARC badge on port 2 when earc is false');
assert.ok(port2Html.indexOf('eARC') === -1, 'no eARC text on port 2');

var port3Html = context.renderHdmiPort({ port: 3, label: 'Sonos', earc: true, signal: null });
assert.ok(port3Html.indexOf('<span class="port-cap" translate="no">eARC</span>') !== -1, 'eARC badge rendered on port 3');

// 2. When earc is true on port 2 (G3, C4)
var g3Port2Html = context.renderHdmiPort({ port: 2, label: 'Soundbar', earc: true, signal: null });
assert.ok(g3Port2Html.indexOf('<span class="port-cap" translate="no">eARC</span>') !== -1, 'eARC badge on port 2 when earc is true');

// 3. Fallback when earc is undefined
var fallbackPort2Html = context.renderHdmiPort({ port: 2, label: 'HDMI 2', signal: null });
assert.ok(fallbackPort2Html.indexOf('<span class="port-cap" translate="no">eARC</span>') !== -1, 'eARC badge on port 2 by default');

var fallbackPort3Html = context.renderHdmiPort({ port: 3, label: 'HDMI 3', signal: null });
assert.ok(fallbackPort3Html.indexOf('class="port-cap"') === -1, 'no eARC badge on port 3 by default');

console.log('  ✓ UI renders eARC badge on the detected eARC port');
