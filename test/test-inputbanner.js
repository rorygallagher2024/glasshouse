/**
 * test-inputbanner.js - lib/inputbanner.js: Back sent once, a moment after an
 * HDMI input with a SIMPLINK device comes to the front, to close LG's input
 * banner; never for another input, a port with nothing on SIMPLINK, a switch
 * away before it is due, the state at start, or with the switch off.
 */
var assert = require('assert');
var inputBanner = require('../server/lib/inputbanner');

var sent, config, saved;
var DEVICES = [
  { id: 'HDMI_1', appId: 'com.webos.app.hdmi1', subList: [{ id: 'SIMPLINK', osdName: 'Formuler Z11 P', cecpDevType: 4 }] },
  { id: 'HDMI_2', appId: 'com.webos.app.hdmi2', subList: [] },
  { id: 'HDMI_3', appId: 'com.webos.app.hdmi3', subList: [{ id: 'SIMPLINK', osdName: 'Sonos Beam', cecpDevType: 5 }] }
];

function setup(on) {
  sent = [];
  saved = [];
  config = { inputs: { closeBanner: on } };
  inputBanner.init({
    config: config,
    luna: function (uri, params, cb) {
      if (uri === 'com.webos.service.eim/getAllInputStatus') return cb({ returnValue: true, devices: DEVICES });
      sent.push([uri, params]);
      cb({ returnValue: true });
    },
    writeSettings: function (patch, cb) { saved.push(patch); cb(null); },
    delayMs: 2
  });
}

function after(ms, fn) { setTimeout(fn, ms); }

var steps = [];
function step(fn) { steps.push(fn); }
function next() {
  var fn = steps.shift();
  if (!fn) return console.log('ALL test-inputbanner.js assertions passed!');
  fn(next);
}

// An HDMI input with a SIMPLINK device: Back once, a moment after it comes to the front.
step(function (done) {
  setup(true);
  inputBanner.onAppChanged('com.webos.app.home');
  inputBanner.onAppChanged('com.webos.app.hdmi1');
  assert.strictEqual(sent.length, 0, 'not at once: the banner is not up yet');
  after(15, function () {
    assert.deepEqual(sent, [['com.webos.service.networkinput/test/sendKeyCode', { keyCode: 412 }]]);
    inputBanner.onAppChanged('com.webos.app.hdmi1');
    after(15, function () {
      assert.strictEqual(sent.length, 1, 'the same input again is no new switch');
      done();
    });
  });
});

// Nothing on SIMPLINK, only a sound bar on it, and other apps.
step(function (done) {
  setup(true);
  inputBanner.onAppChanged('com.webos.app.hdmi2');
  after(15, function () {
    assert.strictEqual(sent.length, 0, 'Back would reach the input app, not a device');
    inputBanner.onAppChanged('youtube.leanback.v4');
    inputBanner.onAppChanged('com.webos.app.acrhdmi1');
    after(15, function () {
      assert.strictEqual(sent.length, 0, 'not an HDMI input app');
      inputBanner.onAppChanged('com.webos.app.hdmi3');
      after(15, function () {
        assert.strictEqual(sent.length, 0, 'a sound bar takes no navigation keys');
        done();
      });
    });
  });
});

// Left before it was due, the state at start, or switched off: nothing.
step(function (done) {
  setup(true);
  inputBanner.onAppChanged('com.webos.app.hdmi1');
  inputBanner.onAppChanged('com.webos.app.home');
  inputBanner.onAppChanged('com.webos.app.hdmi1', true);
  after(15, function () {
    assert.strictEqual(sent.length, 0);
    setup(false);
    inputBanner.onAppChanged('com.webos.app.hdmi1');
    after(15, function () {
      assert.strictEqual(sent.length, 0, 'off by default');
      done();
    });
  });
});

// The switch is saved and shown.
step(function (done) {
  setup(false);
  assert.deepEqual(inputBanner.summary(), { closeBanner: false });
  inputBanner.setEnabled(true, function (r) {
    assert.strictEqual(r.ok, true);
    assert.deepEqual(saved, [{ inputs: { closeBanner: true } }]);
    assert.deepEqual(inputBanner.summary(), { closeBanner: true });
    done();
  });
});

next();
