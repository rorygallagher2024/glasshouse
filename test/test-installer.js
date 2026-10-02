/**
 * test/test-installer.js - ipk inspection, id rules and the install job.
 *
 * Fixture packages are built here: an ar of three members, tar and gzip made
 * with node's zlib. Installs run against the fake luna-send, scripted per test.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var installer = require('../server/lib/installer');
var apps = require('../server/lib/apps');

console.log('Running test-installer.js ...');

/* ------------------------------------------------------- fixture builders */

function alloc(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}
function buf(s) { return typeof Buffer.from === 'function' ? Buffer.from(s) : new Buffer(s); }
function padNum(n, width) { var s = n.toString(8); while (s.length < width) s = '0' + s; return s; }
function field(h, off, text) { buf(text).copy(h, off); }

function tarEntry(name, body, o) {
  o = o || {};
  var data = body === undefined ? alloc(0) : (typeof body === 'string' ? buf(body) : body);
  var h = alloc(512);
  field(h, 0, name);
  field(h, 100, '0000644');
  field(h, 108, '0000000');
  field(h, 116, '0000000');
  field(h, 124, padNum(data.length, 11));
  field(h, 136, '00000000000');
  field(h, 148, '        ');
  field(h, 156, o.type || '0');
  if (o.link) field(h, 157, o.link);
  field(h, 257, 'ustar');
  field(h, 263, '00');
  var sum = 0;
  for (var i = 0; i < 512; i++) sum += h[i];
  field(h, 148, padNum(sum, 6));
  h[154] = 0; h[155] = 32;
  var pad = alloc((512 - data.length % 512) % 512);
  return Buffer.concat([h, data, pad]);
}

function tar(entries) {
  return Buffer.concat(entries.concat([alloc(1024)]));
}

function arMember(name, body, noPad) {
  var h = buf(
    (name + '                ').slice(0, 16) + '0           0     0     100644  ' +
    (String(body.length) + '          ').slice(0, 10) + '`\n');
  var parts = [h, body];
  if (body.length % 2 && !noPad) parts.push(buf('\n'));
  return Buffer.concat(parts);
}

function elf(machine) {
  var b = alloc(64);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; b[4] = 1; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(machine, 18);
  return b;
}

/*
 * o.pkg, o.version, o.apps (ids), o.services (names), o.machine, o.extra
 * (more data.tar entries), o.control (replaces the control file), o.members
 * (extra ar members), o.oddControl (pick a control text whose gzip is odd),
 * o.appVersion (the version in appinfo.json), o.tail (bytes after the data
 * tar's end blocks), o.emptyMember (an ar member with no body).
 */
function makeIpk(o) {
  o = o || {};
  var pkg = o.pkg || 'com.example.app';
  var version = o.version || '1.0.0';
  var appIds = o.apps || [pkg];
  var services = o.services || [pkg + '.service'];
  var entries = [tarEntry('./usr/', undefined, { type: '5' })];
  appIds.forEach(function (id) {
    entries.push(tarEntry('./usr/palm/applications/' + id + '/', undefined, { type: '5' }));
    entries.push(tarEntry('./usr/palm/applications/' + id + '/appinfo.json',
      JSON.stringify({ id: id, title: 'Title of ' + id, version: o.appVersion || version, icon: 'icon.png' })));
  });
  services.forEach(function (s) {
    entries.push(tarEntry('./usr/palm/services/' + s + '/', undefined, { type: '5' }));
    entries.push(tarEntry('./usr/palm/services/' + s + '/run', elf(o.machine || 40)));
  });
  (o.extra || []).forEach(function (e) { entries.push(e); });

  var control = o.control;
  var ctl;
  for (var pad = 0; pad < 40; pad++) {
    var text = control || ('Package: ' + pkg + '\nVersion: ' + version + '\nArchitecture: all\nDescription: ' +
                           new Array(pad + 2).join('x') + '\n');
    ctl = zlib.gzipSync(tar([tarEntry('./control', text)]));
    if (!o.oddControl || ctl.length % 2 === 1) break;
  }
  var dat = zlib.gzipSync(Buffer.concat([tar(entries), o.tail || alloc(0)]));
  if (o.emptyMember === 'control.tar.gz') ctl = alloc(0);
  if (o.emptyMember === 'data.tar.gz') dat = alloc(0);
  var parts = [buf('!<arch>\n'), arMember('debian-binary', buf('2.0\n')), arMember('control.tar.gz', ctl),
               arMember('data.tar.gz', dat)];
  (o.members || []).forEach(function (m) { parts.push(arMember(m, buf('x'))); });
  return Buffer.concat(parts);
}

/* ----------------------------------------------------------------- setup */

var root = path.join(os.tmpdir(), 'test-installer-' + process.pid + '-' + Date.now());
var seq = 0;
fs.mkdirSync(root);

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

function shell(file, body) {
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n');
  fs.chmodSync(file, parseInt('755', 8));
}

/*
 * A fresh directory tree and an initialised installer. ctx.files maps a URL to
 * the package it serves; ctx.installed is what listApps reports.
 */
