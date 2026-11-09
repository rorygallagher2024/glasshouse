/**
 * test/test-doh.js - the DNS server on the TV for DNS over HTTPS: a query
 * over UDP or TCP goes on to its address with ID 0 and its answer comes back
 * with the query's ID, a failure comes back as SERVFAIL with the error kept,
 * an answer too long for UDP sends the resolver to TCP, and only the
 * addresses asked for are served
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var dgram = require('dgram');
var net = require('net');
var doh = require('../server/lib/doh');
var util = require('../server/lib/util');
var freePort = require('./ports').freePort;

console.log('Running test-doh.js ...');

var URL_A = 'https://dns.example/dns-query';
var HOST = '127.0.0.1';

// A query for www.youtube.com, type A, with the given ID.
function query(id) {
  var name = util.toBuffer([3, 119, 119, 119, 7, 121, 111, 117, 116, 117, 98, 101, 3, 99, 111, 109, 0]);
  var head = util.allocBuffer(12);
  head.fill(0);
  head.writeUInt16BE(id, 0);
  head[2] = 0x01;              // RD
  head.writeUInt16BE(1, 4);    // one question
  return Buffer.concat([head, name, util.toBuffer([0, 1, 0, 1])]);
}

// An answer to q with one A record and extra bytes, as long as wanted.
function answerTo(q, length) {
  var out = util.allocBuffer(Math.max(length, q.length + 16));
  out.fill(0);
  q.copy(out);
  out[2] = 0x81;
  out[3] = 0x80;
  out.writeUInt16BE(1, 6);
  return out;
}

var posts = [];
var behaviour = 'answer';
var answerLength = 0;
function post(url, q, cb) {
  posts.push({ url: url, id: q.readUInt16BE(0) });
  setImmediate(function () {
    if (behaviour === 'fail') return cb(new Error('HTTP 403'));
    cb(null, answerTo(q, answerLength));
  });
}

function askUdp(port, q, cb) {
  var s = dgram.createSocket('udp4');
  s.on('message', function (m) { s.close(); cb(m); });
  s.send(q, 0, q.length, port, HOST);
}

function askTcp(port, q, cb) {
  var c = net.connect(port, HOST, function () {
    var head = util.allocBuffer(2);
    head.writeUInt16BE(q.length, 0);
    c.write(Buffer.concat([head, q]));
  });
  var buf = util.allocBuffer(0);
  c.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
      c.end();
      cb(buf.slice(2, 2 + buf.readUInt16BE(0)));
    }
  });
}

freePort(HOST, function (port) {
  doh.init({ post: post, port: port });
  var map = {};
  map[HOST] = URL_A;
  doh.serve(map, function (failed) {
    assert.deepEqual(failed, {});

    askUdp(port, query(0x1234), function (a) {
      assert.equal(posts[0].url, URL_A);
      assert.equal(posts[0].id, 0, 'sent on with ID 0');
      assert.equal(a.readUInt16BE(0), 0x1234, 'the query\'s ID back');
      assert.equal(a[3] & 0x0f, 0);
      assert.equal(a.readUInt16BE(6), 1);
      console.log('  ✓ a UDP query goes on over HTTPS and its answer comes back');

      behaviour = 'fail';
      askUdp(port, query(7), function (f) {
        assert.equal(f.readUInt16BE(0), 7);
        assert.equal(f[3] & 0x0f, 2, 'SERVFAIL');
        assert.equal(doh.status()[HOST].error, 'HTTP 403');
        console.log('  ✓ a failure comes back as SERVFAIL, and the error is kept');

        behaviour = 'answer';
        answerLength = 700;
        askUdp(port, query(8), function (t) {
          assert.ok(t.length <= 512);
          assert.ok(t[2] & 0x02, 'TC set');
          assert.equal(t.readUInt16BE(6), 0);
          askTcp(port, query(9), function (full) {
            assert.equal(full.length, 700);
            assert.equal(full.readUInt16BE(0), 9);
            assert.equal(doh.status()[HOST].error, null, 'an answer clears the error');
            console.log('  ✓ an answer too long for UDP sends the resolver to TCP, which has it whole');

            assert.equal(doh.emptyAnswer(util.allocBuffer(5), false, 2), null);
            doh.serve({}, function () {
              assert.deepEqual(doh.status(), {});
              console.log('  ✓ an address no longer asked for is closed');
              console.log('test-doh.js: all passed');
              process.exit(0);
            });
          });
        });
      });
    });
  });
});
