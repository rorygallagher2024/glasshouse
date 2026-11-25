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

// Only a selected private address and the LG speaker port can be contacted.
// A write rechecks the saved device identity and current limits on the very socket that sends it.
function request(target, change, cb, connect) {
  if (!target || !privateAddress(target.host)) return cb('address');
  var socket = (connect || net.connect)(9741, target.host);
  var pending = views.slice(), state = {}, buffer = util.allocBuffer(0), done = false;
  var writing = null, requested = null;
  var deadline = setTimeout(function () { finish(writing ? 'unconfirmed' : 'offline'); }, 4000);
  function finish(error, result) {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    socket.destroy();
    cb(error, result);
  }
  function send(command) { socket.write(frame(command)); }
  function result(rows) {
    var identity = state[product];
    return { host: target.host, id: identity.s_uuid, model: identity.s_model_name,
      name: state[speaker].s_user_name || identity.s_model_name, rows: rows };
  }
  function receive(message) {
    if (message.result && message.result !== 'ok') return finish(writing ? 'unconfirmed' : 'protocol');
    if (message.cmd !== 'notibyget') return;
    if (views.indexOf(message.msg) < 0 || !message.data || typeof message.data !== 'object') return;
    if (writing) {
      if (message.msg === writing.view) {
        if (message.data[writing.key] !== requested) return finish('unconfirmed');
        state[writing.view] = message.data;
        finish(null, result(controls(state)));
      }
      return;
    }
    var index = pending.indexOf(message.msg);
    if (index < 0) return;
    state[message.msg] = message.data;
    pending.splice(index, 1);
    if (pending.length) return;
    var identity = state[product];
    if (!/^(D?S90TR)$/i.test(identity.s_model_name) || typeof identity.s_uuid !== 'string' || !identity.s_uuid) return finish('model');
    if (target.id && target.id !== identity.s_uuid) return finish('identity');
    var rows = controls(state);
    if (!change) return finish(null, result(rows));
    var row = rows.filter(function (entry) { return entry.key === change.key; })[0];
    if (!target.id || !row || (requested = wireValue(row, change.value)) === null) return finish('invalid');
    if (row.value === change.value) return finish(null, result(rows));
    writing = row;
    var data = {};
    data[row.key] = requested;
    send({ cmd: 'set', msg: row.view, data: data });
    send({ cmd: 'get', msg: row.view });
  }
  socket.on('connect', function () {
    views.forEach(function (view) { send({ cmd: 'get', msg: view }); });
  });
  socket.on('data', function (chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (!done && buffer.length >= 5) {
        var size = buffer.readUInt32BE(1);
        if (buffer[0] !== 16 || !size || size > 65536 || size % 16) return finish('protocol');
        if (buffer.length < 5 + size) return;
        var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        var decoded = Buffer.concat([decipher.update(buffer.slice(5, size + 5)), decipher.final()]);
        buffer = buffer.slice(size + 5);
        receive(JSON.parse(decoded.toString('utf8')));
      }
    } catch (err) { finish('protocol'); }
  });
  socket.on('error', function () { finish(writing ? 'unconfirmed' : 'offline'); });
  socket.on('close', function () { finish(writing ? 'unconfirmed' : 'offline'); });
}

module.exports = { request: request };
