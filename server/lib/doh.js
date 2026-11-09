/*
 * lib/doh.js - a DNS server on the TV that sends each query on over HTTPS
 *
 * An app's resolver (glibc in its jail) speaks plain DNS to the addresses in
 * its resolv.conf, on port 53, with no TLS. For an app given a DNS-over-HTTPS
 * address, lib/appdns names a loopback address served here instead, and each
 * query is posted to the DNS-over-HTTPS address (RFC 8484,
 * application/dns-message) and its answer sent back. glibc does not ask with
 * EDNS, so a UDP answer over 512 bytes goes back cut short with TC set, and
 * glibc asks again over TCP, which is served too.
 *
 * Node's own TLS is used, with the TV's CA bundle where it has one: lib/fetch
 * goes through curl because node 0.12 (webOS 4) cannot speak the TLS most
 * servers now require, and there these lookups fail. The last error for each
 * address is kept for the dashboard.
 *
 * Strict ES5: runs on node 0.12.
 */
var dgram = require('dgram');
var fs = require('fs');
var https = require('https');
var net = require('net');
var urlMod = require('url');
var util = require('./util');

var CA_FILES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/certs/ca-bundle.crt'];
var UDP_MAX = 512;
var TIMEOUT_MS = 5000;
// A TCP connection that sends nothing more is closed after this.
var IDLE_MS = 10000;

var postFn = httpsPost;
var timeoutMs = TIMEOUT_MS;
var port = 53;
var listeners = {};  // address -> { url, udp, tcp, error, answered, failed }

function init(opts) {
  opts = opts || {};
  postFn = opts.post || httpsPost;
  if (opts.timeoutMs) timeoutMs = opts.timeoutMs;
  if (opts.port) port = opts.port;
}

var agent = null;
var caBundle;
function systemCa() {
  if (caBundle !== undefined) return caBundle;
  caBundle = null;
  for (var i = 0; i < CA_FILES.length && !caBundle; i++) {
    try { caBundle = fs.readFileSync(CA_FILES[i]); } catch (e) { /* next */ }
  }
  return caBundle;
}

// cb(err, answer) for one query, posted to url.
function httpsPost(url, query, cb) {
  var u = urlMod.parse(url);
  if (!agent) agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  var opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 443,
    path: u.path || '/',
    agent: agent,
    headers: {
      'Content-Type': 'application/dns-message',
      'Accept': 'application/dns-message',
      'Content-Length': query.length
    }
  };
  var ca = systemCa();
  if (ca) opts.ca = ca;
  var done = false;
  function finish(err, body) {
    if (done) return;
    done = true;
    cb(err, body);
  }
  var req = https.request(opts, function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () {
      if (res.statusCode !== 200) return finish(new Error('HTTP ' + res.statusCode));
      finish(null, Buffer.concat(chunks));
    });
    res.on('error', finish);
  });
  req.setTimeout(timeoutMs, function () {
    req.abort();
    finish(new Error('no answer in ' + Math.round(timeoutMs / 1000) + ' s'));
  });
  req.on('error', finish);
  req.end(query);
}

// Where the question ends, or -1 for a query too short or malformed to answer.
function questionEnd(q) {
  if (q.length < 12) return -1;
  var i = 12;
  while (i < q.length && q[i] !== 0) {
    if ((q[i] & 0xc0) !== 0) return -1;
    i += q[i] + 1;
  }
  i += 5;
  return i <= q.length ? i : -1;
}

/*
 * An answer with no records, made from the query's header and question: with
 * TC set to send glibc to TCP, or with an error code (2 is SERVFAIL).
 */
function emptyAnswer(query, tc, rcode) {
  var end = questionEnd(query);
  if (end < 0) return null;
  var out = util.allocBuffer(end);
  query.copy(out, 0, 0, end);
  out[2] = (query[2] & 0x79) | 0x80 | (tc ? 0x02 : 0);
  out[3] = 0x80 | (rcode & 0x0f);
  out.writeUInt16BE(1, 4);
  out.writeUInt16BE(0, 6);
  out.writeUInt16BE(0, 8);
  out.writeUInt16BE(0, 10);
  return out;
}

/*
 * cb(answer) for one query, or cb(null) for one not worth answering. The ID
 * goes over HTTPS as 0, as RFC 8484 asks so caches can share answers, and the
 * query's own is put back.
 */
