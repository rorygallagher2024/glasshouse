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
var tested = [];
var updatedCfg = null;
var haIsConfigured = false;
var testCfg = { allowControl: true, token: 'tok', web: { enabled: false } };
env.files['/var/lib/tvweb/config.json'] = '{}';

routes.init({
  config: testCfg,
  configFile: '/var/lib/tvweb/config.json',
  screensavers: screensavers,
  haEntity: {
    read: function (id, cb) {
      asked.push(id);
      cb({ ok: true, entity: id, state: '9.1112', attributes: { unit_of_measurement: 'h' } });
    },
    test: function (opts, cb) {
      tested.push(opts);
      cb(opts.url === 'http://good:8123' ? { ok: true, message: 'API running.' } : { ok: false, error: 'bad url' });
    },
    update: function (ha) {
      updatedCfg = ha;
      haIsConfigured = !!(ha && ha.url && ha.token);
    },
    configured: function () { return haIsConfigured; },
    list: function (cb) {
      cb({ ok: true, entities: [{ id: 'sensor.outdoor_temperature', name: 'Outdoor Temp', unit: 'C' }] });
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
function post(url, body, done) { request('POST', url, body, done); }

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

        // 5. Overriding an entity slot restages and serves only the override.
        env.files[path.join(APP, '.tvweb-screensaver')] = 'user-ha-reads';
        screensavers.restageScreensaver();
        screensavers.setSaverEntities('user-ha-reads', { daylight: 'not valid' }, function (badRes) {
          assert.strictEqual(badRes.ok, false);
          screensavers.setSaverEntities('user-ha-reads', { daylight: 'sensor.override_daylight' }, function (okRes) {
            assert.strictEqual(okRes.ok, true, okRes.error);
            assert.strictEqual(screensavers.screensaverEntities().daylight, 'sensor.override_daylight');
            get('/api/entity/sensor.override_daylight?k=tok', function (status5, body5) {
              assert.strictEqual(status5, 200, body5);
              get('/api/entity/sensor.example_daylight?k=tok', function (status6) {
                assert.strictEqual(status6, 404, 'old default no longer served once overridden');
                screensavers.setSaverEntities('user-ha-reads', { daylight: '' }, function (clearRes) {
                  assert.strictEqual(clearRes.ok, true);
                  assert.strictEqual(screensavers.screensaverEntities().daylight, undefined, 'cleared slot is omitted from active entities');
                  get('/api/entity/sensor.example_daylight?k=tok', function (statusClear) {
                    assert.strictEqual(statusClear, 404, 'cleared slot refuses old default');
                    screensavers.setSaverEntities('user-ha-reads', { daylight: null }, function (resetRes) {
                      assert.strictEqual(resetRes.ok, true);
                      assert.strictEqual(screensavers.screensaverEntities().daylight, 'sensor.example_daylight');
                      console.log('  \u2713 overriding, clearing, and resetting entity slots updates what is served');

                      // 6. POST /api/ha/test tests connection via haEntity module
                      post('/api/ha/test', { url: 'http://good:8123', token: 'abc' }, function (status7) {
                        assert.strictEqual(status7, 401, 'requires token when set');
                        post('/api/ha/test?k=tok', { url: 'http://good:8123', token: 'abc' }, function (status8, body8) {
                          assert.strictEqual(status8, 200, body8);
                          assert.strictEqual(JSON.parse(body8).ok, true);
                          assert.deepEqual(tested, [{ url: 'http://good:8123', token: 'abc' }]);
                          post('/api/ha/test?k=tok', { url: 'http://bad:8123', token: 'abc' }, function (status9, body9) {
                            assert.strictEqual(status9, 400, body9);
                            assert.strictEqual(JSON.parse(body9).ok, false);
                            console.log('  \u2713 /api/ha/test enforces auth and forwards to haEntity.test');

                            // 7. POST /api/ha/save applies credentials live and GET /api/ha/entities lists them
                            get('/api/ha/entities?k=tok', function (status10, body10) {
                              assert.strictEqual(status10, 200);
                              assert.strictEqual(JSON.parse(body10).configured, false);
                              post('/api/ha/save?k=tok', { url: 'http://good:8123/', token: 'my-secret' }, function (status11, body11) {
                                assert.strictEqual(status11, 200, body11);
                                var d11 = JSON.parse(body11);
                                assert.strictEqual(d11.ok, true);
                                assert.strictEqual(d11.configured, true);
                                assert.deepEqual(updatedCfg, { url: 'http://good:8123', token: 'my-secret' });
                                assert.strictEqual(JSON.parse(env.files['/var/lib/tvweb/config.json']).homeAssistant.url, 'http://good:8123');
                                get('/api/ha/entities?k=tok', function (status12, body12) {
                                  assert.strictEqual(status12, 200, body12);
                                  var d12 = JSON.parse(body12);
                                  assert.strictEqual(d12.configured, true);
                                  assert.strictEqual(d12.entities.length, 1);
                                  console.log('  \u2713 /api/ha/save updates credentials live and /api/ha/entities returns entities');

                                  env.restore();
                                  console.log('ALL test-entity-route.js assertions passed!\n');
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
