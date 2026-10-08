/*
 * lib/samrescan.js - make sam read its apps again without restarting it (#366)
 *
 * Hiding a Home tile and replacing the screen saver both bind-mount an
 * appinfo.json, which sam reads only when it scans. Restarting sam was the
 * only way found to make it scan, and that restart is the one thing every
 * black-picture report in #366 has in common.
 *
 * sam also scans when configd's profile.blockedAppList changes: LG uses it to
 * block apps by region, and sam watches it. Adding an id no app has and then
 * putting the list back exactly as it was blocks nothing, and sam rereads every
 * appinfo.json, overlays included, within seconds and without restarting: on a
 * C2 on webOS 9.2 a visible:false overlay took effect and sam kept its pid. The
 * list lives in configd's memory, so the nudge leaves nothing behind.
 *
 * webOS 4 has no such setting (a B8 reports it missing), and there callers
 * restart sam as before. They also do if sam has not caught up in time.
 *
 * Strict ES5: runs on node 0.12.
 */
var KEY = 'profile.blockedAppList';
// Not an app: blocking it blocks nothing.
var NUDGE_ID = 'io.github.rorygallagher2024.lg-webos-dashboard.rescan';
var NUDGE_MS = 1500;
var CHECK_POLL_MS = 500;
var CHECK_POLLS = 16;

var lunaFn = null;
var supported = null;
var running = false;
var waiting = [];

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  supported = null;
  if (opts.nudgeMs !== undefined) NUDGE_MS = opts.nudgeMs;
  if (opts.pollMs !== undefined) CHECK_POLL_MS = opts.pollMs;
}

function readList(cb) {
  lunaFn('com.webos.service.config/getConfigs', { configNames: [KEY] }, function (r) {
    var list = r && r.configs && r.configs[KEY];
    cb(Array.isArray(list) ? list : null);
  });
}

function writeList(list, cb) {
  var configs = {};
  configs[KEY] = list;
  lunaFn('com.webos.service.config/setConfigs', { configs: configs }, function (r) {
    cb(!!(r && r.returnValue));
  });
}

/*
 * One nudge at a time: a second one reading the list mid-nudge would take the
 * nudge id for LG's own and put it back.
 */
function nudge(cb) {
  waiting.push(cb);
  if (running) return;
  running = true;
  (function run() {
    var batch = waiting.splice(0, waiting.length);
    nudgeOnce(function (ok) {
      batch.forEach(function (f) { f(ok); });
      if (waiting.length) return run();
      running = false;
    });
  })();
}

function nudgeOnce(cb) {
  if (!lunaFn || supported === false) return cb(false);
  readList(function (list) {
    if (!list) {
      supported = false;
      console.log('samrescan: no ' + KEY + ' on this TV - sam is restarted instead');
      return cb(false);
    }
    supported = true;
    // A run cut short could have left the id in; LG's list is the rest.
    var lg = list.filter(function (id) { return id !== NUDGE_ID; });
    writeList(lg.concat([NUDGE_ID]), function (ok) {
      if (!ok) return cb(false);
      setTimeout(function () { restore(lg, 3, cb); }, NUDGE_MS);
    });
  });
}

function restore(lg, tries, cb) {
  writeList(lg, function (ok) {
    if (ok) return cb(true);
    if (tries <= 1) {
      console.error('samrescan: could not put ' + KEY + ' back; it clears at the next reboot');
      return cb(false);
    }
    setTimeout(function () { restore(lg, tries - 1, cb); }, 1000);
  });
}

/*
 * Nudges sam, then waits until check(done) says the change has taken, for up
 * to CHECK_POLLS polls. cb(true) once it has; cb(false) where the TV cannot be
 * nudged or sam did not catch up, so the caller restarts sam instead.
 */
function refresh(check, cb) {
  nudge(function (ok) {
    if (!ok) return cb(false);
    if (!check) return cb(true);
    var polls = 0;
    (function poll() {
      polls++;
      check(function (done) {
        if (done) return cb(true);
        if (polls >= CHECK_POLLS) {
          console.log('samrescan: sam had not caught up after the nudge');
          return cb(false);
        }
        setTimeout(poll, CHECK_POLL_MS);
      });
    })();
  });
}

module.exports = {
  init: init,
  refresh: refresh,
  KEY: KEY,
  NUDGE_ID: NUDGE_ID
};
