'use strict';
/*
 * Forwards the logs the Tools tab shows to a syslog server, as RFC 5424 over
 * UDP, one datagram a line. Off until config.syslog.server is set.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * The files are followed with the Tools tab's own reads and parsers, so what
 * leaves the TV is what the tab shows, including lines the server did not
 * write through console: libuv's assertions, and the crash handler's last
 * lines once the watchdog has restarted it.
 */
var dgram = require('dgram');
var dns = require('dns');
var fs = require('fs');
var os = require('os');
var execFile = require('child_process').execFile;
var logs = require('./logs');
var children = require('./children');

var SOURCES = ['system', 'glasshouse', 'kernel'];
var POLL_MS = 5000;
// On a CX (webOS 5) luna-send children's libuv aborts went from 1 to 3 an hour
// to 13 in 47 minutes once dmesg ran every 5 s. Its ring holds minutes there.
var KERNEL_POLL_MS = 30000;
// The longest system line seen is 470 bytes; Alloy takes up to 8192.
var MAX_DATAGRAM = 2048;
// Each poll reads at most this much of a file, so one that has grown a lot
// never holds up the loop, HTTP and the heartbeat with it, in one read.
var READ_CHUNK = 64 * 1024;
// Left once the boot's system and kernel logs have been sent. /var/run is
// tmpfs, as /var/log/messages is, so a start without it sends them from their
// beginning and any later one, a watchdog restart included, does not send
// them again. A start that dies before sending them leaves none, so the next
// sends them rather than losing them.
var BOOT_SENT_MARKER = '/var/run/tvweb.syslog-boot-sent';
// Until it syncs the clock reads 2023-01-01 on a C4 (webOS 9) and 2020-01-01
// on a CX (webOS 5). Every timestamp is worked out from it, so nothing is sent
// while it reads earlier than this.
var CLOCK_FLOOR_MS = Date.UTC(2026, 0, 1);

var FACILITIES = {
  kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7,
  uucp: 8, cron: 9, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23
};
var SEVERITIES = {
  emerg: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3,
  warn: 4, warning: 4, notice: 5, info: 6, debug: 7
};
// The parsers' levels, for a line that carries no priority of its own.
var LEVEL_SEVERITY = { error: 3, warning: 4, info: 6, debug: 7 };

var SYS_PRIORITY_RE = /^\S+\s+\[[0-9.]+\]\s+([a-z0-9]+)\.([a-z]+)\s/i;
// The time tvweb.js puts first on each line it writes.
var GLASSHOUSE_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

var config = null;
var messagesPath = logs.MESSAGES_LOG;
var uptimeFn = readUptime;
var clockFn = monotonicMs;
var markerPath = BOOT_SENT_MARKER;
// Whether this start is sending the boot's logs and has yet to leave the marker.
var bootPending = false;
var deviceName = '';
var settings = null;
var timer = null;
var socket = null;
var socketType = '';
var address = '';
var resolving = false;
var needsLookup = true;
var announced = false;
var errorState = null;
var polling = false;
var cursors = {};
var counters = null;
// When dmesg was last started, on clockFn, or null for a read at the next poll.
var kernelReadAt = null;
// Bumped by each start and stop, so a callback from before one is ignored.
var generation = 0;

// Not Date.now(): the clock steps forward years when it syncs, and back too.
function monotonicMs() {
  var t = process.hrtime();
  return t[0] * 1000 + t[1] / 1e6;
}

function readUptime() {
  try {
    var up = parseFloat(fs.readFileSync('/proc/uptime', 'utf8'));
    if (isFinite(up)) return up;
  } catch (e) {}
  return typeof os.uptime === 'function' ? os.uptime() : 0;
}

/*
 * config.syslog as used, or null while no server is set.
 * @param {any} conf the server's config
 */
function readSettings(conf) {
  var s = (conf && conf.syslog) || {};
  var server = typeof s.server === 'string' ? s.server.trim() : '';
  if (!server) return null;
  var port = parseInt(s.port, 10);
  var sources = Array.isArray(s.sources) ? s.sources : ['system', 'glasshouse'];
  return {
    server: server,
    port: port >= 1 && port <= 65535 ? port : 514,
    hostname: typeof s.hostname === 'string' ? s.hostname.trim() : '',
    sources: SOURCES.filter(function (name) { return sources.indexOf(name) !== -1; }),
    redact: s.redact !== false
  };
}

