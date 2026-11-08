/**
 * test/test-appdns-ui.js - the Apps tab's DNS for one app: hidden where the TV
 * has no app sandboxes, a row per app with its servers or the TV's, names
 * escaped, the editor filled in, and a refused address shown beside the field
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-appdns-ui.js ...');

if (parseInt(process.versions.node.split('.')[0], 10) < 8) {
  console.log('  - skipped: UI files use async/await (needs Node 8+)');
  process.exit(0);
}

var elements = {};
var posted = [];
var reply = { ok: true };
var reloads = 0;
function element(id) {
  if (!elements[id]) elements[id] = { id: id, innerHTML: '', textContent: '', value: '', hidden: false, focus: function () {} };
  return elements[id];
}
var context = vm.createContext({
  token: '',
  q: element,
  t: function (key, english, vars) {
    return english.replace(/\{(\w+)\}/g, function (_, name) { return vars[name]; });
  },
  fetch: function (url, opts) {
    posted.push({ url: url, body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: reply.ok, json: function () { return Promise.resolve(reply); } });
  },
  showErr: function () {},
  document: { addEventListener: function () {} },
  window: { addEventListener: function () {} },
  console: console
});
['format.js', 'apps.js'].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui', file), 'utf8'), context, { filename: file });
});
vm.runInContext('loadApps = function () { reloadsSeen(); };', context);
context.reloadsSeen = function () { reloads++; };

function render(d) {
  context.renderAppDnsData = d;
  vm.runInContext('appsData = renderAppDnsData; renderAppDns(appsData);', context);
}

render({ writable: true, appDns: null });
assert.strictEqual(element('disc-appdns').hidden, true);
console.log('  ✓ hidden on a TV without app sandboxes');

render({ writable: true, appDns: [] });
assert.strictEqual(element('disc-appdns').hidden, false);
assert.ok(element('apps-dns-list').innerHTML.indexOf('No sandboxed app has been opened yet.') >= 0);
assert.strictEqual(element('apps-dns-summary').textContent, 'None set');
console.log('  ✓ says so when no sandboxed app has been opened');

var apps = [
  { id: 'com.webos.app.browser', title: 'Browser', servers: [], doh: 'https://dns.example/q?a=1&b=<2>', dohError: 'HTTP 403' },
  { id: 'netflix', title: 'Net<flix>', servers: [], doh: null, dohError: null },
  { id: 'youtube.leanback.v4', title: 'YouTube', servers: ['1.1.1.1', '1.0.0.1'], doh: null, dohError: null }
];
render({ writable: true, appDns: apps });
var html = element('apps-dns-list').innerHTML;
assert.ok(html.indexOf('Net&lt;flix&gt;') >= 0 && html.indexOf('Net<flix>') < 0, 'titles are escaped');
assert.ok(html.indexOf('1.1.1.1, 1.0.0.1') >= 0);
assert.ok(html.indexOf('Using TV\'s DNS</div>') >= 0);
assert.ok(html.indexOf('https://dns.example/q?a=1&amp;b=&lt;2&gt; &middot; no answer: HTTP 403') >= 0, 'the DNS-over-HTTPS address, escaped, with its error');
assert.strictEqual((html.match(/Use the TV's DNS/g) || []).length, 2, 'only an app with its own can be put back');
assert.strictEqual(element('apps-dns-summary').textContent, '2 apps with their own');
render({ writable: false, appDns: apps });
assert.strictEqual((element('apps-dns-list').innerHTML.match(/disabled/g) || []).length, 5, 'read-only disables every button');
console.log('  ✓ a row per app with its servers or DNS-over-HTTPS address, escaped, and read-only respected');

render({ writable: true, appDns: apps });
element('dns-youtube.leanback.v4');
context.editAppDns('youtube.leanback.v4');
html = element('dns-youtube.leanback.v4').innerHTML;
assert.ok(/<input[^>]*value="1\.1\.1\.1, 1\.0\.0\.1"/.test(html), 'the editor starts with the servers');
assert.ok(html.indexOf('saveAppDns(\'youtube.leanback.v4\'') >= 0);
console.log('  ✓ the editor opens in the row with the servers filled in');

reply = { ok: false, error: 'not an IP address: dns.google' };
context.saveAppDns('youtube.leanback.v4', 'dns.google').then(function () {
  assert.deepStrictEqual(posted[0], { url: '/api/appdns', body: { id: 'youtube.leanback.v4', servers: 'dns.google' } });
  assert.strictEqual(element('dns-msg-youtube.leanback.v4').textContent, 'Not an IP address: dns.google.');
  assert.strictEqual(reloads, 0, 'a refused address keeps the editor open');
  reply = { ok: true, servers: [] };
  return context.saveAppDns('youtube.leanback.v4', '');
}).then(function () {
  assert.deepStrictEqual(posted[1].body, { id: 'youtube.leanback.v4', servers: '' });
  assert.strictEqual(reloads, 1);
  console.log('  ✓ a refused address is shown beside the field, and a saved one reloads the tab');
  console.log('test-appdns-ui.js: all passed');
}).catch(function (e) { console.error(e); process.exit(1); });
