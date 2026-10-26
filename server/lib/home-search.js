/*
 * lib/home-search.js - films and series across the TV's apps, for Glasshouse
 * Home's search (lib/home)
 *
 * LG's own Search (com.webos.app.voice) asks com.webos.service.nlpmanager,
 * which answers from LG's catalogue: one result for each title on each
 * streaming service, with the service's id (the app's id) and an item id. A
 * title's item detail, from com.webos.service.sdx, names the id the app
 * itself knows it by, and applicationManager puts that into the app's own
 * deeplinkingParams template (its appinfo.json) when launched with
 * replaceParams, as LG's Search does. On a G3 (webOS 9.2.2) Prime Video,
 * Netflix and HBO Max opened at the title this way.
 *
 * Only apps this TV has are offered: the rest are counted, not shown. Only
 * a title from the last search can be opened, so this is not a way to launch
 * anything at all.
 *
 * Both services reach LG's catalogue on the host sdx names for them
 * (GB.nextlgsdp.com on a G3 in the UK). Where the ad blocker's table holds it,
 * search is unavailable: the view hides it and both routes refuse, rather
 * than asking LG and failing. The saved Search setting is kept, so search
 * comes back when the blocker changes.
 *
 * Strict ES5: runs on node 0.12.
 */
var msg = require('./say').msg;

var SEARCH = 'com.webos.service.nlpmanager/search';
var DETAIL = 'com.webos.service.sdx/send';
// LG's Search asks for 24 a category; it took under a second on a G3.
var MAX_RESULTS = 24;
var SEARCH_TIMEOUT_MS = 10000;
var MAX_QUERY = 80;
// The sdx services search and item detail use, whose host is looked up.
var HOST_SERVICES = ['sdp_nlp', 'sdp_onnow'];
var HOST_RETRY_MS = 60000;

var lunaFn = null;
var SubscriptionType = null;
var appsFn = null;
var openedFn = null;
var enabledFn = null;
var blockedByFn = null;
// LG's hosts for search, lower case, once sdx has named them.
var hosts = {};
var hostsAsked = 0;
var current = null;
var generation = 0;
// The last search's titles by id: { apps: { appId: itemId } }.
var listed = {};

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  SubscriptionType = opts.Subscription || null;
  appsFn = opts.apps || function (cb) { cb([]); };
  openedFn = opts.opened || function () {};
  enabledFn = opts.enabled || function () { return true; };
  blockedByFn = opts.blockedBy || function () { return null; };
  listed = {};
  hosts = {};
  hostsAsked = 0;
  readHosts();
}

/*
 * sdx's request headers for a service name its host (HOST, beside
 * credentials that are not kept). Asked again a minute
 * after a failed or empty answer; once known it is kept, as it follows the
 * TV's LG service country.
 */
function readHosts() {
  if (!lunaFn || Date.now() - hostsAsked < HOST_RETRY_MS) return;
  hostsAsked = Date.now();
  HOST_SERVICES.forEach(function (name) {
    if (hosts[name]) return;
    luna('com.webos.service.sdx/getHttpHeaderForServiceRequest', { serviceName: name }, function (r) {
      var host = r && typeof r.HOST === 'string' ? r.HOST.toLowerCase() : '';
      if (/^[a-z0-9.-]+$/.test(host)) hosts[name] = host;
    });
  });
}

/*
 * { host, by: 'level' | 'list' } where the ad blocker blocks a host search
 * needs, or null. Null too while the hosts are not yet known: search then
 * asks LG, and says so if LG does not answer.
 */
function blocked() {
  readHosts();
  var hit = null;
  Object.keys(hosts).forEach(function (name) {
    var host = hosts[name];
    var by = hit ? null : blockedByFn(host);
    if (by) hit = { host: host, by: by };
  });
  return hit;
}

function refusal() {
  if (!enabledFn()) return { ok: false, error: msg('srv.home.searchOff', 'search is switched off in Glasshouse Home\'s settings') };
  var b = blocked();
  if (b) return { ok: false, blocked: b, error: msg('srv.home.searchBlocked', 'the ad blocker blocks {host}, which LG\'s search needs', { host: b.host }) };
  return null;
}

function luna(uri, payload, cb) {
  if (!lunaFn) return cb(null);
  lunaFn(uri, payload, function (r) { cb(r || null); });
}

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ' ').replace(/^ | $/g, '');
}

function yearOf(date) {
  var m = /^(\d{4})/.exec(String(date || ''));
  return m ? Number(m[1]) : null;
}

