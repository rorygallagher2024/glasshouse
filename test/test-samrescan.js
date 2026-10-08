/**
 * test/test-samrescan.js - sam is made to read its apps again by nudging
 * configd's blocked-app list, which is put back exactly as LG had it; without
 * the list (webOS 4) the caller is told to restart sam instead (#366)
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-samrescan.js ...');

var KEY = samrescan.KEY, NUDGE = samrescan.NUDGE_ID;

// A configd holding the list (or not), recording each list written to it.
function fakeTV(list, opts) {
  opts = opts || {};
  var tv = { list: list, writes: [], failWrites: opts.failWrites || 0 };
  tv.luna = function (uri, payload, cb) {
    var r;
    if (uri === 'com.webos.service.config/getConfigs') {
      var configs = {};
      if (tv.list) configs[KEY] = tv.list.slice();
      r = tv.list ? { returnValue: true, configs: configs } : { returnValue: true, configs: {}, missingConfigs: [KEY] };
    } else if (uri === 'com.webos.service.config/setConfigs') {
      if (tv.failWrites > 0 && tv.writes.length) { tv.failWrites--; r = { returnValue: false }; }
      else { tv.list = payload.configs[KEY].slice(); r = { returnValue: true }; }
      tv.writes.push(payload.configs[KEY].slice());
    } else {
      r = { returnValue: true };
    }
    setTimeout(function () { cb(r); }, 1);
  };
  return tv;
}

// A failure inside a timer would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

var steps = [];
function step(fn) { steps.push(fn); }
function next() { var f = steps.shift(); if (f) f(); else { console.log('ALL test-samrescan.js assertions passed!\n'); process.exit(0); } }

// 1. No list (webOS 4): nothing written, and the caller restarts sam.
step(function () {
  var tv = fakeTV(null);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(tv.writes.length, 0, 'nothing written to configd');
    console.log('  ✓ without the list, nothing is written and the caller restarts sam');
    next();
  }));
});

// 2. LG's own entries are put back exactly, after the nudge id was added.
step(function () {
  var tv = fakeTV(['com.webos.app.roomconnect', 'netflix']);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.deepEqual(tv.writes[0], ['com.webos.app.roomconnect', 'netflix', NUDGE]);
    assert.deepEqual(tv.list, ['com.webos.app.roomconnect', 'netflix']);
    console.log('  ✓ the nudge adds an id no app has, then puts LG\'s list back exactly');
    next();
  }));
});

// 3. A nudge id left by a run cut short is not kept as LG's.
step(function () {
  var tv = fakeTV(['netflix', NUDGE]);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function () {
    assert.deepEqual(tv.list, ['netflix']);
    console.log('  ✓ a nudge id left behind is dropped, not put back');
    next();
  }));
});

// 4. Waits for sam to catch up, and gives up so the caller can restart it.
step(function () {
  var tv = fakeTV([]);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  var asked = 0;
  samrescan.refresh(function (done) { asked++; done(asked >= 3); }, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(asked, 3, 'asked until sam had it');
    samrescan.refresh(function (done) { done(false); }, checked(function (ok2) {
      assert.strictEqual(ok2, false, 'never caught up');
      assert.deepEqual(tv.list, [], 'the list is back even so');
      console.log('  ✓ it waits for sam to have the change, and gives up if it never does');
      next();
    }));
  }));
});

// 5. Two at once: the second does not read the list mid-nudge.
step(function () {
  var tv = fakeTV(['netflix']);
  samrescan.init({ luna: tv.luna, nudgeMs: 20, pollMs: 5 });
  var done = 0;
  function both() {
    if (++done < 2) return;
    tv.writes.forEach(function (w) {
      assert.ok(w.filter(function (id) { return id === NUDGE; }).length <= 1, 'one nudge id at most: ' + w);
    });
    assert.deepEqual(tv.list, ['netflix']);
    console.log('  ✓ nudges asked for together run one after another');
    next();
  }
  samrescan.refresh(null, checked(both));
  samrescan.refresh(null, checked(both));
});

// 6. A failed restore is tried again.
step(function () {
  var tv = fakeTV(['netflix'], { failWrites: 1 });
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.deepEqual(tv.list, ['netflix']);
    console.log('  ✓ putting the list back is tried again if configd refuses it');
    next();
  }));
});

next();
