/*
 * lib/iptv-parse.js - the readers for an owner's IPTV provider: M3U
 * playlists, Xtream JSON and XMLTV guides, and the rules that carry a
 * channel's key from one refresh to the next
 *
 * Used only by lib/iptv-worker.js, in a worker process: nothing here runs in
 * the server, which never reads provider data (PLANIPTV.md). Each reader is
 * fed the download a chunk at a time and keeps only what it must, so a
 * playlist of tens of MB or a guide of 200 MB passes through in bounded
 * memory.
 *
 * Strict ES5: runs on node 0.12.
 */
var crypto = require('crypto');
var toBuffer = require('./util').toBuffer;

// ---------------------------------------------------------------- limits

var LIMITS = {
  // One M3U entry, #EXTINF to its URL; past it the playlist is not one.
  entryBytes: 64 * 1024,
  entries: 500000,
  // One XMLTV element, <programme> to </programme>.
  elementBytes: 2 * 1024 * 1024,
  // One element of Xtream's JSON arrays.
  jsonElementBytes: 64 * 1024
};

function LimitError(code) {
  var e = new Error(code);
  /** @type {any} */ (e).code = code;
  return e;
}

// ---------------------------------------------------------------- text

/*
 * Lines from a stream of chunks, a partial last line kept for the next.
 * CRLF and a leading BOM are taken off. A line longer than maxLine fails
 * with limit-entry rather than growing without end.
 */
function LineSplitter(onLine, maxLine) {
  this.rest = '';
  this.first = true;
  this.onLine = onLine;
  this.maxLine = maxLine || LIMITS.entryBytes;
}
LineSplitter.prototype.push = function (text) {
  var s = this.rest + text;
  if (this.first && s.length) {
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    this.first = false;
  }
  var start = 0, i;
  while ((i = s.indexOf('\n', start)) !== -1) {
    var line = s.slice(start, i);
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    this.onLine(line);
    start = i + 1;
  }
  this.rest = s.slice(start);
  if (this.rest.length > this.maxLine) throw LimitError('limit-entry');
};
LineSplitter.prototype.end = function () {
  var line = this.rest;
  this.rest = '';
  if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
  if (line) this.onLine(line);
};

function clip(s, n) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Safe in a tab-separated line.
function cell(s, n) { return clip(s, n || 200).replace(/\t/g, ' '); }

// ---------------------------------------------------------------- M3U

/*
 * #EXTINF:-1 tvg-id="x" group-title="A, B",Name, with commas
 * The duration, then attributes, then the name after the first comma that
 * is not inside quotes (as Kodi's PVR IPTV Simple Client reads it).
 */
function parseExtinf(line) {
  var body = line.slice(line.indexOf(':') + 1);
  var quote = false, comma = -1;
  for (var i = 0; i < body.length; i++) {
    var c = body.charAt(i);
    if (c === '"') quote = !quote;
    else if (c === ',' && !quote) { comma = i; break; }
  }
  var head = comma === -1 ? body : body.slice(0, comma);
  var name = comma === -1 ? '' : body.slice(comma + 1);
  return { attrs: parseAttrs(head), name: name.replace(/^\s+|\s+$/g, '') };
}

// key="value" pairs, keys lower-cased; unquoted values run to the next space.
function parseAttrs(s) {
  var out = {}, re = /([A-Za-z0-9_\-]+)=("([^"]*)"|[^\s"]*)/g, m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

var NOT_LIVE = /\/(movie|movies|series)\//i;
var NOT_LIVE_EXT = /\.(mp4|mkv|avi|mov|wmv|m4v)(\?|$)/i;

/*
 * An M3U reader. onEntry gets { name, group, tvgId, tvgName, logo, number,
 * shift, url, headers, drm }; headers and drm mark channels a <video> cannot
 * play (it sends no User-Agent or Referer of its own, and LG's engine has
 * no licence path for these). Films and series in the live list are left
 * out. Header guide links go to onGuide.
 */
