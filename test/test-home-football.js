var assert = require('assert');
var football = require('../server/lib/home-football');
var time = Date.UTC(2026, 10, 7, 12, 30), jobs = [], timers = [], result, other;
function init() {
  jobs = []; timers = [];
  football.init({ now: function () { return time; }, fetchJson: function (url, cb) { jobs.push({ url: url, reply: cb }); },
    setTimeout: function (callback, ms) { var timer = { callback: callback, ms: ms }; timers.push(timer); return timer; },
    clearTimeout: function (timer) { timer.cancelled = true; } });
}
function settings() { return { enabled: true, leagues: [{ id: 'fra.1', name: 'Ligue 1' }], teams: [] }; }
function event(id, state, status, homeScore) {
  return { id: id, competitions: [{ status: { type: { state: state, name: status, shortDetail: "42'" } }, competitors: [
    { homeAway: 'away', score: '2', team: { id: '20', displayName: 'Away FC' } },
    { homeAway: 'home', score: homeScore, team: { id: '10', displayName: 'Home FC' } }
  ] }] };
}
var live = event('100', 'in', 'STATUS_IN_PROGRESS', '0');
function board() { return { events: [live, event('101', 'pre', 'STATUS_SCHEDULED', '0'), event('102', 'post', 'STATUS_FULL_TIME', '3'),
  event('103', 'in', 'STATUS_HALFTIME', '1'), event('104', 'in', 'STATUS_SUSPENDED', '0'), null] }; }
init();
football.read(null, function (reply) { result = reply; });
assert.strictEqual(result.available, false);
assert.strictEqual(jobs.length, 0, 'disabled football makes no provider requests');
var chosen = settings();
football.read(chosen, function (reply) { result = reply; });
football.read(chosen, function (reply) { other = reply; });
assert.strictEqual(jobs.length, 1, 'views share in-flight score requests');
assert.ok(jobs[0].url.indexOf('/fra.1/scoreboard?limit=1000&dates=20261107') !== -1, 'the provider accepts a single date');
jobs[0].reply(null, board());
assert.strictEqual(result.matches.length, 2, 'only live games and half-time appear');
assert.strictEqual(result.matches[0].home.score, 0, 'a zero score remains zero');
assert.deepEqual(result, other);
time += 60000;
football.read(chosen, function (reply) { result = reply; });
jobs[1].reply(new Error('offline'));
assert.strictEqual(result.available, false, 'old scores are never presented as live after a failure');
assert.deepEqual(result.matches, []);
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(jobs.length, 2, 'failures back off');
time += 30000;
football.read(chosen, function (reply) { result = reply; });
jobs[2].reply(null, {});
assert.strictEqual(result.available, false, 'malformed data differs from an empty scoreboard');
time += 30000;
football.read(chosen, function (reply) { result = reply; });
jobs[3].reply(null, { events: [] });
assert.strictEqual(result.available, true);
assert.strictEqual(result.matches.length, 0);

init(); chosen = settings();
chosen.leagues.push({ id: 'eng.1', name: 'Premier League' }, { id: 'esp.1', name: 'La Liga' });
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(jobs.length, 2, 'provider concurrency is bounded');
jobs[0].reply(null, board());
assert.strictEqual(jobs.length, 3, 'a completed request admits the next league');
jobs[1].reply(null, board()); jobs[2].reply(new Error('offline'));
assert.strictEqual(result.available, true);
assert.strictEqual(result.partial, true, 'one missing league never looks like complete coverage');
assert.strictEqual(result.matches.length, 2, 'the same match is not duplicated across feeds');
assert.strictEqual(jobs.length, 3);

