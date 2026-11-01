/*
 * lib/iptv-worker.js - one IPTV job in a process of its own
 *
 * Started by lib/iptv.js as `node iptv-worker.js`, in its own process group,
 * under nice where the TV has it. The job comes as one JSON line on stdin;
 * the worker answers with short JSON lines on stdout ({"child":pid},
 * {"progress":..}, then {"done":true,..} or {"error":{code,status}}) and
 * exits. stdin closing means the server has gone: the worker kills its
 * download and exits too.
 *
 * Everything that reads the owner's provider data runs here, never in the
 * server: downloading the playlist and guide, parsing them, writing the
 * snapshot files, fetching logos, and browsing or searching the index. The
 * server reads only the small files a job publishes (meta.json, groups.json,
 * added.json, nownext.json, a result file), each held under a byte limit here.
 *
 * Downloads go through curl or wget (node 0.12 cannot speak the TLS most
 * servers use) and are parsed as they arrive, so a 200 MB guide is never on
 * disk whole. Errors are codes, never a provider's or curl's own words, which
 * can carry the URL and with it the account's password.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var spawn = require('child_process').spawn;
var StringDecoder = require('string_decoder').StringDecoder;
var parse = require('./iptv-parse');
var allocBuffer = require('./util').allocBuffer;

var MB = 1024 * 1024;
var CEIL = {
  // A full lineup carries its channel names and groups to the worker.
  jobBytes: 4 * MB,
  downloadBytes: 300 * MB,
  unzippedBytes: 1536 * MB,
  // Files the server reads.
  metaBytes: 16 * 1024,
  groupsBytes: 384 * 1024,
  // A lineup of 2,000 channels, about 250 bytes each.
  addedBytes: 1024 * 1024,
  nownextBytes: 512 * 1024,
  resultBytes: 96 * 1024,
  streamBytes: 4 * 1024,
  logoBytes: 256 * 1024,
  logosTotal: 32 * MB
};
// A group section carries at most this many of its group's channels.
var GROUP_MAX = 1000;
var LINEUP_MAX = 2000;
// New logos fetched in one select job; the rest wait for the next (added.json logosLeft).
var LOGOS_PER_RUN = 300;
// Channels that are not favourites keep a shorter guide: the lineup can be 2,000 of them.
var GUIDE_LINEUP_AHEAD_MS = 26 * 3600000;
var GUIDE_LINEUP_PROGS = 80;
var GUIDE_LINEUP_DESC = 160;
// nownext.json: from an hour back, for a programme still running, to this far ahead.
var NOWNEXT_AHEAD_MS = 6 * 3600000;
var NOWNEXT_BACK_MS = 3600000;
// The guide's window: what the grid can show.
var GUIDE_BACK_MS = 2 * 3600000;
var GUIDE_AHEAD_MS = 48 * 3600000;
var PAGE = 50;
var PAGE_MAX = 200;
var SEARCH_MAX = 100;
// Provider requests a second, at most (short EPG, logos).
var REQUEST_GAP_MS = 500;

var job = null;
var children = [];
// Bytes this job has written, against the room the server found for it (job.diskLimit).
var written = 0;

function charge(bytes) {
  written += bytes;
  if (job && job.diskLimit && written > job.diskLimit) throw fail('disk');
}
var finished = false;
var umask = 63; // 077

// ---------------------------------------------------------------- protocol

function say(obj) {
  var line = JSON.stringify(obj);
  if (line.length > 4000) line = JSON.stringify({ progress: { truncated: true } });
  try { process.stdout.write(line + '\n'); } catch (e) {}
}

function killChildren() {
  children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
  children = [];
}

function finish(err, result) {
  if (finished) return;
  finished = true;
  killChildren();
  if (err) {
    var code = typeof err === 'string' ? err : err.code === 'ENOSPC' || err.code === 'EDQUOT' ? 'disk'
      : (err.code && /^[a-z\-]+$/.test(err.code) ? err.code : 'failed');
    var out = { code: code };
    if (err.status) out.status = err.status;
    if (err.retryAfter) out.retryAfter = err.retryAfter;
    if (err.detail) out.detail = String(err.detail).slice(0, 40);
    // A crash's own message names a file at most, never a URL.
    if (code === 'failed' && err.message) console.error('iptv-worker: ' + String(err.message).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200));
    say({ error: out });
  } else {
    result = result || {};
    result.done = true;
    say(result);
  }
  // Let stdout drain before going.
  setTimeout(function () { process.exit(err ? 1 : 0); }, 50);
}

function fail(code, extra) {
  var e = new Error(code);
  /** @type {any} */ var any = e;
  any.code = code;
  if (extra) for (var k in extra) any[k] = extra[k];
  return e;
}

// ---------------------------------------------------------------- files

function mkdirs(dir) {
  if (fs.existsSync(dir)) return;
  mkdirs(path.dirname(dir));
  try { fs.mkdirSync(dir, 448); } catch (e) { if (!fs.existsSync(dir)) throw e; }
}

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (n) { rmTree(path.join(p, n)); });
    try { fs.rmdirSync(p); } catch (e) {}
  } else {
    try { fs.unlinkSync(p); } catch (e) {}
  }
}

// A file the server will read, refused when over its limit.
function writeLimited(file, text, limit) {
  var bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limit) throw fail('limit-output', { detail: path.basename(file) });
  charge(bytes);
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 384 });
}

// Lines written in batches with writeSync: a worker may block on its own disk.
function Writer(file) {
  this.fd = fs.openSync(file, 'w', 384);
  this.buf = '';
}
Writer.prototype.line = function (s) {
  this.buf += s + '\n';
  if (this.buf.length > 65536) this.flush();
};
Writer.prototype.flush = function () {
  if (this.buf) {
    charge(Buffer.byteLength(this.buf, 'utf8'));
    fs.writeSync(this.fd, this.buf);
  }
  this.buf = '';
};
Writer.prototype.close = function () {
  this.flush();
  fs.closeSync(this.fd);
};

