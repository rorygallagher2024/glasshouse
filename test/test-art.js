/**
 * test/test-art.js - The Art screen saver's pictures: the settings and what
 * is refused, a museum record as a picture (or not), paintings fetched ahead
 * and only a few kept, the owner's own taken in turn with them, uploads, the
 * message with nothing to show, a Rijksmuseum object read, and a network
 * folder as a source.
 *
 * Strict ES5: runs on node 0.12.
 */

var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var art = require('../server/lib/art');
var waitFor = require('./wait-for').waitFor;
var dlna = require('../server/lib/dlna');

console.log('Running test-art.js ...');

// A small JPEG, valid as the server checks it.
var JPEG = new Buffer('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+O6KKK/Ez+jD/9k=', 'base64');

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'art-')) : path.join(os.tmpdir(), 'art-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

var asked = [], fetched = [], next = 1;
function record(id, w, h, url) {
  return {
    id: id, title: 'Work ' + id, creation_date: '1888',
    creators: [{ description: 'Claude Monet (French, 1840–1926)' }],
    images: { print: { url: url || 'https://openaccess-cdn.clevelandart.org/1.' + id + '/1.' + id + '_print.jpg', width: String(w || 3400), height: String(h || 2400), filesize: '3000000' } }
  };
}
var getJson = function (url, cb) {
  asked.push(url);
  setTimeout(function () { cb(null, { info: { total: 50 }, data: [record(next++)] }); }, 0);
};
var download = function (url, file, cb) {
  fetched.push(url);
  fs.writeFileSync(file, JPEG);
  setTimeout(function () { cb(null); }, 0);
};
var keysWatched = [];
function init() {
  art.init({ watchKeys: function (on) { keysWatched.push(on); }, stateDir: dir, getJson: getJson, download: download, free: function (d, cb) { cb(1e9); } });
}
init();

// Once fetching ahead has settled, however long that takes on a busy runner.
function later(fn) {
  setTimeout(function () { waitFor(function () { return !art.status().fetching; }, fn, 'fetching ahead to settle'); }, 5);
}
function call(fn) { return function (cb) { fn(function (r) { cb(r); }); }; }

// A record is a picture where its print is a JPEG on the museum's CDN and its
// shape suits a screen.
var c = art.COLLECTIONS[0];
var pick = art.clevelandPick(record(7), c);
assert.strictEqual(pick.key, 'cma-7');
assert.strictEqual(pick.info.artist, 'Claude Monet', 'the artist without their dates');
assert.strictEqual(pick.info.date, '1888');
assert.strictEqual(art.clevelandPick(record(8, 3400, 600), c), null, 'a long scroll is left out');
assert.strictEqual(art.clevelandPick(record(9, 3400, 2400, 'https://example.com/x.jpg'), c), null, 'only from the museum');
assert.strictEqual(art.clevelandPick({ id: 10, images: {} }, c), null, 'no print, no picture');

// A Rijksmuseum object, as Linked Art: its IIIF image where marked public
// domain, its English title, its painter (or the attribution's) and date.
function rijks(id, opts) {
  opts = opts || {};
  var EN = [{ id: 'http://vocab.getty.edu/aat/300388277' }], NL = [{ id: 'http://vocab.getty.edu/aat/300388256' }];
  var part = opts.attributed
    ? { referred_to_by: [{ classified_as: [{ id: 'http://vocab.getty.edu/aat/300435417' }], content: 'Geo Poggenbeek (mentioned on object)', language: EN }] }
    : { carried_out_by: [{ notation: [{ '@language': 'nl', '@value': 'Jan Toorop' }, { '@language': 'en', '@value': 'Jan Toorop' }] }] };
  return {
    id: 'https://id.rijksmuseum.nl/' + id,
    identified_by: [
      { type: 'Name', content: 'Mistige zee', language: NL, classified_as: [{ id: 'http://vocab.getty.edu/aat/300404670' }] },
      { type: 'Name', content: 'Misty Sea', language: EN, classified_as: [{ id: 'http://vocab.getty.edu/aat/300404670' }] }
    ],
    produced_by: { part: [part], timespan: { identified_by: [{ type: 'Name', content: '1899', language: EN }] } },
    subject_of: [{ digitally_carried_by: [{
      access_point: [{ id: 'https://iiif.micr.io/mPymb/full/max/0/default.jpg' }],
      referred_to_by: [{ content: opts.copyright ? 'https://rightsstatements.org/vocab/InC/1.0/' : 'https://creativecommons.org/publicdomain/mark/1.0/' }]
    }] }]
  };
}
var rk = art.rijksPick(rijks(200100988), { id: 'rijks-later' });
assert.strictEqual(rk.key, 'rk-200100988');
assert.strictEqual(rk.url, 'https://iiif.micr.io/mPymb/full/!2400,1400/0/default.jpg', 'at a size for the screen');
assert.deepEqual(rk.info, { title: 'Misty Sea', artist: 'Jan Toorop', date: '1899', credit: 'Rijksmuseum' }, 'in English');
assert.strictEqual(art.rijksPick(rijks(1, { attributed: true }), { id: 'x' }).info.artist, 'Geo Poggenbeek', 'an attribution\'s painter');
assert.strictEqual(art.rijksPick(rijks(2, { copyright: true }), { id: 'x' }), null, 'not public domain, not shown');
assert.strictEqual(art.rijksPick({ id: 'https://example.com/1' }, { id: 'x' }), null);

// ESA's archive: its images and how many there are; an image's credit
// whole, or none where it is too long to show unaltered.
var archive = art.readEsaArchive("Showing 1 to 50 of 710 var images = [ { id: 'heic2007a', title: 'Hubble\\'s 30th: the \\'Cosmic Reef\\'', width: 6000, height: 4000, src: 'x' }, { id: 'opo1', title: 'A &amp; B', width: 100, height: 3000, src: 'y' } ];");
assert.strictEqual(archive.total, 710);
assert.deepEqual(archive.images[0], { id: 'heic2007a', title: "Hubble's 30th: the 'Cosmic Reef'", width: 6000, height: 4000 });
assert.strictEqual(archive.images[1].title, 'A & B');
assert.strictEqual(art.readEsaCredit('<div class="credit"><p>NASA, ESA, and STScI</p></div>'), 'NASA, ESA, and STScI');
assert.strictEqual(art.readEsaCredit('<div class="credit"><p>' + new Array(500).join('x') + '</p></div>'), '', 'never cut short');

// Commons: only free licences, credited; a JPEG of a shape for the screen.
function commons(licence, opts) {
  opts = opts || {};
  return { pageid: 42, title: 'File:Lake_at_dawn.jpg', imageinfo: [{
    mime: opts.mime || 'image/jpeg', width: opts.width || 4000, height: opts.height || 3000,
    thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Lake.jpg/1920px-Lake.jpg?utm_source=commons.wikimedia.org',
    extmetadata: { License: { value: licence }, LicenseShortName: { value: licence.toUpperCase() },
      Artist: { value: '<a href="x">Ann Example</a>' }, DateTimeOriginal: { value: '2019-05-01 06:12' } } }] };
}
var wc = art.commonsPick(commons('cc-by-sa-4.0'), { id: 'commons-landscapes' });
assert.strictEqual(wc.key, 'wc-42');
assert.deepEqual(wc.info, { title: 'Lake at dawn', artist: 'Ann Example', date: '2019', credit: 'CC-BY-SA-4.0 \u00b7 Wikimedia Commons', mustCredit: true });
assert.strictEqual(art.commonsPick(commons('pd'), { id: 'x' }).info.mustCredit, false, 'public domain needs no credit kept up');
assert.ok(art.commonsPick(commons('cc0'), { id: 'x' }));
assert.ok(art.commonsPick(commons('cc-by-2.0'), { id: 'x' }));
['fal', 'gfdl', 'cc-by-nc-4.0', 'cc-by-nd-4.0', ''].forEach(function (l) {
  assert.strictEqual(art.commonsPick(commons(l), { id: 'x' }), null, 'licence ' + (l || 'none') + ' left out');
});
assert.strictEqual(art.commonsPick(commons('cc0', { mime: 'image/png' }), { id: 'x' }), null);
assert.strictEqual(art.commonsPick(commons('cc0', { width: 8000, height: 1500 }), { id: 'x' }), null, 'a panorama is too thin');
assert.strictEqual(art.commonsPick(commons('cc0', { width: 1200, height: 900 }), { id: 'x' }), null, 'too small for the screen');

var steps = [
  // Nothing picked and nothing uploaded: the message says where to add some.
  function (done) {
    art.save({ mine: true }, function () {
      art.next(function (r) {
        assert.strictEqual(r.ok, false);
        assert.ok(r.empty);
        assert.ok(/Screensaver tab/.test(r.message));
        assert.strictEqual(asked.length, 0, 'nothing asked of a museum until a collection is picked');
        done();
      });
    });
  },
  // What is not one of the choices is refused, and nothing changes.
  function (done) {
    art.save({ seconds: 7 }, function (r) {
      assert.strictEqual(r.ok, false);
      art.save({ collections: ['cma-european', 'nope'] }, function (r2) {
        assert.strictEqual(r2.ok, false);
        assert.deepEqual(art.status().settings.collections, []);
        done();
      });
    });
  },
  // A collection picked: two paintings come ahead, one at a time.
  function (done) {
    art.save({ collections: ['cma-modern'], seconds: 30 }, function (r) {
      assert.strictEqual(r.ok, true);
      assert.deepEqual(r.settings.collections, ['cma-modern']);
      later(function () {
        assert.strictEqual(fetched.length, 2, 'two fetched ahead');
        assert.ok(asked.every(function (u) { return /cc0=1/.test(u) && /Modern%20European/.test(u); }), 'public domain, from its department');
        assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'art-cache', 'queue.json'))).queue.length === 2);
        done();
      });
    });
  },
  // Each served is the next fetched; the queue fills behind it; only the last
  // five shown, for Previous, stay with the two waiting.
  function (done) {
    var ids = [];
    (function one(n) {
      if (!n) {
        assert.ok(ids.every(function (id, i) { return ids.indexOf(id) === i; }), 'no painting twice');
        later(function () {
          var files = fs.readdirSync(path.join(dir, 'art-cache')).filter(function (f) { return /\.jpg$/.test(f); });
          assert.ok(files.length <= 7, 'only a few kept: ' + files.join(' '));
          assert.ok(art.image(ids[ids.length - 1]), 'the one on screen is still there');
          assert.strictEqual(art.image(ids[0]), null, 'an old one is gone');
          done();
        });
        return;
      }
      art.next(function (r) {
        assert.strictEqual(r.ok, true);
        assert.ok(/^c-cma-\d+$/.test(r.id));
        assert.strictEqual(r.seconds, 30);
        assert.strictEqual(r.fit, 'fit');
        assert.strictEqual(r.info.credit, 'The Cleveland Museum of Art');
        ids.push(r.id);
        later(function () { one(n - 1); });
      });
    })(7);
  },
  // A picture of the owner's own, uploaded: taken in turn with the paintings.
  function (done) {
    var req = new events.EventEmitter();
    req.headers = { 'content-length': String(JPEG.length) };
    art.upload(req, function (r) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.pictures.length, 1);
      var kinds = [];
      (function one(n) {
        if (!n) {
          assert.ok(kinds.indexOf('p') !== -1 && kinds.indexOf('c') !== -1, 'both kinds: ' + kinds.join(''));
          assert.ok(!/pp|cc/.test(kinds.join('')), 'in turn: ' + kinds.join(''));
          return done();
        }
        art.next(function (r2) {
          kinds.push(r2.id.charAt(0));
          later(function () { one(n - 1); });
        });
      })(4);
    });
    req.emit('data', JPEG);
    req.emit('end');
  },
  // Not a JPEG: refused.
  function (done) {
    var req = new events.EventEmitter();
    var bad = new Buffer('not a picture');
    req.headers = { 'content-length': String(bad.length) };
    art.upload(req, function (r) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(art.status().pictures.length, 1);
      done();
    });
    req.emit('data', bad);
    req.emit('end');
  },
  // A picture's address is only one of these two kinds.
  function (done) {
    assert.strictEqual(art.image('../../etc/passwd'), null);
    assert.strictEqual(art.image('p-../x'), null);
    assert.ok(art.image('p-' + art.status().pictures[0]));
    done();
  },
  // The collection dropped: those waiting go, those shown lately stay for
  // Previous, and only the owner's are shown.
  function (done) {
    art.save({ collections: [] }, function () {
      var files = fs.readdirSync(path.join(dir, 'art-cache')).filter(function (f) { return /\.jpg$/.test(f) && f !== 'queue.json'; });
      art.next(function (r) {
        assert.strictEqual(r.id.charAt(0), 'p');
        assert.ok(files.length <= 5, 'only those shown lately stay, for Previous: ' + files.join(' '));
        done();
      });
    });
  },
  // Removed: nothing to show again. Settings survive a restart.
  function (done) {
    art.remove(art.status().pictures[0], function (r) {
      assert.strictEqual(r.pictures.length, 0);
      init();
      assert.strictEqual(art.status().settings.seconds, 30, 'kept over a restart');
      art.next(function (r2) {
        assert.ok(r2.empty);
        done();
      });
    });
  },
  // A network folder: found, added, its pictures fetched over the network.
  function (done) {
    var SV = { udn: 'uuid:nas', name: 'NAS', location: 'http://192.168.1.20:8200/d.xml', control: 'http://192.168.1.20:8200/ctl' };
    var browsed = [], got = [];
    dlna.discover = function (cb) { setTimeout(function () { cb(null, [SV]); }, 0); };
    dlna.describe = function (loc, cb) { setTimeout(function () { cb(null, { udn: SV.udn, name: SV.name, control: SV.control }); }, 0); };
    dlna.browse = function (control, id, max, cb) {
      browsed.push(id);
      setTimeout(function () {
        cb(null, { folders: [{ id: '64$1', title: 'Trips', count: 2 }], total: 3, pictures: id === '64' ? [
          { id: 'a', title: 'Beach', date: '2019-07-01', url: 'http://192.168.1.20:8200/a.jpg' },
          { id: 'b', title: 'Hill', date: '', url: 'http://192.168.1.20:8200/b.jpg' }] : [] });
      }, 0);
    };
    dlna.fetchFile = function (u, max, cb) { got.push(u); setTimeout(function () { cb(null, JPEG); }, 0); };
    init();
    art.save({ mine: false, collections: [] }, function () {
      art.addFolder('uuid:nas', '64', 'Photos', function (r0) {
        assert.strictEqual(r0.ok, false, 'not before the servers are looked for');
        art.findServers(function (s) {
          assert.deepEqual(s.servers, [{ udn: 'uuid:nas', name: 'NAS' }]);
          art.browseFolder('uuid:nas', '64', function (b) {
            assert.strictEqual(b.pictures, 2);
            assert.deepEqual(b.folders, [{ id: '64$1', title: 'Trips', count: 2 }]);
            art.addFolder('uuid:nas', '64', 'Photos', function (r) {
              assert.strictEqual(r.ok, true);
              assert.strictEqual(r.folders.length, 1);
              assert.strictEqual(r.folders[0].server, 'NAS');
              later(function () {
                assert.strictEqual(got.length, 2, 'two fetched ahead from the folder');
                art.next(function (n) {
                  assert.ok(/^c-dl-[0-9a-f]{16}$/.test(n.id));
                  assert.strictEqual(n.info.credit, 'Photos \u00b7 NAS');
                  assert.ok(n.info.date === '2019' || n.info.date === '');
                  var key = r.folders[0].key;
                  init();
                  assert.strictEqual(art.status().folders[0].key, key, 'kept over a restart');
                  art.removeFolder(key, function (r2) {
                    assert.strictEqual(r2.folders.length, 0);
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });
  },
  // Previous and Next: back through those shown, forward through them again,
  // then a new one; a command the views ask for; the remote's arrows only
  // while the No Signal screen asks.
  function (done) {
    getJson = function (url, cb) { setTimeout(function () { cb(null, { info: { total: 50 }, data: [record(next++)] }); }, 0); };
    init();
    art.save({ mine: false, collections: ['cma-european'] }, function () {
      var ids = [];
      (function step(n) {
        if (n) return later(function () { art.next(function (r) { ids.push(r.id); step(n - 1); }); });
        art.next(function (back) {
          assert.strictEqual(back.id, ids[1], 'Previous: the one before');
          assert.ok(art.status().canGoBack);
          art.next(function (fwd) {
            assert.strictEqual(fwd.id, ids[2], 'Next after going back: forward through those shown');
            later(function () {
              art.next(function (fresh) {
                assert.ok(ids.indexOf(fresh.id) === -1, 'then a new one');
                assert.strictEqual(art.status().current.id, fresh.id);
                assert.strictEqual(art.status().showing, false, 'no view has asked yet');
                var p0 = art.poll('saver');
                assert.strictEqual(art.status().showing, true);
                art.go('prev', function (st) {
                  assert.strictEqual(art.poll('saver').seq, p0.seq + 1);
                  assert.strictEqual(art.poll('saver').dir, 'prev');
                  art.go('sideways', function (bad) {
                    assert.strictEqual(bad.ok, false);
                    // Arrows: ignored until the No Signal screen asks.
                    art.keyPressed(106);
                    assert.strictEqual(art.poll('saver').seq, p0.seq + 1);
                    art.poll('nosignal');
                    assert.deepEqual(keysWatched.slice(-1), [true], 'the remote watched');
                    art.keyPressed(106);
                    assert.deepEqual([art.poll('nosignal').seq, art.poll('nosignal').dir], [p0.seq + 2, 'next']);
                    art.keyPressed(105);
                    assert.strictEqual(art.poll('nosignal').dir, 'prev');
                    art.keyPressed(28);
                    assert.strictEqual(art.poll('nosignal').seq, p0.seq + 3, 'other keys left alone');
                    done();
                  });
                });
              });
            });
          });
        }, 'prev');
      })(3);
    });
  },
  // Minutes saved by an earlier build are read as seconds.
  function (done) {
    fs.writeFileSync(path.join(dir, 'art.json'), JSON.stringify({ minutes: 15 }));
    init();
    assert.strictEqual(art.status().settings.seconds, 900);
    done();
  },
  // A museum that does not answer: said on the dashboard, nothing shown.
  function (done) {
    getJson = function (url, cb) { setTimeout(function () { cb(new Error('timed out')); }, 0); };
    init();
    art.save({ collections: ['cma-asian'] }, function () {
      later(function () {
        assert.ok(/timed out/.test(art.status().error));
        art.next(function (r) {
          assert.strictEqual(r.ok, false);
          assert.ok(r.waiting);
          done();
        });
      });
    });
  }
];

(function run(i) {
  if (i === steps.length) {
    console.log('test-art.js: all passed');
    return;
  }
  steps[i](function () { run(i + 1); });
})(0);
