/**
 * test/test-catalog-ui.js - Source links and existing catalog actions
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var repo = require('../server/lib/repo');

console.log('Running test-catalog-ui.js ...');

if (parseInt(process.versions.node.split('.')[0], 10) < 8) {
  console.log('  - skipped: UI files use async/await (needs Node 8+)');
  process.exit(0);
}

var elements = {};
var sourceLabel = 'View source';
var context = vm.createContext({
  q: function (id) {
    if (!elements[id]) elements[id] = { innerHTML: '', textContent: '', value: '', hidden: false };
    return elements[id];
  },
  t: function (key, english, vars) {
    if (key === 'apps.install.viewSource') return sourceLabel;
    return english.replace(/\{(\w+)\}/g, function (_, name) { return vars[name]; });
  },
  appsData: { writable: true },
  makeProgress: function () { return { pct: 25 }; },
  window: { addEventListener: function () {} }
});
['format.js', 'install.js'].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui', file), 'utf8'), context, { filename: file });
});

function app(source) {
  var parsed = repo._parsePackage({ id: 'org.example.app', title: 'Example <app>', manifest: {
    version: '1.2.3', appDescription: 'A catalog app', sourceUrl: source,
    ipkUrl: 'https://example.org/app.ipk', ipkHash: { sha256: new Array(65).join('a') }
  } }, repo.DEFAULT_REPO);
  parsed.repo = repo.DEFAULT_REPO;
  parsed.state = 'none';
  parsed.installedVersion = null;
  return parsed;
}

function sourceLink(html) {
  var match = html.match(/<a class="pill idle catalog-source"[^>]*>[^<]*<\/a>/);
  assert.ok(match, 'a source link is present');
  var actions = html.slice(html.indexOf('<div class="prot-status">'));
  assert.ok(actions.indexOf(match[0]) >= 0, 'the source control is grouped with app actions');
  assert.ok(actions.indexOf(match[0]) < actions.indexOf('<button type="button" class="pill', actions.indexOf(match[0])),
    'the source control is beside the primary app action');
  assert.ok(/target="_blank"/.test(match[0]), 'opens a new tab');
  assert.ok(/rel="noopener noreferrer"/.test(match[0]), 'protects the opener and referrer');
  assert.ok(!/\b(?:disabled|tabindex|onclick)=/.test(match[0]), 'navigation is independent of actions');
  return match[0];
}

var source = 'https://example.org/app?ref="main"&tag=<tag>#readme';
var entry = app(source);
var html = context.catalogRow(entry, true);
assert.strictEqual(sourceLink(html), '<a class="pill idle catalog-source" href="https://example.org/app?ref=&quot;main&quot;&amp;tag=&lt;tag&gt;#readme" target="_blank" rel="noopener noreferrer">View source</a>');
assert.ok(html.indexOf('Example &lt;app&gt;') >= 0, 'titles stay escaped');
sourceLabel = 'Inspect <source> & code';
assert.ok(sourceLink(context.catalogRow(entry, true)).indexOf('Inspect &lt;source&gt; &amp; code') >= 0, 'the translated label is escaped');
sourceLabel = 'View source';
console.log('  ✓ source links use safe attributes and escape URLs and translated labels');

[undefined, null, '', 'javascript:alert(1)', 'http://example.org/app', 'https://',
  'https://example.org/app.ipk?download=1'].forEach(function (value) {
  assert.ok(context.catalogRow(app(value), true).indexOf('catalog-source') < 0, 'no link for ' + value);
});
console.log('  ✓ absent and rejected source URLs leave the app without a link');

['none', 'store', 'update', 'installed', 'hbc'].forEach(function (state) {
  entry.state = state;
  entry.installedVersion = state === 'none' ? null : '1.0.0';
  [true, false].forEach(function (writable) {
    html = context.catalogRow(entry, writable);
    assert.strictEqual(sourceLink(html).indexOf('View source</a>') >= 0, true);
    var action = html.match(/<button[^>]*data-app="org.example.app"[^>]*>[^<]*<\/button>/)[0];
    assert.strictEqual(/ disabled/.test(action), !writable || state === 'hbc', state + ' action availability');
    assert.ok(action.indexOf(state === 'installed' ? 'confirmUninstall(' : 'startInstall(') >= 0);
    assert.strictEqual(html.indexOf("sendCommand('launchApp'") >= 0, state !== 'none' && state !== 'store');
  });
});
entry.state = 'none';
entry.installedVersion = null;
vm.runInContext('installSnap = { source: "catalog", appId: "org.example.app", repo: "' + repo.DEFAULT_REPO + '", state: "downloading" };', context);
html = context.catalogRow(entry, true);
sourceLink(html);
assert.ok(/class="pill busy"/.test(html) && / disabled/.test(html), 'the install action stays busy');
vm.runInContext('installSnap = null; uninstalling["org.example.app"] = true;', context);
sourceLink(context.catalogRow(entry, true));
vm.runInContext('delete uninstalling["org.example.app"];', context);
console.log('  ✓ links stay available for every app state, read-only controls and running jobs');

context.catalogFixture = {
  ok: true, apps: [], others: [],
  repos: [{ url: 'https://example.org/repo.json', label: 'Example catalog', count: 4 }]
};
['apps', 'others'].forEach(function (which) {
  context.catalogFixture[which] = [app(source), app(),
    app('https://github.com/example/app/releases/download/v1/app.ipk'), app('https://example.org/app.ipk')];
});
context.catalogFixture.others.forEach(function (a) { a.repo = 'https://example.org/repo.json'; });
[true, false].forEach(function (writable) {
  context.appsData.writable = writable;
  vm.runInContext('catalogData = catalogFixture; installSideload = false; renderCatalog();', context);
  ['apps-catalog-list', 'apps-others-list'].forEach(function (id) {
    var output = elements[id].innerHTML;
    assert.strictEqual((output.match(/class="pill idle catalog-source"/g) || []).length, 2, id + ' only links apps with a source');
    sourceLink(output);
    assert.ok(output.indexOf('href="https://github.com/example/app"') >= 0, id + ' links GitHub downloads to the repository');
    assert.ok(output.indexOf('href="https://example.org/app.ipk"') < 0, id + ' hides package downloads');
    assert.strictEqual((output.match(/data-app=/g) || []).length, 4, id + ' keeps all app actions');
  });
});
console.log('  ✓ primary and additional catalogs render links with sideloading disabled');
console.log('ALL test-catalog-ui.js assertions passed!');
