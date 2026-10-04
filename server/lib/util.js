/*
 * Small helpers shared by the server's modules.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var fs = require('fs');
var path = require('path');

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

module.exports = { toInt: toInt, mkdirp: mkdirp, readTrimmed: readTrimmed };