/*
 * The documents LG's answer lists, from searchResult. Each category is its own
 * result list, films then series, so LG's order is kept within each.
 */
function documents(reply) {
  var out = [];
  var data = reply && reply.result && reply.result.ResponseData;
  (data || []).forEach(function (d) {
    var results = d && d.ActionData && d.ActionData.response && d.ActionData.response.results;
    (results || []).forEach(function (res) {
      (res && res.doc || []).forEach(function (doc) { out.push(doc); });
    });
  });
  return out;
}

/*
 * Trailers are never offered or opened. LG marks none: its catalogue lists
 * Prime Video's "Sneak Peek" films (5 to 10 minutes), "Dune: Part Two Extended
 * Preview" (10) and "First Look Teaser" (1) as films, and numbers "Teaser
 * Trailer: Season 1" as an episode. Titles with the words are real too
 * (Trailer Park Boys, Trailer War at 113 minutes), so a promo's word must
 * come with a short running time, or, where there is none, end the name or
 * stand before its colon or dash.
 */
var PROMO = /\b(trailers?|teasers?|sneak peeks?|previews?|first look)\b/i;
var PROMO_PLACED = /\b(trailers?|teasers?|sneak peeks?|previews?|first look)\s*\d*\s*(\)\s*)?($|[:\-\u2013\u2014])/i;
var PROMO_MAX_MINUTES = 15;

function isTrailer(name, minutes) {
  name = String(name || '');
  if (!PROMO.test(name)) return false;
  if (typeof minutes === 'number' && minutes > 0) return minutes <= PROMO_MAX_MINUTES;
  return PROMO_PLACED.test(name);
}

// A document as a title on one service, or null for what is not one.
function entry(doc) {
  if (!doc || (doc.type !== 'movie' && doc.type !== 'tvshow') || typeof doc.title !== 'string') return null;
  var click = doc.action_on_click && doc.action_on_click.launch_parameter;
  var cp = doc.cp_thumbnail && doc.cp_thumbnail[0] && doc.cp_thumbnail[0].cp_id;
  if (!click || typeof click.itemId !== 'string' || typeof cp !== 'string') return null;
  var info = doc.display_info || {};
  if (isTrailer(doc.title, info.running_time)) return null;
  // LG's poster address ends in a size hint for its own app (#ADDSIZE#...).
  var poster = String(doc.thumbnail || '').split('#')[0];
  return {
    title: doc.title,
    kind: doc.type === 'movie' ? 'film' : 'series',
    year: yearOf(info.release_date),
    minutes: typeof info.running_time === 'number' ? info.running_time : null,
    genre: typeof doc.genre === 'string' ? doc.genre : '',
    rating: typeof info.age_ratings === 'string' ? info.age_ratings : '',
    poster: /^https?:\/\//.test(poster) ? poster : '',
    app: cp,
    itemId: click.itemId
  };
}

/*
 * One title on several services is several documents, and each service gives
 * its own release date (Dune: 3 September to 6 December 2021 on a G3 in the
 * UK), so the same title and kind within a year is taken as the same title.
 */
function group(entries) {
  var titles = [];
  entries.forEach(function (e) {
    var key = words(e.title), hit = null;
    titles.forEach(function (t) {
      if (!hit && t.key === key && t.kind === e.kind && (t.year === null || e.year === null || Math.abs(t.year - e.year) <= 1)) hit = t;
    });
    if (!hit) {
      hit = { key: key, title: e.title, kind: e.kind, year: e.year, minutes: e.minutes, genre: e.genre, rating: e.rating,
        poster: e.poster, posterApp: e.app, items: {}, order: titles.length };
      titles.push(hit);
    }
    if (hit.year === null || (e.year !== null && e.year < hit.year)) hit.year = e.year;
    if (!hit.minutes) hit.minutes = e.minutes;
    if (!hit.genre) hit.genre = e.genre;
    if (!hit.rating) hit.rating = e.rating;
    if (!hit.items[e.app]) hit.items[e.app] = e.itemId;
    if (!hit.poster && e.poster) { hit.poster = e.poster; hit.posterApp = e.app; }
  });
  return titles;
}

// Titles named as asked come first, then those starting with it, then LG's order.
function rank(titles, query) {
  var q = words(query);
  function score(t) { return t.key === q ? 0 : t.key.indexOf(q) === 0 ? 1 : t.key.indexOf(q) !== -1 ? 2 : 3; }
  return titles.slice().sort(function (a, b) { return score(a) - score(b) || a.order - b.order; });
}

