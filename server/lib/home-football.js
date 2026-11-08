var fetchJson = function (url, cb, opts) { require('./fetch').getJson(url, cb, opts); };
var now = Date.now;
var text = require('./home-widget-format').text;
var msg = require('./say').msg;
var BASE = 'https://site.api.espn.com/apis/site/v2/';
var cache = {}, queue = [], running = 0;
var FRESH_MS = 60000, RETRY_MS = 30000, CATALOGUE_MS = 6 * 60 * 60000;
var scheduleTimer = setTimeout, cancelTimer = clearTimeout, readTimers = [];
// Return progress before Home's 20-second HTTP timeout, even for 64 teams.
var READ_MS = 15000;

function leagueId(value) { return typeof value === 'string' && value.length <= 64 && /^[a-z0-9_]+(\.[a-z0-9_]+){1,4}$/.test(value) ? value : ''; }
function teamId(value) { return typeof value === 'string' && /^\d{1,12}$/.test(value) ? value : ''; }
function selections(raw, limit, id) {
  var result = [];
  if (Array.isArray(raw)) raw.slice(0, limit).forEach(function (item) {
    if (!item || !id(item.id) || !text(item.name, 80) || result.some(function (entry) { return entry.id === item.id; })) return;
    result.push({ id: item.id, name: text(item.name, 80) });
  });
  return result;
}
function normalise(raw) {
  raw = raw || {};
  return { enabled: raw.enabled === true, leagues: selections(raw.leagues, 8, leagueId), teams: selections(raw.teams, 64, teamId) };
}
function unavailable() { return { ok: true, available: false, matches: [] }; }
function prune() {
  var keys = Object.keys(cache).filter(function (key) { return !cache[key].pending; });
  keys.sort(function (a, b) { return cache[a].used - cache[b].used; });
  while (Object.keys(cache).length >= 160 && keys.length) delete cache[keys.shift()];
}
function pump() {
  if (running >= 2 || !queue.length) return;
  var job = queue.shift(); running++;
  fetchJson(BASE + job.path, function (err, raw) {
    var data = null;
    if (!err) { try { data = job.parse(raw); } catch (e) {} }
    job.entry.data = data; job.entry.updated = now();
    job.entry.next = now() + (data ? job.ttl : RETRY_MS);
    var waiters = job.entry.pending; job.entry.pending = null; running--;
    waiters.forEach(function (done) { done(data, job.entry.updated); });
    pump();
  }, { maxBuffer: 2 * 1024 * 1024 });
  pump();
}
function request(key, path, parse, ttl, cb) {
  var entry = cache[key];
  if (entry) {
    entry.used = now();
    if (entry.pending) { entry.pending.push(cb); return detach(entry, cb); }
    if (now() < entry.next) return cb(entry.data, entry.updated);
  } else {
    prune();
    if (Object.keys(cache).length >= 160) return cb(null);
    entry = { data: null, updated: 0, next: 0, used: now(), pending: null }; cache[key] = entry;
  }
  entry.pending = [cb];
  queue.push({ entry: entry, path: path, parse: parse, ttl: ttl }); pump();
  return detach(entry, cb);
}
function detach(entry, cb) {
  return function () {
    if (!entry.pending) return;
    var index = entry.pending.indexOf(cb);
    if (index !== -1) entry.pending.splice(index, 1);
  };
}
function leagues(cb) {
  request('leagues', 'leagues/dropdown?region=us&lang=en&sport=soccer', function (raw) {
    if (!raw || !Array.isArray(raw.leagues) || !raw.leagues.length) return null;
    return selections(raw.leagues.slice(0, 500).map(function (item) { return item && { id: item.slug, name: item.name }; }), 500, leagueId);
  }, CATALOGUE_MS, function (data) {
    cb(data && data.length ? { ok: true, leagues: data } : { ok: false, error: msg('srv.football.leagues', 'Leagues are unavailable. Try again later.') });
  });
}
function teams(id, cb) {
  if (!leagueId(id)) return cb({ ok: false, error: msg('srv.football.league', 'Choose a football league first.') });
  request('teams:' + id, 'sports/soccer/' + id + '/teams?limit=1000', function (raw) {
    var league = raw && raw.sports && raw.sports[0] && raw.sports[0].leagues && raw.sports[0].leagues[0];
    if (!league || !Array.isArray(league.teams)) return null;
    return selections(league.teams.slice(0, 500).map(function (item) { return item && item.team && { id: item.team.id, name: item.team.displayName }; }), 500, teamId);
  }, CATALOGUE_MS, function (data) {
    cb(data ? { ok: true, teams: data } : { ok: false, error: msg('srv.football.teams', 'Teams are unavailable. Try again later.') });
  });
}
function competitor(raw) {
  var team = raw && raw.team;
  if (!team || !teamId(team.id) || !text(team.displayName, 80)) return null;
  var value = raw.score && typeof raw.score === 'object' ? raw.score.value : raw.score;
  var score = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return { id: team.id, name: text(team.shortDisplayName || team.displayName, 80), score: /^\d{1,3}$/.test(score) ? +score : null };
}
function match(event, completed) {
  var game = event && event.competitions && event.competitions[0], status = game && game.status || event && event.status;
  var type = status && status.type;
  if (!game || !type || /SUSPEND|POSTPONE|DELAY|CANCEL|ABANDON|INTERRUPT/.test(type.name || '')) return null;
  if (completed ? type.state !== 'post' || type.completed !== true : type.state !== 'in' || type.completed) return null;
  var sides = Array.isArray(game.competitors) ? game.competitors : [];
  var home = competitor(sides.filter(function (side) { return side && side.homeAway === 'home'; })[0]);
  var away = competitor(sides.filter(function (side) { return side && side.homeAway === 'away'; })[0]);
  if (!home || !away || !teamId(event.id)) return null;
  var result = { id: event.id, home: home, away: away, status: text(type.shortDetail || status.displayClock || type.detail, 30), date: '' };
  if (completed) {
    var date = typeof event.date === 'string' ? Date.parse(event.date) : NaN;
    if (!isFinite(date) || date > now() || home.score === null || away.score === null) return null;
    result.date = new Date(date).toISOString();
  }
  return result;
}
function dates() {
  function day(offset) { return new Date(now() + offset * 3600000).toISOString().slice(0, 10).replace(/-/g, ''); }
  // ESPN's football feed accepts single dates, not ranges. Keep games that
  // started before UTC midnight until even extra time and penalties can end.
  var days = [day(0)], previous = day(-6);
  if (previous !== days[0]) days.push(previous);
  return days;
}
function leagueScores(settings, cb) {
  var days = dates(), total = settings.leagues.length * days.length;
  var remaining = total, matches = [], failed = 0, updated = now(), cancels = [], finished = false;
  var timer = scheduleTimer(finish, READ_MS); readTimers.push(timer);
  function finish() {
    if (finished) return;
    finished = true; cancelTimer(timer);
    var index = readTimers.indexOf(timer); if (index !== -1) readTimers.splice(index, 1);
    cancels.forEach(function (cancel) { if (cancel) cancel(); });
    matches.sort(function (a, b) { return a.id < b.id ? -1 : a.id === b.id ? 0 : 1; });
    cb({ ok: true, available: matches.length > 0 || remaining === 0 && failed < total,
      loading: remaining > 0, partial: failed > 0 || remaining > 0, updated: updated, matches: matches });
  }
  settings.leagues.forEach(function (league) {
    days.forEach(function (day) {
      cancels.push(request('scores:' + league.id + ':' + day, 'sports/soccer/' + league.id + '/scoreboard?limit=1000&dates=' + day, function (raw) {
        if (!raw || !Array.isArray(raw.events)) return null;
        return raw.events.slice(0, 1000).map(function (event) { return match(event, false); }).filter(function (item) { return item !== null; });
      }, FRESH_MS, function (data, time) {
        if (finished) return;
        if (!data) failed++;
        else {
          updated = Math.min(updated, time);
          data.forEach(function (item) {
            if (matches.some(function (existing) { return existing.id === item.id; })) return;
            if (settings.teams.length && !settings.teams.some(function (team) { return team.id === item.home.id || team.id === item.away.id; })) return;
            var copy = JSON.parse(JSON.stringify(item)); copy.league = league.name; matches.push(copy);
          });
        }
        if (!--remaining) finish();
      }));
    });
  });
}
function teamSchedule(team, fixtures, cb) {
  var path = 'sports/soccer/all/teams/' + team.id + '/schedule' + (fixtures ? '?fixture=true' : '');
  return request((fixtures ? 'fixtures:' : 'results:') + team.id, path, function (raw) {
    if (!raw || !Array.isArray(raw.events)) return null;
    var matches = raw.events.slice(0, 500).map(function (event) {
      var result = match(event, !fixtures);
      if (!result || result.home.id !== team.id && result.away.id !== team.id) return null;
      result.league = text(event.league && event.league.name, 80);
      return result;
    }).filter(function (item) { return item !== null; });
    if (fixtures) return matches;
    matches.sort(function (a, b) { return a.date < b.date ? 1 : a.date === b.date ? 0 : -1; });
    return matches.slice(0, 1);
  }, FRESH_MS, cb);
}
function collectTeams(teams, fixtures, deadline, cb) {
  var pending = teams.length, failed = 0, matches = [], missing = [], cancels = [], finished = false, updated = now();
  var timer = scheduleTimer(finish, Math.max(1, deadline - now())); readTimers.push(timer);
  function finish() {
    if (finished) return;
    finished = true; cancelTimer(timer);
    var index = readTimers.indexOf(timer); if (index !== -1) readTimers.splice(index, 1);
    cancels.forEach(function (cancel) { if (cancel) cancel(); });
    matches.sort(function (a, b) {
      if (!fixtures && a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.id < b.id ? -1 : a.id === b.id ? 0 : 1;
    });
    cb({ ok: true, available: matches.length > 0 || pending === 0 && failed < teams.length,
      loading: pending > 0, partial: failed > 0 || pending > 0, updated: updated,
      matches: matches, missingTeams: missing });
  }
  teams.forEach(function (team) {
    cancels.push(teamSchedule(team, fixtures, function (data, time) {
      if (finished) return;
      if (!data) failed++;
      else updated = Math.min(updated, time);
      if (!fixtures && (!data || !data.length)) missing.push({ id: team.id, name: team.name, unavailable: !data });
      (data || []).forEach(function (item) { if (!matches.some(function (have) { return have.id === item.id; })) matches.push(item); });
      if (!--pending) finish();
    }));
  });
}
function scores(settings, cb) {
  settings = normalise(settings);
  if (!settings.enabled || !settings.leagues.length && !settings.teams.length) return cb(unavailable());
  if (!settings.teams.length) return leagueScores(settings, cb);
  var deadline = now() + READ_MS;
  collectTeams(settings.teams, true, deadline, function (live) {
    if (live.matches.length || live.partial) { live.mode = 'live'; return cb(live); }
    collectTeams(settings.teams, false, deadline, function (results) { results.mode = 'latest'; cb(results); });
  });
}
module.exports = { normalise: normalise, leagues: leagues, teams: teams, read: scores, init: function (opts) {
  opts = opts || {}; fetchJson = opts.fetchJson || require('./fetch').getJson; now = opts.now || Date.now;
  readTimers.forEach(function (timer) { cancelTimer(timer); }); readTimers = [];
  scheduleTimer = opts.setTimeout || setTimeout; cancelTimer = opts.clearTimeout || clearTimeout;
  READ_MS = opts.readMs || 15000;
  cache = {}; queue = []; running = 0;
} };
