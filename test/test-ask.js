/**
 * test/test-ask.js - A question sent to command/ask opens the question app,
 * installed the first time, and its answer, Back, its time running out or a
 * newer question each end it with one event; answers to a question already
 * ended are dropped.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');

// Timers are kept rather than run, so the server's own timeout fires when
// the test says.
var timers = [];
global.setTimeout = function (fn, ms) { var t = { fn: fn, ms: ms, unref: function () {} }; timers.push(t); return t; };
global.clearTimeout = function (t) { var i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); };

var ask = require('../server/lib/ask');

console.log('Running test-ask.js ...');

var launches = [], events = [], appActions = [], installedNow = false, refuseLaunch = false;
ask.init({
  luna: function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/launch') launches.push(params);
    cb(refuseLaunch ? { returnValue: false, errorText: 'no' } : { returnValue: true });
  },
  tvApp: function (action, cb) {
    appActions.push(action);
    if (action === 'status') return cb({ ok: true, installed: installedNow });
    if (action === 'install') { installedNow = true; return cb({ ok: true }); }
  },
  publish: function (ev) { events.push(ev); }
});

// Parsing: plain text is a title; options are capped and defaulted.
var p = ask.parse('Cinema mode?').question;
assert.strictEqual(p.title, 'Cinema mode?');
assert.deepEqual(p.options.map(function (o) { return o.id; }), ['yes', 'no']);
assert.strictEqual(p.timeout, 30);
assert.ok(ask.parse('{nope').error);
assert.ok(ask.parse('{"options":["a"]}').error);
var many = ask.parse({ title: 'x', options: ['a', 'b', 'c', 'd', 'e'], timeout: 9999, focus: 3 }).question;
assert.strictEqual(many.options.length, 4);
assert.strictEqual(many.timeout, 600);
assert.strictEqual(many.focus, 3);
console.log('  ✓ a question is read from text or JSON, with options capped and Yes/No by default');

// First question: installed, then launched; the answer is published once.
var result = null;
ask.ask(JSON.stringify({ id: 'cinema', title: 'Cinema?', options: [{ id: 'ja', label: 'Ja' }, { id: 'nej', label: 'Nej' }], timeout: 25 }),
  function (r) { result = r; });
assert.deepEqual(result, { ok: true });
assert.deepEqual(appActions, ['status', 'install']);
assert.strictEqual(launches.length, 1);
assert.strictEqual(launches[0].id, ask.APP);
var cur = ask.current();
assert.strictEqual(cur.title, 'Cinema?');
assert.strictEqual(cur.options[1].label, 'Nej');
assert.strictEqual(ask.answer(cur.seq, 'maybe'), false, 'an option not offered is refused');
assert.strictEqual(ask.answer(cur.seq + 1, 'ja'), false, 'another question\'s answer is refused');
assert.strictEqual(ask.answer(cur.seq, 'ja'), true);
assert.deepEqual(events, [{ event_type: 'answer', id: 'cinema', choice: 'ja', label: 'Ja' }]);
assert.strictEqual(ask.current(), null);
assert.strictEqual(ask.answer(cur.seq, 'ja'), false, 'answered once only');
assert.strictEqual(timers.length, 0, 'the server\'s timeout is cleared by the answer');
console.log('  ✓ the first question installs the app, and its answer is published once');

// Installed now: not looked at again. Back dismisses.
events = [];
ask.ask({ id: 'q2', title: 'Two' });
assert.deepEqual(appActions, ['status', 'install']);
ask.answer(ask.current().seq, '', 'dismissed');
assert.deepEqual(events, [{ event_type: 'dismissed', id: 'q2' }]);
console.log('  ✓ Back is published as dismissed');

// A newer question replaces one waiting.
events = [];
ask.ask({ id: 'old', title: 'Old' });
var oldSeq = ask.current().seq;
ask.ask({ id: 'new', title: 'New' });
assert.deepEqual(events, [{ event_type: 'replaced', id: 'old' }]);
assert.strictEqual(ask.answer(oldSeq, 'yes'), false);
assert.strictEqual(ask.current().id, 'new');
console.log('  ✓ a newer question replaces the one waiting');

// The page timing out, and the server's own timeout behind it.
events = [];
ask.answer(ask.current().seq, '', 'timeout');
assert.deepEqual(events, [{ event_type: 'timeout', id: 'new' }]);
events = [];
ask.ask({ id: 'lost', title: 'Lost', timeout: 10 });
assert.strictEqual(timers.length, 1);
assert.strictEqual(timers[0].ms, 15000);
timers.shift().fn();
assert.deepEqual(events, [{ event_type: 'timeout', id: 'lost' }]);
console.log('  ✓ a question left alone times out, from the page or the server');

// Taken away from elsewhere, as when answered on a phone.
events = [];
ask.ask({ id: 'phone', title: 'Phone' });
assert.strictEqual(ask.close('other'), false, 'another question\'s id leaves it');
assert.strictEqual(ask.close('phone'), true);
assert.deepEqual(events, [{ event_type: 'closed', id: 'phone' }]);
assert.strictEqual(ask.current(), null);
assert.strictEqual(ask.close(''), false);
console.log('  ✓ askClose takes the question away and the page closes');

// A launch the TV refuses ends the question as failed.
events = [];
refuseLaunch = true;
ask.ask({ id: 'nope', title: 'Nope' }, function (r) { result = r; });
assert.strictEqual(result.ok, false);
assert.deepEqual(events, [{ event_type: 'failed', id: 'nope' }]);
assert.strictEqual(ask.current(), null);
console.log('  ✓ a launch the TV refuses is published as failed');

console.log('\nALL test-ask.js assertions passed!\n');
