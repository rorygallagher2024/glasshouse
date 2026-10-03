/**
 * test/test-restart-wait.js - A restart after a settings save waits for an
 * install that started in the moment before it, rather than being dropped
 *
 * Its own suite, so no other test's routes.init can replace the restart
 * function while this one's restart is still due.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var routes = require('../server/lib/routes');

console.log('Running test-restart-wait.js ...');

var busy = false, restarts = 0;
var cfgFile = path.join(os.tmpdir(), 'tvweb-restart-wait-' + process.pid + '.json');
routes.init({
  config: { allowControl: true, token: '', web: { enabled: false } },
  configFile: cfgFile,
  installer: {
    isWorking: function () { return busy; },
    isBusy: function () { return busy; },
    status: function () { return { state: busy ? 'installing' : 'idle' }; }
  },
  restartSelf: function () { restarts++; return true; }
});

var req = new events.EventEmitter();
req.url = '/api/settings';
req.method = 'POST';
req.headers = { 'content-type': 'application/json', host: '192.168.1.131:8080' };
req.connection = { remoteAddress: '192.168.1.50' };
req.destroy = function () {};
var res = {
  statusCode: null, body: '',
  writeHead: function (code) { res.statusCode = code; },
  setHeader: function () {},
  end: function (chunk) {
    if (chunk) res.body += chunk;
    assert.strictEqual(res.statusCode, 200, res.body);
    // An install starts just after the answer, before the restart is due.
    busy = true;
    setTimeout(function () {
      assert.strictEqual(restarts, 0, 'the restart waits while the install runs');
      busy = false;
      setTimeout(function () {
        assert.strictEqual(restarts, 1, 'and happens once it has finished');
        try { fs.unlinkSync(cfgFile); } catch (e) {}
        console.log('  ✓ a restart after a settings save waits for an install that started meanwhile');
        console.log('ALL test-restart-wait.js assertions passed!\n');
      }, 2600);
    }, 600);
  }
};
routes.handleRequest(req, res);
req.emit('data', JSON.stringify({ mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' } }));
req.emit('end');