function setup(over) {
  over = over || {};
  var dir = path.join(root, String(++seq));
  fs.mkdirSync(dir);
  ['state', 'staging', 'store', 'system'].forEach(function (d) { fs.mkdirSync(path.join(dir, d)); });
  var ctx = {
    dir: dir, files: {}, installed: [], downloads: 0, cancelled: 0, hang: false,
    staging: path.join(dir, 'staging'), state: path.join(dir, 'state'),
    lunaLog: path.join(dir, 'luna.log'), elevLog: path.join(dir, 'elevate.log'),
    elevate: path.join(dir, 'elevate-service')
  };
  shell(path.join(dir, 'luna-send'), 'exec "' + process.execPath + '" "' + path.join(__dirname, 'mocks', 'fake-luna-send.js') + '" "$@"');
  shell(ctx.elevate, 'echo "$@" >> "' + ctx.elevLog + '"' + (over.elevateFails ? '; echo denied >&2; exit 3' : ''));
  var fetch = {
    validateUrl: function (u) { return /^https?:\/\/[^\s]+$/.test(u) ? null : 'bad url'; },
    download: function (url, out, opts, cb) {
      ctx.downloads++;
      var timer = null;
      if (ctx.hang) {
        return { cancel: function () { ctx.cancelled++; } };
      }
      timer = setTimeout(function () {
        var data = ctx.files[url];
        if (!data) return cb(new Error('404'));
        fs.writeFileSync(out, data);
        if (opts.onProgress) opts.onProgress(data.length);
        cb(null);
      }, 5);
      return { cancel: function () { ctx.cancelled++; clearTimeout(timer); } };
    }
  };
  var sysApps = { isProtected: apps.isProtected, APP_BASES: [path.join(dir, 'system')], PROTECTED_APP_IDS: apps.PROTECTED_APP_IDS };
  ctx.init = function (extra) {
    var o = {
      luna: function (uri, payload, cb) {
        process.nextTick(function () {
          cb(uri === 'com.webos.applicationManager/listApps' ? { returnValue: true, apps: ctx.installed } : { returnValue: false });
        });
      },
      apps: sysApps, fetch: fetch, stateDir: ctx.state, stagingDir: ctx.staging,
      lunaSendPath: path.join(dir, 'luna-send'), elevatePath: ctx.elevate,
      storeAppsDir: path.join(dir, 'store'), tvMachine: 'arm',
      installTimeoutMs: over.installTimeoutMs || 5000
    };
    for (var k in extra || {}) o[k] = extra[k];
    installer.init(o);
  };
  ctx.init(over.init);
  ctx.script = function (steps, end) {
    var file = path.join(dir, 'script.json');
    var s = {};
    s['com.webos.appInstallService/dev/install'] = { steps: steps, end: end || 'hold' };
    fs.writeFileSync(file, JSON.stringify(s));
    process.env.FAKE_LUNA_SCRIPT = file;
    process.env.FAKE_LUNA_LOG = ctx.lunaLog;
  };
  ctx.pkg = function (ipk, id, version, extra) {
    var url = 'https://repo.example/' + (++seq) + '.ipk';
    ctx.files[url] = ipk;
    var p = { id: id || 'com.example.app', version: version || '1.0.0', ipkUrl: url, sha256: sha(ipk), size: ipk.length };
    for (var k in extra || {}) p[k] = extra[k];
    return { source: 'catalog', pkg: p };
  };
  ctx.ipkFile = function (ipk, name) {
    var f = path.join(ctx.staging, name || 'upload.ipk');
    fs.writeFileSync(f, ipk);
    return f;
  };
  return ctx;
}

function inspect(ipk, cb, init) {
  var ctx = setup({ init: init });
  installer.inspectIpk(ctx.ipkFile(ipk), cb);
}

function waitFor(states, ms, cb) {
  var list = typeof states === 'string' ? [states] : states;
  var until = Date.now() + ms;
  (function poll() {
    var s = installer.status();
    if (list.indexOf(s.state) >= 0) return cb(s);
    if (Date.now() > until) return cb(null, s);
    setTimeout(poll, 10);
  })();
}

function expectState(states, cb, ms) {
  waitFor(states, ms || 5000, function (s, last) {
    assert.ok(s, 'wanted ' + states + ', stuck in ' + JSON.stringify(last));
    cb(s);
  });
}

function startOk(req, cb) {
  installer.start(req, function (err) {
    assert.ok(!err, 'start refused: ' + err);
    cb();
  });
}

function logLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(function (l) { return l; }); } catch (e) { return []; }
}

var DONE = { statusValue: 30, details: { packageId: 'com.example.app' } };
var PROGRESS = { returnValue: true, statusValue: 5, details: { progress: 40 } };

/* ----------------------------------------------------------------- tests */

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('start refuses while the updater is busy', function (done) {
  var updating = true;
  var ctx = setup({ init: { updaterBusy: function () { return updating; } } });
  installer.start({ source: 'catalog', pkg: { id: 'org.example.a', version: '1.0.0', ipkUrl: 'https://example.org/a.ipk', sha256: new Array(65).join('a') } }, function (err) {
    assert.ok(/update is running/.test(err), err);
    assert.strictEqual(installer.isBusy(), false);
    updating = false;
    done();
  });
});

test('parseDf reads BusyBox and wrapped coreutils output', function (done) {
  var busybox = 'Filesystem           1K-blocks      Used Available Use% Mounted on\n' +
                '/dev/mmcblk0p9         1000000    400000    600000  40% /media/developer\n';
  var gnu = 'Filesystem                         1K-blocks    Used Available Use% Mounted on\n' +
            '/dev/mapper/a-very-long-volume-name\n                           2000000  500000   1500000  25% /media\n';
  assert.strictEqual(installer.parseDf(busybox), 600000 * 1024);
  assert.strictEqual(installer.parseDf(gnu), 1500000 * 1024);
  assert.strictEqual(installer.parseDf('nothing'), null);
  done();
});

test('inspectIpk reads package, apps, services and CPU', function (done) {
  inspect(makeIpk({ services: ['com.example.app.service', 'com.example.app.other'] }), function (err, info) {
    assert.ifError(err);
    assert.strictEqual(info.package, 'com.example.app');
    assert.strictEqual(info.version, '1.0.0');
    assert.deepEqual(info.apps, [{ id: 'com.example.app', title: 'Title of com.example.app', version: '1.0.0', icon: 'icon.png' }]);
    assert.deepEqual(info.services, ['com.example.app.service', 'com.example.app.other']);
    assert.deepEqual(info.machines, ['arm']);
    assert.strictEqual(info.cpuMismatch, false);
    done();
  });
});

test('inspectIpk flags a CPU other than the TV\'s', function (done) {
  inspect(makeIpk({ machine: 183 }), function (err, info) {
    assert.ifError(err);
    assert.deepEqual(info.machines, ['aarch64']);
    assert.strictEqual(info.cpuMismatch, true);
    done();
  });
});

