/**
 * test/test-apps.js - Unit tests for application management and tile hiding
 */

require('./fake-clock').install();
var assert = require('assert');
var path = require('path');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var apps = require('../server/lib/apps');
var samrescan = require('../server/lib/samrescan');

// Commands apps.js would run on the TV, recorded instead: on a computer they
// would restart its own services or ask for a password (#918).
var ran = [];
function fakeExec(file, args, opts, cb) {
  ran.push(file + ' ' + (args || []).join(' '));
  process.nextTick(function () { cb(null, '', ''); });
  return {};
}
function init(opts) {
  opts.exec = fakeExec;
  apps.init(opts);
}

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('isProtected strictly protects core TV system services', function () {
  var protectedIds = [
    'com.tvweb.dashboard',
    'com.webos.app.browser',
    'org.webosbrew.hbchannel',
    'com.webos.app.livetv',
    'com.palm.app.settings',
    'com.webos.app.settings',
    'com.webos.app.container',
    'container',
    'com.webos.app.inputcommon',
    'inputcommon',
    'com.webos.app.home',
    'com.webos.app.firstuse',
    'firstuse',
    'com.webos.app.eula',
    'eula',
    'com.webos.app.webapphost',
    'webapphost',
    'com.webos.app.hdmi1',
    'com.webos.app.hdmi2',
    'com.webos.app.hdmi3',
    'com.webos.app.hdmi4'
  ];

  protectedIds.forEach(function (id) {
    assert.strictEqual(apps.isProtected(id), true, id + ' must be protected');
  });
});

test('Home Assistant names apps, keeping each option distinct', function () {
  var ha = require('../server/lib/ha');
  var byId = ha.appNames([{ id: 'netflix', title: 'Netflix' }, { id: 'x.other', title: 'Netflix' },
                          { id: 'no.title' }]);
  assert.strictEqual(byId.netflix, 'Netflix');
  assert.strictEqual(byId['x.other'], 'Netflix (x.other)');
  assert.strictEqual(byId['no.title'], 'no.title');
  assert.strictEqual(ha.appNames([])['youtube.leanback.v4'], 'YouTube');
});

test('isProtected allows normal user and LG bloatware apps', function () {
  var normalIds = [
    'com.webos.app.igallery',
    'com.webos.app.music',
    'com.webos.app.photovideo',
    'com.webos.app.tvuserguide',
    'com.webos.app.sportsteamsettings',
    'com.webos.app.homeconnect',
    'com.webos.app.lifeonscreen',
    'com.webos.app.camera',
    'youtube.leanback.v4',
    'netflix',
    'spotify-beehive'
  ];

  normalIds.forEach(function (id) {
    assert.strictEqual(apps.isProtected(id), false, id + ' should not be protected');
  });
});

test('isProtected rejects invalid, non-string, or empty IDs', function () {
  assert.strictEqual(apps.isProtected(''), true);
  assert.strictEqual(apps.isProtected(null), true);
  assert.strictEqual(apps.isProtected(undefined), true);
  assert.strictEqual(apps.isProtected(123), true);
});

test('hideTile rejects protected apps and invalid IDs', function () {
  init({ config: { allowControl: true } });

  apps.hideTile('com.webos.app.livetv', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });

  apps.hideTile('com.tvweb.dashboard', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });

  apps.hideTile('../etc/passwd', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Invalid') !== -1);
  });
});

test('uninstallApp strictly rejects protected applications', function () {
  init({ config: { allowControl: true } });

  ['com.tvweb.dashboard', 'com.tvweb.home'].forEach(function (id) {
  apps.uninstallApp(id, function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });

  });

  apps.uninstallApp('org.webosbrew.hbchannel', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });
});

test('uninstallApp invokes appInstallService and waits for removal from listApps', function (done) {
  var appsInList = [{ id: 'test.app.dummy' }];
  var removeCalled = false;

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.appInstallService/remove') {
      removeCalled = true;
      setTimeout(function () {
        appsInList = [];
      }, 50);
      return cb({ returnValue: true });
    }
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ apps: appsInList });
    }
    cb({ returnValue: false });
  };

  init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.uninstallApp('test.app.dummy', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.id, 'test.app.dummy');
    assert.strictEqual(removeCalled, true);
    assert.strictEqual(appsInList.length, 0);
    if (done) done();
  });
});

