'use strict';
/*
 * Wake-on-LAN opening Home rather than the last input.
 *
 * At a wake, bootd starts the last input under Home unless the power-on reason
 * is one it opens an app for (a G3, webOS 10.3: remoteKey reopens the last app).
 * Woken over the network, the TV put HDMI 2 in front and a PS5 on it woke over
 * HDMI-CEC, before Glasshouse Home covered the input. bootd reads
 * /var/luna/preferences/bootd.json in place of /etc/palm/bootd.json, as a
 * whole config, once as it starts (a C9, webOS 4.10.0), so LG's config is copied
 * there with the Wake-on-LAN reasons opening Home, and is used from the next
 * boot. With wakeOnWiFi mapped to com.webos.app.home, a G3 (webOS 10.3) woken
 * from Suspend opened Home and never launched the input.
 *
 * Only a file written here is replaced or removed: what was written is kept in
 * a copy, and a file that differs from it is someone else's.
 */
var fs = require('fs');
var util = require('./util');

var REASONS = ['wakeOnWiFi', 'wakeOnLan'];
var lgConf = '/etc/palm/bootd.json';
var ownConf = '/var/luna/preferences/bootd.json';
var copyFile = null;

function init(opts) {
  opts = opts || {};
  if (opts.lgConf) lgConf = opts.lgConf;
  if (opts.ownConf) ownConf = opts.ownConf;
  copyFile = opts.copyFile || null;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

/*
 * LG's config with the wake reasons opening appId, or null where it cannot be
 * read or has no map, or already names every one of them.
 */
function build(appId) {
  var conf = util.readJson(lgConf, null);
  var map = conf && conf.common && conf.common.firstAppByPowerOnReason;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  var added = false;
  REASONS.forEach(function (reason) {
    if (!Object.prototype.hasOwnProperty.call(map, reason)) {
      map[reason] = appId;
      added = true;
    }
  });
  return added ? conf : null;
}

function ours() {
  var written = copyFile && readText(copyFile);
  return written !== null && written === readText(ownConf);
}

function remove() {
  if (!copyFile) return false;
  var had = ours();
  if (had) util.unlinkQuiet(ownConf);
  util.unlinkQuiet(copyFile);
  return had;
}

/*
 * appId: the app the wake reasons open; null, LG's own config again. Returns
 * 'written', 'removed', 'kept' (someone else's file left alone) or ''.
 */
function sync(appId) {
  if (!copyFile) return '';
  if (!appId) return remove() ? 'removed' : '';
  var conf = build(appId);
  if (!conf) return remove() ? 'removed' : '';
  if (readText(ownConf) !== null && !ours()) return 'kept';
  var text = JSON.stringify(conf, null, 2);
  if (readText(ownConf) === text) return '';
  try {
    // The copy first: a file left without one would be taken for someone else's.
    fs.writeFileSync(copyFile, text, 'utf8');
    util.writeJsonAtomic(ownConf, conf);
  } catch (e) {
    console.error('home: could not write ' + ownConf + ': ' + e.message);
    return '';
  }
  return 'written';
}

module.exports = { init: init, sync: sync, REASONS: REASONS };
