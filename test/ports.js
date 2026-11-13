/**
 * test/ports.js - a port for a test to start a server on later
 *
 * A port the system hands out for listen(0) is free only until the next
 * listen(0) or outgoing connection, in any of the suites run-all.js runs side
 * by side: one closed and bound again a moment later was taken in between
 * (EADDRINUSE on CI). These come from 20000-31999, below the ranges the
 * system hands out from (Linux 32768-60999, macOS 49152-65535), picked at
 * random and checked free, so only another suite's pick here could clash.
 *
 * Strict ES5: runs on node 0.12.
 */
var net = require('net');

var FIRST = 20000;
var COUNT = 12000;

// cb(port), free on host (127.0.0.1 unless given) when checked.
function freePort(host, cb) {
  if (typeof host === 'function') { cb = host; host = '127.0.0.1'; }
  (function attempt(left) {
    var port = FIRST + Math.floor(Math.random() * COUNT);
    var s = net.createServer();
    s.once('error', function (err) {
      if (left <= 0) throw err;
      attempt(left - 1);
    });
    s.listen(port, host, function () { s.close(function () { cb(port); }); });
  })(20);
}

module.exports = { freePort: freePort };