function fileEnd(filePath) {
  try {
    var st = fs.statSync(filePath);
    return { end: st.size, ino: String(st.ino) };
  } catch (e) {
    // A file that appears later is all new, so it is read from its start.
    return { end: 0, ino: '' };
  }
}

/*
 * Where each source starts: the system log and the kernel's from their
 * beginning until a start has sent them, everything else from its end now.
 * The kernel's end is null, for the first poll to read off dmesg.
 */
function startCursors(boot, paths) {
  return {
    system: boot ? { end: 0, ino: '' } : fileEnd(paths.system),
    glasshouse: fileEnd(paths.glasshouse),
    kernel: boot ? -1 : null
  };
}

// RFC 5424 header fields are printable ASCII without spaces.
function headerField(v, max) {
  var s = String(v || '').replace(/[^\x21-\x7e]+/g, '-').substring(0, max);
  return s || '-';
}

function priority(entry) {
  var severity = LEVEL_SEVERITY.hasOwnProperty(entry.level) ? LEVEL_SEVERITY[entry.level] : 6;
  if (entry.source === 'kernel') {
    // dmesg -r prints the whole priority, and a write to /dev/kmsg from
    // userspace carries its own facility: <14> is user.info.
    return typeof entry.pri === 'number' && entry.pri >= 0 && entry.pri <= 191 ? entry.pri : severity;
  }
  if (entry.source === 'glasshouse') return FACILITIES.daemon * 8 + severity;
  var m = SYS_PRIORITY_RE.exec(entry.raw || '');
  if (m) {
    var fac = m[1].toLowerCase(), sev = m[2].toLowerCase();
    if (FACILITIES.hasOwnProperty(fac) && SEVERITIES.hasOwnProperty(sev)) {
      return FACILITIES[fac] * 8 + SEVERITIES[sev];
    }
  }
  return FACILITIES.user * 8 + severity;
}

function toBuffer(s) {
  return typeof Buffer.from === 'function' ? Buffer.from(s, 'utf8') : new Buffer(s, 'utf8');
}

/**
 * One parsed log entry as an RFC 5424 message, at most MAX_DATAGRAM bytes.
 * @param {Object} entry from one of the logs module's parsers
 * @param {{hostname: string, bootTimeMs: number, redact: boolean}} opts
 * @returns {Buffer}
 */
function formatMessage(entry, opts) {
  var shown = opts.redact ? logs.redactEntry(entry) : entry;
  // The line's own time, once the clock had synced. Uptime stands still in
  // standby on a CX (webOS 5): a 06:00 line at 82333.5 s and an 11:00 one at
  // 82335.7 s, so boot time plus uptime would date the first at 11:00. Before
  // the clock synced the line's own time is 2023-01-01 or 2020-01-01, and its
  // uptime places it instead. Node 0.12 parses no more than milliseconds.
  var t = Date.parse(String(entry.ts).replace(/(\.\d{3})\d+/, '$1'));
  if (!(t >= CLOCK_FLOOR_MS) && isFinite(entry.mono)) t = opts.bootTimeMs + Math.round(entry.mono * 1000);
  if (!isFinite(t)) t = Date.now();
  // The kernel parser's process is the Tools tab's guess at a subsystem, the
  // word before a colon, which is no syslog app name.
  var app = entry.source === 'kernel' ? 'kernel' : shown.proc;
  var text = '<' + priority(entry) + '>1 ' + new Date(t).toISOString() + ' ' +
    headerField(opts.hostname, 255) + ' ' + headerField(app, 48) + ' - ' +
    headerField(entry.source, 32) + ' -' + (shown.msg ? ' ' + shown.msg : '');
  var buf = toBuffer(text);
  if (buf.length <= MAX_DATAGRAM) return buf;
  // Cut on a character boundary: a UTF-8 continuation byte is 10xxxxxx.
  var cut = MAX_DATAGRAM;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.slice(0, cut);
}

function target() {
  var server = settings.server.indexOf(':') !== -1 ? '[' + settings.server + ']' : settings.server;
  return server + ':' + settings.port;
}

