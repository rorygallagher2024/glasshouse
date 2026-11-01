// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
/*
 * Where the dashboard's keyboard box types when LG's input method has no field
 * to type into. controls.js decides the route; this file holds what each route
 * needs: key presses on the TV's network input, and a web app's page through
 * the web app debugger. docs/IMPLEMENTATION.md has the routing and
 * docs/development/TV-RESEARCH.md what was measured.
 */
var http = require('http');
var crypto = require('crypto');
var allocBuffer = require('./util').allocBuffer;
var msg = require('./say').msg;

// ------------------------------------------------------------- key presses

// The key presses go one call at a time: the text and the backspaces ahead of it.
var SEND_KEYS_MAX = 50;
var KEY_BACKSPACE = 14;

/*
 * Linux evdev codes, as the remote's keys in controls.js. A code carries no
 * modifier, so there is no shift: a capital goes out as its lowercase letter,
 * and only the unshifted symbols are here.
 */
var KEY_CODES_BY_CHARACTER = (function () {
  var codes = { ' ': 57, '-': 12, '=': 13, '[': 26, ']': 27, ';': 39, '\'': 40,
                '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53 };
  var rowKeys = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  var rowFirstCode = [2, 16, 30, 44];
  for (var row = 0; row < rowKeys.length; row++) {
    for (var col = 0; col < rowKeys[row].length; col++) codes[rowKeys[row].charAt(col)] = rowFirstCode[row] + col;
  }
  return codes;
})();

/*
 * The evdev codes for deleting `replace` characters and typing `text`, or an
 * error: the whole request is checked before the first key goes, so a
 * character that has no key sends nothing.
 */
function keyCodesFor(text, replace) {
  if (text.length + replace > SEND_KEYS_MAX) {
    return { error: msg('srv.typing.keysTooLong', 'at most {max} key presses at a time', { max: SEND_KEYS_MAX }) };
  }
  var codes = [];
  for (var bs = 0; bs < replace; bs++) codes.push(KEY_BACKSPACE);
  for (var i = 0; i < text.length; i++) {
    var lower = text.charAt(i).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(KEY_CODES_BY_CHARACTER, lower)) {
      return { error: msg('srv.typing.noKey', 'there is no key press for \u201c{character}\u201d', { character: text.charAt(i) }) };
    }
    codes.push(KEY_CODES_BY_CHARACTER[lower]);
  }
  return { codes: codes };
}

// ------------------------------------------------------------- local HTTP

var LOCAL_HTTP_TIMEOUT_MS = 3000;

// GET on this TV; cb(error message or null, status, body).
function localGet(port, path, cb) {
  var done = false;
  var finish = function (error, status, body) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(error, status, body);
  };
  var req = http.get({ host: '127.0.0.1', port: port, path: path, agent: false }, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (chunk) { if (body.length < 65536) body += chunk; });
    res.on('end', function () { finish(null, res.statusCode, body); });
    res.on('error', function (err) { finish(err.message); });
  });
  var timer = setTimeout(function () {
    req.abort();
    finish('timed out');
  }, LOCAL_HTTP_TIMEOUT_MS);
  req.on('error', function (err) { finish(err.message); });
}

// ----------------------------------------------------------- web app pages

/*
 * A web app's page, through the web app debugger on this TV (port 9998), which
 * takes Chrome DevTools Protocol commands over a WebSocket. Input.dispatchKeyEvent
 * reaches the page as a key press, and the text of a keyDown is typed as given,
 * so there is no shift and any character works. Chromium 53 (webOS 4) is
 * protocol 1.1. devtools.js closes the port to the network only, so the
 * loopback address used here is untouched; with Developer Mode off nothing
 * listens and the route is not offered.
 */
var DEBUGGER_PORT = 9998;
var YOUTUBE_APP = 'youtube.leanback.v4';
var YOUTUBE_PAGE_PREFIX = 'https://www.youtube.com/tv';
var PAGE_COMMAND_TIMEOUT_MS = 3000;
var PAGE_KEY_GAP_MS = 60;

// cb(pages): the debugger's page targets, none when it is not listening.
function listPages(cb) {
  localGet(DEBUGGER_PORT, '/json', function (error, status, body) {
    var targets = null;
    if (!error && status === 200) {
      try { targets = JSON.parse(body); } catch (e) { targets = null; }
    }
    if (!Array.isArray(targets)) return cb([]);
    cb(targets.filter(function (t) { return t && t.type === 'page' && t.webSocketDebuggerUrl; }));
  });
}

