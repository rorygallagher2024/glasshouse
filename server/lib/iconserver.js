/*
 * Installed apps' icons for other devices on the LAN, such as a launcher on
 * an Android TV box, while the dashboard itself stays bound to the TV.
 * Read-only, unauthenticated, and nothing but GET or HEAD /icons/<appId>.png,
 * resolved through apps.getIconPath. Off unless `iconServer` is true.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var fs = require('fs');
var http = require('http');
var url = require('url');
var listenDualStack = require('./util').listenDualStack;
var localAddress4 = require('./util').localAddress4;
var hostPort = require('./util').hostPort;

// A leading dot is refused as well, so '.' and '..' never reach a path join.
var APP_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
var ICON_PATH_RE = /^\/icons\/([^\/]+)\.png$/;

var config = {};
/** @type {typeof import('./apps')} */
var appsModule = null;
/** @type {http.Server} */
var server = null;
var listening = false;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.apps) appsModule = opts.apps;
}

function enabled() {
  return !!(config && config.iconServer === true);
}

function port() {
  return (config.port || 8080) + 2;
}

/*
 * Answers a GET or HEAD for the icon file at iconPath, with an ETag and a
 * 304 for a client already holding it. fail(status, message) answers when the
 * file cannot be read, so each server words its own errors.
 */
function sendIconFile(req, res, iconPath, fail, contentType, cacheControl) {
  fs.stat(iconPath, function (err, st) {
    if (err || !st || !st.isFile()) return fail(404, 'icon read failed');
    var etag = '"' + st.size.toString(16) + '-' + Number(st.mtime).toString(16) + '"';
    var headers = {
      'Content-Type': contentType || 'image/png',
      'Content-Length': st.size,
      'Cache-Control': cacheControl || 'public, max-age=86400',
      'ETag': etag
    };
    if (req.headers && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': headers['Cache-Control'] });
      return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    fs.readFile(iconPath, function (readErr, buf) {
      if (readErr || !buf) return fail(500, 'icon read failed');
      res.writeHead(200, headers);
      res.end(buf);
    });
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
  var m = ICON_PATH_RE.exec(url.parse(req.url || '').pathname || '');
  if (!m || !APP_ID_RE.test(m[1]) || !appsModule) return notFound(res);
  appsModule.getIconPath(m[1], function (iconPath) {
    if (!iconPath) return notFound(res);
    sendIconFile(req, res, iconPath, function (status) {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 404 ? 'not found' : 'error');
    });
  });
}

/*
 * Listens on the LAN when switched on. A port already taken is logged and
 * left: the dashboard and the bridge carry on without icons. cb(err, started).
 */
function start(cb) {
  cb = cb || function () {};
  if (!enabled() || server) return cb(null, false);
  var srv = http.createServer(handleRequest);
  server = srv;
  // IPv4-only if the dashboard is; dual-stack otherwise.
  var host = config.host === '0.0.0.0' ? '0.0.0.0' : '::';
  listenDualStack(srv, port(), host, function (err) {
    if (server !== srv) {   // stopped while it was opening
      if (!err) srv.close();
      return cb(null, false);
    }
    if (err) {
      server = null;
      console.error('icons: could not listen on port ' + port() + ': ' + err.message);
      return cb(err, false);
    }
    listening = true;
    srv.on('error', function (e) {
      console.error('icons: server failed: ' + e.message);
      stop();
    });
    console.log('icons: serving app icons on port ' + port());
    cb(null, true);
  });
}

function stop() {
  if (!server) return;
  var srv = server;
  server = null;
  if (listening) {
    listening = false;
    try { srv.close(); } catch (e) {}
  }
}

/*
 * Where an app's icon is reached from the LAN, 'http://<ip>:<port>/icons/',
 * or null while the server is not listening or the TV has no address.
 */
function baseUrl() {
  if (!listening) return null;
  var ip4 = localAddress4();
  return ip4 ? 'http://' + hostPort(ip4, port()) + '/icons/' : null;
}

module.exports = {
  APP_ID_RE: APP_ID_RE,
  init: init,
  enabled: enabled,
  port: port,
  start: start,
  stop: stop,
  baseUrl: baseUrl,
  handleRequest: handleRequest,
  sendIconFile: sendIconFile
};