// Each line of a file, read in blocks, to fn; fn returning false stops early.
function eachLine(file, fn) {
  var fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return false; }
  var buf = allocBuffer(65536), rest = '', n, stop = false;
  var dec = new StringDecoder('utf8');
  try {
    while (!stop && (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      var s = rest + dec.write(buf.slice(0, n));
      var start = 0, i;
      while ((i = s.indexOf('\n', start)) !== -1) {
        if (fn(s.slice(start, i)) === false) { stop = true; break; }
        start = i + 1;
      }
      rest = s.slice(start);
    }
    if (!stop && rest) fn(rest);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// ---------------------------------------------------------------- downloads

function clientFor() {
  var list = (job.clients || []).concat(['/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl', '/usr/bin/wget', '/bin/wget']);
  for (var i = 0; i < list.length; i++) {
    try { if (list[i] && fs.existsSync(list[i])) return list[i]; } catch (e) {}
  }
  return null;
}

function isWget(bin) { return /wget$/.test(bin); }

/*
 * Streams url to sink.push(text) and sink.end(). A gzip body, told by its
 * first bytes rather than its name or headers, is unzipped on the way.
 * opts: maxBytes, timeoutS, binary (sink.push gets Buffers, no unzip).
 * cb(err) with a code: network, timeout, http (status), login (401/403),
 * busy (429, retryAfter), limit-download, limit-unzipped, empty.
 */
function download(url, opts, sink, cb) {
  var bin = clientFor();
  if (!bin) return cb(fail('no-client'));
  var hdrFile = path.join(job.tmp || '/tmp', 'h-' + process.pid + '-' + Date.now());
  var maxBytes = opts.maxBytes || CEIL.downloadBytes;
  var ua = job.ua || 'Glasshouse';
  var args = isWget(bin)
    ? ['-q', '-T', '60', '-U', ua, '-O', '-', '--', url]
    : ['-sS', '-f', '-L', '--max-redirs', '5', '--proto', '=http,https', '--proto-redir', '=http,https',
       '--connect-timeout', '20', '--speed-limit', '256', '--speed-time', '60',
       '--max-time', String(opts.timeoutS || 600), '-A', ua, '-D', hdrFile, '--', url];
  var child;
  try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return cb(fail('no-client')); }
  children.push(child);
  say({ child: child.pid });
  var bytes = 0, unzipped = 0, first = true, gunzip = null, stderr = '', done = false, sinkErr = null;
  var dec = new StringDecoder('utf8');

  function end(err) {
    if (done) return;
    done = true;
    children = children.filter(function (c) { return c !== child; });
    try { fs.unlinkSync(hdrFile); } catch (e) {}
    cb(err);
  }
  function feed(chunk) {
    if (sinkErr) return;
    try {
      if (opts.binary) sink.push(chunk);
      else sink.push(dec.write(chunk));
    } catch (e) {
      sinkErr = e;
      try { child.kill('SIGKILL'); } catch (x) {}
    }
  }
  child.stdout.on('data', function (chunk) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      sinkErr = fail('limit-download');
      try { child.kill('SIGKILL'); } catch (e) {}
      return;
    }
    if (first) {
      first = false;
      if (!opts.binary && chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
        gunzip = zlib.createGunzip();
        gunzip.on('data', function (d) {
          unzipped += d.length;
          if (unzipped > CEIL.unzippedBytes) {
            sinkErr = fail('limit-unzipped');
            try { child.kill('SIGKILL'); } catch (e) {}
            return;
          }
          feed(d);
        });
        gunzip.on('error', function () { if (!sinkErr) sinkErr = fail('format', { detail: 'gzip' }); });
      }
    }
    if (gunzip) gunzip.write(chunk);
    else feed(chunk);
  });
  child.stderr.on('data', function (d) { if (stderr.length < 2000) stderr += d; });
  child.on('error', function () { end(fail('no-client')); });
  child.on('close', function (code) {
    var after = function () {
      if (sinkErr) return end(sinkErr);
      if (code !== 0) return end(downloadError(bin, code, stderr, hdrFile));
      if (!bytes) return end(fail('empty'));
      try {
        if (!opts.binary) { var tail = dec.end(); if (tail) sink.push(tail); }
        if (sink.end) sink.end();
      } catch (e) { return end(e); }
      end(null);
    };
    if (gunzip) {
      gunzip.on('end', after);
      gunzip.end();
    } else after();
  });
}

// curl's and wget's failures as codes. Their messages are not passed on.
function downloadError(bin, code, stderr, hdrFile) {
  var text = String(stderr || '');
  var m = /returned error:?\s*(?:HTTP\/[\d.]+\s+)?([1-5]\d\d)/i.exec(text) || /\b(?:ERROR|error:? HTTP\/[\d.]+)\s+([1-5]\d\d)\b/i.exec(text);
  var status = m ? parseInt(m[1], 10) : 0;
  if (!status && code === 22) {
    var lastStatus = 0;
    try {
      String(fs.readFileSync(hdrFile, 'utf8')).split('\n').forEach(function (l) {
        var s = /^HTTP\/[\d.]+\s+(\d{3})/.exec(l);
        if (s) lastStatus = +s[1];
      });
    } catch (e) {}
    status = lastStatus;
  }
  if (status === 429) {
    var ra = 0;
    try {
      var h = /\nretry-after:\s*(\d+)/i.exec('\n' + fs.readFileSync(hdrFile, 'utf8'));
      if (h) ra = Math.min(86400, +h[1]);
    } catch (e) {}
    return fail('busy', { status: 429, retryAfter: ra || undefined });
  }
  if (status === 401 || status === 403) return fail('login', { status: status });
  if (status) return fail('http', { status: status });
  if (isWget(bin)) return fail(/timed out/i.test(text) ? 'timeout' : 'network');
  if (code === 28) return fail('timeout');
  if (code === 6 || code === 7 || code === 35 || code === 52 || code === 56) return fail('network');
  if (code === 63) return fail('limit-download');
  // The body ended before its Content-Length: cut off part way.
  if (code === 18) return fail('truncated');
  return fail('network', { detail: 'exit ' + code });
}

// A small JSON document, into memory: an account answer or a category list.
function getJson(url, maxBytes, cb) {
  var text = '';
  download(url, { maxBytes: maxBytes, timeoutS: 60 }, { push: function (s) { text += s; } }, function (err) {
    if (err) return cb(err);
    var doc;
    try { doc = JSON.parse(text); } catch (e) { return cb(fail('format', { detail: 'json' })); }
    cb(null, doc);
  });
}

// ---------------------------------------------------------------- playlist

function xtreamBase(src) {
  return String(src.server || '').replace(/\/+$/, '');
}

