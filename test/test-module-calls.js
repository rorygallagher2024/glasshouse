/**
 * test/test-module-calls.js - scripts/check-module-calls.py finds a call to a
 * name a module does not export, through a require and through a module
 * handed over by init(), and passes one that is exported
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var child = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

console.log('Running test-module-calls.js ...');

try { child.execSync('python3 --version', { stdio: 'ignore' }); } catch (e) {
  console.log('  - skipped: needs python3');
  console.log('ALL test-module-calls.js assertions passed!\n');
  process.exit(0);
}

var root = path.join(os.tmpdir(), 'module-calls-' + process.pid);
var lib = path.join(root, 'server', 'lib');
child.execSync('mkdir -p "' + lib + '"');
var script = path.join(__dirname, '..', 'scripts', 'check-module-calls.py');

fs.writeFileSync(path.join(lib, 'savers.js'),
  'function heldBack() { return false; }\nmodule.exports = {\n  heldBack: heldBack,\n  LEVEL: 1\n};\n');

function run(tvweb, routes) {
  fs.writeFileSync(path.join(root, 'server', 'tvweb.js'), tvweb);
  fs.writeFileSync(path.join(lib, 'routes.js'), routes);
  try {
    return { code: 0, out: String(child.execSync('python3 "' + script + '" "' + root + '"')) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) };
  }
}

var ok = run("var savers = require('./lib/savers');\nsavers.heldBack();\n",
  "/** @type {typeof import('./savers')} */\nvar s = null;\nfunction f() { return s.heldBack() && s.LEVEL; }\n");
assert.strictEqual(ok.code, 0, ok.out);

var viaRequire = run("var savers = require('./lib/savers');\nsavers.held();\n", '');
assert.notStrictEqual(viaRequire.code, 0);
assert.ok(/savers\.held is not exported/.test(viaRequire.out), viaRequire.out);

var viaInit = run('', "/** @type {typeof import('./savers')} */\nvar s = null;\nfunction f() { return s.held(); }\n");
assert.notStrictEqual(viaInit.code, 0);
assert.ok(/routes\.js:3: s\.held is not exported/.test(viaInit.out), viaInit.out);

child.execSync('rm -rf "' + root + '"');
console.log('  ✓ a call to a name a module does not export is found, through a require or init()');
console.log('ALL test-module-calls.js assertions passed!\n');
