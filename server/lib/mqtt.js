/*
 * MiniMQTT - minimal zero-dependency MQTT 3.1.1 client for Node 0.12+.
 * ES5 only: runs on webOS TV Node runtime.
 */
var fs = require('fs');
var net = require('net');
var path = require('path');
var tls = require('tls');
var toBuffer = require('./util').toBuffer;
var hostPort = require('./util').hostPort;

// Node 0.12's built-in root list predates ISRG Root X1 (2015), so a broker
// with a Let's Encrypt certificate fails with "unable to get local issuer
// certificate". A PEM file here replaces the built-in list for the broker.
var BROKER_CA_FILE = path.join(__dirname, '..', 'mqtt-ca.pem');

function readBrokerCa() {
  try {
    return fs.readFileSync(BROKER_CA_FILE);
  } catch (e) {
    return undefined;
  }
}

var CONNACK_ERRORS = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized'
};

function encodeVarLength(len) {
  var bytes = [];
  do {
    var digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit = digit | 0x80;
    bytes.push(digit);
  } while (len > 0);
  return toBuffer(bytes);
}

function encodeConnectPacket(opts) {
  opts = opts || {};
  var protoName = toBuffer([0, 4, 77, 81, 84, 84]); // 'MQTT'
  var protoLevel = toBuffer([4]); // 3.1.1
  var flags = 0x02; // CleanSession
  if (opts.will) {
    flags |= 0x04; // Will flag
    if (opts.will.retain) flags |= 0x20;
  }
  if (opts.username) flags |= 0x80;
  if (opts.password) flags |= 0x40;

  var flagBuf = toBuffer([flags]);
  var keepAlive = toBuffer([0, opts.keepAlive || 60]); // 60s
  var varHeader = Buffer.concat([protoName, protoLevel, flagBuf, keepAlive]);

  var payloads = [];
  var cid = opts.clientId || ('lgtv_' + Math.random().toString(16).slice(2, 8));
  var cidBuf = toBuffer(cid, 'utf8');
  var cidLen = toBuffer([cidBuf.length >> 8, cidBuf.length & 0xff]);
  payloads.push(cidLen, cidBuf);

  if (opts.will) {
    var wtBuf = toBuffer(opts.will.topic, 'utf8');
    payloads.push(toBuffer([wtBuf.length >> 8, wtBuf.length & 0xff]), wtBuf);
    var wmBuf = toBuffer(opts.will.payload || '', 'utf8');
    payloads.push(toBuffer([wmBuf.length >> 8, wmBuf.length & 0xff]), wmBuf);
  }

  if (opts.username) {
    var uBuf = toBuffer(opts.username, 'utf8');
    payloads.push(toBuffer([uBuf.length >> 8, uBuf.length & 0xff]), uBuf);
  }
  if (opts.password) {
    var pBuf = toBuffer(opts.password, 'utf8');
    payloads.push(toBuffer([pBuf.length >> 8, pBuf.length & 0xff]), pBuf);
  }

  var payload = Buffer.concat(payloads);
  var remLen = encodeVarLength(varHeader.length + payload.length);
  return Buffer.concat([toBuffer([0x10]), remLen, varHeader, payload]);
}

function MiniMQTT(opts) {
  this.opts = opts || {};
  this.client = null;
  this.connected = false;
  this.packetId = 1;
  this.buffer = toBuffer([]);
  this.pingTimer = null;
  this.lastRx = 0;
  this.retryTimer = null;
  this.subscriptions = [];
  this.listeners = {};
  this.connectStart = 0;
  this.pingStart = 0;
  this.latencyMs = null;
}

MiniMQTT.prototype.on = function(event, fn) {
  this.listeners[event] = this.listeners[event] || [];
  this.listeners[event].push(fn);
};

MiniMQTT.prototype.emit = function(event, a, b) {
  var list = this.listeners[event] || [];
  for (var i = 0; i < list.length; i++) list[i](a, b);
};

