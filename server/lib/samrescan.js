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
 * C2 on webOS 9.2 a visible:false overlay took effect and sam kept its pid.
 * configd saves any setConfigs as a user-defined value that outlives reboots,
 * and has no call to drop one, so the list stays at LG's value as of the
 * nudge: should LG's own list change later, with a firmware update or a new
 * country, the saved copy still wins.
 *
 * webOS 4 has no such setting (a B8 reports it missing), and there callers
 * restart sam as before. They also do if sam has not caught up in time.
 *
 * On webOS 7 (a 65UQ801C0SB on 7.6.0) sam watches the list as well, its
 * binary naming profile.blockedAppList, but configd holds no value until one
 * is written. sam then blocks the list LG's server sent for the country, kept
 * in blockedAppList/<country>.json, so a nudge starts from that file: sam
 * rescanned within the second, kept its pid, and its app list was unchanged
 * after the list went back. Only where sam has no blockSystemApp, as there:
 * webOS 10 and 11 ignore the list and are reread app by app instead.
 *
 * sam ignores that list on webOS 10 (a C2 on 10.3.1 kept a blocked app on
 * Home), so there rereadApp() asks sam for one app instead:
 * applicationManager/blockSystemApp followed by releaseBlockSystemApp makes
 * sam drop and reread that app's appinfo.json, overlay included. The block is
 * written to /var/preferences/com.webos.applicationManager/
 * blockedSystemAppList/<country>.json and the release takes it out again; on
 * a C5 on 10.3.1 the file was byte-identical afterwards, a Flutter manifest
 * replaced by a QML one was reported within the second and sam kept its pid.
 * The two calls stay together, and the release is tried again if it fails,
 * since an app left blocked cannot launch. A running instance is not stopped:
 * the caller relaunches it.
 *
 * webOS 11 refuses the block with "invalid parameters" unless it also has
 * forceBlockSystemApp, which its schema requires (a G3 on 11.2.0, #768); with
 * false it blocks and releases as on webOS 10. It goes only where the TV's own
 * schema names it, since older firmware has not been tried with it.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var BLOCK_SCHEMA = '/etc/palm/schemas/sam/applicationManager.blockSystemApp.schema';
var SAM_BIN = '/usr/sbin/sam';
var COUNTRY_LISTS = '/var/preferences/com.webos.applicationManager/blockedAppList';
var KEY = 'profile.blockedAppList';
// Not an app: blocking it blocks nothing.
var NUDGE_ID = 'io.github.rorygallagher2024.lg-webos-dashboard.rescan';
var NUDGE_MS = 1500;
var CHECK_POLL_MS = 500;
var CHECK_POLLS = 16;

var lunaFn = null;
var supported = null;
var blockSchema = BLOCK_SCHEMA;
var samBin = SAM_BIN;
var countryLists = COUNTRY_LISTS;
var samReadsKey = null;   // whether sam's binary names KEY, read once
var forceParam = null;   // whether the block needs forceBlockSystemApp, read once
var running = false;
var waiting = [];

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  supported = null;
  forceParam = null;
  if (opts.blockSchema) blockSchema = opts.blockSchema;
  if (opts.samBin) samBin = opts.samBin;
  if (opts.countryLists) countryLists = opts.countryLists;
  samReadsKey = null;
  if (opts.nudgeMs !== undefined) NUDGE_MS = opts.nudgeMs;
  if (opts.pollMs !== undefined) CHECK_POLL_MS = opts.pollMs;
}

function readList(cb) {
  lunaFn('com.webos.service.config/getConfigs', { configNames: [KEY] }, function (r) {
    var list = r && r.configs && r.configs[KEY];
    if (Array.isArray(list)) return cb(list);
    if (r && r.returnValue) return cb(countryList());
    cb(null);
  });
}

/*
 * The list sam blocks while configd has none: the country's, where sam reads
 * the key, has no blockSystemApp, and exactly one country's list is kept.
 * null otherwise.
 */
