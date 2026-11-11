/*
 * test/test-iptv-timeshift.js - pausing live Internet TV: lib/iptv-timeshift
 * starting the real worker, which records a local provider's MPEG-TS stream
 * through curl into a folder standing in for a USB stick and serves it back
 *
 * Sizes are small (20-packet chunks, a 5-chunk buffer) and the provider sends
 * packets when the test says, so nothing waits on a rate or a clock.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var waitFor = require('./wait-for').waitFor;
var allocBuffer = require('../server/lib/util').allocBuffer;
var timeshift = require('../server/lib/iptv-timeshift');

console.log('Running test-iptv-timeshift.js ...');

// Home's band: how long a pause can last and how far behind live, as a clock.
(function () {
  var vm = require('vm');
  var src = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'home.html'), 'utf8');
  var start = src.indexOf('  function clockText(secs) {');
  var end = src.indexOf('\n  }\n', start);
  assert.ok(start !== -1 && end !== -1, 'clockText is in home.html');
  var clockText = vm.runInNewContext(src.slice(start, end + 5) + '\nclockText');
  assert.equal(clockText(0), '0:00 min');
  assert.equal(clockText(65.4), '1:05 min');
  assert.equal(clockText(-3), '0:00 min');
  assert.equal(clockText(2118), '35:18 min');
  assert.equal(clockText(3725), '1:02:05 h');
  console.log('  ✓ Home writes a pause\'s time as a clock');
})();

var CURL = ['/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl'].filter(function (c) { return fs.existsSync(c); })[0];
if (!CURL) {
  console.log('  - skipped: no curl to record with');
  console.log('ALL test-iptv-timeshift.js assertions passed!\n');
  process.exit(0);
}

var PACKET = 188;
var CHUNK = PACKET * 20;
var MAX = CHUNK * 5;
var root = path.join(os.tmpdir(), 'iptv-ts-' + process.pid + '-' + Date.now());
var usb = path.join(root, 'usb');
var stickDir = path.join(usb, 'sda', 'sda1');
var mounts = path.join(root, 'mounts');
fs.mkdirSync(root);
fs.mkdirSync(usb);
fs.mkdirSync(path.join(usb, 'sda'));
fs.mkdirSync(stickDir);
fs.writeFileSync(mounts, '/dev/sda1 ' + stickDir + ' tfat rw,relatime 0 0\n/dev/sdb1 ' + usb + '/sdb/sdb1 ntfs ro 0 0\n');
var folder = path.join(stickDir, timeshift.FOLDER);

// ---------------------------------------------------------------- a provider

// Packets numbered from 0 in their bytes 4 to 7, sent when push() says.
var sent = 0, live = null, agents = [];
var provider = http.createServer(function (req, res) {
  agents.push(req.headers['user-agent']);
  if (req.url === '/refused.ts') { res.writeHead(461); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  live = res;
});
function push(n) {
  var b = allocBuffer(n * PACKET);
  for (var i = 0; i < n; i++) {
    b[i * PACKET] = 0x47;
    b.writeUInt32BE(sent++, i * PACKET + 4);
  }
  live.write(b);
}
function seqs(buf) {
  var out = [];
  for (var i = 0; i + PACKET <= buf.length; i += PACKET) {
    assert.equal(buf[i], 0x47, 'on a packet boundary');
    out.push(buf.readUInt32BE(i + 4));
  }
  return out;
}

// A player: what it read, as packet numbers.
function play(url) {
  var p = { data: [], status: 0, req: null, closed: false };
  p.req = http.get(url, function (res) {
    p.status = res.statusCode;
    res.on('data', function (d) { p.data.push(d); });
    res.on('end', function () { p.closed = true; });
  });
  p.req.on('error', function () { p.closed = true; });
  p.seqs = function () { return seqs(Buffer.concat(p.data)); };
  return p;
}
function files() {
  try { return fs.readdirSync(folder).filter(function (n) { return /\.ts$/.test(n); }); } catch (e) { return []; }
}

var client = CURL;
timeshift.init({ clients: function () { return [client]; }, usbRoot: usb, mountsFile: mounts,
  chunkBytes: CHUNK, maxBytes: MAX, spareBytes: 0, minBytes: CHUNK, statusMs: 20, prerollBytes: PACKET * 4, free: function (d, cb) { cb(1e9); } });

// The worker's last report: [written, kept, behind, bytes a second, player attached].
function report() { var s = timeshift._session(); return s && s.stats; }

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function run(i) {
  if (i === steps.length) {
    timeshift.stop();
    provider.close();
    return waitFor(function () { return !files().length; }, function () {
      fs.unlinkSync(mounts);
      [folder, stickDir, path.join(usb, 'sda'), usb, root].forEach(function (d) { try { fs.rmdirSync(d); } catch (e) {} });
      console.log('ALL test-iptv-timeshift.js assertions passed!\n');
      process.exit(0);
    }, 'the recording emptied');
  }
  steps[i].fn(function () {
    console.log('  ✓ ' + steps[i].name);
    run(i + 1);
  });
}

var base = '', url = '', first = null;

step('a writable stick under /tmp/usb is found', function (done) {
  timeshift.stick(function (s) {
    assert.ok(s && s.free > 0);
    done();
  });
});

step('Home is given a local URL with a token, never the provider\'s', function (done) {
  timeshift.open('p1:a1', base + '/live.ts', function (r) {
    assert.ok(r && /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/live\.ts$/.test(r.url), r && r.url);
    assert.equal(r.url.indexOf(base), -1);
    url = r.url;
    done();
  });
});

step('the recorder asks with a player\'s User-Agent', function (done) {
  waitFor(function () { return live; }, function () {
    assert.ok(/^VLC\//.test(agents[agents.length - 1]), agents[agents.length - 1]);
    done();
  }, 'the recorder\'s request');
});

step('another token is refused', function (done) {
  var p = play(url.replace(/[0-9a-f]{32}/, new Array(33).join('0')));
  waitFor(function () { return p.closed; }, function () {
    assert.equal(p.status, 404);
    done();
  }, 'the refusal');
});

step('the player gets the stream as recorded, every packet in order', function (done) {
  first = play(url + '?gh=1');
  push(30);
  waitFor(function () { return first.seqs().length === 30; }, function () {
    assert.equal(first.status, 200);
    assert.deepEqual(first.seqs(), Array.apply(null, { length: 30 }).map(function (x, i) { return i; }));
    assert.ok(files().length >= 2, 'recorded to the stick in chunks');
    done();
  }, '30 packets');
});

step('a reconnect goes on from its place, not from the start', function (done) {
  // As Home's reconnect does: the new request takes over from the old.
  var again = play(url + '?gh=2');
  waitFor(function () { return again.status === 200; }, function () {
    first.req.abort();
    push(10);
    waitFor(function () { return again.seqs().length >= 10; }, function () {
    var got = again.seqs();
    assert.equal(got[0], 30, 'picks up after the last packet sent');
    assert.equal(got[got.length - 1], 39);
    first = again;
    done();
    }, 'the rest after reconnecting');
  }, 'the reconnect\'s answer');
});

step('a paused player\'s place is held while the recording goes on', function (done) {
  first.req.abort();
  waitFor(function () { return report() && report()[4] === 0; }, function () {
  // The player away, the recording goes on: four chunks more.
  push(80);
  waitFor(function () { return report()[2] >= 80 * PACKET; }, function () {
    var st = timeshift.stats('p1:a1');
    assert.ok(typeof st.capacity === 'number' && st.capacity >= 0 && st.behind >= 0, 'what the buffer holds is known');
    var back = play(url);
    waitFor(function () { return back.seqs().length >= 80; }, function () {
      assert.equal(back.seqs()[0], 40, 'resumed where it paused');
      first = back;
      done();
    }, 'the paused place');
  }, 'the recording to report');
  }, 'the player to be gone');
});

step('the buffer keeps its size on the stick', function (done) {
  push(200);
  waitFor(function () { return first.seqs().length >= 280; }, function () {
    assert.ok(files().length <= MAX / CHUNK + 1, files().length + ' chunks kept');
    done();
  }, 'the stream to go on');
});

step('back to live starts at the live point, a little before it for a keyframe', function (done) {
  first.req.abort();
  var p = play(url + '?live=1');
  push(5);
  waitFor(function () { return p.seqs().length; }, function () {
    assert.ok(p.seqs()[0] >= 320 - 4, 'near live: ' + p.seqs()[0]);
    first = p;
    done();
  }, 'live packets');
});

step('a rewind further than the stick holds starts at its oldest packet', function (done) {
  var st = timeshift.stats('p1:a1');
  assert.ok(typeof st.kept === 'number', 'how much the stick holds is known');
  var p = play(url + '?behind=99999&gh=3');
  waitFor(function () { return p.seqs().length; }, function () {
    var r = report(), oldest = (r[0] - r[1]) / PACKET;
    assert.equal(p.seqs()[0], oldest, 'the oldest kept');
    assert.ok(oldest > 0 && oldest < 320 - 4, 'in the buffer, neither the start nor live');
    first.req.abort();
    first = p;
    done();
  }, 'rewound packets');
});

step('forward to no seconds behind is the live point again', function (done) {
  var p = play(url + '?behind=0');
  waitFor(function () { return p.seqs().length; }, function () {
    assert.ok(p.seqs()[0] >= sent - 4, 'near live: ' + p.seqs()[0]);
    first.req.abort();
    p.req.abort();
    done();
  }, 'live packets');
});

step('another channel\'s play ends the recording and empties the folder', function (done) {
  timeshift.release('p1:b2');
  assert.equal(timeshift._session(), null);
  waitFor(function () { return !files().length; }, done, 'the folder emptied');
});

step('a provider refusing the recorder gives a 502, and the channel then plays directly', function (done) {
  timeshift.open('p1:c3', base + '/refused.ts', function (r) {
    assert.ok(r && r.url);
    var p = play(r.url);
    waitFor(function () { return p.closed && !timeshift._session(); }, function () {
      assert.ok(p.status === 502 || p.status === 0, 'status ' + p.status);
      timeshift.open('p1:c3', base + '/refused.ts', function (again) {
        assert.equal(again, null, 'played directly for a while');
        done();
      });
    }, 'the refusal to end it');
  });
});

step('the lease running out ends the recording', function (done) {
  live = null;
  timeshift.open('p1:d4', base + '/live.ts', function (r) {
    assert.ok(r);
    waitFor(function () { return live; }, function () {
      push(25);
      waitFor(function () { return files().length; }, function () {
        timeshift.leased(Date.now() - 1000);
        waitFor(function () { return !timeshift._session() && !files().length; }, done, 'the lease to end it', 3000);
      }, 'a chunk on the stick');
    }, 'the recording to start');
  });
});

step('curl aborting before exec, as webOS 5 to 8 can, is started again', function (done) {
  timeshift.stop();
  var marker = path.join(root, 'aborted');
  client = path.join(root, 'curl');
  fs.writeFileSync(client, '#!/bin/sh\nif [ ! -e \'' + marker + '\' ]; then touch \'' + marker + '\'; kill -ABRT $$; fi\nexec \'' + CURL + '\' "$@"\n');
  fs.chmodSync(client, 493);
  live = null;
  timeshift.open('p1:e5', base + '/live.ts', function (r) {
    assert.ok(r);
    waitFor(function () { return live; }, function () {
      assert.ok(fs.existsSync(marker), 'the first start aborted');
      push(5);
      waitFor(function () { return report() && report()[0] >= 5 * PACKET; }, function () {
        timeshift.stop();
        fs.unlinkSync(marker);
        fs.unlinkSync(client);
        client = CURL;
        done();
      }, 'the recording');
    }, 'the second start');
  });
});

provider.listen(0, '127.0.0.1', function () {
  base = 'http://127.0.0.1:' + provider.address().port;
  run(0);
});
