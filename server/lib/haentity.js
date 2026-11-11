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
var LIST_TIMEOUT_MS = 8000;
var MAX_BYTES = 65536;
var MAX_LIST_BYTES = 4 * 1024 * 1024;

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

/**
 * Performs a bounded GET request against Home Assistant's REST API and parses JSON.
 */
function requestHaJson(targetUrl, token, opts, cb) {
  var maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
  var timeoutMs = (opts && opts.timeoutMs) || TIMEOUT_MS;
  var label = (opts && opts.label) || 'Home Assistant';
  var parsed = url.parse(targetUrl);
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
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    }
  }, function (res) {
    var chunks = [];
    var bytes = 0;
    res.on('data', function (chunk) {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
    });
    res.on('end', function () {
      if (answered) return;
      if (res.statusCode !== 200) {
        return fail(res.statusCode === 401
          ? 'Home Assistant refused the token (401)'
          : (res.statusCode === 404 && opts && opts.entityId)
            ? 'no entity ' + opts.entityId + ' (404)'
            : 'Home Assistant answered ' + res.statusCode + (opts && opts.entityId ? ' for ' + opts.entityId : ''));
      }
      if (bytes > maxBytes) return fail(label + ' answered more than ' + maxBytes + ' bytes');
      var body;
      try {
        body = JSON.parse(chunks.join(''));
      } catch (e) {
        return fail(label + ' did not answer JSON');
      }
      answered = true;
      cb({ ok: true, body: body });
    });
  });

  req.setTimeout(timeoutMs, function () {
    req.abort();
    fail('Home Assistant did not answer within ' + timeoutMs + ' ms' + (opts && opts.entityId ? ' for ' + opts.entityId : ''));
  });
  req.on('error', function (e) {
    var code = /** @type {any} */ (e);
    fail((code && code.code === 'ECONNREFUSED')
      ? 'Home Assistant refused the connection at ' + parsed.hostname
      : 'could not reach Home Assistant: ' + (e && e.message ? e.message : String(e)));
  });
  req.end();
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
      error: 'Home Assistant is not configured: set it in the MQTT tab or config.json'
    });
  }

  requestHaJson(cfg.url + '/api/states/' + entityId, cfg.token, { maxBytes: MAX_BYTES, label: entityId, entityId: entityId }, function (r) {
    if (!r.ok) return cb(r);
    var body = r.body;
    if (!body || typeof body.state !== 'string') return cb({ ok: false, error: entityId + ' has no state' });
    cb({
      ok: true,
      entity: entityId,
      state: body.state,
      attributes: body.attributes && typeof body.attributes === 'object' ? body.attributes : {},
      updated: typeof body.last_updated === 'string' ? body.last_updated : ''
    });
  });
}

function update(ha) {
  ha = ha || {};
  if (typeof ha.url === 'string') cfg.url = ha.url.replace(/\/+$/, '');
  if (typeof ha.token === 'string') cfg.token = ha.token;
}

function test(opts, cb) {
  cb = cb || function () {};
  opts = opts || {};
  var testUrl = typeof opts.url === 'string' ? opts.url.replace(/\/+$/, '') : cfg.url;
  var testToken = (typeof opts.token === 'string' && opts.token) ? opts.token : cfg.token;

  if (!/^https?:\/\//i.test(testUrl)) {
    return cb({ ok: false, error: 'URL must start with http:// or https://' });
  }
  if (!testToken) {
    return cb({ ok: false, error: 'A Long-Lived Access Token is required' });
  }

  requestHaJson(testUrl + '/api/', testToken, { maxBytes: MAX_BYTES, label: 'Home Assistant' }, function (r) {
    if (!r.ok) return cb(r);
    var body = r.body;
    cb({ ok: true, message: (body && body.message) || 'Connected to Home Assistant' });
  });
}

/**
 * Fetches available entities (id, friendly name, unit) from Home Assistant without states.
 */
function list(cb) {
  cb = cb || function () {};
  if (!configured()) {
    return cb({ ok: false, error: 'Home Assistant is not configured' });
  }
  requestHaJson(cfg.url + '/api/states', cfg.token, { maxBytes: MAX_LIST_BYTES, timeoutMs: LIST_TIMEOUT_MS, label: 'Home Assistant' }, function (r) {
    if (!r.ok) return cb(r);
    if (!Array.isArray(r.body)) return cb({ ok: false, error: 'Home Assistant did not return an entity list' });
    var out = [];
    for (var i = 0; i < r.body.length; i++) {
      var item = r.body[i];
      if (!item || typeof item.entity_id !== 'string') continue;
      var attrs = item.attributes && typeof item.attributes === 'object' ? item.attributes : {};
      out.push({
        id: item.entity_id,
        name: typeof attrs.friendly_name === 'string' ? attrs.friendly_name : '',
        unit: typeof attrs.unit_of_measurement === 'string' ? attrs.unit_of_measurement : ''
      });
    }
    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    cb({ ok: true, entities: out });
  });
}

module.exports = {
  init: init,
  read: read,
  list: list,
  configured: configured,
  update: update,
  test: test
};
