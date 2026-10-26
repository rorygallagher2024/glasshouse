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
var TABLES = '/proc/net/ip_tables_names';
var FILES = [FLAG, '/usr/sbin/iptables', '/usr/sbin/ip6tables', '/sbin/iptables', '/sbin/ip6tables', TABLES];

function tv(present, fn) {
  FILES.forEach(function (f) { mockEnv.files[f] = present.indexOf(f) !== -1 ? '' : null; });
  calls = [];
  var log = console.log, warn = console.warn, error = console.error;
  console.log = console.warn = console.error = function () {};
  try { return fn(); } finally {
    console.log = log; console.warn = warn; console.error = error;
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
  tv([FLAG, '/usr/sbin/iptables', TABLES], function () {
    answer = function () { return new Error('not permitted'); };
    assert.deepEqual(run(), []);
    assert.equal(devtools.status(), 'open');
  });
});

// A 50QNED80A6A (webOS 10): iptables is there, the kernel's filter table is not (#699).
test('a kernel without a firewall is reported as one', function () {
  tv([FLAG, '/usr/sbin/iptables'], function () {
    answer = function () { return new Error("can't initialize iptables table `filter'"); };
    assert.deepEqual(run(), []);
    assert.equal(devtools.status(), 'unsupported');
  });
});

test('a TV without iptables is reported as having no firewall', function () {
  tv([FLAG], function () {
    assert.deepEqual(run(), []);
    assert.deepEqual(calls, []);
    assert.equal(devtools.status(), 'unsupported');
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

test('setNetworkDebuggerAllowed toggles the firewall rule and writes config', function () {
  var controls = require('../server/lib/controls');
  var written = null;
  controls.init({
    config: { allowControl: true, allowNetworkDebugger: false },
    devtools: devtools,
    writeSettings: function (patch, cb) { written = patch; cb(null); },
    updateSummary: function () { return { ok: true, devtools: devtools.status() }; }
  });

  tv([FLAG, '/usr/sbin/iptables'], function () {
    controls.doControl('setNetworkDebuggerAllowed', true, function (res) {
      assert.strictEqual(res.ok, true);
      assert.strictEqual(written.allowNetworkDebugger, true);
      assert.strictEqual(devtools.status(), 'allowed');
    });

    controls.doControl('setNetworkDebuggerAllowed', false, function (res) {
      assert.strictEqual(res.ok, true);
      assert.strictEqual(written.allowNetworkDebugger, false);
      assert.strictEqual(devtools.status(), 'closed');
    });
  });
});

test('setNetworkDebuggerAllowed is refused when controls are disabled', function () {
  var controls = require('../server/lib/controls');
  controls.init({
    config: { allowControl: false },
    devtools: devtools
  });
  controls.doControl('setNetworkDebuggerAllowed', true, function (res) {
    assert.strictEqual(res.ok, false);
  });
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