function failure(reply) {
  var text = reply && (reply.errorText || reply.errorCode);
  return { ok: false, error: msg('srv.home.searchFailed', 'LG\'s search did not answer'), detail: text ? String(text) : undefined };
}

function stopCurrent() {
  if (!current) return;
  var c = current;
  current = null;
  clearTimeout(c.timer);
  c.sub.stop();
}

function find(query, cb) {
  query = String(query || '').replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, MAX_QUERY);
  var no = refusal();
  if (no) return cb(no);
  if (query.length < 2) return cb({ ok: false, error: msg('srv.home.searchShort', 'type two letters or more') });
  if (!SubscriptionType) return cb({ ok: false, error: msg('srv.home.searchUnavailable', 'this TV has no LG search to ask') });
  // A newer search answers the view; the older one is dropped unanswered.
  if (current) {
    var was = current.cb;
    stopCurrent();
    was({ ok: false, superseded: true });
  }
  // answered: the titles came, and are being matched to the TV's apps.
  var mine = { cb: cb, timer: null, sub: null, answered: false };
  function finish(r) {
    if (current !== mine) return;
    stopCurrent();
    if (r.ok && !r.results.length) listed = {};
    cb(r);
  }
  mine.sub = new SubscriptionType(SEARCH, {
    subscribe: true, query: query, start_index: 1, max_results: MAX_RESULTS,
    category_name: 'movie,tvshow', suggestion_keywords: false
  }, null, {
    message: function (r) {
      if (r.returnValue === false || r.event === 'error' || r.event === 'exceptionResult') return finish(failure(r));
      if (r.event === 'searchResult') {
        if (mine.answered) return;
        mine.answered = true;
        return answer(query, r, mine, finish);
      }
      // LG ends the session straight after the titles, before the app list
      // has been read where it is not cached.
      if (r.event === 'sessionEnd' && !mine.answered) finish({ ok: true, query: query, results: [], elsewhere: 0 });
    },
    // luna-send ends without an answer where the service is missing (webOS before 9 is untried).
    close: function () { if (!mine.answered) finish(failure(null)); }
  });
  mine.timer = setTimeout(function () { finish(failure(null)); }, SEARCH_TIMEOUT_MS);
  current = mine;
  mine.sub.start();
}

function answer(query, reply, mine, cb) {
  appsFn(function (apps) {
    // A superseded or timed-out search must not replace newer launch targets.
    if (current !== mine) return;
    var byId = {};
    (apps || []).forEach(function (a) { byId[a.id] = a; });
    var gen = ++generation, out = [], elsewhere = 0;
    listed = {};
    rank(group(documents(reply).map(entry).filter(Boolean)), query).forEach(function (t) {
      var on = [], items = {};
      for (var app in t.items) {
        if (!byId[app]) continue;
        items[app] = t.items[app];
        on.push({ id: app, title: byId[app].title, icon: byId[app].icon ? '/api/home/icon?id=' + encodeURIComponent(app) : null });
      }
      if (!on.length) { elsewhere++; return; }
      var id = gen + '.' + out.length;
      listed[id] = { kind: t.kind, apps: items };
      out.push({ id: id, title: t.title, kind: t.kind, year: t.year, minutes: t.minutes, genre: t.genre, rating: t.rating,
        poster: t.poster, apps: on });
    });
    cb({ ok: true, query: query, results: out, elsewhere: elsewhere });
  });
}

function detail(itemId, type, cb) {
  // A series can need several reads; settings may change between replies.
  if (refusal()) return cb(null);
  var body = 'item_id=' + encodeURIComponent(itemId) + '&item_type=CONTS&item_detail_type=' + type + '&app_id=WTV_NLP';
  luna(DETAIL, { serviceName: 'sdp_onnow', url: 'content_discovery/item-detail', methodType: 'REQ_SSL_POST_METHOD', bodyData: body }, function (r) {
    /** @type {any} */
    var answer = null;
    try { answer = JSON.parse(r.serverResponse.response); } catch (e) {}
    cb(answer && answer.item && answer.item.item_detail || null);
  });
}

function items(d, key) {
  var list = d && d[key] && d[key].items;
  return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
}

/*
 * The id an app knows an LG item by: what follows its first "|", less LG's
 * tag for the service ("AMAZON_", "DISNEY_", "BBC_"). Item detail gave the
 * same for every title tried on a G3, films, seasons and episodes.
 */
