// A stopped server releases the standalone Home key without disabling Home.
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var source = fs.readFileSync(path.join(__dirname, '../server/lib/home-takeover.js'), 'utf8');

function release(home, failRestore, failLaunch) {
  var events = [], exitCode;
  var moduleObject = { exports: {} };
  var remoteKeys = {
    init: function () {},
    homeApp: function () { return home; },
    setStarting: function (text, cb) { events.push(['starting', text]); cb({ ok: true }); },
    setHome: function (id, cb) { events.push(['home', id]); cb({ ok: !failRestore }); }
  };
  function requireModule(name) {
    if (name === './luna') return { call: function (uri, payload, cb) {
      events.push([uri, payload.id]); cb({ returnValue: !failLaunch });
    } };
    if (name === './samrescan') return { init: function () {} };
    if (name === './remotekeys') return remoteKeys;
    if (name === './util') return { mkdirp: function () {} };
    return require(name);
  }
  requireModule.main = moduleObject;
  vm.runInNewContext(source, {
    require: requireModule, module: moduleObject,
    __dirname: path.join(__dirname, '../server/lib'),
    console: { log: function () {} },
    process: { argv: ['node', 'home-takeover.js', '--release'], exit: function (code) { exitCode = code; } }
  });
  return { events: events, code: exitCode };
}

var restored = release('com.tvweb.home');
assert.strictEqual(restored.code, 0);
assert.deepEqual(restored.events, [
  ['starting', ''], ['home', ''],
  ['com.webos.applicationManager/launch', 'com.webos.app.home']
]);
var refused = release('com.tvweb.home', true);
assert.strictEqual(refused.code, 1);
assert.strictEqual(refused.events.length, 2, 'a refused mapping restore must report failure');
assert.strictEqual(release('com.tvweb.home', false, true).code, 1);
var untouched = release('');
assert.strictEqual(untouched.code, 0);
assert.deepEqual(untouched.events, [['starting', '']], 'the takeover recovery path is retained');
console.log('Standalone Home recovery tests passed.');
