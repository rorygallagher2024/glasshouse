/**
 * test/test-home-takeover.js - LG Home process scanning and takeover helpers.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var takeover = require('../server/lib/home-takeover');

console.log('Running test-home-takeover.js ...');

var dir = path.join(os.tmpdir(), 'home-takeover-test-' + process.pid);
var procDir = path.join(dir, 'proc');

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}
process.on('exit', function () { rmrf(dir); });

rmrf(dir);
fs.mkdirSync(dir);
fs.mkdirSync(procDir);

var killed = [];
takeover.init({
  procDir: procDir,
  kill: function (pid) { killed.push(pid); }
});

function writePid(pid, comm, cmdline) {
  var p = path.join(procDir, String(pid));
  if (!fs.existsSync(p)) fs.mkdirSync(p);
  if (comm !== null) fs.writeFileSync(path.join(p, 'comm'), comm + '\n');
  if (cmdline !== null) fs.writeFileSync(path.join(p, 'cmdline'), cmdline);
}

// 1. Native webOS 9 LG Home with comm matching truncated name
writePid(1001, 'com.webos.app.h', '/usr/bin/com.webos.app.home\0');

// 2. Flutter client LG Home on webOS 10/11
writePid(1002, 'flutter-client', '/usr/bin/flutter-client\0-i\0com.webos.app.home\0');

// 3. Other process with unrelated comm: should be skipped even if cmdline matches
writePid(1003, 'WebAppMgr', '/usr/bin/com.webos.app.home\0');

// 4. Flutter client running a different app
writePid(1004, 'flutter-client', '/usr/bin/flutter-client\0-i\0com.other.app\0');

// 5. Process without comm file (fallback to cmdline)
writePid(1005, null, '/usr/bin/com.webos.app.home\0');

// 6. Non-numeric directory
var notPid = path.join(procDir, 'self');
fs.mkdirSync(notPid);
fs.writeFileSync(path.join(notPid, 'cmdline'), '/usr/bin/com.webos.app.home\0');

var count = takeover.stopLgHome();
assert.strictEqual(count, 3, 'stops native, flutter LG Home, and fallback process without comm');
assert.deepEqual(killed.sort(), [1001, 1002, 1005], 'killed exactly matching PIDs');

rmrf(dir);
console.log('ALL test-home-takeover.js assertions passed!');
