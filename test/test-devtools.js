/**
 * test/test-devtools.js - Closing the WebAppMgr debugger to the network
 */

var assert = require('assert');
var childProcess = require('child_process');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

// devtools.js takes execFile when it loads, so it is replaced first. Answers
// synchronously, which keeps each test synchronous.
var calls = [];
var answer = function () { return null; };
childProcess.execFile = function (file, args, opts, cb) {
  calls.push(file.split('/').pop() + ' ' + args[0]);
  cb(answer(file, args));
};

var devtools = require('../server/lib/devtools');

var FLAG = '/var/luna/preferences/devmode_enabled';
var FILES = [FLAG, '/usr/sbin/iptables', '/usr/sbin/ip6tables', '/sbin/iptables', '/sbin/ip6tables'];

function tv(present, fn) {
  FILES.forEach(function (f) { mockEnv.files[f] = present.indexOf(f) !== -1 ? '' : null; });
  calls = [];
  var log = console.log, error = console.error;
  console.log = console.error = function () {};
  try { return fn(); } finally {
    console.log = log; console.error = error;
    answer = function () { return null; };
  }
}

function run() {
  var held = null;
  devtools.blockFromNetwork(function (h) { held = h; });
  assert.ok(held, 'called back');
  return held;
}

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('without Developer Mode nothing is touched', function () {
  tv(['/usr/sbin/iptables'], function () {
    assert.deepEqual(run(), []);
    assert.deepEqual(calls, []);
    assert.equal(devtools.status(), 'off');
  });
});

test('the rule is added for each family when it is missing', function () {
  tv([FLAG, '/usr/sbin/iptables', '/usr/sbin/ip6tables'], function () {
    answer = function (file, args) { return args[0] === '-C' ? new Error('no rule') : null; };
    assert.deepEqual(run(), ['/usr/sbin/iptables', '/usr/sbin/ip6tables']);
    assert.deepEqual(calls, ['iptables -C', 'iptables -I', 'ip6tables -C', 'ip6tables -I']);
    assert.equal(devtools.status(), 'closed');
  });
});

test('a rule already in place is not added twice', function () {
  tv([FLAG, '/usr/sbin/iptables'], function () {
    assert.deepEqual(run(), ['/usr/sbin/iptables']);
    assert.deepEqual(calls, ['iptables -C']);
  });
});

test('a kernel without ip6_tables still gets the IPv4 rule', function () {
  tv([FLAG, '/usr/sbin/iptables', '/usr/sbin/ip6tables'], function () {
    answer = function (file, args) {
      return (/ip6tables$/.test(file) || args[0] === '-C') ? new Error('no table') : null;
    };
    assert.deepEqual(run(), ['/usr/sbin/iptables']);
  });
});

test('the dashboard is told when the port could not be closed', function () {
  tv([FLAG, '/usr/sbin/iptables'], function () {
    answer = function () { return new Error('not permitted'); };
    assert.deepEqual(run(), []);
    assert.equal(devtools.status(), 'open');
  });
});

test('the tools are found in /sbin too', function () {
  tv([FLAG, '/sbin/iptables'], function () {
    assert.deepEqual(run(), ['/sbin/iptables']);
  });
});

function runLeaveOpen() {
  var held = null;
  devtools.leaveOpen(function (h) { held = h; });
  assert.ok(held, 'called back');
  return held;
}

test('allowNetworkDebugger takes out a rule an earlier start left', function () {
  tv([FLAG, '/usr/sbin/iptables', '/usr/sbin/ip6tables'], function () {
    assert.deepEqual(runLeaveOpen(), []);
    assert.deepEqual(calls, ['iptables -C', 'iptables -D', 'ip6tables -C', 'ip6tables -D']);
    assert.equal(devtools.status(), 'allowed');
  });
});

test('allowNetworkDebugger leaves a TV without the rule alone', function () {
  tv([FLAG, '/usr/sbin/iptables'], function () {
    answer = function () { return new Error('no rule'); };
    assert.deepEqual(runLeaveOpen(), []);
    assert.deepEqual(calls, ['iptables -C']);
    assert.equal(devtools.status(), 'allowed');
  });
});

test('a rule that cannot be taken out is reported as closed', function () {
  tv([FLAG, '/usr/sbin/iptables'], function () {
    answer = function (file, args) { return args[0] === '-D' ? new Error('not permitted') : null; };
    assert.deepEqual(runLeaveOpen(), ['/usr/sbin/iptables']);
    assert.equal(devtools.status(), 'closed');
  });
});

test('allowNetworkDebugger without Developer Mode touches nothing', function () {
  tv(['/usr/sbin/iptables'], function () {
    assert.deepEqual(runLeaveOpen(), []);
    assert.deepEqual(calls, []);
    assert.equal(devtools.status(), 'off');
  });
});

test('the rule drops 9998 from everything but loopback', function () {
  assert.equal(devtools.RULE.join(' '), 'INPUT -p tcp --dport 9998 ! -i lo -j DROP');
});

var failures = 0;
tests.forEach(function (t) {
  try {
    t[1]();
    console.log('  ✓ ' + t[0]);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + t[0] + '\n      ' + e.message);
  }
});
FILES.forEach(function (f) { delete mockEnv.files[f]; });
mockEnv.restore();
process.exit(failures ? 1 : 0);
