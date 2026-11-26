// A simulated DS90TR uses real LG frames, including replies split inside the header.
var assert = require('assert');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var buffers = require('../server/lib/util');
var bar = require('../server/lib/soundbar');
var key = buffers.toBuffer('T^&*J%^7tr~4^%^&I(o%^!jIJ__+a0 k');
var iv = buffers.toBuffer("'%^Ur7gy$~t+f)%@");
var target = { host: '192.168.1.15', id: 'soundbar-under-test' };
var speaker = 'SPK_LIST_VIEW_INFO';

require('./fake-clock').install();

function simulatedBar(ignoreSet) {
  var views = {
    PRODUCT_INFO: { s_model_name: 'DS90TR', s_uuid: 'soundbar-under-test' },
    SPK_LIST_VIEW_INFO: { i_vol: 7, i_vol_min: 0, i_vol_max: 100, b_mute: false },
    SETTING_VIEW_INFO: { i_woofer_level: 19, i_woofer_min: -15, i_woofer_max: 6,
      b_night_time: false, b_enable_dialog: false, i_dialog_level: 0, i_dialog_min: 0, i_dialog_max: 6 },
    EQ_VIEW_INFO: { ai_eq_list: [0, 7, 26], i_curr_eq: 7 },
    FUNC_VIEW_INFO: { ai_func_list: [1, 20], i_curr_func: 20 }
  };
  var writes = [], connections = 0, socket, closed = false, rejected = [];
  var mock;
  function notify(cmd, view, data, result) {
    var cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    var raw = JSON.stringify({ cmd: cmd, result: result || 'ok', msg: view, data: data });
    var body = Buffer.concat([cipher.update(buffers.toBuffer(raw, 'utf8')), cipher.final()]);
    var header = buffers.allocBuffer(5);
    header[0] = 16;
    header.writeUInt32BE(body.length, 1);
    process.nextTick(function () {
      socket.emit('data', header.slice(0, 2));
      socket.emit('data', Buffer.concat([header.slice(2), body]));
    });
  }
  function connect(port, host) {
    assert.strictEqual(port, 9741);
    assert.strictEqual(host, target.host);
    connections++;
    socket = new EventEmitter();
    socket.destroy = function () { closed = true; };
    socket.write = function (frame) {
      var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      var request = JSON.parse(Buffer.concat([decipher.update(frame.slice(5)), decipher.final()]));
      var data = views[request.msg];
      if (request.cmd === 'get') {
        if (rejected.indexOf(request.msg) >= 0) notify('notibyget', request.msg, null, 'fail');
        else notify('notibyget', request.msg, data);
        if (mock.afterGet) mock.afterGet(request.msg);
        return;
      }
      writes.push(request.data);
      if (!ignoreSet) Object.keys(request.data).forEach(function (field) { data[field] = request.data[field]; });
    };
    process.nextTick(function () { socket.emit('connect'); });
    return socket;
  }
  mock = { connect: connect, notify: notify, writes: writes, views: views, rejected: rejected, afterGet: null,
    connections: function () { return connections; }, closed: function () { return closed; } };
  return mock;
}

// Each step has a bar of its own, so the steps run one after another.
var steps = [];
function step(fn) { steps.push(fn); }
function next() {
  var fn = steps.shift();
  if (fn) fn(next);
}

function simulate(selection, change, ignoreSet, check, prepare) {
  step(function (done) {
    var mock = simulatedBar(ignoreSet);
    if (prepare) prepare(mock);
    bar.init({ connect: mock.connect });
    bar.request(selection, change, function (error, device) {
      process.nextTick(function () {
        check(error, device, mock.writes);
        done();
      });
    });
  });
}

function row(result, key) { return result.rows.filter(function (r) { return r.key === key; })[0]; }
var change = { key: 'i_woofer_level', value: -2 };
simulate(target, null, false, function (error, device) {
  assert.strictEqual(error, null);
  assert.strictEqual(row(device, 'i_woofer_level').value, 4);
  assert.strictEqual(row(device, 'i_dialog_level'), undefined);
});
simulate(target, change, false, function (error, device, writes) {
  assert.strictEqual(error, null);
  assert.deepEqual(writes, [{ i_woofer_level: 13 }]);
  assert.strictEqual(row(device, 'i_woofer_level').value, -2);
});
simulate(target, change, true, function (error, device, writes) {
  assert.strictEqual(error, 'unconfirmed');
  assert.strictEqual(row(device, 'i_woofer_level').value, 4);
  assert.strictEqual(writes.length, 1);
});
[{ key: 'i_woofer_level', value: 7 }, { key: 'i_curr_eq', value: 4 },
  { key: 'b_night_time', value: 'true' }, { key: 's_user_name', value: 'name' }].forEach(function (invalid) {
  simulate(target, invalid, false, function (error, device, writes) {
    assert.strictEqual(error, 'invalid');
    assert.deepEqual(writes, []);
  });
});
simulate({ host: target.host, id: 'other-device' }, change, false, function (error, device, writes) {
  assert.strictEqual(error, 'identity');
  assert.deepEqual(writes, []);
});
simulate({ host: 'example.org' }, null, false, function (error) { assert.strictEqual(error, 'address'); });

// A compatible bar without the DS90TR's EQ and input views still loads, without their rows.
simulate(target, null, false, function (error, device) {
  assert.strictEqual(error, null);
  assert.strictEqual(row(device, 'i_curr_eq'), undefined);
  assert.strictEqual(row(device, 'i_curr_func'), undefined);
  assert.strictEqual(row(device, 'i_vol').value, 7);
}, function (mock) { mock.rejected.push('EQ_VIEW_INFO', 'FUNC_VIEW_INFO'); });

