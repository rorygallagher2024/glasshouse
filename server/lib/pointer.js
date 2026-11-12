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
var hasServiceFn = null;
var authedFn = null;
var connectFn = null;
var config = {};
var clients = [];
var socket = null;
var socketIsWebSocket = false;
var connecting = false;
var waiters = [];
var idleTimer = null;
var IDLE_CLOSE_MS = 5000;
var RETRY_COOLDOWN_MS = 5000;
var MAX_MOVES = 120;
var MAX_DELTA = 10000;

var retryAfter = 0;
var retryMs = RETRY_COOLDOWN_MS;
var lastError = '';
var nowFn = Date.now;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  hasServiceFn = opts.hasService || null;
  authedFn = opts.authed || null;
  connectFn = opts.connect || null;
  config = opts.config || {};
  retryMs = typeof opts.retryMs === 'number' ? opts.retryMs : RETRY_COOLDOWN_MS;
  nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  retryAfter = 0;
  lastError = '';
}

function isSupported() {
  return typeof lunaFn === 'function' &&
    (!hasServiceFn || hasServiceFn('com.webos.service.networkinput'));
}

function isEnabled() {
  return !!(config.pointer && config.pointer.enabled) && isSupported();
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
  clearTimeout(idleTimer);
  idleTimer = null;
  socketIsWebSocket = false;
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
}

function closeAfterIdle() {
  clearTimeout(idleTimer);
  if (clients.length) return;
  idleTimer = setTimeout(closeSocket, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function failWaiters(error) {
  if (error) {
    lastError = error.message || 'pointer input failed';
    retryAfter = nowFn() + retryMs;
    if (waiters.length) console.error('pointer: ' + lastError);
  } else {
    lastError = '';
    retryAfter = 0;
  }
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
  if (!isEnabled()) return cb({ ok: false, error: 'pointer input is unavailable' });
  if (socket) return writeCommands(checked.commands, function (err) {
    if (err) {
      console.error('pointer: socket write failed: ' + err.message);
      closeSocket();
    } else closeAfterIdle();
    cb(err ? { ok: false, error: err.message } : { ok: true, count: checked.commands.length });
  });
  if (!connecting && nowFn() < retryAfter) {
    return cb({ ok: false, error: lastError || 'pointer input is temporarily unavailable' });
  }
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
      console.log('pointer: connected to LG network input (' + (socketIsWebSocket ? 'WebSocket' : 'Unix socket') + ')');
      socket.on('error', function (socketError) {
        console.error('pointer: socket error: ' + socketError.message);
        closeSocket();
      });
      socket.on('close', function () { if (socket === connected) socket = null; });
      failWaiters(null);
    });
  });
}

function serverFrame(payload) {
  var body = bufferFromString(payload);
  var headerLength = body.length < 126 ? 2 : 4;
  var frame = allocBuffer(headerLength + body.length);
  frame[0] = 0x81;
  if (body.length < 126) frame[1] = body.length;
  else {
    frame[1] = 126;
    frame.writeUInt16BE(body.length, 2);
  }
  body.copy(frame, headerLength);
  return frame;
}

function refuseUpgrade(socket, status) {
  socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function handleUpgrade(req, client, head) {
  var pathname = String(req.url || '').split('?')[0];
  if (pathname !== '/api/pointer') return false;
  if (!isEnabled()) return refuseUpgrade(client, '404 Not Found'), true;
  if (!authedFn || !authedFn(req)) return refuseUpgrade(client, '401 Unauthorized'), true;
  if (!config.allowControl) return refuseUpgrade(client, '403 Forbidden'), true;
  var origin = String(req.headers.origin || '');
  if (origin && origin.replace(/^https?:\/\//, '') !== String(req.headers.host || '')) {
    return refuseUpgrade(client, '403 Forbidden'), true;
  }
  var key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade !== 'websocket' || typeof key !== 'string') {
    return refuseUpgrade(client, '400 Bad Request'), true;
  }
  var accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  client.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  clients.push(client);
  client.on('close', function () {
    var index = clients.indexOf(client);
    if (index !== -1) clients.splice(index, 1);
    if (!clients.length) closeSocket();
  });
  var buffered = Buffer.isBuffer(head) && head.length ? head : allocBuffer(0);
  client.on('data', function (chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      var finalFrame = (buffered[0] & 0x80) !== 0;
      var opcode = buffered[0] & 0x0f;
      var masked = (buffered[1] & 0x80) !== 0;
      var length = buffered[1] & 0x7f;
      var offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) return client.destroy();
      if (length > 65536 || !finalFrame || !masked) return client.destroy();
      if (masked) offset += 4;
      if (buffered.length < offset + length) return;
      var mask = masked ? buffered.slice(offset - 4, offset) : null;
      var payload = allocBuffer(length);
      buffered.copy(payload, 0, offset, offset + length);
      for (var i = 0; i < length; i++) payload[i] ^= mask[i % 4];
      buffered = buffered.slice(offset + length);
      if (opcode === 8) return client.end();
      if (opcode === 1) {
        var body = null;
        try { body = JSON.parse(payload.toString('utf8')); } catch (e) {}
        send(body, function (result) {
          if (!result.ok) client.write(serverFrame(JSON.stringify(result)));
        });
      }
    }
  });
  client.on('error', function () { client.destroy(); });
  return true;
}

function stop() {
  while (clients.length) clients.shift().destroy();
  closeSocket();
  failWaiters(new Error('pointer input stopped'));
  retryAfter = 0;
  lastError = '';
}

module.exports = {
  MAX_MOVES: MAX_MOVES,
  commandsFor: commandsFor,
  init: init,
  isSupported: isSupported,
  isEnabled: isEnabled,
  send: send,
  handleUpgrade: handleUpgrade,
  stop: stop
};
