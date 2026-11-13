'use strict';
// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var fs = require('fs');
var path = require('path');
var os = require('os');
var execFile = require('child_process').execFile;
var allocBuffer = require('./util').allocBuffer;

var MESSAGES_LOG = '/var/log/messages';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 1000;
var MAX_FILE_READ = 512 * 1024; // 512 KB tail read

function getTvwebLogPath() {
  return process.env.TVWEB_LOG || '/var/lib/tvweb/tvweb.log';
}

// Where tvwebctl keeps the last copy when it trims tvweb.log.
function getTvwebRotatedLogPath() {
  return getTvwebLogPath() + '.1';
}

/*
 * Reads a file's complete lines from `from` to the end, or the last maxBytes
 * of it when `from` is null, no longer in the file (rotated or truncated), on
 * another file (ino), or further back than maxBytes. `end` is the offset just
 * past the last newline, so a line still being written is read whole by the
 * next call; `whole` says the start was not `from`, so what came before has to
 * be dropped rather than added to. `atEnd` says the read reached the end of
 * the file.
 *
 * With `forward`, a file that grew by more than maxBytes is read maxBytes at a
 * time from `from` rather than for its last maxBytes, and one that is new or
 * was cut short is read from its start: every line is read once, a piece at a
 * time, for following the file rather than showing its end.
 */
function readLines(filePath, from, ino, maxBytes, forward) {
  try {
    if (!fs.existsSync(filePath)) return null;
    var stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    var size = stat.size;
    var sameFile = from !== null && (!ino || ino === String(stat.ino));
    var whole, start, toRead;
    if (forward) {
      whole = !sameFile || from > size;
      start = whole ? 0 : from;
      toRead = Math.min(size - start, maxBytes);
    } else {
      whole = !sameFile || from > size || size - from > maxBytes;
      start = whole ? Math.max(0, size - maxBytes) : from;
      toRead = size - start;
    }
    if (toRead <= 0) return { text: '', end: start, ino: String(stat.ino), whole: whole, atEnd: true };
    var fd = fs.openSync(filePath, 'r');
    var buf = allocBuffer(toRead);
    var bytesRead = fs.readSync(fd, buf, 0, toRead, start);
    fs.closeSync(fd);
    var last = -1;
    for (var i = bytesRead - 1; i >= 0; i--) { if (buf[i] === 10) { last = i; break; } }
    // A line longer than a whole forward read is taken as it is, or the read
    // would never get past it.
    if (forward && last === -1 && bytesRead === maxBytes) last = bytesRead - 1;
    var text = last === -1 ? '' : buf.toString('utf8', 0, last + 1);
    // A read that began part way into the file starts mid-line.
    if (whole && start > 0) {
      var firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.substring(firstNewline + 1);
    }
    return { text: text, end: start + last + 1, ino: String(stat.ino), whole: whole, atEnd: start + bytesRead >= size };
  } catch (e) {
    return null;
  }
}

/**
 * Determine log level from line text or explicit indicator.
 * @param {string} text
 * @param {string} [hint]
 * @returns {string} 'error' | 'warning' | 'info' | 'debug'
 */
function detectLevel(text, hint) {
  if (hint) {
    var h = hint.toLowerCase();
    if (h === 'err' || h === 'error' || h === 'crit' || h === 'alert' || h === 'emerg') return 'error';
    if (h === 'warn' || h === 'warning') return 'warning';
    if (h === 'debug') return 'debug';
    if (h === 'info' || h === 'notice') return 'info';
  }
  var lower = text.toLowerCase();
  if (/\b(error|fail|failed|failure|fatal|panic|corrupt|segfault)\b/.test(lower)) return 'error';
  if (/\b(warn|warning)\b/.test(lower)) return 'warning';
  if (/\bdebug\b/.test(lower)) return 'debug';
  return 'info';
}

var SYS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[([0-9.]+)\]\s+(\S+)\s+(\S+)\s+(?:\[[^\]]*\])?\s*(.*)$/;

/**
 * Parse system log lines from /var/log/messages.
 * @param {string} raw
 * @param {number} bootTimeMs
 * @returns {Array.<Object>}
 */