test('inspectIpk rejects a truncated file at any cut', function (done) {
  var ipk = makeIpk();
  var cuts = [4, 20, 70, 100, ipk.length - 30, ipk.length - 3];
  (function next() {
    if (!cuts.length) return done();
    var n = cuts.shift();
    inspect(ipk.slice(0, n), function (err) {
      assert.ok(err, 'cut at ' + n + ' accepted');
      assert.ok(/truncated|not an ipk/.test(err), err);
      next();
    });
  })();
});

test('inspectIpk handles odd ar member sizes with padding', function (done) {
  var odd = makeIpk({ oddControl: true });
  inspect(odd, function (err, info) {
    assert.ifError(err);
    assert.strictEqual(info.package, 'com.example.app');
    done();
  });
});

test('inspectIpk rejects an extra ar member', function (done) {
  inspect(makeIpk({ members: ['evil.tar.gz'] }), function (err) {
    assert.ok(/unexpected part: evil/.test(err), err);
    done();
  });
});

test('inspectIpk stops a gzip bomb at the cap', function (done) {
  var big = tarEntry('./usr/palm/applications/com.example.app/blob', alloc(3 * 1024 * 1024));
  inspect(makeIpk({ extra: [big] }), function (err) {
    assert.ok(/unpacks to more/.test(err), err);
    done();
  }, { caps: { dataBytes: 1024 * 1024 } });
});

test('inspectIpk stops an oversize control archive', function (done) {
  inspect(makeIpk({ control: 'Package: com.example.app\nVersion: 1\nX: ' + new Array(5000).join('y') + '\n' }), function (err) {
    assert.ok(/unpacks to more/.test(err), err);
    done();
  }, { caps: { controlBytes: 2048 } });
});

test('inspectIpk stops at the entry cap', function (done) {
  var extra = [];
  for (var i = 0; i < 30; i++) extra.push(tarEntry('./usr/share/f' + i, 'x'));
  inspect(makeIpk({ extra: extra }), function (err) {
    assert.ok(/too many files/.test(err), err);
    done();
  }, { caps: { entries: 10 } });
});

test('inspectIpk rejects an oversize appinfo.json', function (done) {
  var ipk = makeIpk({ extra: [tarEntry('./usr/palm/applications/com.example.app/appinfo.json', new Array(300).join('a'))] });
  inspect(ipk, function (err) {
    assert.ok(/appinfo/.test(err), err);
    done();
  }, { caps: { appinfoBytes: 200 } });
});

test('inspectIpk rejects GNU LongLink and pax headers', function (done) {
  var kinds = ['L', 'K', 'x', 'g'];
  (function next() {
    if (!kinds.length) return done();
    var k = kinds.shift();
    inspect(makeIpk({ extra: [tarEntry('././@LongLink', 'usr/palm/applications/com.webos.app.home\0', { type: k })] }), function (err) {
      assert.ok(/does not read/.test(err), k + ': ' + err);
      next();
    });
  })();
});

test('inspectIpk rejects paths that leave the package and absolute links', function (done) {
  inspect(makeIpk({ extra: [tarEntry('./usr/palm/../../etc/passwd', 'x')] }), function (err) {
    assert.ok(/unsafe path/.test(err), err);
    inspect(makeIpk({ extra: [tarEntry('./usr/palm/applications/com.example.app/ln', undefined, { type: '2', link: '/etc' })] }), function (err2) {
      assert.ok(/unsafe path/.test(err2), err2);
      done();
    });
  });
});

test('inspectIpk refuses a link that leads out of its package directory', function (done) {
  var base = './usr/palm/applications/com.example.app/';
  var bad = [
    // A link at the top, then a file written through it.
    [tarEntry('./x', undefined, { type: '2', link: 'usr/palm/services' }),
     tarEntry('./x/org.webosbrew.hbchannel.service/elevate-service', 'x')],
    [tarEntry('./usr/palm/x', undefined, { type: '2', link: 'services' })],
    [tarEntry(base + 'ln', undefined, { type: '2', link: '../../../services/com.example.app.service' })],
    [tarEntry(base + 'ln', undefined, { type: '1', link: 'usr/palm/services/org.webosbrew.hbchannel.service/run' })],
    [tarEntry(base + 'ln', undefined, { type: '2', link: '/usr/palm/services' })],
    // A file through an earlier link, the link inside its own directory.
    [tarEntry(base + 'ln', undefined, { type: '2', link: 'sub' }), tarEntry(base + 'ln/file', 'x')],
    [tarEntry(base + 'ln', undefined, { type: '2', link: 'sub' }), tarEntry(base + 'ln', 'x')]
  ];
  (function next() {
    if (!bad.length) return done();
    var extra = bad.shift();
    inspect(makeIpk({ extra: extra }), function (err) {
      assert.ok(/unsafe path/.test(err), JSON.stringify(err));
      next();
    });
  })();
});

test('inspectIpk accepts links that stay inside their own id directory', function (done) {
  var base = './usr/palm/applications/com.example.app/';
  inspect(makeIpk({ extra: [
    tarEntry(base + 'lib/', undefined, { type: '5' }),
    tarEntry(base + 'lib/a.so.1', 'x'),
    tarEntry(base + 'lib/a.so', undefined, { type: '2', link: 'a.so.1' }),
    tarEntry(base + 'bin', undefined, { type: '2', link: 'lib/../lib' }),
    tarEntry(base + 'copy', undefined, { type: '1', link: 'usr/palm/applications/com.example.app/lib/a.so.1' })
  ] }), function (err, info) {
    assert.ifError(err);
    assert.strictEqual(info.package, 'com.example.app');
    done();
  });
});