MiniMQTT.prototype.connect = function() {
  var self = this;
  if (this.client) return;
  clearTimeout(this.retryTimer);

  /*
   * Start each connection on an empty buffer. A drop mid-packet - a broker
   * restart, a Wi-Fi blip - leaves a partial packet here, and the new
   * connection's CONNACK would be appended to that fragment. The parser reads
   * the remaining length from the fragment's bytes, waits for a packet that
   * never completes, and the client stays unconnected: publish() then silently
   * returns and the bridge goes quiet until the process restarts.
   */
  this.buffer = toBuffer([]);

  /*
   * Plain TCP by default, since that is what a typical home broker listens on.
   * With mqtt.tls set, connect over TLS instead - otherwise the username and
   * password cross the LAN in cleartext inside every CONNECT packet, and a
   * reconnect loop resends them every few seconds.
   */
  var socket;
  if (this.opts.tls) {
    socket = tls.connect({
      host: this.opts.host,
      port: this.opts.port || 8883,
      servername: this.opts.host,
      ca: readBrokerCa(),
      // Self-signed broker certs are common on home networks. Turning this
      // off keeps the traffic encrypted but stops authenticating the broker,
      // so only do it on a network you trust.
      rejectUnauthorized: this.opts.tlsRejectUnauthorized !== false
    });
  } else {
    socket = net.createConnection({ host: this.opts.host, port: this.opts.port || 1883 });
  }
  this.client = socket;
  this.connectStart = Date.now();

  socket.on(self.opts.tls ? 'secureConnect' : 'connect', function() {
    socket.write(encodeConnectPacket(self.opts));
  });

  socket.on('data', function(chunk) {
    self.lastRx = Date.now();
    self.buffer = Buffer.concat([self.buffer, chunk]);
    self._parse();
  });

  socket.on('close', function() {
    var wasConnected = self.connected;
    self.connected = false;
    self.client = null;
    self.latencyMs = null;
    clearInterval(self.pingTimer);
    if (wasConnected) {
      console.log('mqtt: disconnected from ' + hostPort(self.opts.host, self.opts.port || (self.opts.tls ? 8883 : 1883)));
      self.emit('close');
    }
    if (self.rewill) {
      self.rewill = false;
      self.closing = false;
      return self.connect();
    }
    if (!self.closing) self.retryTimer = setTimeout(function() { self.connect(); }, 5000);
  });

  socket.on('error', function(err) {
    self.emit('error', err);
    if (self.client) {
      self.client.destroy();
    }
  });
};