// One line when the error changes, not one per failed datagram.
function setError(text) {
  if (text === errorState) return;
  var had = errorState;
  errorState = text;
  if (text) console.error('syslog: ' + text);
  else if (had) console.log('syslog: sending to ' + target() + ' again');
}

function openSocket(type) {
  if (socket && socketType === type) return;
  if (socket) { try { socket.close(); } catch (e) {} }
  var sock = dgram.createSocket(type);
  socket = sock;
  socketType = type;
  // A socket that has failed is replaced, by the lookup the next poll makes.
  sock.on('error', function (err) {
    try { sock.close(); } catch (e) {}
    if (socket !== sock) return;
    socket = null;
    socketType = '';
    needsLookup = true;
    setError('socket error: ' + err.message);
  });
}

// At start and after a send fails, never per send.
function resolve() {
  if (resolving) return;
  resolving = true;
  var gen = generation;
  dns.lookup(settings.server, function (err, addr, family) {
    if (gen !== generation) return;
    resolving = false;
    if (err) { setError('could not resolve ' + settings.server + ': ' + err.message); return; }
    openSocket(family === 6 ? 'udp6' : 'udp4');
    address = addr;
    needsLookup = false;
    if (!announced) {
      announced = true;
      console.log('syslog: forwarding ' + settings.sources.join(', ') + ' to ' + target() +
                  (addr !== settings.server ? ' (' + addr + ')' : ''));
    }
  });
}

// A failed send is dropped and counted: UDP syslog does not queue.
function send(buf, source) {
  // A socket error between a poll's checks and dmesg's answer leaves none.
  if (!socket || needsLookup) { counters.errors++; return; }
  var gen = generation;
  socket.send(buf, 0, buf.length, settings.port, address, function (err) {
    if (gen !== generation) return;
    if (err) {
      counters.errors++;
      needsLookup = true;
      setError('could not send to ' + target() + ': ' + err.message);
    } else {
      counters.messages[source]++;
      setError(null);
    }
  });
}

function sendEntries(entries, bootTimeMs) {
  var opts = { hostname: settings.hostname || deviceName, bootTimeMs: bootTimeMs, redact: settings.redact };
  for (var i = 0; i < entries.length; i++) send(formatMessage(entries[i], opts), entries[i].source);
}

/*
 * Glasshouse lines without a time of their own, such as libuv's assertion from
 * a child process, take the time of the stamped line before them. The parser
 * dates those at the start of a read at boot, which Loki rejects as more than
 * an hour behind the stream; they were written since the last poll, so they
 * are dated at this one.
 */
function dateUnstamped(entries, nowMs, uptime) {
  for (var i = 0; i < entries.length && !GLASSHOUSE_STAMP_RE.test(entries[i].raw); i++) {
    entries[i].ts = new Date(nowMs).toISOString();
    entries[i].mono = uptime;
  }
  return entries;
}

// Whether the read reached the end of the file, or found no file.
function followFile(name, filePath, parse, bootTimeMs) {
  var at = cursors[name];
  var r = logs.readLines(filePath, at.end, at.ino, READ_CHUNK, true);
  if (!r) return true;
  cursors[name] = { end: r.end, ino: r.ino };
  sendEntries(parse(r.text), bootTimeMs);
  return r.atEnd;
}

// Once the boot's logs are sent, so a restart does not send them again.
function bootSent() {
  bootPending = false;
  try { fs.writeFileSync(markerPath, ''); } catch (e) {}
}

/*
 * One pass over every enabled source. Lines wait, their cursors unmoved,
 * until there is a hostname to send as, the clock has synced and the server has
 * resolved.
 * @param {function(): void} [done] called once the pass has sent its lines
 */