test('inspectIpk refuses an ar member too short to hold gzip', function (done) {
  var kinds = ['control.tar.gz', 'data.tar.gz'];
  (function next() {
    if (!kinds.length) return done();
    var k = kinds.shift();
    inspect(makeIpk({ emptyMember: k }), function (err) {
      assert.ok(/damaged/.test(err), k + ': ' + err);
      next();
    });
  })();
});

test('inspectIpk refuses data after the end of the tar and accepts zero padding', function (done) {
  inspect(makeIpk({ tail: tarEntry('./usr/palm/applications/com.example.app/late', 'x') }), function (err) {
    assert.ok(/damaged/.test(err), err);
    inspect(makeIpk({ tail: alloc(9000) }), function (err2, info) {
      assert.ifError(err2);
      assert.strictEqual(info.package, 'com.example.app');
      done();
    });
  });
});

test('inspectIpk rejects a bad control file and a package with nothing in it', function (done) {
  inspect(makeIpk({ control: 'Package: ../evil\nVersion: 1\n' }), function (err) {
    assert.ok(/control/.test(err), err);
    inspect(makeIpk({ apps: [], services: [] }), function (err2) {
      assert.ok(/no app or service/.test(err2), err2);
      done();
    });
  });
});

test('checkIds accepts a package whose ids sit under its name', function (done) {
  setup();
  assert.strictEqual(installer.checkIds({
    package: 'com.example.app', apps: [{ id: 'com.example.app' }, { id: 'com.example.app.extra' }],
    services: ['com.example.app.service']
  }), null);
  done();
});

test('checkIds refuses a protected id inside the package', function (done) {
  setup();
  var err = installer.checkIds({ package: 'com.tvweb.dashboard', apps: [{ id: 'com.tvweb.dashboard' }], services: [] });
  assert.ok(/TV system/.test(err), err);
  err = installer.checkIds({ package: 'com.example.app', apps: [{ id: 'com.webos.app.home' }], services: [] });
  assert.ok(/does not begin/.test(err), err);
  done();
});

test('checkIds refuses a service with a foreign prefix', function (done) {
  setup();
  var err = installer.checkIds({ package: 'com.example.app', apps: [{ id: 'com.example.app' }], services: ['org.other.svc'] });
  assert.ok(/org.other.svc does not begin with the package name com.example.app/.test(err), err);
  done();
});

test('checkIds refuses com.webos, com.palm and com.lge names', function (done) {
  setup();
  ['com.webos.foo', 'com.palm.foo', 'com.lge.foo'].forEach(function (p) {
    var err = installer.checkIds({ package: p, apps: [], services: [p + '.service'] });
    assert.ok(/TV system/.test(err), p + ': ' + err);
  });
  done();
});

test('checkIds refuses an id already present in the system apps', function (done) {
  var ctx = setup();
  fs.mkdirSync(path.join(ctx.dir, 'system', 'com.example.app'));
  var err = installer.checkIds({ package: 'com.example.app', apps: [{ id: 'com.example.app' }], services: [] });
  assert.ok(/already part of the TV system/.test(err), err);
  done();
});

test('checkIds refuses the Homebrew Channel and the dashboard\'s HBC package', function (done) {
  setup();
  ['org.webosbrew.hbchannel', 'io.github.rorygallagher2024.lg-webos-dashboard'].forEach(function (p) {
    var err = installer.checkIds({ package: p, apps: [{ id: p }], services: [p + '.service'] });
    assert.ok(/Homebrew Channel/.test(err), p + ': ' + err);
  });
  done();
});

test('a protected package is stopped before the preview', function (done) {
  var ctx = setup();
  startOk(ctx.pkg(makeIpk({ pkg: 'com.webos.evil' }), 'com.webos.evil'), function () {
    expectState('error', function (s) {
      assert.ok(/TV system/.test(s.error), s.error);
      assert.deepEqual(fs.readdirSync(ctx.staging), []);
      done();
    });
  });
});

test('a catalog download with the wrong sha256 is refused', function (done) {
  var ctx = setup();
  var req = ctx.pkg(makeIpk());
  req.pkg.sha256 = new Array(65).join('a');
  startOk(req, function () {
    expectState('error', function (s) {
      assert.ok(/sha256/.test(s.error), s.error);
      assert.strictEqual(installer.isBusy(), false);
      assert.deepEqual(fs.readdirSync(ctx.staging), []);
      done();
    });
  });
});

test('a catalog entry for another package id is refused', function (done) {
  var ctx = setup();
  startOk(ctx.pkg(makeIpk(), 'com.example.other'), function () {
    expectState('error', function (s) {
      assert.ok(/not com.example.other/.test(s.error), s.error);
      done();
    });
  });
});

test('start refuses a malformed catalog entry, a bad url and an outside file', function (done) {
  var ctx = setup();
  installer.start({ source: 'catalog', pkg: { id: 'a' } }, function (e1) {
    assert.ok(e1);
    var req = ctx.pkg(makeIpk());
    req.pkg.ipkUrl = req.pkg.ipkUrl.replace('https', 'http');
    installer.start(req, function (e2) {
      assert.ok(/https/.test(e2), e2);
      installer.start({ source: 'url', url: 'file:///etc/passwd' }, function (e3) {
        assert.ok(e3);
        installer.start({ source: 'file', path: '/etc/passwd' }, function (e4) {
          assert.ok(/staging/.test(e4), e4);
          assert.strictEqual(installer.isBusy(), false);
          done();
        });
      });
    });
  });
});

