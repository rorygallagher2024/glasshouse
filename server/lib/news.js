/*
 * lib/news.js - headlines from RSS and Atom feeds, for Glasshouse Home's news
 * strip and the News screen saver
 *
 * The owner gives up to three feeds on the Home tab. Each is fetched at most
 * every 10 minutes, and only while something shows the headlines (Home in
 * front with the strip on, or the screen saver asking through /api/news).
 * Only the titles are kept: a feed's own name, then each item's title, newest
 * first. Nothing is sent to a feed but the request for it.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');

var MAX_FEEDS = 3;
var MAX_ITEMS = 15;
var TITLE_MAX = 200;
var SOURCE_MAX = 40;
var FEED_MAX_BYTES = 2 * 1024 * 1024;
var REFRESH_MS = 10 * 60 * 1000;
// A feed that failed is tried again sooner, but not on every ask.
var RETRY_MS = 2 * 60 * 1000;

/** @type {null|function(string, string, function(any): void): any} */
var fetchFile = null;
var tmpDir = os.tmpdir();
var nowFn = function () { return Date.now(); };

// By feed address: { at, ok, source, items: [title] }.
var feeds = {};
var fetching = {};

function init(opts) {
  opts = opts || {};
  if (typeof opts.fetchFile === 'function') fetchFile = opts.fetchFile;
  if (typeof opts.tmpDir === 'string') tmpDir = opts.tmpDir;
  if (typeof opts.now === 'function') nowFn = opts.now;
  feeds = {};
  fetching = {};
}

/*
 * The feeds as the Home layout keeps them: up to three { url, name }, each an
 * http or https address of at most 2048 characters, the name optional.
 */
function feedsOf(raw) {
  var out = [];
  if (!raw || typeof raw.length !== 'number') return out;
  for (var i = 0; i < raw.length && out.length < MAX_FEEDS; i++) {
    var f = raw[i] || {};
    var url = typeof f === 'string' ? f : f.url;
    url = typeof url === 'string' ? url.trim() : '';
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) continue;
    var name = typeof f.name === 'string' ? oneLine(f.name).slice(0, SOURCE_MAX) : '';
    out.push({ url: url, name: name });
  }
  return out;
}

function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }

var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  aring: 'å', auml: 'ä', ouml: 'ö', Aring: 'Å', Auml: 'Ä', Ouml: 'Ö', eacute: 'é', uuml: 'ü', Uuml: 'Ü',
  oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', szlig: 'ß', egrave: 'è', agrave: 'à', aacute: 'á',
  iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', ecirc: 'ê', copy: '©', reg: '®',
  trade: '™', euro: '€', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', times: '×' };

function fromCode(n) {
  if (!(n > 0 && n < 0x110000)) return '';
  if (n <= 0xffff) return String.fromCharCode(n);
  n -= 0x10000;
  return String.fromCharCode(0xd800 + (n >> 10), 0xdc00 + (n & 0x3ff));
}

// Text as a feed carries it: CDATA unwrapped, entities decoded, any markup a
// title holds dropped, on one line.
function textOf(raw) {
  var s = String(raw || '');
  var cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) s = cdata[1];
  else s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  function decode(t) {
    return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e.charAt(0) === '#') return fromCode(e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return NAMED[e] !== undefined ? NAMED[e] : m;
    });
  }
  // Escaped markup (&lt;b&gt;) is decoded first, then dropped with any other.
  // Only what looks like a tag goes, so "x < y" in a headline stays.
  var tag = /<\/?[a-z][^<>]*>/gi;
  s = decode(s).replace(tag, ' ');
  return oneLine(decode(s).replace(tag, ' '));
}

function firstTag(xml, tag) {
  var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(xml);
  return m ? m[1] : null;
}

/*
 * parse(xml) - { source, items: [title] } from an RSS 2.0, RSS 1.0 or Atom
 * document, or null when it is none of them.
 */
function parse(xml) {
  if (typeof xml !== 'string') return null;
  var blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi);
  var atom = false;
  if (!blocks) {
    blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi);
    atom = !!blocks;
  }
  if (!blocks && !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return null;
  // The feed's own title: before its first item, so an item's is not taken.
  var head = blocks && blocks.length ? xml.slice(0, xml.indexOf(blocks[0])) : xml;
  var source = textOf(firstTag(head, 'title') || '').slice(0, SOURCE_MAX);
  var items = [];
  (blocks || []).forEach(function (b) {
    if (items.length >= MAX_ITEMS) return;
    var t = textOf(firstTag(b, 'title') || '').slice(0, TITLE_MAX);
    if (t && items.indexOf(t) === -1) items.push(t);
  });
  return { source: source, items: items, atom: atom };
}

/*
 * A feed's text as its XML declaration says it is written: UTF-8 unless it
 * names ISO-8859-1 or Windows-1252, which older feeds still use and which
 * read as UTF-8 turn å, ä and ö into replacement characters.
 */
function decodeFeed(buf) {
  var head = buf.slice(0, 200).toString('binary');
  var m = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (m && /^(iso-?8859-1|latin-?1|windows-1252|cp1252)$/i.test(m[1])) {
    // Windows-1252's own letters (the curly quotes, the dash) sit in 0x80-0x9f.
    var cp1252 = { 128: '€', 130: '‚', 132: '„', 133: '…', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 153: '™' };
    return buf.toString('binary').replace(/[\u0080-\u009f]/g, function (c) { return cp1252[c.charCodeAt(0)] || ''; });
  }
  return buf.toString('utf8');
}

