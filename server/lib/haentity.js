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
var msg = require('./say').msg;
var http = require('http');
var https = require('https');
var url = require('url');
var crypto = require('crypto');
var allocBuffer = require('./util').allocBuffer;

var TIMEOUT_MS = 5000;
var LIST_TIMEOUT_MS = 8000;
var MAX_BYTES = 65536;
// Every entity with all its attributes: 2.2 MB for one install, under 4 MB for
// 4,557 entities in another. Parsed whole, so it is held in memory at once.
var MAX_LIST_BYTES = 8 * 1024 * 1024;
var WS_BACKOFF_MS = 2000;
var WS_MAX_BACKOFF_MS = 30000;
// How long a watched entity's cache entry is kept once nothing has asked for
// it: long enough to survive a slow screen saver tick, short enough that a
// removed bar entity stops being pushed to.
var WATCH_TTL_MS = 10 * 60 * 1000;
// A bar or a screen saver asks for its entities together, so a change to
// what is watched waits this long before the subscription is made again.
var RESUBSCRIBE_MS = 200;

/*
 * updateMode: "websocket" (the default) keeps a connection open to Home
 * Assistant, which pushes each change to the entities Glasshouse uses, with
 * REST answering until it is up and while it reconnects. "polling", set only
 * in config.json, never opens it: every read is a REST request, as before
 * the socket existed, for a setup where it misbehaves.
 */
var cfg = { enabled: true, url: '', token: '', tlsRejectUnauthorized: true, updateMode: 'websocket' };
var lastStatus = { ok: null, message: '', error: '', checkedAt: 0 };
// For the HA & MQTT tab's Connection box, as the MQTT one shows its broker:
// how long Home Assistant last took to answer, and when an entity was last read.
var lastLatencyMs = null;
var lastReadAt = 0;

/*
 * Entities read() or readMany() has been asked for, each with when it was
 * last asked for (watchedAt) and, once known, its state (cache). The socket
 * subscribes to state triggers for the watched ids only, so Home Assistant
 * filters its changes rather than sending every entity's to the TV, and the
 * push keeps the cache current. read() answers from the cache only for an id
 * the confirmed subscription covers (wsSubscribed); any other read, and every
 * read while the socket is down, is a REST request. The cache is dropped with
 * the socket, as changes made while it was down never arrive.
 */
var watchedAt = {};
var cache = {};
var wsBackoffMs = WS_BACKOFF_MS;
var ws = null;
var wsAuthed = false;
var wsReconnectTimer = null;
var wsNextId = 1;
// The subscription in force, and the one asked for and not yet answered.
var wsSubscribeId = 0;
var wsSubscribed = {};
var wsPending = null;
var wsResubTimer = null;
// A change to the watched ids while a subscription is unanswered waits for
// it; a refused one is not asked again until the socket reconnects.
var wsResubAgain = false;
var wsRefused = false;
// Home Assistant's own ping, for the Connection box's response time where
// reads come from the push and no longer measure it, and to notice a
// connection that died without closing.
var WS_PING_MS = 30000;
var wsPingTimer = null;
var wsPingSentAt = 0;
var wsPingId = 0;

function init(opts) {
  opts = opts || {};
  var ha = (opts.config && opts.config.homeAssistant) || {};
  cfg = {
    enabled: ha.enabled !== false,
    url: typeof ha.url === 'string' ? ha.url.replace(/\/+$/, '') : '',
    token: typeof ha.token === 'string' ? ha.token : '',
    tlsRejectUnauthorized: ha.tlsRejectUnauthorized !== false,
    updateMode: ha.updateMode === 'polling' ? 'polling' : 'websocket'
  };
  lastStatus = { ok: null, message: '', error: '', checkedAt: 0 };
  lastLatencyMs = null;
  lastReadAt = 0;
  watchedAt = {};
  cache = {};
  wsBackoffMs = typeof opts.wsBackoffMs === 'number' ? opts.wsBackoffMs : WS_BACKOFF_MS;
  wsStop();
  applyUpdateMode();
}

