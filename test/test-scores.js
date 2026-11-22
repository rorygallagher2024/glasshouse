/**
 * test/test-scores.js - The day's matches come from ESPN's scoreboard for each
 * chosen league on the TV's date, as sides, score, kick-off and where they
 * stand, sorted by kick-off; a league that fails is left out while another
 * answers, and unknown leagues are not asked about.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var scores = require('../server/lib/scores');

console.log('Running test-scores.js ...');

function event(date, state, name, clock, home, hs, away, as) {
  return { date: date, competitions: [{ status: { displayClock: clock, type: { state: state, name: name } },
    competitors: [
      { homeAway: 'home', score: hs, team: { shortDisplayName: home } },
      { homeAway: 'away', score: as, team: { shortDisplayName: away } }
    ] }] };
}

var asked = [];
var answers = {};
scores.init({ getJson: function (url, cb) {
  asked.push(url);
  var hit = null;
  for (var k in answers) if (url.indexOf(k) !== -1) hit = answers[k];
  setTimeout(function () { return hit instanceof Error ? cb(hit) : cb(null, hit); }, 0);
} });

var now = new Date(2026, 10, 22, 12, 0, 0).getTime();
assert.strictEqual(scores.dayOf(now), '20261122');
assert.strictEqual(scores.league('soccer/eng.1').short, 'PL');
assert.strictEqual(scores.league('soccer/nowhere'), null);

answers['eng.1'] = { events: [
  event('2026-11-22T16:30Z', 'pre', 'STATUS_SCHEDULED', "0'", 'Liverpool', '0', 'Man Utd', '0'),
  event('2026-11-22T14:00Z', 'in', 'STATUS_IN_PROGRESS', "67'", 'Hull', '2', 'Brighton', '1'),
  { date: '2026-11-22T10:00Z', competitions: [{ competitors: [] }] }
] };
answers['uefa.champions'] = new Error('offline');

scores.today(['soccer/eng.1', 'soccer/uefa.champions', 'soccer/nowhere'], now, function (err, matches) {
  assert.ifError(err);
  assert.strictEqual(asked.length, 2, 'an unknown league is not asked about');
  assert.ok(/soccer\/eng\.1\/scoreboard\?dates=20261122$/.test(asked[0]), 'the TV\'s date');
  assert.strictEqual(matches.length, 2, 'a failed league and a malformed event left out');
  assert.deepEqual(matches[0], { league: 'soccer/eng.1', start: Date.parse('2026-11-22T14:00Z'), state: 'in',
    status: 'STATUS_IN_PROGRESS', clock: "67'", home: 'Hull', away: 'Brighton', homeScore: '2', awayScore: '1' }, 'by kick-off');
  assert.strictEqual(matches[1].state, 'pre');
  console.log('  ✓ matches are read per league, sorted by kick-off, with a failed league left out');
  assert.strictEqual(scores.shortName('Brommapojkar', 'IF Brommapojkarna'), 'Brommapojkarna', 'cut at 12 by ESPN');
  assert.strictEqual(scores.shortName('Man Utd', 'Manchester United'), 'Man Utd');
  assert.strictEqual(scores.shortName('Malmö', 'Malmö FF'), 'Malmö');
  assert.strictEqual(scores.shortName('Paris SG', 'Paris Saint-Germain'), 'Paris SG');
  assert.strictEqual(scores.shortName('', 'Örgryte IS'), '');
  console.log('  ✓ a short name ESPN cut off is completed from the full name');

  answers['eng.1'] = new Error('offline');
  scores.today(['soccer/eng.1'], now, function (err2) {
    assert.ok(err2, 'an error when no league answers');
    scores.today([], now, function (err3, none) {
      assert.ifError(err3);
      assert.deepEqual(none, []);
      console.log('  ✓ no league answering is an error, none chosen is an empty day');
      console.log('\nALL test-scores.js assertions passed!\n');
    });
  });
});
