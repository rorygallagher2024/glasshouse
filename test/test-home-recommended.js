/* The Recommended row: the cards the apps publish are read, kept to a few an
 * app, and only a listed card opens, at its title.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var recommended = require('../server/lib/home-recommended');

var tv, launched;

function card(app, contentId, title, extra) {
  var c = { type: 'content', titleText: title, category: 'Top picks',
    image: { url: 'https://img.example/' + contentId + '.jpg', width: 480, height: 270 },
    onClick: { targetAppId: app, contentId: contentId, launchParam: '' } };
  for (var k in extra || {}) if (extra.hasOwnProperty(k)) c[k] = extra[k];
  return c;
}

function reset() {
  launched = [];
  var many = [];
  for (var i = 0; i < 15; i++) many.push(card('youtube.leanback.v4', 'v=' + i, 'Video ' + i));
  tv = { answer: { returnValue: true, allContents: [
    { launchPointId: 'netflix_default', contents: [
      // Each list opens with an empty heading entry.
      { type: 'title', titleText: '', onClick: { targetAppId: 'netflix', contentId: '' } },
      card('netflix', 'm=1', '  Lupin  '),
      card('netflix', 'm=2', 'Perfeito!', { image: { url: 'javascript:alert(1)' } }),
      card('netflix', 'm=1', 'Lupin again'),
      card('netflix', '', 'No content id')
    ] },
    { launchPointId: 'youtube.leanback.v4_default', contents: many },
    { launchPointId: 'com.webos.app.browser_default', contents: [] }
  ] } };
}

function luna(uri, payload, cb) {
  var r;
  if (uri === 'com.webos.service.applicationmanager/getAllContents') r = tv.answer;
  else if (uri === 'com.webos.applicationManager/launch') {
    launched.push(payload);
    r = { returnValue: !tv.refuse };
  } else throw new Error('unexpected Luna call: ' + uri);
  process.nextTick(function () { cb(r); });
}

recommended.init({ luna: luna });

var steps = [
  function (next) {
    reset();
    recommended.cards(function (list) {
      var netflix = list.filter(function (c) { return c.app === 'netflix'; });
      assert.equal(netflix.length, 2, 'headings, repeats and cards without a content id are left out');
      assert.equal(netflix[0].title, 'Lupin');
      assert.equal(netflix[0].category, 'Top picks');
      assert.equal(netflix[0].image, 'https://img.example/m=1.jpg');
      assert.equal(netflix[1].image, null, 'only an http(s) picture is passed on');
      assert.equal(netflix[0].contentId, undefined, 'the launch parameter stays on the server');
      assert.equal(list.filter(function (c) { return c.app === 'youtube.leanback.v4'; }).length, 12, 'at most 12 an app');
      recommended.cards(function (again) {
        assert.equal(again[0].id, list[0].id, 'a card keeps its id from one read to the next');
        next();
      });
    });
  },
  function (next) {
    reset();
    recommended.cards(function (list) {
      recommended.open(list[0].id, function (r) {
        assert.equal(r.ok, true);
        assert.equal(r.app, 'netflix');
        assert.deepEqual(launched, [{ id: 'netflix', params: { contentTarget: 'm=1' } }]);
        recommended.open('not-a-card', function (r2) {
          assert.equal(r2.ok, false, 'only a listed card opens');
          assert.equal(launched.length, 1);
          tv.refuse = true;
          recommended.open(list[0].id, function (r3) {
            assert.equal(r3.ok, false, 'a refused launch is reported');
            next();
          });
        });
      });
    });
  },
  function (next) {
    reset();
    tv.answer = { returnValue: false, errorText: 'Unknown method' };
    recommended.cards(function (list) {
      assert.equal(list, null, 'a TV without the call gives no list');
      recommended.open('x', function (r) {
        assert.equal(r.ok, false);
        next();
      });
    });
  }
];

(function next() {
  var step = steps.shift();
  if (step) return step(next);
  console.log('Recommended row passed.');
})();