function hasCredentials() {
  return !!(/^https?:\/\//i.test(cfg.url) && cfg.token);
}

function configured() {
  return !!(cfg.enabled && hasCredentials());
}

/**
 * Turns a low-level Node/OpenSSL socket failure into a clear message for logs
 * and the dashboard, hiding raw file paths and cipher/record stack strings.
 */
function formatRequestError(e, host, isHttps, verifyTls) {
  var code = /** @type {any} */ (e);
  var errCode = (code && code.code) ? String(code.code) : '';
  var errMsg = (e && e.message) ? String(e.message) : String(e || '');

  if (errCode === 'ECONNREFUSED') {
    return 'Home Assistant refused the connection at ' + host + '. Check the address and port.';
  }
  if (errCode === 'ENOTFOUND' || errCode === 'EAI_AGAIN') {
    return 'Could not find ' + host + ' on the network. Check the address.';
  }
  if (errCode === 'EHOSTUNREACH' || errCode === 'ENETUNREACH') {
    return 'Could not reach ' + host + ' on the network. Check the address and that Home Assistant is running.';
  }
  if (errCode === 'ETIMEDOUT') {
    return 'Home Assistant at ' + host + ' did not answer in time.';
  }
  if (isHttps) {
    if (/unrecognized name/i.test(errMsg)) {
      return 'The HTTPS server rejected the hostname ' + host + '. Use the domain name on its certificate, or http:// on the local network.';
    }
    if (/handshake failure|protocol version|unsupported protocol|no protocols available|no ciphers/i.test(errMsg)) {
      return 'Could not agree on an HTTPS protocol or cipher with ' + host + '. Try http:// on the local network, or allow TLS 1.2 on the proxy.';
    }
    if (/wrong version number|ssl3_get_record|packet length too long|http request/i.test(errMsg) || errCode === 'EPROTO') {
      return 'Home Assistant is not using HTTPS on this address. Try http:// instead.';
    }
    if (/socket hang up/i.test(errMsg) || errCode === 'ECONNRESET') {
      return 'Home Assistant closed the HTTPS connection. If it is not using HTTPS, try http:// instead.';
    }
    if (/^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(errCode) || /certificate|self[- ]signed|altname/i.test(errMsg)) {
      return verifyTls
        ? 'Home Assistant\'s HTTPS certificate could not be verified. For a self-signed or LAN IP certificate, turn off Verify certificate.'
        : 'Home Assistant\'s HTTPS certificate was rejected.';
    }
  } else if (/socket hang up/i.test(errMsg) || errCode === 'ECONNRESET') {
    return 'Home Assistant closed the connection unexpectedly.';
  }

  var firstLine = errMsg.split('\n')[0].replace(/:?\.\.\/openssl[^\n]*/i, '').trim();
  return firstLine ? 'Could not reach Home Assistant (' + firstLine + ').' : 'Could not reach Home Assistant.';
}

/**
 * Performs a bounded GET request against Home Assistant's REST API and parses JSON.
 */
function requestHaJson(targetUrl, token, opts, cb) {
  var maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
  var timeoutMs = (opts && opts.timeoutMs) || TIMEOUT_MS;
  var label = (opts && opts.label) || 'Home Assistant';
  var parsed = url.parse(targetUrl);
  var isHttps = parsed.protocol === 'https:';
  var lib = isHttps ? https : http;
  var verifyTls = opts && typeof opts.rejectUnauthorized === 'boolean'
    ? opts.rejectUnauthorized
    : (cfg.tlsRejectUnauthorized !== false);
  var answered = false;
  var startedAt = Date.now();

  function fail(error, tooLarge) {
    if (answered) return;
    answered = true;
    cb(tooLarge ? { ok: false, error: error, tooLarge: true } : { ok: false, error: error });
  }

  var method = (opts && opts.method) || 'GET';
  var payload = (opts && opts.body !== undefined) ? JSON.stringify(opts.body) : null;
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json'
  };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
  }

  /** @type {https.RequestOptions} */
  var reqOpts = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path,
    method: method,
    headers: headers
  };
  if (isHttps) reqOpts.rejectUnauthorized = verifyTls;

  var req = lib.request(reqOpts, function (res) {
    var chunks = [];
    var bytes = 0;
    res.on('data', function (chunk) {
      bytes += chunk.length;
      if (bytes <= maxBytes) return chunks.push(chunk);
      // Stop downloading the rest of an answer that will be refused anyway.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        fail(label + ' answered more than ' + maxBytes + ' bytes', true);
        req.abort();
      }
    });
    res.on('end', function () {
      if (answered) return;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return fail(res.statusCode === 401
          ? 'Home Assistant refused the token (401)'
          : (res.statusCode === 404 && opts && opts.entityId)
            ? 'no entity ' + opts.entityId + ' (404)'
            : 'Home Assistant answered ' + res.statusCode + (opts && opts.entityId ? ' for ' + opts.entityId : ''));
      }
      if (bytes > maxBytes) return fail(label + ' answered more than ' + maxBytes + ' bytes', true);
      var body;
      try {
        // Joined as bytes first: a character split across two chunks would
        // otherwise decode as two replacement characters.
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return fail(label + ' did not answer JSON');
      }
      answered = true;
      cb({ ok: true, body: body, ms: Date.now() - startedAt });
    });
  });

  req.setTimeout(timeoutMs, function () {
    req.abort();
    fail('Home Assistant did not answer within ' + timeoutMs + ' ms' + (opts && opts.entityId ? ' for ' + opts.entityId : ''));
  });
  req.on('error', function (e) {
    fail(formatRequestError(e, parsed.hostname, isHttps, verifyTls));
  });
  if (payload !== null) req.write(payload);
  req.end();
}