['Synthetic LG model', '  ', 42].forEach(function (model) {
  simulate({ host: target.host }, null, false, function (err, device) {
    if (model === 'Synthetic LG model') {
      assert.ifError(err);
      assert.strictEqual(device.model, model);
    } else assert.strictEqual(err, 'model');
  }, function (mock) { mock.views.PRODUCT_INFO.s_model_name = model; });
});

// The dashboard's write and both live viewers share the same connection.
var complete = false;
step(function (done) {
  var live = simulatedBar(true);
  bar.init({ connect: live.connect });
  var volumes = [], peerVolumes = [], confirmed = false, stopPeer;
  var stopWatching = bar.watch(target, function (err, device) {
    process.nextTick(function () {
      assert.ifError(err);
      var volume = row(device, 'i_vol');
      assert.strictEqual(volume.max, 100);
      volumes.push(volume.value);
      if (volume.value === 7) {
        stopPeer = bar.watch(target, function (err, state) { if (!err) peerVolumes.push(row(state, 'i_vol').value); });
        bar.request(target, { key: 'i_vol', value: 8 }, function (reason, result) {
          process.nextTick(function () {
            assert.ifError(reason);
            assert.strictEqual(row(result, 'i_vol').value, 8);
            confirmed = true;
          });
        });
        // The first read after the write still sees 7. The bar acknowledges the change after it.
        live.afterGet = function (view) {
          if (view !== speaker || !live.writes.length) return;
          live.afterGet = null;
          live.views[speaker].i_vol = 8;
          live.notify('notibyset', speaker, { i_vol: 8 });
        };
      } else if (volume.value === 8) {
        live.views[speaker].i_vol = 9;
        live.notify('notify', speaker, { i_vol: 9 });
      } else if (volume.value === 9) {
        // A remote step without a notification is picked up by the speaker poll.
        live.views[speaker].i_vol = 10;
      } else {
        assert.deepEqual(volumes, [7, 8, 9, 10]);
        assert.deepEqual(peerVolumes, volumes);
        assert.deepEqual(live.writes, [{ i_vol: 8 }]);
        assert.strictEqual(live.connections(), 1);
        assert(confirmed);
        stopWatching();
        assert(!live.closed());
        stopPeer();
        assert(live.closed());
        complete = true;
        done();
      }
    });
  });
});

// A viewer joining a session a read opened gets the state once, not again on the next poll.
step(function (done) {
  var mock = simulatedBar(false);
  bar.init({ connect: mock.connect });
  var received = 0, polls = 0, stopWatching;
  bar.request(target, null, function (err) {
    assert.ifError(err);
    stopWatching = bar.watch(target, function (err) { assert.ifError(err); received++; });
  });
  mock.afterGet = function (view) {
    if (view !== speaker || !stopWatching || ++polls < 2) return;
    mock.afterGet = null;
    process.nextTick(function () {
      assert.strictEqual(received, 1);
      stopWatching();
      done();
    });
  };
});

// Connect to the selected bar's address reads through its session; another bar there is paired anew.
var routes = require('../server/lib/routes');
function connectRequest(selection, host, fakeBar, check) {
  step(function (done) {
    var calls = [];
    routes.init({ config: { soundbar: selection, allowControl: true }, soundbar: {
      request: function (requested, change, cb) {
        calls.push(requested);
        fakeBar(requested, cb);
      },
      watch: bar.watch, forget: function () {}, init: bar.init
    } });
    var req = new EventEmitter(), res = new EventEmitter();
    req.url = '/api/audio/soundbar';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:8080' };
    req.socket = { remoteAddress: '127.0.0.1' };
    req.setEncoding = function () {};
    res.writeHead = function (status) { res.statusCode = status; };
    res.setHeader = function () {};
    res.end = function () {
      check(calls);
      done();
    };
    routes.handleRequest(req, res);
    process.nextTick(function () {
      req.emit('data', JSON.stringify({ action: 'connect', host: host, id: selection.id }));
      req.emit('end');
    });
  });
}
connectRequest(target, target.host, function (requested, cb) {
  cb('identity');
}, function (calls) {
  assert.deepEqual(calls, [target, { host: target.host }]);
});
connectRequest(target, '192.168.1.16', function (requested, cb) {
  cb('offline');
}, function (calls) {
  assert.deepEqual(calls, [{ host: '192.168.1.16' }]);
});

// A dropped SSE viewer may emit close on both sides, with a queued update still pending.
step(function (done) {
  var updates, unsubscribed = 0, sent = [];
  routes.init({ config: { soundbar: target }, soundbar: {
    watch: function (selection, cb) {
      updates = cb;
      return function () { unsubscribed++; };
    },
    request: bar.request, forget: bar.forget, init: bar.init
  } });
  var req = new EventEmitter(), res = new EventEmitter();
  req.url = '/api/audio/soundbar/events';
  req.method = 'GET';
  req.headers = {};
  req.socket = { destroyed: false };
  res.writable = true;
  res.writeHead = function () {};
  res.write = function (data) { sent.push(data); };
  routes.handleRequest(req, res);
  if (parseInt(process.versions.node, 10) >= 16) {
    req.emit('close');
    assert.strictEqual(unsubscribed, 0);
  }
  updates(null, { rows: [] });
  var beforeClose = sent.length;
  req.socket.destroyed = true;
  req.emit('close');
  res.emit('close');
  res.emit('finish');
  updates(null, { rows: [] });
  assert.strictEqual(unsubscribed, 1);
  assert.strictEqual(sent.length, beforeClose);
  done();
});

process.on('exit', function () {
  assert(complete, 'live soundbar exercise completed');
  assert.strictEqual(steps.length, 0, 'every step ran');
});
next();
