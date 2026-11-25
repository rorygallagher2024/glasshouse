// A simulated DS90TR uses real LG frames, including replies split inside the header.
var assert = require('assert');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var buffers = require('../server/lib/util');
var bar = require('../server/lib/soundbar');
var key = buffers.toBuffer('T^&*J%^7tr~4^%^&I(o%^!jIJ__+a0 k');
var iv = buffers.toBuffer("'%^Ur7gy$~t+f)%@");
var target = { host: '192.168.1.15', id: 'soundbar-under-test' };

function simulate(target, change, ignoreSet, check) {
  var views = {
    PRODUCT_INFO: { s_model_name: 'DS90TR', s_uuid: 'soundbar-under-test' },
    SPK_LIST_VIEW_INFO: { i_vol: 7, i_vol_min: 0, i_vol_max: 100, b_mute: false },
    SETTING_VIEW_INFO: { i_woofer_level: 19, i_woofer_min: -15, i_woofer_max: 6,
      b_night_time: false, b_enable_dialog: false, i_dialog_level: 0, i_dialog_min: 0, i_dialog_max: 6 },
    EQ_VIEW_INFO: { ai_eq_list: [0, 7, 26], i_curr_eq: 7 },
    FUNC_VIEW_INFO: { ai_func_list: [1, 20], i_curr_func: 20 }
  };
  var writes = [];
  function connect(port, host) {
    assert.strictEqual(port, 9741);
    assert.strictEqual(host, target.host);
    var socket = new EventEmitter();
    socket.destroy = function () {};
    socket.write = function (frame) {
      var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      var request = JSON.parse(Buffer.concat([decipher.update(frame.slice(5)), decipher.final()]));
      var data = views[request.msg];
      if (request.cmd === 'set') {
        writes.push(request.data);
        if (!ignoreSet) Object.keys(request.data).forEach(function (field) { data[field] = request.data[field]; });
        return;
      }
      var cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      var raw = JSON.stringify({ cmd: 'notibyget', result: 'ok', msg: request.msg, data: data });
      var body = Buffer.concat([cipher.update(buffers.toBuffer(raw, 'utf8')), cipher.final()]);
      var header = buffers.allocBuffer(5);
      header[0] = 16;
      header.writeUInt32BE(body.length, 1);
      process.nextTick(function () {
        socket.emit('data', header.slice(0, 2));
        socket.emit('data', Buffer.concat([header.slice(2), body]));
      });
    };
    process.nextTick(function () { socket.emit('connect'); });
    return socket;
  }
  bar.request(target, change, function (error, device) {
    // Assertions must run outside the socket decoder's error handler.
    process.nextTick(function () { check(error, device, writes); });
  }, connect);
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
simulate(target, change, true, function (error) { assert.strictEqual(error, 'unconfirmed'); });
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