// A cache entry as read() hands it back, or null for one not yet seeded.
function fromCache(entityId) {
  var hit = cache[entityId];
  if (!hit) return null;
  return { ok: true, entity: entityId, state: hit.state, attributes: hit.attributes, updated: hit.updated };
}

// Whether read() may answer entityId from the cache rather than asking Home
// Assistant: only while the socket's subscription covers it, so the push
// keeps it current. A cache entry has to exist too; the subscription seeds one.
function cacheIsLive(entityId) {
  return cfg.updateMode === 'websocket' && wsAuthed && wsSubscribed[entityId] === true;
}

/*
 * Fetches entityId from Home Assistant directly, bypassing the cache, and
 * caches a successful answer. Shared by read()'s cache miss and the seed
 * reads once a subscription is confirmed.
 */
function fetchAndCache(entityId, cb) {
  requestHaJson(cfg.url + '/api/states/' + entityId, cfg.token, { maxBytes: MAX_BYTES, label: entityId, entityId: entityId }, function (r) {
    if (!r.ok) {
      if (!/^no entity /.test(r.error || '')) {
        lastStatus = { ok: false, message: '', error: r.error || 'Error', checkedAt: Date.now() };
      }
      return cb(r);
    }
    lastStatus = { ok: true, message: lastStatus.message || 'Connected to Home Assistant', error: '', checkedAt: Date.now() };
    lastLatencyMs = r.ms;
    lastReadAt = Date.now();
    var body = r.body;
    if (!body || typeof body.state !== 'string') return cb({ ok: false, error: entityId + ' has no state' });
    var entity = {
      ok: true,
      entity: entityId,
      state: body.state,
      attributes: body.attributes && typeof body.attributes === 'object' ? body.attributes : {},
      updated: typeof body.last_updated === 'string' ? body.last_updated : ''
    };
    // A change pushed while this request was out is newer than its answer.
    var held = cache[entityId];
    if (held && held.updated && entity.updated && held.updated > entity.updated) return cb(fromCache(entityId));
    cache[entityId] = { state: entity.state, attributes: entity.attributes, updated: entity.updated };
    cb(entity);
  });
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
      error: msg('srv.ha.notConfiguredWhere', 'Home Assistant is not configured: set it in the MQTT tab or config.json')
    });
  }
  var known = Object.prototype.hasOwnProperty.call(watchedAt, entityId);
  watchedAt[entityId] = Date.now();
  if (cacheIsLive(entityId)) {
    var hit = fromCache(entityId);
    if (hit) {
      lastReadAt = Date.now();
      return cb(hit);
    }
  }
  if (!known || (wsAuthed && !wsSubscribed[entityId])) wsScheduleResubscribe();
  fetchAndCache(entityId, cb);
}

