/*
 * lib/iptv-timeshift-worker.js - records the Internet TV channel Glasshouse
 * Home plays full screen to a USB stick, and serves it back to Home's player
 *
 * A child of the server (lib/iptv-timeshift), so the bytes never pass
 * through the server's one thread. curl or wget writes the provider's
 * MPEG-TS stream into numbered chunk files on the stick as it arrives; a
 * small HTTP server on 127.0.0.1 hands it to the player from those files.
 * When the player pauses, it stops reading, TCP holds this end's read head
 * where it is, and recording goes on: resuming continues from the same byte.
 *
 * Next to nothing is kept in memory, where a TV has a few hundred MB for
 * everything: every byte goes to the stick at once and is read back from
 * it, 64 KB at a time.
 *
 * stdin: one JSON line { url, ua, client, dir, maxBytes, chunkBytes, token,
 *   statusMs, prerollBytes };
 *   it exits when stdin closes, as when the server dies.
 * stdout, a JSON line each: { port }, { child }, { s: [written, kept, behind,
 *   bytesPerSecond, playerAttached] } every 2 s, { error: { code, status } }.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var net = require('net');
var path = require('path');
var spawn = require('child_process').spawn;
var allocBuffer = require('./util').allocBuffer;

var PACKET = 188;
var SYNC = 0x47;
var READ_BYTES = 64 * 1024;
// A provider that sends nothing for this long after a request is refusing it.
var FIRST_BYTES_MS = 15000;
var STATUS_MS = 2000;
// Bytes not a TS stream at all, by then: an error page with a 200.
var SYNC_GIVE_UP = 1024 * 1024;
// A dropped download is asked for again, waiting a little longer each time.
var RETRY_MS = [1000, 2000, 4000, 8000];
var RETRIES = 6;
/*
 * curl dying of SIGABRT between fork and exec, before a byte: LG's node on
 * webOS 5 to 8 aborts a child started while a handle is closing, printing
 * uv_close's assertion (docs/development/TV-RESEARCH.md, "Children that abort
 * before exec"). Seen on a CX for this worker's first child. Started again
 * from a timer, a few times.
 */
var ABORT_RETRIES = 3;
var ABORT_WAIT_MS = 200;
// A paused reader holds its chunk past the buffer's size by this many chunks at most.
var HOLD_CHUNKS = 2;
/*
 * "Back to live" starts this many seconds before the live point, and at
 * least this many bytes. The player reads what is there from the stick at
 * once, then only as fast as the channel arrives, so what it holds past the
 * picture stays what it started with: 0.3 s (256 KB of an HD channel) ran
 * dry at the first hiccup, a stall seconds after the jump (CX).
 */
var LIVE_PREROLL_S = 6;
var LIVE_PREROLL = 256 * 1024;
var HEAD_MAX = 8192;

var job = null;
var written = 0;     // bytes recorded, at offsets counted from the first
var first = 0;       // the oldest chunk still on the stick
var pos = 0;         // where the player's stream goes on from
var reader = null;   // { sock, fd, fdChunk, busy }
var waiting = [];    // requests that came before the first bytes
var recorder = null;
var tries = 0;
var aborts = 0;
var gotBytes = false;
var synced = false;
var pendingSync = null;
var unsynced = 0;
var writeFd = null;
var writeChunk = -1;
var startedAt = 0;
var ended = false;
var server = null;