function ownId(itemId) {
  var rest = itemId.indexOf('|') !== -1 ? itemId.slice(itemId.indexOf('|') + 1) : itemId;
  return rest.replace(/^[A-Z][A-Z0-9]*_/, '');
}

// The id the app knows the title by, from LG's item detail, and its name there.
function execId(app, itemId, cb) {
  detail(itemId, 'exec_full', function (d) {
    /** @type {any} */
    var hit = null;
    ((d && d.exec_list && d.exec_list.execs) || []).forEach(function (x) {
      if (!hit && x && x.exec_app_id === app && typeof x.exec_id === 'string') hit = x;
    });
    cb(hit ? hit.exec_id : ownId(itemId), hit ? hit.cp_conts_name : '');
  });
}

/*
 * A series. For one, LG's item detail names its latest episode (Severance on
 * Prime Video: series 2's 16th, a bonus interview). Its advanced detail lists
 * the seasons, and a season's lists its episodes, so a series opens at its
 * start instead: Prime Video and HBO Max at the first season's page; apps
 * whose season links do not open (Disney+ showed a blank screen, BBC iPlayer
 * has only playback links) at the first episode. Apple TV and Netflix list
 * no seasons, and keep LG's own link: Apple TV's latest episode's page,
 * Netflix's series page. Checked on a G3 (webOS 9.2.2), October 2026.
 */
var SEASON_PAGE_APPS = ['amazon', 'com.wbd.stream'];

function lowest(list, numberOf) {
  /** @type {any} */
  var best = null;
  // LG lists a season's episodes before its extras, which Prime Video numbers
  // too (its Season 1 trailer is an episode 1): the first lowest is the
  // episode, and a trailer is never taken whatever its number.
  list.forEach(function (x) {
    var n = parseInt(numberOf(x), 10);
    if (isTrailer(x.conts_epsd_real_name || x.item_name_disp, null)) return;
    if (n > 0 && (!best || n < best.n)) best = { n: n, item: x };
  });
  return best;
}

function seriesStart(app, itemId, cb) {
  detail(itemId, 'advanced', function (d) {
    var first = lowest(items(d, 'season_list'), function (s) { return s.conts_season_num; });
    if (!first || typeof first.item.item_id !== 'string') return cb(null);
    var season = first.item.item_id;
    if (SEASON_PAGE_APPS.indexOf(app) !== -1) return cb({ value: ownId(season), at: 'season ' + first.n });
    function episodes(s) {
      var ep = lowest(items(s, 'tab_episode'), function (e) { return e.item_name; });
      cb(ep && typeof ep.item.item_id === 'string' ? { value: ownId(ep.item.item_id), at: 'season ' + first.n + ' episode ' + ep.n } : null);
    }
    if (season === itemId) return episodes(d);
    detail(season, 'advanced', episodes);
  });
}

function target(kind, app, itemId, cb) {
  if (kind !== 'series') return execId(app, itemId, function (value) { cb({ value: value, at: 'title' }); });
  seriesStart(app, itemId, function (start) {
    if (start) return cb(start);
    // LG's own episode, unless it is a trailer: then the app opens as it is.
    execId(app, itemId, function (value, name) {
      cb(isTrailer(name, null) ? { value: null, at: 'the app, LG naming a trailer' } : { value: value, at: 'LG\'s episode' });
    });
  });
}

function open(body, cb) {
  var id = body && typeof body.id === 'string' ? body.id : '';
  var app = body && typeof body.app === 'string' ? body.app : '';
  var no = refusal();
  if (no) return cb(no);
  var title = listed.hasOwnProperty(id) ? listed[id] : null;
  if (!title || !title.apps.hasOwnProperty(app)) return cb({ ok: false, error: msg('srv.home.searchGone', 'that is no longer in the results') });
  target(title.kind, app, title.apps[app], function (to) {
    var no = refusal();
    if (no) return cb(no);
    console.log('home: search opens ' + app + ' at ' + to.at + (to.value ? ': ' + to.value : ''));
    var launch = { id: app };
    if (to.value) launch.replaceParams = { deeplinkingParams: { target: '$CONTENTID', value: to.value } };
    luna('com.webos.applicationManager/launch', launch, function (r) {
      if (!r || !r.returnValue) return cb({ ok: false, error: msg('srv.home.launchRefused', 'the TV would not open it') });
      openedFn(app);
      cb({ ok: true });
    });
  });
}

module.exports = {
  init: init,
  find: find,
  open: open,
  blocked: blocked
};