function xtreamApi(src, action, extra) {
  return xtreamBase(src) + '/player_api.php?username=' + encodeURIComponent(src.user) +
    '&password=' + encodeURIComponent(src.pass) + (action ? '&action=' + action : '') + (extra || '');
}

function xtreamStreamUrl(src, id, ext) {
  return xtreamBase(src) + '/live/' + encodeURIComponent(src.user) + '/' + encodeURIComponent(src.pass) + '/' + id + '.' + ext;
}

/*
 * index.tsv, one live channel a line:
 *   key group name number epgId logo flags dupe shift
 * flags: h needs headers, d DRM, u not http(s). dupe: "2/3" where entries
 * share name, group and tvg-id.
 */
function indexLine(e) {
  var flags = (e.headers ? 'h' : '') + (e.drm ? 'd' : '') + (e.unsupported ? 'u' : '');
  return [e.key, parse.cell(e.group, 120), parse.cell(e.name, 200), parse.cell(e.number, 12), parse.cell(e.tvgId, 200),
    parse.safeDerivedUrl(e.logo) ? e.logo.replace(/\t/g, '') : '', flags, e.dupe || '', e.shift || ''].join('\t');
}

function readIndexLine(line) {
  var p = line.split('\t');
  if (p.length < 7) return null;
  return { key: p[0], group: p[1], name: p[2], number: p[3], epgId: p[4], logo: p[5], flags: p[6], dupe: p[7] || '', shift: parseFloat(p[8]) || 0 };
}

function Groups() { this.order = []; this.counts = {}; }
Groups.prototype.add = function (g) {
  if (!this.counts.hasOwnProperty(g)) { this.counts[g] = 0; this.order.push(g); }
  this.counts[g]++;
};
Groups.prototype.list = function (max) {
  var self = this;
  return this.order.slice(0, max).map(function (g) { return { name: parse.clip(g, 80), count: self.counts[g] }; });
};

/*
 * groups.json: every group, its name as index.tsv has it (a group section
 * matches it exactly) and its count, in the provider's order. Too many to
 * fit lists fewer rather than refusing the snapshot.
 */
function writeGroups(dir, groups) {
  var list = groups.order.map(function (g) { return [g, groups.counts[g]]; });
  var text = JSON.stringify({ total: list.length, groups: list });
  while (Buffer.byteLength(text, 'utf8') > CEIL.groupsBytes && list.length > 100) {
    list = list.slice(0, Math.floor(list.length * 0.8));
    text = JSON.stringify({ total: groups.order.length, groups: list, cut: true });
  }
  writeLimited(path.join(dir, 'groups.json'), text, CEIL.groupsBytes);
}

function playlistJob(cb) {
  var src = job.source;
  if (src.kind === 'xtream') return xtreamPlaylist(src, cb);
  m3uPlaylist(src, cb);
}

function m3uPlaylist(src, cb) {
  var tmp = job.tmp;
  var entriesFile = path.join(tmp, 'entries.tmp');
  var w = new Writer(entriesFile);
  var fresh = [];
  var dupeCount = {};
  var guides = [];
  var count = 0;
  var reader = new parse.M3uReader(function (e) {
    var dupeId = parse.sha1([e.name, e.group, e.tvgId].join('\u0001')).slice(0, 16);
    var ord = dupeCount[dupeId] = (dupeCount[dupeId] || 0) + 1;
    var digest = parse.urlDigest(e.url), hint = parse.entryHint(e);
    fresh.push({ digest: digest, hint: hint });
    w.line([digest, hint, dupeId, ord, parse.cell(e.group, 120), parse.cell(e.name, 200), parse.cell(e.number, 12), parse.cell(e.tvgId, 200),
      parse.safeDerivedUrl(e.logo) ? e.logo.replace(/\t/g, '') : '', (e.headers ? 'h' : '') + (e.drm ? 'd' : '') + (e.unsupported ? 'u' : ''),
      e.shift || '', e.url.replace(/[\t\n]/g, '')].join('\t'));
    if (++count % 20000 === 0) say({ progress: { entries: count } });
  }, function (u) { if (parse.safeDerivedUrl(u) && guides.length < 4 && guides.indexOf(u) === -1) guides.push(u); });
  var sawText = false;
  download(src.url, { maxBytes: CEIL.downloadBytes, timeoutS: 600 }, {
    push: function (s) { if (!sawText && /\S/.test(s)) sawText = true; reader.push(s); },
    end: function () { reader.end(); }
  }, function (err) {
    try { w.close(); } catch (e) {}
    if (err) return cb(err);
    if (!count) return cb(fail(reader.seenHeader ? 'empty' : 'format', { detail: 'm3u' }));
    // Keys from the last snapshot, carried where the entry is the same one.
    var old = [];
    if (job.prev) {
      eachLine(path.join(job.prev, 'keys.tsv'), function (l) {
        var p = l.split('\t');
        if (p.length >= 3) old.push({ key: p[0], digest: p[1], hint: p[2] });
      });
    }
    var keys = parse.carryKeys(old, fresh);
    old = null;
    fresh = null;
    var index = new Writer(path.join(tmp, 'index.tsv'));
    var urls = new Writer(path.join(tmp, 'urls.tsv'));
    var keyFile = new Writer(path.join(tmp, 'keys.tsv'));
    var groups = new Groups(), i = 0, flagged = { headers: 0, drm: 0 };
    eachLine(entriesFile, function (l) {
      var p = l.split('\t');
      var key = keys[i++];
      var total = dupeCount[p[2]];
      var e = { key: key, group: p[4], name: p[5], number: p[6], tvgId: p[7], logo: p[8],
        headers: p[9].indexOf('h') !== -1, drm: p[9].indexOf('d') !== -1, unsupported: p[9].indexOf('u') !== -1,
        dupe: total > 1 ? p[3] + '/' + total : '', shift: p[10] };
      if (e.headers) flagged.headers++;
      if (e.drm) flagged.drm++;
      groups.add(e.group);
      index.line(indexLine(e));
      urls.line(key + '\t' + p[11]);
      keyFile.line(key + '\t' + p[0] + '\t' + p[1]);
    });
    index.close(); urls.close(); keyFile.close();
    try { fs.unlinkSync(entriesFile); } catch (e) {}
    if (guides.length) writeLimited(path.join(tmp, 'guides.txt'), guides.join('\n'), 16384);
    var meta = { kind: 'm3u', at: Date.now(), channels: count, dropped: reader.dropped, groupsTotal: groups.order.length,
      groups: groups.list(200), headers: flagged.headers, drm: flagged.drm, guideInPlaylist: guides.length > 0 };
    writeMeta(tmp, meta);
    writeGroups(tmp, groups);
    cb(null, { channels: count, groups: groups.order.length });
  });
}