function update(ha) {
  ha = ha || {};
  if (typeof ha.enabled === 'boolean') cfg.enabled = ha.enabled;
  if (typeof ha.url === 'string') cfg.url = ha.url.replace(/\/+$/, '');
  if (typeof ha.token === 'string') cfg.token = ha.token;
  if (typeof ha.tlsRejectUnauthorized === 'boolean') cfg.tlsRejectUnauthorized = ha.tlsRejectUnauthorized;
  if (ha.updateMode === 'websocket' || ha.updateMode === 'polling') cfg.updateMode = ha.updateMode;
  lastStatus = { ok: null, message: '', error: '', checkedAt: 0 };
  lastLatencyMs = null;
  lastReadAt = 0;
  // A new address or token: the open socket was made with the old ones.
  wsStop();
  wsBackoffMs = WS_BACKOFF_MS;
  applyUpdateMode();
}

// Drops a watched id nothing has asked for in a while, so a removed bar
// entity or an old screen saver's reading stops being pushed to. Returns
// whether any was dropped.
function forgetStaleWatches() {
  var cutoff = Date.now() - WATCH_TTL_MS;
  var dropped = false;
  for (var id in watchedAt) {
    if (watchedAt[id] < cutoff) {
      delete watchedAt[id];
      delete cache[id];
      dropped = true;
    }
  }
  return dropped;
}

function watchedIds() {
  var ids = [];
  for (var id in watchedAt) ids.push(id);
  return ids;
}

// ------------------------------------------------------------ websocket push

function bufferFromString(text) {
  var buffer = allocBuffer(Buffer.byteLength(text, 'utf8'));
  buffer.write(text, 0, buffer.length, 'utf8');
  return buffer;
}