test('install completes on statusValue 30 and clears the staging directory', function (done) {
  var ctx = setup();
  ctx.script([{ out: { returnValue: true, subscribed: true } }, { out: PROGRESS, delay: 20 }, { out: DONE, delay: 20 }]);
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(installer.isBusy(), true);
      var p = s.preview;
      assert.strictEqual(p.package, 'com.example.app');
      assert.strictEqual(p.direction, 'new');
      assert.strictEqual(p.installedVersion, null);
      assert.strictEqual(p.storeInstalled, false);
      assert.strictEqual(p.cpuMismatch, false);
      assert.ok(p.needBytes > 0 && p.freeBytes > 0);
      assert.deepEqual(p.services, ['com.example.app.service']);
      var staged = fs.readdirSync(ctx.staging);
      assert.strictEqual(staged.length, 1);
      installer.confirm({ jobId: s.jobId }, function (err) {
        assert.ifError(err);
        expectState('installed', function (done2) {
          assert.strictEqual(done2.result.version, '1.0.0');
          assert.strictEqual(installer.isBusy(), false);
          assert.deepEqual(fs.readdirSync(ctx.staging), []);
          var call = JSON.parse(logLines(ctx.lunaLog)[0]);
          assert.strictEqual(call[0], '-i');
          assert.strictEqual(call[1], 'luna://com.webos.appInstallService/dev/install');
          var payload = JSON.parse(call[2]);
          assert.strictEqual(payload.id, 'com.example.app');
          assert.strictEqual(payload.subscribe, true);
          assert.strictEqual(path.dirname(payload.ipkUrl), ctx.staging);
          done();
        });
      });
    });
  });
});

test('the preview shows upgrade, downgrade and reinstall', function (done) {
  var cases = [['0.9.0', 'up'], ['2.0.0', 'down'], ['1.0.0', 'same']];
  (function next() {
    if (!cases.length) return done();
    var c = cases.shift();
    var ctx = setup();
    ctx.installed = [{ id: 'com.example.app', version: c[0] }];
    startOk(ctx.pkg(makeIpk()), function () {
      expectState('awaiting-confirm', function (s) {
        assert.strictEqual(s.preview.direction, c[1]);
        assert.strictEqual(s.preview.installedVersion, c[0]);
        installer.cancel(s.jobId, function () { next(); });
      });
    });
  })();
});

test('a service error code fails the install with its reason', function (done) {
  var ctx = setup();
  ctx.script([{ out: { returnValue: true, subscribed: true } },
              { out: { returnValue: true, statusValue: 99, details: { errorCode: -5, reason: 'package is corrupt' } }, delay: 20 }]);
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('error', function (e) {
          assert.ok(/package is corrupt/.test(e.error), e.error);
          assert.deepEqual(fs.readdirSync(ctx.staging), []);
          done();
        });
      });
    });
  });
});

test('returnValue false fails the install', function (done) {
  var ctx = setup();
  ctx.script([{ out: { returnValue: false, errorText: 'Unknown method' } }]);
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('error', function (e) {
          assert.ok(/Unknown method/.test(e.error), e.error);
          done();
        });
      });
    });
  });
});

test('a stalled install is accepted when the app list shows the new version', function (done) {
  var ctx = setup({ installTimeoutMs: 400 });
  ctx.script([{ out: { returnValue: true, subscribed: true } }, { out: PROGRESS }], 'hold');
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      ctx.installed = [{ id: 'com.example.app', version: '1.0.0' }];
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('installed', function () { done(); });
      });
    });
  });
});

test('a stalled install fails when the app is not there at the new version', function (done) {
  var ctx = setup({ installTimeoutMs: 300 });
  ctx.script([{ out: PROGRESS }], 'hold');
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      ctx.installed = [{ id: 'com.example.app', version: '0.5.0' }];
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('error', function (e) {
          assert.ok(/did not finish/.test(e.error), e.error);
          done();
        });
      });
    });
  });
});

test('a dropped stream fails the install', function (done) {
  var ctx = setup();
  ctx.script([{ out: PROGRESS }], 'exit');
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('error', function (e) {
          assert.ok(/stopped answering/.test(e.error), e.error);
          done();
        });
      });
    });
  });
});

test('cancel before confirm drops the job and the staged file', function (done) {
  var ctx = setup();
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.cancel(s.jobId, function (err) {
        assert.ifError(err);
        assert.strictEqual(installer.status().state, 'idle');
        assert.strictEqual(installer.isBusy(), false);
        assert.deepEqual(fs.readdirSync(ctx.staging), []);
        installer.confirm({ jobId: s.jobId }, function (err2) {
          assert.ok(err2);
          done();
        });
      });
    });
  });
});

test('cancel during the download stops the downloader', function (done) {
  var ctx = setup();
  ctx.hang = true;
  startOk(ctx.pkg(makeIpk()), function () {
    (function wait() {
      if (!ctx.downloads) return setTimeout(wait, 10);
      installer.cancel(installer.status().jobId, function (err) {
        assert.ifError(err);
        assert.strictEqual(ctx.cancelled, 1);
        assert.strictEqual(installer.isBusy(), false);
        done();
      });
    })();
  });
});

test('cancel after the install began is refused', function (done) {
  var ctx = setup();
  ctx.script([{ out: PROGRESS }], 'hold');
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId }, function () {
        assert.strictEqual(installer.status().state, 'installing');
        installer.cancel(s.jobId, function (err) {
          assert.ok(/cannot be cancelled/.test(err), err);
          assert.strictEqual(installer.isBusy(), true);
          done();
        });
      });
    });
  });
});

test('a second start is refused while a job is waiting', function (done) {
  var ctx = setup();
  var req = ctx.pkg(makeIpk());
  startOk(req, function () {
    expectState('awaiting-confirm', function () {
      installer.start(req, function (err) {
        assert.ok(/already in progress/.test(err), err);
        done();
      });
    });
  });
});

test('an unconfirmed preview expires and its file is deleted', function (done) {
  var ctx = setup({ init: { previewMs: 150 } });
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function () {
      expectState('error', function (e) {
        assert.ok(/expired/.test(e.error), e.error);
        assert.deepEqual(fs.readdirSync(ctx.staging), []);
        assert.strictEqual(installer.isBusy(), false);
        done();
      });
    });
  });
});

test('too little free space stops the install before the download', function (done) {
  var ctx = setup();
  var df = path.join(ctx.dir, 'df');
  shell(df, "printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/x 100 99 1 99%% /\\n'");
  ctx.init({ dfPath: df });
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('error', function (e) {
      assert.ok(/not enough free space/.test(e.error), e.error);
      assert.strictEqual(ctx.downloads, 0);
      done();
    });
  });
});

