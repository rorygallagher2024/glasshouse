/**
 * test/test-spawn-stdio.js - No child process on the TV is started with
 * 'inherit' in a stdio list: node 0.10 (webOS 2) refuses it there, and takes
 * it only as the whole stdio value (#1256). A file descriptor number works on
 * every version.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

console.log('Running test-spawn-stdio.js ...');

var root = path.join(__dirname, '../server');
var files = [path.join(root, 'tvweb.js')];
fs.readdirSync(path.join(root, 'lib')).forEach(function (f) {
  if (/\.js$/.test(f)) files.push(path.join(root, 'lib', f));
});

var hits = [];
files.forEach(function (file) {
  var src = fs.readFileSync(file, 'utf8');
  var re = /stdio\s*:\s*\[[^\]]*['"]inherit['"][^\]]*\]/g, m;
  while ((m = re.exec(src))) {
    hits.push(path.relative(root, file) + ':' + src.slice(0, m.index).split('\n').length);
  }
});
assert.deepEqual(hits, [], "'inherit' in a stdio list: use 2 (or 1) instead");
console.log('  \u2713 no stdio list on the TV names inherit');
console.log('ALL test-spawn-stdio.js assertions passed!');