function fetchFeed(url, cb) {
  if (fetching[url]) return fetching[url].push(cb);
  fetching[url] = [cb];
  function done() {
    var waiting = fetching[url] || [];
    delete fetching[url];
    waiting.forEach(function (w) { w(); });
  }
  var file = path.join(tmpDir, 'tvweb-news-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.xml');
  var prev = feeds[url];
  // error: 'fetch' when nothing came back, 'size' for a file over 2 MB,
  // 'feed' for something that is not RSS or Atom.
  function failed(error) {
    feeds[url] = { at: nowFn(), ok: false, error: error, source: prev ? prev.source : '', items: prev ? prev.items : [] };
  }
  fetchFile(url, file, function (err) {
    var xml = null, error = err ? (err.tooBig ? 'size' : 'fetch') : '';
    try {
      if (!err && fs.statSync(file).size > FEED_MAX_BYTES) error = 'size';
      else if (!err) xml = decodeFeed(fs.readFileSync(file));
    } catch (e) { xml = null; error = 'fetch'; }
    try { fs.unlinkSync(file); } catch (e) {}
    var doc = xml ? parse(xml) : null;
    if (!doc) failed(error || 'feed');
    else feeds[url] = { at: nowFn(), ok: true, error: '', source: doc.source, items: doc.items };
    done();
  });
}

function stale(url) {
  var f = feeds[url];
  if (!f) return true;
  return nowFn() - f.at >= (f.ok ? REFRESH_MS : RETRY_MS);
}

/*
 * headlines(list, cb) - cb({ ok, items: [{ source, title }] }) for the feeds,
 * fetching any not read in the last 10 minutes first. The feeds' headlines
 * take turns, so one busy feed does not crowd the others out. ok is false
 * only when feeds were given and none could be read.
 */
function headlines(list, cb) {
  var wanted = feedsOf(list);
  if (!wanted.length || !fetchFile) return setTimeout(function () { cb({ ok: !wanted.length, items: [] }); }, 0);
  var left = 0;
  wanted.forEach(function (f) { if (stale(f.url)) left++; });
  function answer() {
    headlinesSync(wanted, function (r) {
      r.ok = wanted.some(function (f) { return !!feeds[f.url] && (feeds[f.url].ok || feeds[f.url].items.length > 0); });
      cb(r);
    });
  }
  if (!left) return setTimeout(answer, 0);
  wanted.forEach(function (f) {
    if (!stale(f.url)) return;
    fetchFeed(f.url, function () { if (--left === 0) answer(); });
  });
}

function hostOf(url) {
  var m = /^https?:\/\/(?:www\.)?([^\/:?#]+)/i.exec(url);
  return m ? m[1] : '';
}

/*
 * cached(list) - the headlines as last read, without fetching: for the Home
 * beat, which must not wait on a feed.
 */
function cached(list) {
  var out = null;
  headlinesSync(list, function (r) { out = r; });
  return out;
}

function headlinesSync(list, cb) {
  var wanted = feedsOf(list);
  var lists = wanted.map(function (f) {
    var got = feeds[f.url];
    var source = f.name || (got && got.source) || hostOf(f.url);
    return (got ? got.items : []).map(function (t) { return { source: source, title: t }; });
  });
  var items = [];
  for (var i = 0; i < MAX_ITEMS; i++) {
    lists.forEach(function (l) { if (l[i]) items.push(l[i]); });
  }
  cb({ ok: items.length > 0, items: items });
}

// Fetches the feeds that are due, in the background, for the Home strip.
function refresh(list) {
  var wanted = feedsOf(list);
  if (!fetchFile) return;
  wanted.forEach(function (f) { if (stale(f.url)) fetchFeed(f.url, function () {}); });
}

/*
 * status(list, cb) - cb([{ url, ok, source, count, error }]) for each feed,
 * reading any not read in the last 10 minutes (2 after a failure) first: what
 * the dashboard shows under each address, so a wrong one is seen at once.
 */
function status(list, cb) {
  var wanted = feedsOf(list);
  function answer() {
    cb(wanted.map(function (f) {
      var got = feeds[f.url];
      return {
        url: f.url,
        ok: !!(got && got.ok),
        source: f.name || (got && got.source) || hostOf(f.url),
        count: got ? got.items.length : 0,
        error: got ? got.error || '' : 'fetch'
      };
    }));
  }
  var left = 0;
  if (fetchFile) wanted.forEach(function (f) { if (stale(f.url)) left++; });
  if (!left) return setTimeout(answer, 0);
  wanted.forEach(function (f) {
    if (stale(f.url)) fetchFeed(f.url, function () { if (--left === 0) answer(); });
  });
}

module.exports = {
  FEED_MAX_BYTES: FEED_MAX_BYTES,
  status: status,
  MAX_FEEDS: MAX_FEEDS,
  init: init,
  feedsOf: feedsOf,
  parse: parse,
  decodeFeed: decodeFeed,
  textOf: textOf,
  headlines: headlines,
  cached: cached,
  refresh: refresh
};