init(); chosen = settings(); result = null;
chosen.leagues.push({ id: 'eng.1', name: 'Premier League' }, { id: 'esp.1', name: 'La Liga' });
var leagueReplies = 0;
football.read(chosen, function (reply) { result = reply; leagueReplies++; });
football.read(chosen, function (reply) { other = reply; });
assert.strictEqual(timers.length, 2, 'each league reader has its own response deadline');
assert.strictEqual(timers[0].ms, 15000);
assert.strictEqual(jobs.length, 2, 'league readers share the bounded provider queue');
timers[0].callback();
assert.strictEqual(result.loading, true, 'slow league reads return progress before Home times out');
assert.strictEqual(result.available, false, 'pending leagues do not imply a confirmed empty scoreboard');
assert.strictEqual(result.partial, true);
jobs[0].reply(null, board()); jobs[1].reply(null, { events: [] }); jobs[2].reply(null, { events: [] });
assert.strictEqual(leagueReplies, 1, 'late provider replies cannot answer a detached reader again');
assert.deepEqual(result.matches, [], 'late replies cannot mutate the progress response');
assert.strictEqual(other.loading, false, 'another reader still receives the completed shared requests');
assert.strictEqual(other.matches.length, 2);
assert.ok(timers[1].cancelled, 'completed league readers cancel their deadline');
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(result.loading, false, 'a retry uses the completed cache');
assert.strictEqual(jobs.length, 3, 'a progress response leaves the shared cache usable');
assert.ok(timers[2].cancelled, 'synchronous cache hits leave no deadline running');

init(); chosen = settings();
chosen.leagues.push({ id: 'eng.1', name: 'Premier League' });
football.read(chosen, function (reply) { result = reply; });
jobs[0].reply(null, board());
timers[0].callback();
assert.strictEqual(result.loading, true);
assert.strictEqual(result.available, true, 'received live games remain visible while another league is pending');
assert.strictEqual(result.matches.length, 2);
assert.strictEqual(result.partial, true);
jobs[1].reply(null, { events: [event('999', 'in', 'STATUS_IN_PROGRESS', '1')] });
assert.strictEqual(result.matches.length, 2, 'a late league cannot append to an already returned match list');

init(); time = Date.UTC(2026, 10, 8, 0, 30);
football.read(settings(), function (reply) { result = reply; });
assert.strictEqual(jobs.length, 2, 'after midnight, games from the previous UTC day remain included');
assert.ok(jobs[0].url.indexOf('dates=20261108') !== -1);
assert.ok(jobs[1].url.indexOf('dates=20261107') !== -1);
jobs[0].reply(null, { events: [] }); jobs[1].reply(null, board());
assert.strictEqual(result.matches.length, 2);

function favourites() { return { enabled: true, leagues: [], teams: [{ id: '20', name: 'Away FC' }] }; }
function completed(id, date, score) {
  var item = event(id, 'post', 'STATUS_FULL_TIME', { value: score });
  item.date = date; item.league = { name: 'International Friendly' };
  item.competitions[0].status.type.completed = true;
  item.competitions[0].competitors[0].score = { value: 0 };
  return item;
}
var recent = completed('201', '2026-11-07T20:00Z', 3), older = completed('202', '2026-10-01T20:00Z', 1);
init(); chosen = favourites();
football.read(chosen, function (reply) { result = reply; });
assert.ok(jobs[0].url.indexOf('/all/teams/20/schedule?fixture=true') !== -1, 'national teams need no league and follow all competitions');
jobs[0].reply(null, board());
assert.strictEqual(result.mode, 'live');
assert.strictEqual(result.matches.length, 2, 'away-team favourites are included');
assert.strictEqual(jobs.length, 1, 'live games take priority over all historical results');
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(jobs.length, 1, 'team fixture requests are shared and cached');