// One client frame (text by default), masked as the protocol requires.
function encodeWsFrame(payload, opcode) {
  var length = payload.length;
  var headerLength = length < 126 ? 2 : 4;
  var frame = allocBuffer(headerLength + 4 + length);
  var mask = crypto.randomBytes(4);
  frame[0] = 0x80 | (opcode || 1);
  if (length < 126) frame[1] = 0x80 | length;
  else {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  }
  mask.copy(frame, headerLength);
  for (var i = 0; i < length; i++) frame[headerLength + 4 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

/*
 * Takes Home Assistant's own (unmasked) frames in as they arrive. onFrame
 * (opcode, payload) is called for each whole message, with a fragmented one
 * joined; it returns false once the socket is no use.
 */
function WsFrameReader(onFrame) {
  this.buffer = allocBuffer(0);
  this.fragments = [];
  this.fragmentOpcode = 0;
  this.onFrame = onFrame;
}

WsFrameReader.prototype.push = function (chunk) {
  this.buffer = Buffer.concat([this.buffer, chunk]);
  for (;;) {
    var b = this.buffer;
    if (b.length < 2) return true;
    var finalFragment = (b[0] & 0x80) !== 0;
    var opcode = b[0] & 0x0f;
    var masked = (b[1] & 0x80) !== 0;
    var length = b[1] & 0x7f;
    var offset = 2;
    if (length === 126) {
      if (b.length < 4) return true;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return true;
      if (b.readUInt32BE(2) !== 0 || b.readUInt32BE(6) > MAX_LIST_BYTES) return false;
      length = b.readUInt32BE(6);
      offset = 10;
    }
    var maskOffset = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return true;
    var payload = allocBuffer(length);
    b.copy(payload, 0, offset, offset + length);
    if (masked) for (var i = 0; i < length; i++) payload[i] ^= b[maskOffset + (i % 4)];
    this.buffer = b.slice(offset + length);
    if (opcode >= 8) {
      if (this.onFrame(opcode, payload) === false) return false;
    } else {
      if (opcode !== 0) { this.fragments = []; this.fragmentOpcode = opcode; }
      this.fragments.push(payload);
      if (finalFragment) {
        var whole = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.onFrame(this.fragmentOpcode, whole) === false) return false;
      }
    }
  }
};

function wsSend(socket, message) {
  try { socket.write(encodeWsFrame(bufferFromString(JSON.stringify(message)))); } catch (e) { /* closing anyway */ }
}

// A ping still unanswered when the next is due means the connection is gone.
function wsPing() {
  if (!ws || !wsAuthed) return;
  if (wsPingSentAt) return wsScheduleReconnect();
  if (forgetStaleWatches()) wsScheduleResubscribe();
  wsPingId = wsNextId++;
  wsPingSentAt = Date.now();
  wsSend(ws, { id: wsPingId, type: 'ping' });
}

function wsStop() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  clearInterval(wsPingTimer);
  wsPingTimer = null;
  wsPingSentAt = 0;
  wsAuthed = false;
  clearTimeout(wsResubTimer);
  wsResubTimer = null;
  wsSubscribeId = 0;
  wsSubscribed = {};
  wsPending = null;
  wsResubAgain = false;
  wsRefused = false;
  // Changes made while the socket was down never arrive, so nothing cached
  // before it is trusted after it: reads go to REST until it is back.
  cache = {};
  if (ws) {
    var socket = ws;
    ws = null;
    socket.removeAllListeners();
    try { socket.destroy(); } catch (e) {}
  }
}

function wsScheduleReconnect() {
  // error then close on the same dead socket would otherwise double the
  // backoff and schedule two reconnects for one drop.
  if (wsReconnectTimer) return;
  wsStop();
  if (cfg.updateMode !== 'websocket' || !configured()) return;
  wsReconnectTimer = setTimeout(wsConnect, wsBackoffMs);
  if (wsReconnectTimer.unref) wsReconnectTimer.unref();
  wsBackoffMs = Math.min(wsBackoffMs * 2, WS_MAX_BACKOFF_MS);
}

/*
 * Subscribes to a state trigger for every watched id, so Home Assistant sends
 * a change to one of those (its state or any attribute) and nothing else. The
 * new subscription is asked for before the old one is dropped, so no change
 * falls between them. subscribe_trigger is in Home Assistant's documented
 * WebSocket API; "platform" is accepted by every version that has it.
 */
function wsResubscribe() {
  wsResubTimer = null;
  if (!ws || !wsAuthed || wsRefused) return;
  if (wsPending) { wsResubAgain = true; return; }
  forgetStaleWatches();
  var ids = watchedIds();
  var old = wsSubscribeId;
  if (!ids.length) {
    if (old) wsSend(ws, { id: wsNextId++, type: 'unsubscribe_events', subscription: old });
    wsSubscribeId = 0;
    wsSubscribed = {};
    wsPending = null;
    return;
  }
  var id = wsNextId++;
  wsPending = { id: id, ids: ids, old: old };
  wsSend(ws, { id: id, type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: ids } });
}

function wsScheduleResubscribe() {
  if (!ws || !wsAuthed || wsRefused || wsResubTimer) return;
  wsResubTimer = setTimeout(wsResubscribe, RESUBSCRIBE_MS);
  if (wsResubTimer.unref) wsResubTimer.unref();
}