function answer(entry, query, cb) {
  if (questionEnd(query) < 0) return cb(null);
  var id = query.readUInt16BE(0);
  var sent = util.allocBuffer(query.length);
  query.copy(sent);
  sent.writeUInt16BE(0, 0);
  postFn(entry.url, sent, function (err, body) {
    if (err || !body || body.length < 12) {
      entry.failed++;
      entry.error = err ? err.message : 'an empty answer';
      return cb(emptyAnswer(query, false, 2));
    }
    entry.answered++;
    entry.error = null;
    body.writeUInt16BE(id, 0);
    cb(body);
  });
}

function serveUdp(address, entry, cb) {
  var sock = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
  var bound = false;
  sock.on('message', function (msg, from) {
    answer(entry, msg, function (reply) {
      if (!reply) return;
      if (reply.length > UDP_MAX) reply = emptyAnswer(msg, true, 0);
      if (reply) sock.send(reply, 0, reply.length, from.port, from.address);
    });
  });
  sock.on('error', function (err) {
    if (!bound) return cb(err);
    entry.error = err.message;
  });
  sock.bind(port, address, function () { bound = true; cb(null); });
  entry.udp = sock;
}

// Each message over TCP comes with its length in two bytes before it.
function serveTcp(address, entry, cb) {
  var server = net.createServer(function (conn) {
    var buf = util.allocBuffer(0);
    conn.setTimeout(IDLE_MS, function () { conn.destroy(); });
    conn.on('error', function () { conn.destroy(); });
    conn.on('data', function (d) {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        var len = buf.readUInt16BE(0);
        var query = buf.slice(2, 2 + len);
        buf = buf.slice(2 + len);
        answer(entry, query, function (reply) {
          if (!reply || conn.destroyed) return;
          var head = util.allocBuffer(2);
          head.writeUInt16BE(reply.length, 0);
          conn.write(Buffer.concat([head, reply]));
        });
      }
    });
  });
  var listening = false;
  server.on('error', function (err) {
    if (!listening) return cb(err);
    entry.error = err.message;
  });
  server.listen(port, address, function () { listening = true; cb(null); });
  entry.tcp = server;
}

function close(address) {
  var e = listeners[address];
  if (!e) return;
  try { if (e.udp) e.udp.close(); } catch (err) { /* already closed */ }
  try { if (e.tcp) e.tcp.close(); } catch (err) { /* already closed */ }
  delete listeners[address];
}

/*
 * Serves exactly the addresses in map ({ address: url }): starts the new ones,
 * points one that stays at its url, and closes the rest. cb({ address: error })
 * for those that could not start.
 */
function serve(map, cb) {
  cb = cb || function () {};
  Object.keys(listeners).forEach(function (a) { if (!map.hasOwnProperty(a)) close(a); });
  var failed = {};
  var todo = Object.keys(map).filter(function (a) {
    if (listeners[a]) { listeners[a].url = map[a]; return false; }
    return true;
  });
  var left = todo.length;
  if (!left) return cb(failed);
  todo.forEach(function (a) {
    var entry = { url: map[a], udp: null, tcp: null, error: null, answered: 0, failed: 0 };
    listeners[a] = entry;
    serveUdp(a, entry, function (err) {
      if (err) return started(a, err);
      serveTcp(a, entry, function (err2) { started(a, err2); });
    });
  });
  function started(a, err) {
    if (err) {
      failed[a] = err.message;
      listeners[a].error = err.message;
      console.error('doh: could not answer on ' + a + ': ' + err.message);
    } else {
      console.log('doh: answering on ' + a + ' for ' + listeners[a].url);
    }
    if (--left === 0) cb(failed);
  }
}

function stop() {
  Object.keys(listeners).forEach(close);
}

// { address: { url, error, answered, failed } }
function status() {
  var out = {};
  Object.keys(listeners).forEach(function (a) {
    var e = listeners[a];
    out[a] = { url: e.url, error: e.error, answered: e.answered, failed: e.failed };
  });
  return out;
}

module.exports = {
  init: init,
  serve: serve,
  stop: stop,
  status: status,
  emptyAnswer: emptyAnswer,
  questionEnd: questionEnd
};
