/**
 * test-updateask.js - lib/updateask.js: a new release asked about on the TV
 * after a wake, with Later focused, installed on Update now with a toast, and
 * asked about again only when left unanswered.
 */
var assert = require('assert');
var updateAsk = require('../server/lib/updateask');

var summary, asked, installed, installResult, saved, toasts, screenOn, config, otherQuestion;

function setup(over) {
  summary = { available: true, latest: '0.160.0', notes: 'Shorter waits after a wake. New screen savers.' };
  asked = [];
  installed = 0;
  installResult = { ok: true };
  saved = [];
  toasts = [];
  screenOn = true;
  otherQuestion = false;
  config = { allowControl: true, update: { check: true, askOnTv: true } };
  var opts = {
    config: config,
    updater: { isBusy: function () { return false; }, updateSummary: function () { return summary; } },
    ask: {
      ask: function (q, cb) { asked.push(q); cb({ ok: true }); },
      busy: function () { return otherQuestion; }
    },
    writeSettings: function (patch, cb) { saved.push(patch); cb(null); },
    install: function (cb) { installed++; cb(installResult); },
    toast: function (text) { toasts.push(text); },
    screenOn: function () { return screenOn; },
    wakeDelayMs: 1,
    busyRetryMs: 1
  };
  for (var k in over || {}) opts[k] = over[k];
  updateAsk.init(opts);
}

function answer(eventType, choice) {
  return updateAsk.onAskEvent({ id: updateAsk.ASK_ID, event_type: eventType, choice: choice });
}

// Calls then() once fn() is true.
function waitFor(fn, then) {
  var timer = setInterval(function () {
    if (!fn()) return;
    clearInterval(timer);
    then();
  }, 1);
}

var steps = [];
function step(fn) { steps.push(fn); }
function next() {
  var fn = steps.shift();
  if (!fn) return console.log('ALL test-updateask.js assertions passed!');
  fn(next);
}

// Asked after a wake, with the release's own summary and Later focused.
step(function (done) {
  setup();
  updateAsk.onWake();
  waitFor(function () { return asked.length; }, function () {
    assert.strictEqual(asked[0].id, 'glasshouse-update');
    assert.strictEqual(asked[0].title, 'Glasshouse 0.160.0 is out');
    assert.strictEqual(asked[0].message, 'Shorter waits after a wake. New screen savers.');
    assert.deepEqual(asked[0].options.map(function (o) { return o.id; }), ['install', 'later']);
    assert.strictEqual(asked[0].focus, 1, 'Later has the focus');
    assert.strictEqual(updateAsk.maybeAsk(), 'no', 'one question at a time');

    // Update now installs it with a toast and is remembered.
    assert.strictEqual(answer('answer', 'install'), true);
    assert.strictEqual(installed, 1);
    assert.strictEqual(toasts.length, 1);
    assert.ok(/0\.160\.0/.test(toasts[0]));
    assert.deepEqual(saved, [{ update: { askedVersion: '0.160.0' } }]);
    assert.strictEqual(updateAsk.maybeAsk(), 'no', 'an answered release is not asked about again');
    done();
  });
});

// A failed install says so on the TV.
step(function (done) {
  setup();
  installResult = { ok: false, error: 'download failed' };
  assert.strictEqual(updateAsk.maybeAsk(), 'asked');
  answer('answer', 'install');
  assert.strictEqual(toasts.length, 2);
  assert.ok(/download failed/.test(toasts[1]));
  done();
});

// Later and Back are remembered too, without installing.
step(function (done) {
  setup();
  updateAsk.maybeAsk();
  answer('dismissed');
  assert.strictEqual(installed, 0);
  assert.strictEqual(toasts.length, 0);
  assert.strictEqual(config.update.askedVersion, '0.160.0');
  done();
});

// Unanswered: asked again the next time.
step(function (done) {
  setup();
  updateAsk.maybeAsk();
  answer('timeout');
  assert.strictEqual(saved.length, 0);
  assert.strictEqual(updateAsk.maybeAsk(), 'asked', 'a release left unanswered is asked about again');
  // Another question's events are not this module's.
  assert.strictEqual(updateAsk.onAskEvent({ id: 'cinema', event_type: 'answer', choice: 'yes' }), false);
  done();
});

// Not asked with the switch off, the daily check off, controls off, nothing newer or the picture off.
step(function (done) {
  setup();
  config.update.askOnTv = false;
  assert.strictEqual(updateAsk.maybeAsk(), 'no');
  config.update.askOnTv = true;
  config.update.check = false;
  assert.strictEqual(updateAsk.maybeAsk(), 'no', 'the daily check off');
  config.update.check = true;
  config.allowControl = false;
  assert.strictEqual(updateAsk.maybeAsk(), 'no');
  config.allowControl = true;
  screenOn = false;
  assert.strictEqual(updateAsk.maybeAsk(), 'no');
  screenOn = true;
  summary.available = false;
  assert.strictEqual(updateAsk.maybeAsk(), 'no');
  assert.strictEqual(asked.length, 0);
  done();
});

// Switching it on saves it and waits for a wake.
step(function (done) {
  setup();
  config.update.askOnTv = false;
  updateAsk.setEnabled(true, function (r) {
    assert.strictEqual(r.ok, true);
    assert.deepEqual(saved[0], { update: { askOnTv: true } });
    assert.strictEqual(config.update.askOnTv, true);
    assert.strictEqual(asked.length, 0);
    done();
  });
});

// Another question up at the wake: it waits for that one to go.
step(function (done) {
  setup();
  otherQuestion = true;
  updateAsk.onWake();
  setTimeout(function () {
    assert.strictEqual(asked.length, 0, 'not over another question');
    otherQuestion = false;
    waitFor(function () { return asked.length; }, function () {
      assert.strictEqual(asked[0].title, 'Glasshouse 0.160.0 is out');

      // A long summary is cut at a sentence to fit the card.
      var long = updateAsk.summaryOf({ notes: new Array(30).join('A sentence here. ') });
      assert.ok(long.length <= 190 && /\.$/.test(long));
      done();
    });
  }, 5);
});

next();
