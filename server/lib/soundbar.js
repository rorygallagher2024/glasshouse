// LG Wi-Fi Speaker framing, also used by google/python-temescal.
var crypto = require('crypto');
var net = require('net');
var util = require('./util');
var key = util.toBuffer('T^&*J%^7tr~4^%^&I(o%^!jIJ__+a0 k', 'ascii');
var iv = util.toBuffer("'%^Ur7gy$~t+f)%@", 'ascii');
var productView = 'PRODUCT_INFO', speakerView = 'SPK_LIST_VIEW_INFO', settingsView = 'SETTING_VIEW_INFO';
var eqView = 'EQ_VIEW_INFO', inputsView = 'FUNC_VIEW_INFO';
var views = [productView, speakerView, settingsView, eqView, inputsView];
var connectTo = net.connect;

function init(options) {
  options = options || {};
  if (options.connect) connectTo = options.connect;
}

function privateAddress(host) {
  return typeof host === 'string' && net.isIPv4(host) &&
    /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
}

function frame(message) {
  var cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  var body = Buffer.concat([cipher.update(util.toBuffer(JSON.stringify(message), 'utf8')), cipher.final()]);
  var header = util.allocBuffer(5);
  header[0] = 16;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function decode(body) {
  try {
    var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    var message = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    return message && typeof message === 'object' ? message : null;
  } catch (err) {
    return null;
  }
}

function integer(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

// Rows carry only settings for which the soundbar supplied a usable value and range.
// A view the bar rejected is an empty object and adds no rows.
function controls(state) {
  var rows = [];
  function addRow(view, field, row) {
    row.key = field;
    row.view = view;
    rows.push(row);
  }
  function addChoiceRow(view, field, choices) {
    var value = state[view][field];
    if (integer(value) && Array.isArray(choices)) {
      var options = choices.filter(integer);
      if (options.length) addRow(view, field, { value: value, options: options });
    }
  }
  function addRangeRow(view, field, min, max, offset, step) {
    var raw = state[view][field];
    if (!integer(raw) || !integer(min) || !integer(max) || min > max || max - min > 1000) return;
    var value = raw * step + offset;
    if (value >= min && value <= max) addRow(view, field, { value: value, min: min, max: max, offset: offset, step: step });
  }
  function addToggleRow(view, field) {
    if (typeof state[view][field] === 'boolean') addRow(view, field, { value: state[view][field] });
  }
  var speaker = state[speakerView], settings = state[settingsView], eq = state[eqView];
  addRangeRow(speakerView, 'i_vol', speaker.i_vol_min, speaker.i_vol_max, 0, 1);
  addToggleRow(speakerView, 'b_mute');
  addChoiceRow(eqView, 'i_curr_eq', eq.ai_eq_list);
  addChoiceRow(inputsView, 'i_curr_func', state[inputsView].ai_func_list);
  if (settings.b_nighttime_enable !== false) addToggleRow(settingsView, 'b_night_time');
  ['woofer', 'center', 'side', 'top', 'rear', 'dialog'].forEach(function (name) {
    if (name === 'dialog' && !settings.b_enable_dialog) return;
    var prefix = 'i_' + name;
    // Levels count up from zero on the wire, even when the displayed minimum is negative.
    addRangeRow(settingsView, prefix + '_level', settings[prefix + '_min'], settings[prefix + '_max'], settings[prefix + '_min'], 1);
  });
  ['i_bass', 'i_middle', 'i_treble'].forEach(function (field) {
    addRangeRow(eqView, field, eq[field + '_min'], eq[field + '_max'], eq[field + '_min'], 1);
  });
  ['b_drc', 'b_auto_vol', 'b_auto_power', 'b_voice_feedback', 'b_neuralx'].forEach(function (field) { addToggleRow(settingsView, field); });
  addRangeRow(settingsView, 'i_av_sync', 0, 300, 0, 10);
  addChoiceRow(settingsView, 'i_back_light', [0, 1, 2]);
  return rows;
}

function wireValue(row, value) {
  if (row.options) return row.options.indexOf(value) >= 0 ? value : null;
  if (typeof row.value === 'boolean') return typeof value === 'boolean' ? value : null;
  if (!integer(value) || value < row.min || value > row.max || (value - row.offset) % row.step) return null;
  return (value - row.offset) / row.step;
}

function sessionName(target) { return JSON.stringify([target.host, target.id || '']); }

// Each selected bar has one socket shared by open dashboards, refreshes and writes.
var sessions = {};
function sessionFor(target) {
  var name = sessionName(target);
  if (sessions[name]) return sessions[name];
  var socket = connectTo(9741, target.host);
  var state = {}, listeners = [], readers = [], missing = views.slice();
  var closed = false, ready = false, writing = null, retry, monitor, lastReply = 0, cycle = 0;
  var buffer = util.allocBuffer(0), previous = '';
  var deadline = setTimeout(function () { stop('offline'); }, 4000);
  function send(cmd, msg, data) { socket.write(frame({ cmd: cmd, msg: msg, data: data })); }
  function get(view) { send('get', view); }
  function snapshot() {
    return { host: target.host, id: state[productView].s_uuid, model: state[productView].s_model_name,
      name: state[speakerView].s_user_name || state[productView].s_model_name, rows: controls(state) };
  }
  function release() {
    if (!listeners.length && !readers.length && !writing) stop();
  }
  function finishWrite(error) {
    var action = writing;
    writing = null;
    clearTimeout(retry);
    action.cb(error, ready && !closed ? snapshot() : null);
    release();
  }
  function stop(reason) {
    if (closed) return;
    closed = true;
    if (sessions[name] === session) delete sessions[name];
    clearTimeout(deadline);
    clearInterval(monitor);
    clearTimeout(retry);
    socket.destroy();
    if (writing) finishWrite(reason === 'identity' ? reason : 'unconfirmed');
    readers.splice(0).forEach(function (cb) { cb(reason || 'offline'); });
    listeners.splice(0).forEach(function (cb) { cb(reason || 'offline'); });
  }
  function publish() {
    if (!listeners.length) return;
    var current = snapshot(), signature = JSON.stringify(current);
    if (signature === previous) return;
    previous = signature;
    listeners.slice().forEach(function (cb) { cb(null, current); });
  }
  function apply(change, cb) {
    var row = controls(state).filter(function (entry) { return entry.key === change.key; })[0];
    var value = row && wireValue(row, change.value);
    if (!target.id || !row || value === null) return cb('invalid', snapshot());
    if (writing) return cb('busy');
    writing = { row: row, value: value, cb: cb };
    var data = {};
    data[row.key] = value;
    send('set', row.view, data);
    // The first read can still carry the old value. Re-read without sending the change twice.
    var attempts = 0;
    function confirm() {
      if (++attempts > 6) return finishWrite('unconfirmed');
      retry = setTimeout(confirm, 300);
      get(row.view);
    }
    confirm();
  }
  function read(change, cb) {
    function complete(error) {
      if (error) return cb(error);
      if (change) return apply(change, cb);
      cb(null, snapshot());
    }
    if (ready && change) return complete(null);
    readers.push(complete);
    if (ready && !missing.length) {
      missing = views.slice();
      deadline = setTimeout(function () { stop('offline'); }, 4000);
      views.forEach(get);
    }
  }
  function watch(cb) {
    listeners.push(cb);
    if (ready) {
      var current = snapshot();
      // Listeners already open have this state, so the next poll must not send it again.
      previous = JSON.stringify(current);
      cb(null, current);
    }
    if (!monitor) monitor = setInterval(function () {
      if (!ready) return;
      if (Date.now() - lastReply > 8000) return stop('offline');
      // Some eARC volume steps do not produce an unsolicited speaker update.
      if (++cycle % 5 === 0) views.forEach(get);
      else get(speakerView);
    }, 1500);
    return function () {
      var idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
      if (!listeners.length) { clearInterval(monitor); monitor = null; }
      release();
    };
  }
  function receive(message) {
    var view = message.msg, data = message.data;
    if (views.indexOf(view) < 0 || !/^noti/.test(message.cmd)) return;
    lastReply = Date.now();
    var failed = message.result && message.result !== 'ok';
    if (failed && writing && writing.row.view === view) finishWrite('unconfirmed');
    if (closed || (!failed && (!data || typeof data !== 'object'))) return;
    // A compatible bar can reject a view the DS90TR has. Loading goes on without its rows.
    if (!state[view]) state[view] = {};
    if (!failed) {
      if (view === productView && data.s_uuid && target.id && data.s_uuid !== target.id) return stop('identity');
      Object.keys(data).forEach(function (field) {
        if (/^(i_|ai_|b_|s_)/.test(field)) state[view][field] = data[field];
      });
    }
    var index = missing.indexOf(view);
    if (index >= 0 && message.cmd === 'notibyget') missing.splice(index, 1);
    if (!failed && ready && writing && view === writing.row.view && data[writing.row.key] === writing.value) finishWrite(null);
    if (closed) return;
    if (!missing.length && (!ready || readers.length)) {
      var identity = state[productView];
      if (typeof identity.s_model_name !== 'string' || !identity.s_model_name.trim() ||
          typeof identity.s_uuid !== 'string' || !identity.s_uuid.trim()) return stop('model');
      if (target.id && target.id !== identity.s_uuid) return stop('identity');
      ready = true;
      clearTimeout(deadline);
      readers.splice(0).forEach(function (cb) { cb(null); });
      release();
    }
    if (ready) publish();
  }
  var session = { read: read, watch: watch, stop: stop };
  sessions[name] = session;
  socket.on('connect', function () { views.forEach(get); });
  socket.on('data', function (chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (!closed && buffer.length >= 5) {
      var size = buffer.readUInt32BE(1);
      if (buffer[0] !== 16 || !size || size > 65536 || size % 16) return stop('protocol');
      if (buffer.length < 5 + size) return;
      var message = decode(buffer.slice(5, size + 5));
      buffer = buffer.slice(size + 5);
      if (!message) return stop('protocol');
      // Outside the decoder's error handling: a dashboard callback that throws is
      // its own bug, not a fault of the bar shared by every open panel.
      receive(message);
    }
  });
  socket.on('error', function () { stop('offline'); });
  socket.on('close', function () { stop('offline'); });
  return session;
}

function request(target, change, cb) {
  if (!target || !privateAddress(target.host)) return cb('address');
  sessionFor(target).read(change, cb);
}

function watch(target, cb) {
  if (!target || !privateAddress(target.host) || !target.id) { cb('address'); return function () {}; }
  return sessionFor(target).watch(cb);
}

function forget(target) {
  var session = sessions[sessionName(target)];
  if (session) session.stop('selection');
}

module.exports = { init: init, request: request, watch: watch, forget: forget };
