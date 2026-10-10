'use strict';
/*
 * Sets the TV's clock from an NTP server, as an SNTP client (RFC 4330). Off
 * until config.ntp.server is set.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * The time service registers no "ntp" source, so each result goes to
 * clock/setTime as an "sdp" time, which sets the clock, the service's source
 * and timeValid as LG's own sync does. Setting the kernel clock directly
 * leaves the source and timeValid unchanged.
 */
var dgram = require('dgram');
var dns = require('dns');
var monotonicMs = require('./util').monotonicMs;
var allocBuffer = require('./util').allocBuffer;

var NTP_PORT = 123;
var PACKET_BYTES = 48;
// Where each timestamp sits in a packet.
var ORIGINATE = 24;
var RECEIVE = 32;
var TRANSMIT = 40;
// Seconds from 1900-01-01, where NTP counts from, to 1970-01-01.
var NTP_UNIX_OFFSET = 2208988800;

// Hourly once synced. Until then, and after a failure, every 30 seconds.
var RESYNC_MS = 3600000;
var RETRY_MS = 30000;
var REPLY_TIMEOUT_MS = 2000;
// An answer with a longer round trip is too uncertain to set the clock from.
var MAX_ROUND_TRIP_MS = 1000;
// clock/setTime takes whole seconds, so a smaller error is left alone.
var MIN_STEP_MS = 1000;
// No release is older than this, so an earlier answer is wrong.
var CLOCK_FLOOR_MS = Date.UTC(2026, 0, 1);

/**
 * One answer from the server.
 * @typedef {Object} Answer
 * @property {number} at the server's time when the answer came, Unix milliseconds
 * @property {number} atMono the TV's monotonic time when the answer came
 * @property {number} offsetMs the server's time less the TV's
 * @property {number} roundTripMs the round trip, less the server's own time to answer
 * @property {number} stratum the server's stratum
 */

var config = null;
/** @type {function(string, Object, function(any): void): void} */
var luna = null;
var settings = null;

var timer = null;
// From a sync's query until the time service has answered its set.
var busy = false;
var errorState = null;
// Bumped by each start and stop, so a callback from before one is ignored.
var generation = 0;

// Whether this start has set the clock yet.
var appliedOnce = false;
/** @type {?Answer} */
var lastAnswer = null;
// Clocks set and syncs that failed since start, or null while off.
var counters = null;

/*
 * config.ntp as used, or null while no server is set.
 * @param {any} conf the server's config
 */
function readSettings(conf) {
  var n = (conf && conf.ntp) || {};
  var server = typeof n.server === 'string' ? n.server.trim() : '';
  if (!server) return null;
  var port = parseInt(n.port, 10);
  if (!(port >= 1 && port <= 65535)) port = NTP_PORT;
  return { server: server, port: port };
}

/**
 * An NTP timestamp, 8 bytes at off, as Unix milliseconds. Seconds below 2^31
 * are taken as era 1, from 2036-02-07 on (RFC 4330 section 3).
 * @param {Buffer} buf
 * @param {number} off
 * @returns {number}
 */
function readTimestamp(buf, off) {
  var sec = buf.readUInt32BE(off);
  var frac = buf.readUInt32BE(off + 4);
  if (sec < 0x80000000) sec += 0x100000000;
  return (sec - NTP_UNIX_OFFSET) * 1000 + frac / 0x100000000 * 1000;
}

/**
 * Writes Unix milliseconds as an NTP timestamp, 8 bytes at off.
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} ms
 */
function writeTimestamp(buf, off, ms) {
  var sec = Math.floor(ms / 1000);
  var frac = Math.floor((ms - sec * 1000) / 1000 * 0x100000000);
  buf.writeUInt32BE((sec + NTP_UNIX_OFFSET) % 0x100000000, off);
  buf.writeUInt32BE(frac, off + 4);
}

/**
 * A client request: LI 0, version 4, mode 3, and the transmit timestamp the
 * reply must echo as its originate timestamp. Its low 16 bits, about 15
 * microseconds, are random, so a reply cannot be forged from the time alone
 * (RFC 5905 section 9.1).
 * @param {number} nowMs
 * @returns {Buffer}
 */
function buildRequest(nowMs) {
  var buf = allocBuffer(PACKET_BYTES);
  buf[0] = (0 << 6) | (4 << 3) | 3;
  writeTimestamp(buf, TRANSMIT, nowMs);
  buf[TRANSMIT + 6] = Math.floor(Math.random() * 256);
  buf[TRANSMIT + 7] = Math.floor(Math.random() * 256);
  return buf;
}