// Home Assistant's answer to a subscribe_trigger.
function wsSubscribeResult(message) {
  var pending = wsPending;
  wsPending = null;
  var again = wsResubAgain;
  wsResubAgain = false;
  if (!message.success) {
    var why = message.error && message.error.message ? message.error.message : 'no reason given';
    console.error('haentity: Home Assistant refused the state subscription (' + why + '); reads stay with REST');
    wsRefused = true;
    return;
  }
  if (again) wsScheduleResubscribe();
  var was = wsSubscribed;
  wsSubscribeId = pending.id;
  wsSubscribed = {};
  for (var i = 0; i < pending.ids.length; i++) wsSubscribed[pending.ids[i]] = true;
  if (pending.old) wsSend(ws, { id: wsNextId++, type: 'unsubscribe_events', subscription: pending.old });
  // An id read over REST before it was covered may have changed since:
  // read once more, now that a later change will be pushed.
  for (var j = 0; j < pending.ids.length; j++) {
    if (!was[pending.ids[j]]) fetchAndCache(pending.ids[j], function () {});
  }
}

// cache[entity_id] from a state trigger's to_state, for a watched id.
function wsHandleEvent(message) {
  var trigger = message && message.event && message.event.variables && message.event.variables.trigger;
  var entityId = trigger && trigger.entity_id;
  if (typeof entityId !== 'string' || !Object.prototype.hasOwnProperty.call(watchedAt, entityId)) return;
  var newState = trigger.to_state;
  if (!newState || typeof newState.state !== 'string') { delete cache[entityId]; return; }
  cache[entityId] = {
    state: newState.state,
    attributes: newState.attributes && typeof newState.attributes === 'object' ? newState.attributes : {},
    updated: typeof newState.last_updated === 'string' ? newState.last_updated : ''
  };
}

function wsConnect() {
  wsReconnectTimer = null;
  if (cfg.updateMode !== 'websocket' || !configured() || ws) return;
  var parsed = url.parse(cfg.url);
  var isHttps = parsed.protocol === 'https:';
  var lib = isHttps ? https : http;
  /** @type {https.RequestOptions} */
  var reqOpts = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    // Behind a reverse proxy at a path, as the REST calls are (cfg.url + '/api/...').
    path: (parsed.pathname || '').replace(/\/+$/, '') + '/api/websocket',
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64')
    },
    agent: false
  };
  if (isHttps) reqOpts.rejectUnauthorized = cfg.tlsRejectUnauthorized !== false;
  var openedUrl = cfg.url;
  var req = lib.request(reqOpts);
  req.on('upgrade', function (res, socket, head) {
    if (cfg.updateMode !== 'websocket' || cfg.url !== openedUrl) return socket.destroy();
    ws = socket;
    var reader = new WsFrameReader(function (opcode, payload) {
      // A protocol ping is answered with a pong frame carrying its payload,
      // or the server's heartbeat closes the connection.
      if (opcode === 9) { try { ws.write(encodeWsFrame(payload, 10)); } catch (e) {} return true; }
      if (opcode === 8) { wsScheduleReconnect(); return false; }
      if (opcode !== 1) return true;
      var message = null;
      try { message = JSON.parse(payload.toString('utf8')); } catch (e) { return true; }
      if (message.type === 'auth_required') {
        wsSend(ws, { type: 'auth', access_token: cfg.token });
      } else if (message.type === 'auth_ok') {
        wsAuthed = true;
        wsBackoffMs = WS_BACKOFF_MS;
        wsResubscribe();
        wsPing();
        clearInterval(wsPingTimer);
        wsPingTimer = setInterval(wsPing, WS_PING_MS);
        if (wsPingTimer.unref) wsPingTimer.unref();
      } else if (message.type === 'pong' && message.id === wsPingId && wsPingSentAt) {
        lastLatencyMs = Date.now() - wsPingSentAt;
        wsPingSentAt = 0;
        lastStatus = { ok: true, message: lastStatus.message || 'Connected to Home Assistant', error: '', checkedAt: Date.now() };
      } else if (message.type === 'auth_invalid') {
        console.error('haentity: Home Assistant refused the websocket token');
        wsScheduleReconnect();
        return false;
      } else if (message.type === 'result' && wsPending && message.id === wsPending.id) {
        wsSubscribeResult(message);
      } else if (message.type === 'event') {
        wsHandleEvent(message);
      }
      return true;
    });
    socket.on('data', function (chunk) { reader.push(chunk); });
    socket.on('error', wsScheduleReconnect);
    socket.on('close', wsScheduleReconnect);
    // Bytes the server wrote right after its 101 response can arrive in the
    // same packet, already consumed by the HTTP parser rather than left for
    // a 'data' event.
    if (head && head.length) reader.push(head);
  });
  req.on('response', function (res) { res.resume(); wsScheduleReconnect(); });
  req.on('error', wsScheduleReconnect);
  req.end();
}