MiniMQTT.prototype._parse = function() {
  while (this.buffer.length >= 2) {
    var packetType = this.buffer[0] >> 4;
    var flags = this.buffer[0] & 0x0f;
    var multiplier = 1, remLen = 0, idx = 1, digit;
    do {
      if (idx >= this.buffer.length) return; // wait for more data
      digit = this.buffer[idx++];
      remLen += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0);

    var totalLen = idx + remLen;
    if (this.buffer.length < totalLen) return; // wait for full packet

    var packetBody = this.buffer.slice(idx, totalLen);
    this.buffer = this.buffer.slice(totalLen);

    if (packetType === 2) { // CONNACK
      var returnCode = packetBody[1];
      if (returnCode === 0) {
        this.connected = true;
        this.latencyMs = this.connectStart ? (Date.now() - this.connectStart) : null;
        var self = this;
        clearInterval(this.pingTimer);
        /*
         * A broker that has dropped the connection does not always say so: a
         * TV back from standby still holds a socket the broker closed while it
         * slept, and writes to it go nowhere. Every ping is answered, so no
         * packet at all since the one before last means the broker is gone.
         * Date.now() also runs through standby, so the first round after a
         * resume finds the gap and reconnects.
         */
        this.pingTimer = setInterval(function() {
          if (!self.client || !self.connected) return;
          if (Date.now() - self.lastRx > 45000) {
            console.log('mqtt: no answer from ' + self.opts.host + ' - reconnecting');
            return self.client.destroy();
          }
          self.pingStart = Date.now();
          self.client.write(toBuffer([0xc0, 0x00])); // PINGREQ
        }, 30000);
        // Resubscribe to all saved subscriptions
        for (var i = 0; i < this.subscriptions.length; i++) {
          this._sendSubscribe(this.subscriptions[i]);
        }
        this.emit('connect');
      } else {
        var errDesc = CONNACK_ERRORS[returnCode] || ('CONNACK rejected with code ' + returnCode);
        this.emit('error', new Error(errDesc));
        if (this.client) {
          this.client.destroy();
        }
      }
    } else if (packetType === 13) { // PINGRESP
      if (this.pingStart) {
        this.latencyMs = Date.now() - this.pingStart;
      }
    } else if (packetType === 3) { // PUBLISH
      var qos = (flags >> 1) & 0x03;
      var tLen = (packetBody[0] << 8) | packetBody[1];
      var topic = packetBody.slice(2, 2 + tLen).toString('utf8');
      var pOffset = 2 + tLen;
      if (qos > 0) {
        /*
         * Subscriptions are made at QoS 0 and a broker may not deliver above
         * the granted QoS, so this should never arrive. If one does, a QoS 1
         * message left unacknowledged is redelivered on a timer for as long as
         * the session lasts, so answer it rather than drop it silently.
         */
        if (qos === 1 && this.client) {
          this.client.write(toBuffer([0x40, 0x02, packetBody[pOffset], packetBody[pOffset + 1]]));
        }
        pOffset += 2;   // past the packet identifier
      }
      var payload = packetBody.slice(pOffset).toString('utf8');
      this.emit('message', topic, payload);
    }
  }
};

MiniMQTT.prototype._sendSubscribe = function(topic) {
  if (!this.client || !this.connected) return;
  var pid = this.packetId++;
  if (this.packetId > 65535) this.packetId = 1;
  var pidBuf = toBuffer([pid >> 8, pid & 0xff]);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var qosBuf = toBuffer([0]);
  var payload = Buffer.concat([pidBuf, tLen, tBuf, qosBuf]);
  var remLen = encodeVarLength(payload.length);
  var packet = Buffer.concat([toBuffer([0x82]), remLen, payload]);
  this.client.write(packet);
};

MiniMQTT.prototype.subscribe = function(topic) {
  if (this.subscriptions.indexOf(topic) === -1) {
    this.subscriptions.push(topic);
  }
  this._sendSubscribe(topic);
};

