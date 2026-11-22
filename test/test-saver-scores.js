/*
 * test/test-saver-scores.js - The Scores screen saver shows the Premier League
 * until leagues are picked, keeps up to four known ones, refuses none, and is
 * staged with the address of /api/scores for them, carrying the token. With
 * Glasshouse Home they are its board's leagues, picked on either tab. A
 * screen saver added on the TV is not given that address.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var mockEnv = require('./mocks/mock-env');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-saver-scores.js ...');

var BUILTIN_DIR = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var APP = '/usr/palm/applications/com.webos.app.screensaver/';

var addedRoot = path.join(os.tmpdir(), 'tvweb-saver-scores-' + process.pid + '-' + Date.now());
fs.mkdirSync(addedRoot);
fs.mkdirSync(path.join(addedRoot, 'mine'));
fs.writeFileSync(path.join(addedRoot, 'mine', 'saver.json'), JSON.stringify({
  manifest: 1, version: '1.0.0', name: 'Mine', description: 'Asks for scores', uses: ['scores']
}));
fs.writeFileSync(path.join(addedRoot, 'mine', 'main.qml'), 'import QtQuick 2.4\nItem { property string u: "__TVWEB_SCORES__" }\n');

var env = mockEnv.createMockEnv({ files: {
  '/usr/palm/applications/com.webos.app.screensaver/appinfo.json': '{"id":"com.webos.app.screensaver","type":"qml"}'
}, luna: {
  'com.webos.service.tvpower/power/getPowerState': function () { return { returnValue: true, state: 'Active' }; },
  'com.webos.applicationManager/getAppInfo': function () { return { returnValue: true, appInfo: { id: 'com.webos.app.screensaver' } }; }
} });
env.install();
env.files[APP + '.tvweb-screensaver'] = 'scores';
screensavers.init({
  luna: env.mockLuna,
  config: { allowControl: true, port: 8080, token: 't1' },
  saverRoots: [{ dir: BUILTIN_DIR, builtin: true }, { dir: addedRoot, builtin: false }],
  injectKey: function (k, cb) { cb(true); },
  KEY_BACK: 412
});
screensavers.restageScreensaver();

function staged() { return fs.readFileSync(path.join(screensavers.SCREENSAVER_DIR, 'qml', 'main.qml'), 'utf8'); }
function mode(id) { return screensavers.screensaverList().modes.filter(function (m) { return m.id === id; })[0]; }

var qml = staged();
assert.ok(!/__TVWEB_\w+__/.test(qml), 'every placeholder filled: ' + (qml.match(/__TVWEB_\w+__/) || [''])[0]);
assert.ok(qml.indexOf('"http://127.0.0.1:8080/api/scores?leagues=soccer%2Feng.1&k=t1"') !== -1, 'Premier League by default');
var m = mode('scores');
assert.deepEqual(m.leagues, ['soccer/eng.1']);
assert.ok(m.leagueOptions.length > 10 && m.leagueOptions[0].label === 'Premier League');
assert.strictEqual(mode('clock').leagueOptions, undefined, 'only a saver showing scores offers leagues');
var mine = screensavers.screensaverList().modes.filter(function (x) { return x.label === 'Mine'; })[0];
assert.strictEqual(mine.available, false, 'one added on the TV is not given the address');
assert.ok(/matches/.test(mine.note));
console.log('  ✓ the Premier League until leagues are picked, staged as /api/scores with the token');

screensavers.setSaverLeagues('scores', [], function (none) {
  assert.strictEqual(none.ok, false, 'none is refused');
  screensavers.setSaverLeagues('clock', ['soccer/eng.1'], function (notScores) {
    assert.strictEqual(notScores.ok, false);
    screensavers.setSaverLeagues('scores', ['soccer/uefa.champions', 'nope', 'soccer/eng.1', 'soccer/eng.1',
      'soccer/swe.1', 'hockey/nhl', 'basketball/nba'], function (r) {
      assert.strictEqual(r.ok, true);
      assert.deepEqual(r.leagues, ['soccer/uefa.champions', 'soccer/eng.1', 'soccer/swe.1', 'hockey/nhl'], 'known, once each, up to four');
      assert.deepEqual(mode('scores').leagues, r.leagues);
      assert.ok(staged().indexOf('leagues=' + encodeURIComponent(r.leagues.join(',')) + '&k=t1') !== -1, 'restaged with them');
      console.log('  ✓ up to four known leagues are kept and restaged, none is refused');

      // With Glasshouse Home, the leagues are its board's: one list for both.
      var board = ['soccer/swe.1'];
      var boardSets = [];
      screensavers.init({
        luna: env.mockLuna,
        config: { allowControl: true, port: 8080, token: 't1' },
        saverRoots: [{ dir: BUILTIN_DIR, builtin: true }, { dir: addedRoot, builtin: false }],
        injectKey: function (k, cb) { cb(true); },
        KEY_BACK: 412,
        leagues: function () { return board; },
        setLeagues: function (list, done) {
          boardSets.push(list);
          board = list;
          screensavers.leaguesChanged();
          done({ ok: true });
        }
      });
      screensavers.restageScreensaver();
      assert.deepEqual(mode('scores').leagues, ['soccer/swe.1'], 'the board\'s leagues');
      assert.ok(staged().indexOf('leagues=soccer%2Fswe.1&k=t1') !== -1);
      board = ['soccer/eng.1', 'soccer/uefa.champions'];
      screensavers.leaguesChanged();
      assert.ok(staged().indexOf('leagues=' + encodeURIComponent('soccer/eng.1,soccer/uefa.champions')) !== -1, 'picked on the Home tab, restaged');
      screensavers.setSaverLeagues('scores', ['soccer/ger.1', 'nope'], function (shared) {
        assert.strictEqual(shared.ok, true);
        assert.deepEqual(boardSets, [['soccer/ger.1']], 'picked here, saved as the board\'s');
        assert.ok(staged().indexOf('leagues=soccer%2Fger.1&k=t1') !== -1);
        board = [];
        assert.deepEqual(mode('scores').leagues, ['soccer/eng.1'], 'a board without leagues: the Premier League');
        console.log('  ✓ with Glasshouse Home, the leagues are its board\'s, picked on either tab');
        env.restore();
      fs.unlinkSync(path.join(addedRoot, 'mine', 'saver.json'));
      fs.unlinkSync(path.join(addedRoot, 'mine', 'main.qml'));
      fs.rmdirSync(path.join(addedRoot, 'mine'));
      fs.rmdirSync(addedRoot);
        console.log('\nALL test-saver-scores.js assertions passed!\n');
      });
    });
  });
});
