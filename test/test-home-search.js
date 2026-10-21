/* Glasshouse Home's search: LG's answer as titles on the TV's own apps, and
 * only a listed title opens, in its app, at the id the app knows it by.
 * The answer is a real one from a G3 (webOS 9.2.2) in the UK, trimmed.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var search = require('../server/lib/home-search');
var answer = require('./fixtures/search-g3-dune.json');
// Severance on Prime Video and The Bear on Disney+, with LG's detail for each
// series and its first season, from the same G3.
var series = require('./fixtures/search-g3-series-detail.json');
// What a G3 answered for "sneak peek", "dune trailer", "teaser" and "trailer":
// promos LG lists as films and series, and real titles with the same words.
var promos = require('./fixtures/search-g3-trailers.json');

var INSTALLED = ['amazon', 'com.apple.appletv', 'com.wbd.stream', 'netflix', 'com.disney.disneyplus-prod', 'com.tubitv.ott.tubi'];
var calls;

function FakeSubscription(uri, payload, appId, handlers) {
  this.start = function () {
    calls.push({ uri: uri, payload: payload });
    var reply = calls.reply;
    // As a G3 sends them: the titles and the session's end together.
    process.nextTick(function () {
      handlers.message({ returnValue: true, subscribed: true });
      handlers.message(reply);
      handlers.message({ subscribed: true, event: 'sessionEnd' });
    });
  };
  this.stop = function () { calls.stopped++; };
}

function luna(uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  var r = { returnValue: true };
  if (uri === 'com.webos.service.sdx/send') {
    var body = payload.bodyData;
    var item = decodeURIComponent(/item_id=([^&]*)/.exec(body)[1]), type = /item_detail_type=([^&]*)/.exec(body)[1];
    var known = series.detail[type + ' ' + item];
    var execs = [{ exec_app_id: 'netflix', exec_id: 'netflix-own-id' }];
    r.serverResponse = { response: JSON.stringify({ item: { item_detail: known || { exec_list: { execs: execs } } } }) };
  }
  process.nextTick(function () { cb(r); });
}

function setUp(reply, off) {
  calls = [];
  calls.stopped = 0;
  calls.reply = reply;
  search.init({
    enabled: function () { return !off; },
    luna: luna,
    Subscription: FakeSubscription,
    // Read from the TV, so it answers later than the search's end.
    apps: function (cb) {
      setTimeout(function () { cb(INSTALLED.map(function (id) { return { id: id, title: id, icon: 'x.png' }; })); }, 5);
    },
    opened: function (id) { calls.opened = id; }
  });
}

function find(query, cb) {
  search.find(query, function (r) { cb(r); });
}

var tests = [
  function groupsTitlesAcrossTheTvsApps(done) {
    setUp(answer);
    find('Dune', function (r) {
      assert.ok(r.ok);
      assert.deepEqual(calls[0].payload.category_name, 'movie,tvshow');
      var dune = r.results[0];
      // One film on three services, dated 3 September to 21 October 2021 by them.
      assert.equal(dune.title, 'Dune');
      assert.equal(dune.kind, 'film');
      assert.equal(dune.year, 2021);
      assert.deepEqual(dune.apps.map(function (a) { return a.id; }), ['amazon', 'com.apple.appletv', 'com.wbd.stream']);
      assert.ok(/^http:\/\/[^#]+$/.test(dune.poster), 'poster without LG\'s size hint');
      var titles = r.results.map(function (x) { return x.title + ' ' + x.year; });
      assert.deepEqual(titles.slice(0, 2), ['Dune 2021', 'Dune 1984']);
      assert.ok(titles.indexOf('Dune: Part Two 2024') !== -1);
      // Frank Herbert's Dune is on Prime Video; nothing is listed only for an app the TV lacks.
      r.results.forEach(function (x) { x.apps.forEach(function (a) { assert.ok(INSTALLED.indexOf(a.id) !== -1); }); });
      assert.equal(calls.stopped, 1);
      done();
    });
  },

  function opensAListedTitleAtTheAppsOwnId(done) {
    setUp(answer);
    find('Dune', function (r) {
      var partTwo = r.results.filter(function (x) { return x.title === 'Dune: Part Two'; })[0];
      search.open({ id: partTwo.id, app: 'netflix' }, function (o) {
        assert.ok(o.ok);
        var launch = calls[calls.length - 1];
        assert.equal(launch.uri, 'com.webos.applicationManager/launch');
        assert.deepEqual(launch.payload, { id: 'netflix',
          replaceParams: { deeplinkingParams: { target: '$CONTENTID', value: 'netflix-own-id' } } });
        assert.equal(calls.opened, 'netflix');
        done();
      });
    });
  },

  function refusesWhatTheSearchDidNotList(done) {
    setUp(answer);
    find('Dune', function (r) {
      var before = calls.length;
      // Listed, but not on that app; then an app the search never named.
      search.open({ id: r.results[1].id, app: 'netflix' }, function (a) {
        search.open({ id: r.results[0].id, app: 'com.example.anything' }, function (b) {
          assert.ok(!a.ok && !b.ok);
          assert.equal(calls.length, before, 'nothing was launched');
          done();
        });
      });
    });
  },

  function opensASeriesAtItsStart(done) {
    setUp(series.search);
    find('Severance', function (r) {
      var byApp = {};
      r.results.forEach(function (x) { byApp[x.apps[0].id] = x; });
      assert.equal(byApp.amazon.kind, 'series');
      // LG's own link for both is the latest episode: Prime Video's series 2
      // episode 16 (a bonus interview), Disney+'s series 5 episode 8.
      search.open({ id: byApp.amazon.id, app: 'amazon' }, function () {
        // Prime Video opens its first season's page.
        assert.equal(calls[calls.length - 1].payload.replaceParams.deeplinkingParams.value,
          'amzn1.dv.gti.078e982d-fd12-426a-8764-dfabcca6245c');
        search.open({ id: byApp['com.disney.disneyplus-prod'].id, app: 'com.disney.disneyplus-prod' }, function () {
          // Disney+'s season pages do not open, so its first episode plays.
          assert.equal(calls[calls.length - 1].payload.replaceParams.deeplinkingParams.value,
            'page=play&id=60da223c-d2a0-411a-95c9-665a839371f9&distributionPartner=lg');
          done();
        });
      });
    });
  },

  function neverListsATrailer(done) {
    setUp(promos);
    find('trailer', function (r) {
      assert.deepEqual(r.results.map(function (x) { return x.title; }).sort(), [
        'Kung Fu Trailers of Fury', 'Mathematical Brain Teasers and Logic Puzzles', 'Thriller Teaser Series',
        'Trailer Park Boys', 'Trailer War']);
      done();
    });
  },

  function neverOpensASeriesAtATrailer(done) {
    // The Bear's first season on Disney+, with Prime Video's real "Teaser
    // Trailer: Season 1" item, numbered episode 1, put first.
    var bear = series.detail['advanced MasterSet_GB|DISNEY_page=browse&id=entity-f1b38ee5-310d-4be7-b8b3-6998d29d8e85&seasonSequenceNumber=1&distributionPartner=lg'];
    var prime = series.detail['advanced MasterSet_GB|AMAZON_amzn1.dv.gti.078e982d-fd12-426a-8764-dfabcca6245c'];
    var trailer = prime.tab_episode.items.filter(function (e) { return /Trailer/.test(e.conts_epsd_real_name); })[0];
    var saved = bear.tab_episode.items;
    bear.tab_episode.items = [trailer].concat(saved);
    setUp(series.search);
    find('The Bear', function (r) {
      var title = r.results.filter(function (x) { return x.apps[0].id === 'com.disney.disneyplus-prod'; })[0];
      search.open({ id: title.id, app: 'com.disney.disneyplus-prod' }, function () {
        bear.tab_episode.items = saved;
        assert.equal(calls[calls.length - 1].payload.replaceParams.deeplinkingParams.value,
          'page=play&id=60da223c-d2a0-411a-95c9-665a839371f9&distributionPartner=lg');
        done();
      });
    });
  },

  function opensAtTheItemsOwnIdWithoutDetail(done) {
    setUp(answer);
    find('Dune', function (r) {
      // LG names no Prime Video id here: the item id, less LG's tag, is the app's.
      search.open({ id: r.results[0].id, app: 'amazon' }, function () {
        assert.equal(calls[calls.length - 1].payload.replaceParams.deeplinkingParams.value,
          'amzn1.dv.gti.a8025548-3908-4562-8896-8fffd945cfb6');
        done();
      });
    });
  },

  function switchedOffAsksLgNothing(done) {
    setUp(answer, true);
    find('Dune', function (r) {
      assert.ok(!r.ok);
      assert.equal(calls.length, 0, 'no search and no detail went to LG');
      done();
    });
  },

  function reportsLgsErrorAsAFailure(done) {
    setUp({ subscribed: true, event: 'error', errorCode: '6011', errorText: 'NLP invalid parameter' });
    find('Dune', function (r) {
      assert.ok(!r.ok);
      assert.equal(r.detail, 'NLP invalid parameter');
      done();
    });
  },

  function onlyTheNewestSearchCanReplaceLaunchableResults(done) {
    var subscriptions = [], appReplies = [], newest;
    calls = [];
    search.init({
      luna: luna,
      Subscription: function (uri, payload, appId, handlers) {
        this.start = function () { subscriptions.push(handlers); };
        this.stop = function () {};
      },
      apps: function (cb) { appReplies.push(cb); }
    });
    search.find('du', function (r) { assert.ok(r.superseded); });
    subscriptions[0].message(answer);
    search.find('dune', function (r) { newest = r.results[0]; });
    subscriptions[1].message(answer);
    var apps = [{ id: 'amazon', title: 'Prime Video' }];
    appReplies[1](apps);
    // The first search's app list arrives after the newer results are visible.
    appReplies[0](apps);
    search.open({ id: newest.id, app: 'amazon' }, function (r) {
      assert.ok(r.ok, 'the newest displayed result remains launchable');
      search.find('no matches', function (empty) {
        assert.ok(empty.ok && !empty.results.length);
        var before = calls.length;
        search.open({ id: newest.id, app: 'amazon' }, function (old) {
          assert.ok(!old.ok, 'an empty result replaces the previous launch list');
          assert.equal(calls.length, before);
          done();
        });
      });
      subscriptions[2].message({ event: 'sessionEnd' });
    });
  }
];

(function next(i) {
  if (i === tests.length) return console.log('test-home-search: ' + tests.length + ' passed');
  tests[i](function () { next(i + 1); });
})(0);
