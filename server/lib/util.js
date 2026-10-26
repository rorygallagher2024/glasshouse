/*
 * Small helpers shared by the server's modules.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');

// An integer from config or a request, or dflt when there is none.
function toInt(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

// node 0.12 has no { recursive: true }.
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e) {}
}

// A file's text, trimmed, or null when it cannot be read.
function readTrimmed(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch (e) { return null; }
}

// The TV's IPv4 local address, whatever the server is bound to.
function localAddress4() {
  var ifaces = {};
  try { ifaces = os.networkInterfaces() || {}; } catch (e) { return null; }
  var best = null;
  for (var name in ifaces) {
    if (!ifaces.hasOwnProperty(name)) continue;
    var list = ifaces[name] || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var fam = String(a.family);
      if (fam !== 'IPv4' && fam !== '4') continue;
      if (a.internal) continue;
      // Wired first where a TV has both, otherwise the first that answers.
      if (!best || /^eth/.test(name)) best = a.address;
    }
  }
  return best;
}

// Milliseconds on CLOCK_MONOTONIC, which a step of the wall clock does not move.
function monotonicMs() {
  var t = process.hrtime();
  return t[0] * 1000 + t[1] / 1e6;
}

// node 0.12 has no Buffer.from or Buffer.alloc.
function toBuffer(data, enc) {
  return typeof Buffer.from === 'function' ? Buffer.from(data, enc) : new Buffer(data, enc);
}

// Buffer#equals arrived in node 0.11.13; webOS 2 runs 0.10.
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function allocBuffer(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}

// A file's parsed JSON, or dflt when it is missing or does not parse.
function readJson(filePath, dflt) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { return dflt; }
}

// Written beside the file and renamed over it, so a reader never sees half of
// it. Indented, for a file someone may edit, unless compact. Throws on failure.
function writeJsonAtomic(filePath, obj, mode, compact) {
  var tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2), 'utf8');
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

// Removes a file that may not be there.
function unlinkQuiet(filePath) {
  try { fs.unlinkSync(filePath); } catch (e) {}
}

function existsQuiet(filePath) {
  try { return fs.existsSync(filePath); } catch (e) { return false; }
}

/*
 * Listens on host and calls back with the address bound. A dual-stack '::'
 * listener falls back to '0.0.0.0' on a kernel without IPv6, passing the error
 * that caused it.
 */
function listenDualStack(server, port, host, cb) {
  function onError(err) {
    server.removeListener('listening', onListening);
    if (host === '::' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      return listenDualStack(server, port, '0.0.0.0', function (e, took) {
        if (e) return cb(e);
        cb(null, took, err);
      });
    }
    cb(err);
  }
  function onListening() {
    server.removeListener('error', onError);
    cb(null, host);
  }
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
}

/*
 * A colour as '#rrggbb' in lower case, from '#rgb' or '#rrggbb' as an
 * appinfo.json gives it, or null for anything else. Android's
 * Color.parseColor takes no three-digit form, so it is spelled out.
 */
function hexColor(v) {
  var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  var h = m[1].toLowerCase();
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  return '#' + h;
}

// host:port as a URL writes it, with an IPv6 address in brackets.
function hostPort(host, port) {
  return (String(host).indexOf(':') !== -1 ? '[' + host + ']' : host) + ':' + port;
}

module.exports = {
  toInt: toInt,
  mkdirp: mkdirp,
  readTrimmed: readTrimmed,
  localAddress4: localAddress4,
  monotonicMs: monotonicMs,
  toBuffer: toBuffer,
  allocBuffer: allocBuffer,
  sameBytes: sameBytes,
  readJson: readJson,
  writeJsonAtomic: writeJsonAtomic,
  unlinkQuiet: unlinkQuiet,
  existsQuiet: existsQuiet,
  listenDualStack: listenDualStack,
  hostPort: hostPort,
  hexColor: hexColor
};