init();
football.read(chosen, function (reply) { result = reply; });
jobs[0].reply(null, { events: [] });
assert.ok(jobs[1].url.indexOf('/all/teams/20/schedule') !== -1);
var future = completed('203', '2027-01-01T20:00Z', 5), missingDate = completed('204', '', 2);
jobs[1].reply(null, { events: [older, future, recent, missingDate, live] });
assert.strictEqual(result.mode, 'latest');
assert.strictEqual(result.matches.length, 1);
assert.strictEqual(result.matches[0].id, '201', 'the latest completed result is chosen by date, never feed order');
assert.strictEqual(result.matches[0].date, '2026-11-07T20:00:00.000Z');
assert.strictEqual(result.matches[0].home.score, 3, 'schedule score objects are normalised');
assert.strictEqual(result.matches[0].away.score, 0);
assert.strictEqual(result.matches[0].league, 'International Friendly');

init(); chosen.teams.push({ id: '10', name: 'Home FC' });
football.read(chosen, function (reply) { result = reply; });
jobs[0].reply(null, { events: [] }); jobs[1].reply(null, { events: [] });
jobs[2].reply(null, { events: [recent] }); jobs[3].reply(null, { events: [recent] });
assert.strictEqual(result.matches.length, 1, 'one result can cover two selected opponents without duplicate rows');
assert.strictEqual(result.partial, false);

init();
football.read(chosen, function (reply) { result = reply; });
jobs[0].reply(null, { events: [] }); jobs[1].reply(null, { events: [] });
jobs[2].reply(null, { events: [] }); jobs[3].reply(new Error('offline'));
assert.strictEqual(result.available, true);
assert.strictEqual(result.partial, true);
assert.deepEqual(result.missingTeams, [{ id: '20', name: 'Away FC', unavailable: false }, { id: '10', name: 'Home FC', unavailable: true }]);

init(); chosen = favourites();
football.read(chosen, function (reply) { result = reply; });
jobs[0].reply(new Error('offline'));
assert.strictEqual(result.available, false);
assert.strictEqual(jobs.length, 1, 'an unknown live state is not replaced by historical scores');

init();
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(timers[0].ms, 15000);
timers[0].callback();
assert.strictEqual(result.loading, true, 'large or slow selections return progress before the HTTP timeout');
jobs[0].reply(null, { events: [] });
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(jobs.length, 2, 'a timed-out reader leaves the shared fetch cache usable');
jobs[1].reply(null, { events: [recent] });
assert.strictEqual(result.mode, 'latest');
assert.strictEqual(result.loading, false);

init(); chosen.teams = [];
for (var n = 1; n <= 64; n++) chosen.teams.push({ id: String(n), name: 'Team ' + n });
football.read(chosen, function (reply) { result = reply; });
for (var j = 0; j < 128; j++) { assert.ok(jobs[j]); jobs[j].reply(null, { events: [] }); }
assert.strictEqual(result.loading, false);
assert.strictEqual(result.missingTeams.length, 64, 'every selected team gets a result or an explicit no-result entry');
assert.strictEqual(jobs.length, 128);

init();
football.teams('../../bad', function (reply) { result = reply; });
assert.strictEqual(result.ok, false);
assert.strictEqual(jobs.length, 0);
football.leagues(function (reply) { result = reply; });
jobs[0].reply(null, { leagues: [{ slug: 'eng.1', name: 'Premier League' }, { slug: 'eng.1', name: 'Duplicate' }, { slug: 'https://bad', name: 'Bad' }, null] });
assert.deepEqual(result.leagues, [{ id: 'eng.1', name: 'Premier League' }]);
football.leagues(function (reply) { result = reply; });
assert.strictEqual(jobs.length, 1, 'league discovery is cached');
football.teams('eng.1', function (reply) { result = reply; });
jobs[1].reply(null, { sports: [{ leagues: [{ teams: [{ team: { id: '1', displayName: 'Arsenal' } }, { team: { id: 'x', displayName: 'Bad' } }, null] }] }] });
assert.deepEqual(result.teams, [{ id: '1', name: 'Arsenal' }]);
assert.deepEqual(football.normalise({ enabled: true, leagues: [{ id: 'https://bad', name: 'Bad' }], teams: [{ id: 'constructor', name: 'Bad' }] }),
  { enabled: true, leagues: [], teams: [] });
console.log('test-home-football.js passed');