function growingFetch(ctx, total, extra) {
  extra = extra || {};
  extra.fetch = {
    validateUrl: function () { return null; },
    download: function (url, out, opts, cb) {
      var sent = 0, stopped = false, timer;
      ctx.downloads++;
      fs.writeFileSync(out, '');
      timer = setInterval(function () {
        if (stopped) return;
        sent += 1024 * 1024;
        fs.appendFileSync(out, Buffer.alloc ? Buffer.alloc(1024 * 1024) : new Buffer(1024 * 1024));
        opts.onProgress(sent, null);
        if (!stopped && sent >= total) { clearInterval(timer); cb(null); }
      }, 2);
      return { cancel: function () { stopped = true; ctx.cancelled++; clearInterval(timer); } };
    }
  };
  ctx.init(extra);
}

test('a download that outgrows a third of the free space is cancelled', function (done) {
  var ctx = setup();
  var df = path.join(ctx.dir, 'df');
  // 30 MB free: the limit is 10 MB.
  shell(df, "printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/x 99999 69279 30720 69%% /\\n'");
  growingFetch(ctx, 50 * 1024 * 1024, { dfPath: df });
  var req = ctx.pkg(makeIpk(), null, null, { size: 0 });
  startOk(req, function () {
    expectState('error', function (e) {
      assert.ok(/not enough free space/.test(e.error), e.error);
      assert.strictEqual(ctx.cancelled, 1);
      assert.deepEqual(fs.readdirSync(ctx.staging), []);
      assert.strictEqual(installer.isBusy(), false);
      done();
    });
  });
});

test('a download past the upload cap is cancelled', function (done) {
  var ctx = setup();
  growingFetch(ctx, 50 * 1024 * 1024, { caps: { uploadBytes: 4 * 1024 * 1024 } });
  startOk(ctx.pkg(makeIpk(), null, null, { size: 0 }), function () {
    expectState('error', function (e) {
      assert.ok(/larger than/.test(e.error), e.error);
      assert.strictEqual(ctx.cancelled, 1);
      assert.deepEqual(fs.readdirSync(ctx.staging), []);
      done();
    });
  });
});

test('replacing a store app needs its own confirmation', function (done) {
  var ctx = setup();
  var appDir = path.join(ctx.dir, 'store', 'com.example.app');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'appinfo.json'), '{}');
  ctx.script([{ out: DONE }]);
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(s.preview.storeInstalled, true);
      installer.confirm({ jobId: s.jobId }, function (err) {
        assert.ok(/LG store/.test(err), err);
        assert.strictEqual(installer.status().state, 'awaiting-confirm');
        installer.confirm({ jobId: s.jobId, replaceStore: true }, function (err2) {
          assert.ifError(err2);
          expectState('installed', function () { done(); });
        });
      });
    });
  });
});

test('a file source inside the staging directory is verified and previewed', function (done) {
  var ctx = setup();
  var file = ctx.ipkFile(makeIpk());
  startOk({ source: 'file', path: file }, function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(s.preview.package, 'com.example.app');
      assert.strictEqual(ctx.downloads, 0);
      done();
    });
  });
});

test('a url source checks an optional sha256', function (done) {
  var ctx = setup();
  var ipk = makeIpk();
  var req = ctx.pkg(ipk);
  startOk({ source: 'url', url: req.pkg.ipkUrl, sha256: new Array(65).join('0') }, function () {
    expectState('error', function (e) {
      assert.ok(/sha256/.test(e.error), e.error);
      startOk({ source: 'url', url: req.pkg.ipkUrl }, function () {
        expectState('awaiting-confirm', function () { done(); });
      });
    });
  });
});

test('elevation runs once per service with its name and is recorded', function (done) {
  var ctx = setup();
  ctx.script([{ out: DONE }]);
  var ipk = makeIpk({ services: ['com.example.app.one', 'com.example.app.two'] });
  startOk(ctx.pkg(ipk), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId, elevate: true }, function (err) {
        assert.ifError(err);
        expectState('installed', function (r) {
          assert.deepEqual(logLines(ctx.elevLog), ['com.example.app.one', 'com.example.app.two']);
          assert.deepEqual(r.result.elevation.done, ['com.example.app.one', 'com.example.app.two']);
          var rec = JSON.parse(fs.readFileSync(path.join(ctx.state, 'elevated.json'), 'utf8'));
          assert.deepEqual(rec['com.example.app'], ['com.example.app.one', 'com.example.app.two']);
          done();
        });
      });
    });
  });
});

test('an update of an elevated package elevates again without being asked', function (done) {
  var ctx = setup();
  ctx.script([{ out: DONE }]);
  fs.writeFileSync(path.join(ctx.state, 'elevated.json'), JSON.stringify({ 'com.example.app': ['com.example.app.service'] }));
  startOk(ctx.pkg(makeIpk({ version: '1.1.0' }), 'com.example.app', '1.1.0'), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId, elevate: false }, function () {
        expectState('installed', function () {
          assert.deepEqual(logLines(ctx.elevLog), ['com.example.app.service']);
          done();
        });
      });
    });
  });
});

test('no elevation without the request, and none for a package never elevated', function (done) {
  var ctx = setup();
  ctx.script([{ out: DONE }]);
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('installed', function (r) {
          assert.deepEqual(logLines(ctx.elevLog), []);
          assert.strictEqual(r.result.elevation, null);
          done();
        });
      });
    });
  });
});

test('asking for elevation without the Homebrew Channel is refused', function (done) {
  var ctx = setup();
  ctx.init({ elevatePath: path.join(ctx.dir, 'absent') });
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId, elevate: true }, function (err) {
        assert.ok(/Homebrew Channel/.test(err), err);
        assert.strictEqual(installer.status().state, 'awaiting-confirm');
        done();
      });
    });
  });
});

