/* Screenshot tiles use the translated choice title, including their accessible label. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
try { vm.runInNewContext('(async function () {})'); }
catch (e) { console.log('test-remotekeys-ui.js skipped: browser JavaScript needs Node 8+'); process.exit(0); }
var source = fs.readFileSync(path.join(__dirname, '../server/assets/ui/apps.js'), 'utf8');
source = source.slice(source.indexOf('const RK_GROUPS'), source.indexOf('// Opens a key\'s picker'));
var nodes = {}, document = { activeElement: {} };
function node(id) {
  return nodes[id] || (nodes[id] = { contains: function () { return false; } });
}
var context = vm.createContext({
  q: node, document: document, renderInputs: function () {},
  api: function (url) { return url; },
  t: function (key, english, vars) { return english.replace(/\{(\w+)\}/g, function (_, name) { return vars[name]; }); }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui/format.js'), 'utf8'), context);
vm.runInContext(source, context);
var captureId = 'capture:DISPLAY:1920x1080';
var key = { key: 'netflix', title: 'Netflix', action: 'open', id: captureId,
  opens: 'Screenshot · Full screen · 1920×1080' };
context.appsData = { writable: true, remoteKeys: {
  keys: [key], choices: [{ id: captureId, kind: 'capture', title: 'Captura <pantalla> · 1920×1080' }]
} };
context.renderRemoteKeys(context.appsData);
var html = node('apps-rk-list').innerHTML;
assert.ok(html.indexOf('aria-label="Netflix key: Captura &lt;pantalla&gt; · 1920×1080"') >= 0);
assert.ok(html.indexOf('<span class="rk-does">Captura &lt;pantalla&gt; · 1920×1080</span>') >= 0);
assert.ok(html.indexOf('Screenshot · Full screen') < 0);
assert.strictEqual(key.opens, 'Screenshot · Full screen · 1920×1080', 'rendering leaves the API response intact');
console.log('test-remotekeys-ui.js passed');
