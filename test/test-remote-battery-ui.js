var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// readouts.js runs in a modern browser, not the TV's legacy Node runtime.
if (Number(process.versions.node.split('.')[0]) < 16) {
  console.log('test-remote-battery-ui.js: browser renderer skipped on legacy Node');
  process.exit(0);
}

var html = fs.readFileSync(path.join(__dirname, '../server/assets/ui.html'), 'utf8');
var elements = {};
html.replace(/\bid="([^"]+)"/g, function (_, id) {
  elements[id] = { hidden: false, textContent: '', style: {} };
});
var context = {
  q: function (id) { assert.ok(elements[id], 'markup contains ' + id); return elements[id]; },
  t: function (key, english, values) {
    return english.replace(/\{(\w+)\}/g, function (_, name) { return values[name]; });
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui/readouts.js'), 'utf8'), context);

context.renderRemoteBattery({ model: 'LGE MR25GA', battery: 46, batteryUpdatedAt: 1793718000000, connected: false });
assert.strictEqual(elements['remote-pct'].textContent, 46);
assert.strictEqual(elements['remote-model-val'].textContent, 'MR25GA');
assert.strictEqual(elements['remote-read-row'].hidden, false);
assert.ok(elements['remote-read-val'].textContent.length > 0);
assert.strictEqual(elements['remote-pill'].textContent, 'Standby');
assert.strictEqual(elements.remoteblock.hidden, false);

context.renderRemoteBattery({ model: 'LGE MR24', battery: null, batteryStatus: 'waiting', connected: false });
assert.strictEqual(elements.remoteblock.hidden, true, 'hidden when no battery reading is available');
assert.strictEqual(elements['remote-read-row'].hidden, true);
assert.strictEqual(elements['remote-read-val'].textContent, '', 'old timestamp is not carried to another remote');

context.renderRemoteBattery({ model: 'Other remote', battery: null, batteryStatus: 'unsupported' });
assert.strictEqual(elements.remoteblock.hidden, true, 'hidden on unsupported TVs and remotes');

context.renderRemoteBattery({ model: 'LGE MR24', battery: 0, connected: true });
assert.strictEqual(elements['remote-pct'].textContent, 0);
assert.strictEqual(elements['remote-gauge-fill'].style.width, '0%');
assert.strictEqual(elements['remote-read-row'].hidden, true);
assert.strictEqual(elements.remoteblock.hidden, false);
assert.strictEqual(elements['remote-pill'].textContent, 'Connected');

context.renderRemoteBattery(null);
assert.strictEqual(elements.remoteblock.hidden, true);
assert.strictEqual(elements['control-remote'], undefined, 'not duplicated on Control tab');
console.log('test-remote-battery-ui.js passed');
