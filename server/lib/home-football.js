var fetchJson = function (url, cb, opts) { require('./fetch').getJson(url, cb, opts); };
var now = Date.now;
var text = require('./home-widget-format').text;
var msg = require('./say').msg;
var BASE = 'https://site.api.espn.com/apis/site/v2/';
var cache = {}, queue = [], running = 0;
var FRESH_MS = 60000, RETRY_MS = 30000, CATALOGUE_MS = 6 * 60 * 60000;

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
  while (Object.keys(cache).length >= 32 && keys.length) delete cache[keys.shift()];
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
    if (entry.pending) { entry.pending.push(cb); return; }
    if (now() < entry.next) return cb(entry.data, entry.updated);
  } else {
    prune();
    if (Object.keys(cache).length >= 32) return cb(null);
    entry = { data: null, updated: 0, next: 0, used: now(), pending: null }; cache[key] = entry;
  }
  entry.pending = [cb];
  queue.push({ entry: entry, path: path, parse: parse, ttl: ttl }); pump();
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
  var score = typeof raw.score === 'number' || typeof raw.score === 'string' ? String(raw.score) : '';
  return { id: team.id, name: text(team.shortDisplayName || team.displayName, 80), score: /^\d{1,3}$/.test(score) ? +score : null };
}
function match(event) {
  var game = event && event.competitions && event.competitions[0], status = game && game.status || event && event.status;
  var type = status && status.type;
  if (!game || !type || type.state !== 'in' || type.completed || /SUSPEND|POSTPONE|DELAY|CANCEL|ABANDON|INTERRUPT/.test(type.name || '')) return null;
  var sides = Array.isArray(game.competitors) ? game.competitors : [], home = null, away = null;
  sides.forEach(function (side) {
    if (side && side.homeAway === 'home') home = competitor(side);
    if (side && side.homeAway === 'away') away = competitor(side);
  });
  if (!home || !away || !teamId(event.id)) return null;
  return { id: event.id, home: home, away: away, status: text(type.shortDetail || status.displayClock || type.detail, 30) };
}
function dates() {
  function day(offset) { return new Date(now() + offset * 3600000).toISOString().slice(0, 10).replace(/-/g, ''); }
  // ESPN's football feed accepts single dates, not ranges. Keep games that
  // started before UTC midnight until even extra time and penalties can end.
  var days = [day(0)], previous = day(-6);
  if (previous !== days[0]) days.push(previous);
  return days;
}
function scores(settings, cb) {
  settings = normalise(settings);
  if (!settings.enabled || !settings.leagues.length) return cb(unavailable());
  var days = dates(), total = settings.leagues.length * days.length;
  var remaining = total, matches = [], failed = 0, updated = now();
  settings.leagues.forEach(function (league) {
    days.forEach(function (day) {
      request('scores:' + league.id + ':' + day, 'sports/soccer/' + league.id + '/scoreboard?limit=1000&dates=' + day, function (raw) {
        if (!raw || !Array.isArray(raw.events)) return null;
        return raw.events.slice(0, 1000).map(match).filter(function (item) { return item !== null; });
      }, FRESH_MS, function (data, time) {
        if (!data) failed++;
        else {
          updated = Math.min(updated, time);
          data.forEach(function (item) {
            if (matches.some(function (existing) { return existing.id === item.id; })) return;
            if (settings.teams.length && !settings.teams.some(function (team) { return team.id === item.home.id || team.id === item.away.id; })) return;
            var copy = JSON.parse(JSON.stringify(item)); copy.league = league.name; matches.push(copy);
          });
        }
        if (--remaining) return;
        matches.sort(function (a, b) { return a.id < b.id ? -1 : a.id === b.id ? 0 : 1; });
        cb({ ok: true, available: failed < total, partial: failed > 0, updated: updated, matches: matches });
      });
    });
  });
}
module.exports = { normalise: normalise, leagues: leagues, teams: teams, read: scores, init: function (opts) {
  opts = opts || {}; fetchJson = opts.fetchJson || require('./fetch').getJson; now = opts.now || Date.now;
  cache = {}; queue = []; running = 0;
} };
