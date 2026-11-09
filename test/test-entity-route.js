/**
 * test/test-entity-route.js - /api/entity serves what the screen saver on the
 * TV declared, and nothing else, with the token every other read takes
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var events = require('events');
var path = require('path');

var mockEnv = require('./mocks/mock-env');
var env = mockEnv.createMockEnv({ files: {} });
env.install();

var routes = require('../server/lib/routes');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-entity-route.js ...');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STAGE = '/var/lib/tvweb/screensaver';
var BUILTIN = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var ENTS = path.join(__dirname, 'fixtures', 'saver-entities');

screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true, token: 'tok' },
  saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: ENTS, builtin: false }]
});

// The saver that declares two entities is the one on the TV.
env.files[path.join(APP, '.tvweb-screensaver')] = 'user-ha-reads';
screensavers.restageScreensaver();

var asked = [];
routes.init({
  config: { allowControl: true, token: 'tok', web: { enabled: false } },
  screensavers: screensavers,
  haEntity: {
    read: function (id, cb) {
      asked.push(id);
      cb({ ok: true, entity: id, state: '9.1112', attributes: { unit_of_measurement: 'h' } });
    }
  },
  fromHomebrewChannel: function () { return false; }
});

function get(url, done) {
  var req = new events.EventEmitter();
  req.url = url;
  req.method = 'GET';
  req.headers = { host: '192.168.1.131:8080' };
  req.connection = { remoteAddress: '192.168.1.50' };
  req.destroy = function () {};
  var res = {
    statusCode: null, body: '',
    writeHead: function (code) { res.statusCode = code; },
    setHeader: function () {},
    end: function (chunk) {
      if (chunk) res.body += chunk;
      done(res.statusCode, res.body);
    }
  };
  routes.handleRequest(req, res);
}

// 1. A declared entity is read, with the token the dashboard also takes.
get('/api/entity/sensor.example_daylight?k=tok', function (status, body) {
  assert.strictEqual(status, 200, body);
  var d = JSON.parse(body);
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.entity, 'sensor.example_daylight');
  assert.strictEqual(d.state, '9.1112');
  assert.deepEqual(asked, ['sensor.example_daylight']);
  console.log('  \u2713 a declared entity is read');

  // 2. An entity the saver did not declare is not served, even though the
  //    token would allow every other read.
  get('/api/entity/sensor.someone_elses?k=tok', function (status2, body2) {
    assert.strictEqual(status2, 404, body2);
    assert.ok(/does not declare/.test(JSON.parse(body2).error), body2);
    assert.deepEqual(asked, ['sensor.example_daylight'], 'Home Assistant was not asked');
    console.log('  \u2713 an undeclared entity is refused without asking Home Assistant');

    // 3. Without the token, no read at all.
    get('/api/entity/sensor.example_daylight', function (status3, body3) {
      assert.strictEqual(status3, 401, body3);
      console.log('  \u2713 the read takes the same token as every other');

      // 4. With nothing declared, nothing is served.
      env.files[path.join(APP, '.tvweb-screensaver')] = 'vitals';
      screensavers.restageScreensaver();
      get('/api/entity/sensor.example_daylight?k=tok', function (status4, body4) {
        assert.strictEqual(status4, 404, body4);
        console.log('  \u2713 a saver that declares nothing is served nothing');

        env.restore();
        console.log('ALL test-entity-route.js assertions passed!\n');
      });
    });
  });
});