/**
 * Whether reply echoes request's transmit timestamp, so answers it.
 * @param {Buffer} reply
 * @param {Buffer} request
 * @returns {boolean}
 */
function answersRequest(reply, request) {
  if (reply.length < PACKET_BYTES) return false;
  var originate = reply.slice(ORIGINATE, ORIGINATE + 8);
  return originate.equals(request.slice(TRANSMIT, TRANSMIT + 8));
}

/**
 * Why a reply is not from a synchronised server, or null if it is.
 * Stratum 0 is a kiss-of-death, and LI 3 an unsynchronised server.
 * @param {Buffer} reply
 * @returns {?string}
 */
function rejectReason(reply) {
  var leap = reply[0] >> 6;
  var mode = reply[0] & 7;
  var stratum = reply[1];
  if (mode !== 4) return 'not a server reply (mode ' + mode + ')';
  if (stratum < 1 || stratum > 15) return 'server not synchronised (stratum ' + stratum + ')';
  if (leap === 3) return 'server not synchronised (leap indicator 3)';
  if (reply.readUInt32BE(TRANSMIT) === 0 && reply.readUInt32BE(TRANSMIT + 4) === 0) {
    return 'reply has no transmit time';
  }
  return null;
}

/**
 * The answer in a reply known to answer this request, or why it is not used.
 *
 * Names follow RFC 4330 section 5: T1 the request leaving the TV, T2 it
 * reaching the server, T3 the reply leaving the server, T4 it reaching the TV.
 * T1 and T4 are on the TV's clock, T2 and T3 on the server's.
 * @param {Buffer} reply
 * @param {number} t1 Unix milliseconds
 * @param {number} t4 Unix milliseconds
 * @param {number} t4Mono the TV's monotonic time at T4
 * @returns {{answer?: Answer, error?: string}}
 */
function parseReply(reply, t1, t4, t4Mono) {
  var reason = rejectReason(reply);
  if (reason) return { error: reason };

  var t2 = readTimestamp(reply, RECEIVE);
  var t3 = readTimestamp(reply, TRANSMIT);
  var offsetMs = ((t2 - t1) + (t3 - t4)) / 2;
  var roundTripMs = (t4 - t1) - (t3 - t2);
  var serverMs = t4 + offsetMs;

  if (roundTripMs > MAX_ROUND_TRIP_MS) {
    return { error: 'round trip too long (' + Math.round(roundTripMs) + ' ms)' };
  }
  if (serverMs < CLOCK_FLOOR_MS) {
    return { error: 'server time ' + new Date(serverMs).toISOString() + ' is before 2026' };
  }
  return {
    answer: {
      at: serverMs,
      atMono: t4Mono,
      offsetMs: offsetMs,
      // Negative when the server reports more time answering (T3 - T2) than
      // the whole round trip took on the TV's clock.
      roundTripMs: Math.max(0, roundTripMs),
      stratum: reply[1]
    }
  };
}

// One line when the error changes, not one per failed query.
function setError(text) {
  if (text === errorState) return;
  var had = errorState;
  errorState = text;
  if (text) console.error('ntp: ' + text);
  else if (had) console.log('ntp: syncing with ' + settings.server + ' again');
}

/*
 * Asks the server for the time. cb gets {answer} or {error}.
 */
function query(cb) {
  dns.lookup(settings.server, function (err, address, family) {
    if (err) return cb({ error: 'could not resolve ' + settings.server + ': ' + err.message });
    exchange(address, family, cb);
  });
}

/*
 * Sends one request to address and waits for the reply that answers it.
 *
 * A packet that is not that reply is ignored and the wait goes on. The
 * sender's address is not compared: dns.lookup gives an IPv6 literal as
 * written, and rinfo in its canonical form.
 *
 * T4 is the wall clock at sending plus the monotonic time since, so a step of
 * the clock while waiting does not count.
 */
function exchange(address, family, cb) {
  var sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  var sentAt = Date.now();
  var sentMono = monotonicMs();
  var request = buildRequest(sentAt);
  var timeout = setTimeout(onTimeout, REPLY_TIMEOUT_MS);
  var finished = false;

  sock.on('message', onMessage);
  sock.on('error', onError);
  sock.send(request, 0, request.length, settings.port, address, onSent);

  function onMessage(msg, rinfo) {
    if (rinfo.port !== settings.port || !answersRequest(msg, request)) return;
    var mono = monotonicMs();
    finish(parseReply(msg, sentAt, sentAt + (mono - sentMono), mono));
  }

  function onSent(err) {
    if (err) finish({ error: 'could not send to ' + settings.server + ': ' + err.message });
  }

  function onError(err) {
    finish({ error: 'socket error: ' + err.message });
  }

  function onTimeout() {
    finish({ error: 'no answer from ' + settings.server + ' in ' + REPLY_TIMEOUT_MS + ' ms' });
  }

  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try { sock.close(); } catch (e) {}
    cb(result);
  }
}

