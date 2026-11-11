/*
 * Pointer events through LG's network-input socket. Strict ES5.
 * The socket carries the same text commands as LG's phone remote, framed by
 * its transport: WebSocket messages or a 32-bit big-endian length on Unix.
 */
var net = require('net');
var http = require('http');
var crypto = require('crypto');
var allocBuffer = require('./util').allocBuffer;

var lunaFn = null;
var connectFn = null;
var socket = null;
var socketIsWebSocket = false;
var connecting = false;
var waiters = [];

var MAX_MOVES = 120;
var MAX_DELTA = 10000;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  connectFn = opts.connect || null;
}

function isSupported() {
  return typeof lunaFn === 'function';
}

function validDelta(value) {
  return typeof value === 'number' && isFinite(value) &&
    Math.floor(value) === value && Math.abs(value) <= MAX_DELTA;
}

function validPair(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    validDelta(value.dx) && validDelta(value.dy);
}

function commandsFor(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'a JSON object is required' };
  var moves = body.move === undefined ? [] : body.move;
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) return { error: 'move must be an array of at most ' + MAX_MOVES + ' events' };
  var commands = [];
  for (var i = 0; i < moves.length; i++) {
    if (!validPair(moves[i])) return { error: 'each move needs integer dx and dy between -' + MAX_DELTA + ' and ' + MAX_DELTA };
    var down = moves[i].down === true ? 'drag' : '0';
    if (moves[i].down !== undefined && moves[i].down !== false && moves[i].down !== true) return { error: 'move.down must be boolean' };
    commands.push('type:move\ndx:' + moves[i].dx + '\ndy:' + moves[i].dy + '\ndown:' + down + '\n\n');
  }
  if (body.click !== undefined && body.click !== true && body.click !== false) return { error: 'click must be boolean' };
  if (body.down !== undefined && typeof body.down !== 'boolean') return { error: 'down must be boolean' };
  if (body.up !== undefined && typeof body.up !== 'boolean') return { error: 'up must be boolean' };
  if (body.click) commands.push('type:click\n\n');
  if (body.down) commands.push('type:move\ndx:0\ndy:0\ndown:drag\n\n');
  if (body.up) commands.push('type:move\ndx:0\ndy:0\ndown:0\n\n');
  if (body.scroll !== undefined) {
    if (!validPair(body.scroll)) return { error: 'scroll needs integer dx and dy between -' + MAX_DELTA + ' and ' + MAX_DELTA };
    commands.push('type:scroll\ndx:' + body.scroll.dx + '\ndy:' + body.scroll.dy + '\n\n');
  }
  if (!commands.length) return { error: 'no pointer events' };
  return { commands: commands };
}

function closeSocket() {
  socketIsWebSocket = false;
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
}

function failWaiters(error) {
  var pending = waiters;
  waiters = [];
  connecting = false;
  for (var i = 0; i < pending.length; i++) pending[i](error);
}

function connectSocket(socketPath, cb) {
  if (connectFn) return connectFn(socketPath, cb);
  if (/^wss?:\/\//.test(socketPath)) return connectWebSocket(socketPath, cb);
  var client = net.connect(socketPath);
  client.once('connect', function () { cb(null, client); });
  client.once('error', cb);
}

function bufferFromString(text) {
  var buffer = allocBuffer(Buffer.byteLength(text, 'utf8'));
  buffer.write(text, 0, buffer.length, 'utf8');
  return buffer;
}

function encodeWebSocketFrame(payload) {
  var length = payload.length;
  var headerLength = length < 126 ? 2 : 4;
  var frame = allocBuffer(headerLength + 4 + length);
  var mask = crypto.randomBytes(4);
  frame[0] = 0x81;
  if (length < 126) frame[1] = 0x80 | length;
  else {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  }
  mask.copy(frame, headerLength);
  for (var i = 0; i < length; i++) frame[headerLength + 4 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

function connectWebSocket(address, cb) {
  var target = /^ws:\/\/([^\/]+)(\/.*)$/.exec(address);
  if (!target) return cb(new Error('LG returned an unsupported pointer socket address'));
  var req = http.request({
    host: target[1].split(':')[0], port: target[1].split(':')[1] || 80, path: target[2], agent: false,
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }
  });
  req.on('upgrade', function (res, upgraded) {
    socketIsWebSocket = true;
    cb(null, upgraded);
  });
  req.on('response', function (res) {
    res.resume();
    cb(new Error('pointer socket refused the connection (' + res.statusCode + ')'));
  });
  req.on('error', cb);
  req.end();
}

function writeCommands(commands, cb) {
  var unixBuffer = null;
  if (!socketIsWebSocket) {
    var parts = [];
    for (var i = 0; i < commands.length; i++) {
      var payload = bufferFromString(commands[i]);
      var header = allocBuffer(4);
      header.writeUInt32BE(payload.length, 0);
      parts.push(header, payload);
    }
    unixBuffer = Buffer.concat(parts);
  }
  if (unixBuffer) return socket.write(unixBuffer, cb);
  for (var j = 0; j < commands.length - 1; j++) {
    socket.write(encodeWebSocketFrame(bufferFromString(commands[j])));
  }
  socket.write(encodeWebSocketFrame(bufferFromString(commands[commands.length - 1])), cb);
}

function send(body, cb) {
  var checked = commandsFor(body);
  if (checked.error) return cb({ ok: false, error: checked.error });
  if (!isSupported()) return cb({ ok: false, error: 'pointer input is unavailable' });
  if (socket) return writeCommands(checked.commands, function (err) {
    if (err) closeSocket();
    cb(err ? { ok: false, error: err.message } : { ok: true, count: checked.commands.length });
  });
  waiters.push(function (err) {
    if (err) return cb({ ok: false, error: err.message });
    send(body, cb);
  });
  if (connecting) return;
  connecting = true;
  lunaFn('com.webos.service.networkinput/getPointerInputSocket', {}, function (reply) {
    if (!reply || reply.returnValue !== true || typeof reply.socketPath !== 'string' || !reply.socketPath) {
      return failWaiters(new Error(reply && reply.errorText || 'the TV did not provide a pointer socket'));
    }
    connectSocket(reply.socketPath, function (err, connected) {
      if (err) return failWaiters(err);
      socket = connected;
      socket.on('error', function () { closeSocket(); });
      socket.on('close', function () { if (socket === connected) socket = null; });
      failWaiters(null);
    });
  });
}

function stop() {
  closeSocket();
  failWaiters(new Error('pointer input stopped'));
}

module.exports = {
  MAX_MOVES: MAX_MOVES,
  commandsFor: commandsFor,
  init: init,
  isSupported: isSupported,
  send: send,
  stop: stop
};