// The page that belongs to the app in front, by what its address says; null
// where that does not tell (the one-page case is controls.js's, which can ask
// whether the app is a web app).
function pickPage(pages, appId) {
  var i;
  for (i = 0; i < pages.length; i++) {
    if (String(pages[i].url || '').indexOf(appId) !== -1) return pages[i];
  }
  if (appId === YOUTUBE_APP) {
    for (i = 0; i < pages.length; i++) {
      if (String(pages[i].url || '').indexOf(YOUTUBE_PAGE_PREFIX) === 0) return pages[i];
    }
  }
  return null;
}

function bufferFromString(text) {
  var buffer = allocBuffer(Buffer.byteLength(text, 'utf8'));
  buffer.write(text, 0, buffer.length, 'utf8');
  return buffer;
}

// One client frame, masked as the protocol requires; payloads here are small.
function encodeFrame(opcode, payload) {
  var length = payload.length;
  var headerLength = length < 126 ? 2 : 4;
  var frame = allocBuffer(headerLength + 4 + length);
  var mask = crypto.randomBytes(4);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  }
  mask.copy(frame, headerLength);
  for (var i = 0; i < length; i++) frame[headerLength + 4 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

/*
 * Takes server frames in as they arrive. onFrame(opcode, payload) is called
 * for each whole message, with a message in fragments joined; it returns
 * false once the socket is no use.
 */
function FrameReader(onFrame) {
  this.buffer = allocBuffer(0);
  this.fragments = [];
  this.fragmentOpcode = 0;
  this.onFrame = onFrame;
}

FrameReader.prototype.push = function (chunk) {
  this.buffer = Buffer.concat([this.buffer, chunk]);
  for (;;) {
    var b = this.buffer;
    if (b.length < 2) return true;
    var finalFragment = (b[0] & 0x80) !== 0;
    var opcode = b[0] & 0x0f;
    var masked = (b[1] & 0x80) !== 0;
    var length = b[1] & 0x7f;
    var offset = 2;
    if (length === 126) {
      if (b.length < 4) return true;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return true;
      if (b.readUInt32BE(2) !== 0 || b.readUInt32BE(6) > 4 * 1024 * 1024) return false;
      length = b.readUInt32BE(6);
      offset = 10;
    }
    var maskOffset = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return true;
    var payload = allocBuffer(length);
    b.copy(payload, 0, offset, offset + length);
    if (masked) for (var i = 0; i < length; i++) payload[i] ^= b[maskOffset + (i % 4)];
    this.buffer = b.slice(offset + length);
    if (opcode >= 8) {
      if (this.onFrame(opcode, payload) === false) return false;
    } else {
      if (opcode !== 0) { this.fragments = []; this.fragmentOpcode = opcode; }
      this.fragments.push(payload);
      if (finalFragment) {
        var whole = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.onFrame(this.fragmentOpcode, whole) === false) return false;
      }
    }
  }
};

/*
 * Sends the commands to a page one at a time, each once the one before is
 * answered, then closes the socket. cb({ ok, error, sent }) with how many the
 * page answered.
 */
