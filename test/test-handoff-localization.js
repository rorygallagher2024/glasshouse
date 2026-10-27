/** Handoff localization stays behind its one-time code and static allowlist. ES5. */
var assert = require('assert');
var fs = require('fs');
var http = require('http');
var path = require('path');
var url = require('url');
var util = require('../server/lib/util');
var originalAddress = util.localAddress4;
var originalListen = util.listenDualStack;
var config = { port: 8080, host: '127.0.0.1', allowControl: true };
var port;

// Keep the integration test on loopback and let the OS allocate its port.
util.localAddress4 = function () { return '127.0.0.1'; };
util.listenDualStack = function (server, requestedPort, requestedHost, callback) {
  originalListen(server, 0, '127.0.0.1', function (error) {
    if (!error) { port = server.address().port; config.port = port - 1; }
    callback(error);
  });
};
var routes = require('../server/lib/routes');
var assets = path.join(__dirname, '..', 'server', 'assets');
routes.init({
  config: config,
  assetPath: function (relative) {
    var file = path.join(assets, relative);
    return fs.existsSync(file) ? file : null;
  }
});
var finished = false;
var deadline = setTimeout(function () { done(new Error('handoff test timed out')); }, 15000);
function done(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  routes.stopHandoff();
  util.localAddress4 = originalAddress;
  util.listenDualStack = originalListen;
  if (error) { console.error(error.stack || error); process.exit(1); }
  console.log('Handoff localization requires its code; unrelated files and expired codes are refused.');
}
function request(resource, method, callback) {
  var req = http.request({ hostname: '127.0.0.1', port: port, path: resource, method: method }, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (part) { body += part; });
    res.on('end', function () {
      if (finished) return;
      try { callback(res, body); } catch (error) { done(error); }
    });
  });
  req.on('error', done);
  req.end();
}
function sequence(steps) {
  if (!steps.length) return done();
  var step = steps.shift();
  step(function () { sequence(steps); });
}
routes.startHandoff(function (error, link) {
  if (error) return done(error);
  var code = url.parse(link, true).query.c;
  function status(resource, method, expected) {
    return function (next) {
      request(resource, method, function (response) {
        assert.strictEqual(response.statusCode, expected, method + ' ' + resource);
        next();
      });
    };
  }
  sequence([
    status('/assets/i18n/ar.json', 'GET', 403),
    status('/assets/i18n/ar.json?c=wrong', 'GET', 403),
    status('/?c=' + code, 'GET', 200),
    status('/assets/i18n.js?c=' + code, 'GET', 200),
    status('/assets/rtl.css?c=' + code, 'GET', 200),
    status('/assets/i18n/ar.json?c=' + code, 'GET', 200),
    status('/assets/i18n/ar.json?c=' + code, 'POST', 404),
    status('/assets/dashboard.html?c=' + code, 'GET', 404),
    status('/assets/../config.json?c=' + code, 'GET', 404),
    function (next) {
      routes.stopHandoff();
      routes.startHandoff(function (error, newLink) {
        if (error) return done(error);
        var newCode = url.parse(newLink, true).query.c;
        assert.notStrictEqual(newCode, code, 'a replacement link invalidates the old code');
        status('/assets/i18n/ar.json?c=' + code, 'GET', 403)(function () {
          status('/assets/i18n/ar.json?c=' + newCode, 'GET', 200)(next);
        });
      });
    }
  ]);
});
