'use strict';
// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var fs = require('fs');
var path = require('path');
var os = require('os');
var execFile = require('child_process').execFile;

var MESSAGES_LOG = '/var/log/messages';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 1000;
var MAX_FILE_READ = 512 * 1024; // 512 KB tail read

function getTvwebLogPath() {
  return process.env.TVWEB_LOG || '/var/lib/tvweb/tvweb.log';
}

function getTvwebRotatedLogPath() {
  return (process.env.TVWEB_LOG || '/var/lib/tvweb/tvweb.log') + '.1';
}

/**
 * Safely read the tail of a file up to maxBytes.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string|null}
 */
function readTail(filePath, maxBytes) {
  try {
    if (!fs.existsSync(filePath)) return null;
    var stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    var size = stat.size;
    if (size === 0) return '';
    var fd = fs.openSync(filePath, 'r');
    var toRead = Math.min(size, maxBytes);
    var buf = typeof Buffer.alloc === 'function' ? Buffer.alloc(toRead) : new Buffer(toRead);
    var pos = Math.max(0, size - toRead);
    var bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
    fs.closeSync(fd);
    var content = buf.toString('utf8', 0, bytesRead);
    if (size > maxBytes) {
      var firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) {
        content = content.substring(firstNewline + 1);
      }
    }
    return content;
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

var TVWEB_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:\s+\[([0-9.]+)\])?(?:\s+\[(INFO|WARN|WARNING|ERR|ERROR|DEBUG)\])?(?:\s+(.*))?$/i;

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
        else if (tagUpper === 'DEBUG') explicitLvl = 'debug';
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

var DMESG_RE = /^\s*\[\s*([0-9.]+)\s*\]\s*(.*)$/;