function countryList() {
  try {
    if (fs.existsSync(blockSchema)) return null;
    if (samReadsKey === null) samReadsKey = fs.readFileSync(samBin).toString('binary').indexOf(KEY) !== -1;
    if (!samReadsKey) return null;
    var files = fs.readdirSync(countryLists).filter(function (f) { return /\.json$/.test(f); });
    if (files.length !== 1) return null;
    var list = JSON.parse(fs.readFileSync(countryLists + '/' + files[0], 'utf8')).blocked_applist;
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (typeof list[i] !== 'string') return null;
    return list;
  } catch (e) {
    return null;
  }
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
      console.log('samrescan: no ' + KEY + ' on this TV, so sam cannot be nudged');
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
 * cb(true) where the TV has the setting a nudge uses, cb(false) where it has
 * not, cb(null) where that is not known. Read once; a nudge also records it.
 */
function canNudge(cb) {
  if (supported !== null || !lunaFn) return cb(supported);
  readList(function (list) {
    if (supported === null) supported = !!list;
    cb(supported);
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
    waitFor(check, 'the nudge', cb);
  });
}

// cb(true) once check(done) says the change has taken, cb(false) after
// CHECK_POLLS polls without it. No check: cb(true) at once.
function waitFor(check, what, cb) {
  if (!check) return cb(true);
  var polls = 0;
  (function poll() {
    polls++;
    check(function (done) {
      if (done) return cb(true);
      if (polls >= CHECK_POLLS) {
        console.log('samrescan: sam had not caught up after ' + what);
        return cb(false);
      }
      setTimeout(poll, CHECK_POLL_MS);
    });
  })();
}

function needsForce() {
  if (forceParam === null) {
    try { forceParam = fs.readFileSync(blockSchema, 'utf8').indexOf('"forceBlockSystemApp"') !== -1; }
    catch (e) { forceParam = false; }
  }
  return forceParam;
}

// The block, and only the block, carries forceBlockSystemApp where the TV
// asks for it. A refusal is logged as sam gave it.
function samCall(method, appId, cb) {
  var payload = { id: appId };
  if (method === 'blockSystemApp' && needsForce()) payload.forceBlockSystemApp = false;
  lunaFn('com.webos.applicationManager/' + method, payload, function (r) {
    var ok = !!(r && r.returnValue);
    if (!ok && r && (r.errorText || r.errorCode !== undefined)) {
      console.log('samrescan: ' + method + ' for ' + appId + ' refused: ' + (r.errorText || '') +
                  (r.errorCode !== undefined ? ' (' + r.errorCode + ')' : ''));
    }
    cb(ok);
  });
}

function release(appId, tries, cb, quiet) {
  samCall('releaseBlockSystemApp', appId, function (ok) {
    if (ok) return cb(true);
    if (quiet) return cb(false);
    if (tries <= 1) {
      console.error('samrescan: could not release ' + appId + '; it stays blocked in '
                    + '/var/preferences/com.webos.applicationManager/blockedSystemAppList until released');
      return cb(false);
    }
    setTimeout(function () { release(appId, tries - 1, cb); }, 1000);
  });
}

/*
 * Makes sam reread one system app's appinfo.json with a block and a release,
 * then waits as refresh() does. cb(false) where sam has no such call (the
 * block is refused and nothing is released), where the release failed, or
 * where sam did not report the change in time, so the caller tries the nudge
 * or restarts sam.
 */
function rereadApp(appId, check, cb) {
  if (!lunaFn) return cb(false);
  samCall('blockSystemApp', appId, function (blocked) {
    if (!blocked) {
      // An answer that timed out may still have been a block sam made, so it
      // is released all the same, as the boot hook does; once and quietly,
      // as on a TV without the call (webOS 4) it is refused too.
      console.log('samrescan: sam did not take blockSystemApp for ' + appId);
      return release(appId, 1, function () { cb(false); }, true);
    }
    release(appId, 3, function (released) {
      if (!released) return cb(false);
      waitFor(check, 'the block and release', cb);
    });
  });
}

module.exports = {
  init: init,
  refresh: refresh,
  canNudge: canNudge,
  rereadApp: rereadApp,
  KEY: KEY,
  NUDGE_ID: NUDGE_ID
};