function parseSystemLogs(raw, bootTimeMs) {
  if (!raw) return [];
  var lines = raw.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var m = SYS_RE.exec(line);
    if (m) {
      var facLev = m[3];
      var levHint = facLev.indexOf('.') !== -1 ? facLev.split('.')[1] : facLev;
      out.push({
        ts: m[1],
        mono: parseFloat(m[2]),
        source: 'system',
        level: detectLevel(m[5], levHint),
        proc: m[4],
        msg: m[5],
        raw: line
      });
    } else {
      // Fallback for unstructured lines in /var/log/messages
      var isoMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/.exec(line);
      var ts = isoMatch ? isoMatch[1] : new Date().toISOString();
      var msg = isoMatch ? isoMatch[2] : line;
      var mono = (Date.parse(ts) - bootTimeMs) / 1000;
      if (isNaN(mono)) mono = 0;
      out.push({
        ts: ts,
        mono: mono,
        source: 'system',
        level: detectLevel(msg),
        proc: 'system',
        msg: msg,
        raw: line
      });
    }
  }
  return out;
}

var TVWEB_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:\s+\[([0-9.]+)\])?(?:\s+\[(INFO|WARN|WARNING|ERR|ERROR|DBG|DEBUG)\])?(?:\s+(.*))?$/i;

/**
 * Parse Glasshouse server log lines.
 * @param {string} raw
 * @param {number} bootTimeMs
 * @param {number} defaultMono
 * @returns {Array.<Object>}
 */
function parseGlasshouseLogs(raw, bootTimeMs, defaultMono) {
  if (!raw) return [];
  var lines = raw.split('\n');
  var out = [];
  var lastMono = null;
  var lastTs = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var m = TVWEB_RE.exec(line);
    var ts, mono, msg;
    var explicitLvl = null;
    if (m) {
      ts = m[1];
      mono = m[2] ? parseFloat(m[2]) : (Date.parse(ts) - bootTimeMs) / 1000;
      if (m[3]) {
        var tagUpper = m[3].toUpperCase();
        if (tagUpper === 'WARN' || tagUpper === 'WARNING') explicitLvl = 'warning';
        else if (tagUpper === 'ERR' || tagUpper === 'ERROR') explicitLvl = 'error';
        else if (tagUpper === 'DBG' || tagUpper === 'DEBUG') explicitLvl = 'debug';
        else explicitLvl = 'info';
      }
      msg = m[4] || '';
      lastMono = mono;
      lastTs = ts;
    } else if (lastMono !== null) {
      ts = lastTs;
      mono = lastMono;
      msg = line;
    } else {
      ts = new Date(bootTimeMs).toISOString();
      mono = 0;
      msg = line;
    }
    var proc = 'tvweb';
    var tagMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(msg);
    if (tagMatch) {
      var cand = tagMatch[1];
      var candLower = cand.toLowerCase();
      if (candLower !== 'warning' && candLower !== 'warn' && candLower !== 'error' && candLower !== 'info' && candLower !== 'debug') {
        proc = cand;
      }
    }
    out.push({
      ts: ts,
      mono: mono,
      source: 'glasshouse',
      level: explicitLvl || detectLevel(msg),
      proc: proc,
      msg: msg,
      raw: line
    });
  }
  return out;
}

// `dmesg -r` puts each line's priority first, as <6>.
var DMESG_RE = /^\s*(?:<(\d+)>)?\[\s*([0-9.]+)\s*\]\s*(.*)$/;

/**
 * Parse kernel dmesg output, with or without -r. An entry from `dmesg -r`
 * also has its priority as `pri`.
 * @param {string} raw
 * @param {number} bootTimeMs
 * @returns {Array.<Object>}
 */
function parseKernelLogs(raw, bootTimeMs) {
  if (!raw) return [];
  var lines = raw.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var m = DMESG_RE.exec(line);
    if (m) {
      var mono = parseFloat(m[2]);
      var msg = m[3];
      var ts = new Date(bootTimeMs + Math.round(mono * 1000)).toISOString();
      var proc = 'kernel';
      var tagMatch = /^(?:\[([a-zA-Z0-9_.-]+)\]:?\s*|([a-zA-Z0-9_.-]+)(?:\s+[\w.:-]+)?:\s*)(.*)$/.exec(msg);
      if (tagMatch) {
        var candidate = tagMatch[1] || tagMatch[2];
        var candLower = candidate.toLowerCase();
        if (candLower !== 'warning' && candLower !== 'warn' && candLower !== 'error' && candLower !== 'info' && candLower !== 'debug') {
          proc = candidate;
        }
      }
      var entry = {
        ts: ts,
        mono: mono,
        source: 'kernel',
        level: detectLevel(msg),
        proc: proc,
        msg: msg,
        raw: line
      };
      if (m[1]) entry.pri = parseInt(m[1], 10);
      out.push(entry);
    }
  }
  return out;
}

