/*
 * Paired Bluetooth audio devices (headphones, a soundbar), listed and
 * connected or disconnected from the Audio tab. Strict ES5 for node 0.10/0.12.
 *
 * LG's btaudiosrc service owns the TV-to-speaker link and routes the sound, so
 * it is used rather than the raw bluetooth2 A2DP calls. Only what the owner
 * chooses is sent: a scan for new devices when asked, and nothing connects or
 * pairs on its own. No unpairing, adapter power or reads from the remote device.
 *
 * Pairing is btaudiosrc's connect on a device its scan found: it pairs, then
 * connects, as LG's own device selection does (webOS 4.4.3 and 9.2.2).
 *
 * A request names a device by address only after a fresh getPairedDevices
 * lists it as an audio device in the state the action needs. The reply to
 * connect or disconnect is never taken as the outcome: the list is read again
 * and the state in it is reported.
 */
var lunaModule = require('./luna');
var say = require('./say');
var msg = say.msg;

var SERVICE = 'com.webos.service.btaudiosrc/';
var ADDRESS = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
// Wanted state in the fresh list, and the state the device must be in now.
var ACTIONS = {
  connect: { from: 'disconnected', to: 'connected' },
  disconnect: { from: 'connected', to: 'disconnected' },
  pair: { from: null, to: 'connected' }
};
// LG's scan runs up to 90 s; a speaker in pairing mode answered within a few.
var SCAN_MS = 20000;
var scan = { running: false, found: [], error: '', sub: null, timer: null };

/** @type {function(string, Object, function(any): void): void} */
var luna = null;
var clearLunaCache = null;
var actionRunning = false;
var pendingAction = null;
var SETTLE_WAIT_MS = 15000;

/**
 * Only the three fields the page shows leave this module; anything else the
 * service reports about a device is dropped.
 * @param {any} reply
 * @returns {Array<{address: string, name: string, state: string}>}
 */
function audioDevices(reply) {
  var out = [];
  var list = reply && Array.isArray(reply.devices) ? reply.devices : [];
  list.forEach(function (d) {
    if (!d || d.type !== 'bt_audio' || typeof d.address !== 'string' || !ADDRESS.test(d.address)) return;
    var name = typeof d.name === 'string' ? d.name.slice(0, 64) : '';
    var state = typeof d.state === 'string' && /^[a-z_]{1,24}$/.test(d.state) ? d.state : 'unknown';
    out.push({ address: d.address.toLowerCase(), name: name, state: state });
  });
  return out;
}

/**
 * cb(kind, devices): kind is 'ok', 'unavailable' (this TV has no such
 * service) or 'failed'.
 * @param {function(string, Array<{address: string, name: string, state: string}>): void} cb
 */
function readPaired(cb) {
  luna(SERVICE + 'getPairedDevices', {}, function (r) {
    if (r && r.returnValue === true && Array.isArray(r.devices)) {
      var devices = audioDevices(r);
      if (pendingAction && (Date.now() >= pendingAction.until || devices.some(function (d) {
        return d.address === pendingAction.address && d.state === pendingAction.state;
      }))) pendingAction = null;
      return cb('ok', devices);
    }
    var text = r && typeof r.errorText === 'string' ? r.errorText : '';
    if (/Service does not exist|Unknown method/i.test(text)) return cb('unavailable', []);
    cb('failed', []);
  });
}

function cleanName(name) {
  return typeof name === 'string' ? name.slice(0, 64) : '';
}

function finishScan() {
  if (!scan.running) return;
  scan.running = false;
  clearTimeout(scan.timer);
  scan.timer = null;
  if (scan.sub) {
    scan.sub.stop();
    scan.sub = null;
  }
  luna(SERVICE + 'cancelDiscovery', {}, function () {});
}

/*
 * Each answer names one device it heard: { state, device: { address, name,
 * type } }. The first answer is { returnValue, timeOut } and names none.
 */
function startScan() {
  if (scan.running) return;
  scan.running = true;
  scan.found = [];
  scan.error = '';
  scan.sub = new lunaModule.Subscription(SERVICE + 'startDiscovery', { subscribe: true }, null, {
    message: function (r) {
      if (r && r.returnValue === false) {
        scan.error = typeof r.errorText === 'string' ? r.errorText : '';
        return finishScan();
      }
      var d = r && r.device;
      if (!d || d.type !== 'bt_audio' || typeof d.address !== 'string' || !ADDRESS.test(d.address)) return;
      var address = d.address.toLowerCase();
      var known = scan.found.filter(function (f) { return f.address === address; })[0];
      if (known) known.name = cleanName(d.name) || known.name;
      else scan.found.push({ address: address, name: cleanName(d.name) });
    },
    close: finishScan
  });
  scan.sub.start();
  scan.timer = setTimeout(finishScan, SCAN_MS);
}