function M3uReader(onEntry, onGuide) {
  var self = this;
  this.count = 0;
  this.seenHeader = false;
  this.dropped = 0;
  this.pending = null;
  this.onEntry = onEntry;
  this.onGuide = onGuide || function () {};
  this.lines = new LineSplitter(function (line) { self.line(line); });
}
M3uReader.prototype.push = function (text) { this.lines.push(text); };
M3uReader.prototype.end = function () { this.lines.end(); };
M3uReader.prototype.line = function (line) {
  var t = line.replace(/^\s+|\s+$/g, '');
  if (!t) return;
  if (/^#EXTM3U/i.test(t)) {
    this.seenHeader = true;
    var a = parseAttrs(t.slice(7));
    var guides = [a['url-tvg'], a['x-tvg-url'], a['tvg-url']].filter(Boolean).join(',');
    if (guides) {
      var self = this;
      guides.split(',').forEach(function (u) {
        u = u.replace(/^\s+|\s+$/g, '');
        if (u) self.onGuide(u);
      });
    }
    return;
  }
  if (/^#EXTINF/i.test(t)) {
    var p = parseExtinf(t);
    this.pending = {
      name: p.name || p.attrs['tvg-name'] || '',
      group: p.attrs['group-title'] || '',
      tvgId: p.attrs['tvg-id'] || '',
      tvgName: p.attrs['tvg-name'] || '',
      logo: p.attrs['tvg-logo'] || p.attrs.logo || '',
      number: p.attrs['tvg-chno'] || p.attrs['channel-number'] || p.attrs['tvg-num'] || '',
      shift: parseFloat(p.attrs['tvg-shift']) || 0,
      headers: false,
      drm: false
    };
    return;
  }
  if (/^#EXTGRP:/i.test(t)) {
    if (this.pending && !this.pending.group) this.pending.group = t.slice(8).replace(/^\s+/, '');
    return;
  }
  if (/^#EXTVLCOPT:/i.test(t)) {
    if (this.pending && /http-(user-agent|referrer|referer|origin|header)/i.test(t)) this.pending.headers = true;
    return;
  }
  if (/^#KODIPROP:/i.test(t)) {
    if (this.pending && /license_(key|type)|drm/i.test(t)) this.pending.drm = true;
    if (this.pending && /stream_headers|manifest_headers/i.test(t)) this.pending.headers = true;
    return;
  }
  if (t.charAt(0) === '#') return;
  // A URL line: the entry it ends, or a bare URL with no #EXTINF.
  var e = this.pending || { name: '', group: '', tvgId: '', tvgName: '', logo: '', number: '', shift: 0, headers: false, drm: false };
  this.pending = null;
  var url = t;
  var bar = url.indexOf('|');
  if (bar !== -1) {
    // Kodi's url|User-Agent=...&Referer=...
    if (/user-agent|referer|referrer|origin|cookie/i.test(url.slice(bar))) e.headers = true;
    url = url.slice(0, bar);
  }
  if (!/^(https?|rtmp|rtsp|udp|rtp|mms):\/\//i.test(url)) { this.dropped++; return; }
  if (NOT_LIVE.test(url) || NOT_LIVE_EXT.test(url)) { this.dropped++; return; }
  if (!/^https?:\/\//i.test(url)) e.unsupported = true;
  e.url = url;
  // Nothing of the URL becomes a name: its path can be the account's token.
  if (++this.count > LIMITS.entries) throw LimitError('limit-entries');
  if (!e.name) e.name = e.tvgName || 'Channel ' + (e.number || this.count);
  this.onEntry(e);
};


// ---------------------------------------------------------------- JSON arrays

/*
 * The elements of a top-level JSON array, one at a time, without holding
 * the array: Xtream's get_live_streams runs to tens of MB on a big panel.
 * Each element is parsed on its own and handed to onElement; one larger
 * than jsonElementBytes fails with limit-entry. A document that is not an
 * array (an error object, an HTML page) is collected, up to 64 KB, for
 * notArray().
 */
function JsonArrayReader(onElement) {
  this.onElement = onElement;
  this.depth = 0;
  this.inString = false;
  this.escape = false;
  this.buf = '';
  this.collecting = false;
  this.started = false;
  this.other = '';
  this.count = 0;
}
JsonArrayReader.prototype.push = function (text) {
  // An element is cut out of the chunk whole where it can be, not built a
  // character at a time: the reader sees every byte of a 30 MB answer.
  var start = this.collecting ? 0 : -1;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (!this.started) {
      if (c === 91) { this.started = true; this.depth = 1; continue; }
      if ((c > 32 || this.other) && this.other.length < 65536) this.other += text.charAt(i);
      continue;
    }
    if (this.depth === 0) continue;
    if (this.collecting) {
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === 92) this.escape = true;
        else if (c === 34) {
          this.inString = false;
          if (this.depth === 1) { this.finish(text, start, i); start = -1; }
        }
        continue;
      }
      if (c === 34) this.inString = true;
      else if (c === 123 || c === 91) this.depth++;
      else if (c === 125 || c === 93) {
        this.depth--;
        if (this.depth === 1) { this.finish(text, start, i); start = -1; }
      }
      continue;
    }
    // Between elements, at depth 1.
    if (c === 123 || c === 91) { this.collecting = true; this.buf = ''; start = i; this.depth = 2; }
    else if (c === 93) this.depth = 0;
    else if (c === 34) { this.collecting = true; this.buf = ''; start = i; this.inString = true; this.depth = 1; }
  }
  if (this.collecting && start !== -1) {
    this.buf += text.slice(start);
    if (this.buf.length > LIMITS.jsonElementBytes) throw LimitError('limit-entry');
  }
};
JsonArrayReader.prototype.finish = function (text, start, end) {
  this.buf += text.slice(start, end + 1);
  if (this.buf.length > LIMITS.jsonElementBytes) throw LimitError('limit-entry');
  this.emit();
};
// A body that ends inside the array was cut off, however its HTTP framing looked.
JsonArrayReader.prototype.end = function () {
  if (this.started && (this.depth !== 0 || this.collecting)) throw LimitError('truncated');
};
JsonArrayReader.prototype.emit = function () {
  var text = this.buf;
  this.buf = '';
  this.collecting = false;
  var v = null;
  // A malformed record is a malformed list: none of it is published.
  try { v = JSON.parse(text); } catch (e) { throw LimitError('format'); }
  if (++this.count > LIMITS.entries) throw LimitError('limit-entries');
  this.onElement(v);
};
JsonArrayReader.prototype.notArray = function () {
  if (this.started) return null;
  try { return JSON.parse(this.other); } catch (e) { return undefined; }
};