/*
 * The cursor a poll sends back to be given only what is new:
 * "system:<end>:<ino>,glasshouse:<end>:<ino>,kernel:<last uptime>".
 */
/*
 * Numbers the boots in a run of tvweb.log entries, in the order written: the
 * last is 0, the one before -1. tvweb.log outlives a reboot and its uptime
 * starts again from 0, so uptime alone put an earlier boot's later lines after
 * this boot's, and a limit kept those over the newest. A boot ends where the
 * uptime goes back. The system log and the kernel's are this boot's only.
 * @param {Array.<Object>} entries
 */
function markBoots(entries) {
  var boot = 0;
  for (var i = entries.length - 1; i >= 0; i--) {
    if (i < entries.length - 1 && entries[i].mono > entries[i + 1].mono) boot--;
    entries[i].boot = boot;
  }
}

function parseCursor(since) {
  var out = {};
  String(since || '').split(',').forEach(function (part) {
    var f = part.split(':');
    if (f[0] === 'kernel' && f[1] && !isNaN(parseFloat(f[1]))) out.kernel = parseFloat(f[1]);
    else if ((f[0] === 'system' || f[0] === 'glasshouse') && /^\d+$/.test(f[1] || '')) {
      out[f[0]] = { end: parseInt(f[1], 10), ino: f[2] || '' };
    }
  });
  return out;
}

/**
 * Fetch and combine logs across requested sources.
 * @param {Object} opts
 * @param {Array.<string>} [opts.sources] 'system', 'glasshouse', 'kernel'
 * @param {number|string} [opts.limit]
 * @param {string} [opts.filter]
 * @param {string} [opts.since] the cursor from the last call: only what
 *   came after it is returned, unless `incremental` comes back false
 * @param {boolean} [opts.redact]
 * @param {function(Error|null, Object=): void} cb
 */