/**
 * Parse kernel dmesg output.
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
      var mono = parseFloat(m[1]);
      var msg = m[2];
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
      out.push({
        ts: ts,
        mono: mono,
        source: 'kernel',
        level: detectLevel(msg),
        proc: proc,
        msg: msg,
        raw: line
      });
    }
  }
  return out;
}

/**
 * Fetch and combine logs across requested sources.
 * @param {Object} opts
 * @param {Array.<string>} [opts.sources] 'system', 'glasshouse', 'kernel'
 * @param {number|string} [opts.limit]
 * @param {string} [opts.filter]
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
  var ringEntries = getGlasshouseRing();
  var ghAvailable = fs.existsSync(tvwebPath) || fs.existsSync(rotPath) || ringEntries.length > 0;

  var meta = {
    system: { available: sysAvailable, path: MESSAGES_LOG },
    glasshouse: {
      available: ghAvailable,
      path: tvwebPath,
      rotatedAvailable: fs.existsSync(rotPath),
      buffered: ringEntries.length
    },
    kernel: { available: true }
  };

  var allEntries = [];

  if (wantSystem && sysAvailable) {
    var sysRaw = readTail(MESSAGES_LOG, MAX_FILE_READ);
    if (sysRaw) {
      var sysEntries = parseSystemLogs(sysRaw, bootTimeMs);
      for (var s = 0; s < sysEntries.length; s++) allEntries.push(sysEntries[s]);
    }
  }

  if (wantGlasshouse && ghAvailable) {
    if (ringEntries.length >= limit) {
      // In-memory ring buffer satisfies request completely - bypass eMMC file reads
      var sliceStart = ringEntries.length - limit;
      for (var r = sliceStart; r < ringEntries.length; r++) {
        allEntries.push(ringEntries[r]);
      }
    } else {
      var ghEntries = [];
      if (fs.existsSync(tvwebPath) || fs.existsSync(rotPath)) {
        var ghRaw = readTail(tvwebPath, MAX_FILE_READ) || '';
        ghEntries = parseGlasshouseLogs(ghRaw, bootTimeMs, uptime);
        if (fs.existsSync(rotPath) && (ghEntries.length < limit || ghRaw.length < MAX_FILE_READ / 2)) {
          var remainingBytes = Math.max(0, MAX_FILE_READ - ghRaw.length);
          if (remainingBytes > 0) {
            var rotRaw = readTail(rotPath, remainingBytes);
            if (rotRaw) {
              var rotEntries = parseGlasshouseLogs(rotRaw, bootTimeMs, uptime);
              ghEntries = rotEntries.concat(ghEntries);
            }
          }
        }
      }
      if (ringEntries.length === 0) {
        for (var g = 0; g < ghEntries.length; g++) allEntries.push(ghEntries[g]);
      } else {
        var firstRing = ringEntries[0];
        for (var d = 0; d < ghEntries.length; d++) {
          var de = ghEntries[d];
          if (de.ts < firstRing.ts || (de.ts === firstRing.ts && de.mono < firstRing.mono)) {
            allEntries.push(de);
          }
        }
        for (var m = 0; m < ringEntries.length; m++) {
          allEntries.push(ringEntries[m]);
        }
      }
    }
  }

  function finish() {
    // Sort combined entries chronologically
    allEntries.sort(function (a, b) {
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
        var kEntries = parseKernelLogs(stdout, bootTimeMs);
        for (var k = 0; k < kEntries.length; k++) allEntries.push(kEntries[k]);
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
    .replace(/((\?|&)(?:k|token|key|api_key|auth)=)[^&\s"'`>]+/gi, '$1<REDACTED>')
    // Bearer authorization tokens
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1<REDACTED>')
    // Key-value credentials (e.g. password: "foo", secret = "bar")
    .replace(/(["']?(?:password|passwd|secret|client_secret|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^"',\s}]+(["']?)/gi, '$1<REDACTED>$2')
    // Serial numbers and device IDs (e.g. serialNumber: "301NDXK0C912")
    .replace(/(["']?(?:serial(?:_?number)?|device_?id|esn)["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{6,}(["']?)/gi, '$1<SERIAL>$2')
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
    source: entry.source,
    proc: redact(entry.proc),
    level: entry.level,
    msg: redact(entry.msg),
    raw: redact(entry.raw)
  };
}

var GH_RING_MAX = 500;
var ghRing = [];

/**
 * Record a formatted Glasshouse log line into the in-memory ring buffer.
 * Bounded to GH_RING_MAX lines to eliminate repetitive eMMC flash reads during live inspection.
 * @param {string} line
 * @returns {void}
 */
function recordGlasshouseLog(line) {
  if (typeof line !== 'string' || !line) return;
  var now = Date.now();
  var uptime = typeof os.uptime === 'function' ? os.uptime() : 0;
  var bootTimeMs = now - Math.round(uptime * 1000);
  var entries = parseGlasshouseLogs(line + '\n', bootTimeMs, uptime);
  for (var i = 0; i < entries.length; i++) {
    ghRing.push(entries[i]);
  }
  if (ghRing.length > GH_RING_MAX) {
    ghRing.splice(0, ghRing.length - GH_RING_MAX);
  }
}

/**
 * Get current in-memory Glasshouse ring buffer entries.
 * @returns {Array.<Object>}
 */
function getGlasshouseRing() {
  return ghRing.slice(0);
}

/**
 * Clear ring buffer (for tests).
 * @returns {void}
 */
function clearGlasshouseRing() {
  ghRing = [];
}

module.exports = {
  getLogs: getLogs,
  parseSystemLogs: parseSystemLogs,
  parseGlasshouseLogs: parseGlasshouseLogs,
  parseKernelLogs: parseKernelLogs,
  detectLevel: detectLevel,
  formatFatalError: formatFatalError,
  redact: redact,
  redactEntry: redactEntry,
  recordGlasshouseLog: recordGlasshouseLog,
  getGlasshouseRing: getGlasshouseRing,
  clearGlasshouseRing: clearGlasshouseRing,
  getTvwebLogPath: getTvwebLogPath,
  getTvwebRotatedLogPath: getTvwebRotatedLogPath
};
