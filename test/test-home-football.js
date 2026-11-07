var assert = require('assert');
var football = require('../server/lib/home-football');
var time = Date.UTC(2026, 10, 7, 12, 30), jobs = [], result, other;
function init() {
  jobs = [];
  football.init({ now: function () { return time; }, fetchJson: function (url, cb) { jobs.push({ url: url, reply: cb }); } });
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
chosen.teams = [{ id: '20', name: 'Away FC' }];
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(result.matches.length, 2, 'away-team favourites are included');
chosen.teams[0].id = '99';
football.read(chosen, function (reply) { result = reply; });
assert.strictEqual(result.matches.length, 0, 'unselected teams are hidden');
assert.strictEqual(jobs.length, 1, 'filters share the cached league feed');
chosen.teams = [];
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

init(); time = Date.UTC(2026, 10, 8, 0, 30);
football.read(settings(), function (reply) { result = reply; });
assert.strictEqual(jobs.length, 2, 'after midnight, games from the previous UTC day remain included');
assert.ok(jobs[0].url.indexOf('dates=20261108') !== -1);
assert.ok(jobs[1].url.indexOf('dates=20261107') !== -1);
jobs[0].reply(null, { events: [] }); jobs[1].reply(null, board());
assert.strictEqual(result.matches.length, 2);

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
