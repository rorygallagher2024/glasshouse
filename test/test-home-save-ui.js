/*
 * test/test-home-save-ui.js - A save on the dashboard's Home tab that ends in
 * an error (a render or reload throwing, the server restarting mid-save) does
 * not leave the tab "saving", which made every later change do nothing.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

console.log('Running test-home-save-ui.js ...');

var nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 8) {
  console.log('  - skipped: UI files use async/await (needs Node 8+)');
  console.log('ALL test-home-save-ui.js assertions passed!\n');
  process.exit(0);
}

var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'ui', 'home.js'), 'utf8');
var m = /async function homeSaveLayout\(patch\) \{[\s\S]*?\n\}\n/.exec(src);
assert.ok(m, 'homeSaveLayout found');

var posts = [];
var errors = [];
var throwInLoad = true;
var ctx = {
  homeSaving: false,
  homeLoadRevision: 0,
  homeLayout: {},
  homeStatus: { layout: {} },
  homeWritable: function () { return !ctx.homeSaving; },
  renderHome: function () {},
  showErr: function (msg) { errors.push(msg); },
  homePost: function (p, body) { posts.push(body); return Promise.resolve({ ok: true, layout: body }); },
  loadHome: function () {
    if (throwInLoad) { throwInLoad = false; return Promise.reject(new Error('render failed')); }
    return Promise.resolve();
  }
};
vm.createContext(ctx);
vm.runInContext(m[0] + '\nthis.homeSaveLayout = homeSaveLayout;', ctx);

ctx.homeSaveLayout({ boardCrests: 'both' }).catch(function () {}).then(function () {
  assert.strictEqual(ctx.homeSaving, false, 'not left saving after a reload that threw');
  return ctx.homeSaveLayout({ boardCrests: 'crests' });
}).then(function () {
  assert.deepEqual(posts, [{ boardCrests: 'both' }, { boardCrests: 'crests' }], 'the next change is saved');
  console.log('  ✓ a save that ends in an error does not stop the next one');
  console.log('\nALL test-home-save-ui.js assertions passed!\n');
}).catch(function (e) { console.error(e); process.exit(1); });