test('readHiddenAppsList filters out protected IDs', function () {
  var hiddenFile = '/var/lib/tvweb/hidden_apps';
  mockEnv.files[hiddenFile] = 'com.webos.app.igallery\ncom.webos.app.livetv\ncom.webos.app.music\n';

  try {
    var map = apps.readHiddenAppsList();
    assert.strictEqual(map['com.webos.app.igallery'], true);
    assert.strictEqual(map['com.webos.app.music'], true);
    assert.strictEqual(map['com.webos.app.livetv'], undefined, 'Protected app must be filtered from hidden map');
  } finally {
    delete mockEnv.files[hiddenFile];
  }
});

test('getApps segregates removable apps and built-in system tiles', function (done) {
  var mockAppsList = [
    {
      id: 'youtube.leanback.v4',
      title: 'YouTube',
      removable: true,
      systemApp: false,
      folderPath: '/media/cryptofs/apps/usr/palm/applications/youtube.leanback.v4',
      appsize: 42455683
    },
    {
      id: 'com.webos.app.igallery',
      title: 'Gallery',
      removable: false,
      systemApp: true,
      folderPath: '/usr/palm/applications/com.webos.app.igallery'
    },
    {
      id: 'com.tvweb.dashboard',
      title: 'Glasshouse',
      removable: true,
      systemApp: false,
      folderPath: '/media/developer/apps/usr/palm/applications/com.tvweb.dashboard'
    },
    {
      id: 'com.webos.app.livetv',
      title: 'Live TV',
      removable: false,
      systemApp: true,
      folderPath: '/usr/palm/applications/com.webos.app.livetv'
    }
  ];

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ apps: mockAppsList });
    }
    if (uri === 'com.webos.applicationManager/listLaunchPoints') {
      return cb({ launchPoints: mockAppsList });
    }
    cb({ returnValue: false });
  };

  init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.getApps(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.writable, true);

    // Protected apps must be excluded
    var allIds = res.installed.concat(res.systemTiles).map(function (x) { return x.id; });
    assert.strictEqual(allIds.indexOf('com.tvweb.dashboard'), -1);
    assert.strictEqual(allIds.indexOf('com.webos.app.livetv'), -1);

    // YouTube in installed
    var yt = res.installed.filter(function (x) { return x.id === 'youtube.leanback.v4'; })[0];
    assert.ok(yt, 'YouTube should be in installed');
    assert.strictEqual(yt.removable, true);
    assert.strictEqual(yt.size, 42455683, 'YouTube size matches appsize');

    // Gallery in systemTiles
    var gal = res.systemTiles.filter(function (x) { return x.id === 'com.webos.app.igallery'; })[0];
    assert.ok(gal, 'Gallery should be in systemTiles');
    assert.strictEqual(gal.systemApp, true);
    assert.strictEqual(gal.hidden, false);

    if (done) done();
  });
});

test('APP_BASES prioritizes /media/system/apps', function () {
  assert.strictEqual(apps.APP_BASES[0], '/media/system/apps/usr/palm/applications');
});

test('findAllAppinfoPaths discovers apps across multiple bases', function () {
  var p1 = '/media/system/apps/usr/palm/applications/com.webos.app.browser/appinfo.json';
  var p2 = '/mnt/otncabi/usr/palm/applications/com.webos.app.browser/appinfo.json';
  mockEnv.files[p1] = JSON.stringify({ id: 'com.webos.app.browser', version: '4.1.15' });
  mockEnv.files[p2] = JSON.stringify({ id: 'com.webos.app.browser', version: '2.0.0' });

  try {
    var all = apps.findAllAppinfoPaths('com.webos.app.browser');
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0], p1);
    assert.strictEqual(all[1], p2);
    assert.strictEqual(apps.findAppinfoPath('com.webos.app.browser'), p1);
  } finally {
    delete mockEnv.files[p1];
    delete mockEnv.files[p2];
  }
});

test('getApps categorizes /media/system apps as built-in system tiles', function (done) {
  var mockAppsList = [
    {
      id: 'com.webos.app.music',
      title: 'Music',
      removable: false,
      systemApp: true,
      folderPath: '/media/system/apps/usr/palm/applications/com.webos.app.music'
    },
    {
      id: 'com.webos.app.lgchannels',
      title: 'LG Channels',
      removable: false,
      systemApp: true,
      folderPath: '/media/system/apps/usr/palm/applications/com.webos.app.lgchannels'
    }
  ];

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ apps: mockAppsList });
    }
    if (uri === 'com.webos.applicationManager/listLaunchPoints') {
      return cb({ launchPoints: mockAppsList });
    }
    cb({ returnValue: false });
  };

  init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.getApps(function (res) {
    assert.strictEqual(res.ok, true);
    var music = res.systemTiles.filter(function (x) { return x.id === 'com.webos.app.music'; })[0];
    assert.ok(music, 'Music should be in systemTiles');
    assert.strictEqual(music.systemApp, true);

    var lgch = res.systemTiles.filter(function (x) { return x.id === 'com.webos.app.lgchannels'; })[0];
    assert.ok(lgch, 'LG Channels should be in systemTiles');
    assert.strictEqual(lgch.systemApp, true);

    if (done) done();
  });
});