function say(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function noop() {}
function chunkFile(n) { return path.join(job.dir, n + '.ts'); }

function quit(code, status) {
  if (ended) return;
  ended = true;
  if (code) say({ error: status ? { code: code, status: status } : { code: code } });
  waiting.forEach(function (w) { respond(w.sock, 502, 'Bad Gateway'); });
  waiting = [];
  if (recorder) { try { recorder.kill('SIGKILL'); } catch (e) {} }
  if (reader) { try { reader.sock.destroy(); } catch (e) {} }
  if (server) { try { server.close(); } catch (e) {} }
  // A moment for the 502s to go out. The server empties the folder once
  // this process is gone.
  setTimeout(function () { process.exit(code ? 1 : 0); }, 200);
}

// ---------------------------------------------------------------- recording

function record() {
  var bin = job.client, wget = /wget$/.test(bin);
  // -N: curl holds its output to a pipe in a buffer otherwise, and a
  // channel's first seconds with it.
  var args = wget
    ? ['-q', '-T', '20', '-U', job.ua, '-O', '-', '--', job.url]
    : ['-sS', '-N', '-f', '-L', '--max-redirs', '5', '--proto', '=http,https', '--proto-redir', '=http,https',
       '--connect-timeout', '10', '--speed-limit', '1', '--speed-time', '20', '-A', job.ua, '--', job.url];
  var proc;
  try { proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return quit('no-client'); }
  recorder = proc;
  synced = false;
  pendingSync = null;
  say({ child: proc.pid });
  var errText = '', got = 0;
  proc.stdout.on('data', function (d) { got += d.length; feed(d, proc); });
  proc.stderr.on('data', function (d) { if (errText.length < 400) errText += d; });
  proc.on('error', noop);
  proc.on('close', function (code, signal) {
    if (ended || recorder !== proc) return;
    recorder = null;
    if (signal === 'SIGABRT' && !got && ++aborts <= ABORT_RETRIES) {
      return setTimeout(function () { if (!ended) record(); }, ABORT_WAIT_MS);
    }
    var m = /(?:error|ERROR)[^0-9]*(\d{3})/.exec(errText);
    var status = m ? +m[1] : 0;
    // Refused before a byte came: no use asking again, the server plays it directly.
    if (!gotBytes) return quit(status ? 'http' : signal === 'SIGABRT' ? 'aborted' : code === 127 ? 'no-client' : 'network', status);
    if (got > 0) tries = 0;
    if (++tries > RETRIES) return quit('network', status);
    aborts = 0;
    setTimeout(function () { if (!ended) record(); }, RETRY_MS[Math.min(tries - 1, RETRY_MS.length - 1)]);
  });
}

// The first packet boundary: a sync byte with two more a packet apart.
function syncAt(b) {
  for (var i = 0; i + 2 * PACKET < b.length; i++) {
    if (b[i] === SYNC && b[i + PACKET] === SYNC && b[i + 2 * PACKET] === SYNC) return i;
  }
  return -1;
}

function feed(d, proc) {
  if (!synced) {
    d = pendingSync ? Buffer.concat([pendingSync, d]) : d;
    pendingSync = null;
    var at = syncAt(d);
    if (at < 0) {
      unsynced += d.length;
      if (unsynced > SYNC_GIVE_UP) return quit('format');
      // Two packets kept for the next piece to complete; the rest was not TS.
      pendingSync = d.length > 3 * PACKET ? d.slice(d.length - 3 * PACKET) : d;
      return;
    }
    d = d.slice(at);
    synced = true;
    // A download that dropped part way through a packet: the rest of it is
    // filler, so the next one starts on a boundary again.
    var part = written % PACKET;
    if (part) {
      var fill = allocBuffer(PACKET - part);
      fill.fill(0xff);
      d = Buffer.concat([fill, d]);
    }
  }
  // One write at a time, in order: the download waits for the stick, which
  // writes about 30 MB/s against a channel's 1.
  proc.stdout.pause();
  writeBytes(d, function (err) {
    if (err) return quit('disk');
    if (!gotBytes) {
      gotBytes = true;
      var list = waiting;
      waiting = [];
      list.forEach(function (w) { attach(w.sock, w.seek); });
    }
    if (recorder === proc) proc.stdout.resume();
  });
}

function writeBytes(buf, cb) {
  if (!buf.length) return cb(null);
  var chunk = Math.floor(written / job.chunkBytes);
  var room = (chunk + 1) * job.chunkBytes - written;
  var part = buf.length > room ? buf.slice(0, room) : buf;
  openChunk(chunk, function (err, fd) {
    if (err) return cb(err);
    fs.write(fd, part, 0, part.length, null, function (e2) {
      if (e2) return cb(e2);
      written += part.length;
      evict();
      pump();
      writeBytes(buf.slice(part.length), cb);
    });
  });
}

function openChunk(chunk, cb) {
  if (writeChunk === chunk) return cb(null, writeFd);
  if (writeFd !== null) fs.close(writeFd, noop);
  writeFd = null;
  fs.open(chunkFile(chunk), 'w', 384, function (err, fd) {
    if (err) return cb(err);
    writeFd = fd;
    writeChunk = chunk;
    cb(null, fd);
  });
}

/*
 * The buffer's oldest chunks go once it is full, except the one a paused
 * player's place is in, for a little longer: the server sees how little is
 * left and Home plays on. Past that, the place moves on with the buffer.
 */
function evict() {
  var current = Math.floor(written / job.chunkBytes);
  while ((current - first) * job.chunkBytes > job.maxBytes) {
    var held = Math.floor(pos / job.chunkBytes) <= first;
    if (held && (current - first - HOLD_CHUNKS) * job.chunkBytes <= job.maxBytes) break;
    fs.unlink(chunkFile(first), noop);
    first++;
    if (pos < first * job.chunkBytes) pos = first * job.chunkBytes;
  }
}

// ---------------------------------------------------------------- serving

function respond(sock, code, text) {
  try { sock.end('HTTP/1.1 ' + code + ' ' + text + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch (e) {}
}

function onConnection(sock) {
  var head = '';
  sock.on('error', noop);
  sock.setTimeout(10000, function () { if (head !== null) sock.destroy(); });
  function onData(d) {
    head += d.toString('binary');
    if (head.length > HEAD_MAX) return sock.destroy();
    var end = head.indexOf('\r\n\r\n');
    if (end === -1) return;
    sock.removeListener('data', onData);
    sock.setTimeout(0);
    var text = head.slice(0, end);
    head = null;
    request(sock, text);
  }
  sock.on('data', onData);
}

/*
 * GET /<token>/live.ts goes on from the last place, which a reconnect after
 * a stall keeps; ?live=1 starts at the live point and ?behind=<seconds> that
 * long before it, for Home's rewind and forward. Anything else in the query
 * is Home's own (gh=, asking past a cache) and ignored.
 */
function request(sock, text) {
  var m = /^(GET|HEAD) (\/[^ ]*) HTTP\/1\.[01]/.exec(text);
  if (!m) return respond(sock, 400, 'Bad Request');
  var q = m[2].indexOf('?');
  var p = q === -1 ? m[2] : m[2].slice(0, q);
  if (p !== '/' + job.token + '/live.ts') return respond(sock, 404, 'Not Found');
  // Seconds behind live to start at, 0 the live point; null goes on from the last place.
  var query = q === -1 ? '' : m[2].slice(q + 1), seek = null;
  var behind = /(^|&)behind=(\d{1,6})(&|$)/.exec(query);
  if (behind) seek = +behind[2];
  else if (/(^|&)live=1(&|$)/.test(query)) seek = 0;
  if (m[1] === 'HEAD') {
    try { sock.end(header()); } catch (e) {}
    return;
  }
  if (gotBytes) return attach(sock, seek);
  var w = { sock: sock, seek: seek };
  waiting.push(w);
  setTimeout(function () {
    var i = waiting.indexOf(w);
    if (i === -1) return;
    waiting.splice(i, 1);
    respond(sock, 504, 'Gateway Timeout');
  }, FIRST_BYTES_MS);
}

function header() {
  return 'HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n';
}

// One player at a time: a new request takes over from the last.
function attach(sock, seek) {
  if (reader) drop(reader);
  if (seek !== null) {
    // By the recording's average rate: within a few seconds on a channel of steady bitrate.
    var secs = (Date.now() - startedAt) / 1000;
    var back = secs > 0 ? Math.round(seek * written / secs) : 0;
    var preroll = job.prerollBytes > 0 ? job.prerollBytes : Math.max(LIVE_PREROLL, secs > 0 ? Math.round(LIVE_PREROLL_S * written / secs) : 0);
    pos = Math.max(first * job.chunkBytes, written - Math.max(back, Math.min(written, preroll)));
  }
  pos -= pos % PACKET;
  var r = { sock: sock, fd: null, fdChunk: -1, busy: false };
  reader = r;
  sock.on('close', function () { if (reader === r) drop(r); });
  sock.on('drain', pump);
  sock.write(header());
  pump();
}

function drop(r) {
  if (reader === r) reader = null;
  if (r.fd !== null) fs.close(r.fd, noop);
  r.fd = null;
  try { r.sock.destroy(); } catch (e) {}
}

function readerFd(r, chunk, cb) {
  if (r.fdChunk === chunk && r.fd !== null) return cb(null, r.fd);
  if (r.fd !== null) fs.close(r.fd, noop);
  r.fd = null;
  fs.open(chunkFile(chunk), 'r', function (err, fd) {
    if (err) return cb(err);
    r.fd = fd;
    r.fdChunk = chunk;
    cb(null, fd);
  });
}

// The next piece from the stick to the player, while it takes it.
function pump() {
  var r = reader;
  if (!r || r.busy || ended) return;
  if (pos < first * job.chunkBytes) pos = first * job.chunkBytes;
  var at = pos, avail = written - at;
  if (avail <= 0) return;
  var chunk = Math.floor(at / job.chunkBytes);
  var n = Math.min(READ_BYTES, avail, (chunk + 1) * job.chunkBytes - at);
  r.busy = true;
  readerFd(r, chunk, function (err, fd) {
    if (err) { r.busy = false; return drop(r); }
    // A new buffer each time: one handed to write() may still be queued.
    var buf = allocBuffer(n);
    fs.read(fd, buf, 0, n, at - chunk * job.chunkBytes, function (e2, got) {
      r.busy = false;
      if (reader !== r) return;
      if (e2 || !got) return drop(r);
      // The buffer moved past this place while it was read.
      if (pos !== at) return setImmediate(pump);
      pos = at + got;
      if (r.sock.write(got === n ? buf : buf.slice(0, got))) setImmediate(pump);
    });
  });
}

// ---------------------------------------------------------------- start

function status() {
  if (ended) return;
  var secs = (Date.now() - startedAt) / 1000;
  say({ s: [written, written - first * job.chunkBytes, written - pos, secs > 0 ? Math.round(written / secs) : 0, reader ? 1 : 0] });
}

function valid(j) {
  return j && typeof j.url === 'string' && /^https?:\/\//i.test(j.url) && typeof j.client === 'string' &&
    typeof j.dir === 'string' && typeof j.token === 'string' && /^[0-9a-f]{16,64}$/.test(j.token) &&
    typeof j.ua === 'string' && j.maxBytes > 0 && j.chunkBytes > 0 && j.chunkBytes % PACKET === 0;
}

function begin(j) {
  if (!valid(j)) return quit('job');
  job = j;
  startedAt = Date.now();
  server = net.createServer(onConnection);
  server.on('error', function () { quit('listen'); });
  server.listen(0, '127.0.0.1', function () {
    say({ port: server.address().port });
    // From a timer, never from a callback a handle closes in (ABORT_RETRIES).
    setTimeout(record, 0);
  });
  setInterval(status, j.statusMs > 0 ? j.statusMs : STATUS_MS);
}

var input = '';
process.stdin.on('data', function (d) {
  if (job) return;
  input += d;
  var i = input.indexOf('\n');
  if (i === -1) { if (input.length > 16384) quit('job'); return; }
  var j;
  try { j = JSON.parse(input.slice(0, i)); } catch (e) { return quit('job'); }
  begin(j);
});
process.stdin.on('end', function () { quit(null); });
process.stdin.on('error', function () { quit(null); });
process.stdin.resume();
