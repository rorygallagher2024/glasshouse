/**
 * test/test-screensaver-shadowed.js - The start-up auto-heal leaves a staged
 * screen saver alone while it is mounted over LG's app (#1378)
 *
 * After a reboot, Aerial's boot hook had bind-mounts its assets folder over
 * LG's screen saver app in a shared peer group, and the staged copy mounted on
 * top of it then also showed over Aerial's own assets folder. Aerial's saver
 * read as gone, the marker as stock, and the auto-heal emptied the mounted
 * copy. The mountinfo lines are the ones read from the TV in the issue.
 *
 * Strict ES5: runs on node 0.10.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var mockEnv = require('./mocks/mock-env');

console.log('Running test-screensaver-shadowed.js ...');

var APP_DIR = '/usr/palm/applications/com.webos.app.screensaver';
var STAGED_DIR = '/var/lib/tvweb/screensaver';
var AERIAL = 'org.aabytt.webos.custom-screensaver-aerial';
var AERIAL_ID = 'app-org-aabytt-webos-custom-screensaver-aerial';

// Aerial's folder as the server saw it: its assets folder shadowed by the
// staged copy, so no screen saver QML in it. Made before the mock is in place,
// which keeps writes under /var and /tmp in memory.
var appsRoot = path.join(os.tmpdir(), 'tvweb-shadowed-' + process.pid);
fs.mkdirSync(appsRoot);
fs.mkdirSync(path.join(appsRoot, AERIAL));
fs.mkdirSync(path.join(appsRoot, AERIAL, 'assets'));
fs.writeFileSync(path.join(appsRoot, AERIAL, 'appinfo.json'), '{"title":"Aerial","version":"3.0.4"}');

var AERIAL_MOUNT = '1948 59 179:60 /developer/apps/usr/palm/applications/' + AERIAL + '/assets ' + APP_DIR +
  ' rw,nosuid,relatime shared:40 - ext4 /dev/mmcblk0p60 rw,data=ordered';
function ourMount(root) {
  return '2847 1948 179:59 ' + root + ' ' + APP_DIR + ' rw,nosuid,relatime shared:39 - ext4 /dev/mmcblk0p59 rw,data=ordered';
}
var PROPAGATED = '2852 82 179:59 ' + STAGED_DIR + ' /media/developer/apps/usr/palm/applications/' + AERIAL +
  '/assets rw,nosuid,relatime shared:39 - ext4 /dev/mmcblk0p59 rw,data=ordered';
var JAIL = '3001 2900 179:58 ' + APP_DIR + ' /var/palm/jail/com.example/usr/palm/applications/com.webos.app.screensaver' +
  ' ro,relatime shared:12 - ext4 /dev/mmcblk0p58 ro';

var env = mockEnv.createMockEnv();
env.install();
var screensavers = require('../server/lib/screensavers');

var stagedMarker = path.join(STAGED_DIR, '.tvweb-screensaver');
var stagedQml = path.join(STAGED_DIR, 'appinfo.json');

function stage(mountinfo) {
  env.files['/proc/self/mountinfo'] = mountinfo.join('\n') + '\n';
  // The app shows the staged copy while it is mounted.
  env.files[path.join(APP_DIR, '.tvweb-screensaver')] = AERIAL_ID;
  env.files[stagedMarker] = AERIAL_ID;
  env.files[stagedQml] = '{"type":"qml"}';
}

function start() {
  screensavers.init({ luna: env.mockLuna, config: {}, saverRoots: [{ dir: appsRoot, builtin: false, apps: true }] });
}

try {
  (function testShadowedMountKept() {
    stage([AERIAL_MOUNT, ourMount(STAGED_DIR), PROPAGATED]);
    assert.strictEqual(screensavers.screensaverMode(), 'stock', 'Aerial reads as gone while shadowed');
    assert.strictEqual(screensavers.stagedCopyMounted(), true);
    start();
    assert.strictEqual(fs.existsSync(stagedMarker), true, 'staged marker kept');
    assert.strictEqual(fs.existsSync(stagedQml), true, 'staged files kept');
    console.log('  ✓ a staged copy mounted over the app is not cleared, though its saver reads as gone');
  })();

  (function testSeparateVarMountKept() {
    // /var/lib as a filesystem of its own: mountinfo's root is the path inside it.
    stage([ourMount('/tvweb/screensaver')]);
    assert.strictEqual(screensavers.stagedCopyMounted(), true);
    start();
    assert.strictEqual(fs.existsSync(stagedMarker), true);
    console.log('  ✓ the mount is found where /var/lib is its own filesystem');
  })();

  (function testUnmountedOrphanCleared() {
    // Only Aerial's own mount, and the jail's bind of the app elsewhere: the
    // staged copy is not in place, so its marker is an orphan.
    stage([AERIAL_MOUNT, JAIL]);
    env.files[path.join(APP_DIR, '.tvweb-screensaver')] = null;
    assert.strictEqual(screensavers.stagedCopyMounted(), false);
    start();
    assert.strictEqual(fs.existsSync(stagedMarker), false, 'orphaned marker cleared');
    assert.strictEqual(fs.existsSync(stagedQml), false);
    console.log('  ✓ an orphaned staged copy that is not mounted is still cleared');
  })();
} finally {
  env.restore();
  fs.unlinkSync(path.join(appsRoot, AERIAL, 'appinfo.json'));
  fs.rmdirSync(path.join(appsRoot, AERIAL, 'assets'));
  fs.rmdirSync(path.join(appsRoot, AERIAL));
  fs.rmdirSync(appsRoot);
}
