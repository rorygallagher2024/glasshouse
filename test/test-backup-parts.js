/**
 * test/test-backup-parts.js - The settings a backup carries beyond LG's rows,
 * and that every control is either carried or left out for a reason
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var parts = require('../server/lib/backup-parts');
var backup = require('../server/lib/backup');

console.log('Running test-backup-parts.js ...');

function copy(v) { return JSON.parse(JSON.stringify(v)); }

/*
 * A TV as the parts see it: LG's settings by category and key, and what each
 * module answers. controls records each call and changes the TV as it would.
 */
function fakeTv(opts) {
  var tv = {
    settings: copy(opts.settings),
    timeFormat: opts.timeFormat || 'HH24',
    lmt: opts.lmt,
    acr: opts.acr,
    adBlock: opts.adBlock || 'off',
    custom: opts.custom || null,
    services: copy(opts.services || {}),
    pages: copy(opts.pages || []),
    keys: copy(opts.keys || {}),
    quick: copy(opts.quick || {}),
    savers: opts.savers || ['stock'],
    saver: { mode: 'stock', level: 'dim' },
    config: {},
    controls: [],
    alwaysOn: !!opts.alwaysOn
  };
  var luna = function (uri, p, cb) {
    var r = { returnValue: true };
    if (uri === 'com.webos.service.settings/getSystemSettings') {
      var cat = tv.settings[p.category] || {};
      r.settings = {};
      p.keys.forEach(function (k) { if (cat[k] !== undefined) r.settings[k] = cat[k]; });
    } else if (uri === 'com.webos.settingsservice/getSystemSettings') {
      r.settings = tv.lmt === undefined ? {} : { lmt: tv.lmt };
    } else if (uri === 'com.webos.service.systemservice/getPreferences') {
      r.timeFormat = tv.timeFormat;
    } else if (uri === 'com.webos.applicationManager/listLaunchPoints') {
      r.launchPoints = [{ id: 'netflix', title: 'Netflix' }].concat(tv.pages.map(function (pg, i) {
        return { id: 'com.webos.app.browser', lptype: 'bookmark', launchPointId: String(i), title: pg.title, params: { target: pg.address } };
      }));
    }
    process.nextTick(function () { cb(r); });
  };
  var control = function (action, value, cb) {
    tv.controls.push([action, value]);
    if (action === 'lgLogo') tv.settings.other.lgLogoDisplay = value ? 'on' : 'off';
    if (action === 'clockHour12') tv.timeFormat = value ? 'HH12' : 'HH24';
    if (action === 'setAdBlock') tv.adBlock = value;
    if (action === 'screensaverMode') tv.saver = value;
    if (action === 'screensaverPowerOff') tv.config.screensaverPowerOffMinutes = value || undefined;
    process.nextTick(function () { cb({ ok: true }); });
  };
  var modules = {
    luna: luna,
    control: control,
    config: tv.config,
    alwaysOnSupported: function (cb) { cb(tv.alwaysOn); },
    home: { autoLaunchHeld: function () { return false; } },
    privacy: {
      collectPrivacy: function (cb) { cb({ acr: tv.acr === undefined ? undefined : { consentOn: tv.acr } }); },
      adBlockMode: function () { return tv.adBlock; },
      customHosts: function () { return tv.custom; },
      setCustomHosts: function (o, cb) {
        tv.controls.push(['customHosts', o]);
        if (o.clear) tv.custom = null;
        else if (o.text) tv.custom = { mode: o.mode, names: o.text.split('\n'), enabled: true };
        else tv.custom.enabled = o.enabled;
        cb({ ok: true });
      }
    },
    services: {
      getServices: function (cb) {
        cb({ ok: true, supported: true, services: Object.keys(tv.services).map(function (id) { return { id: id, disabled: tv.services[id] }; }) });
      },
      toggleService: function (id, off, cb) { tv.controls.push(['service', id, off]); tv.services[id] = off; cb({ ok: true }); }
    },
    apps: {
      addSavedPage: function (address, title, cb) { tv.controls.push(['addPage', address]); tv.pages.push({ title: title, address: address }); cb({ ok: true }); }
    },
    remoteKeys: {
      getRemoteKeys: function (cb) {
        cb({ ok: true, supported: true, keys: Object.keys(tv.keys).map(function (k) {
          var v = tv.keys[k];
          return { key: k, action: v === null ? 'lg' : v === '' ? 'nothing' : 'open', id: v || '' };
        }) });
      },
      setRemoteKey: function (key, action, id, cb) {
        tv.controls.push(['remoteKey', key, action, id]);
        if (id === 'missing.app') return cb({ ok: false, error: 'not installed' });
        tv.keys[key] = action === 'lg' ? null : action === 'nothing' ? '' : id;
        cb({ ok: true });
      }
    },
    quickAccess: {
      getQuickAccess: function (cb) {
        cb({ ok: true, supported: true, keys: Object.keys(tv.quick).map(function (k) { return { key: Number(k), id: tv.quick[k] }; }) });
      },
      setQuickAccess: function (n, id, cb) { tv.controls.push(['quickAccess', n, id]); tv.quick[String(n)] = id; cb({ ok: true }); }
    },
    screensavers: {
      screensaverMode: function () { return tv.saver.mode; },
      screensaverLevel: function () { return tv.saver.level; },
      screensaverList: function () { return tv.savers.map(function (id) { return { id: id, available: true }; }); }
    }
  };
  tv.use = function () {
    parts.init(modules);
    backup.init({ parts: parts, config: {}, lgSettings: { collect: function (s, cb) { cb({ ok: true, rows: [] }); }, set: function () {} } });
  };
  return tv;
}

