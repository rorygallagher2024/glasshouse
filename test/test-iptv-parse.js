/**
 * test/test-iptv-parse.js - Internet TV's readers: M3U, Xtream's JSON, XMLTV,
 * guide matching, and how a channel keeps its key from one refresh to the next
 */

var assert = require('assert');
var parse = require('../server/lib/iptv-parse');
var toBuffer = require('../server/lib/util').toBuffer;

console.log('Running test-iptv-parse.js ...');

// Fed in pieces of every size, as a download arrives.
function feed(reader, text, size) {
  for (var i = 0; i < text.length; i += size) reader.push(text.slice(i, i + size));
  if (reader.end) reader.end();
}

function readM3u(text, size) {
  var out = [], guides = [];
  var r = new parse.M3uReader(function (e) { out.push(e); }, function (g) { guides.push(g); });
  feed(r, text, size || text.length);
  return { entries: out, guides: guides, reader: r };
}

var M3U = '﻿#EXTM3U url-tvg="http://g.example/a.xml,http://g.example/b.xml.gz" x-tvg-url="http://g.example/c.xml"\r\n' +
  '#EXTINF:-1 tvg-id="hs1.uk" tvg-name="HS1" tvg-logo="http://l.example/1.png" group-title="Sport, Live" tvg-chno="7",Harbour Sport 1, Live & Loud\r\n' +
  'http://s.example/live/u/p/1.m3u8\r\n' +
  '#EXTINF:-1,Grouped Later\r\n#EXTGRP:News\r\nhttp://s.example/2.ts\r\n' +
  '#EXTINF:-1 group-title="Sport",Needs Agent\r\n#EXTVLCOPT:http-user-agent=Foo/1\r\nhttp://s.example/3.m3u8\r\n' +
  '#EXTINF:-1 group-title="Sport",Locked\r\n#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha\r\nhttps://s.example/4.mpd\r\n' +
  '#EXTINF:-1,A Film\r\nhttp://s.example/movie/u/p/9.mp4\r\n' +
  '#EXTINF:-1,An Episode\r\nhttp://s.example/series/u/p/10.mkv\r\n' +
  '#EXTINF:-1,Piped\r\nhttp://s.example/5.m3u8|User-Agent=X&Referer=http://r\r\n' +
  'http://s.example/play/SECRET-PATH-TOKEN\r\n' +
  '#EXTINF:-1,Multicast\r\nudp://@239.0.0.1:1234\r\n';

[1, 7, 64, M3U.length].forEach(function (size) {
  var m = readM3u(M3U, size);
  assert.equal(m.entries.length, 7, 'chunks of ' + size);
  assert.equal(m.reader.dropped, 2, 'films and series are left out');
  var e = m.entries[0];
  assert.equal(e.name, 'Harbour Sport 1, Live & Loud');
  assert.equal(e.group, 'Sport, Live');
  assert.equal(e.tvgId, 'hs1.uk');
  assert.equal(e.number, '7');
  assert.equal(e.logo, 'http://l.example/1.png');
  assert.equal(m.entries[1].group, 'News');
  assert.equal(m.entries[2].headers, true);
  assert.equal(m.entries[3].drm, true);
  assert.equal(m.entries[4].headers, true);
  assert.equal(m.entries[4].url, 'http://s.example/5.m3u8');
  assert.equal(m.entries[5].name, 'Channel 6', 'a bare URL\'s path, which can be its token, never becomes a name');
  assert.equal(m.entries[6].unsupported, true);
  assert.deepEqual(m.guides, ['http://g.example/a.xml', 'http://g.example/b.xml.gz', 'http://g.example/c.xml']);
});
console.log('  ✓ M3U: a BOM, CRLF, quoted commas, #EXTGRP, headers, DRM, films and series, in chunks of any size');

var bare = readM3u('#EXTINF:-1,One\nhttp://x.example/1\n');
assert.equal(bare.entries.length, 1);
assert.equal(bare.reader.seenHeader, false);
assert.throws(function () { readM3u('#EXTINF:-1,' + new Array(70 * 1024).join('x')); }, /limit-entry/);
console.log('  ✓ M3U: no #EXTM3U is read all the same; a line past 64 KB is refused');

// ---------------------------------------------------------------- JSON