function runPageCommands(webSocketUrl, commands, cb) {
  var target = /^wss?:\/\/[^\/]+(\/.*)$/.exec(String(webSocketUrl || ''));
  if (!target) return cb({ ok: false, error: msg('srv.typing.pageAddress', 'the page has no debugger address'), sent: 0 });
  var sent = 0, finished = false, timer = null, socket = null, waitingFor = 0, nextId = 1;

  var finish = function (error) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (socket) {
      try { socket.write(encodeFrame(8, allocBuffer(0))); } catch (e) { /* closing anyway */ }
      socket.destroy();
    }
    cb(error ? { ok: false, error: error, sent: sent } : { ok: true, sent: sent });
  };
  var armTimeout = function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      finish(msg('srv.typing.pageTimeout', 'the page did not answer'));
    }, PAGE_COMMAND_TIMEOUT_MS);
  };
  var sendNext = function () {
    if (finished) return;
    if (sent >= commands.length) return finish(null);
    armTimeout();
    waitingFor = nextId++;
    socket.write(encodeFrame(1, bufferFromString(JSON.stringify({
      id: waitingFor, method: commands[sent].method, params: commands[sent].params
    }))));
  };

  armTimeout();
  var req = http.request({
    host: '127.0.0.1', port: DEBUGGER_PORT, path: target[1], agent: false,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64')
    }
  });
  req.on('upgrade', function (res, upgraded, head) {
    socket = upgraded;
    if (finished) return socket.destroy();
    var reader = new FrameReader(function (opcode, payload) {
      if (opcode === 9) { socket.write(encodeFrame(10, payload)); return true; }
      if (opcode === 8) { finish(msg('srv.typing.pageClosed', 'the page closed the debugger connection')); return false; }
      if (opcode !== 1) return true;
      var reply = null;
      try { reply = JSON.parse(payload.toString('utf8')); } catch (e) { reply = null; }
      if (!reply || reply.id !== waitingFor) return true;
      if (reply.error) { finish(String(reply.error.message || 'the page refused the key press')); return false; }
      sent++;
      // Back-to-back key events reach YouTube's search but its box drops some of
      // the letters it shows (webOS 4.10); a short gap after each key keeps them.
      if (commands[sent - 1].params.type === 'keyUp') setTimeout(sendNext, PAGE_KEY_GAP_MS);
      else sendNext();
      return !finished;
    });
    socket.on('data', function (chunk) {
      if (!finished && reader.push(chunk) === false) finish(msg('srv.typing.pageGarbled', 'the page sent something unreadable'));
    });
    socket.on('error', function (err) { finish(err.message); });
    socket.on('close', function () { finish(msg('srv.typing.pageClosed', 'the page closed the debugger connection')); });
    if (head && head.length && reader.push(head) === false) return finish(msg('srv.typing.pageGarbled', 'the page sent something unreadable'));
    sendNext();
  });
  req.on('response', function (res) {
    res.resume();
    finish('the debugger refused the connection (' + res.statusCode + ')');
  });
  req.on('error', function (err) { finish(err.message); });
  req.end();
}

// Windows virtual-key code and DOM code for the characters that have one, which
// some pages' own handlers look at; the text carries the character either way.
function keyIdentity(character) {
  if (/^[a-zA-Z]$/.test(character)) return { vk: character.toUpperCase().charCodeAt(0), code: 'Key' + character.toUpperCase() };
  if (/^[0-9]$/.test(character)) return { vk: character.charCodeAt(0), code: 'Digit' + character };
  if (character === ' ') return { vk: 32, code: 'Space' };
  return { vk: 0, code: '' };
}

function keyEvent(type, key, code, vk, text) {
  var params = { type: type, key: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (code) params.code = code;
  if (text) { params.text = text; params.unmodifiedText = text; }
  return { method: 'Input.dispatchKeyEvent', params: params };
}

// The key events for deleting `replace` characters, typing `text` and, when
// asked, pressing Enter. A character outside the Basic Multilingual Plane is
// one event, as a surrogate pair is one character.
function pageKeyCommands(text, replace, enter) {
  var commands = [], i;
  for (i = 0; i < replace; i++) {
    commands.push(keyEvent('rawKeyDown', 'Backspace', 'Backspace', 8));
    commands.push(keyEvent('keyUp', 'Backspace', 'Backspace', 8));
  }
  for (i = 0; i < text.length; i++) {
    var character = text.charAt(i);
    var next = text.charAt(i + 1);
    if (/[\ud800-\udbff]/.test(character) && /[\udc00-\udfff]/.test(next)) {
      character += next;
      i++;
    }
    var identity = keyIdentity(character);
    commands.push(keyEvent('keyDown', character, identity.code, identity.vk, character));
    commands.push(keyEvent('keyUp', character, identity.code, identity.vk));
  }
  if (enter) {
    commands.push(keyEvent('keyDown', 'Enter', 'Enter', 13, '\r'));
    commands.push(keyEvent('keyUp', 'Enter', 'Enter', 13));
  }
  return commands;
}

function typeIntoPage(webSocketUrl, text, replace, enter, cb) {
  runPageCommands(webSocketUrl, pageKeyCommands(text, replace, enter), cb);
}

module.exports = {
  SEND_KEYS_MAX: SEND_KEYS_MAX,
  keyCodesFor: keyCodesFor,
  listPages: listPages,
  pickPage: pickPage,
  typeIntoPage: typeIntoPage,
  // For checking the page route against a real debugger.
  pageKeyCommands: pageKeyCommands
};
