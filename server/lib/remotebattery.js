/*
 * The Magic Remote's battery, from its Bluetooth Battery Service. LG's own
 * pairing file has only the remote model's battery thresholds (see
 * readRemoteInfo in telemetry.js), so the level is read from the remote itself.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * lginput2 holds the remote's own connection; the Bluetooth service reads the
 * level only over a GATT connection of its own, so each read connects, reads
 * and disconnects. Only a remote lginput2 has connected is read: one asleep is
 * not woken for it. It sleeps soon after it is put down, so the read waits for
 * it to wake: the first time after the TV switches on, then at most hourly.
 * See docs/development/TV-RESEARCH.md.
 */

var path = require('path');
var util = require('./util');
var lunaTransport = require('./luna');

var BT = 'com.webos.service.bluetooth2';
var BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
var BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';
var HOUR_MS = 3600000;
// A failed read is tried again at the next wake after this.
var RETRY_MS = 300000;
// For a remote kept awake, which announces no new connection.
var CHECK_MS = 600000;
// After the remote connects, before a second connection to it.
var SETTLE_MS = 3000;
// discoverServices answers before the services can be read.
var DISCOVER_MS = 2000;
var discoverMs = DISCOVER_MS;
var settleMs = SETTLE_MS;
/*
 * The Bluetooth read connects to the remote alongside lginput2's own
 * connection. It has been tried on webOS 9 (C2) and 10 (C4); on a webOS 5 TV
 * the remote lost its pointer and some buttons after waking, until a reboot,
 * once v0.97.0 began reading. webOS 11 is limited to the C5/MR25GA tested
 * below. Elsewhere only LG's remote service is asked.
 */
var webosVersion = '';
var getTVModel = function () { return ''; };
var getRemoteInfo = function () { return null; };
var attemptedMac = null;

/** @type {function(string, Object, function(any): void): void} */
var luna = null;
var onLevel = null;
var timer = null;
var subscription = null;
var isOnFn = function () { return true; };
var busy = false;
// When the next read is wanted; 0 is at the next chance.
var dueAt = 0;
// { level: 0-100, at: Unix ms, mac: string|null } once read.
var last = null;
var stateFile = null;
var connected = false;
var isBle = false;
var lowStrength = null;
var firmware = null;

function sameAddress(a, b) {
  return !!(a && b && a.toLowerCase() === b.toLowerCase());
}

function gattSupported(model, version, remoteModel) {
  if (!/^LGE MR\d+[A-Z]*$/i.test(remoteModel || '')) return false;
  if (/^(9|10)\./.test(version || '')) return true;
  // MR25GA returned 46% on this C5, webOS 11.2 / firmware 43.21.31.
  return isTestedC5(model, version) && /^LGE MR25GA$/i.test(remoteModel);
}

function isTestedC5(model, version) {
  return /^11\.2\./.test(version || '') && String(model || '').split('.')[0] === 'OLED77C5PUA';
}

function gattPlatformSupported() {
  return /^(9|10)\./.test(webosVersion) ||
    isTestedC5(getTVModel(), webosVersion);
}

function remoteDevice(devices, mac) {
  var candidates = [];
  for (var i = 0; i < (devices || []).length; i++) {
    var d = devices[i];
    if (d && d.paired && d.typeOfDevice === 'ble' && /^LGE MR/i.test(d.name || '') && d.address) {
      if (mac && sameAddress(mac, d.address)) return d;
      candidates.push(d);
    }
  }
  // Multiple saved remotes are not evidence of which one is in use.
  return !mac && candidates.length === 1 ? candidates[0] : null;
}

function remoteAddress(devices) {
  var device = remoteDevice(devices, null);
  return device ? device.address : null;
}

function levelFrom(r) {
  var bytes = r && r.returnValue && r.value && r.value.value && r.value.value.bytes;
  var n = bytes && bytes.length ? bytes[0] : null;
  return validLevel(n) ? n : null;
}

function deviceLevelFrom(info) {
  var n = info && info.returnValue ? info.batteryLevel : null;
  return validLevel(n) ? n : null;
}

function validLevel(n) {
  return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100;
}

function saveLevel(level, mac, source) {
  var changed = !last || last.level !== level || !sameAddress(last.mac, mac);
  last = { level: level, at: Date.now(), mac: mac, source: source };
  if (stateFile) {
    try {
      util.writeJsonAtomic(stateFile, {
        level: last.level, at: last.at, mac: last.mac, source: last.source, lowStrength: lowStrength
      });
    } catch (e) {}
  }
  if (changed && onLevel) onLevel(level);
}

/**
 * Reads the level once, unless a read is under way or the remote is not
 * connected. done gets the level, or null when there is none this time.
 * @param {function(?number): void} [done]
 */
