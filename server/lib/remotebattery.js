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
 * once v0.97.0 began reading. Elsewhere only LG's remote service is asked.
 */
var gattTested = false;

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

function remoteAddress(devices) {
  for (var i = 0; i < (devices || []).length; i++) {
    var d = devices[i];
    if (d && d.paired && d.typeOfDevice === 'ble' && /^LGE MR/i.test(d.name || '')) return d.address;
  }
  return null;
}

function levelFrom(r) {
  var bytes = r && r.returnValue && r.value && r.value.value && r.value.value.bytes;
  var n = bytes && bytes.length ? bytes[0] : null;
  return typeof n === 'number' && n >= 0 && n <= 100 ? n : null;
}

function deviceLevelFrom(info) {
  var n = info && info.returnValue ? info.batteryLevel : null;

  if (typeof n === 'number' && n >= 0 && n <= 100) {
    return n;
  }

  if (typeof n === 'string') {
    switch (n.toUpperCase()) {
      case 'HIGH':
        return 100;
      case 'MID':
        return 50;
      case 'LOW':
        return 10;
    }
  }

  return null;
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
  var address = null;

  function finish(level) {
    function end() {
      busy = false;
      if (tried) dueAt = Date.now() + (level !== null ? HOUR_MS : RETRY_MS);
      if (level !== null) {
        var changed = !last || last.level !== level;
        last = { level: level, at: Date.now(), mac: address };
        if (stateFile) {
          try {
            util.writeJsonAtomic(stateFile, {
              level: last.level,
              at: last.at,
              mac: last.mac,
              lowStrength: lowStrength
            });
          } catch (e) {}
        }
        if (changed && onLevel) onLevel(level);
      }
      done(level);
    }
    // Always given back, whatever failed after connecting.
    if (clientId) luna(BT + '/gatt/disconnect', { clientId: clientId }, function () { end(); });
    else end();
  }

  function fallbackDeviceInfo(onFallback) {
    luna('com.webos.service.mrcu/getDeviceInfo', { subscribe: false, deviceName: 'MagicRemote_1' }, function (info) {
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
        return onFallback(dl);
      }
      onFallback(null);
    });
  }

  luna('com.webos.service.mrcu/getConnectionStatus', {}, function (st) {
    // Asked once, getConnectionStatus gives isBleRemocon false even with the
    // Magic Remote connected (B8 on 4.4, C2 on 9.2); only the subscription's
    // updates carry true. So this answer can confirm it, never clear it.
    if (st && typeof st.connected === 'boolean') connected = st.connected;
    if (st && st.isBleRemocon === true) isBle = true;
    if (!st || !st.connected || !isBle) return finish(null);
    // webOS 4 has the charge here (a B8's went from 49 to 63 with other
    // batteries), and its gatt/connect answers with no clientId to disconnect
    // by. Later webOS answer "-", and are read over Bluetooth.
    fallbackDeviceInfo(function (dl) {
      if (dl !== null) {
        tried = true;
        return finish(dl);
      }
      if (!gattTested) {
        tried = true;
        return finish(null);
      }
      readGatt();
    });
  });

  function readGatt() {
    luna(BT + '/device/getStatus', {}, function (ds) {
      address = remoteAddress(ds && ds.devices);
      if (!address) return finish(null);
      tried = true;
      luna(BT + '/gatt/connect', { address: address }, function (c) {
        clientId = c && c.returnValue && c.clientId ? String(c.clientId) : null;
        if (!clientId) return finish(null);
        luna(BT + '/gatt/discoverServices', { address: address }, function (disc) {
          if (disc && disc.returnValue === false) return finish(null);
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
  return Date.now() >= dueAt && isOnFn();
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
      if (!last) {
        var dl = deviceLevelFrom(info);
        if (dl !== null) {
          var mac = (info && typeof info.bdAddress === 'string' && info.bdAddress !== '00:00:00:00:00:00') ? info.bdAddress : null;
          last = { level: dl, at: Date.now(), mac: mac };
          if (stateFile) {
            try {
              util.writeJsonAtomic(stateFile, {
                level: last.level,
                at: last.at,
                mac: last.mac,
                lowStrength: lowStrength
              });
            } catch (e) {}
          }
          if (onLevel) onLevel(dl);
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
  if (mac && last.mac && mac.toLowerCase() !== last.mac.toLowerCase()) return null;
  return last.level;
}

/**
 * @param {Object} [opts]
 * @param {function(string, Object, function(any): void): void} [opts.luna]
 * @param {function(number): void} [opts.onLevel] called when the level changes
 * @param {number} [opts.discoverMs] the wait after discoverServices, for tests
 * @param {number} [opts.settleMs] the wait after the remote connects, for tests
 * @param {string} [opts.stateDir] where to save the last known level
 * @param {string} [opts.stateFile] override file path for tests
 * @param {?string} [opts.webosVersion] as the TV reports it; Bluetooth is read only on 9 and 10
 */
function init(opts) {
  opts = opts || {};
  luna = opts.luna;
  discoverMs = opts.discoverMs !== undefined ? opts.discoverMs : DISCOVER_MS;
  settleMs = opts.settleMs !== undefined ? opts.settleMs : SETTLE_MS;
  gattTested = /^(9|10)\./.test(String(opts.webosVersion || ''));
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
  if (saved && typeof saved.level === 'number' && saved.level >= 0 && saved.level <= 100) {
    last = { level: saved.level, at: saved.at || Date.now(), mac: saved.mac || null };
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

