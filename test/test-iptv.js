/**
 * test/test-iptv.js - Internet TV end to end: the server module starting real
 * worker processes that download from a local provider through curl, and
 * what it publishes, keeps and refuses
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var zlib = require('zlib');
var toBuffer = require('../server/lib/util').toBuffer;

console.log('Running test-iptv.js ...');

var CURL = ['/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl'].filter(function (c) { return fs.existsSync(c); })[0];
if (!CURL) {
  console.log('  - skipped: no curl to download with');
  console.log('ALL test-iptv.js assertions passed!\n');
  process.exit(0);
}

var stateDir = path.join(os.tmpdir(), 'iptv-test-' + process.pid + '-' + Date.now());
fs.mkdirSync(stateDir);

// ---------------------------------------------------------------- a provider

var PNG = toBuffer('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGP8z8DwnwEPYMIjBwBTZgH/2EydfwAAAABJRU5ErkJggg==', 'base64');
var mode = 'ok';
var hits = {};
var provider = http.createServer(function (req, res) {
  var u = req.url;
  hits[u.split('?')[0]] = (hits[u.split('?')[0]] || 0) + 1;
  var base = 'http://127.0.0.1:' + provider.address().port;
  if (/^\/list\.m3u/.test(u)) {
    if (mode === '500') { res.writeHead(500); return res.end('no'); }
    if (mode === '401') { res.writeHead(401); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    var extra = mode === 'more' ? '#EXTINF:-1 group-title="News",Late Addition\nhttp://s.test/9.m3u8?token=SECRET-TOKEN-Q\n' : '';
    return res.end('#EXTM3U url-tvg="' + base + '/guide.xml.gz"\n' +
      '#EXTINF:-1 tvg-id="hs1.uk" tvg-logo="' + base + '/logo.png" group-title="Sport",Harbour Sport 1\nhttp://s.test/1.m3u8?token=SECRET-TOKEN-Q\n' +
      '#EXTINF:-1 tvg-id="wt.uk" group-title="News",World Today\nhttp://s.test/2.m3u8?token=SECRET-TOKEN-Q\n' +
      '#EXTINF:-1 group-title="News",### NEWS ###\nhttp://s.test/0.m3u8\n' + extra);
  }
  if (/^\/xmltv\.php/.test(u) && u.indexOf('username=canary-user&password=canary-pass') === -1) { res.writeHead(401); return res.end('no'); }
  if (/^\/(guide\.xml\.gz|xmltv\.php)/.test(u)) {
    var now = Date.now(), t = Math.floor(now / 3600000) * 3600000;
    var fmt = function (ms) {
      var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + '00 +0000';
    };
    var xml = '<tv><channel id="hs1.uk"><display-name>Harbour Sport 1</display-name></channel>' +
      '<programme start="' + fmt(t) + '" stop="' + fmt(t + 3600000) + '" channel="hs1.uk"><title>Leeds v Fulham</title></programme>' +
      '<programme start="' + fmt(t + 3600000) + '" stop="' + fmt(t + 7200000) + '" channel="hs1.uk"><title>Final Score</title></programme></tv>';
    res.writeHead(200);
    return res.end(zlib.gzipSync ? zlib.gzipSync(xml) : xml);
  }
  if (u === '/logo.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
  if (/^\/player_api\.php/.test(u)) {
    var ok = u.indexOf('username=canary-user&password=canary-pass') !== -1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!ok) return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    if (u.indexOf('action=get_live_categories') !== -1) return res.end(JSON.stringify([{ category_id: '1', category_name: 'Sport' }]));
    if (u.indexOf('action=get_short_epg') !== -1 && mode === 'epg-refused') return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    if (u.indexOf('action=get_live_streams') !== -1) {
      return res.end(JSON.stringify([{ num: 1, name: 'Harbour Sport 1', stream_type: 'live', stream_id: 101, category_id: '1', epg_channel_id: 'hs1.uk' },
        { num: 2, name: 'Harbour Sport 2', stream_type: 'live', stream_id: 102, category_id: '1' }]));
    }
    return res.end(JSON.stringify({ user_info: { auth: 1, status: 'Active', exp_date: '1801436400', max_connections: '1', active_cons: '0',
      allowed_output_formats: ['m3u8', 'ts'] } }));
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

function finish() {
  iptv.stop();
  provider.close();
  rmTree(stateDir);
  console.log('ALL test-iptv.js assertions passed!\n');
  process.exit(0);
}

function rmTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) fs.readdirSync(p).forEach(function (n) { rmTree(path.join(p, n)); });
  try { if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); } catch (e) {}
}

// Every reply the dashboard can get, as text, for the secrets test.
function everyReply(cb) {
  var out = [JSON.stringify(iptv.status()), JSON.stringify(iptv.rowItems()), JSON.stringify(iptv.rowStatus()), JSON.stringify(iptv.nowNext()),
    JSON.stringify(iptv.lineup())];
  var ids = iptv.status().playlists.map(function (p) { return p.id; });
  var left = ids.length * 2;
  if (!left) return cb(out.join('\n'));
  ids.forEach(function (id) {
    iptv.search(id, 'harbour', '', function (r) { out.push(JSON.stringify(r)); if (--left === 0) cb(out.join('\n')); });
    iptv.groups(id, function (r) { out.push(JSON.stringify(r)); if (--left === 0) cb(out.join('\n')); });
  });
}

// ---------------------------------------------------------------- steps

var m3u = null, xc = null, base = null;

step('an M3U link is read by a worker and published, with no link or token in any reply', function (done) {
  iptv.playlistsAction({ action: 'add', kind: 'm3u', label: 'Test list', url: base + '/list.m3u?token=SECRET-TOKEN-Q' }, function (r) {
    assert.equal(r.ok, true);
    m3u = r.id;
    wait(function () { var p = playlistOf(m3u); return p && p.ready && idle(); }, function () {
      var p = playlistOf(m3u);
      assert.equal(p.channels, 3);
      assert.equal(p.groups, 2);
      assert.equal(p.host, '127.0.0.1');
      assert.equal(p.guideInPlaylist, true);
      assert.ok(changes > 0, 'Home is told something changed');
      var mode600 = fs.statSync(path.join(stateDir, 'iptv', 'config.json')).mode & 511;
      assert.equal(mode600, 384, 'config.json is 0600');
      assert.equal(fs.statSync(path.join(stateDir, 'iptv')).mode & 511, 448, 'its folder is 0700');
      done();
    });
  });
});

step('search runs in a worker and leaves out the provider’s headings', function (done) {
  iptv.search(m3u, 'news', '', function (r) {
    assert.equal(r.ok, true);
    assert.equal(r.total, 0);
    iptv.browse(m3u, 'News', 0, function (b) {
      assert.deepEqual(b.channels.map(function (c) { return c.name; }), ['World Today']);
      iptv.search(m3u, 'harbour', '', function (s) {
        assert.equal(s.channels.length, 1);
        assert.equal(s.channels[0].added, false);
        done();
      });
    });
  });
});

step('an added channel gets its logo and play URL, and the guide in the playlist gives now and next', function (done) {
  iptv.search(m3u, 'harbour', '', function (s) {
    var c = s.channels[0];
    iptv.setSelection({ action: 'add', channels: [{ pl: m3u, key: c.key, name: c.name, group: c.group }] }, function (r) {
      assert.equal(r.ok, true);
      wait(function () { return idle() && iptv.nowNext().guide[m3u + ':' + c.key]; }, function () {
        var item = iptv.rowItems()[0];
        assert.equal(item.name, 'Harbour Sport 1');
        assert.ok(/^\/api\/iptv\/logo\?/.test(item.logo), 'a logo the server serves');
        var logoId = /id=([0-9a-f]+)/.exec(item.logo)[1];
        assert.ok(iptv.logoPath(m3u, logoId), 'the checked logo is on disk');
        assert.equal(iptv.logoPath(m3u, '../../etc/passwd'), null);
        var s2 = iptv.streamUrl(m3u, c.key);
        assert.equal(s2.url, 'http://s.test/1.m3u8?token=SECRET-TOKEN-Q');
        assert.equal(s2.format, 'hls');
        var nn = iptv.nowNext().guide[m3u + ':' + c.key];
        assert.equal(nn[0].title, 'Leeds v Fulham');
        assert.equal(nn[1].title, 'Final Score');
        assert.ok(iptv.nowNext().nextChange > Date.now());
        done();
      });
    });
  });
});

step('a failed refresh keeps the last list published and says why', function (done) {
  mode = '500';
  var before = iptv._state().current[m3u].snap;
  iptv.playlistsAction({ action: 'refresh', id: m3u }, function () {
    wait(function () { var p = playlistOf(m3u); return idle() && p.error; }, function () {
      var p = playlistOf(m3u);
      assert.deepEqual([p.error.code, p.error.status], ['http', 500]);
      assert.equal(iptv._state().current[m3u].snap, before);
      assert.equal(p.ready, true);
      assert.equal(iptv.rowItems().length, 1, 'the row keeps its channel');
      mode = 'ok';
      done();
    });
  });
});

step('an edit reads the list again, and the next snapshot replaces the last', function (done) {
  mode = 'more';
  var before = iptv._state().current[m3u].snap;
  iptv.playlistsAction({ action: 'edit', id: m3u, label: 'Renamed' }, function (r) {
    assert.equal(r.ok, true);
    wait(function () { var p = playlistOf(m3u); return idle() && p.channels === 4 && !p.error; }, function () {
      assert.notEqual(iptv._state().current[m3u].snap, before);
      assert.equal(playlistOf(m3u).label, 'Renamed');
      // The old candidate goes once nothing points at it (after a minute; not waited for here).
      mode = 'ok';
      done();
    });
  });
});

step('an Xtream login is checked, and a refused one stops its refreshes until it is edited', function (done) {
  iptv.playlistsAction({ action: 'add', kind: 'xtream', label: 'Panel', server: base + '/', user: 'canary-user', pass: 'wrong-pass' }, function (r) {
    xc = r.id;
    wait(function () { var p = playlistOf(xc); return idle() && p.error; }, function () {
      var p = playlistOf(xc);
      assert.equal(p.error.code, 'login');
      assert.equal(p.loginRefused, true);
      var calls = hits['/player_api.php'];
      iptv._catchUp(0);
      setTimeout(function () {
        assert.equal(hits['/player_api.php'], calls, 'no second try at a refused login');
        iptv.playlistsAction({ action: 'edit', id: xc, pass: 'canary-pass' }, function () {
          wait(function () { var q = playlistOf(xc); return idle() && q.ready; }, function () {
            var q = playlistOf(xc);
            assert.equal(q.loginRefused, false);
            assert.equal(q.channels, 2);
            assert.deepEqual([q.account.maxConnections, q.account.format], [1, 'm3u8']);
            done();
          });
        });
      }, 300);
    });
  });
});

step('the password is write-only: an edit without one keeps it, and no reply carries it', function (done) {
  var stored = iptv._state().config.playlists.filter(function (p) { return p.id === xc; })[0];
  assert.equal(stored.pass, 'canary-pass');
  iptv.playlistsAction({ action: 'edit', id: xc, label: 'Panel 2', pass: '' }, function () {
    stored = iptv._state().config.playlists.filter(function (p) { return p.id === xc; })[0];
    assert.equal(stored.pass, 'canary-pass');
    wait(idle, function () {
      everyReply(function (text) {
        ['canary-user', 'canary-pass', 'SECRET-TOKEN-Q', 'list.m3u', 'player_api'].forEach(function (secret) {
          assert.equal(text.indexOf(secret), -1, secret + ' must not be in a reply');
        });
        done();
      });
    });
  });
});

step('searches asked for together run one at a time, the newest replacing the rest', function (done) {
  var answers = [];
  var check = function () {
    if (answers.length < 3) return;
    assert.deepEqual(answers.slice(0, 2).map(function (r) { return r.error; }), ['replaced', 'replaced']);
    assert.equal(answers[2].ok, true);
    assert.equal(answers[2].q, 'harbour sport');
    done();
  };
  iptv.search(xc, 'harbour', '', function (r) { answers.push(r); check(); });
  iptv.search(xc, 'harbour s', '', function (r) { answers.push(r); check(); });
  assert.ok(iptv._state().running.interactive, 'the lane is taken before the memory check answers');
  iptv.search(xc, 'harbour sport', '', function (r) { answers.push(r); check(); });
});

step('a short EPG answered with a refused login stops the playlist, as a refused login does', function (done) {
  mode = 'epg-refused';
  var calls = hits['/player_api.php'];
  iptv.search(xc, 'harbour sport 2', '', function (s) {
    var c = s.channels[0];
    iptv.setSelection({ action: 'add', channels: [{ pl: xc, key: c.key, name: c.name, group: c.group }] }, function () {
      wait(function () { var p = playlistOf(xc); return idle() && p.loginRefused; }, function () {
        var p = playlistOf(xc);
        assert.equal(p.guideError.code, 'login');
        assert.ok(hits['/player_api.php'] - calls <= 2, 'it stopped at the first refusal');
        mode = 'ok';
        iptv.playlistsAction({ action: 'refresh', id: xc }, function () { wait(function () { return idle() && !playlistOf(xc).loginRefused; }, done); });
      });
    });
  });
});

step('the row keeps the order Home arranges, and leaves out what it removes', function (done) {
  iptv.search(xc, 'harbour', '', function (s) {
    var add = s.channels.map(function (c) { return { pl: xc, key: c.key, name: c.name, group: c.group }; });
    iptv.setSelection({ action: 'add', channels: add }, function () {
      var ids = iptv.rowItems().map(function (t) { return t.id; });
      assert.equal(ids.length, 3);
      iptv.setOrder([ids[2], ids[0]]);
      assert.deepEqual(iptv.rowItems().map(function (t) { return t.id; }), [ids[2], ids[0]]);
      done();
    });
  });
});

step('a whole group joins the lineup, numbered after the picks, and the guide comes from the Xtream XMLTV', function (done) {
  var lineup = function () { return iptv.lineup(); };
  iptv.setLineup({ action: 'add-group', pl: xc, group: 'Sport' }, function (r) {
    assert.equal(r.ok, true);
    var sid = r.section;
    wait(function () { return idle() && lineup().sections.some(function (s) { return s.id === sid && s.state === 'ready'; }); }, function () {
      var doc = lineup();
      var sec = doc.sections.filter(function (s) { return s.id === sid; })[0];
      var picks = doc.sections[0];
      assert.equal(picks.kind, 'pick', 'the picks lead');
      // The picks already carry the group's channels: each channel is in the lineup once.
      var ids = doc.channels.map(function (c) { return c.id; });
      assert.equal(ids.length, ids.filter(function (id, i) { return ids.indexOf(id) === i; }).length);
      assert.deepEqual(doc.channels.map(function (c) { return +c.number; }), doc.channels.map(function (c, i) { return i + 1; }));
      assert.ok(sec.start > picks.end || sec.count === 0);
      assert.ok(hits['/xmltv.php'] >= 1, 'the XMLTV guide was read once the lineup went beyond the favourites');
      iptv.groups(xc, function (g) {
        var sport = g.groups.filter(function (x) { return x.name === 'Sport'; })[0];
        assert.equal(sport.section, sid);
        assert.ok(sport.inLineup >= 2);
        done();
      });
    }, 20000);
  });
});

step('sections renumber, a channel taken out of a group stays out, and renames and stars follow the channel', function (done) {
  var doc = iptv.lineup();
  var sec = doc.sections.filter(function (s) { return s.kind === 'group'; })[0];
  var pick = doc.sections.filter(function (s) { return s.kind === 'pick'; })[0];
  iptv.setLineup({ action: 'move-section', section: sec.id, to: 0 }, function () {
    iptv.setLineup({ action: 'section', section: pick.id, from: 401 }, function () {
      var d = iptv.lineup();
      assert.equal(d.sections[0].id, sec.id);
      assert.equal(d.channels[0].number, '1');
      var firstPick = d.channels.filter(function (c) { return c.sid === pick.id; })[0];
      assert.equal(firstPick.number, '401');
      var inGroup = d.channels.filter(function (c) { return c.sid === sec.id; });
      var out = inGroup[0];
      iptv.setLineup({ action: 'remove', ids: [out.id] }, function () {
        var d2 = iptv.lineup();
        assert.ok(!d2.channels.some(function (c) { return c.id === out.id; }), 'taken out');
        assert.equal(d2.sections[0].except, 1);
        var keep = d2.channels[0];
        iptv.setLineup({ action: 'rename', id: keep.id, name: 'Harbour Main' }, function () {
          iptv.setLineup({ action: 'star', id: keep.id }, function (r) {
            assert.equal(r.ok, true);
            var row = iptv.rowItems();
            assert.equal(row[row.length - 1].name, 'Harbour Main');
            assert.equal(row[row.length - 1].number, keep.number);
            // Back in, by adding it again.
            iptv.setLineup({ action: 'add', channels: [{ pl: out.pl, key: out.key, name: out.name, group: out.group }] }, function () {
              assert.equal(iptv.lineup().sections[0].except, 0);
              wait(function () { return idle() && iptv.lineup().channels.some(function (c) { return c.id === out.id && c.sid === sec.id; }); }, done, 15000);
            });
          });
        });
      });
    });
  });
});

step('a hidden group is left out of a search of the whole playlist, not of a search inside it', function (done) {
  iptv.setLineup({ action: 'hide', pl: xc, groups: ['Sport'] }, function () {
    iptv.search(xc, 'harbour', '', function (all) {
      assert.equal(all.total, 0);
      iptv.search(xc, 'harbour', 'Sport', function (inside) {
        assert.ok(inside.total >= 2);
        iptv.groups(xc, function (g) {
          assert.equal(g.groups.filter(function (x) { return x.name === 'Sport'; })[0].hidden, true);
          iptv.setLineup({ action: 'hide', pl: xc, groups: ['Sport'], hidden: false }, function () { done(); });
        });
      });
    });
  });
});

step('Undo takes back the last edits in turn, and a channel taken out comes back where it was', function (done) {
  var d = iptv.lineup();
  var c = d.channels[1];
  var depth = d.undo;
  assert.ok(depth > 0);
  iptv.setLineup({ action: 'remove', ids: [c.id] }, function (r) {
    assert.equal(r.undo, depth + 1);
    assert.ok(!iptv.lineup().channels.some(function (x) { return x.id === c.id; }));
    iptv.setLineup({ action: 'undo' }, function (u) {
      assert.equal(u.ok, true);
      assert.equal(u.undo, depth);
      var back = iptv.lineup().channels.filter(function (x) { return x.id === c.id; })[0];
      assert.ok(back, 'back in the lineup');
      assert.equal(back.number, c.number);
      done();
    });
  });
});

step('channels added just before a restart get their play links at once after it, not after the catch-up', function (done) {
  iptv.search(xc, 'harbour sport 1', '', function (s) {
    var c = s.channels[0];
    iptv.stop();
    // Added while the server is down, as a restart cuts the select job short.
    var sel = JSON.parse(fs.readFileSync(path.join(stateDir, 'iptv', 'selection.json'), 'utf8'));
    var pick = sel.sections.filter(function (x) { return x.kind === 'pick'; })[0];
    pick.channels = pick.channels.filter(function (x) { return x.key !== c.key; }).concat([{ pl: xc, key: c.key, name: c.name, group: c.group }]);
    sel.generation++;
    fs.writeFileSync(path.join(stateDir, 'iptv', 'selection.json'), JSON.stringify(sel));
    iptv.init({ stateDir: stateDir, clients: function () { return [CURL]; }, version: 'test', catchupMs: 600000,
      onChange: function () { changes++; } });
    iptv.start();
    wait(function () { return iptv.streamUrl(xc, c.key); }, function () {
      iptv.stop();
      iptv.init({ stateDir: stateDir, clients: function () { return [CURL]; }, version: 'test', catchupMs: 0, onChange: function () { changes++; } });
      iptv.start();
      wait(idle, done);
    }, 15000);
  });
});

step('removing a playlist takes its channels off the row and its files off the TV at once', function (done) {
  iptv.playlistsAction({ action: 'remove', id: m3u }, function (r) {
    assert.equal(r.ok, true);
    assert.ok(iptv.rowItems().every(function (t) { return t.pl !== m3u; }));
    wait(function () { return !fs.existsSync(path.join(stateDir, 'iptv', m3u)); }, done, 5000);
  });
});

step('a playlist with no reachable server is refused when added, before any download', function (done) {
  iptv.playlistsAction({ action: 'add', kind: 'm3u', url: 'file:///etc/passwd' }, function (r) {
    assert.deepEqual([r.ok, r.error], [false, 'url']);
    iptv.playlistsAction({ action: 'add', kind: 'xtream', server: 'http://x.test', user: '', pass: 'p' }, function (r2) {
      assert.deepEqual([r2.ok, r2.error], [false, 'login']);
      done();
    });
  });
});

provider.listen(0, '127.0.0.1', function () {
  base = 'http://127.0.0.1:' + provider.address().port;
  iptv.init({ stateDir: stateDir, clients: function () { return [CURL]; }, version: 'test', catchupMs: 0,
    onChange: function () { changes++; } });
  iptv.start();
  run(0);
});

setTimeout(function () { console.error('test-iptv.js timed out'); process.exit(1); }, 120000).unref();