test('a failed elevation is reported but the install stands', function (done) {
  var ctx = setup({ elevateFails: true });
  ctx.script([{ out: DONE }]);
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      installer.confirm({ jobId: s.jobId, elevate: true }, function () {
        expectState('installed', function (r) {
          assert.strictEqual(r.result.elevation.done.length, 0);
          assert.ok(/denied/.test(r.result.elevation.failed[0].error), r.result.elevation.failed[0].error);
          assert.ok(!fs.existsSync(path.join(ctx.state, 'elevated.json')));
          done();
        });
      });
    });
  });
});

test('recover reports an unfinished job and clears the staging directory', function (done) {
  var ctx = setup();
  fs.writeFileSync(path.join(ctx.staging, 'abc.ipk'), 'partial');
  fs.writeFileSync(path.join(ctx.state, 'install-job.json'), JSON.stringify({ jobId: 'abc', state: 'installing', package: 'com.example.app' }));
  ctx.init();
  installer.recover();
  var s = installer.status();
  assert.strictEqual(s.state, 'interrupted');
  assert.ok(/check the app list/.test(s.error), s.error);
  assert.strictEqual(installer.isBusy(), false);
  assert.deepEqual(fs.readdirSync(ctx.staging), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ctx.state, 'install-job.json'), 'utf8')).state, 'interrupted');
  ctx.init();
  installer.recover();
  assert.strictEqual(installer.status().state, 'idle', 'an interrupted job is reported once');
  done();
});

test('recover ignores a finished job', function (done) {
  var ctx = setup();
  fs.writeFileSync(path.join(ctx.state, 'install-job.json'), JSON.stringify({ jobId: 'abc', state: 'installed' }));
  installer.recover();
  assert.strictEqual(installer.status().state, 'idle');
  done();
});

test('the preview names where the package came from', function (done) {
  var ctx = setup();
  startOk({ source: 'file', path: ctx.ipkFile(makeIpk()) }, function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(s.preview.source, 'file');
      done();
    });
  });
});

test('an upload is checked for size, space and a running job before it is read', function (done) {
  var ctx = setup({ init: { caps: { uploadBytes: 1000 } } });
  var df = path.join(ctx.dir, 'df');
  shell(df, "printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/x 100 99 1 99%% /\\n'");
  installer.prepareUpload(1001, function (err, file, status) {
    assert.ok(/larger than/.test(err), err);
    assert.strictEqual(status, 413);
    ctx.init({ caps: { uploadBytes: 1000 }, dfPath: df });
    installer.prepareUpload(500, function (err2, file2, status2) {
      assert.ok(/not enough free space/.test(err2), err2);
      assert.strictEqual(status2, 507);
      assert.strictEqual(installer.isBusy(), false);
      installer.start({ source: 'url', url: 'https://example.org/a.ipk' }, function (err3) {
        assert.ifError(err3);   // a refused upload holds nothing
        done();
      });
    });
  });
});

test('a reserved upload blocks other installs until it is started or released', function (done) {
  var ctx = setup();
  fs.writeFileSync(path.join(ctx.staging, 'upload-stale.ipk'), 'x');
  installer.prepareUpload(100, function (err, file, status) {
    assert.ifError(err);
    assert.strictEqual(path.dirname(file), ctx.staging);
    assert.deepEqual(fs.readdirSync(ctx.staging), [], 'a stale upload is cleared');
    installer.prepareUpload(100, function (err2, f2, st2) {
      assert.strictEqual(st2, 409, 'one upload at a time');
      installer.start(ctx.pkg(makeIpk()), function (err3) {
        assert.ok(/upload is in progress/.test(err3), err3);
        fs.writeFileSync(file, makeIpk());
        installer.start({ source: 'file', path: file }, function (err4) {
          assert.ifError(err4);
          expectState('awaiting-confirm', function () { done(); });
        });
      });
    });
  });
});

test('releasing an upload deletes the file and frees the hold', function (done) {
  var ctx = setup();
  installer.prepareUpload(100, function (err, file) {
    assert.ifError(err);
    fs.writeFileSync(file, 'partial');
    installer.releaseUpload(file);
    assert.ok(!fs.existsSync(file));
    installer.prepareUpload(100, function (err2) { assert.ifError(err2); done(); });
  });
});

test('a silent install is accepted when the app list shows the appinfo version', function (done) {
  var ctx = setup({ installTimeoutMs: 300 });
  ctx.script([], 'hold');
  startOk(ctx.pkg(makeIpk({ appVersion: '1.0.0-b2' })), function () {
    expectState('awaiting-confirm', function (s) {
      ctx.installed = [{ id: 'com.example.app', version: '1.0.0-b2' }];
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('installed', function () { done(); });
      });
    });
  });
});

test('an upload checks free space even when the staging directory does not exist yet', function (done) {
  var ctx = setup();
  var df = path.join(ctx.dir, 'df');
  shell(df, '[ -d "$2" ] || exit 1\nprintf \'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/x 100 99 1 99%% /\\n\'');
  ctx.init({ dfPath: df });
  fs.rmdirSync(ctx.staging);
  installer.prepareUpload(500, function (err, file, status) {
    assert.ok(/not enough free space/.test(err), err);
    assert.strictEqual(status, 507);
    done();
  });
});

test('upload data keeps the hold past its first 30 minutes', function (done) {
  var ctx = setup();
  var realNow = Date.now;
  var at = realNow.call(Date);
  Date.now = function () { return at; };
  installer.prepareUpload(100, function (err) {
    assert.ifError(err);
    at += 20 * 60 * 1000;
    installer.touchUpload();
    at += 20 * 60 * 1000;
    installer.start(ctx.pkg(makeIpk()), function (err2) {
      Date.now = realNow;
      assert.ok(/upload is in progress/.test(err2), err2);
      done();
    });
  });
});