function writeMeta(dir, meta) {
  var text = JSON.stringify(meta);
  // Very many groups: fewer listed rather than the snapshot refused.
  while (Buffer.byteLength(text, 'utf8') > CEIL.metaBytes && meta.groups.length > 10) {
    meta.groups = meta.groups.slice(0, Math.floor(meta.groups.length * 0.75));
    text = JSON.stringify(meta);
  }
  writeLimited(path.join(dir, 'meta.json'), text, CEIL.metaBytes);
}

function xtreamPlaylist(src, cb) {
  var tmp = job.tmp;
  getJson(xtreamApi(src), MB, function (err, doc) {
    if (err) return cb(err);
    var acct = parse.xtreamAccount(doc);
    if (!acct.ok) return cb(fail(acct.code, acct.status ? { detail: acct.status } : null));
    say({ progress: { account: true } });
    getJson(xtreamApi(src, 'get_live_categories'), 8 * MB, function (err2, cats) {
      if (err2) return cb(err2);
      var catNames = {}, catOrder = [];
      (Object.prototype.toString.call(cats) === '[object Array]' ? cats : []).forEach(function (c) {
        if (c && c.category_id !== undefined) {
          catNames[String(c.category_id)] = String(c.category_name || '');
          catOrder.push(String(c.category_id));
        }
      });
      var ext = parse.xtreamExtension(acct.formats);
      var index = new Writer(path.join(tmp, 'index.tsv'));
      var urls = new Writer(path.join(tmp, 'urls.tsv'));
      var groups = new Groups(), count = 0, dupeCount = {};
      var reader = new parse.JsonArrayReader(function (s) {
        if (!s || typeof s !== 'object' || s.stream_id === undefined) return;
        if (s.stream_type && s.stream_type !== 'live' && s.stream_type !== 'created_live' && s.stream_type !== 'radio_streams') return;
        var id = parseInt(s.stream_id, 10);
        if (!(id >= 0)) return;
        var e = { key: 'x' + id, group: catNames[String(s.category_id)] || '', name: String(s.name || ''),
          number: s.num !== undefined && s.num !== null ? String(s.num) : '', tvgId: String(s.epg_channel_id || ''),
          logo: String(s.stream_icon || ''), radio: s.stream_type === 'radio_streams' };
        var dupeId = parse.sha1([e.name, e.group, e.tvgId].join('\u0001')).slice(0, 16);
        e.ord = dupeCount[dupeId] = (dupeCount[dupeId] || 0) + 1;
        e.dupeId = dupeId;
        groups.add(e.group);
        index.line(indexLine(e));
        urls.line(e.key + '\t' + xtreamStreamUrl(src, id, ext));
        if (++count % 20000 === 0) say({ progress: { entries: count } });
        if (count > parse.LIMITS.entries) throw parse.LimitError('limit-entries');
      });
      download(xtreamApi(src, 'get_live_streams'), { maxBytes: CEIL.downloadBytes, timeoutS: 600 }, reader, function (err3) {
        index.close(); urls.close();
        if (err3) return cb(err3);
        var other = reader.notArray();
        if (other !== null) {
          // An object where the list should be: a refusal some panels send with 200.
          var again = other && parse.xtreamAccount(other);
          return cb(fail(again && again.code === 'login' ? 'login' : 'format', { detail: 'streams' }));
        }
        if (!count) return cb(fail('empty'));
        // Duplicates are labelled "2 of 3" once every entry has been seen.
        var needDupes = false;
        for (var d in dupeCount) if (dupeCount[d] > 1) { needDupes = true; break; }
        if (needDupes) relabelDupes(path.join(tmp, 'index.tsv'), dupeCount);
        var meta = { kind: 'xtream', at: Date.now(), channels: count, dropped: 0, groupsTotal: groups.order.length,
          groups: groups.list(200), headers: 0, drm: 0, guideInPlaylist: false,
          account: { expires: acct.expires, maxConnections: acct.maxConnections, activeConnections: acct.activeConnections,
            trial: acct.trial, format: ext } };
        writeMeta(tmp, meta);
        writeGroups(tmp, groups);
        cb(null, { channels: count, groups: groups.order.length });
      });
    });
  });
}

// Writes the "n/total" column for Xtream entries that share name, group and guide id.
function relabelDupes(file, dupeCount) {
  var out = new Writer(file + '.new');
  var seen = {};
  eachLine(file, function (l) {
    var e = readIndexLine(l);
    if (!e) return;
    var dupeId = parse.sha1([e.name, e.group, e.epgId].join('\u0001')).slice(0, 16);
    var total = dupeCount[dupeId] || 1;
    var ord = seen[dupeId] = (seen[dupeId] || 0) + 1;
    var p = l.split('\t');
    p[7] = total > 1 ? ord + '/' + total : '';
    out.line(p.join('\t'));
  });
  out.close();
  fs.renameSync(file + '.new', file);
}

// ---------------------------------------------------------------- selection

/*
 * The owner's added channels from one playlist: added.json, a play URL
 * each in streams/, and their logos. A key gone from the playlist is
 * matched again only to the one entry with its name and group (or its
 * tvg-id, where unique); otherwise it stays missing for the owner to pick
 * again.
 */
/*
 * The lineup's channels in a playlist, read from its snapshot: the ones
 * asked for by key (job.keys: picks, favourites, renamed), followed when a
 * refresh moved them, and each group section's channels (job.groups), in
 * the provider's order less the ones taken out. Writes added.json, a play
 * link a channel under streams/, and the logos.
 */
