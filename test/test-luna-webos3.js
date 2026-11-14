/**
 * test/test-luna-webos3.js - Service name fallback for older webOS
 *
 * luna.js tries the newer service names first. When the TV answers
 * "Service does not exist", it remembers and remaps every later call to
 * the legacy name. Covers both:
 *   com.webos.service.settings   -> com.webos.settingsservice
 *   com.webos.service.systemservice -> com.palm.systemservice
 */

var assert = require('assert');
var child = require('child_process');

console.log('Running test-luna-webos3.js ...');

var calls = [];
var nextResponse = null;

child.execFile = function (file, args, opts, cb) {
  var uri = args[args.length - 2].replace('luna://', '');
  calls.push(uri);
  var res = typeof nextResponse === 'function' ? nextResponse(uri) : nextResponse;
  process.nextTick(function () { cb(null, JSON.stringify(res)); });
};
child.spawn = function () {
  var EventEmitter = require('events').EventEmitter;
  var c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = function () {};
  return c;
};

// Fresh require for each scenario
function freshLuna() {
  delete require.cache[require.resolve('../server/lib/luna')];
  return require('../server/lib/luna');
}

// --- Scenario 1: newer TV, first call succeeds ---
calls = [];
nextResponse = { returnValue: true, settings: { backlight: '50' } };
var luna1 = freshLuna();

luna1.call('com.webos.service.settings/getSystemSettings', {}, function () {
  assert.strictEqual(calls[0], 'com.webos.service.settings/getSystemSettings',
    'newer TV: first call should use the new name');

  // Second call should still use the new name
  luna1.call('com.webos.service.settings/setSystemSettings', {}, function () {
    assert.strictEqual(calls[1], 'com.webos.service.settings/setSystemSettings',
      'newer TV: second call should keep the new name');
    console.log('  ✓ newer TV keeps com.webos.service.settings');

    // Non-settings URIs are never remapped
    luna1.call('com.webos.audio/getVolume', {}, function () {
      assert.strictEqual(calls[2], 'com.webos.audio/getVolume',
        'non-settings URI should pass through');
      console.log('  ✓ non-settings URIs are not touched');

      // --- Scenario 2: older TV, first call fails, retry with old name ---
      calls = [];
      var firstCall = true;
      nextResponse = function (uri) {
        if (firstCall && uri.indexOf('com.webos.service.settings') === 0) {
          firstCall = false;
          return {
            returnValue: false,
            errorCode: -1,
            errorText: 'Service does not exist: com.webos.service.settings.'
          };
        }
        return { returnValue: true, settings: { backlight: '50' } };
      };

      var luna2 = freshLuna();
      luna2.call('com.webos.service.settings/setSystemSettings', {}, function (res) {
        assert.strictEqual(calls[0], 'com.webos.service.settings/setSystemSettings',
          'older TV: first attempt should try the new name');
        assert.strictEqual(calls[1], 'com.webos.settingsservice/setSystemSettings',
          'older TV: retry should use the old name');
        assert.strictEqual(res.returnValue, true,
          'older TV: caller should get the successful retry result');
        console.log('  ✓ older TV falls back to com.webos.settingsservice on first call');

        // After fallback is learned, subsequent calls go straight to old name
        calls = [];
        luna2.call('com.webos.service.settings/getSystemSettings', {}, function () {
          assert.strictEqual(calls[0], 'com.webos.settingsservice/getSystemSettings',
            'older TV: subsequent calls should use the old name directly');
          console.log('  ✓ subsequent calls use the remembered old name');

          testSystemService();
        });
      });
    });
  });
});

// --- Scenario 3: systemservice fallback (NTP clock service) ---
function testSystemService() {
  calls = [];
  var firstCall = true;
  nextResponse = function (uri) {
    if (firstCall && uri.indexOf('com.webos.service.systemservice') === 0) {
      firstCall = false;
      return {
        returnValue: false,
        errorCode: -1,
        errorText: 'Service does not exist: com.webos.service.systemservice.'
      };
    }
    return { returnValue: true };
  };

  var luna3 = freshLuna();
  luna3.call('com.webos.service.systemservice/clock/setTime', {}, function (res) {
    assert.strictEqual(calls[0], 'com.webos.service.systemservice/clock/setTime',
      'systemservice: first attempt should try the new name');
    assert.strictEqual(calls[1], 'com.palm.systemservice/clock/setTime',
      'systemservice: retry should use com.palm.systemservice');
    assert.strictEqual(res.returnValue, true,
      'systemservice: caller should get the successful retry result');
    console.log('  ✓ older TV falls back to com.palm.systemservice for clock');

    // After fallback, subsequent calls go straight to old name
    calls = [];
    luna3.call('com.webos.service.systemservice/clock/getTime', {}, function () {
      assert.strictEqual(calls[0], 'com.palm.systemservice/clock/getTime',
        'systemservice: subsequent calls should use the old name directly');
      console.log('  ✓ subsequent clock calls use the remembered old name');

      testBothIndependent();
    });
  });
}

// --- Scenario 4: each service is probed independently ---
function testBothIndependent() {
  calls = [];
  nextResponse = function (uri) {
    // settings fails, systemservice succeeds
    if (uri.indexOf('com.webos.service.settings') === 0) {
      return {
        returnValue: false, errorCode: -1,
        errorText: 'Service does not exist: com.webos.service.settings.'
      };
    }
    return { returnValue: true };
  };

  var luna4 = freshLuna();
  // systemservice succeeds on first try
  luna4.call('com.webos.service.systemservice/clock/setTime', {}, function () {
    assert.strictEqual(calls[0], 'com.webos.service.systemservice/clock/setTime',
      'independent: systemservice should use the new name');
    console.log('  ✓ services are probed independently');

    testCaptureService();
  });
}

function testCaptureService() {
  calls = [];
  nextResponse = function (uri) {
    return { returnValue: false, errorText: uri.indexOf('com.webos.service.capture/') === 0 ? 'Service does not exist' : 'No video is playing' };
  };
  var transport = freshLuna();
  transport.call('com.webos.service.capture/executeOneShot', { method: 'VIDEO', width: 1920, height: 1080 }, function (r) {
    assert.strictEqual(r.errorText, 'No video is playing');
    assert.deepEqual(calls, ['com.webos.service.capture/executeOneShot', 'com.webos.service.tv.capture/executeOneShot']);
    transport.call('com.webos.service.capture/executeOneShot', {}, function () {
      assert.strictEqual(calls[2], 'com.webos.service.tv.capture/executeOneShot');
      calls = [];
      transport = freshLuna();
      nextResponse = { returnValue: false, errorText: 'No video is playing' };
      transport.call('com.webos.service.capture/executeOneShot', {}, function () {
        assert.strictEqual(calls.length, 1, 'a capture error is not a missing service');
        console.log('  ✓ capture fallback is remembered even when video capture fails');
        console.log('ALL test-luna-webos3.js assertions passed!\n');
      });
    });
  });
}