test('an upload that sends nothing for 30 minutes lets the hold lapse', function (done) {
  var ctx = setup();
  var realNow = Date.now;
  var at = realNow.call(Date);
  Date.now = function () { return at; };
  installer.prepareUpload(100, function (err) {
    assert.ifError(err);
    at += 31 * 60 * 1000;
    installer.touchUpload();
    installer.start(ctx.pkg(makeIpk()), function (err2) {
      Date.now = realNow;
      assert.ifError(err2);
      done();
    });
  });
});

test('recover clears leftover uploads when no job is on file or the job finished', function (done) {
  var ctx = setup();
  fs.writeFileSync(path.join(ctx.staging, 'upload-abc.ipk'), 'partial');
  installer.recover();
  assert.deepEqual(fs.readdirSync(ctx.staging), []);
  fs.writeFileSync(path.join(ctx.staging, 'upload-def.ipk'), 'partial');
  fs.writeFileSync(path.join(ctx.state, 'install-job.json'), JSON.stringify({ jobId: 'abc', state: 'installed' }));
  installer.recover();
  assert.deepEqual(fs.readdirSync(ctx.staging), []);
  assert.strictEqual(installer.status().state, 'idle');
  done();
});

test('a preview waiting for confirmation is busy for installs but not working', function (done) {
  var ctx = setup();
  ctx.script([{ out: PROGRESS }], 'hold');
  assert.strictEqual(installer.isWorking(), false);
  startOk(ctx.pkg(makeIpk()), function () {
    assert.strictEqual(installer.isWorking(), true, 'downloading is work');
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(installer.isBusy(), true);
      assert.strictEqual(installer.isWorking(), false);
      installer.confirm({ jobId: s.jobId }, function () {
        assert.strictEqual(installer.isWorking(), true, 'installing is work');
        done();
      });
    });
  });
});

test('confirm waits for a running dashboard update', function (done) {
  var updating = false;
  var ctx = setup({ init: { updaterBusy: function () { return updating; } } });
  startOk(ctx.pkg(makeIpk()), function () {
    expectState('awaiting-confirm', function (s) {
      updating = true;
      installer.confirm({ jobId: s.jobId }, function (err) {
        assert.ok(/update is running/.test(err), err);
        assert.strictEqual(installer.status().state, 'awaiting-confirm');
        done();
      });
    });
  });
});

test('root for a package from a URL or file needs the services named in the request', function (done) {
  var ctx = setup();
  ctx.script([{ out: DONE }]);
  var ipk = makeIpk({ services: ['com.example.app.one', 'com.example.app.two'] });
  startOk({ source: 'file', path: ctx.ipkFile(ipk) }, function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(s.preview.willElevate, false);
      installer.confirm({ jobId: s.jobId, elevate: true }, function (e1) {
        assert.ok(/must be confirmed/.test(e1), e1);
        installer.confirm({ jobId: s.jobId, elevate: true, confirmRoot: ['com.example.app.one'] }, function (e2) {
          assert.ok(/must be confirmed/.test(e2), e2);
          installer.confirm({ jobId: s.jobId, elevate: true, confirmRoot: 'com.example.app.one' }, function (e3) {
            assert.ok(/must be confirmed/.test(e3), e3);
            assert.strictEqual(installer.status().state, 'awaiting-confirm');
            installer.confirm({ jobId: s.jobId, elevate: true, confirmRoot: ['com.example.app.two', 'com.example.app.one'] }, function (e4) {
              assert.ifError(e4);
              expectState('installed', function (r) {
                assert.deepEqual(r.result.elevation.done, ['com.example.app.one', 'com.example.app.two']);
                done();
              });
            });
          });
        });
      });
    });
  });
});

test('a package from a URL or file is not elevated again from elevated.json', function (done) {
  var ctx = setup();
  ctx.script([{ out: DONE }]);
  fs.writeFileSync(path.join(ctx.state, 'elevated.json'), JSON.stringify({ 'com.example.app': ['com.example.app.service'] }));
  startOk({ source: 'file', path: ctx.ipkFile(makeIpk()) }, function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(s.preview.willElevate, false);
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('installed', function (r) {
          assert.deepEqual(logLines(ctx.elevLog), []);
          assert.strictEqual(r.result.elevation, null);
          done();
        });
      });
    });
  });
});

test('a catalog update is elevated again only for the services recorded', function (done) {
  var ctx = setup();
  ctx.script([{ out: DONE }]);
  fs.writeFileSync(path.join(ctx.state, 'elevated.json'), JSON.stringify({ 'com.example.app': ['com.example.app.one', 'com.example.app.gone'] }));
  startOk(ctx.pkg(makeIpk({ services: ['com.example.app.one', 'com.example.app.two'] })), function () {
    expectState('awaiting-confirm', function (s) {
      assert.strictEqual(s.preview.willElevate, true);
      installer.confirm({ jobId: s.jobId }, function () {
        expectState('installed', function () {
          assert.deepEqual(logLines(ctx.elevLog), ['com.example.app.one']);
          done();
        });
      });
    });
  });
});

/* ---------------------------------------------------------------- runner */

var failures = 0;
(function run(i) {
  if (i >= tests.length) return finish();
  var t = tests[i];
  var settled = false;
  var guard = setTimeout(function () { settle(new Error('timed out')); }, 20000);
  function settle(err) {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    if (err) { failures++; console.log('  ✗ ' + t[0] + '\n      ' + (err.stack || err.message)); }
    else console.log('  ✓ ' + t[0]);
    run(i + 1);
  }
  // Assertions in later callbacks surface as uncaught exceptions.
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', settle);
  try { t[1](function () { settle(null); }); } catch (e) { settle(e); }
})(0);

function finish() {
  delete process.env.FAKE_LUNA_SCRIPT;
  delete process.env.FAKE_LUNA_LOG;
  try { require('child_process').execSync('rm -rf "' + root + '"'); } catch (e) {}
  if (!failures) console.log('ALL test-installer.js assertions passed!\n');
  process.exit(failures ? 1 : 0);
}