// ---------------------------------------------------------------- Xtream

/*
 * A panel's login answer: refused unless user_info.auth is 1 and the
 * account is Active, whatever the HTTP status said (panels answer a wrong
 * password with 200).
 */
function xtreamAccount(doc) {
  var u = doc && typeof doc === 'object' && doc.user_info;
  if (!u || typeof u !== 'object') return { ok: false, code: 'format' };
  if (+u.auth !== 1) return { ok: false, code: 'login' };
  var status = String(u.status || '');
  if (status && status !== 'Active') return { ok: false, code: 'login', status: status.slice(0, 20) };
  var formats = Object.prototype.toString.call(u.allowed_output_formats) === '[object Array]' ? u.allowed_output_formats : [];
  var exp = parseInt(u.exp_date, 10);
  return {
    ok: true,
    expires: exp > 0 ? exp * 1000 : null,
    maxConnections: parseInt(u.max_connections, 10) || null,
    activeConnections: parseInt(u.active_cons, 10) || 0,
    trial: String(u.is_trial) === '1',
    formats: formats.map(String).filter(function (f) { return /^(m3u8|ts|rtmp)$/.test(f); })
  };
}

// The output a <video> can take: HLS where the panel allows it.
function xtreamExtension(formats) {
  if (!formats || !formats.length || formats.indexOf('m3u8') !== -1) return 'm3u8';
  return formats.indexOf('ts') !== -1 ? 'ts' : 'm3u8';
}