// What the scan found that is not paired already.
function scanStatus(paired) {
  return {
    running: scan.running,
    error: scan.error,
    found: scan.found.filter(function (f) {
      return !paired.some(function (d) { return d.address === f.address; });
    })
  };
}

/**
 * The paired list for the Audio tab. A TV without the service says so.
 * @param {function(Object): void} cb
 */
function list(cb) {
  readPaired(function (kind, devices) {
    if (kind === 'unavailable') return cb({ ok: true, available: false, devices: [] });
    if (kind === 'failed') {
      return cb({ ok: false, error: msg('srv.btaudio.readFailed', 'the TV did not report its paired Bluetooth audio devices') });
    }
    cb({ ok: true, available: true, devices: devices, scan: scanStatus(devices) });
  });
}

/**
 * Connect or disconnect one paired audio device. cb(status, body).
 * @param {any} action
 * @param {any} address
 * @param {function(number, Object): void} cb
 */
function act(action, address, cb) {
  if (action === 'scan') {
    startScan();
    return readPaired(function (kind, devices) {
      cb(202, { ok: true, devices: devices, scan: scanStatus(devices) });
    });
  }
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return cb(400, { ok: false, error: 'unknown action' });
  }
  if (typeof address !== 'string' || !ADDRESS.test(address)) {
    return cb(400, { ok: false, error: 'bad device address' });
  }
  if (actionRunning) {
    return cb(409, { ok: false, error: msg('srv.btaudio.busy', 'another Bluetooth request is still running') });
  }
  actionRunning = true;
  function finish(status, body) {
    actionRunning = false;
    cb(status, body);
  }
  var wanted = ACTIONS[action];
  var target = address.toLowerCase();
  readPaired(function (kind, devices) {
    if (kind !== 'ok') {
      return finish(502, { ok: false, error: msg('srv.btaudio.readFailed', 'the TV did not report its paired Bluetooth audio devices') });
    }
    if (pendingAction) {
      return finish(409, { ok: false, devices: devices, error: msg('srv.btaudio.pending',
        'the previous connection request is not confirmed yet; wait and refresh before trying again') });
    }
    var device = devices.filter(function (d) { return d.address === target; })[0];
    if (action === 'pair') {
      if (device) {
        return finish(409, { ok: false, devices: devices, error: msg('srv.btaudio.alreadyPaired', 'that device is paired already') });
      }
      device = scan.found.filter(function (f) { return f.address === target; })[0];
      if (!device) {
        return finish(404, { ok: false, devices: devices, error: msg('srv.btaudio.notFound', 'that device was not found by the last scan; scan again') });
      }
      finishScan();
    } else if (!device) {
      return finish(404, { ok: false, devices: devices, error: msg('srv.btaudio.notPaired', 'that device is not a paired Bluetooth audio device') });
    }
    if (wanted.from && device.state !== wanted.from) {
      return finish(409, { ok: false, devices: devices, error: action === 'connect'
        ? msg('srv.btaudio.notDisconnected', 'that device is not disconnected') : msg('srv.btaudio.notConnected', 'that device is not connected') });
    }
    luna(SERVICE + (action === 'pair' ? 'connect' : action), { address: device.address }, function (reply) {
      var accepted = !!reply && reply.returnValue === true;
      var refused = reply && typeof reply.errorText === 'string' ? reply.errorText : '';
      if (clearLunaCache) clearLunaCache();
      // The state read back is the outcome, whatever the reply said.
      readPaired(function (readKind, after) {
        var unknown = !reply || (reply.returnValue !== true && reply.returnValue !== false && !refused);
        var body = { ok: accepted, accepted: accepted, devices: readKind === 'ok' ? after : devices, settled: false };
        if (readKind === 'ok') {
          after.forEach(function (d) { if (d.address === target) body.settled = d.state === wanted.to; });
        }
        if (unknown) body.ok = true;  // A missing answer is not a refusal or proof of connection.
        body.pending = body.ok && !body.settled;
        if (body.pending) pendingAction = { address: target, state: wanted.to, until: Date.now() + SETTLE_WAIT_MS };
        if (!body.ok) {
          body.error = refused
            ? msg('srv.btaudio.refused', 'the TV refused the request: {error}', { error: refused })
            : msg('srv.btaudio.noAnswer', 'the TV did not confirm the request; refresh to see the current state');
        }
        finish(body.ok ? (body.pending ? 202 : 200) : 502, body);
      });
    });
  });
}

function init(opts) {
  luna = opts.luna;
  clearLunaCache = opts.clearLunaCache || null;
}

module.exports = { init: init, list: list, act: act };