function selectJob(cb) {
  var snap = job.snap, out = job.tmp;
  var wanted = {}, found = {}, missingKeys = [];
  (job.keys || []).forEach(function (w) { wanted[w.key] = w; });
  var bySection = {}, byGroup = {}, groupsCut = {}, carried = 0;
  (job.groups || []).forEach(function (g) {
    bySection[g.id] = [];
    var ex = {};
    (g.except || []).forEach(function (k) { ex[k] = true; });
    (byGroup[g.group] = byGroup[g.group] || []).push({ id: g.id, except: ex });
  });
  var byNameGroup = {}, byEpg = {};
  var nameGroupOf = function (n, g) { return parse.normalise(n) + '\u0001' + g; };
  (job.keys || []).forEach(function (w) {
    if (w.name) byNameGroup[nameGroupOf(w.name, w.group)] = [];
    if (w.epgId) byEpg[w.epgId] = [];
  });
  var ok = eachLine(path.join(snap, 'index.tsv'), function (l) {
    var e = readIndexLine(l);
    if (!e) return;
    if (wanted.hasOwnProperty(e.key)) found[e.key] = e;
    var secs = byGroup.hasOwnProperty(e.group) ? byGroup[e.group] : null;
    if (secs && !SEPARATOR.test(e.name)) {
      secs.forEach(function (sec) {
        if (sec.except[e.key]) return;
        var list = bySection[sec.id];
        if (list.length >= GROUP_MAX || carried >= LINEUP_MAX) { groupsCut[sec.id] = true; return; }
        list.push(e.key);
        carried++;
        found[e.key] = e;
      });
    }
    var ng = byNameGroup[nameGroupOf(e.name, e.group)];
    if (ng && ng.length < 2) ng.push(e);
    var ep = e.epgId && byEpg[e.epgId];
    if (ep && ep.length < 2) ep.push(e);
  });
  if (!ok) return cb(fail('no-snapshot'));
  var rematch = {};
  Object.keys(wanted).forEach(function (k) {
    if (found[k]) return;
    var w = wanted[k];
    var ng = w.name ? byNameGroup[nameGroupOf(w.name, w.group)] || [] : [];
    var ep = w.epgId ? byEpg[w.epgId] || [] : [];
    var hit = ng.length === 1 ? ng[0] : ep.length === 1 ? ep[0] : null;
    if (hit && !wanted.hasOwnProperty(hit.key) && !found[hit.key]) {
      found[hit.key] = hit;
      rematch[k] = hit.key;
    } else missingKeys.push(k);
  });
  mkdirs(path.join(out, 'streams'));
  var streamsLeft = {}, leftCount = 0;
  Object.keys(found).forEach(function (k) { streamsLeft[k] = true; leftCount++; });
  if (leftCount) {
    eachLine(path.join(snap, 'urls.tsv'), function (l) {
      var tab = l.indexOf('\t');
      var k = l.slice(0, tab);
      if (!streamsLeft[k]) return;
      delete streamsLeft[k];
      var url = l.slice(tab + 1);
      if (url.length < CEIL.streamBytes && /^https?:\/\//i.test(url)) writeLimited(path.join(out, 'streams', k), url, CEIL.streamBytes);
      if (--leftCount === 0) return false;
    });
  }
  // Logos: the favourites' first, as Home's row shows them; then in the lineup's order.
  var channels = {}, logoJobs = [], queued = {};
  function logoFor(k) {
    var e = found[k];
    if (!e || queued[k] || !e.logo) return;
    queued[k] = true;
    logoJobs.push({ key: k, id: parse.sha1(e.logo).slice(0, 16), url: e.logo });
  }
  Object.keys(found).forEach(function (k) {
    var e = found[k];
    channels[k] = { name: parse.clip(e.name, 80), group: e.group, number: e.number, epgId: parse.clip(e.epgId, 120),
      logo: null, headers: e.flags.indexOf('h') !== -1, drm: e.flags.indexOf('d') !== -1,
      unsupported: e.flags.indexOf('u') !== -1, dupe: e.dupe, shift: e.shift || 0 };
  });
  (job.favs || []).forEach(logoFor);
  (job.keys || []).forEach(function (w) { logoFor(rematch[w.key] || w.key); });
  Object.keys(bySection).forEach(function (sid) { bySection[sid].forEach(logoFor); });
  var prev = job.prevSel ? readJsonSmall(path.join(job.prevSel, 'added.json'), CEIL.addedBytes) : null;
  fetchLogos(logoJobs, path.join(out, 'logos'), job.prevSel ? path.join(job.prevSel, 'logos') : null, prev && prev.logoFail || {}, function (got, left, logoFail) {
    Object.keys(got).forEach(function (k) { if (channels[k]) channels[k].logo = got[k]; });
    var added = { at: Date.now(), channels: channels, groups: bySection, groupsCut: groupsCut, rematch: rematch, missing: missingKeys,
      logosLeft: left, logoFail: logoFail };
    var text = JSON.stringify(added);
    // Names are cut before the file is refused.
    if (Buffer.byteLength(text, 'utf8') > CEIL.addedBytes) {
      Object.keys(channels).forEach(function (k) { channels[k].name = parse.clip(channels[k].name, 40); channels[k].group = parse.clip(channels[k].group, 30); });
      added.logoFail = {};
      text = JSON.stringify(added);
    }
    try { writeLimited(path.join(out, 'added.json'), text, CEIL.addedBytes); } catch (e) { return cb(e); }
    cb(null, { found: Object.keys(found).length, missing: missingKeys.length, rematched: Object.keys(rematch).length, logosLeft: left });
  });
}

function readJsonSmall(file, limit) {
  try {
    var st = fs.statSync(file);
    if (!st.isFile() || st.size > limit) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return null; }
}

// A file of the last candidate's in this one: a hard link where the filesystem allows, else a copy.
function carryFile(from, to) {
  try { fs.linkSync(from, to); return fs.statSync(to).size; } catch (e) {}
  var buf = fs.readFileSync(from);
  charge(buf.length);
  fs.writeFileSync(to, buf, { mode: 384 });
  return buf.length;
}

/*
 * Each logo checked by its first bytes and size before it is kept; one the
 * last selection had is carried over. At most two requests a second,
 * LOGOS_PER_RUN new ones a job (the next job fetches more), and 32 MB in
 * all. A logo that failed is not asked for again for a day.
 * cb(got, left, failures).
 */
var LOGO_RETRY_MS = 24 * 3600000;
function fetchLogos(list, dir, prevDir, failedBefore, cb) {
  var got = {}, total = 0, i = 0, fetched = 0, left = 0, seen = {}, now = Date.now();
  var failures = {};
  Object.keys(failedBefore).forEach(function (id) {
    if (/^[0-9a-f]{16}$/.test(id) && typeof failedBefore[id] === 'number' && now - failedBefore[id] < LOGO_RETRY_MS) failures[id] = failedBefore[id];
  });
  if (!list.length || job.noLogos) return cb(got, 0, failures);
  mkdirs(dir);
  function next() {
    while (i < list.length && !finished) {
      var l = list[i++];
      var file = path.join(dir, l.id);
      // Several channels can share one logo.
      if (seen.hasOwnProperty(l.id)) { if (seen[l.id]) got[l.key] = l.id; continue; }
      if (failures[l.id]) { seen[l.id] = false; continue; }
      if (prevDir && total < CEIL.logosTotal) {
        try {
          total += carryFile(path.join(prevDir, l.id), file);
          seen[l.id] = true;
          got[l.key] = l.id;
          continue;
        } catch (e) {}
      }
      if (fetched >= (typeof job.logoBudget === 'number' && job.logoBudget > 0 ? job.logoBudget : LOGOS_PER_RUN) || total >= CEIL.logosTotal) { left++; continue; }
      fetched++;
      return download1(l, file);
    }
    cb(got, left, failures);
  }
  function download1(l, file) {
    var bufs = [], size = 0;
    download(l.url, { maxBytes: CEIL.logoBytes, timeoutS: 15, binary: true }, {
      push: function (b) { bufs.push(b); size += b.length; }
    }, function (err) {
      var buf = err ? null : Buffer.concat(bufs, size);
      if (buf && parse.imageType(buf) && total + size <= CEIL.logosTotal) {
        try { charge(size); } catch (e) { return cb(got, left, failures); }
        fs.writeFileSync(file, buf, { mode: 384 });
        total += size;
        seen[l.id] = true;
        got[l.key] = l.id;
      } else {
        seen[l.id] = false;
        failures[l.id] = now;
      }
      setTimeout(next, REQUEST_GAP_MS);
    });
  }
  next();
}

// ---------------------------------------------------------------- guide

/*
 * schedule/<key>/<YYYYMMDD>.json, a UTC day of one channel each, for the
 * grid; nownext.json for the row, the band and the channel list.
 */
function writeSchedule(dir, progs, now, carried) {
  mkdirs(path.join(dir, 'schedule'));
  Object.keys(progs).forEach(function (key) {
    var list = progs[key];
    if (!list.length || (carried && carried[key])) return;
    var days = {};
    list.forEach(function (p) {
      var d = new Date(p.start), day = d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
      (days[day] = days[day] || []).push([p.start, p.stop, parse.clip(p.title, 120), parse.clip(p.desc, p.descMax || 400)]);
    });
    mkdirs(path.join(dir, 'schedule', key));
    Object.keys(days).forEach(function (day) {
      var text = JSON.stringify(days[day]);
      charge(Buffer.byteLength(text, 'utf8'));
      fs.writeFileSync(path.join(dir, 'schedule', key, day + '.json'), text, { mode: 384 });
    });
  });
  writeNowNext(dir, progs, now);
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function writeNowNext(dir, progs, now) {
  var from = now - NOWNEXT_BACK_MS, to = now + NOWNEXT_AHEAD_MS;
  var perChannel = 12, text;
  for (;;) {
    var ch = {};
    Object.keys(progs).forEach(function (key) {
      var list = progs[key].filter(function (p) { return p.stop > from && p.start < to; }).slice(0, perChannel);
      if (list.length) ch[key] = list.map(function (p) { return [p.start, p.stop, parse.clip(p.title, 80)]; });
    });
    text = JSON.stringify({ at: now, from: from, to: to, ch: ch });
    if (Buffer.byteLength(text, 'utf8') <= CEIL.nownextBytes || perChannel <= 2) break;
    perChannel = Math.max(2, Math.floor(perChannel / 2));
  }
  writeLimited(path.join(dir, 'nownext.json'), text, CEIL.nownextBytes);
}

/*
 * The last guide's files for channels this job has nothing new for (a
 * favourite's short EPG when the XMLTV has none of it; the rest of the
 * lineup when only the favourites' short EPG was asked for), linked rather
 * than copied, with their programmes in nownext.json as well. Days the grid
 * can no longer show stay behind.
 */
function carryGuide(prevGuide, out, keys, progs, now) {
  var carried = {};
  if (!prevGuide) return carried;
  var from = path.join(prevGuide, 'schedule');
  var oldest = utcDay(now - GUIDE_BACK_MS - 24 * 3600000);
  keys.forEach(function (key) {
    if (!/^[a-z][0-9a-z]{1,24}$/.test(key)) return;
    var days;
    try { days = fs.readdirSync(path.join(from, key)); } catch (e) { return; }
    var list = [];
    days.sort().forEach(function (d) {
      if (!/^\d{8}\.json$/.test(d) || d.slice(0, 8) < oldest) return;
      var to = path.join(out, 'schedule', key, d);
      try {
        mkdirs(path.join(out, 'schedule', key));
        carryFile(path.join(from, key, d), to);
        JSON.parse(fs.readFileSync(to, 'utf8')).forEach(function (p) {
          if (p[1] > now - NOWNEXT_BACK_MS && p[0] < now + NOWNEXT_AHEAD_MS) list.push({ start: p[0], stop: p[1], title: p[2] });
        });
      } catch (e) {}
    });
    if (!fs.existsSync(path.join(out, 'schedule', key))) return;
    carried[key] = true;
    progs[key] = list;
  });
  return carried;
}

function utcDay(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}

// Sorted by start; a programme with no stop runs to the next one's start.
function tidy(list, shiftMs) {
  list.sort(function (a, b) { return a.start - b.start; });
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (shiftMs) { p.start += shiftMs; if (p.stop) p.stop += shiftMs; }
    if (!p.stop) p.stop = list[i + 1] ? list[i + 1].start + (shiftMs || 0) : p.start + 3600000;
    if (p.stop <= p.start) continue;
    if (out.length && out[out.length - 1].start === p.start) continue;
    out.push(p);
  }
  return out;
}

function guideJob(cb) {
  var now = Date.now(), from = now - GUIDE_BACK_MS, to = now + GUIDE_AHEAD_MS;
  var wanted = job.channels || [];
  var progs = {}, caps = {};
  wanted.forEach(function (w) {
    progs[w.key] = [];
    caps[w.key] = w.fav ? { to: to, n: 400, desc: 400 } : { to: Math.min(to, now + GUIDE_LINEUP_AHEAD_MS), n: GUIDE_LINEUP_PROGS, desc: GUIDE_LINEUP_DESC };
  });
  var urls = (job.urls || []).filter(parse.safeDerivedUrl).slice(0, 4);
  if (!urls.length) return cb(fail('no-guide'));
  /*
   * Only guide channels that could match an added one are kept: a guide can
   * list 100,000 channels, and indexing all of them by name ran a 64 MB heap
   * out of memory on a 200 MB guide.
   */
  var guideIds = { ids: {}, byNorm: {} };
  var wantedIds = {}, wantedNorms = {};
  wanted.forEach(function (w) {
    if (w.epgId) wantedIds[w.epgId] = true;
    [parse.normalise(w.epgId), parse.normalise(w.name)].forEach(function (n) { if (n) wantedNorms[n] = true; });
  });
  var map = null, byGuide = {}, matched = 0, anyOk = false, lastErr = null, i = 0;
  function resolve() {
    map = parse.matchGuide(wanted, guideIds);
    byGuide = {};
    Object.keys(map).forEach(function (k) { (byGuide[map[k]] = byGuide[map[k]] || []).push(k); });
    matched = Object.keys(map).length;
  }
  (function nextUrl() {
    if (i >= urls.length) {
      if (!anyOk) return cb(lastErr || fail('no-guide'));
      var shifts = {};
      wanted.forEach(function (w) { shifts[w.key] = (w.shift || 0) * 3600000; });
      Object.keys(progs).forEach(function (k) { progs[k] = tidy(progs[k], shifts[k]); });
      var none = Object.keys(progs).filter(function (k) { return !progs[k].length; });
      var carried = carryGuide(job.prevGuide, job.tmp, none, progs, now);
      writeSchedule(job.tmp, progs, now, carried);
      return cb(null, { matched: matched, channels: wanted.length, carried: Object.keys(carried).length });
    }
    var url = urls[i++];
    map = null;
    var reader = new parse.XmltvReader(function (c) {
      if (!c.id) return;
      if (wantedIds[c.id]) guideIds.ids[c.id] = true;
      var norms = [parse.normalise(c.id)].concat(c.names.map(parse.normalise));
      var seen = {};
      norms.forEach(function (n) {
        if (!n || seen[n] || !wantedNorms[n]) return;
        seen[n] = true;
        var l = guideIds.byNorm[n] = guideIds.byNorm[n] || [];
        if (l.indexOf(c.id) === -1 && l.length < 3) l.push(c.id);
      });
    }, function (p) {
      if (!map) resolve();
      var keys = byGuide[p.channel];
      if (!keys || p.start === null) return;
      if (p.start > to || (p.stop !== null && p.stop < from)) return;
      var title = p.title + (p.sub && p.sub !== p.title ? ': ' + p.sub : '');
      keys.forEach(function (k) {
        var cap = caps[k];
        if (p.start > cap.to || progs[k].length >= cap.n) return;
        progs[k].push({ start: p.start, stop: p.stop, title: title, desc: p.desc, descMax: cap.desc });
      });
    });
    download(url, { maxBytes: CEIL.downloadBytes, timeoutS: 1200 }, reader, function (err) {
      if (err) { lastErr = err; return nextUrl(); }
      if (!map) resolve();
      anyOk = true;
      say({ progress: { guide: i, programmes: reader.programmes } });
      nextUrl();
    });
  })();
}

/*
 * Xtream's short EPG for each added channel: a request each, two a second at
 * most. Numeric timestamps, not the panel's local date strings.
 */
function epgJob(cb) {
  var src = job.source, now = Date.now();
  var list = (job.channels || []).filter(function (c) { return /^x\d+$/.test(c.key); });
  var progs = {}, failed = {}, i = 0, failures = 0, okCount = 0;
  (function next() {
    if (finished) return;
    if (i >= list.length) {
      if (!okCount && failures) return cb(fail('epg'));
      if (job.prevGuide) keepEarlier(progs, job.prevGuide, now, failed);
      Object.keys(progs).forEach(function (k) { progs[k] = tidy(progs[k], 0); });
      // The rest of the lineup keeps what the XMLTV guide gave it.
      var others = (job.carry || []).filter(function (k) { return !progs.hasOwnProperty(k); });
      var carried = carryGuide(job.prevGuide, job.tmp, others, progs, now);
      writeSchedule(job.tmp, progs, now, carried);
      return cb(null, { channels: okCount, carried: Object.keys(carried).length });
    }
    var c = list[i++];
    getJson(xtreamApi(src, 'get_short_epg', '&stream_id=' + c.key.slice(1) + '&limit=' + (job.limit || 12)), 2 * MB, function (err, doc) {
      // An expired or disabled account answers 200 with auth 0: stop, as for a 401.
      var refused = !err && doc && typeof doc === 'object' && doc.user_info && !parse.xtreamAccount(doc).ok;
      if (refused) return cb(fail('login'));
      if (err) {
        if (err.code === 'login' || err.code === 'busy') return cb(err);
        failures++;
        // Not answered: its last guide stands, rather than none.
        progs[c.key] = [];
        failed[c.key] = true;
      } else {
        okCount++;
        var l = doc && Object.prototype.toString.call(doc.epg_listings) === '[object Array]' ? doc.epg_listings : [];
        progs[c.key] = [];
        l.forEach(function (p) {
          var s = parseInt(p.start_timestamp, 10) * 1000, e = parseInt(p.stop_timestamp, 10) * 1000;
          if (!(s > 0) || !(e > s)) return;
          progs[c.key].push({ start: s, stop: e, title: parse.maybeBase64(p.title), desc: parse.maybeBase64(p.description) });
        });
      }
      setTimeout(next, REQUEST_GAP_MS);
    });
  })();
}

/*
 * A panel's short EPG can leave out the programme on now as it nears its end
 * (seen at 19:49 for one that ran 19:00 to 20:00): from the last guide, a
 * programme already started is kept where the new answer has nothing at
 * that time. A channel whose request failed keeps all of its last guide.
 */
function keepEarlier(progs, guideDir, now, failed) {
  Object.keys(progs).forEach(function (key) {
    var fresh = progs[key], dir = path.join(guideDir, 'schedule', key), days = [];
    try { days = fs.readdirSync(dir); } catch (e) { return; }
    days.forEach(function (d) {
      var list = [];
      try { list = JSON.parse(fs.readFileSync(path.join(dir, d), 'utf8')); } catch (e) { return; }
      list.forEach(function (p) {
        if (!(p[1] > now - NOWNEXT_BACK_MS)) return;
        if (!failed[key] && p[0] > now) return;
        for (var i = 0; i < fresh.length; i++) if (fresh[i].start < p[1] && p[0] < fresh[i].stop) return;
        fresh.push({ start: p[0], stop: p[1], title: p[2], desc: p[3] || '' });
      });
    });
  });
}

// nownext.json again from the guide's shards, with no network.
function nownextJob(cb) {
  var now = Date.now(), progs = {};
  var sched = path.join(job.guide, 'schedule');
  var keys = [];
  try { keys = fs.readdirSync(sched); } catch (e) { return cb(fail('no-guide')); }
  keys.forEach(function (k) {
    var list = [];
    try {
      fs.readdirSync(path.join(sched, k)).sort().forEach(function (d) {
        try {
          JSON.parse(fs.readFileSync(path.join(sched, k, d), 'utf8')).forEach(function (p) {
            if (p[1] > now - NOWNEXT_BACK_MS && p[0] < now + NOWNEXT_AHEAD_MS) list.push({ start: p[0], stop: p[1], title: p[2] });
          });
        } catch (e) {}
      });
    } catch (e) {}
    progs[k] = list;
  });
  writeNowNext(job.tmp, progs, now);
  cb(null, { channels: keys.length });
}

// ---------------------------------------------------------------- browse and search

// "### UK General ###", "----- SPORT -----": a provider's heading in its list, not a channel.
var SEPARATOR = /^\s*[#=*~\-_|\u2022]{2,}.*[#=*~\-_|\u2022]{2,}\s*$/;

function entryOut(e, dupes) {
  // The group whole, as index.tsv has it: a group section and the dashboards match it exactly.
  var o = { key: e.key, name: parse.clip(e.name, 80), group: e.group, number: e.number };
  if (e.flags.indexOf('h') !== -1) o.headers = true;
  if (e.flags.indexOf('d') !== -1) o.drm = true;
  if (e.flags.indexOf('u') !== -1) o.unsupported = true;
  if (e.dupe) o.dupe = e.dupe;
  return o;
}

function writeResult(obj) {
  var text = JSON.stringify(obj);
  while (Buffer.byteLength(text, 'utf8') > CEIL.resultBytes && obj.channels.length > 1) {
    obj.channels = obj.channels.slice(0, Math.floor(obj.channels.length * 0.8));
    obj.cut = true;
    text = JSON.stringify(obj);
  }
  writeLimited(job.out, text, CEIL.resultBytes);
}

function browseJob(cb) {
  var size = Math.max(1, Math.min(PAGE_MAX, job.size | 0 || PAGE));
  var group = job.group, page = Math.max(0, job.page | 0), skip = page * size;
  var n = 0, out = [];
  var ok = eachLine(path.join(job.snap, 'index.tsv'), function (l) {
    var e = readIndexLine(l);
    if (!e || (group !== null && group !== undefined && e.group !== group) || SEPARATOR.test(e.name)) return;
    if (n >= skip && out.length < size) out.push(entryOut(e));
    n++;
  });
  if (!ok) return cb(fail('no-snapshot'));
  writeResult({ group: group, page: page, size: size, total: n, channels: out });
  cb(null, { total: n });
}

/*
 * Every word of the query somewhere in the name, case and accents aside;
 * names starting with the query first.
 */
function searchJob(cb) {
  var words = String(job.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  var whole = words.join(' ');
  var group = job.group;
  // Groups the owner hid are left out of a search of the whole playlist.
  var hidden = {};
  (job.hidden || []).forEach(function (g) { hidden[g] = true; });
  var first = [], rest = [], total = 0;
  var ok = eachLine(path.join(job.snap, 'index.tsv'), function (l) {
    var e = readIndexLine(l);
    if (!e || (group && e.group !== group) || (!group && hidden[e.group]) || SEPARATOR.test(e.name)) return;
    var name = e.name.toLowerCase();
    for (var i = 0; i < words.length; i++) if (name.indexOf(words[i]) === -1) return;
    total++;
    if (name.indexOf(whole) === 0) { if (first.length < SEARCH_MAX) first.push(entryOut(e)); }
    else if (rest.length < SEARCH_MAX) rest.push(entryOut(e));
  });
  if (!ok) return cb(fail('no-snapshot'));
  writeResult({ q: whole, total: total, channels: first.concat(rest).slice(0, SEARCH_MAX) });
  cb(null, { total: total });
}

// ---------------------------------------------------------------- start

var JOBS = { playlist: playlistJob, select: selectJob, guide: guideJob, epg: epgJob, nownext: nownextJob,
  browse: browseJob, search: searchJob };

function run() {
  process.umask(umask);
  var fn = JOBS[job.type];
  if (!fn) return finish(fail('unknown-job'));
  if (job.tmp) {
    rmTree(job.tmp);
    mkdirs(job.tmp);
  }
  // A second line of defence: the server measures the whole process group.
  if (job.rssLimit) {
    setInterval(function () {
      if (process.memoryUsage().rss > job.rssLimit) {
        if (job.tmp) rmTree(job.tmp);
        finish(fail('memory'));
      }
    }, 1000);
  }
  try {
    fn(function (err, result) {
      // A candidate is the job's only output; a failed one is not left behind.
      if (err && job.tmp) rmTree(job.tmp);
      finish(err, result);
    });
  } catch (e) {
    if (job.tmp) rmTree(job.tmp);
    finish(e);
  }
}

if (require.main === module) {
  var input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (d) {
    if (finished || job) return;
    input += d;
    if (Buffer.byteLength(input, 'utf8') > CEIL.jobBytes) return finish(fail('bad-job'));
    var nl = input.indexOf('\n');
    if (nl === -1) return;
    try { job = JSON.parse(input.slice(0, nl)); } catch (e) { return finish(fail('bad-job')); }
    input = '';
    run();
  });
  // The server gone: nothing left to report to.
  process.stdin.on('end', function () {
    if (finished) return;
    killChildren();
    if (job && job.tmp) rmTree(job.tmp);
    process.exit(2);
  });
  process.on('SIGTERM', function () {
    killChildren();
    if (job && job.tmp) rmTree(job.tmp);
    process.exit(2);
  });
}

module.exports = { _download: download, _downloadError: downloadError, _tidy: tidy };
