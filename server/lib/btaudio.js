/*
 * Paired Bluetooth audio devices (headphones, a soundbar), listed and
 * connected or disconnected from the Audio tab. Strict ES5 for node 0.10/0.12.
 *
 * LG's btaudiosrc service owns the TV-to-speaker link and routes the sound, so
 * it is used rather than the raw bluetooth2 A2DP calls. Only what the owner
 * chooses is sent: no discovery, pairing, unpairing, adapter power or reads
 * from the remote device, and nothing connects on its own.
 *
 * A request names a device by address only after a fresh getPairedDevices
 * lists it as an audio device in the state the action needs. The reply to
 * connect or disconnect is never taken as the outcome: the list is read again
 * and the state in it is reported.
 */
var say = require('./say');
var msg = say.msg;

var SERVICE = 'com.webos.service.btaudiosrc/';
var ADDRESS = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
// Wanted state in the fresh list, and the state the device must be in now.
var ACTIONS = {
  connect: { from: 'disconnected', to: 'connected' },
  disconnect: { from: 'connected', to: 'disconnected' }
};

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
    cb({ ok: true, available: true, devices: devices });
  });
}

/**
 * Connect or disconnect one paired audio device. cb(status, body).
 * @param {any} action
 * @param {any} address
 * @param {function(number, Object): void} cb
 */
function act(action, address, cb) {
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
    if (!device) {
      return finish(404, { ok: false, devices: devices, error: msg('srv.btaudio.notPaired', 'that device is not a paired Bluetooth audio device') });
    }
    if (device.state !== wanted.from) {
      return finish(409, { ok: false, devices: devices, error: action === 'connect'
        ? msg('srv.btaudio.notDisconnected', 'that device is not disconnected') : msg('srv.btaudio.notConnected', 'that device is not connected') });
    }
    luna(SERVICE + action, { address: device.address }, function (reply) {
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
