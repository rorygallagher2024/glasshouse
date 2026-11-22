/**
 * test/test-scores.js - The day's matches come from ESPN's scoreboard for each
 * chosen league on the TV's date, as sides, score, kick-off and where they
 * stand, sorted by kick-off; a league that fails is left out while another
 * answers, and unknown leagues are not asked about. The Scores screen
 * saver's board words each match, says when there are none, reads ESPN once
 * a minute however often it is asked, and keeps the day's last answer when a
 * read fails.
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

  answers['eng.1'] = new Error('offline');
  scores.today(['soccer/eng.1'], now, function (err2) {
    assert.ok(err2, 'an error when no league answers');
    scores.today([], now, function (err3, none) {
      assert.ifError(err3);
      assert.deepEqual(none, []);
      console.log('  ✓ no league answering is an error, none chosen is an empty day');
      saverSteps();
    });
  });
});

function saverSteps() {
  var kick = Date.parse('2026-11-22T16:30Z');
  var kickHm = function (d) { return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); };
  answers['eng.1'] = { events: [
    event('2026-11-22T16:30Z', 'pre', 'STATUS_SCHEDULED', "0'", 'Liverpool', '0', 'Man Utd', '0'),
    event('2026-11-22T14:00Z', 'in', 'STATUS_HALFTIME', 'HT', 'Hull', '2', 'Brighton', '1'),
    event('2026-11-22T12:00Z', 'post', 'STATUS_FULL_TIME', "90'", 'Leeds', '0', 'Wolves', '3'),
    event('2026-11-22T11:00Z', 'post', 'STATUS_POSTPONED', "0'", 'Spurs', '0', 'Everton', '0')
  ] };
  answers['uefa.champions'] = { events: [] };
  asked = [];
  scores.resetCache();
  scores.saverBoard(['soccer/eng.1', 'soccer/uefa.champions', 'soccer/eng.1', 'nope'], now, false, function (b) {
    assert.strictEqual(b.ok, true);
    assert.deepEqual(b.leagues, ['PL', 'CL'], 'each league once, unknown ones dropped');
    assert.deepEqual(b.names, { PL: 'Premier League', CL: 'Champions League' }, 'the names the saver heads its groups with');
    assert.strictEqual(b.note, '');
    assert.deepEqual(b.matches.map(function (m) { return m.detail; }), ['Postponed', 'FT', 'HT', kickHm(new Date(kick))]);
    assert.deepEqual(b.matches[2], { league: 'PL', home: 'Hull', away: 'Brighton', homeScore: '2', awayScore: '1', state: 'in', detail: 'HT' });
    assert.strictEqual(b.matches[3].homeScore, '', 'no score before kick-off');
    console.log('  ✓ the screen saver\'s board words each match: postponed, full time, half time, kick-off');

    var before = asked.length;
    scores.saverBoard(['soccer/eng.1', 'soccer/uefa.champions'], now + 30000, true, function (b2) {
      assert.strictEqual(asked.length, before, 'within a minute, ESPN is not asked again');
      var d = new Date(kick);
      assert.strictEqual(b2.matches[3].detail, ((d.getHours() % 12) || 12) + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() + (d.getHours() < 12 ? ' AM' : ' PM'), 'the TV\'s 12-hour clock');
      answers['eng.1'] = new Error('offline');
      answers['uefa.champions'] = new Error('offline');
      scores.saverBoard(['soccer/eng.1', 'soccer/uefa.champions'], now + 61000, false, function (b3) {
        assert.strictEqual(asked.length, before + 2, 'asked again after a minute');
        assert.strictEqual(b3.ok, true);
        assert.strictEqual(b3.matches.length, 4, 'a failed read keeps the day\'s last answer');
        scores.saverBoard(['soccer/swe.1'], now, false, function (b4) {
          assert.strictEqual(b4.ok, false, 'nothing read at all');
          answers['swe.1'] = { events: [] };
          scores.saverBoard(['soccer/swe.1'], now + 1, false, function (b5) {
            assert.strictEqual(b5.ok, true);
            assert.deepEqual(b5.matches, []);
            assert.strictEqual(b5.note, 'No matches today');
            assert.strictEqual(b5.title, 'Today’s matches');
            console.log('  ✓ ESPN is read once a minute, a failed read keeps the last answer, and an empty day says so');
            var say = require('../server/lib/say');
            say.init(require('path').join(__dirname, '..', 'server', 'assets', 'i18n'));
            assert.strictEqual(say.langOfLocale('sv_SE'), 'sv');
            assert.strictEqual(say.langOfLocale('pt-BR'), 'pt-br', 'a region with its own file');
            assert.strictEqual(say.langOfLocale('es_MX'), 'es');
            assert.strictEqual(say.langOfLocale('en_GB'), null);
            assert.strictEqual(say.langOfLocale(''), null);
            var sv = JSON.parse(say.translateBody(JSON.stringify(b5), 'sv'));
            assert.strictEqual(sv.note, 'Inga matcher i dag', 'worded in the TV\'s language');
            assert.strictEqual(sv.title, 'Dagens matcher');
            console.log('  ✓ the board is worded in the language of the TV\'s locale');
            console.log('\nALL test-scores.js assertions passed!\n');
          });
        });
      });
    });
  });
}
