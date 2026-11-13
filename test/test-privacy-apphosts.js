/**
 * The privacy blocker's table reaches app jails after mounts, clock sync,
 * country and list changes, and is removed there when blocking ends.
 * Every mount is simulated. Strict ES5 / node 0.10.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var realFs = {};
['readFileSync', 'writeFileSync', 'existsSync', 'unlinkSync', 'renameSync', 'chmodSync', 'mkdirSync'].forEach(function (name) { realFs[name] = fs[name]; });
var mock = require('./mocks/mock-env').createMockEnv();
mock.install();
var privacy = require('../server/lib/privacy');
var appHosts = require('../server/lib/apphosts');
var ROOT = '/etc/hosts';
var TABLE = '/var/lib/tvweb/adblock_hosts';
var FLAG = '/var/lib/tvweb/adblock_enabled';
var BASE = '127.0.0.1 localhost\n::1 localhost\n';
var dir = path.join(os.tmpdir(), 'privacy-apphosts-' + process.pid);
var jailFile = path.join(dir, 'jail', 'com.webos.chromecast', 'etc', 'hosts');
var mounted = false;
var mountReply = null;
var time = { returnValue: true, timeValid: false, systemTimeSource: 'system' };
var country = 'de';
var commands = [];
var writeFile;

// The TV paths are virtual; the jail copies use real temporary files.
Object.keys(realFs).forEach(function (name) {
  var virtual = fs[name];
  fs[name] = function (file) {
    if (typeof file === 'string' && (file === dir || file.indexOf(dir + path.sep) === 0)) return realFs[name].apply(fs, arguments);
    return virtual.apply(fs, arguments);
  };
});
writeFile = fs.writeFileSync;

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
remove(dir);
mkdirs(path.dirname(jailFile));
fs.writeFileSync(jailFile, BASE);
mock.files[ROOT] = BASE;
mock.files[FLAG] = 'full';

// A write to the generated inode is also seen through the simulated mount.
fs.writeFileSync = function (file, text) {
  var result = writeFile.apply(fs, arguments);
  if (file === TABLE && mounted) mock.files[ROOT] = text;
  return result;
};
function exec(command, args, options, callback) {
  commands.push(command);
  if (command === '/bin/mount') mountReply = callback;
  else if (command === '/bin/umount') {
    mounted = false;
    mock.files[ROOT] = BASE;
    callback(null);
  } else throw new Error('unexpected command: ' + command);
}
function finishMount(error) {
  var callback = mountReply;
  mountReply = null;
  if (!error) { mounted = true; mock.files[ROOT] = mock.files[TABLE]; }
  callback(error || null);
}
function luna(uri, params, callback) {
  if (uri === 'com.webos.service.systemservice/time/getSystemTime') callback(time);
  else callback({ returnValue: true, settings: { smartServiceCountryCode2: country } });
}
function jail() { return fs.readFileSync(jailFile, 'utf8'); }
function sinkholed(text, name) { return text.indexOf('0.0.0.0\t' + name) !== -1 && text.indexOf('::\t' + name) !== -1; }
function reply(method, value) {
  var result;
  method(value, function (r) { result = r; });
  assert.ok(result && result.ok, JSON.stringify(result));
  return result;
}

appHosts.init({ jailRoot: path.join(dir, 'jail'), hostFile: ROOT, watch: function () { return { on: function () {}, close: function () {} }; } });
privacy.init({ luna: luna, appHosts: appHosts, exec: exec });
process.on('exit', function () {
  privacy._clearSdpTimer();
  appHosts.stop();
  fs.writeFileSync = writeFile;
  mock.restore();
  remove(dir);
});

privacy._setSdpGraceActive(true);
privacy.checkBootAdBlock();
assert.ok(mountReply, 'mount is pending');
assert.strictEqual(jail(), BASE, 'nothing changes in the jail before the TV table is mounted');
assert.ok(!sinkholed(mock.files[TABLE], 'de.nextlgsdp.com'), 'clock host still reachable');
time.timeValid = true;
time.systemTimeSource = 'sdp';
privacy._checkSdpClockSync(false);
assert.ok(sinkholed(mock.files[TABLE], 'de.nextlgsdp.com'), 'clock completion updates the inode before the mount finishes');
finishMount();
assert.ok(jail() === mock.files[ROOT], 'jail follows the mounted table');
assert.ok(sinkholed(jail(), 'de.nextlgsdp.com'));
assert.ok(sinkholed(jail(), 'de.app.lgwebostv.com'));
assert.ok(sinkholed(jail(), 'de.lgrecommends.lgappstv.com'));
console.log('  ok - clock sync during a pending mount reaches existing jails');

// The ordinary cold-boot ordering: mounted first, clock sync afterwards.
time.timeValid = false;
time.systemTimeSource = 'system';
privacy._setSdpGraceActive(true);
privacy.checkBootAdBlock();
assert.ok(!sinkholed(jail(), 'de.nextlgsdp.com'));
time.timeValid = true;
time.systemTimeSource = 'sdp';
privacy._checkSdpClockSync(false);
assert.ok(sinkholed(jail(), 'de.nextlgsdp.com'));
assert.ok(sinkholed(jail(), 'eic.tv.wiselg.com'));
console.log('  ok - clock completion rewrites already mounted app copies');

reply(privacy.setAdBlock, 'ads');
assert.ok(sinkholed(jail(), 'ad.lgsmartad.com'));
assert.ok(!sinkholed(jail(), 'de.nextlgsdp.com'));
assert.ok(!sinkholed(jail(), 'de.app.lgwebostv.com'));
assert.ok(!sinkholed(jail(), 'de.lgrecommends.lgappstv.com'));
reply(privacy.setCustomHosts, { mode: 'replace', text: 'only.example.com\n' });
assert.ok(sinkholed(jail(), 'only.example.com'));
assert.ok(!sinkholed(jail(), 'ad.lgsmartad.com'));
reply(privacy.setCustomHosts, { clear: true });
reply(privacy.setAdBlock, 'full');
console.log('  ok - tier and custom-list changes reach app copies');

country = 'fr';
privacy.init({ luna: luna, appHosts: appHosts, exec: exec });
assert.ok(sinkholed(jail(), 'fr.lgeapi.com'));
assert.ok(!sinkholed(jail(), 'de.lgeapi.com'));
['app.lgwebostv.com', 'lgrecommends.lgappstv.com'].forEach(function (host) {
  assert.ok(sinkholed(jail(), 'fr.' + host));
  assert.ok(!sinkholed(jail(), 'de.' + host));
});
console.log('  ok - learned country changes reach app copies');

reply(privacy.setTvUpdatesBlocked, true);
reply(privacy.setAdBlock, 'off');
assert.ok(sinkholed(jail(), 'snu.lge.com'));
assert.ok(!sinkholed(jail(), 'mtalk.google.com'));
reply(privacy.setTvUpdatesBlocked, false);
assert.strictEqual(jail(), BASE, 'unmounting clears the blocks in the jail');
console.log('  ok - update-only blocking and unmounting reach app copies');

fs.writeFileSync(jailFile, BASE + '# LG Ad & Telemetry Blackhole (lg-webos-dashboard)\n0.0.0.0 stale.example\n');
privacy.checkBootAdBlock();
assert.strictEqual(jail(), BASE, 'startup with no blocking clears stale copies');
console.log('  ok - startup with the blocker off restores marked stale copies');

var failed;
privacy.setAdBlock('full', function (r) { failed = r; });
assert.ok(mountReply);
finishMount(new Error('mount refused'));
assert.ok(failed && !failed.ok);
assert.strictEqual(jail(), BASE, 'failed mounting does not enable the table inside apps');
assert.ok(commands.every(function (command) { return command === '/bin/mount' || command === '/bin/umount'; }));
console.log('  ok - a failed mount leaves app copies alone');
console.log('test-privacy-apphosts.js: all assertions passed');
