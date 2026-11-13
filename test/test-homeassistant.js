/**
 * test/test-homeassistant.js - /api/homeassistant serves every entity the
 * staged screen saver declared in one answer, and nothing the saver did not
 * declare.
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

console.log('Running test-homeassistant.js ...');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STAGE = '/var/lib/tvweb/screensaver';
var BUILTIN = path.join(__dirname, '..', 'server', 'assets', 'screensavers');
var ENTS = path.join(__dirname, 'fixtures', 'saver-entities');

screensavers.init({
  luna: env.mockLuna,
  config: { port: 8080, allowControl: true, token: 'tok' },
  saverRoots: [{ dir: BUILTIN, builtin: true }, { dir: ENTS, builtin: false }]
});

env.files[path.join(APP, '.tvweb-screensaver')] = 'user-ha-entities';
screensavers.restageScreensaver();

var readIds = [];
var configured = true;

routes.init({
  config: { allowControl: true, token: 'tok', web: { enabled: false } },
  configFile: '/var/lib/tvweb/config.json',
  screensavers: screensavers,
  haEntity: {
    configured: function () { return configured; },
    readMany: function (ids, cb) {
      readIds.push(ids.slice());
      var out = {};
      for (var i = 0; i < ids.length; i++) {
        out[ids[i]] = { state: '9.1112', attributes: { unit_of_measurement: 'h' }, updated: '' };
      }
      cb({ ok: true, entities: out, errors: {} });
    }
  },
  fromHomebrewChannel: function () { return false; }
});

function request(method, url, jsonBody, done) {
  var req = new events.EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = { host: '192.168.1.131:8080' };
  if (method === 'POST') req.headers['content-type'] = 'application/json';
  req.connection = { remoteAddress: '192.168.1.50' };
  req.setEncoding = function () {};
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
  if (jsonBody !== null) {
    req.emit('data', JSON.stringify(jsonBody));
    req.emit('end');
  }
}

function get(url, done) { request('GET', url, null, done); }

// 1. Without the token, nothing.
get('/api/homeassistant', function (status, body) {
  assert.strictEqual(status, 401, body);
  assert.deepEqual(readIds, []);
  console.log('  \u2713 the read takes the token every other read takes');

  // 2. One answer with every declared entity, read in one go.
  get('/api/homeassistant?k=tok', function (status2, body2) {
    assert.strictEqual(status2, 200, body2);
    var d = JSON.parse(body2);
    assert.strictEqual(d.ok, true, body2);
    assert.deepEqual(Object.keys(d.entities).sort(), ['humidity', 'temp']);
    assert.strictEqual(d.entities.temp.state, '9.1112');
    assert.strictEqual(d.entities.temp.attributes.unit_of_measurement, 'h');
    assert.deepEqual(readIds, [['sensor.example_temperature', 'sensor.example_humidity']],
      'every declared entity is read, in one call');
    assert.strictEqual(d.calendar, undefined, 'no calendar in this answer');
    console.log('  \u2713 one answer carries the declared entities and nothing else');

    // 3. The staged QML is handed the single address.
    var qml = env.files[path.join(STAGE, 'qml', 'main.qml')];
    assert.ok(qml.indexOf('http://127.0.0.1:8080/api/homeassistant?k=tok') !== -1, 'ha-all URL staged');
    assert.strictEqual(qml.indexOf('__TVWEB_HA_ALL__'), -1, 'no ha-all placeholder left');
    console.log('  \u2713 the saver is handed one address, with the token');

    // 4. A saver that declares nothing is served nothing.
    env.files[path.join(APP, '.tvweb-screensaver')] = 'vitals';
    screensavers.restageScreensaver();
    get('/api/homeassistant?k=tok', function (status3, body3) {
      assert.strictEqual(status3, 200, body3);
      var d3 = JSON.parse(body3);
      assert.deepEqual(d3.entities, {});
      assert.strictEqual(readIds.length, 1, 'Home Assistant was not asked again');
      console.log('  \u2713 a saver that declares nothing is served nothing');

      // 5. With the API off, the answer says so rather than failing.
      env.files[path.join(APP, '.tvweb-screensaver')] = 'user-ha-entities';
      screensavers.restageScreensaver();
      configured = false;
      get('/api/homeassistant?k=tok', function (status4, body4) {
        assert.strictEqual(status4, 200, body4);
        var d4 = JSON.parse(body4);
        assert.strictEqual(d4.ok, false);
        assert.strictEqual(d4.configured, false);
        console.log('  \u2713 an unconfigured API is reported, not retried');

        env.restore();
        console.log('ALL test-homeassistant.js assertions passed!\n');
      });
    });
  });
});
