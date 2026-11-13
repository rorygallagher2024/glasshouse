/**
 * An app's hosts copy follows blocker changes and jail resets, including
 * copies made before clock sync. No TV commands run. Strict ES5 / node 0.10.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var waitFor = require('./wait-for').waitFor;
var appHosts = require('../server/lib/apphosts');

var dir = path.join(os.tmpdir(), 'apphosts-' + process.pid);
var jails = path.join(dir, 'jail');
var hostFile = path.join(dir, 'hosts');
var BASE = '127.0.0.1 localhost\n::1 localhost\n';
var MARK = '# LG Ad & Telemetry Blackhole (lg-webos-dashboard)\n';
var EARLY = BASE + MARK + '0.0.0.0 mtalk.google.com\n:: mtalk.google.com\n';
var FULL = EARLY + '0.0.0.0 de.nextlgsdp.com\n:: de.nextlgsdp.com\n192.168.1.5 nas\n';
var watches = [];
var steps = [];

function mkdirs(p) {
  if (fs.existsSync(p)) return;
  mkdirs(path.dirname(p));
  fs.mkdirSync(p);
}
function remove(p) {
  var info;
  try { info = fs.lstatSync(p); } catch (e) { return; }
  if (info.isDirectory()) { fs.readdirSync(p).forEach(function (name) { remove(path.join(p, name)); }); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
function fileOf(id) { return path.join(jails, id, 'etc', 'hosts'); }
function read(id) { return fs.readFileSync(fileOf(id), 'utf8'); }
function makeJail(id, text) {
  mkdirs(path.dirname(fileOf(id)));
  fs.writeFileSync(fileOf(id), text || BASE);
  fs.writeFileSync(path.join(jails, id, 'etc', 'resolv.conf'), 'nameserver 127.0.0.1\n');
}
function fakeWatch(p, callback) {
  var w = { path: p, callback: callback, closed: false, close: function () { this.closed = true; }, on: function (event, fn) { this.error = fn; } };
  watches.push(w);
  return w;
}
function fire(p, name) {
  var count = 0;
  watches.slice().forEach(function (w) { if (!w.closed && w.path === p) { w.callback('rename', name); count++; } });
  return count;
}
function init(watch, recheckMs) {
  appHosts.init({ jailRoot: jails, hostFile: hostFile, watch: watch || fakeWatch, recheckMs: recheckMs || 10000, debounceMs: 1 });
}
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function equalSoon(id, text, done, what) {
  waitFor(function () { return read(id) === text; }, done, what || id + ' hosts updated', 500);
}

remove(dir);
mkdirs(jails);
process.on('exit', function () { appHosts.stop(); remove(dir); });
fs.writeFileSync(hostFile, EARLY);
makeJail('com.webos.chromecast', BASE);
makeJail('lg.thinqai.adapter', BASE);
makeJail('constructor', BASE);
init();

step('startup repairs old app and service copies without changing their DNS servers', function (done) {
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), EARLY);
  assert.equal(read('lg.thinqai.adapter'), EARLY);
  assert.equal(read('constructor'), EARLY);
  assert.equal(fs.readFileSync(path.join(jails, 'com.webos.chromecast', 'etc', 'resolv.conf'), 'utf8'), 'nameserver 127.0.0.1\n');
  done();
});

step('clock sync updates existing jails with both address families and foreign mappings', function (done) {
  fs.writeFileSync(hostFile, FULL);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), FULL);
  assert.equal(read('lg.thinqai.adapter'), FULL);
  done();
});

step('a launch copy is repaired when the directory watch sees hosts change', function (done) {
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  assert.ok(fire(path.dirname(fileOf('com.webos.chromecast')), 'hosts'));
  equalSoon('com.webos.chromecast', FULL, done);
});

step('a new jail is found by the root watch', function (done) {
  makeJail('com.webos.service.voice.performer', BASE);
  assert.ok(fire(jails, 'com.webos.service.voice.performer'));
  equalSoon('com.webos.service.voice.performer', FULL, done);
});

step('replacing etc at a reset rearms its watch', function (done) {
  remove(path.dirname(fileOf('com.webos.chromecast')));
  makeJail('com.webos.chromecast', BASE);
  fire(path.join(jails, 'com.webos.chromecast'), 'jail-reset.10.3.1');
  equalSoon('com.webos.chromecast', FULL, function () {
    fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
    assert.ok(fire(path.dirname(fileOf('com.webos.chromecast')), 'hosts'));
    equalSoon('com.webos.chromecast', FULL, done);
  });
});

step('an unchanged table is not rewritten, and permissions are preserved', function (done) {
  fs.chmodSync(fileOf('com.webos.chromecast'), parseInt('640', 8));
  var before = fs.statSync(fileOf('com.webos.chromecast'));
  appHosts.sync();
  assert.equal(fs.statSync(fileOf('com.webos.chromecast')).ino, before.ino);
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  appHosts.sync();
  assert.equal(fs.statSync(fileOf('com.webos.chromecast')).mode & parseInt('777', 8), parseInt('640', 8));
  done();
});

step('an etc reset rearms watching even when its inode is unchanged', function (done) {
  var etc = path.dirname(fileOf('com.webos.chromecast'));
  var before = watches.filter(function (w) { return !w.closed && w.path === etc; })[0];
  assert.ok(before);
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  // Keeping the same directory models inode reuse without relying on the OS allocator.
  fire(path.join(jails, 'com.webos.chromecast'), 'etc');
  equalSoon('com.webos.chromecast', FULL, function () {
    assert.ok(before.closed, 'the old inode watch is no longer usable');
    var after = watches.filter(function (w) { return !w.closed && w.path === etc; })[0];
    assert.ok(after && after !== before, 'the recreated path has its own watch');
    fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
    fire(etc, 'hosts');
    equalSoon('com.webos.chromecast', FULL, done);
  });
});

step('a jail reset rearms both watches even when its inodes are unchanged', function (done) {
  var jail = path.join(jails, 'com.webos.chromecast');
  var before = watches.filter(function (w) { return !w.closed && (w.path === jail || w.path === path.join(jail, 'etc')); });
  assert.equal(before.length, 2);
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  fire(jails, 'com.webos.chromecast');
  equalSoon('com.webos.chromecast', FULL, function () {
    assert.ok(before.every(function (w) { return w.closed; }), 'old watches must not follow reused inodes');
    fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
    assert.ok(fire(path.join(jail, 'etc'), 'hosts'));
    equalSoon('com.webos.chromecast', FULL, done);
  });
});

step('tier and custom-list changes remove old entries as well as adding new ones', function (done) {
  fs.writeFileSync(hostFile, EARLY);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), EARLY);
  var custom = BASE + MARK + '0.0.0.0 custom.example.com\n:: custom.example.com\n';
  fs.writeFileSync(hostFile, custom);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), custom);
  fs.writeFileSync(hostFile, FULL);
  appHosts.sync();
  done();
});

step('symlinked jails, etc directories and hosts files are left alone', function (done) {
  var outside = path.join(dir, 'outside');
  mkdirs(path.join(outside, 'etc'));
  fs.writeFileSync(path.join(outside, 'etc', 'hosts'), 'outside');
  fs.symlinkSync(outside, path.join(jails, 'symlink-jail'));
  mkdirs(path.join(jails, 'symlink-etc'));
  fs.symlinkSync(path.join(outside, 'etc'), path.join(jails, 'symlink-etc', 'etc'));
  makeJail('symlink-hosts', BASE);
  fs.unlinkSync(fileOf('symlink-hosts'));
  fs.symlinkSync(path.join(outside, 'etc', 'hosts'), fileOf('symlink-hosts'));
  appHosts.sync();
  assert.equal(fs.readFileSync(path.join(outside, 'etc', 'hosts'), 'utf8'), 'outside');
  assert.ok(fs.lstatSync(fileOf('symlink-hosts')).isSymbolicLink());
  done();
});

step('an unwritable or mounted target does not prevent another jail being repaired', function (done) {
  var rename = fs.renameSync;
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  fs.writeFileSync(fileOf('lg.thinqai.adapter'), EARLY);
  fs.renameSync = function (from, to) {
    if (to === fileOf('com.webos.chromecast')) { var error = new Error('mount point'); error.code = 'EBUSY'; throw error; }
    return rename.apply(fs, arguments);
  };
  try { appHosts.sync(); } finally { fs.renameSync = rename; }
  assert.equal(read('com.webos.chromecast'), EARLY);
  assert.equal(read('lg.thinqai.adapter'), FULL);
  assert.equal(fs.readFileSync(hostFile, 'utf8'), FULL);
  assert.deepEqual(fs.readdirSync(path.dirname(fileOf('com.webos.chromecast'))).sort(), ['hosts', 'resolv.conf']);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), FULL);
  done();
});

step('missing or empty source files cannot erase a jail table', function (done) {
  fs.unlinkSync(hostFile);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), FULL);
  fs.writeFileSync(hostFile, '');
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), FULL);
  fs.writeFileSync(hostFile, FULL);
  done();
});

step('the fallback repairs missed events and works without filesystem watches', function (done) {
  init(function () { throw new Error('watch unavailable'); }, 5);
  appHosts.sync();
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  equalSoon('com.webos.chromecast', FULL, done);
});

step('turning blocking off restores marked copies and closes the watches', function (done) {
  init();
  appHosts.sync();
  makeJail('owner-copy', BASE + '192.168.1.7 local.example\n');
  fs.writeFileSync(hostFile, BASE);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), BASE);
  assert.equal(read('lg.thinqai.adapter'), BASE);
  assert.equal(read('owner-copy'), BASE + '192.168.1.7 local.example\n');
  assert.equal(watches.filter(function (w) { return !w.closed; }).length, 0);
  done();
});

step('startup with blocking off clears copies left by an earlier server', function (done) {
  fs.writeFileSync(fileOf('com.webos.chromecast'), FULL);
  appHosts.sync();
  assert.equal(read('com.webos.chromecast'), BASE);
  assert.equal(watches.filter(function (w) { return !w.closed; }).length, 0);
  done();
});

step('late events after stop cannot restart watching or rewrite a jail', function (done) {
  fs.writeFileSync(hostFile, FULL);
  init();
  appHosts.sync();
  var old = watches.filter(function (w) { return !w.closed; });
  appHosts.stop();
  fs.writeFileSync(fileOf('com.webos.chromecast'), EARLY);
  old.forEach(function (w) { w.callback('rename', 'hosts'); });
  // A negative check: no queued copy may happen after the debounce period.
  setTimeout(function () {
    assert.equal(read('com.webos.chromecast'), EARLY);
    assert.equal(watches.filter(function (w) { return !w.closed; }).length, 0);
    done();
  }, 15);
});

step('real filesystem watches see new jails, launch copies and replaced etc directories', function (done) {
  init(fs.watch);
  appHosts.sync();
  makeJail('real-watch-app', BASE);
  equalSoon('real-watch-app', FULL, function () {
    fs.writeFileSync(fileOf('real-watch-app'), EARLY);
    equalSoon('real-watch-app', FULL, function () {
      remove(path.dirname(fileOf('real-watch-app')));
      makeJail('real-watch-app', BASE);
      equalSoon('real-watch-app', FULL, function () {
        fs.writeFileSync(fileOf('real-watch-app'), EARLY);
        equalSoon('real-watch-app', FULL, done, 'real watch after etc replacement');
      }, 'real watch sees replaced etc');
    }, 'real watch sees launch copy');
  }, 'real watch discovers new jail');
});

step('a jail root created after startup is discovered by the fallback', function (done) {
  var later = path.join(dir, 'later-jails');
  appHosts.init({ jailRoot: later, hostFile: hostFile, watch: fakeWatch, recheckMs: 5, debounceMs: 1 });
  fs.writeFileSync(hostFile, FULL);
  appHosts.sync();
  mkdirs(path.join(later, 'new-app', 'etc'));
  var file = path.join(later, 'new-app', 'etc', 'hosts');
  fs.writeFileSync(file, BASE);
  waitFor(function () { return fs.readFileSync(file, 'utf8') === FULL; }, done, 'new jail root discovered', 500);
});

(function run(i) {
  if (i === steps.length) {
    appHosts.stop();
    assert.equal(watches.filter(function (w) { return !w.closed; }).length, 0);
    console.log('test-apphosts.js: all ' + steps.length + ' passed');
    return;
  }
  steps[i].fn(function () { console.log('  ok - ' + steps[i].name); run(i + 1); });
})(0);
