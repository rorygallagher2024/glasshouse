/*
 * A custom launcher (lib/home-launcher) through the real HTTP routes: each
 * kind of upload unpacked and served with the kit added, a web address in
 * its frame, choosing it in Glasshouse Home's place, and what is refused.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var zlib = require('zlib');
var home = require('../server/lib/home');
var launcher = require('../server/lib/home-launcher');
var routes = require('../server/lib/routes');

console.log('Running test-home-launcher.js ...');

function alloc(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}
function buf(s) { return typeof Buffer.from === 'function' ? Buffer.from(s) : new Buffer(s); }

var CRC_TABLE = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  var crc = 0xffffffff;
  for (var i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// node 0.10 has no zlib.gzipSync: there, a gzip of stored deflate blocks.
function gzipSync(data) {
  if (typeof zlib.gzipSync === 'function') return zlib.gzipSync(data);
  var parts = [buf([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])];
  var at = 0;
  do {
    var len = Math.min(65535, data.length - at);
    var head = alloc(5);
    head[0] = at + len >= data.length ? 1 : 0;
    head.writeUInt16LE(len, 1);
    head.writeUInt16LE(0xffff - len, 3);
    parts.push(head, data.slice(at, at + len));
    at += len;
  } while (at < data.length);
  var tail = alloc(8);
  tail.writeUInt32LE(crc32(data), 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  parts.push(tail);
  return Buffer.concat(parts);
}

function padNum(n, width) { var s = n.toString(8); while (s.length < width) s = '0' + s; return s; }
function tarEntry(name, body, type) {
  var data = body === undefined ? alloc(0) : buf(body);
  var h = alloc(512);
  buf(name).copy(h, 0);
  buf('0000644').copy(h, 100);
  buf('0000000').copy(h, 108);
  buf('0000000').copy(h, 116);
  buf(padNum(data.length, 11)).copy(h, 124);
  buf('00000000000').copy(h, 136);
  buf('        ').copy(h, 148);
  buf(type || '0').copy(h, 156);
  buf('ustar').copy(h, 257);
  buf('00').copy(h, 263);
  var sum = 0;
  for (var i = 0; i < 512; i++) sum += h[i];
  buf(padNum(sum, 6)).copy(h, 148);
  h[154] = 0; h[155] = 32;
  return Buffer.concat([h, data, alloc((512 - data.length % 512) % 512)]);
}
function arMember(name, body) {
  var h = buf((name + '                ').slice(0, 16) + '0           0     0     100644  ' +
    (String(body.length) + '          ').slice(0, 10) + '`\n');
  return Buffer.concat(body.length % 2 ? [h, body, buf('\n')] : [h, body]);
}
// files: { 'usr/palm/applications/<id>/index.html': text }
function makeIpk(files) {
  var entries = Object.keys(files).map(function (name) { return tarEntry('./' + name, files[name]); });
  var ctl = gzipSync(Buffer.concat([tarEntry('./control', 'Package: com.example.launcher\nVersion: 1.0.0\n'), alloc(1024)]));
  var dat = gzipSync(Buffer.concat(entries.concat([alloc(1024)])));
  return Buffer.concat([buf('!<arch>\n'), arMember('debian-binary', buf('2.0\n')),
    arMember('control.tar.gz', ctl), arMember('data.tar.gz', dat)]);
}

// entries: [{ name, body, deflate }]; cb(zip). The deflated ones need zlib's async call on node 0.10.
function makeZip(entries, cb) {
  var locals = [], central = [], offset = 0;
  (function next(i) {
    if (i >= entries.length) {
      var cd = Buffer.concat(central);
      var end = alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(cd.length, 12);
      end.writeUInt32LE(offset, 16);
      return cb(Buffer.concat(locals.concat([cd, end])));
    }
    var e = entries[i], data = buf(e.body || '');
    function add(stored) {
      var name = buf(e.name);
      var method = stored === data ? 0 : 8;
      var lh = alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(crc32(data), 14);
      lh.writeUInt32LE(stored.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      var ch = alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(crc32(data), 16);
      ch.writeUInt32LE(stored.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      if (e.mode) ch.writeUInt32LE((e.mode << 16) >>> 0, 38);
      ch.writeUInt32LE(offset, 42);
      locals.push(lh, name, stored);
      central.push(ch, name);
      offset += 30 + name.length + stored.length;
      next(i + 1);
    }
    if (!e.deflate) return add(data);
    zlib.deflateRaw(data, function (err, out) { assert.ifError(err); add(out); });
  })(0);
}

var dir = path.join(os.tmpdir(), 'home-launcher-' + process.pid);
fs.mkdirSync(dir);
var free = 1024 * 1024 * 1024;
home.init({ stateDir: dir, webosVersion: '9.2.2', port: 8080 });
var launcherOpts = { stateDir: dir, version: '1.2.3', df: function (target, cb) { cb(free); } };
launcher.init(launcherOpts);
routes.init({ config: { allowControl: true }, home: home, homeLauncher: launcher,
  assetPath: function (rel) { var f = path.join(__dirname, '..', 'server', 'assets', rel); return fs.existsSync(f) ? f : null; } });
var server = http.createServer(routes.handleRequest), port;

function request(method, url, body, type, cb) {
  var h = { 'Content-Length': body ? body.length : 0 };
  if (type) h['Content-Type'] = type;
  var req = http.request({ hostname: '127.0.0.1', port: port, method: method, path: url, headers: h }, function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () { cb(res.statusCode, Buffer.concat(chunks).toString('utf8'), res.headers); });
  });
  req.on('error', function (e) { throw e; });
  req.end(body || undefined);
}
function upload(name, body, cb) {
  request('POST', '/api/home/launcher/upload?name=' + encodeURIComponent(name), body, 'application/octet-stream', function (code, text) {
    cb(code, JSON.parse(text));
  });
}
function post(body, cb) {
  request('POST', '/api/home/launcher', buf(JSON.stringify(body)), 'application/json', function (code, text) {
    cb(code, JSON.parse(text));
  });
}
function get(url, cb) { request('GET', url, null, null, cb); }

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

function own() { return launcher.status().launchers.filter(function (l) { return l.id === 'own'; })[0]; }

test('a single HTML file is the owner\'s own, served with the kit first in its head once chosen', function (done) {
  upload('My launcher.html', buf('<!doctype html><html><head><title>x</title></head><body>hi</body></html>'), function (code, r) {
    assert.strictEqual(code, 200, JSON.stringify(r));
    var l = r.launchers.launchers.filter(function (x) { return x.id === 'own'; })[0];
    assert.strictEqual(r.launchers.launchers[0].id, 'minimal', 'Glasshouse\'s own first');
    assert.strictEqual(l.kind, 'app');
    assert.strictEqual(l.title, 'x', 'the page\'s own title');
    assert.strictEqual(r.launchers.chosen, null);
    get('/home/launcher/', function (c0) {
      assert.strictEqual(c0, 404, 'nothing served while none is chosen');
      post({ choose: 'own' }, function (c1) {
        assert.strictEqual(c1, 200);
        get('/home/launcher/', function (c2, text, headers) {
          assert.strictEqual(c2, 302);
          assert.strictEqual(headers.location, '/home/launcher/index.html');
          get('/home/launcher/index.html', function (c3, page) {
            assert.strictEqual(c3, 200);
            assert.ok(page.indexOf('<head><script src="/assets/home-kit.js?v=1.2.3"></script><title>') !== -1, page);
            done();
          });
        });
      });
    });
  });
});

test('a zip of a folder is served from inside it, at the start page appinfo.json names', function (done) {
  makeZip([
    { name: 'mine/appinfo.json', body: JSON.stringify({ id: 'com.example.mine', title: 'Mine', main: 'app/start.html', type: 'web' }) },
    { name: 'mine/app/start.html', body: '<html><body>start</body></html>', deflate: true },
    { name: 'mine/app/style.css', body: 'body{color:red}' },
    { name: 'mine/app/link', body: '/etc/passwd', mode: parseInt('120777', 8) },
    { name: '__MACOSX/mine/._start.html', body: 'junk' }
  ], function (zip) {
    var before = launcher.revision();
    upload('mine.zip', zip, function (code, r) {
      assert.strictEqual(code, 200, JSON.stringify(r));
      assert.strictEqual(own().title, 'Mine');
      assert.strictEqual(own().files, 3);
      assert.strictEqual(r.launchers.chosen, 'own', 'still chosen');
      assert.notStrictEqual(launcher.revision(), before, 'a page showing the one replaced reloads');
      assert.ok(!fs.existsSync(path.join(dir, 'home-launcher', 'apps', 'own', 'app', 'link')), 'a link is left out');
      get('/home/launcher/', function (c2, text, headers) {
        assert.strictEqual(headers.location, '/home/launcher/app/start.html');
        get('/home/launcher/app/start.html', function (c3, page) {
          assert.strictEqual(page, '<html><script src="/assets/home-kit.js?v=1.2.3"></script><body>start</body></html>');
          get('/home/launcher/app/style.css', function (c4, css, h4) {
            assert.strictEqual(c4, 200);
            assert.strictEqual(css, 'body{color:red}');
            assert.strictEqual(h4['content-type'], 'text/css; charset=utf-8');
            get('/home/launcher/..%2F..%2Flauncher.json', function (c5) {
              assert.strictEqual(c5, 404);
              done();
            });
          });
        });
      });
    });
  });
});

test('a zip reaching outside its folder is refused, and the launcher before it kept', function (done) {
  makeZip([{ name: 'index.html', body: '<p>x' }, { name: '../evil.html', body: 'x' }], function (zip) {
    upload('evil.zip', zip, function (code, r) {
      assert.strictEqual(code, 400);
      assert.ok(/outside its own folder/.test(r.error), r.error);
      assert.ok(!fs.existsSync(path.join(dir, 'home-launcher', 'evil.html')));
      assert.strictEqual(own().title, 'Mine');
      done();
    });
  });
});

test('an ipk\'s web app is unpacked; a native one is refused', function (done) {
  var id = 'com.example.launcher';
  var base = 'usr/palm/applications/' + id + '/';
  var files = {};
  files[base + 'appinfo.json'] = JSON.stringify({ id: id, title: 'Packaged', main: 'index.html', type: 'web' });
  files[base + 'index.html'] = '<html><head></head><body>ipk</body></html>';
  files[base + 'img/empty.png'] = '';
  files['usr/palm/services/' + id + '.service/run'] = 'binary';
  upload('launcher.ipk', makeIpk(files), function (code, r) {
    assert.strictEqual(code, 200, JSON.stringify(r));
    assert.strictEqual(own().title, 'Packaged');
    assert.ok(fs.existsSync(path.join(dir, 'home-launcher', 'apps', 'own', 'img', 'empty.png')));
    get('/home/launcher/index.html', function (c2, page) {
      assert.ok(page.indexOf('<head><script src="/assets/home-kit.js?v=1.2.3"></script></head>') !== -1, page);
      var native = {};
      native[base + 'appinfo.json'] = JSON.stringify({ id: id, title: 'Native', main: 'bin/launcher', type: 'native' });
      native[base + 'bin/launcher'] = 'elf';
      upload('native.ipk', makeIpk(native), function (c3, r3) {
        assert.strictEqual(c3, 400);
        assert.ok(/native app/.test(r3.error), r3.error);
        assert.strictEqual(own().title, 'Packaged');
        done();
      });
    });
  });
});

test('a file that is none of the three is refused', function (done) {
  upload('photo.jpg', buf([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), function (code, r) {
    assert.strictEqual(code, 400);
    assert.ok(/\.ipk, a \.zip or an \.html/.test(r.error), r.error);
    done();
  });
});

test('an upload with too little free space on the TV is refused before it is saved', function (done) {
  free = 1024;
  upload('x.html', buf('<p>x'), function (code, r) {
    free = 1024 * 1024 * 1024;
    assert.strictEqual(code, 507);
    assert.ok(/free space/.test(r.error));
    assert.strictEqual(own().title, 'Packaged');
    done();
  });
});

test('only a launcher kept can be chosen, and Home\'s page follows the choice', function (done) {
  fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ enabled: true }));
  post({ choose: 'nope' }, function (c0, r0) {
    assert.strictEqual(c0, 400);
    assert.ok(/first/.test(r0.error));
    get('/assets/home.html', function (c1, text, headers) {
      assert.strictEqual(c1, 302);
      assert.strictEqual(headers.location, '/home/launcher/');
      request('POST', '/api/home/beat', buf('{}'), 'application/json', function (c2, beat) {
        assert.strictEqual(JSON.parse(beat).launcher, launcher.revision());
        assert.ok(/^custom-own-\d+$/.test(launcher.revision()));
        post({ choose: false }, function (c3, r3) {
          assert.strictEqual(r3.launchers.chosen, null);
          assert.strictEqual(launcher.revision(), '');
          get('/assets/home.html', function (c4) {
            assert.notStrictEqual(c4, 302, 'Glasshouse Home again');
            post({ choose: 'own' }, function () { done(); });
          });
        });
      });
    });
  });
});

test('a web address replaces the owner\'s own upload, escaped in the frame, and keeps the choice', function (done) {
  post({ address: 'javascript:alert(1)' }, function (c1, r1) {
    assert.strictEqual(c1, 400);
    assert.ok(/http:\/\/ or https:\/\//.test(r1.error));
    post({ address: 'http://ha.local:8123/lovelace/tv?kiosk&x="y"' }, function (code, r) {
      assert.strictEqual(code, 200);
      assert.strictEqual(own().kind, 'web');
      assert.strictEqual(own().title, 'ha.local:8123');
      assert.strictEqual(r.launchers.chosen, 'own');
      assert.ok(!fs.existsSync(path.join(dir, 'home-launcher', 'apps', 'own')), 'the upload before it is removed');
      get('/home/launcher/', function (c2, page) {
        assert.strictEqual(c2, 200);
        assert.ok(page.indexOf('src="http://ha.local:8123/lovelace/tv?kiosk&amp;x=&quot;y&quot;" data-launcher') !== -1, page);
        assert.ok(page.indexOf('/assets/home-kit.js?v=1.2.3') !== -1, 'the kit, at this release\'s address');
        done();
      });
    });
  });
});

test('Minimal comes with Glasshouse: chosen, it is served with the kit, and it cannot be removed', function (done) {
  var mini = launcher.status().launchers[0];
  assert.deepEqual([mini.id, mini.source, mini.title], ['minimal', 'builtin', 'Minimal']);
  var was = launcher.status().chosen;
  post({ choose: 'minimal' }, function (c1, r1) {
    assert.strictEqual(c1, 200);
    assert.strictEqual(r1.launchers.chosen, 'minimal');
    assert.ok(/^custom-minimal-\d+$/.test(launcher.revision()));
    get('/home/launcher/', function (c2, page) {
      assert.strictEqual(c2, 200);
      assert.ok(/<head><script src="\/assets\/home-kit\.js\?v=1\.2\.3"><\/script>/.test(page), 'the kit first');
      assert.ok(page.indexOf('<title>Minimal</title>') !== -1);
      assert.ok(page.indexOf('Glasshouse.onHome(') !== -1);
      get('/home/launcher/other.js', function (c3) {
        assert.strictEqual(c3, 404, 'it has no other files');
        post({ remove: 'minimal' }, function (c4, r4) {
          assert.strictEqual(c4, 200);
          assert.strictEqual(r4.launchers.launchers[0].id, 'minimal', 'still offered');
          post({ choose: was }, function () { done(); });
        });
      });
    });
  });
});

test('removing the chosen one gives Glasshouse Home its place', function (done) {
  post({ remove: 'own' }, function (code, r) {
    assert.strictEqual(code, 200);
    assert.strictEqual(r.launchers.chosen, null);
    assert.deepEqual(r.launchers.launchers.map(function (x) { return x.id; }), ['minimal'], 'Minimal stays');
    assert.ok(!fs.existsSync(path.join(dir, 'home-launcher', 'apps', 'own')));
    get('/home/launcher/', function (c2) {
      assert.strictEqual(c2, 404);
      done();
    });
  });
});

test('the first release\'s single launcher becomes the owner\'s own, still chosen', function (done) {
  var ld = path.join(dir, 'home-launcher');
  fs.mkdirSync(path.join(ld, 'app'));
  fs.writeFileSync(path.join(ld, 'app', 'index.html'), '<p>old');
  fs.writeFileSync(path.join(ld, 'launcher.json'), JSON.stringify({ kind: 'app', title: 'Old', main: 'index.html', files: 1, bytes: 6, chosen: true, rev: 4 }));
  launcher.init(launcherOpts);
  var st = launcher.status();
  assert.strictEqual(st.chosen, 'own');
  assert.strictEqual(st.launchers.filter(function (l) { return l.id === 'own'; })[0].title, 'Old');
  assert.ok(fs.existsSync(path.join(ld, 'apps', 'own', 'index.html')));
  assert.ok(!fs.existsSync(path.join(ld, 'app')));
  get('/home/launcher/index.html', function (code, page) {
    assert.strictEqual(code, 200);
    assert.ok(/<p>old$/.test(page));
    done();
  });
});

function rmTree(d) {
  if (!fs.existsSync(d)) return;
  fs.readdirSync(d).forEach(function (f) {
    var p = path.join(d, f);
    if (fs.lstatSync(p).isDirectory()) rmTree(p); else fs.unlinkSync(p);
  });
  fs.rmdirSync(d);
}

server.listen(0, '127.0.0.1', function () {
  port = server.address().port;
  var i = 0;
  (function next() {
    if (i >= tests.length) {
      server.close();
      home.stop();
      rmTree(dir);
      console.log('test-home-launcher.js: ' + tests.length + ' passed');
      return;
    }
    var t = tests[i++];
    t[1](function () { console.log('  ok - ' + t[0]); next(); });
  })();
});