// Opens the socket where cfg.updateMode wants it, or closes it.
function applyUpdateMode() {
  if (cfg.updateMode === 'websocket' && configured()) { if (!ws && !wsReconnectTimer) wsConnect(); }
  else wsStop();
}

function test(opts, cb) {
  cb = cb || function () {};
  opts = opts || {};
  var testUrl = typeof opts.url === 'string' && opts.url ? opts.url.replace(/\/+$/, '') : cfg.url;
  // The saved token goes only to the saved address: a test of another one
  // brings its own, or the token would be handed to whatever address is named.
  var testToken = (typeof opts.token === 'string' && opts.token) ? opts.token
    : testUrl === cfg.url ? cfg.token : '';
  var testVerify = typeof opts.tlsRejectUnauthorized === 'boolean'
    ? opts.tlsRejectUnauthorized
    : (cfg.tlsRejectUnauthorized !== false);

  if (!/^https?:\/\//i.test(testUrl)) {
    return cb({ ok: false, error: 'URL must start with http:// or https://' });
  }
  if (!testToken) {
    return cb({ ok: false, error: cfg.token && testUrl !== cfg.url
      ? 'Enter the token to test an address other than the saved one'
      : 'A Long-Lived Access Token is required' });
  }

  requestHaJson(testUrl + '/api/', testToken, { maxBytes: MAX_BYTES, label: 'Home Assistant', rejectUnauthorized: testVerify }, function (r) {
    if (!r.ok) {
      if (cfg.enabled && testUrl === cfg.url) {
        lastStatus = { ok: false, message: '', error: r.error || 'Connection failed', checkedAt: Date.now() };
      }
      return cb(r);
    }
    var body = r.body;
    var okMsg = (body && body.message) || 'Connected to Home Assistant';
    if (cfg.enabled && testUrl === cfg.url) {
      lastStatus = { ok: true, message: okMsg, error: '', checkedAt: Date.now() };
      lastLatencyMs = r.ms;
    }
    cb({ ok: true, message: okMsg });
  });
}

function status() {
  var st = !cfg.enabled ? 'disabled'
    : !hasCredentials() ? 'unconfigured'
    : lastStatus.ok === true ? 'connected'
    : lastStatus.ok === false ? 'error'
    : 'unknown';
  return {
    enabled: cfg.enabled,
    configured: configured(),
    hasCredentials: hasCredentials(),
    state: st,
    error: lastStatus.error || '',
    message: lastStatus.message || '',
    checkedAt: lastStatus.checkedAt || null,
    latencyMs: st === 'connected' ? lastLatencyMs : null,
    // How long ago a screen saver last read an entity, as the MQTT box's last publish.
    lastReadMs: lastReadAt ? Date.now() - lastReadAt : null,
    updateMode: cfg.updateMode,
    // Only meaningful in websocket mode: whether Home Assistant is pushing
    // state changes right now, or a request/reconnect is still in flight.
    wsConnected: cfg.updateMode === 'websocket' ? wsAuthed : null
  };
}

/**
 * Fetches available entities (id, friendly name, unit) from Home Assistant without states.
 */