var streams = '[{"num":1,"name":"A [b] {c}","stream_id":11},{"name":"Quote \\" and \\\\ ]","stream_id":12},\n {"stream_id":13,"x":[1,[2]]}]';
[1, 3, streams.length].forEach(function (size) {
  var got = [];
  var r = new parse.JsonArrayReader(function (v) { got.push(v); });
  feed(r, streams, size);
  assert.deepEqual(got.map(function (v) { return v.stream_id; }), [11, 12, 13], 'chunks of ' + size);
  assert.equal(got[1].name, 'Quote " and \\ ]');
  assert.strictEqual(r.notArray(), null);
});
var refusal = new parse.JsonArrayReader(function () { assert.fail('no elements'); });
feed(refusal, '{"user_info":{"auth":0}}', 5);
assert.deepEqual(refusal.notArray(), { user_info: { auth: 0 } });
assert.throws(function () {
  feed(new parse.JsonArrayReader(function () {}), '[{"a":"' + new Array(70 * 1024).join('x') + '"}]', 4096);
}, /limit-entry/);
assert.throws(function () { feed(new parse.JsonArrayReader(function () {}), '[{"stream_id":1},{"stream_id":2', 5); }, /truncated/);
assert.throws(function () { feed(new parse.JsonArrayReader(function () {}), '[{"stream_id":1},', 5); }, /truncated/);
assert.throws(function () { feed(new parse.JsonArrayReader(function () {}), '[{"stream_id":1},{"stream_id":}]', 4); }, /format/,
  'a malformed record refuses the list, not just itself');
console.log('  ✓ Xtream lists are read an element at a time, a refusal object is told apart, an element past 64 KB and a list cut off are refused');

assert.deepEqual(parse.xtreamAccount({ user_info: { auth: 0 } }), { ok: false, code: 'login' });
assert.equal(parse.xtreamAccount({ user_info: { auth: 1, status: 'Expired' } }).code, 'login');
assert.equal(parse.xtreamAccount({ error: 'x' }).code, 'format');
var acct = parse.xtreamAccount({ user_info: { auth: '1', status: 'Active', exp_date: '1801436400', max_connections: '1',
  active_cons: '0', allowed_output_formats: ['m3u8', 'ts', 'rtmp'] } });
assert.equal(acct.ok, true);
assert.equal(acct.expires, 1801436400000);
assert.equal(acct.maxConnections, 1);
assert.equal(parse.xtreamExtension(acct.formats), 'm3u8');
assert.equal(parse.xtreamExtension(['ts']), 'ts');
console.log('  ✓ an Xtream login is checked by auth and status, whatever the HTTP status said');

assert.equal(parse.maybeBase64('TGl2ZTogTGVlZHMgdiBGdWxoYW0='), 'Live: Leeds v Fulham');
assert.equal(parse.maybeBase64('News'), 'News');
assert.equal(parse.maybeBase64('Sport'), 'Sport');
assert.equal(parse.maybeBase64('Live: Leeds v Fulham'), 'Live: Leeds v Fulham');
console.log('  ✓ short EPG text is decoded only when it is base64 of real UTF-8 text');

// ---------------------------------------------------------------- XMLTV

var XML = '<?xml version="1.0"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd" [<!ENTITY boom "x">]>\n<tv>' +
  '<channel id="hs1.uk"><display-name>Harbour Sport 1</display-name></channel>' +
  '<channel id="other"><display-name lang="en">World &amp; Today</display-name></channel>' +
  '<programme start="20261031150000 +0000" stop="20261031170000 +0000" channel="hs1.uk">' +
  '<title lang="de">Fussball</title><title lang="en">Leeds v Fulham &#8211; Live</title><desc>&boom; &lt;b&gt;</desc></programme>' +
  '<programme start="202610311700 +0100" channel="hs1.uk"><title><![CDATA[Final <Score>]]></title></programme>' +
  '<programme start="20261031" channel="other"/>' +
  '<programmeX start="1"></programmeX></tv>';
