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
assert.strictEqual(elements['control-remote-battery'].textContent, 'Battery: 46%');
assert.strictEqual(elements['control-remote-model'].textContent, 'MR25GA');
assert.ok(/^Last read:/.test(elements['control-remote-note'].textContent));
assert.strictEqual(elements['remote-pill'].textContent, 'Standby');
assert.strictEqual(elements.remoteblock.hidden, false);

context.renderRemoteBattery({ model: 'LGE MR24', battery: null, batteryStatus: 'waiting', connected: false });
assert.strictEqual(elements['control-remote-model'].textContent, 'MR24');
assert.strictEqual(elements['control-remote-battery'].textContent, 'Battery unavailable');
assert.strictEqual(elements['remote-battery'].hidden, true);
assert.strictEqual(elements.remoteblock.hidden, false);
assert.ok(/Move the remote/.test(elements['control-remote-note'].textContent));
assert.ok(!/Last read:/.test(elements['control-remote-note'].textContent), 'old timestamp is not carried to another remote');

context.renderRemoteBattery({ model: 'Other remote', battery: null, batteryStatus: 'unsupported' });
assert.ok(/not supported/.test(elements['remote-battery-note'].textContent));
context.renderRemoteBattery({ model: 'LGE MR24', battery: 0, connected: true });
assert.strictEqual(elements['control-remote-battery'].textContent, 'Battery: 0%');
assert.strictEqual(elements['remote-gauge-fill'].style.width, '0%');
assert.strictEqual(elements['remote-battery'].hidden, false);
assert.strictEqual(elements['remote-pill'].textContent, 'Connected');

context.renderRemoteBattery(null);
assert.strictEqual(elements.remoteblock.hidden, true);
assert.strictEqual(elements['control-remote'].hidden, true);
console.log('test-remote-battery-ui.js passed');
