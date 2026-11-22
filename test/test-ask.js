/**
 * test/test-ask.js - A question sent to command/ask opens the question app,
 * installed the first time, and its answer, Back, its time running out or a
 * newer question each end it with one event; answers to a question already
 * ended, or without the question's token, are dropped.
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
// The token the app was last launched with.
function tok() { return launches[launches.length - 1].params.token; }
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
var token = tok();
assert.ok(/^[0-9a-f]{32}$/.test(token), 'the app is launched with the question\'s token');
assert.strictEqual(ask.current(), null, 'no token, no question');
var wrong = (token.charAt(0) === 'a' ? 'b' : 'a') + token.slice(1);
assert.strictEqual(ask.current(wrong), null, 'a wrong token reads nothing');
var cur = ask.current(token);
assert.strictEqual(cur.title, 'Cinema?');
assert.strictEqual(cur.options[1].label, 'Nej');
assert.strictEqual(cur.token, undefined, 'the token is not handed back');
assert.strictEqual(ask.answer(token, 'maybe'), false, 'an option not offered is refused');
assert.strictEqual(ask.answer(String(cur.seq), 'ja'), false, 'the seq alone answers nothing');
assert.strictEqual(ask.answer('', 'ja'), false);
assert.strictEqual(ask.answer(token, 'ja'), true);
assert.deepEqual(events, [{ event_type: 'answer', id: 'cinema', choice: 'ja', label: 'Ja' }]);
assert.strictEqual(ask.current(token), null);
assert.strictEqual(ask.answer(token, 'ja'), false, 'answered once only');
assert.strictEqual(timers.length, 0, 'the server\'s timeout is cleared by the answer');
console.log('  ✓ the first question installs the app, and its answer is published once');

// Installed now: not looked at again. Back dismisses.
events = [];
ask.ask({ id: 'q2', title: 'Two' });
assert.deepEqual(appActions, ['status', 'install']);
ask.answer(tok(), '', 'dismissed');
assert.deepEqual(events, [{ event_type: 'dismissed', id: 'q2' }]);
console.log('  ✓ Back is published as dismissed');

// A newer question replaces one waiting.
events = [];
ask.ask({ id: 'old', title: 'Old' });
var oldToken = tok();
ask.ask({ id: 'new', title: 'New' });
assert.deepEqual(events, [{ event_type: 'replaced', id: 'old' }]);
assert.notStrictEqual(tok(), oldToken, 'each question has its own token');
assert.strictEqual(ask.answer(oldToken, 'yes'), false);
assert.strictEqual(ask.current(oldToken), null);
assert.strictEqual(ask.current(tok()).id, 'new');
console.log('  ✓ a newer question replaces the one waiting');

// The page timing out, and the server's own timeout behind it.
events = [];
ask.answer(tok(), '', 'timeout');
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
assert.strictEqual(ask.current(tok()), null);
assert.strictEqual(ask.close(''), false);
console.log('  ✓ askClose takes the question away and the page closes');

// A launch the TV refuses ends the question as failed.
events = [];
refuseLaunch = true;
ask.ask({ id: 'nope', title: 'Nope' }, function (r) { result = r; });
assert.strictEqual(result.ok, false);
assert.deepEqual(events, [{ event_type: 'failed', id: 'nope' }]);
assert.strictEqual(ask.current(tok()), null);
console.log('  ✓ a launch the TV refuses is published as failed');

console.log('\nALL test-ask.js assertions passed!\n');
