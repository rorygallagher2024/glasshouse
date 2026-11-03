/* Recent-app HTTP outcomes: a close is confirmed before its card is removed,
 * web apps stop too, and private snapshots cannot enter shared caches.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var http = require('http');
var path = require('path');
var recentApps = require('../server/lib/home-recent-apps');
var routes = require('../server/lib/routes');
var tv;

function reset() {
  tv = { cards: ['netflix', 'web.app', 'com.webos.app.home'],
    running: ['netflix', 'web.app', 'com.webos.app.home', 'background.app'] };
}

function luna(uri, payload, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.recent/listRecents') {
    r.recentsAppList = tv.cards.map(function (id) {
      return { appId: id, title: id, cardSnapShotFilePath: path.join(__dirname, 'fixtures/home-wallpaper.jpg') };
    });
  } else if (uri === 'com.webos.applicationManager/running') {
    r = tv.unavailable ? null : { returnValue: true, running: tv.running.map(function (id) {
      return { id: id, appType: id === 'web.app' ? 'web' : 'native' };
    }) };
  } else if (uri === 'com.webos.applicationManager/closeByAppId' || uri === 'com.palm.webappmanager/killApp') {
    var id = payload.id || payload.appId;
    if (tv.refused) r.returnValue = false;
    else if (!tv.ackOnly && (id !== 'web.app' || uri === 'com.palm.webappmanager/killApp')) {
      tv.running = tv.running.filter(function (x) { return x !== id; });
    }
    if (tv.newCard && tv.cards.indexOf('new.app') === -1) {
      tv.cards.push('new.app'); tv.running.push('new.app');
    }
  } else if (uri === 'com.webos.service.recent/removeRecent') {
    tv.cards = tv.cards.filter(function (id) { return id !== payload.appId; });
  } else if (uri === 'com.webos.service.recent/removeAllRecents') {
    tv.cards = [];
  } else throw new Error('unexpected Luna call: ' + uri);
  process.nextTick(function () { cb(r); });
}

var excluded = [];
recentApps.init({ luna: luna, excluded: function () { return excluded; } });
routes.init({ config: { allowControl: true, token: '' }, home: { recentApps: recentApps } });
var server = http.createServer(routes.handleRequest);
function request(body, cb, suffix) {
  var req = http.request({ host: '127.0.0.1', port: server.address().port,
    path: '/api/home/recents' + (suffix || ''), method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {} }, function (res) {
    var raw = '';
    res.on('data', function (d) { raw += d; });
    res.on('end', function () { cb(res, suffix ? raw : JSON.parse(raw)); });
  });
  req.on('error', function (e) { throw e; });
  req.end(body ? JSON.stringify(body) : undefined);
}

var steps = [
  function (next) {
    reset();
    request(null, function () {
      excluded = ['netflix'];
      request(null, function (res) {
        assert.equal(res.statusCode, 404, 'changing exclusions invalidates cached image access immediately');
        request(null, function (res2, r) {
          assert.deepEqual(r.apps.map(function (a) { return a.id; }), ['web.app']);
          request({ action: 'closeAll' }, function () {
            assert.ok(tv.running.indexOf('netflix') !== -1, 'excluded apps remain running');
            excluded = [];
            next();
          });
        });
      }, '/image?id=netflix');
    });
  },
  function (next) {
    reset(); tv.refused = true;
    request({ action: 'close', id: 'netflix' }, function (res, r) {
      assert.equal(res.statusCode, 400);
      assert.equal(r.ok, false);
      assert.ok(tv.cards.indexOf('netflix') !== -1, 'a refused stop retains its card');
      tv.refused = false; tv.ackOnly = true;
      request({ action: 'close', id: 'netflix' }, function (res2, r2) {
        assert.equal(r2.ok, false, 'an acknowledgement without an exit is not a completed close');
        assert.ok(tv.cards.indexOf('netflix') !== -1);
        tv.ackOnly = false;
        request({ action: 'close', id: 'netflix' }, function (res3, r3) {
          assert.equal(r3.ok, true, 'the retained card can be retried');
          assert.equal(tv.running.indexOf('netflix'), -1);
          assert.equal(tv.cards.indexOf('netflix'), -1);
          next();
        });
      });
    });
  },
  function (next) {
    reset(); tv.unavailable = true;
    request({ action: 'closeAll' }, function (res, r) {
      assert.equal(res.statusCode, 400);
      assert.equal(r.ok, false);
      assert.equal(tv.cards.length, 3, 'an unavailable running list preserves the cards');
      next();
    });
  },
  function (next) {
    reset(); tv.newCard = true;
    request({ action: 'closeAll' }, function (res, r) {
      assert.equal(res.statusCode, 200);
      assert.equal(r.ok, true);
      assert.deepEqual(tv.running, ['com.webos.app.home', 'background.app', 'new.app']);
      assert.deepEqual(tv.cards, ['com.webos.app.home', 'new.app']);
      assert.deepEqual(r.apps.map(function (a) { return a.id; }), ['new.app']);
      next();
    });
  },
  function (next) {
    reset();
    request(null, function () {
      request(null, function (res) {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'image/jpeg');
        assert.equal(res.headers['cache-control'], 'private, no-store');
        next();
      }, '/image?id=netflix');
    });
  }
];
server.listen(0, '127.0.0.1', function next() {
  var step = steps.shift();
  if (step) return step(next);
  server.close();
  console.log('Recent-app HTTP outcomes passed.');
});