function read(done) {
  done = done || function () {};
  if (!luna || busy) return done(null);
  busy = true;
  var clientId = null;
  // Whether the remote was connected to; until then nothing is put off.
  var tried = false;
  var identity = getRemoteInfo();
  var address = identity && identity.mac;
  var source = 'mrcu';

  function finish(level) {
    function end() {
      busy = false;
      if (tried) {
        dueAt = Date.now() + (level !== null ? HOUR_MS : RETRY_MS);
        attemptedMac = address;
      }
      var current = getRemoteInfo();
      if (current && current.mac && !sameAddress(current.mac, address)) level = null;
      if (level !== null) saveLevel(level, address, source);
      done(level);
    }
    // Always given back, whatever failed after connecting.
    if (clientId) luna(BT + '/gatt/disconnect', { clientId: clientId }, function () { end(); });
    else end();
  }

  function readDeviceInfo(onResult) {
    luna('com.webos.service.mrcu/getDeviceInfo', { subscribe: false, deviceName: 'MagicRemote_1' }, function (info) {
      if (address && info && info.bdAddress && info.bdAddress !== '00:00:00:00:00:00' &&
          !sameAddress(address, info.bdAddress)) return onResult(null);
      if (info && typeof info.lowStrength === 'boolean') {
        lowStrength = info.lowStrength;
      }
      if (info && typeof info.fwVer === 'string' && info.fwVer.length > 0 && info.fwVer !== '00.00.00.00.00.00.00.00.00.00.00') {
        firmware = info.fwVer;
      }
      var dl = deviceLevelFrom(info);
      if (dl !== null) {
        if (!address && info && typeof info.bdAddress === 'string' && info.bdAddress !== '00:00:00:00:00:00') {
          address = info.bdAddress;
        }
        return onResult(dl);
      }
      onResult(null);
    });
  }

  luna('com.webos.service.mrcu/getConnectionStatus', {}, function (st) {
    // Asked once, getConnectionStatus gives isBleRemocon false even with the
    // Magic Remote connected (B8 on 4.4, C2 on 9.2); only the subscription's
    // updates carry true. So this answer can confirm it, never clear it.
    if (st && typeof st.connected === 'boolean') connected = st.connected;
    if (st && st.isBleRemocon === true) isBle = true;
    if (!st || !st.returnValue || !st.connected || !isBle) return finish(null);
    // webOS 4 has the charge here (a B8's went from 49 to 63 with other
    // batteries), and its gatt/connect answers with no clientId to disconnect
    // by. Later webOS answer "-", and are read over Bluetooth.
    readDeviceInfo(function (dl) {
      if (dl !== null) {
        tried = true;
        return finish(dl);
      }
      if (!gattPlatformSupported()) {
        tried = true;
        return finish(null);
      }
      readGatt();
    });
  });

  function readGatt() {
    luna(BT + '/device/getStatus', {}, function (ds) {
      var device = remoteDevice(ds && ds.returnValue && ds.devices, address);
      if (!device) return finish(null);
      address = device.address;
      tried = true;
      if (!gattSupported(getTVModel(), webosVersion, device.name)) return finish(null);
      if (identity && identity.model && identity.model.toLowerCase() !== device.name.toLowerCase()) return finish(null);
      source = 'bluetooth';
      luna(BT + '/gatt/connect', { address: address }, function (c) {
        clientId = c && c.returnValue && c.clientId ? String(c.clientId) : null;
        if (!clientId) return finish(null);
        luna(BT + '/gatt/discoverServices', { address: address }, function (disc) {
          if (!disc || !disc.returnValue) return finish(null);
          setTimeout(function () {
            luna(BT + '/gatt/readCharacteristicValue', {
              clientId: clientId, service: BATTERY_SERVICE, characteristic: BATTERY_LEVEL
            }, function (r) { finish(levelFrom(r)); });
          }, discoverMs);
        });
      });
    });
  }
}

function due() {
  var remote = getRemoteInfo();
  var changed = remote && remote.mac && !sameAddress(remote.mac, attemptedMac || (last && last.mac));
  return (Date.now() >= dueAt || changed) && isOnFn();
}

// lginput2's connection status: a remote waking is the chance to read.
function connectionChanged(st) {
  if (st) {
    if (typeof st.connected === 'boolean') connected = st.connected;
    if (typeof st.isBleRemocon === 'boolean') isBle = st.isBleRemocon;
  }
  if (st && st.connected && st.isBleRemocon && due()) setTimeout(function () { if (due()) read(); }, settleMs);
}

// The TV has switched on: read at the remote's next wake.
function poweredOn() {
  dueAt = 0;
}