// A C2 (webOS 9.2) with its LG logo off, set up as its owner likes.
var C2 = {
  settings: {
    other: { lgLogoDisplay: 'off', ueiEnable: 'off' },
    option: { quickStartMode: 'on', standByLight: 'off' },
    network: { wolwowlOnOff: 'true' },
    general: { alwaysOn: 'off', alwaysOnDisableStartHour: '2', lifeOnScreenMode: 'off', homeAutoLaunch: 'off' }
  },
  timeFormat: 'HH12', lmt: 'on', acr: true, adBlock: 'ads',
  custom: { mode: 'add', names: ['ads.example.com'], enabled: false },
  services: { nudge: true, remotelogger: false },
  pages: [{ title: 'home assistant', address: 'http://192.168.1.125:8123' }],
  keys: { netflix: 'youtube.leanback.v4', amazon: null, red: '' },
  quick: { 1: 'netflix', 2: '' },
  savers: ['stock', 'aquarium'], alwaysOn: true
};

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function next() {
  var s = steps.shift();
  if (!s) return console.log('All backup parts tests passed.');
  s.fn(function () { console.log('  ✓ ' + s.name); next(); });
}

var saved = null;

step('a backup holds LG\'s own switches, privacy, apps, keys and the screen saver', function (done) {
  var tv = fakeTv(C2);
  tv.saver = { mode: 'aquarium', level: 'bright' };
  tv.config.screensaverPowerOffMinutes = 120;
  tv.use();
  backup.create(function (b) {
    saved = b;
    assert.deepEqual(b.settings, {
      lgLogo: false, quickBoot: true, wakeOnLan: true, deviceDetection: false, standbyLight: false,
      alwaysOn: false, alwaysOnOffStart: 2, alwaysReadyScreen: false, homeAutoLaunch: false, clockHour12: true,
      limitAdTracking: true, acr: true, adBlock: 'ads',
      adBlockList: { mode: 'add', names: ['ads.example.com'], enabled: false },
      services: { nudge: true, remotelogger: false },
      savedPages: [{ title: 'home assistant', address: 'http://192.168.1.125:8123' }],
      remoteKeys: { netflix: 'youtube.leanback.v4', amazon: null, red: '' },
      quickAccess: { 1: 'netflix', 2: '' },
      screensaver: { mode: 'aquarium', level: 'bright' },
      screensaverPowerOff: 120
    });
    done();
  });
});

step('a TV without a setting leaves it out of its backup', function (done) {
  var tv = fakeTv({ settings: { other: {}, option: { standByLight: 'on' }, network: {}, general: { alwaysOn: 'on' } } });
  tv.use();
  backup.create(function (b) {
    ['lgLogo', 'quickBoot', 'wakeOnLan', 'alwaysOn', 'alwaysOnOffStart', 'limitAdTracking', 'acr'].forEach(function (id) {
      assert.ok(!(id in b.settings), id + ' left out');
    });
    assert.strictEqual(b.settings.standbyLight, true);
    done();
  });
});