function getLogs(opts, cb) {
  opts = opts || {};
  var limit = parseInt(String(opts.limit), 10);
  if (isNaN(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  var requestedSources = opts.sources;
  if (!requestedSources || !requestedSources.length) {
    requestedSources = ['system', 'glasshouse'];
  }
  var wantSystem = requestedSources.indexOf('system') !== -1;
  var wantGlasshouse = requestedSources.indexOf('glasshouse') !== -1;
  var wantKernel = requestedSources.indexOf('kernel') !== -1;

  var now = Date.now();
  var uptime = typeof os.uptime === 'function' ? os.uptime() : 0;
  var bootTimeMs = now - Math.round(uptime * 1000);

  var tvwebPath = getTvwebLogPath();
  var rotPath = getTvwebRotatedLogPath();
  var sysAvailable = fs.existsSync(MESSAGES_LOG);
  var ghAvailable = fs.existsSync(tvwebPath) || fs.existsSync(rotPath);

  var meta = {
    system: { available: sysAvailable, path: MESSAGES_LOG },
    glasshouse: {
      available: ghAvailable,
      path: tvwebPath,
      rotatedAvailable: fs.existsSync(rotPath)
    },
    kernel: { available: true }
  };

  var allEntries = [];
  var since = opts.since ? parseCursor(opts.since) : null;
  // False once any source had to be read whole, so the caller replaces its
  // list rather than adding to it.
  var incremental = !!since;
  var cursor = [];

  function readSource(name, file, parse) {
    var at = since && since[name];
    var r = readLines(file, at ? at.end : null, at ? at.ino : '', MAX_FILE_READ);
    if (!r) { if (since) incremental = false; return; }
    if (r.whole) incremental = false;
    cursor.push(name + ':' + r.end + ':' + r.ino);
    var entries = parse(r.text);
    for (var e = 0; e < entries.length; e++) {
      entries[e].boot = 0;
      allEntries.push(entries[e]);
    }
    return { whole: r.whole, count: entries.length };
  }

  if (wantSystem && sysAvailable) {
    readSource('system', MESSAGES_LOG, function (text) { return parseSystemLogs(text, bootTimeMs); });
  }

  if (wantGlasshouse && ghAvailable) {
    var ghEntries = [];
    var gh = readSource('glasshouse', tvwebPath, function (text) {
      ghEntries = parseGlasshouseLogs(text, bootTimeMs, uptime);
      return [];
    });
    // Just after tvwebctl trims tvweb.log it holds a few lines: a whole read
    // that comes up short is topped up from the copy it kept, oldest first.
    if (gh && gh.whole && ghEntries.length < limit && fs.existsSync(rotPath)) {
      var rot = readLines(rotPath, null, '', MAX_FILE_READ);
      if (rot) ghEntries = parseGlasshouseLogs(rot.text, bootTimeMs, uptime).concat(ghEntries);
    }
    markBoots(ghEntries);
    for (var o = 0; o < ghEntries.length; o++) allEntries.push(ghEntries[o]);
  }

  function finish() {
    // Sort combined entries chronologically: by boot, then uptime within it.
    allEntries.sort(function (a, b) {
      if (a.boot !== b.boot) return a.boot - b.boot;
      if (a.mono !== b.mono) return a.mono - b.mono;
      return a.ts < b.ts ? -1 : (a.ts > b.ts ? 1 : 0);
    });

    // Optional server-side filter string
    var filter = typeof opts.filter === 'string' ? opts.filter.trim().toLowerCase() : '';
    if (filter) {
      var filtered = [];
      for (var f = 0; f < allEntries.length; f++) {
        var ent = allEntries[f];
        if (ent.raw.toLowerCase().indexOf(filter) !== -1 ||
            ent.proc.toLowerCase().indexOf(filter) !== -1) {
          filtered.push(ent);
        }
      }
      allEntries = filtered;
    }

    // Apply cap
    if (allEntries.length > limit) {
      allEntries = allEntries.slice(allEntries.length - limit);
    }

    if (opts && opts.redact) {
      var redacted = [];
      for (var r = 0; r < allEntries.length; r++) {
        redacted.push(redactEntry(allEntries[r]));
      }
      allEntries = redacted;
    }

    cb(null, {
      ok: true,
      cursor: cursor.join(','),
      incremental: incremental,
      sources: meta,
      uptime: uptime,
      bootTime: bootTimeMs,
      limit: limit,
      total: allEntries.length,
      entries: allEntries
    });
  }

  if (wantKernel) {
    execFile('dmesg', [], { maxBuffer: 2 * 1024 * 1024 }, function (err, stdout) {
      if (!err && stdout) {
        // dmesg is a ring buffer, read whole each time: what is new is what
        // is later than the last entry the caller has.
        var kEntries = parseKernelLogs(stdout, bootTimeMs);
        // All of it when a file was read whole, as the caller starts over.
        var after = incremental && typeof since.kernel === 'number' ? since.kernel : -1;
        var lastMono = after;
        for (var k = 0; k < kEntries.length; k++) {
          kEntries[k].boot = 0;
          if (kEntries[k].mono > after) allEntries.push(kEntries[k]);
          if (kEntries[k].mono > lastMono) lastMono = kEntries[k].mono;
        }
        if (lastMono >= 0) cursor.push('kernel:' + lastMono);
      } else if (err) {
        meta.kernel.available = false;
        meta.kernel.error = err.message;
      }
      finish();
    });
  } else {
    finish();
  }
}

/**
 * Format an unhandled exception or fatal error into structured log lines.
 * @param {Error|any} err
 * @returns {Array.<string>}
 */
function formatFatalError(err) {
  var mem = (typeof process !== 'undefined' && process.memoryUsage) ? process.memoryUsage() : null;
  var memStr = mem ? 'rss=' + Math.round(mem.rss / 1048576) + 'MB heap=' + Math.round(mem.heapUsed / 1048576) + '/' + Math.round(mem.heapTotal / 1048576) + 'MB' : '';
  var stack = (err && err.stack) ? String(err.stack) : String(err);
  var out = [];
  out.push('fatal: uncaught exception' + (memStr ? ' (' + memStr + ')' : ''));
  var lines = stack.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (l) out.push('fatal: ' + l);
  }
  return out;
}

/**
 * Redact sensitive diagnostic information (IPs, MACs, device serials, tokens/credentials)
 * for safe bug reporting, sharing, and exports.
 * @param {string} str
 * @returns {string}
 */
function redact(str) {
  if (!str) return str;
  return String(str)
    // Passwords, credentials, and basic auth in URLs
    .replace(/(:\/\/[^:]+:)[^@\s]+(@)/g, '$1<REDACTED>$2')
    // URL query tokens and auth keys (e.g. ?k=..., &token=...)
    .replace(/((\?|&)(?:k|token|key|api_key|auth)=)[^&\s"'\x60>]+/gi, '$1<REDACTED>')
    // Bearer authorization tokens
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1<REDACTED>')
    // Key-value credentials (e.g. password: "foo", secret = "bar")
    .replace(/(["']?(?:password|passwd|secret|client_secret|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^"',\s}]+(["']?)/gi, '$1<REDACTED>$2')
    // Serial numbers and device IDs (e.g. serialNumber: "301NDXK0C912")
    .replace(/(["']?(?:serial(?:_?number)?|device_?id|esn)["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{6,}(["']?)/gi, '$1<SERIAL>$2')
    // Postcodes and coordinates (pqcontroller reports "zip_code":"bt155at" on a C2)
    .replace(/(["']?(?:zip_?code|post_?code|postal_?code|latitude|longitude)["']?\s*[:=]\s*["']?)[^"',}\r\n]+(["']?)/gi, '$1<LOCATION>$2')
    // Wi-Fi SSIDs (e.g. SSID "MyNetwork")
    .replace(/(ssid["':=\s]+["'])[^\r\n"']*(["'])/gi, '$1<SSID>$2')
    // MAC addresses (e.g. 14:49:e0:12:34:56 or 14-49-e0-12-34-56)
    .replace(/\b([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})\b/g, '<MAC>')
    // IPv6 addresses (preserving ::1)
    .replace(/(?:\bfe80:[0-9a-fA-F:]+\b|\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b|\b[0-9a-fA-F]{1,4}::[0-9a-fA-F:]*\b)/gi, '<IPV6>')
    // IPv4 addresses (private and public, preserving 127.0.0.1 and 0.0.0.0)
    .replace(/\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '<IP>');
}

/**
 * Return a copy of a log entry with sensitive data redacted in msg, proc, and raw.
 * @param {Object} entry
 * @returns {Object}
 */
function redactEntry(entry) {
  if (!entry) return entry;
  return {
    ts: entry.ts,
    mono: entry.mono,
    boot: entry.boot,
    source: entry.source,
    proc: redact(entry.proc),
    level: entry.level,
    msg: redact(entry.msg),
    raw: redact(entry.raw)
  };
}

/**
 * Determine if a log entry with the given levelTag should be output
 * under the configured verbosity setting ('quiet', 'info', 'debug').
 * @param {string} levelTag 'INFO', 'WARN', 'ERR', 'DBG'
 * @param {string} [configuredLevel='info']
 * @returns {boolean}
 */
function shouldLog(levelTag, configuredLevel) {
  var tag = (levelTag || 'INFO').toUpperCase();
  var cfg = String(configuredLevel || 'info').toLowerCase();
  if (tag === 'ERR' || tag === 'FATAL' || tag === 'ERROR') return true;
  if (tag === 'WARN' || tag === 'WARNING') return true;
  if (cfg === 'quiet' || cfg === 'error' || cfg === 'warn') return false;
  if (tag === 'INFO') return true;
  if (tag === 'DBG' || tag === 'DEBUG') return cfg === 'debug';
  return true;
}

module.exports = {
  getLogs: getLogs,
  readLines: readLines,
  MESSAGES_LOG: MESSAGES_LOG,
  parseCursor: parseCursor,
  parseSystemLogs: parseSystemLogs,
  parseGlasshouseLogs: parseGlasshouseLogs,
  parseKernelLogs: parseKernelLogs,
  markBoots: markBoots,
  detectLevel: detectLevel,
  formatFatalError: formatFatalError,
  redact: redact,
  redactEntry: redactEntry,
  shouldLog: shouldLog,
  getTvwebLogPath: getTvwebLogPath,
  getTvwebRotatedLogPath: getTvwebRotatedLogPath
};
