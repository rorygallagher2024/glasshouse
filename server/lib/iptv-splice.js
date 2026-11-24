/*
 * Joins an MPEG-TS stream across the provider's reconnects, for the Internet
 * TV relay (lib/iptv relayStream).
 *
 * A provider seen closing a channel's connection after a burst of 14 MB in
 * 1.4 s, and opening the next one with a burst of the same few seconds again.
 * Reconnected, the relay goes on in the same response, and this keeps the
 * player from seeing the join: per elementary stream, a PES whose timestamp is
 * not after the last one passed on is dropped, so the repeat is cut where the
 * last connection stopped; and each stream's latest PES is held until the
 * next one starts, so a PES a closed connection cut short is dropped
 * (restart()) and comes whole from the next.
 *
 * A step back of more than a minute is the provider starting the channel again,
 * from new timestamps: restarted is set, for the relay to end the response,
 * since a player discards what comes before the timestamps it started from.
 *
 * Packets other than an elementary stream's (PAT, PMT, SDT, PCR-only) pass at
 * once. Holding one PES per stream (a frame of video) reorders packets across
 * streams by at most that, which a demuxer separating them by PID does not see.
 *
 * Strict ES5 for Node 0.12 on webOS 4.
 */
'use strict';

var PACKET = 188;
var SYNC = 0x47;
// Timestamps are 33-bit, in 90 kHz ticks.
var WRAP = 8589934592;
var HALF = WRAP / 2;
// Further back than this, a timestamp starts the stream again rather than repeats it.
var RESET_TICKS = 60 * 90000;
// Bound a single held PES so a stream without PUSI packets cannot grow without limit.
var MAX_PES_PACKETS = 2000;

function Splice() {
  this.carry = null;
  this.pmtPid = -1;
  // pid -> { packets, ts, keep, last }
  this.streams = {};
  this.restarted = false;
}

// The connection closed: what it left unfinished is dropped.
Splice.prototype.restart = function () {
  this.carry = null;
  var streams = this.streams;
  Object.keys(streams).forEach(function (pid) {
    streams[pid].packets = [];
    streams[pid].keep = false;
  });
};

// Bytes from the connection in; the bytes to pass on out (possibly empty).
Splice.prototype.feed = function (chunk) {
  var data = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
  this.carry = null;
  var out = [], i = alignment(data, 0);
  while (i >= 0 && i + PACKET <= data.length) {
    if (data[i] !== SYNC) {
      i = alignment(data, i + 1);
      continue;
    }
    this.packet(data.slice(i, i + PACKET), out);
    i += PACKET;
  }
  if (i >= 0 && i < data.length) this.carry = data.slice(i);
  return out.length ? Buffer.concat(out) : null;
};

Splice.prototype.packet = function (p, out) {
  var pid = ((p[1] & 0x1f) << 8) | p[2], start = (p[1] & 0x40) !== 0;
  var payload = payloadAt(p);
  if (pid === 0 && start && payload > 0) this.readPat(p, payload);
  else if (pid === this.pmtPid && start && payload > 0) this.readPmt(p, payload);
  var stream = this.streams[pid];
  if (!stream) return out.push(p);
  if (start) {
    if (stream.keep) flush(stream, out);
    stream.packets = [];
    var ts = payload > 0 ? pesTimestamp(p, payload) : -1;
    if (ts < 0) stream.keep = true;
    else {
      var order = stream.last < 0 ? LATER : compare(ts, stream.last);
      if (order === RESTART) this.restarted = true;
      stream.keep = order !== REPEAT;
      if (stream.keep) stream.ts = ts;
    }
  }
  if (stream.keep) {
    stream.packets.push(p);
    if (stream.packets.length >= MAX_PES_PACKETS) flush(stream, out);
  }
};

Splice.prototype.readPat = function (p, at) {
  var t = at + 1 + p[at];
  if (t + 12 > PACKET || p[t] !== 0x00) return;
  var end = Math.min(t + 3 + (((p[t + 1] & 0x0f) << 8) | p[t + 2]) - 4, PACKET);
  for (var k = t + 8; k + 4 <= end; k += 4) {
    var program = (p[k] << 8) | p[k + 1];
    if (program !== 0) {
      this.pmtPid = ((p[k + 2] & 0x1f) << 8) | p[k + 3];
      return;
    }
  }
};

Splice.prototype.readPmt = function (p, at) {
  var t = at + 1 + p[at];
  if (t + 12 > PACKET || p[t] !== 0x02) return;
  var end = Math.min(t + 3 + (((p[t + 1] & 0x0f) << 8) | p[t + 2]) - 4, PACKET);
  var k = t + 12 + (((p[t + 10] & 0x0f) << 8) | p[t + 11]);
  while (k + 5 <= end) {
    var pid = ((p[k + 1] & 0x1f) << 8) | p[k + 2];
    if (!this.streams[pid]) this.streams[pid] = { packets: [], ts: -1, keep: false, last: -1 };
    k += 5 + (((p[k + 3] & 0x0f) << 8) | p[k + 4]);
  }
};

function flush(stream, out) {
  for (var k = 0; k < stream.packets.length; k++) out.push(stream.packets[k]);
  stream.packets = [];
  if (stream.ts >= 0) stream.last = stream.ts;
}

var LATER = 1, REPEAT = 0, RESTART = 2;
// Ahead by less than half the clock is later; so far behind, the stream started again.
function compare(ts, last) {
  var ahead = (ts - last + WRAP) % WRAP;
  if (ahead > 0 && ahead < HALF) return LATER;
  var behind = (last - ts + WRAP) % WRAP;
  return behind > RESET_TICKS && behind < HALF ? RESTART : REPEAT;
}
function after(ts, last) { return compare(ts, last) !== REPEAT; }

// Where a packet's payload starts, or -1 when it carries none.
function payloadAt(p) {
  var control = (p[3] >> 4) & 3;
  if (!(control & 1)) return -1;
  var at = control & 2 ? 5 + p[4] : 4;
  return at < PACKET ? at : -1;
}

// A PES header's DTS, else its PTS, else -1.
function pesTimestamp(p, at) {
  if (at + 14 > PACKET || p[at] !== 0 || p[at + 1] !== 0 || p[at + 2] !== 1) return -1;
  var flags = p[at + 7] >> 6;
  if (flags === 3 && at + 19 <= PACKET) return timestamp(p, at + 14);
  if (flags >= 2) return timestamp(p, at + 9);
  return -1;
}

function timestamp(p, k) {
  return ((p[k] >> 1) & 7) * 1073741824 + ((p[k + 1] << 22) | ((p[k + 2] >> 1) << 15) | (p[k + 3] << 7) | (p[k + 4] >> 1)) % 1073741824;
}

// The first offset from which packets follow each other at 188 bytes, or -1.
function alignment(data, from) {
  for (var i = from; i < data.length; i++) {
    if (data[i] !== SYNC) continue;
    if (i + PACKET >= data.length || data[i + PACKET] === SYNC) return i;
  }
  return -1;
}

module.exports = { Splice: Splice, _after: after, _timestamp: timestamp, _MAX_PES_PACKETS: MAX_PES_PACKETS };
