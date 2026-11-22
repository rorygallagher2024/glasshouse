/**
 * test-updateask.js - lib/updateask.js: a new release asked about on the TV
 * once the picture is on, installed on Update now, and asked about again only
 * when left unanswered.
 */
var assert = require('assert');
var updateAsk = require('../server/lib/updateask');

var summary, asked, installed, saved, screenOn, config;

function setup(over) {
  summary = { available: true, latest: '0.160.0', notes: 'Shorter waits after a wake. New screen savers.' };
  asked = [];
  installed = 0;
  saved = [];
  screenOn = true;
  config = { allowControl: true, update: { check: true, askOnTv: true } };
  var opts = {
    config: config,
    updater: { isBusy: function () { return false; }, updateSummary: function () { return summary; } },
    ask: { ask: function (q, cb) { asked.push(q); cb({ ok: true }); } },
    writeSettings: function (patch, cb) { saved.push(patch); cb(null); },
    install: function (cb) { installed++; cb({ ok: true }); },
    screenOn: function () { return screenOn; },
    wakeDelayMs: 5
  };
  for (var k in over || {}) opts[k] = over[k];
  updateAsk.init(opts);
}

function answer(eventType, choice) {
  return updateAsk.onAskEvent({ id: updateAsk.ASK_ID, event_type: eventType, choice: choice });
}

// Asked while the picture is on, with the release's own summary.
setup();
updateAsk.onUpdateChange();
assert.strictEqual(asked.length, 1);
assert.strictEqual(asked[0].id, 'glasshouse-update');
assert.strictEqual(asked[0].title, 'Glasshouse 0.160.0 is out');
assert.strictEqual(asked[0].message, 'Shorter waits after a wake. New screen savers.');
assert.deepEqual(asked[0].options.map(function (o) { return o.id; }), ['install', 'later']);
updateAsk.onUpdateChange();
assert.strictEqual(asked.length, 1, 'one question at a time');

// Update now installs it and is remembered.
assert.strictEqual(answer('answer', 'install'), true);
assert.strictEqual(installed, 1);
assert.deepEqual(saved, [{ update: { askedVersion: '0.160.0' } }]);
updateAsk.onUpdateChange();
assert.strictEqual(asked.length, 1, 'an answered release is not asked about again');

// Later and Back are remembered too, without installing.
setup();
updateAsk.onUpdateChange();
answer('dismissed');
assert.strictEqual(installed, 0);
assert.strictEqual(config.update.askedVersion, '0.160.0');

// Unanswered: asked again the next time.
setup();
updateAsk.onUpdateChange();
answer('timeout');
assert.strictEqual(saved.length, 0);
updateAsk.onUpdateChange();
assert.strictEqual(asked.length, 2, 'a release left unanswered is asked about again');

// Another question's events are not this module's.
assert.strictEqual(updateAsk.onAskEvent({ id: 'cinema', event_type: 'answer', choice: 'yes' }), false);

// Not asked with the switch off, controls off, or nothing newer.
setup();
config.update.askOnTv = false;
updateAsk.onUpdateChange();
config.update.askOnTv = true;
config.allowControl = false;
updateAsk.onUpdateChange();
config.allowControl = true;
summary.available = false;
updateAsk.onUpdateChange();
assert.strictEqual(asked.length, 0);

// Switching it on asks straight away.
setup();
config.update.askOnTv = false;
updateAsk.setEnabled(true, function (r) {
  assert.strictEqual(r.ok, true);
  assert.deepEqual(saved[0], { update: { askOnTv: true } });
  assert.strictEqual(asked.length, 1);

  // A release found with the picture off is asked about once it comes on.
  setup();
  screenOn = false;
  updateAsk.onUpdateChange();
  assert.strictEqual(asked.length, 0);
  screenOn = true;
  updateAsk.onScreenOn();
  var waited = setInterval(function () {
    if (!asked.length) return;
    clearInterval(waited);
    assert.strictEqual(asked[0].title, 'Glasshouse 0.160.0 is out');

    // A long summary is cut at a sentence to fit the card.
    var long = updateAsk.summaryOf({ notes: new Array(30).join('A sentence here. ') });
    assert.ok(long.length <= 190 && /\.$/.test(long));
    console.log('ALL test-updateask.js assertions passed!');
  }, 2);
});
