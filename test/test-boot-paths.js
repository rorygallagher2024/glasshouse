/* The boot mock must keep source readable when a checkout lives under a
 * simulated TV prefix, such as Bazzite's /var/home. Strict ES5. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var source = fs.readFileSync(path.join(__dirname, 'mocks', 'boot-server.js'), 'utf8');
var fakeRoot = '/var/tmp/glasshouse-boot-paths';

console.log('Running test-boot-paths.js ...');

['/workspace/glasshouse', '/var/home/wkirby/Projects/glasshouse-alternative-view',
 '/mnt/work/glasshouse', '/media/work/glasshouse', '/usr/local/src/glasshouse',
 '/home/root/glasshouse'].forEach(function (checkout) {
  var calls = [];
  var mockFs = {};
  ['readFileSync', 'writeFileSync', 'realpathSync', 'renameSync'].forEach(function (name) {
    mockFs[name] = function () {
      calls.push({name:name, args:Array.prototype.slice.call(arguments)});
      return arguments[0];
    };
  });
  var context = {
    __dirname:path.join(checkout, 'test', 'mocks'),
    console:console,
    process:{env:{FAKE_ROOT:fakeRoot}, argv:['node', 'boot-server.js']},
    require:function (id) {
      if (id === 'fs') return mockFs;
      if (id === 'path') return path;
      assert.strictEqual(id, '../../server/tvweb.js');
      return {};
    }
  };
  vm.runInNewContext(source, context, {filename:'boot-server.js'});

  ['server/tvweb.js', 'server/lib/home.js', 'server/assets/home.html',
   'server/tvwebctl', 'test/mocks/fake-luna-send.js'].forEach(function (file) {
    var original = path.join(checkout, file);
    mockFs.readFileSync(original);
    assert.strictEqual(calls[calls.length - 1].args[0], original, original);
    mockFs.realpathSync(original);
    assert.strictEqual(calls[calls.length - 1].args[0], original, original);
  });
  var parent = checkout;
  while (parent !== path.dirname(parent)) {
    mockFs.realpathSync(parent);
    assert.strictEqual(calls[calls.length - 1].args[0], parent, parent);
    parent = path.dirname(parent);
  }
  mockFs.writeFileSync(path.join(checkout, 'server', 'home.json'), '{}');
  assert.strictEqual(calls[calls.length - 1].args[0], path.join(fakeRoot, 'var/lib/tvweb/home.json'));
  ['/var/lib/tvweb/config.json', '/var/run/tvweb.beat', '/proc/stat', '/sys/class',
   '/etc/issue', '/mnt/lg', '/media/developer', '/usr/palm', '/home/root/state'].forEach(function (file) {
    mockFs.readFileSync(file);
    assert.strictEqual(calls[calls.length - 1].args[0], path.join(fakeRoot, file), file);
  });
  mockFs.renameSync(path.join(checkout, 'server', 'home.json.tmp'), path.join(checkout, 'server', 'home.json'));
  assert.strictEqual(calls[calls.length - 1].args[0], path.join(fakeRoot, 'var/lib/tvweb/home.json.tmp'));
  assert.strictEqual(calls[calls.length - 1].args[1], path.join(fakeRoot, 'var/lib/tvweb/home.json'));
  mockFs.readFileSync(fakeRoot + '/etc/issue');
  assert.strictEqual(calls[calls.length - 1].args[0], fakeRoot + '/etc/issue');
  mockFs.readFileSync(fakeRoot + '-other/etc/issue');
  assert.strictEqual(calls[calls.length - 1].args[0], path.join(fakeRoot, fakeRoot + '-other/etc/issue'));
  var sibling = checkout + '-other/server/tvweb.js';
  mockFs.readFileSync(sibling);
  assert.strictEqual(calls[calls.length - 1].args[0], /^\/(var|mnt|media|usr|home\/root)\//.test(sibling) ? path.join(fakeRoot, sibling) : sibling);
  console.log('  \u2713 source stays readable and TV state stays isolated under ' + checkout);
});

console.log('ALL test-boot-paths.js assertions passed!');