step('a restore sets each through its control, only where this TV has it', function (done) {
  // A B8 (webOS 4.4): no LG logo setting or Always-on, ACR off, other services and keys.
  var tv = fakeTv({
    settings: { other: { ueiEnable: 'off' }, option: { quickStartMode: 'off', standByLight: 'off' },
                network: { wolwowlOnOff: 'true' }, general: { alwaysOn: 'on', homeAutoLaunch: 'off' } },
    acr: false, services: { nudge: false, contentminer: true },
    pages: [{ title: 'HA', address: 'http://192.168.1.125:8123' }],
    keys: { netflix: null, amazon: null }, quick: { 1: '', 2: '' }
  });
  var wanted = copy(saved.settings);
  wanted.remoteKeys.amazon = 'missing.app';
  wanted.savedPages.push({ title: 'Weather', address: 'https://example.com/weather' });
  tv.use();
  backup.restore({ format: 'glasshouse-backup', version: 1, settings: wanted }, function (r) {
    assert.strictEqual(r.ok, true);
    var skipped = {};
    r.lg.skipped.forEach(function (s) { skipped[s.id] = s.reason; });
    assert.deepEqual(skipped, {
      lgLogo: 'absent', alwaysOn: 'absent', alwaysOnOffStart: 'absent', alwaysReadyScreen: 'absent', limitAdTracking: 'absent',
      acr: 'consent', screensaver: 'absent'
    });
    assert.ok(r.lg.applied.indexOf('quickBoot') !== -1);
    assert.deepEqual(tv.services, { nudge: true, contentminer: true }, 'a service only one TV lists is left as it is');
    assert.deepEqual(tv.pages.map(function (p) { return p.address; }),
      ['http://192.168.1.125:8123', 'https://example.com/weather'], 'a page already saved is not added again');
    assert.deepEqual(tv.keys, { netflix: 'youtube.leanback.v4', amazon: null }, 'a key this TV lacks is left out');
    assert.deepEqual(r.lg.failed, [{ id: 'remoteKeys', error: 'amazon' }], 'an app this TV lacks is named');
    assert.deepEqual(tv.quick, { 1: 'netflix', 2: '' });
    assert.strictEqual(tv.config.screensaverPowerOffMinutes, 120);
    assert.deepEqual(tv.custom, { mode: 'add', names: ['ads.example.com'], enabled: false }, 'the list, switched off as it was');
    assert.ok(!tv.controls.some(function (c) { return c[0] === 'acr'; }), 'ACR is never switched on');
    done();
  });
});

step('the same settings restored again change nothing', function (done) {
  var tv = fakeTv(C2);
  tv.saver = { mode: 'aquarium', level: 'bright' };
  tv.config.screensaverPowerOffMinutes = 120;
  tv.use();
  backup.restore({ format: 'glasshouse-backup', version: 1, settings: saved.settings }, function (r) {
    assert.deepEqual(r.lg.applied, []);
    assert.deepEqual(r.lg.skipped, []);
    assert.deepEqual(tv.controls, []);
    done();
  });
});

step('a value the setting cannot take is skipped, and ACR switches off', function (done) {
  var tv = fakeTv(C2);
  tv.use();
  backup.restore({ format: 'glasshouse-backup', version: 1, settings: {
    lgLogo: 'off', adBlock: 'everything', savedPages: [{ title: 'x', address: 'file:///etc/passwd' }],
    acr: false, nonsense: 1
  } }, function (r) {
    var skipped = {};
    r.lg.skipped.forEach(function (s) { skipped[s.id] = s.reason; });
    assert.deepEqual(skipped, { lgLogo: 'value', adBlock: 'value', savedPages: 'value', nonsense: 'absent' });
    assert.deepEqual(tv.controls, [['acr', false]]);
    done();
  });
});

step('every control is carried by a backup or left out for a reason', function (done) {
  var src = fs.readFileSync(path.join(__dirname, '../server/lib/controls.js'), 'utf8');
  var cases = [];
  src.replace(/^    case '([A-Za-z0-9_]+)':/gm, function (m, id) { if (cases.indexOf(id) === -1) cases.push(id); });
  var carried = parts.PARTS.map(function (p) { return p.action; }).filter(Boolean);
  var missing = cases.filter(function (c) { return carried.indexOf(c) === -1 && !parts.NOT_CARRIED.hasOwnProperty(c); });
  assert.deepEqual(missing, [], 'add these to backup-parts.js\'s PARTS, or to NOT_CARRIED with a reason');
  var both = carried.filter(function (c) { return parts.NOT_CARRIED.hasOwnProperty(c); });
  assert.deepEqual(both, [], 'both carried and left out');
  var gone = Object.keys(parts.NOT_CARRIED).filter(function (c) { return cases.indexOf(c) === -1; });
  assert.deepEqual(gone, [], 'no longer a control');
  var sections = [];
  require('../server/lib/lgsettings').ROWS.forEach(function (r) { if (sections.indexOf(r.section) === -1) sections.push(r.section); });
  sections.forEach(function (s) {
    assert.ok(backup.SECTIONS.indexOf(s) !== -1 || backup.SECTIONS_NOT_CARRIED.indexOf(s) !== -1,
      'lgsettings.js\'s ' + s + ' section is neither in a backup nor left out');
  });
  done();
});

next();