[1, 9, XML.length].forEach(function (size) {
  var chans = [], progs = [];
  feed(new parse.XmltvReader(function (c) { chans.push(c); }, function (p) { progs.push(p); }), XML, size);
  assert.equal(chans.length, 2, 'chunks of ' + size);
  assert.deepEqual(chans[1].names, ['World & Today']);
  assert.equal(progs.length, 3, 'chunks of ' + size);
  assert.equal(progs[0].title, 'Leeds v Fulham – Live');
  assert.equal(progs[0].desc, '&boom; <b>', 'no DTD entity is expanded');
  assert.equal(progs[0].start, Date.UTC(2026, 9, 31, 15, 0));
  assert.equal(progs[1].title, 'Final <Score>');
  assert.equal(progs[1].start, Date.UTC(2026, 9, 31, 16, 0), '+0100 is an hour ahead of UTC');
  assert.strictEqual(progs[1].stop, null);
  assert.equal(progs[2].start, Date.UTC(2026, 9, 31));
});
assert.equal(parse.xmltvTime('20261031150000'), Date.UTC(2026, 9, 31, 15, 0), 'no offset is UTC');
assert.equal(parse.xmltvTime('20261031150000 -0500'), Date.UTC(2026, 9, 31, 20, 0));
assert.equal(parse.xmltvTime('2026103115'), Date.UTC(2026, 9, 31, 15, 0));
assert.strictEqual(parse.xmltvTime('soon'), null);
assert.throws(function () { feed(new parse.XmltvReader(function () {}, function () {}), XML.slice(0, XML.indexOf('<programme start="2026103117')), 50); }, /truncated/);
assert.throws(function () { feed(new parse.XmltvReader(function () {}, function () {}), '<html><body>Not found</body></html>', 50); }, /format/);
assert.throws(function () {
  feed(new parse.XmltvReader(function () {}, function () {}),
    '<tv><channel id="a"/><programme channel="a" start="20261031150000"><desc><![CDATA[</tv>]]></desc>', 7);
}, /truncated/, '</tv> inside an unfinished programme is not the guide\'s end');
console.log('  ✓ XMLTV: chunked elements, CDATA, the five entities and numeric ones only, shortened times and offsets; one cut off, or not XMLTV, is refused');

var guide = { ids: { 'hs1.uk': true, 'news.a': true, 'news.b': true },
  byNorm: { harboursport1: ['hs1.uk'], worldtoday: ['wt.uk'], news: ['news.a', 'news.b'] } };
assert.deepEqual(parse.matchGuide([
  { key: 'a', epgId: 'hs1.uk', name: 'x' },
  { key: 'b', epgId: '', name: 'World Today HD' },
  { key: 'c', epgId: 'NEWS', name: 'News' },
  { key: 'd', epgId: 'nothing', name: 'Nothing' }
], guide), { a: 'hs1.uk', b: 'wt.uk' });
console.log('  ✓ a guide id is matched exactly, or loosely only where one guide channel matches');

// ---------------------------------------------------------------- identity

function fresh(url, name) {
  var e = { url: url, name: name || 'Twin', group: 'News', tvgId: 'tw.uk' };
  return { digest: parse.urlDigest(url), hint: parse.entryHint(e) };
}
var n = 0;
function counter() { return 'k' + (++n); }

var first = [fresh('http://h/1.m3u8?token=A'), fresh('http://h/1.m3u8?token=B'), fresh('http://h/9.m3u8?token=Z', 'Solo')];
var keys1 = parse.carryKeys([], first, counter);
assert.deepEqual(keys1, ['k1', 'k2', 'k3'], 'token-only duplicates keep two keys');
var old = first.map(function (f, i) { return { key: keys1[i], digest: f.digest, hint: f.hint }; });
assert.deepEqual(parse.carryKeys(old, first, counter), keys1, 'the same URLs keep their keys');
var rotated = [fresh('http://h/1.m3u8?token=C'), fresh('http://h/1.m3u8?token=D'), fresh('http://h/9.m3u8?token=Y', 'Solo')];
var keys2 = parse.carryKeys(old, rotated, counter);
assert.equal(keys2[2], 'k3', 'a single channel whose token rotated keeps its key');
assert.ok(keys2[0] !== 'k1' && keys2[0] !== 'k2' && keys2[1] !== 'k1' && keys2[1] !== 'k2',
  'twins that both rotated are not guessed');
assert.notEqual(keys2[0], keys2[1]);
console.log('  ✓ keys: the full URL first, a unique hint for a rotated token, and never a guess between twins');

assert.equal(parse.monogram('Harbour Sport 1'), 'HS1');
assert.equal(parse.monogram('BBC One HD'), 'BOH');
assert.equal(parse.monogram(''), '?');
assert.equal(parse.imageType(toBuffer([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
assert.equal(parse.imageType(toBuffer('<html><body></body></html>')), null);
assert.equal(parse.safeDerivedUrl('https://l.example/a.png'), true);
assert.equal(parse.safeDerivedUrl('http://user:pw@l.example/a.png'), false);
assert.equal(parse.safeDerivedUrl('file:///etc/passwd'), false);
console.log('  ✓ initials, logo types by their bytes, and derived links without credentials');

console.log('ALL test-iptv-parse.js assertions passed!\n');
