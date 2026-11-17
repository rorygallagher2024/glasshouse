/**
 * test/test-mqtt-save-ui.js - Unit tests for MQTT settings save & restart UI behavior.
 * Verifies that button busy loading state and disabled state are properly cleared
 * after server restart or errors, preventing the button from being stuck in busy state.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var urlModule = require('url');

var URLSearchParamsClass = typeof URLSearchParams !== 'undefined'
  ? URLSearchParams
  : (urlModule.URLSearchParams || function () {
      return { get: function () { return null; } };
    });

console.log('Running test-mqtt-save-ui.js ...');

var nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 8) {
  console.log('  - skipped: UI files use async/await (needs Node 8+)');
  console.log('ALL test-mqtt-save-ui.js assertions passed!\n');
  process.exit(0);
}

function makeClassList() {
  var classes = {};
  return {
    add: function (c) { classes[c] = true; },
    remove: function (c) { delete classes[c]; },
    toggle: function (c, v) {
      if (v === undefined) v = !classes[c];
      if (v) classes[c] = true; else delete classes[c];
      return !!classes[c];
    },
    contains: function (c) { return !!classes[c]; }
  };
}

function createDOM() {
  var elements = {};
  function getEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id: id,
        value: '',
        textContent: '',
        className: '',
        disabled: false,
        hidden: false,
        classList: makeClassList(),
        dataset: {},
        addEventListener: function () {}
      };
    }
    return elements[id];
  }

  // Prepopulate form fields
  getEl('cfg-save-btn').disabled = false;
  getEl('cfg-enabled').classList.add('on');
  getEl('cfg-host').value = '192.168.1.50';
  getEl('cfg-port').value = '1883';
  getEl('cfg-tls').classList.remove('on');
  getEl('cfg-verify').classList.remove('on');
  getEl('cfg-user').value = 'homeassistant';
  getEl('cfg-pass').value = '';
  getEl('cfg-prefix').value = 'lg-tv';
  getEl('cfg-disc').value = 'homeassistant';
  getEl('cfg-interval').value = '10000';
  getEl('cfg-devid').value = 'lg_c2';
  getEl('cfg-devname').value = 'LG C2 OLED';

  return { elements: elements, getEl: getEl };
}

function runTest(name, scenario, done) {
  var dom = createDOM();
  var fetchLog = [];

  var context = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    loadUpdate: function () {},
    stopCpuPolling: function () {},
    cpuPanelOpen: function () { return false; },
    Date: Date,
    Promise: Promise,
    URLSearchParams: URLSearchParamsClass,
    location: { search: '' },
    window: { location: { search: '' }, innerWidth: 1024, addEventListener: function () {} },
    document: {
      querySelectorAll: function () { return []; },
      querySelector: function () { return null; },
      getElementById: function (id) { return dom.getEl(id); },
      addEventListener: function () {}
    },
    showTab: function () {},
    // core.js's: the full dashboard, not the remote on its own.
    remoteView: false,
    q: function (id) { return dom.getEl(id); },
    api: function (p) { return p; },
    t: function (k, d) { return d; },
    tick: function () {},
    cfgSyncEnabled: function () {},
    cfgSyncTls: function () {},
    renderEntitiesUI: function () {},
    renderMqttTopology: function () {},
    renderCfgStatus: function () {},
    cfgEntities: {},
    cfgCategories: {},
    cfgCatalogue: [],
    cfgPasswordSet: true,
    updateToggle: function () {},
    fetch: function (url, opts) {
      fetchLog.push({ url: url, opts: opts });
      return scenario.onFetch(url, opts);
    }
  };

  vm.createContext(context);

  var mainCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'ui', 'main.js'), 'utf8');
  var mqttCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'ui', 'mqtt.js'), 'utf8');

  // Extract functions needed for tests
  // main.js: waitForServer
  // mqtt.js: cfgMsg, loadSettings, saveSettings
  var snippet = [
    mainCode,
    mqttCode
  ].join('\n;\n');

  try {
    vm.runInContext(snippet, context);
  } catch (err) {
    return done(err);
  }

  scenario.run(context, dom, function (err) {
    if (err) return done(err);
    done(null);
  });
}

var tests = [
  {
    name: 'clears busy state and re-enables save button on successful save & restart',
    onFetch: function (url, opts) {
      if (url === '/api/settings' && opts && opts.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ ok: true }); }
        });
      }
      if (url === '/api/caps') {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (url === '/api/settings') {
        return Promise.resolve({
          ok: true,
          json: function () {
            return Promise.resolve({
              ok: true,
              writable: true,
              mqtt: { host: '192.168.1.50', port: 1883, username: 'test', passwordSet: true, topicPrefix: 'lg', discoveryPrefix: 'ha', telemetryIntervalMs: 10000, enabled: true, tls: false, tlsRejectUnauthorized: false },
              device: { id: 'lg_c2', name: 'LG C2 OLED' }
            });
          }
        });
      }
      return Promise.reject(new Error('Unknown url: ' + url));
    },
    run: function (context, dom, cb) {
      var saveBtn = dom.getEl('cfg-save-btn');
      assert.strictEqual(saveBtn.classList.contains('busy'), false);
      assert.strictEqual(saveBtn.disabled, false);

      context.cfgToggleIcons();
      var sent = null, realFetch = context.fetch;
      context.fetch = function (url, opts) {
        if (opts && opts.method === 'POST') sent = JSON.parse(opts.body);
        return realFetch(url, opts);
      };
      context.saveSettings().then(function () {
        assert.strictEqual(saveBtn.classList.contains('busy'), false, 'busy class must be removed');
        assert.strictEqual(saveBtn.disabled, false, 'button must be re-enabled');
        assert.strictEqual(dom.getEl('cfg-msg').textContent, 'Applied.', 'message must indicate applied');
        assert.strictEqual(sent.iconServer, true, 'the icon switch is saved with the form');
        cb();
      }).catch(cb);
    }
  },
  {
    name: 'clears busy state and re-enables save button on server rejection (ok: false)',
    onFetch: function (url, opts) {
      if (url === '/api/settings' && opts && opts.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ ok: false, error: 'Invalid MQTT port' }); }
        });
      }
      return Promise.reject(new Error('Unexpected fetch'));
    },
    run: function (context, dom, cb) {
      var saveBtn = dom.getEl('cfg-save-btn');
      context.saveSettings().then(function () {
        assert.strictEqual(saveBtn.classList.contains('busy'), false, 'busy class must be removed on error');
        assert.strictEqual(saveBtn.disabled, false, 'button must be re-enabled on error');
        assert.strictEqual(dom.getEl('cfg-msg').textContent, 'Invalid MQTT port');
        cb();
      }).catch(cb);
    }
  },
  {
    name: 'clears busy state and re-enables save button on network exception',
    onFetch: function () {
      return Promise.reject(new Error('Failed to fetch'));
    },
    run: function (context, dom, cb) {
      var saveBtn = dom.getEl('cfg-save-btn');
      context.saveSettings().then(function () {
        assert.strictEqual(saveBtn.classList.contains('busy'), false, 'busy class must be removed on network failure');
        assert.strictEqual(saveBtn.disabled, false, 'button must be re-enabled on network failure');
        assert.strictEqual(dom.getEl('cfg-msg').textContent, 'Failed to fetch');
        cb();
      }).catch(cb);
    }
  },
  {
    name: 'loadSettings sets disabled state without leaving busy class on non-writable configs',
    onFetch: function (url) {
      if (url === '/api/settings') {
        return Promise.resolve({
          ok: true,
          json: function () {
            return Promise.resolve({
              ok: true,
              writable: false,
              mqtt: { host: '192.168.1.50', port: 1883, username: 'test', passwordSet: true, topicPrefix: 'lg', discoveryPrefix: 'ha', telemetryIntervalMs: 10000, enabled: true, tls: false, tlsRejectUnauthorized: false },
              device: { id: 'lg_c2', name: 'LG C2 OLED' }
            });
          }
        });
      }
      return Promise.reject(new Error('Unexpected fetch'));
    },
    run: function (context, dom, cb) {
      var saveBtn = dom.getEl('cfg-save-btn');
      saveBtn.classList.add('busy');
      context.loadSettings().then(function () {
        assert.strictEqual(saveBtn.classList.contains('busy'), false, 'busy class must be removed when settings load');
        assert.strictEqual(saveBtn.disabled, true, 'button must be disabled for unwritable configs');
        cb();
      }).catch(cb);
    }
  }
];

function runNext(i) {
  if (i >= tests.length) {
    console.log('ALL test-mqtt-save-ui.js assertions passed!\n');
    process.exit(0);
    return;
  }
  var t = tests[i];
  runTest(t.name, t, function (err) {
    if (err) {
      console.error('FAIL: ' + t.name);
      console.error(err);
      process.exit(1);
    }
    console.log('  ✓ ' + t.name);
    runNext(i + 1);
  });
}

runNext(0);