test('isTileHidingEnabled detects flag file and auto-migrates from hidden_apps', function () {
  var flagFile = '/var/lib/tvweb/tile_hiding_enabled';
  var hiddenFile = '/var/lib/tvweb/hidden_apps';

  delete mockEnv.files[flagFile];
  delete mockEnv.files[hiddenFile];
  assert.strictEqual(apps.isTileHidingEnabled(), false);

  mockEnv.files[flagFile] = '1\n';
  assert.strictEqual(apps.isTileHidingEnabled(), true);

  mockEnv.files[flagFile] = '0\n';
  assert.strictEqual(apps.isTileHidingEnabled(), false, 'Explicit 0 in flag file must evaluate to false');

  delete mockEnv.files[flagFile];
  mockEnv.files[hiddenFile] = 'com.webos.app.igallery\n';
  assert.strictEqual(apps.isTileHidingEnabled(), true);
  assert.strictEqual(mockEnv.files[flagFile].trim(), '1', 'Should auto-create flag file with 1 when hidden_apps has content');

  // Even if hidden_apps exists, if flag file is set to '0', it stays disabled
  mockEnv.files[flagFile] = '0\n';
  assert.strictEqual(apps.isTileHidingEnabled(), false, 'Explicitly disabled flag must override existing hidden_apps file');

  delete mockEnv.files[flagFile];
  delete mockEnv.files[hiddenFile];
});

test('setTileHidingEnabled toggles flag file, requires allowControl, and restarts sam only on webOS 4 to 6', function (done) {
  var flagFile = '/var/lib/tvweb/tile_hiding_enabled';
  var appJson = '/usr/palm/applications/com.webos.app.gallery/appinfo.json';
  var blockSchema = '/etc/palm/schemas/sam/applicationManager.blockSystemApp.schema';

  // Disabled when allowControl is false
  init({ config: { allowControl: false } });
  apps.setTileHidingEnabled(true, function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('disabled') !== -1);

    // webOS 4-6: neither blockedAppList nor blockSystemApp, so tile hiding
    // works as before, with sam restarted to read the change.
    mockEnv.files[appJson] = '{"id":"com.webos.app.gallery","title":"Gallery","visible":true}';
    mockEnv.files[blockSchema] = null;
    var noRescanLuna = function (uri, params, cb) {
      if (uri === 'com.webos.service.config/getConfigs') return cb({ returnValue: true, configs: {}, missingConfigs: [samrescan.KEY] });
      cb({ returnValue: true, launchPoints: [{ id: 'netflix' }] });
    };
    init({ luna: noRescanLuna, config: { allowControl: true, allowTileHiding: true } });
    samrescan.init({ luna: noRescanLuna, nudgeMs: 5, pollMs: 5, blockSchema: blockSchema });
    ran = [];
    function samRestarts() {
      return ran.filter(function (c) { return /kill|initctl restart sam/.test(JSON.stringify(c)); }).length;
    }
    apps.setTileHidingEnabled(true, function (oldRes) {
      assert.strictEqual(oldRes.ok, true, oldRes.error);
      assert.strictEqual(oldRes.tileHidingEnabled, true);

      apps.hideTile('com.webos.app.gallery', function (oldHide) {
        assert.strictEqual(oldHide.ok, true, oldHide.error);
        assert.strictEqual(oldHide.hidden, true);
        assert.strictEqual(samRestarts(), 1, 'sam restarted once to read the hidden tile');

        apps.unhideTile('com.webos.app.gallery', function (oldUnhide) {
          assert.strictEqual(oldUnhide.ok, true, oldUnhide.error);
          assert.strictEqual(samRestarts(), 2, 'and once to show it again');

        // Enabled when allowControl, allowTileHiding, and configd rescan list exist
        var nudgeLuna = function (uri, params, cb) {
          if (uri === 'com.webos.service.config/getConfigs') {
            var c = {};
            c[samrescan.KEY] = [];
            return cb({ returnValue: true, configs: c });
          }
          cb({ returnValue: true, launchPoints: [{ id: 'netflix' }] });
        };
        init({ luna: nudgeLuna, config: { allowControl: true, allowTileHiding: true } });
        samrescan.init({ luna: nudgeLuna, nudgeMs: 5, pollMs: 5, blockSchema: blockSchema });

        apps.setTileHidingEnabled(true, function (r1) {
          assert.strictEqual(r1.ok, true);
          assert.strictEqual(r1.tileHidingEnabled, true);
          assert.strictEqual(r1.samRestarted, false);
          assert.strictEqual(mockEnv.files[flagFile].trim(), '1');

          apps.setTileHidingEnabled(false, function (r2) {
            assert.strictEqual(r2.ok, true);
            assert.strictEqual(r2.tileHidingEnabled, false);
            assert.strictEqual(mockEnv.files[flagFile].trim(), '0');
            delete mockEnv.files[appJson];
            delete mockEnv.files[blockSchema];
            if (done) done();
          });
        });
        });
      });
    });
  });
});