/*
 * Short EPG titles are base64 on some panels and plain on others. Decoded
 * only when the text is valid base64 and decodes to valid UTF-8 that reads
 * as text.
 */
function maybeBase64(s) {
  s = String(s || '');
  var t = s.replace(/\s+/g, '');
  if (t.length < 4 || t.length % 4 !== 0 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(t)) return s;
  var buf;
  try { buf = toBuffer(t, 'base64'); } catch (e) { return s; }
  var out = buf.toString('utf8');
  if (out.indexOf('�') !== -1) return s;
  if (/[\u0000-\u0008\u000e-\u001f]/.test(out)) return s;
  return out;
}

// ---------------------------------------------------------------- XMLTV

var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

/*
 * Only the five predefined entities and numeric ones. Anything else is left
 * as written: there is no DTD and nothing is fetched.
 */
function unescapeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, function (m, e) {
    if (e.charAt(0) === '#') {
      var n = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(n > 0 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return m;
      if (n < 0x10000) return String.fromCharCode(n);
      n -= 0x10000;
      return String.fromCharCode(0xd800 + (n >> 10), 0xdc00 + (n & 0x3ff));
    }
    return ENTITIES.hasOwnProperty(e) ? ENTITIES[e] : m;
  });
}

// An element's text: CDATA as written, the rest unescaped, tags dropped.
function xmlText(s) {
  var out = '', re = /<!\[CDATA\[([\s\S]*?)\]\]>/g, last = 0, m;
  while ((m = re.exec(s))) {
    out += unescapeXml(s.slice(last, m.index).replace(/<[^>]*>/g, '')) + m[1];
    last = re.lastIndex;
  }
  return out + unescapeXml(s.slice(last).replace(/<[^>]*>/g, ''));
}

