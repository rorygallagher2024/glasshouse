/**
 * test/test-iptv-enigma2.js - an Enigma2 receiver as an Internet TV source,
 * end to end: the server module starting real worker processes that download
 * from a local stand-in for the receiver's OpenWebif through curl
 *
 * @slow: started first by run-all.js, which runs a few suites at a time.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var urlLib = require('url');
var toBuffer = require('../server/lib/util').toBuffer;

console.log('Running test-iptv-enigma2.js ...');

var CURL = ['/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl'].filter(function (c) { return fs.existsSync(c); })[0];
if (!CURL) {
  console.log('  - skipped: no curl to download with');
  console.log('ALL test-iptv-enigma2.js assertions passed!\n');
  process.exit(0);
}

var stateDir = path.join(os.tmpdir(), 'iptv-e2-test-' + process.pid + '-' + Date.now());
fs.mkdirSync(stateDir);

// ---------------------------------------------------------------- a receiver

var PNG = toBuffer('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGP8z8DwnwEPYMIjBwBTZgH/2EydfwAAAABJRU5ErkJggg==', 'base64');
var USER = 'root', PASS = 'canary-pass';
var POLSKIE = '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.pl.tv" ORDER BY bouquet';
var SPORT = '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.sport.tv" ORDER BY bouquet';
var TVP_HD = '1:0:1:1138:2AF8:13E:820000:0:0:0:';
var TVN = '1:0:1:2B1:3E8:13E:820000:0:0:0:';
var SPORT_ONE = '1:0:1:3390:2BC0:71:820000:0:0:0:';
var hits = { m3u: [], epg: [], noLogin: 0, zap: [], about: 0 };
var tuners = [];

function decodeRef(u) {
  var m = /[?&]bRef=([^&]*)/.exec(u);
  return m ? decodeURIComponent(m[1]) : '';
}

// The tuner's stream port: a transport stream behind the same login, and what it was asked for.
var streamHits = [];
var sessions = 0;
var TS_BYTES = toBuffer(new Array(188 * 40 + 1).join('G'), 'utf8');
var streamer = http.createServer(function (req, res) {
  var auth = /^Basic (.+)$/.exec(req.headers.authorization || '');
  streamHits.push({ path: req.url, auth: !!auth });
  if (!auth || toBuffer(auth[1], 'base64').toString('utf8') !== USER + ':' + PASS) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="streaming"' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'video/MP2T' });
  res.end(TS_BYTES);
});
var streamBase = '';

var receiver = http.createServer(function (req, res) {
  var base = 'http://127.0.0.1:' + receiver.address().port;
  var u = req.url;
  var auth = /^Basic (.+)$/.exec(req.headers.authorization || '');
  var ok = auth && toBuffer(auth[1], 'base64').toString('utf8') === USER + ':' + PASS;
  if (!ok) {
    hits.noLogin++;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenWebif"' });
    return res.end('<html>401</html>');
  }
  if (u === '/api/getservices') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ result: true, services: [
      { servicename: 'Polskie', servicereference: POLSKIE },
      { servicename: 'Sport', servicereference: SPORT },
      { servicename: 'Not a bouquet', servicereference: TVP_HD }
    ] }));
  }
  if (/^\/web\/services\.m3u/.test(u)) {
    var ref = decodeRef(u);
    hits.m3u.push(ref);
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    if (ref === POLSKIE) {
      // A receiver with a login names a new session in the addresses of each read.
      var session = function (u) { return u.replace('://', '://-sid:token' + (++sessions) + '@'); };
      return res.end('#EXTM3U \n' +
        '#EXTVLCOPT:http-reconnect=true\n#EXTINF:-1 tvg-chno="4408" tvg-logo="' + session(base) + '/picon/tvp hd.png" tvg-id="' + TVP_HD + '",TVP HD\n#EXTVLCOPT:program=4408\n' + session(streamBase) + '/' + TVP_HD + '\n' +
        '#EXTINF:-1 tvg-id="1:64:1:0:0:0:0:0:0:0:",--- News ---\n' + streamBase + '/1:64:1:0:0:0:0:0:0:0:\n' +
        '#EXTINF:-1 tvg-id="' + TVN + '" tvg-logo="' + base + '/picon/tvn.png",TVN\n' + streamBase + '/' + TVN + '\n');
    }
    return res.end('#EXTM3U \n#EXTINF:-1 tvg-id="' + SPORT_ONE + '" tvg-logo="' + base + '/picon/sport one.png",Sport One\n' + streamBase + '/' + SPORT_ONE + '\n');
  }
  if (/^\/picon\//.test(u)) {
    if (decodeURIComponent(u) !== '/picon/tvp hd.png') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PNG);
  }
  if (u === '/api/about') {
    hits.about++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ info: { tuners: tuners, streams: [] } }));
  }
  if (/^\/api\/zap/.test(u)) {
    hits.zap.push(decodeURIComponent(/[?&]sRef=([^&]*)/.exec(u)[1]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ result: true, message: 'zapped' }));
  }
  if (/^\/api\/epgmulti/.test(u)) {
    hits.epg.push(decodeRef(u));
    var now = Math.floor(Date.now() / 1000), events = [];
    function ev(sref, name, id, from, minutes, title) {
      events.push({ id: String(id), begin_timestamp: String(now + from), duration_sec: String(minutes * 60), title: title,
        shortdesc: '', longdesc: 'About ' + title, sref: sref, sname: name, now_timestamp: String(now) });
    }
    if (decodeRef(u) === POLSKIE) {
      // Grouped by channel, as the receiver answers; TVN has none; a service not asked for comes first.
      ev('1:0:1:9999:1:1:820000:0:0:0:', 'Other', 1, -600, 60, 'Not in the lineup');
      ev(TVP_HD, 'TVP HD', 10, -1800, 60, 'Evening News');
      ev(TVP_HD, 'TVP HD', 11, 1800, 90, 'Late Film');
      ev(TVP_HD, 'TVP HD', 12, 6 * 86400, 60, 'Week Ahead');
      ev(TVP_HD, 'TVP HD', 13, 9 * 86400, 60, 'Too Far Ahead');
    } else {
      ev(SPORT_ONE, 'Sport One', 20, -900, 120, 'Live Match');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ events: events, result: true }));
  }
  res.writeHead(404);
  res.end();
});

// ---------------------------------------------------------------- helpers

var iptv = require('../server/lib/iptv');
var changes = 0;

function wait(test, cb, ms) {
  var until = Date.now() + (ms || 20000);
  (function poll() {
    if (test()) return cb();
    if (Date.now() > until) throw new Error('timed out waiting');
    setTimeout(poll, 50);
  })();
}

function playlistOf(id) {
  var list = iptv.status().playlists;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function idle() {
  var st = iptv._state();
  return !st.running.background && !st.queue.length;
}

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function run(i) {
  if (i >= steps.length) return finish();
  steps[i].fn(function () {
    console.log('  ✓ ' + steps[i].name);
    run(i + 1);
  });
}

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) fs.readdirSync(p).forEach(function (n) { rmTree(path.join(p, n)); });
  try { if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); } catch (e) {}
}

function finish() {
  iptv.stop();
  receiver.close();
  streamer.close();
  try { relayServer.close(); } catch (e) {}
  rmTree(stateDir);
  console.log('ALL test-iptv-enigma2.js assertions passed!\n');
  process.exit(0);
}

function utcDay(ms) {
  var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

// ---------------------------------------------------------------- steps

var pl = null, address = null, tvp = null;

step('a wrong login is refused as a login, and the receiver is asked nothing else', function (done) {
  iptv.playlistsAction({ action: 'add', kind: 'enigma2', server: address, user: USER, pass: 'wrong' }, function (r) {
    assert.equal(r.ok, true);
    wait(function () { var p = playlistOf(r.id); return p && p.loginRefused; }, function () {
      var p = playlistOf(r.id);
      assert.equal(p.error.code, 'login');
      assert.deepEqual(hits.m3u, [], 'no bouquet was read');
      iptv.playlistsAction({ action: 'remove', id: r.id }, function () { done(); });
    });
  });
});

step('a receiver with a login is read: its bouquets are the groups, a bare host:port is enough', function (done) {
  iptv.playlistsAction({ action: 'add', kind: 'enigma2', server: address, user: USER, pass: PASS }, function (r) {
    assert.equal(r.ok, true);
    pl = r.id;
    wait(function () { var p = playlistOf(pl); return p && p.ready && idle(); }, function () {
      var p = playlistOf(pl);
      assert.equal(p.kind, 'enigma2');
      assert.equal(p.host, '127.0.0.1');
      // TVP HD and TVN, and Sport One: the marker is no channel, and a service that is no bouquet is not one.
      assert.equal(p.channels, 3);
      assert.equal(p.groups, 2);
      assert.deepEqual(hits.m3u.sort(), [POLSKIE, SPORT].sort(), 'each bouquet read once');
      assert.equal(fs.statSync(path.join(stateDir, 'iptv', 'config.json')).mode & 511, 384, 'its login is in a 0600 file');
      done();
    });
  });
});

step('no reply carries the address, user or password', function (done) {
  var text = JSON.stringify([iptv.status(), iptv.rowItems(), iptv.rowStatus(), iptv.nowNext(), iptv.lineup()]);
  assert.ok(text.indexOf(PASS) === -1 && text.indexOf('root') === -1 && text.indexOf(address) === -1);
  iptv.groups(pl, function (g) {
    assert.deepEqual(g.groups.map(function (x) { return x.name; }).sort(), ['Polskie', 'Sport']);
    assert.ok(JSON.stringify(g).indexOf(PASS) === -1);
    done();
  });
});

step('a channel numbered in its bouquet, with the receiver\'s stream URL and a picon fetched behind the login', function (done) {
  iptv.search(pl, 'tvp', '', function (s) {
    var c = s.channels[0];
    assert.equal(c.name, 'TVP HD');
    tvp = c;
    iptv.setSelection({ action: 'add', channels: [{ pl: pl, key: c.key, name: c.name, group: c.group }] }, function (r) {
      assert.equal(r.ok, true);
      wait(function () { return idle() && iptv.rowItems().length === 1 && /^\/api\/iptv\/logo\?/.test(iptv.rowItems()[0].logo || ''); }, function () {
        var item = iptv.rowItems()[0];
        var logoId = /id=([0-9a-f]+)/.exec(item.logo)[1];
        assert.ok(iptv.logoPath(pl, logoId), 'the picon was fetched with the login and kept');
        assert.equal(iptv.streamUrl(pl, c.key).url, streamBase + '/' + TVP_HD);
        done();
      });
    });
  });
});

step('the receiver\'s guide for the lineup: each channel by its service reference, a week ahead and no further', function (done) {
  wait(function () { return iptv.nowNext().guide[pl + ':' + tvp.key]; }, function () {
    var nn = iptv.nowNext().guide[pl + ':' + tvp.key];
    assert.equal(nn[0].title, 'Evening News');
    assert.equal(nn[1].title, 'Late Film');
    assert.deepEqual(hits.epg, [POLSKIE], 'one read, of the bouquet the lineup has a channel in');
    var week = utcDay(Date.now() + 6 * 86400000);
    var file = iptv.schedulePath(pl, tvp.key, week);
    assert.ok(file, 'a day six days ahead is in the grid');
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).some(function (p) { return p[2] === 'Week Ahead'; }));
    assert.strictEqual(iptv.schedulePath(pl, tvp.key, utcDay(Date.now() + 9 * 86400000)), null, 'nothing past the week');
    done();
  });
});

step('a channel the receiver has no guide for does not break the others', function (done) {
  iptv.search(pl, 'tvn', '', function (s) {
    var c = s.channels[0];
    assert.equal(c.name, 'TVN');
    iptv.setSelection({ action: 'add', channels: [{ pl: pl, key: c.key, name: c.name, group: c.group }] }, function (r) {
      assert.equal(r.ok, true);
      wait(function () { return idle() && iptv.rowItems().length === 2; }, function () {
        assert.ok(iptv.nowNext().guide[pl + ':' + tvp.key], 'the other keeps its programmes');
        assert.ok(!iptv.nowNext().guide[pl + ':' + c.key], 'TVN has none');
        done();
      });
    });
  });
});

function playOnce(cb) {
  var zaps = hits.zap.length;
  iptv.playUrl(pl, tvp.key, false, function (stream) {
    assert.equal(stream.url, streamBase + '/' + TVP_HD);
    cb(hits.zap.length - zaps);
  });
}

step('a busy tuner is left alone unless the owner allows moving it', function (done) {
  tuners = [{ name: 'Tuner A', rec: '', live: 'TVN', stream: '' }];
  playOnce(function (zaps) {
    assert.equal(zaps, 0, 'takeOver is off by default');
    assert.equal(playlistOf(pl).takeOver, false);
    iptv.playlistsAction({ action: 'edit', id: pl, takeOver: true }, function (r) {
      assert.equal(r.ok, true);
      wait(function () { var p = playlistOf(pl); return idle() && p.ready && p.takeOver === true; }, function () { done(); });
    });
  });
});

step('with it on, the only tuner showing live TV is moved to the channel', function (done) {
  tuners = [{ name: 'Tuner A', rec: '', live: 'TVN', stream: '' }];
  playOnce(function (zaps) {
    assert.equal(zaps, 1);
    assert.equal(hits.zap[hits.zap.length - 1], TVP_HD);
    done();
  });
});

step('a free tuner is used as it is, and a recording or another stream is never moved', function (done) {
  tuners = [{ name: 'Tuner A', rec: '', live: 'TVN', stream: '' }, { name: 'Tuner B', rec: '', live: '', stream: '' }];
  playOnce(function (free) {
    assert.equal(free, 0, 'a free tuner');
    tuners = [{ name: 'Tuner A', rec: 'Film', live: 'Film', stream: '' }];
    playOnce(function (rec) {
      assert.equal(rec, 0, 'a recording');
      tuners = [{ name: 'Tuner A', rec: '', live: '', stream: '192.168.1.5' }];
      playOnce(function (other) {
        assert.equal(other, 0, 'another stream');
        done();
      });
    });
  });
});

var relayServer = http.createServer(function (req, res) {
  var q = urlLib.parse(req.url, true).query;
  iptv.relay(String(q.pl || ''), String(q.key || ''), req, res);
});
function viaRelay(cb) {
  var path = '/api/iptv/relay?pl=' + encodeURIComponent(pl) + '&key=' + encodeURIComponent(tvp.key);
  http.get({ host: '127.0.0.1', port: relayServer.address().port, path: path, agent: false }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(res.statusCode, Buffer.concat(chunks)); });
  });
}

step('a stream is not relayed unless the owner says the tuner\'s stream port wants a login', function (done) {
  relayServer.listen(0, '127.0.0.1', function () {
    viaRelay(function (status) {
      assert.equal(status, 404);
      assert.equal(streamHits.length, 0, 'the tuner was not asked');
      iptv.playlistsAction({ action: 'edit', id: pl, streamLogin: true }, function (r) {
        assert.equal(r.ok, true);
        wait(function () { var p = playlistOf(pl); return idle() && p.ready && p.streamLogin === true; }, function () { done(); });
      });
    });
  });
});

step('with it on, Home is given the relay and the tuner is asked with the login', function (done) {
  iptv.playUrl(pl, tvp.key, true, function (stream) {
    assert.ok(/^\/api\/iptv\/relay\?pl=/.test(stream.url), 'the relay, not the tuner\'s address');
    assert.equal(stream.format, 'ts');
    assert.ok(stream.url.indexOf('127.0.0.1') === -1 && stream.url.indexOf(PASS) === -1);
    viaRelay(function (status, body) {
      assert.equal(status, 200);
      assert.equal(body.length, TS_BYTES.length);
      assert.deepEqual(streamHits[streamHits.length - 1], { path: '/' + TVP_HD, auth: true });
      done();
    });
  });
});

step('a refused login on the stream port is a 502, and the password is not stuck to it', function (done) {
  iptv.playlistsAction({ action: 'edit', id: pl, pass: 'wrong' }, function (r) {
    assert.equal(r.ok, true);
    viaRelay(function (status) {
      assert.equal(status, 502);
      iptv.playlistsAction({ action: 'edit', id: pl, pass: PASS }, function (r2) {
        assert.equal(r2.ok, true);
        wait(function () { var p = playlistOf(pl); return idle() && p.ready && !p.loginRefused; }, function () {
          // Read again with a new session in every address: the channel keeps its key.
          iptv.search(pl, 'tvp', '', function (s) {
            assert.equal(s.channels[0].key, tvp.key);
            done();
          });
        });
      });
    });
  });
});

step('a stream port set on the tuner replaces the one in every channel\'s URL', function (done) {
  iptv.playlistsAction({ action: 'edit', id: pl, streamPort: '8002' }, function (r) {
    assert.equal(r.ok, true);
    wait(function () { var p = playlistOf(pl); return idle() && p.ready && p.streamPort === 8002; }, function () {
      assert.equal(iptv.streamUrl(pl, tvp.key).url, streamBase.replace(/:\d+$/, ':8002') + '/' + TVP_HD);
      iptv.playlistsAction({ action: 'edit', id: pl, streamPort: '' }, function (r2) {
        assert.equal(r2.ok, true);
        wait(function () { var p2 = playlistOf(pl); return idle() && p2.ready && p2.streamPort === 0; }, function () {
          assert.equal(iptv.streamUrl(pl, tvp.key).url, streamBase + '/' + TVP_HD, 'cleared, the tuner\'s own port is used again');
          done();
        });
      });
    });
  });
});

step('a stream port out of range is refused when added or edited', function (done) {
  iptv.playlistsAction({ action: 'edit', id: pl, streamPort: '0' }, function (r) {
    assert.deepEqual([r.ok, r.error], [false, 'streamPort']);
    iptv.playlistsAction({ action: 'edit', id: pl, streamPort: '70000' }, function (r2) {
      assert.deepEqual([r2.ok, r2.error], [false, 'streamPort']);
      iptv.playlistsAction({ action: 'edit', id: pl, streamPort: '8002abc' }, function (r3) {
        assert.deepEqual([r3.ok, r3.error], [false, 'streamPort'], 'only a whole number is a port');
        done();
      });
    });
  });
});

step('an edit keeps the login that was set, and noLogin clears it', function (done) {
  iptv.playlistsAction({ action: 'edit', id: pl, label: 'Living room' }, function (r) {
    assert.equal(r.ok, true);
    wait(function () { var p = playlistOf(pl); return idle() && p.label === 'Living room' && !p.error && p.ready; }, function () {
      var before = hits.noLogin;
      iptv.playlistsAction({ action: 'edit', id: pl, noLogin: true }, function (r2) {
        assert.equal(r2.ok, true);
        wait(function () { var p = playlistOf(pl); return idle() && p.loginRefused; }, function () {
          assert.ok(hits.noLogin > before, 'the receiver was asked with no login, and refused');
          done();
        });
      });
    });
  });
});

step('a favourite whose key moved follows its channel, though a whole group carries it', function (done) {
  iptv.playlistsAction({ action: 'edit', id: pl, user: USER, pass: PASS }, function (r0) {
  assert.equal(r0.ok, true);
  wait(function () { var p = playlistOf(pl); return idle() && p.ready && !p.loginRefused; }, function () {
  iptv.setLineup({ action: 'add-group', pl: pl, group: 'Polskie' }, function (r) {
    assert.equal(r.ok, true);
    wait(function () { return idle(); }, function () {
      var file = path.join(stateDir, 'iptv', 'selection.json');
      var text = fs.readFileSync(file, 'utf8');
      assert.ok(text.indexOf(tvp.key) !== -1, 'the favourite is in the saved selection');
      // A newer generation, as an edit made while the server was off would leave: the select job reads it again.
      fs.writeFileSync(file, text.split(tvp.key).join('mstalekey0001').replace(/"generation":(\d+)/, function (m, n) { return '"generation":' + (+n + 1); }));
      iptv.stop();
      iptv.init({ stateDir: stateDir, clients: function () { return [CURL]; }, version: 'test', catchupMs: 0,
        onChange: function () { changes++; } });
      iptv.start();
      wait(function () {
        var favs = iptv.lineup().favourites;
        return idle() && favs.indexOf(pl + ':' + tvp.key) !== -1;
      }, function () {
        assert.ok(iptv.lineup().favourites.indexOf(pl + ':mstalekey0001') === -1, 'the old key is gone');
        done();
      });
    });
  });
  });
  });
});

step('an address and a login are checked when added', function (done) {
  iptv.playlistsAction({ action: 'add', kind: 'enigma2', server: '', user: USER, pass: PASS }, function (r) {
    assert.deepEqual([r.ok, r.error], [false, 'server']);
    iptv.playlistsAction({ action: 'add', kind: 'enigma2', server: 'http://user:secret@box.test', user: USER, pass: PASS }, function (r2) {
      // A login in the address is refused, not read as the host.
      assert.deepEqual([r2.ok, r2.error], [false, 'server']);
      iptv.playlistsAction({ action: 'add', kind: 'enigma2', server: 'box.test', user: '', pass: 'p' }, function (r3) {
        // A password with no user is no login.
        assert.deepEqual([r3.ok, r3.error], [false, 'login']);
        done();
      });
    });
  });
});

streamer.listen(0, '127.0.0.1', function () {
  streamBase = 'http://127.0.0.1:' + streamer.address().port;
receiver.listen(0, '127.0.0.1', function () {
  address = '127.0.0.1:' + receiver.address().port;
  iptv.init({ stateDir: stateDir, clients: function () { return [CURL]; }, version: 'test', catchupMs: 0,
    onChange: function () { changes++; } });
  iptv.start();
  run(0);
});
});

setTimeout(function () { console.error('test-iptv-enigma2.js timed out'); process.exit(1); }, 120000).unref();
