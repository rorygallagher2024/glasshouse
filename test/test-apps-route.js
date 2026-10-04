/**
 * test/test-apps-route.js - The Apps tab's /api/apps answers, with the real
 * screensavers module behind it, so a function it calls cannot be renamed
 * from under it unnoticed: held() became heldBack() and the route threw,
 * taking the server down whenever the Apps tab opened.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var events = require('events');
var routes = require('../server/lib/routes');
var screensavers = require('../server/lib/screensavers');

console.log('Running test-apps-route.js ...');

routes.init({
  config: { allowControl: true, token: '', web: { enabled: false } },
  apps: { getApps: function (cb) { cb({ ok: true, installed: [], systemTiles: [] }); } },
  services: { getServices: function (cb) { cb({ ok: true, services: [] }); } },
  screensavers: screensavers,
  fromHomebrewChannel: function () { return false; }
});

var req = new events.EventEmitter();
req.url = '/api/apps';
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
    assert.strictEqual(res.statusCode, 200, res.body);
    var d = JSON.parse(res.body);
    assert.strictEqual(typeof d.tileHidingHeld, 'boolean');
    assert.strictEqual(typeof d.tileHidingOverridden, 'boolean');
    console.log('  ✓ /api/apps answers with the screensavers module it is given');
    console.log('ALL test-apps-route.js assertions passed!\n');
  }
};
routes.handleRequest(req, res);