/**
 * clock/setTime's arguments for answer. The service adds the time since
 * timestamp to utc, so a call that waited in the luna queue does not set the
 * clock behind. Both use CLOCK_MONOTONIC.
 * @param {Answer} answer
 */
function setTimePayload(answer) {
  var sec = Math.floor(answer.atMono / 1000);
  var nsec = Math.round((answer.atMono - sec * 1000) * 1e6);
  return {
    utc: Math.round(answer.at / 1000),
    source: 'sdp',
    available: true,
    timestamp: { source: 'monotonic', sec: sec, nsec: nsec }
  };
}

function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(function () { timer = null; sync(); }, ms);
  if (timer.unref) timer.unref();
}

function syncFailed(text) {
  counters.errors++;
  setError(text);
  schedule(RETRY_MS);
}

// The first answer of a start always, so the service's source and timeValid
// follow it; after that only an error of a second or more.
function needsSetting(answer) {
  return !appliedOnce || Math.abs(answer.offsetMs) >= MIN_STEP_MS;
}

function formatOffset(ms) {
  return (ms >= 0 ? '+' : '') + (ms / 1000).toFixed(3) + ' s';
}

// Hands answer to the time service. done is called once it has answered.
function setClock(answer, gen, done) {
  var payload = setTimePayload(answer);
  luna('com.webos.service.systemservice/clock/setTime', payload, function (res) {
    if (gen !== generation) return done();
    busy = false;
    // The luna wrapper gives null when luna-send timed out or printed no JSON.
    if (!res) {
      syncFailed('the time service did not answer');
      return done();
    }
    if (res.returnValue !== true) {
      syncFailed('the time service refused the time: ' + JSON.stringify(res));
      return done();
    }
    setError(null);
    appliedOnce = true;
    counters.sets++;
    console.log('ntp: set the clock from ' + settings.server +
                ' (stratum ' + answer.stratum + '), ' + formatOffset(answer.offsetMs));
    schedule(RESYNC_MS);
    done();
  });
}

/**
 * Asks the server for the time, sets the clock if it needs it, and schedules
 * the next sync. Does nothing while off or while another sync is under way:
 * one that measured the clock before a pending set took would set it again.
 * @param {function(): void} [done] called once the sync has finished
 */
function sync(done) {
  done = done || function () {};
  if (!settings || busy) return done();
  busy = true;
  var gen = generation;

  query(function (r) {
    // A stop or start since the query began has reset everything.
    if (gen !== generation) return done();

    if (r.error) {
      busy = false;
      syncFailed(r.error);
      return done();
    }
    lastAnswer = r.answer;
    if (needsSetting(r.answer)) return setClock(r.answer, gen, done);

    busy = false;
    setError(null);
    schedule(RESYNC_MS);
    done();
  });
}

/**
 * @param {Object} opts
 * @param {any} opts.config the server's config, read at start()
 * @param {function(string, Object, function(any): void): void} opts.luna
 */
function init(opts) {
  config = opts.config;
  luna = opts.luna;
}

/**
 * Starts syncing when a server is set. Changed settings take effect at the
 * server's next start.
 * @param {function(): void} [done] called once the first sync has finished,
 *   when it started
 * @returns {boolean} whether it started
 */
function start(done) {
  stop();
  settings = readSettings(config);
  if (!settings) return false;
  counters = { sets: 0, errors: 0 };
  console.log('ntp: setting the clock from ' + settings.server +
              (settings.port !== NTP_PORT ? ':' + settings.port : ''));
  sync(done);
  return true;
}

function stop() {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  settings = null;
  busy = false;
  errorState = null;
  appliedOnce = false;
  lastAnswer = null;
  counters = null;
}

/**
 * Clocks set and syncs that failed since start, and the last answer, null
 * before one. Null while off.
 * @returns {?{sets: number, errors: number, last: ?Answer}}
 */
function getStatus() {
  if (!counters) return null;
  return { sets: counters.sets, errors: counters.errors, last: lastAnswer };
}

module.exports = {
  init: init,
  start: start,
  stop: stop,
  sync: sync,
  getStatus: getStatus,
  readSettings: readSettings,
  buildRequest: buildRequest,
  answersRequest: answersRequest,
  parseReply: parseReply,
  readTimestamp: readTimestamp,
  writeTimestamp: writeTimestamp,
  setTimePayload: setTimePayload,
  CLOCK_FLOOR_MS: CLOCK_FLOOR_MS
};