test('tile hiding on webOS 10-11 uses blockSystemApp, settles launchPoints, and rolls back refused hides', function (done) {
  var blockSchema = '/etc/palm/schemas/sam/applicationManager.blockSystemApp.schema';
  var galleryJson = '/usr/palm/applications/com.webos.app.gallery/appinfo.json';
  var musicJson = '/usr/palm/applications/com.webos.app.music/appinfo.json';
  var galleryOvr = '/var/lib/tvweb/appinfo-overrides/com.webos.app.gallery.json';
  var musicOvr = '/var/lib/tvweb/appinfo-overrides/com.webos.app.music.json';
  var hiddenFile = '/var/lib/tvweb/hidden_apps';
  var flagFile = '/var/lib/tvweb/tile_hiding_enabled';

  mockEnv.files[blockSchema] = '{"properties":{"id":{},"forceBlockSystemApp":{}}}';
  mockEnv.files[galleryJson] = '{"id":"com.webos.app.gallery","title":"Gallery","visible":true}';
  mockEnv.files[musicJson] = '{"id":"com.webos.app.music","title":"Music","visible":true}';
  mockEnv.files[hiddenFile] = '';
  mockEnv.files[flagFile] = '1\n';

  var partial = [{ id: 'netflix' }, { id: 'youtube.leanback.v4' }];
  var full = partial.concat([{ id: 'com.webos.app.browser' }]);
  var reads = [null, partial, partial, full, full, full, full];
  var lpReads = 0;
  var settledOn = 0;
  var visibleState = { 'com.webos.app.gallery': true, 'com.webos.app.music': true };
  var applyVisibility = { 'com.webos.app.gallery': true };
  var samCalls = [];
  var mountedTargets = {};
  ran = [];

  var execWithMounts = function (file, args, opts, cb) {
    ran.push(file + ' ' + (args || []).join(' '));
    if (file === '/bin/mount' && (!args || args.length === 0)) {
      var out = Object.keys(mountedTargets).map(function (t) { return '/dev/tmp ' + t + ' ext4 rw 0 0'; }).join('\n');
      return process.nextTick(function () { cb(null, out, ''); });
    }
    if (file === '/bin/mount' && args && args[0] === '--bind') {
      mountedTargets[args[2]] = true;
    } else if (file === '/bin/umount' && args && args[1]) {
      delete mountedTargets[args[1]];
    }
    process.nextTick(function () { cb(null, '', ''); });
    return {};
  };

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.service.config/getConfigs') {
      return cb({ returnValue: true, configs: {}, missingConfigs: [samrescan.KEY] });
    }
    if (uri === 'com.webos.applicationManager/blockSystemApp') {
      samCalls.push(['block', params.id, params.forceBlockSystemApp]);
      return cb({ returnValue: true });
    }
    if (uri === 'com.webos.applicationManager/releaseBlockSystemApp') {
      samCalls.push(['release', params.id]);
      if (params.id in applyVisibility) visibleState[params.id] = applyVisibility[params.id];
      // com.webos.app.music is absent from applyVisibility so it stays visible (simulating refusal)
      return cb({ returnValue: true });
    }
    if (uri === 'com.webos.applicationManager/getAppInfo') {
      return cb({ returnValue: true, appInfo: { id: params.id, visible: visibleState[params.id] !== false } });
    }
    if (uri === 'com.webos.applicationManager/listLaunchPoints') {
      var lps = reads[Math.min(lpReads++, reads.length - 1)];
      if (lps === full) settledOn++;
      return cb(lps ? { returnValue: true, launchPoints: lps } : { returnValue: false });
    }
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ returnValue: true, apps: [{ id: 'com.webos.app.gallery', title: 'Gallery', visible: visibleState['com.webos.app.gallery'], systemApp: true }] });
    }
    cb({ returnValue: true });
  };

  apps.init({ luna: mockLuna, exec: execWithMounts, config: { allowControl: true, allowTileHiding: true } });
  samrescan.init({ luna: mockLuna, nudgeMs: 5, pollMs: 5, blockSchema: blockSchema });

  // Batching: concurrent restartSamShared callers share rescan and wait for launchPoints to settle
  var answered = 0;
  var onBatchDone = function (restarted) {
    assert.strictEqual(restarted, true);
    answered++;
    if (answered < 2) return;
    assert.ok(settledOn >= 3, 'waited for full launchPoints reads before answering');
    assert.ok(!ran.some(function (c) { return /kill|systemctl|initctl/.test(c); }), 'sam never restarted');

    samCalls = [];
    applyVisibility['com.webos.app.gallery'] = false;
    apps.hideTile('com.webos.app.gallery', function (h) {
      assert.strictEqual(h.ok, true, h.error);
      assert.strictEqual(h.hidden, true);
      assert.deepEqual(samCalls, [
        ['block', 'com.webos.app.gallery', false],
        ['release', 'com.webos.app.gallery']
      ]);
      assert.ok(mockEnv.files[hiddenFile].indexOf('com.webos.app.gallery') !== -1);
      assert.ok(!ran.some(function (c) { return /kill|systemctl|initctl/.test(c); }), 'never restarted sam for hideTile');

      apps.getApps(function (g) {
        assert.strictEqual(g.tileHidingNudge, true, 'tileHidingNudge is true when blockSystemApp schema exists');

        // Refused hide rolls back mount, override json, and hidden_apps
        apps.hideTile('com.webos.app.music', function (failRes) {
          assert.strictEqual(failRes.ok, false);
          assert.strictEqual(failRes.hidden, false);
          assert.ok(failRes.error && failRes.error.length > 0);
          assert.strictEqual(!!mountedTargets[musicJson], false, 'refused hide unmounts bind-mount');
          assert.strictEqual(!!mockEnv.files[musicOvr], false, 'refused hide removes override file');
          assert.strictEqual(mockEnv.files[hiddenFile].indexOf('com.webos.app.music'), -1, 'refused hide removes id from hidden_apps');
          assert.ok(!ran.some(function (c) { return /kill|systemctl|initctl/.test(c); }), 'still never restarted sam');

          delete mockEnv.files[blockSchema];
          delete mockEnv.files[galleryJson];
          delete mockEnv.files[musicJson];
          delete mockEnv.files[galleryOvr];
          delete mockEnv.files[hiddenFile];
          delete mockEnv.files[flagFile];
          if (done) done();
        });
      });
    });
  };
  var e1 = { 'com.webos.app.gallery': true };
  apps.restartSamShared(onBatchDone, e1);
  apps.restartSamShared(onBatchDone, e1);
});

test('dirSize computes folder size on disk', function () {
  var dir = path.join(__dirname, 'mocks');
  var sz = apps.dirSize(dir);
  assert.strictEqual(typeof sz, 'number');
  assert.ok(sz > 0, 'dirSize should be positive for mock directory');
});

var failures = 0;

/*
 * One at a time: the tests share the apps module, and an uninstall can now
 * restart sam, which would join a restart test's shared restart.
 */
(function next(i) {
  if (i === tests.length) return finish();
  var t = tests[i];
  function fail(e) {
    failures++;
    console.log('  \u2717 ' + t[0] + '\n      ' + e.message);
  }
  if (t[1].length === 0) {
    try {
      t[1]();
      console.log('  \u2713 ' + t[0]);
    } catch (e) { fail(e); }
    return next(i + 1);
  }
  try {
    t[1](function () {
      console.log('  \u2713 ' + t[0]);
      next(i + 1);
    });
  } catch (e) {
    fail(e);
    next(i + 1);
  }
})(0);

function finish() {
  mockEnv.restore();
  if (failures === 0) {
    console.log('ALL test-apps.js assertions passed!');
  }
  process.exit(failures ? 1 : 0);
}
