/*
 * lib/haentity.js - one Home Assistant entity's state and attributes
 *
 * The read behind a screen saver's own values. Glasshouse holds the token in
 * config.json, a screen saver asks this server, and this asks Home Assistant,
 * so no token reaches a saver's QML. Nothing here interprets the answer: only
 * the saver knows whether 9.1112 hours should read 9h 07m.
 *
 * Strict ES5: runs on node 0.12.
 */
var http = require('http');
var https = require('https');
var url = require('url');

var TIMEOUT_MS = 5000;
var MAX_BYTES = 65536;

var cfg = { url: '', token: '' };

function init(opts) {
  opts = opts || {};
  var ha = (opts.config && opts.config.homeAssistant) || {};
  cfg = {
    url: typeof ha.url === 'string' ? ha.url.replace(/\/+$/, '') : '',
    token: typeof ha.token === 'string' ? ha.token : ''
  };
}

function configured() {
  return !!(/^https?:\/\//i.test(cfg.url) && cfg.token);
}

/*
 * read(entityId, cb) - cb({ ok: true, entity, state, attributes }) with the
 * entity as Home Assistant reports it, or cb({ ok: false, error }) in words fit
 * for a log line. The token is never included in an error.
 */
function read(entityId, cb) {
  cb = cb || function () {};
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(String(entityId || ''))) {
    return cb({ ok: false, error: 'not an entity id: ' + String(entityId).slice(0, 60) });
  }
  if (!configured()) {
    return cb({
      ok: false,
      error: 'Home Assistant is not configured: set homeAssistant.url and homeAssistant.token in config.json'
    });
  }

  var target = cfg.url + '/api/states/' + entityId;
  var parsed = url.parse(target);
  var lib = parsed.protocol === 'https:' ? https : http;
  var answered = false;

  function fail(error) {
    if (answered) return;
    answered = true;
    cb({ ok: false, error: error });
  }

  var req = lib.request({
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.path,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/json'
    }
  }, function (res) {
    var chunks = [];
    var bytes = 0;
    res.on('data', function (chunk) {
      bytes += chunk.length;
      if (bytes <= MAX_BYTES) chunks.push(chunk);
    });
    res.on('end', function () {
      if (answered) return;
      if (res.statusCode !== 200) {
        return fail(res.statusCode === 401
          ? 'Home Assistant refused the token (401)'
          : res.statusCode === 404
            ? 'no entity ' + entityId + ' (404)'
            : 'Home Assistant answered ' + res.statusCode + ' for ' + entityId);
      }
      if (bytes > MAX_BYTES) return fail(entityId + ' answered more than ' + MAX_BYTES + ' bytes');
      var body;
      try {
        body = JSON.parse(chunks.join(''));
      } catch (e) {
        return fail(entityId + ' did not answer JSON');
      }
      if (!body || typeof body.state !== 'string') return fail(entityId + ' has no state');
      answered = true;
      cb({
        ok: true,
        entity: entityId,
        state: body.state,
        attributes: body.attributes && typeof body.attributes === 'object' ? body.attributes : {},
        updated: typeof body.last_updated === 'string' ? body.last_updated : ''
      });
    });
  });

  req.setTimeout(TIMEOUT_MS, function () {
    req.abort();
    fail('Home Assistant did not answer within ' + TIMEOUT_MS + ' ms for ' + entityId);
  });
  req.on('error', function (e) {
    var code = /** @type {any} */ (e);
    fail((code && code.code === 'ECONNREFUSED')
      ? 'Home Assistant refused the connection at ' + parsed.hostname
      : 'could not reach Home Assistant: ' + (e && e.message ? e.message : String(e)));
  });
  req.end();
}

module.exports = {
  init: init,
  read: read,
  configured: configured
};
