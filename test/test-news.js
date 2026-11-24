/*
 * test/test-news.js - Headlines from RSS 2.0, RSS 1.0 and Atom: titles decoded
 * and stripped of markup, the feed's own name, up to fifteen per feed; feeds
 * checked and kept to three; each read at most every 10 minutes (2 after a
 * failure, keeping the last headlines); feeds taking turns.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var news = require('../server/lib/news');

console.log('Running test-news.js ...');

var rss = '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>SVT Nyheter</title>' +
  '<item><title>Regeringen &amp; SD: <![CDATA[ny budget]]></title><description><title>no</title></description></item>' +
  '<item><title><![CDATA[Storm i <b>norr</b>]]></title></item>' +
  '<item><title>V&auml;der &#8211; sn&#xF6;</title></item></channel></rss>';
var atom = '<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">DN</title>' +
  '<entry><title type="html">Ett &amp;lt;em&amp;gt;nytt&amp;lt;/em&amp;gt; rekord</title></entry></feed>';
var rdf = '<rdf:RDF><channel><title>Gammal</title></channel><item><title>RDF-rubrik</title></item></rdf:RDF>';

var p = news.parse(rss);
assert.strictEqual(p.source, 'SVT Nyheter');
assert.deepEqual(p.items, ['Regeringen & SD: ny budget', 'Storm i norr', 'Väder – snö']);
assert.deepEqual(news.parse(atom).items, ['Ett nytt rekord'], 'markup escaped twice is dropped too');
assert.strictEqual(news.parse(atom).source, 'DN');
assert.deepEqual(news.parse(rdf).items, ['RDF-rubrik']);
assert.strictEqual(news.parse('<html><body>Not a feed</body></html>'), null);
assert.strictEqual(news.textOf('1 < 2 &amp; 3 > 2'), '1 < 2 & 3 > 2', 'a "<" that is not a tag stays');
var many = '<rss><channel><title>X</title>';
for (var n = 0; n < 30; n++) many += '<item><title>T' + n + '</title></item>';
assert.strictEqual(news.parse(many + '</channel></rss>').items.length, 15);
var latin1 = Buffer.concat([new Buffer('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>L</title><item><title>'),
  new Buffer([0xC5, 0x6B, 0x65, 0x20, 0x96, 0x20, 0xF6]), new Buffer('</title></item></channel></rss>')]);
assert.deepEqual(news.parse(news.decodeFeed(latin1)).items, ['Åke – ö'], 'an ISO-8859-1 or Windows-1252 feed');
assert.deepEqual(news.parse(news.decodeFeed(new Buffer('<rss><channel><title>U</title><item><title>Åke &copy;</title></item></channel></rss>'))).items, ['Åke ©']);
console.log('  ✓ RSS 2.0, RSS 1.0 and Atom titles are read, decoded and stripped of markup');

assert.deepEqual(news.feedsOf([
  { url: ' https://a.example/rss ', name: '  SVT  ' }, { url: 'ftp://b.example' }, 'http://c.example/feed',
  { url: 'javascript:alert(1)' }, { url: 'https://d.example/x' }, { url: 'https://e.example/y' }
]), [{ url: 'https://a.example/rss', name: 'SVT' }, { url: 'http://c.example/feed', name: '' }, { url: 'https://d.example/x', name: '' }]);
assert.deepEqual(news.feedsOf(null), []);
console.log('  ✓ feeds are http or https addresses, three at most');

var clock = 1000000;
var bodies = {};
var fetched = [];
news.init({ tmpDir: os.tmpdir(), now: function () { return clock; }, fetchFile: function (url, out, cb) {
  fetched.push(url);
  setTimeout(function () {
    var b = bodies[url];
    if (b instanceof Error) return cb(b);
    fs.writeFileSync(out, b);
    cb(null);
  }, 0);
} });
bodies['https://svt.example/rss'] = rss;
bodies['https://dn.example/atom'] = atom.replace('</feed>', '<entry><title>Andra</title></entry></feed>');
var feeds = [{ url: 'https://svt.example/rss', name: '' }, { url: 'https://dn.example/atom', name: 'Dagens Nyheter' }];
assert.deepEqual(news.cached(feeds).items, [], 'nothing before the first read');
var leftovers = function () {
  return fs.readdirSync(os.tmpdir()).filter(function (f) { return f.indexOf('tvweb-news-' + process.pid) === 0; });
};
news.headlines(feeds, function (r) {
  assert.strictEqual(r.ok, true);
  assert.deepEqual(r.items.map(function (i) { return i.source + ': ' + i.title; }), [
    'SVT Nyheter: Regeringen & SD: ny budget', 'Dagens Nyheter: Ett nytt rekord',
    'SVT Nyheter: Storm i norr', 'Dagens Nyheter: Andra', 'SVT Nyheter: Väder – snö'], 'feeds take turns; a name given wins');
  assert.deepEqual(leftovers(), [], 'the downloaded feed is not left behind');
  assert.strictEqual(fetched.length, 2);
  console.log('  ✓ headlines come from each feed in turn, with its name');
  clock += 9 * 60000;
  news.headlines(feeds, function () {
    assert.strictEqual(fetched.length, 2, 'not again within 10 minutes');
    clock += 2 * 60000;
    bodies['https://svt.example/rss'] = new Error('offline');
    news.headlines(feeds, function (r2) {
      assert.strictEqual(fetched.length, 4, 'again after 10 minutes');
      assert.strictEqual(r2.items.length, 5, 'a failed read keeps the last headlines');
      clock += 60000;
      news.refresh(feeds);
      assert.strictEqual(fetched.length, 4, 'a failed feed is not tried again within 2 minutes');
      clock += 60000;
      news.refresh(feeds);
      assert.strictEqual(fetched.length, 5, 'but is after them');
      setTimeout(function () {
        news.init({ fetchFile: function (url, out, cb) {
          fs.writeFileSync(out, /gone/.test(url) ? '<html>moved</html>' : '<rss><channel><title>X</title><item><title>T</title></item></channel></rss>');
          cb(null);
        } });
        news.headlines([{ url: 'https://gone.example/rss', name: '' }], function (r3) {
          assert.strictEqual(r3.ok, false, 'no feed could be read');
          assert.deepEqual(r3.items, []);
          news.headlines([], function (r4) {
            assert.strictEqual(r4.ok, true, 'no feeds is not a failure');
          news.status([{ url: 'https://gone.example/rss', name: '' }, { url: 'https://svt.example/rss', name: '' }], function (st) {
            assert.deepEqual(st[0], { url: 'https://gone.example/rss', ok: false, source: 'gone.example', count: 0, error: 'feed' }, 'read, but not a feed');
            assert.strictEqual(st[1].ok, true, 'a feed read now');
            assert.strictEqual(st[1].source, 'X');
            console.log('  ✓ each feed\'s state says what it is called and how many headlines it has, or why it failed');
            console.log('  ✓ each feed is read every 10 minutes at most, 2 after a failure, keeping its last headlines');
            console.log('\nALL test-news.js assertions passed!\n');
          });
          });
        });
      }, 10);
    });
  });
});