function xmlAttrs(tag) {
  var out = {}, re = /([A-Za-z_][\w\-.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
  while ((m = re.exec(tag))) out[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
  return out;
}

// The first child element named name, its text, preferring lang when given.
function childText(body, name, lang) {
  var re = new RegExp('<' + name + '(\\s[^>]*)?>([\\s\\S]*?)</' + name + '\\s*>', 'g'), m, first = null;
  while ((m = re.exec(body))) {
    var text = xmlText(m[2]);
    if (first === null) first = text;
    if (!lang) break;
    var a = xmlAttrs(m[1] || '');
    if (a.lang && a.lang.toLowerCase().indexOf(lang) === 0) return text;
  }
  return first;
}

/*
 * XMLTV's times: YYYYMMDDHHMMSS with an offset (+0100) or none, which is
 * UTC; and the shortened forms YYYYMMDDHHMM, YYYYMMDDHH and YYYYMMDD.
 * Returns ms since the epoch, or null.
 */
function xmltvTime(v) {
  var m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+\-]\d{2}:?\d{2}|Z|UTC|GMT)?/.exec(String(v || ''));
  if (!m) return null;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (isNaN(t)) return null;
  var off = m[7];
  if (off && /^[+\-]/.test(off)) {
    var d = off.replace(':', '');
    var mins = (+d.slice(1, 3)) * 60 + (+d.slice(3, 5));
    t -= (d.charAt(0) === '-' ? -1 : 1) * mins * 60000;
  }
  return t;
}

/*
 * An XMLTV reader that hands on <channel> and <programme> elements one at a
 * time. Everything else (the DOCTYPE, comments, the <tv> wrapper) is passed
 * over unread. An element larger than elementBytes fails with limit-entry.
 */
function XmltvReader(onChannel, onProgramme) {
  this.buf = '';
  this.onChannel = onChannel;
  this.onProgramme = onProgramme;
  this.channels = 0;
  this.programmes = 0;
  this.closed = false;
  // The last scan stopped inside an element still to come.
  this.unfinished = false;
}
XmltvReader.prototype.push = function (text) {
  this.buf += text;
  this.scan(false);
};
// A guide that stops before </tv> was cut off, and one with no <tv> is not a guide.
XmltvReader.prototype.end = function () {
  this.scan(true);
  this.buf = '';
  if (this.unfinished || !this.closed) throw LimitError(this.channels || this.programmes ? 'truncated' : 'format');
};

/*
 * </tv> between elements, not inside one (a CDATA title can hold the text)
 * nor a comment: the guide's real end.
 */
XmltvReader.prototype.noteClose = function (between) {
  if (this.closed) return;
  var r = between.replace(/<!--[\s\S]*?-->/g, '');
  var close = r.search(/<\/tv\s*>/);
  if (close === -1) return;
  var open = r.search(/<(programme|channel)[\s>\/]/);
  if (open === -1 || open > close) this.closed = true;
};
XmltvReader.prototype.scan = function (final) {
  var s = this.buf, pos = 0;
  this.unfinished = false;
  for (;;) {
    var ch = s.indexOf('<channel', pos), pr = s.indexOf('<programme', pos);
    var at = ch === -1 ? pr : pr === -1 ? ch : Math.min(ch, pr);
    this.noteClose(s.slice(pos, at === -1 ? s.length : at));
    if (at === -1) {
      // Keep enough of the tail for a start tag split across chunks.
      pos = Math.max(pos, s.length - 12);
      break;
    }
    var name = at === pr ? 'programme' : 'channel';
    var next = s.charAt(at + name.length + 1);
    if (next && !/[\s>\/]/.test(next)) { pos = at + 1; continue; }
    var tagEnd = s.indexOf('>', at);
    if (tagEnd === -1) { pos = at; this.unfinished = true; if (s.length - at > LIMITS.elementBytes) throw LimitError('limit-entry'); break; }
    var openTag = s.slice(at, tagEnd + 1);
    var end, body;
    if (/\/\s*>$/.test(openTag)) { end = tagEnd + 1; body = ''; }
    else {
      var close = s.indexOf('</' + name, tagEnd);
      if (close === -1) {
        pos = at;
        this.unfinished = true;
        if (s.length - at > LIMITS.elementBytes) throw LimitError('limit-entry');
        break;
      }
      var closeEnd = s.indexOf('>', close);
      if (closeEnd === -1) { pos = at; this.unfinished = true; break; }
      body = s.slice(tagEnd + 1, close);
      end = closeEnd + 1;
    }
    if (end - at > LIMITS.elementBytes) throw LimitError('limit-entry');
    var attrs = xmlAttrs(openTag);
    if (name === 'channel') {
      this.channels++;
      var names = [], re = /<display-name(\s[^>]*)?>([\s\S]*?)<\/display-name\s*>/g, m;
      while ((m = re.exec(body)) && names.length < 8) names.push(xmlText(m[2]).replace(/^\s+|\s+$/g, ''));
      this.onChannel({ id: attrs.id || '', names: names });
    } else {
      this.programmes++;
      this.onProgramme({
        channel: attrs.channel || '',
        start: xmltvTime(attrs.start),
        stop: xmltvTime(attrs.stop),
        title: childText(body, 'title', 'en') || '',
        sub: childText(body, 'sub-title', 'en') || '',
        desc: childText(body, 'desc', 'en') || ''
      });
    }
    pos = end;
  }
  this.buf = final ? '' : s.slice(pos);
};

// Ids and names compared loosely: case, spaces, dots and "HD" set aside.
function normalise(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/\b(hd|fhd|uhd|4k|sd)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/*
 * Which guide channel each wanted channel takes: its epgId exactly, then a
 * normalised id or display name only where exactly one guide channel has it.
 * wanted: [{ key, epgId, name }]; guide: { ids: {id: true}, byNorm: {norm: [ids]} }.
 */
function matchGuide(wanted, guide) {
  var out = {};
  wanted.forEach(function (w) {
    if (w.epgId && guide.ids[w.epgId]) { out[w.key] = w.epgId; return; }
    var tries = [normalise(w.epgId), normalise(w.name)];
    for (var i = 0; i < tries.length; i++) {
      var hit = tries[i] && guide.byNorm[tries[i]];
      if (hit && hit.length === 1) { out[w.key] = hit[0]; return; }
    }
  });
  return out;
}

// ---------------------------------------------------------------- identity

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

// The full URL, token and all: identical only for the same entry.
function urlDigest(url) { return sha1(url).slice(0, 20); }

/*
 * A matching aid, not an identity: the name, group, tvg-id and the URL's
 * host and last path segment, with no credentials or query. Several entries
 * may share one.
 */
function entryHint(e) {
  var u = String(e.url || '').replace(/[?#].*$/, '');
  var m = /^[a-z]+:\/\/(?:[^\/@]*@)?([^\/]+)(.*)$/i.exec(u);
  var host = m ? m[1].toLowerCase() : '';
  var seg = m ? m[2].slice(m[2].lastIndexOf('/') + 1) : '';
  return sha1([e.name, e.group, e.tvgId, host, seg].join('\u0001')).slice(0, 20);
}

function newKey() { return 'm' + crypto.randomBytes(6).toString('hex'); }

/*
 * Carries keys from the last snapshot to this one. old: [{ key, digest, hint }];
 * fresh: [{ digest, hint }] in playlist order. Returns the keys for fresh, in
 * order: the same full-URL digest keeps its key; otherwise a hint shared by
 * exactly one old key and exactly one new entry (a token rotated on a single
 * channel); otherwise a new key. Two entries whose URLs differ only in a
 * token keep two keys, and when both rotate at once neither is guessed.
 */
function carryKeys(old, fresh, makeKey) {
  makeKey = makeKey || newKey;
  var byDigest = {}, oldHints = {}, used = {};
  old.forEach(function (o) {
    if (!byDigest.hasOwnProperty(o.digest)) byDigest[o.digest] = o.key;
    (oldHints[o.hint] = oldHints[o.hint] || []).push(o.key);
  });
  var newHints = {};
  fresh.forEach(function (f) { newHints[f.hint] = (newHints[f.hint] || 0) + 1; });
  var keys = new Array(fresh.length), pending = [];
  fresh.forEach(function (f, i) {
    var k = byDigest.hasOwnProperty(f.digest) ? byDigest[f.digest] : null;
    if (k && !used[k]) { keys[i] = k; used[k] = true; } else pending.push(i);
  });
  pending.forEach(function (i) {
    var f = fresh[i], olds = oldHints[f.hint];
    if (olds && olds.length === 1 && newHints[f.hint] === 1 && !used[olds[0]]) {
      keys[i] = olds[0];
      used[olds[0]] = true;
      return;
    }
    var k;
    do { k = makeKey(); } while (used[k]);
    used[k] = true;
    keys[i] = k;
  });
  return keys;
}

// "Harbour Sport 1" -> "HS1": the tile's glyph where a logo cannot be shown.
function monogram(name) {
  var words = String(name || '').replace(/[^A-Za-z0-9À-ɏ ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  var out = '';
  for (var i = 0; i < words.length && out.length < 4; i++) {
    var w = words[i];
    out += /^\d+$/.test(w) ? w.slice(0, 4 - out.length) : w.charAt(0).toUpperCase();
  }
  return out;
}

// The image types a logo may be, by their first bytes.
function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// http(s) only, no user name or password in the address.
function safeDerivedUrl(u) {
  u = String(u || '');
  if (u.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(u)) return false;
  return !/^https?:\/\/[^\/?#]*@/i.test(u);
}

module.exports = {
  LIMITS: LIMITS,
  LimitError: LimitError,
  LineSplitter: LineSplitter,
  M3uReader: M3uReader,
  parseExtinf: parseExtinf,
  JsonArrayReader: JsonArrayReader,
  XmltvReader: XmltvReader,
  xtreamAccount: xtreamAccount,
  xtreamExtension: xtreamExtension,
  maybeBase64: maybeBase64,
  unescapeXml: unescapeXml,
  xmltvTime: xmltvTime,
  normalise: normalise,
  matchGuide: matchGuide,
  urlDigest: urlDigest,
  entryHint: entryHint,
  carryKeys: carryKeys,
  monogram: monogram,
  imageType: imageType,
  safeDerivedUrl: safeDerivedUrl,
  clip: clip,
  cell: cell,
  sha1: sha1
};