function list(cb) {
  cb = cb || function () {};
  if (!configured()) {
    return cb({ ok: false, error: msg('srv.ha.notConfigured', 'Home Assistant is not configured') });
  }
  requestHaJson(cfg.url + '/api/states', cfg.token, { maxBytes: MAX_LIST_BYTES, timeoutMs: LIST_TIMEOUT_MS, label: 'Home Assistant' }, function (r) {
    if (r.tooLarge) {
      // Home Assistant answered, so the connection is fine: only the picker is lost.
      return cb({ ok: false, error: msg('srv.ha.tooManyEntities',
        'Home Assistant has more entities than the TV can list (over {mb} MB): type entity IDs instead, such as sensor.outdoor_temperature',
        { mb: MAX_LIST_BYTES / 1024 / 1024 }) });
    }
    if (!r.ok) {
      lastStatus = { ok: false, message: '', error: r.error || 'Error', checkedAt: Date.now() };
      return cb(r);
    }
    if (!Array.isArray(r.body)) {
      lastStatus = { ok: false, message: '', error: msg('srv.ha.noEntityList', 'Home Assistant did not return an entity list'), checkedAt: Date.now() };
      return cb({ ok: false, error: msg('srv.ha.noEntityList', 'Home Assistant did not return an entity list') });
    }
    lastStatus = { ok: true, message: lastStatus.message || 'API running.', error: '', checkedAt: Date.now() };
    lastLatencyMs = r.ms;
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

/*
 * readMany(ids, cb) - cb({ ok, entities: { id: { state, attributes,
 * updated } }, errors: { id: message } }). One request per entity, all in
 * flight together: a saver asking for eight values should wait for the
 * slowest, not for eight timeouts in turn.
 */
function readMany(ids, cb) {
  cb = cb || function () {};
  var out = {};
  var errors = {};
  var left = ids.length;
  if (!left) return cb({ ok: true, entities: out, errors: errors });
  for (var i = 0; i < ids.length; i++) {
    (function (id) {
      read(id, function (r) {
        if (r.ok) {
          out[id] = { state: r.state, attributes: r.attributes, updated: r.updated };
        } else {
          errors[id] = r.error || 'Home Assistant did not answer';
        }
        if (--left === 0) cb({ ok: true, entities: out, errors: errors });
      });
    })(ids[i]);
  }
}

/**
 * Calls a Home Assistant service (POST /api/services/<domain>/<service>).
 */
function callService(domain, service, data, cb) {
  cb = cb || function () {};
  domain = String(domain || '');
  service = String(service || '');
  if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) {
    return cb({ ok: false, error: 'not a service name: ' + domain + '.' + service });
  }
  if (!configured()) {
    return cb({
      ok: false,
      error: msg('srv.ha.notConfiguredWhere', 'Home Assistant is not configured: set it in the MQTT tab or config.json')
    });
  }
  var label = domain + '.' + service;
  requestHaJson(cfg.url + '/api/services/' + domain + '/' + service, cfg.token, {
    method: 'POST',
    body: data && typeof data === 'object' ? data : {},
    maxBytes: MAX_LIST_BYTES,
    timeoutMs: TIMEOUT_MS,
    label: label
  }, function (r) {
    if (!r.ok) {
      lastStatus = { ok: false, message: '', error: r.error || 'Error', checkedAt: Date.now() };
      return cb(r);
    }
    // Not the link's response time: a service call answers once the device
    // has acted, about a second for a light behind a PLC against 10 to 20 ms
    // for a read, so it would read as a slow connection.
    lastStatus = { ok: true, message: lastStatus.message || 'Connected to Home Assistant', error: '', checkedAt: Date.now() };
    cb({ ok: true, changed: Array.isArray(r.body) ? r.body : [] });
  });
}

module.exports = {
  init: init,
  read: read,
  readMany: readMany,
  list: list,
  callService: callService,
  configured: configured,
  hasCredentials: hasCredentials,
  update: update,
  test: test,
  status: status
};