function poll(done) {
  done = done || function () {};
  if (!settings || polling) return done();
  if (needsLookup) resolve();
  if (!(settings.hostname || deviceName) || !address || needsLookup || Date.now() < CLOCK_FLOOR_MS) return done();
  var uptime = uptimeFn();
  var bootTimeMs = Date.now() - Math.round(uptime * 1000);
  var want = settings.sources;
  var systemCaughtUp = true;
  if (want.indexOf('system') !== -1) {
    systemCaughtUp = followFile('system', messagesPath, function (text) {
      return logs.parseSystemLogs(text, bootTimeMs);
    }, bootTimeMs);
  }
  if (want.indexOf('glasshouse') !== -1) {
    followFile('glasshouse', logs.getTvwebLogPath(), function (text) {
      return dateUnstamped(logs.parseGlasshouseLogs(text, bootTimeMs, uptime), Date.now(), uptime);
    }, bootTimeMs);
  }
  if (want.indexOf('kernel') === -1) {
    if (bootPending && systemCaughtUp) bootSent();
    return done();
  }
  var now = clockFn();
  if (kernelReadAt !== null && now - kernelReadAt < KERNEL_POLL_MS) return done();
  kernelReadAt = now;
  polling = true;
  var gen = generation;
  // A ring buffer rather than a file: read whole, and sent from after the
  // last uptime sent.
  children.launch(function () {
    if (gen !== generation) return done();
    execFile('dmesg', ['-r'], { maxBuffer: 2 * 1024 * 1024 }, function (err, stdout) {
      if (gen !== generation) return done();
      polling = false;
      if (err) { setError('could not run dmesg: ' + err.message); return done(); }
      var entries = logs.parseKernelLogs(stdout, bootTimeMs);
      var after = cursors.kernel, last = after === null ? -1 : after, fresh = [];
      for (var i = 0; i < entries.length; i++) {
        if (after !== null && entries[i].mono > after) fresh.push(entries[i]);
        if (entries[i].mono > last) last = entries[i].mono;
      }
      cursors.kernel = last;
      sendEntries(fresh, bootTimeMs);
      if (bootPending && systemCaughtUp) bootSent();
      done();
    });
  });
}

/**
 * @param {Object} opts
 * @param {any} opts.config the server's config, read at start()
 * @param {string} [opts.messagesPath] the system log, for tests
 * @param {function(): number} [opts.uptime] seconds since boot, for tests
 * @param {string} [opts.markerPath] the boot-sent marker, for tests
 * @param {function(): number} [opts.clock] monotonic milliseconds, for tests
 */
function init(opts) {
  config = opts.config;
  if (opts.messagesPath) messagesPath = opts.messagesPath;
  if (opts.uptime) uptimeFn = opts.uptime;
  if (opts.markerPath) markerPath = opts.markerPath;
  if (opts.clock) clockFn = opts.clock;
}

function bootLogsUnsent() {
  return !fs.existsSync(markerPath);
}

// The device name, once known, sent as the hostname unless config gives one.
// The system's own is LGwebOSTV on a C4 (webOS 9) and a CX (webOS 5) alike.
function setHostname(name) {
  deviceName = name || '';
}

/**
 * Starts forwarding when a server is set. Changed settings take effect at the
 * server's next start.
 * @returns {boolean} whether it started
 */
function start() {
  stop();
  settings = readSettings(config);
  if (!settings) return false;
  bootPending = bootLogsUnsent();
  cursors = startCursors(bootPending, { system: messagesPath, glasshouse: logs.getTvwebLogPath() });
  counters = { messages: {}, errors: 0 };
  kernelReadAt = null;
  settings.sources.forEach(function (name) { counters.messages[name] = 0; });
  needsLookup = true;
  announced = false;
  errorState = null;
  resolve();
  timer = setInterval(function () { poll(); }, POLL_MS);
  return true;
}

function stop() {
  generation++;
  bootPending = false;
  resolving = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (socket) { try { socket.close(); } catch (e) {} }
  socket = null;
  socketType = '';
  address = '';
  settings = null;
  counters = null;
  polling = false;
}

/**
 * Datagrams sent and failed since start, or null while forwarding is off.
 * @returns {{messages: Object.<string, number>, errors: number}|null}
 */
function getCounters() {
  return counters;
}

module.exports = {
  init: init,
  start: start,
  stop: stop,
  poll: poll,
  setHostname: setHostname,
  getCounters: getCounters,
  readSettings: readSettings,
  startCursors: startCursors,
  bootLogsUnsent: bootLogsUnsent,
  formatMessage: formatMessage,
  dateUnstamped: dateUnstamped,
  MAX_DATAGRAM: MAX_DATAGRAM
};
