/*
 * lib/scores.js - the day's matches and results, for Glasshouse Home's board
 *
 * From ESPN's public scoreboard feed (site.api.espn.com), which needs no key:
 * one request per league for a day's matches, with each one's teams, score,
 * kick-off and where it stands. lib/home.js asks once a minute at most, and
 * only while Home is on screen with the board set to show them. The view
 * words what comes back in its own language.
 *
 * Strict ES5: runs on node 0.12.
 */
var SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/';

// The leagues offered, by ESPN's sport and league path, with a short name for
// when two are shown together.
var LEAGUES = [
  { id: 'soccer/eng.1', name: 'Premier League', short: 'PL' },
  { id: 'soccer/uefa.champions', name: 'Champions League', short: 'CL' },
  { id: 'soccer/uefa.europa', name: 'Europa League', short: 'EL' },
  { id: 'soccer/esp.1', name: 'La Liga', short: 'LL' },
  { id: 'soccer/ger.1', name: 'Bundesliga', short: 'BL' },
  { id: 'soccer/ita.1', name: 'Serie A', short: 'SA' },
  { id: 'soccer/fra.1', name: 'Ligue 1', short: 'L1' },
  { id: 'soccer/ned.1', name: 'Eredivisie', short: 'ED' },
  { id: 'soccer/por.1', name: 'Primeira Liga', short: 'PT' },
  { id: 'soccer/swe.1', name: 'Allsvenskan', short: 'AS' },
  { id: 'soccer/nor.1', name: 'Eliteserien', short: 'ES' },
  { id: 'soccer/den.1', name: 'Superliga', short: 'SL' },
  { id: 'soccer/usa.1', name: 'MLS', short: 'MLS' },
  { id: 'hockey/nhl', name: 'NHL', short: 'NHL' },
  { id: 'basketball/nba', name: 'NBA', short: 'NBA' },
  { id: 'football/nfl', name: 'NFL', short: 'NFL' }
];
var MAX_MATCHES = 20;
var NAME_MAX = 24;

/** @type {function(string, function(?Error, any=): void): void} */
var getJson = null;

function init(opts) {
  opts = opts || {};
  if (typeof opts.getJson === 'function') getJson = opts.getJson;
}

function league(id) {
  for (var i = 0; i < LEAGUES.length; i++) if (LEAGUES[i].id === id) return LEAGUES[i];
  return null;
}

function text(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/*
 * One event as the board shows it: { league, start, state, status, clock,
 * home, away, homeScore, awayScore }. state is ESPN's pre, in or post; status
 * its name, such as STATUS_HALFTIME or STATUS_POSTPONED. null where it is
 * not a match between two sides.
 */
/*
 * A side's short name, whole. ESPN cuts shortDisplayName at 12 characters
 * (swe.1: "Brommapojkar" for "IF Brommapojkarna"), so a short name that is
 * the start of a longer word of displayName is that word.
 */
function shortName(short, display) {
  if (typeof short !== 'string' || !short) return '';
  var words = typeof display === 'string' ? display.split(/\s+/) : [];
  var last = short.split(/\s+/).pop();
  for (var i = 0; i < words.length; i++) {
    if (words[i].length > last.length && words[i].indexOf(last) === 0) {
      return short.slice(0, short.length - last.length) + words[i];
    }
  }
  return short;
}

function matchOf(leagueId, e) {
  var c = e && e.competitions && e.competitions[0];
  if (!c || !c.competitors || c.competitors.length !== 2) return null;
  /** @type {any} */
  var home = null;
  /** @type {any} */
  var away = null;
  c.competitors.forEach(function (t) {
    if (t && t.homeAway === 'home') home = t;
    else if (t && t.homeAway === 'away') away = t;
  });
  if (!home || !away) return null;
  var type = (c.status && c.status.type) || {};
  var start = Date.parse(e.date || c.date || '');
  function side(t) {
    var team = t.team || {};
    return text(shortName(team.shortDisplayName, team.displayName) || team.displayName || team.abbreviation, NAME_MAX);
  }
  return {
    league: leagueId,
    start: isFinite(start) ? start : 0,
    state: type.state === 'in' || type.state === 'post' ? type.state : 'pre',
    status: text(type.name, 40),
    clock: text(c.status && c.status.displayClock, 12),
    home: side(home),
    away: side(away),
    homeScore: text(String(home.score === undefined ? '' : home.score), 4),
    awayScore: text(String(away.score === undefined ? '' : away.score), 4)
  };
}

// YYYYMMDD of a date in the TV's own time, as ESPN takes it.
function dayOf(ms) {
  var d = new Date(ms);
  function two(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate());
}

/*
 * today(ids, nowMs, cb) - cb(null, matches) for the chosen leagues' matches
 * on the TV's date, by kick-off, or cb(err) when none of them could be read.
 * A league that fails is left out while another answers.
 */
function today(ids, nowMs, cb) {
  var wanted = (ids || []).filter(function (id) { return !!league(id); });
  if (!getJson) return setTimeout(function () { cb(new Error('scores are not available')); }, 0);
  if (!wanted.length) return setTimeout(function () { cb(null, []); }, 0);
  var day = dayOf(nowMs);
  var left = wanted.length, matches = [], answered = 0, lastErr = null;
  wanted.forEach(function (id) {
    getJson(SCOREBOARD_URL + id + '/scoreboard?dates=' + day, function (err, doc) {
      if (err || !doc) lastErr = err || new Error('no answer');
      else {
        answered++;
        (doc.events || []).forEach(function (e) {
          var m = matchOf(id, e);
          if (m) matches.push(m);
        });
      }
      if (--left) return;
      if (!answered) return cb(lastErr);
      matches.sort(function (a, b) { return a.start - b.start; });
      cb(null, matches.slice(0, MAX_MATCHES));
    });
  });
}

module.exports = {
  LEAGUES: LEAGUES,
  shortName: shortName,
  init: init,
  league: league,
  matchOf: matchOf,
  dayOf: dayOf,
  today: today
};