/**
 * Starts watching for the remote to wake.
 * @param {function(): boolean} isOn whether the TV is on; nothing is read in
 *   standby
 */
function start(isOn) {
  stop();
  isOnFn = isOn;
  dueAt = 0;
  connected = false;
  isBle = false;
  subscription = new lunaTransport.Subscription('com.webos.service.mrcu/getConnectionStatus',
    { subscribe: true }, null, { message: connectionChanged });
  subscription.start();
  timer = setInterval(function () { if (due()) read(); }, CHECK_MS);
  if (luna) {
    luna('com.webos.service.mrcu/getDeviceInfo', { subscribe: false, deviceName: 'MagicRemote_1' }, function (info) {
      if (info && typeof info.lowStrength === 'boolean') {
        lowStrength = info.lowStrength;
      }
      if (info && typeof info.fwVer === 'string' && info.fwVer.length > 0 && info.fwVer !== '00.00.00.00.00.00.00.00.00.00.00') {
        firmware = info.fwVer;
      }
      var remote = getRemoteInfo();
      if (level(remote && remote.mac) === null) {
        var dl = deviceLevelFrom(info);
        if (dl !== null) {
          var mac = (info && typeof info.bdAddress === 'string' && info.bdAddress !== '00:00:00:00:00:00') ? info.bdAddress : null;
          if (!remote || !remote.mac || sameAddress(remote.mac, mac)) saveLevel(dl, mac, 'mrcu');
        }
      }
    });
  }
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (subscription) { subscription.stop(); subscription = null; }
}

// The last level read, or null before one has been.
function level(mac) {
  if (!last) return null;
  if (mac && !sameAddress(mac, last.mac)) return null;
  return last.level;
}

function details(remote) {
  var available = level(remote && remote.mac) !== null;
  var supported = gattSupported(getTVModel(), webosVersion, remote && remote.model);
  return {
    batteryUpdatedAt: available && last ? last.at : null,
    batterySource: available && last ? last.source || null : null,
    batteryStatus: available ? 'available' : sameAddress(attemptedMac, remote && remote.mac)
      ? (supported ? 'unavailable' : 'unsupported') : 'waiting'
  };
}

/**
 * @param {Object} [opts]
 * @param {function(string, Object, function(any): void): void} [opts.luna]
 * @param {function(number): void} [opts.onLevel] called when the level changes
 * @param {number} [opts.discoverMs] the wait after discoverServices, for tests
 * @param {number} [opts.settleMs] the wait after the remote connects, for tests
 * @param {string} [opts.stateDir] where to save the last known level
 * @param {string} [opts.stateFile] override file path for tests
 * @param {?string} [opts.webosVersion] as the TV reports it
 * @param {function(): string} [opts.getTVModel]
 * @param {function(): Object} [opts.getRemoteInfo] current pairing identity
 */
function init(opts) {
  opts = opts || {};
  luna = opts.luna;
  discoverMs = opts.discoverMs !== undefined ? opts.discoverMs : DISCOVER_MS;
  settleMs = opts.settleMs !== undefined ? opts.settleMs : SETTLE_MS;
  webosVersion = String(opts.webosVersion || '');
  getTVModel = opts.getTVModel || function () { return ''; };
  getRemoteInfo = opts.getRemoteInfo || function () { return null; };
  attemptedMac = null;
  onLevel = opts.onLevel || null;
  busy = false;
  dueAt = 0;
  connected = false;
  isBle = false;
  lowStrength = null;
  firmware = null;
  isOnFn = function () { return true; };
  stateFile = opts.stateFile !== undefined ? opts.stateFile :
    (opts.stateDir ? path.join(opts.stateDir, 'remote-battery.json') : null);
  var saved = stateFile ? util.readJson(stateFile, null) : null;
  if (saved && validLevel(saved.level)) {
    var at = typeof saved.at === 'number' && isFinite(saved.at) && saved.at > 0 ? saved.at : null;
    last = { level: saved.level, at: at, mac: saved.mac || null, source: saved.source || null };
    if (typeof saved.lowStrength === 'boolean') lowStrength = saved.lowStrength;
  } else {
    last = null;
  }
}

module.exports = {
  init: init,
  start: start,
  stop: stop,
  read: read,
  poweredOn: poweredOn,
  connectionChanged: connectionChanged,
  level: level,
  details: details,
  gattSupported: gattSupported,
  connected: function () { return connected; },
  isBle: function () { return isBle; },
  signal: function () {
    if (lowStrength === null) return null;
    return lowStrength ? 'weak' : 'good';
  },
  lowStrength: function () { return lowStrength; },
  firmware: function () { return firmware; },
  remoteAddress: remoteAddress,
  levelFrom: levelFrom,
  deviceLevelFrom: deviceLevelFrom
};