MiniMQTT.prototype.publish = function(topic, message, retain) {
  if (!this.client || !this.connected) return;
  var firstByte = 0x30 | (retain ? 0x01 : 0x00);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var mBuf = toBuffer(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
  var remLen = encodeVarLength(tLen.length + tBuf.length + mBuf.length);
  var packet = Buffer.concat([toBuffer([firstByte]), remLen, tLen, tBuf, mBuf]);
  this.client.write(packet);
};

// A clean DISCONNECT also stops the broker publishing the will, and the
// client stays disconnected rather than retrying.
MiniMQTT.prototype.disconnect = function() {
  this.closing = true;
  clearTimeout(this.retryTimer);
  if (this.client && this.connected) {
    try {
      this.client.write(toBuffer([0xe0, 0x00])); // DISCONNECT
    } catch (e) {}
    this.connected = false;
    try {
      this.client.end();
    } catch (e) {}
    /*
     * end() waits for the broker to acknowledge the close. One that already
     * dropped the connection never does, and the socket sat in FIN_WAIT1 for
     * the kernel's full retry time (about 15 minutes on a B8) with nothing
     * published: connect() does nothing while it exists.
     */
    var sock = this.client;
    setTimeout(function() { sock.destroy(); }, 3000);
  }
};

/*
 * A will is fixed when the connection is made, so changing it means a clean
 * disconnect - which the broker does not answer with the old will - and a new
 * connection carrying the new one. Unconnected, the next connect takes it up.
 */
MiniMQTT.prototype.setWill = function(payload) {
  if (!this.opts.will || this.opts.will.payload === payload) return;
  this.opts.will.payload = payload;
  if (!this.client || !this.connected) return;
  this.rewill = true;
  this.disconnect();
};

MiniMQTT.encodeVarLength = encodeVarLength;
MiniMQTT.encodeConnectPacket = encodeConnectPacket;

/*
 * Probe broker reachability and credentials without disturbing the running
 * client. Connects, sends an MQTT 3.1.1 CONNECT packet, parses CONNACK,
 * measures round-trip latency, and tears down the socket cleanly.
 */
MiniMQTT.testConnection = function(opts, cb) {
  cb = typeof cb === 'function' ? cb : function() {};
  opts = opts || {};
  if (!opts.host || typeof opts.host !== 'string' || !opts.host.trim()) {
    return cb(null, { ok: false, error: 'broker host is required' });
  }
  var host = opts.host.trim();
  var port = opts.port ? parseInt(opts.port, 10) : (opts.tls ? 8883 : 1883);
  if (!port || port < 1 || port > 65535) {
    return cb(null, { ok: false, error: 'invalid port' });
  }
  var timeoutMs = opts.timeoutMs || 5000;
  var startTime = Date.now();
  var done = false;
  var timer = null;
  var socket = null;

  function finish(result) {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (socket) {
      try { socket.destroy(); } catch (e) {}
      socket = null;
    }
    cb(null, result);
  }

  timer = setTimeout(function() {
    finish({ ok: false, latencyMs: Date.now() - startTime, error: 'connection timed out' });
  }, timeoutMs);

  try {
    if (opts.tls) {
      socket = tls.connect({
        host: host,
        port: port,
        servername: host,
        ca: readBrokerCa(),
        rejectUnauthorized: opts.tlsRejectUnauthorized !== false
      });
    } else {
      socket = net.createConnection({ host: host, port: port });
    }
  } catch (err) {
    return finish({ ok: false, error: err.message || String(err) });
  }

  socket.on(opts.tls ? 'secureConnect' : 'connect', function() {
    try {
      var packet = encodeConnectPacket({
        clientId: 'gh_test_' + Math.random().toString(16).slice(2, 8),
        username: opts.username,
        password: opts.password,
        keepAlive: 10
      });
      socket.write(packet);
    } catch (err) {
      finish({ ok: false, latencyMs: Date.now() - startTime, error: err.message || String(err) });
    }
  });

  var buf = toBuffer([]);
  socket.on('data', function(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      var packetType = buf[0] >> 4;
      var multiplier = 1, remLen = 0, idx = 1, digit;
      do {
        if (idx >= buf.length) return; // wait for more data
        digit = buf[idx++];
        remLen += (digit & 127) * multiplier;
        multiplier *= 128;
      } while ((digit & 128) !== 0);

      var totalLen = idx + remLen;
      if (buf.length < totalLen) return; // wait for full packet

      var packetBody = buf.slice(idx, totalLen);
      buf = buf.slice(totalLen);

      if (packetType === 2) { // CONNACK
        var latency = Date.now() - startTime;
        var returnCode = packetBody.length >= 2 ? packetBody[1] : 0;
        if (returnCode === 0) {
          return finish({ ok: true, latencyMs: latency, code: 0 });
        }
        var reason = CONNACK_ERRORS[returnCode] || ('connection refused: code ' + returnCode);
        return finish({ ok: false, latencyMs: latency, code: returnCode, error: reason });
      }
    }
  });

  socket.on('error', function(err) {
    var msgStr = (err && err.message) || String(err || 'connection error');
    finish({ ok: false, latencyMs: Date.now() - startTime, error: msgStr });
  });

  socket.on('close', function() {
    finish({ ok: false, latencyMs: Date.now() - startTime, error: 'connection closed by broker' });
  });
};

module.exports = MiniMQTT;
