// LG Wi-Fi Speaker framing, also used by google/python-temescal.
var crypto = require('crypto');
var net = require('net');
var util = require('./util');
var key = util.toBuffer('T^&*J%^7tr~4^%^&I(o%^!jIJ__+a0 k', 'ascii');
var iv = util.toBuffer("'%^Ur7gy$~t+f)%@", 'ascii');
var product = 'PRODUCT_INFO', speaker = 'SPK_LIST_VIEW_INFO', settings = 'SETTING_VIEW_INFO';
var eq = 'EQ_VIEW_INFO', inputs = 'FUNC_VIEW_INFO';
var views = [product, speaker, settings, eq, inputs];

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

function integer(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

// Rows carry only settings for which the soundbar supplied a usable value and range.
function controls(state) {
  var rows = [];
  function add(group, field, row) {
    row.key = field;
    row.view = group;
    rows.push(row);
  }
  function choice(group, field, choices) {
    var value = state[group][field];
    if (integer(value) && Array.isArray(choices)) {
      var options = choices.filter(integer);
      if (options.length) add(group, field, { value: value, options: options });
    }
  }
  function number(group, field, min, max, offset, step) {
    var raw = state[group][field];
    if (!integer(raw) || !integer(min) || !integer(max) || min > max || max - min > 1000) return;
    var value = raw * step + offset;
    if (value >= min && value <= max) add(group, field, { value: value, min: min, max: max, offset: offset, step: step });
  }
  function toggle(group, field) {
    if (typeof state[group][field] === 'boolean') add(group, field, { value: state[group][field] });
  }
  number(speaker, 'i_vol', state[speaker].i_vol_min, state[speaker].i_vol_max, 0, 1);
  toggle(speaker, 'b_mute');
  choice(eq, 'i_curr_eq', state[eq].ai_eq_list);
  choice(inputs, 'i_curr_func', state[inputs].ai_func_list);
  if (state[settings].b_nighttime_enable !== false) toggle(settings, 'b_night_time');
  ['woofer', 'center', 'side', 'top', 'rear', 'dialog'].forEach(function (name) {
    if (name === 'dialog' && !state[settings].b_enable_dialog) return;
    var prefix = 'i_' + name;
    // Levels count up from zero on the wire, even when the displayed minimum is negative.
    number(settings, prefix + '_level', state[settings][prefix + '_min'], state[settings][prefix + '_max'], state[settings][prefix + '_min'], 1);
  });
  ['i_bass', 'i_middle', 'i_treble'].forEach(function (field) {
    number(eq, field, state[eq][field + '_min'], state[eq][field + '_max'], state[eq][field + '_min'], 1);
  });
  ['b_drc', 'b_auto_vol', 'b_auto_power', 'b_voice_feedback', 'b_neuralx'].forEach(function (field) { toggle(settings, field); });
  number(settings, 'i_av_sync', 0, 300, 0, 10);
  choice(settings, 'i_back_light', [0, 1, 2]);
  return rows;
}

function wireValue(row, value) {
  if (row.options) return row.options.indexOf(value) >= 0 ? value : null;
  if (typeof row.value === 'boolean') return typeof value === 'boolean' ? value : null;
  if (!integer(value) || value < row.min || value > row.max || (value - row.offset) % row.step) return null;
  return (value - row.offset) / row.step;
}

// Each selected bar has one socket shared by open dashboards, refreshes and writes.
var sessions = {};
function sessionFor(target, connect) {
  var name = JSON.stringify([target.host, target.id || '']);
  if (!connect && sessions[name]) return sessions[name];
  var socket = (connect || net.connect)(9741, target.host);
  var state = {}, listeners = [], readers = [], missing = views.slice();
  var closed = false, ready = false, writing = null, retry, monitor, lastSpeaker = 0, cycle = 0;
  var buffer = util.allocBuffer(0), previous = '';
  var deadline = setTimeout(function () { stop('offline'); }, 4000);
  function send(cmd, msg, data) { socket.write(frame({ cmd: cmd, msg: msg, data: data })); }
  function get(view) { send('get', view); }
  function snapshot() {
    return { host: target.host, id: state[product].s_uuid, model: state[product].s_model_name,
      name: state[speaker].s_user_name || state[product].s_model_name, rows: controls(state) };
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
    if (ready) cb(null, snapshot());
    if (!monitor) monitor = setInterval(function () {
      if (!ready) return;
      if (Date.now() - lastSpeaker > 8000) return stop('offline');
      // Some eARC volume steps do not produce an unsolicited speaker update.
      if (++cycle % 5 === 0) views.forEach(get);
      else get(speaker);
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
    if (message.result && message.result !== 'ok') {
      if (writing && writing.row.view === view) finishWrite('unconfirmed');
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (view === product && data.s_uuid && target.id && data.s_uuid !== target.id) return stop('identity');
    if (!state[view]) state[view] = {};
    Object.keys(data).forEach(function (field) {
      if (/^(i_|ai_|b_|s_)/.test(field)) state[view][field] = data[field];
    });
    if (view === speaker) lastSpeaker = Date.now();
    var index = missing.indexOf(view);
    if (index >= 0 && message.cmd === 'notibyget') missing.splice(index, 1);
    if (ready && writing && view === writing.row.view && data[writing.row.key] === writing.value) finishWrite(null);
    if (!missing.length && (!ready || readers.length)) {
      var identity = state[product];
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
  if (!connect) sessions[name] = session;
  socket.on('connect', function () { views.forEach(get); });
  socket.on('data', function (chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (!closed && buffer.length >= 5) {
        var size = buffer.readUInt32BE(1);
        if (buffer[0] !== 16 || !size || size > 65536 || size % 16) return stop('protocol');
        if (buffer.length < 5 + size) return;
        var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        var decoded = Buffer.concat([decipher.update(buffer.slice(5, size + 5)), decipher.final()]);
        buffer = buffer.slice(size + 5);
        receive(JSON.parse(decoded.toString('utf8')));
      }
    } catch (err) { stop('protocol'); }
  });
  socket.on('error', function () { stop('offline'); });
  socket.on('close', function () { stop('offline'); });
  return session;
}

function request(target, change, cb, connect) {
  if (!target || !privateAddress(target.host)) return cb('address');
  sessionFor(target, connect).read(change, cb);
}

function watch(target, cb, connect) {
  if (!target || !privateAddress(target.host) || !target.id) { cb('address'); return function () {}; }
  return sessionFor(target, connect).watch(cb);
}

function forget(target) {
  var session = sessions[JSON.stringify([target.host, target.id || ''])];
  if (session) session.stop('selection');
}

module.exports = { request: request, watch: watch, forget: forget };
