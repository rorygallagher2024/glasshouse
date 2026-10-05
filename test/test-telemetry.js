/**
 * test/test-telemetry.js - Unit tests for telemetry subsystem
 */

var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var telemetry = require('../server/lib/telemetry');

var oledMock = {
  detectOled: function (cb) { cb(true); },
  getIsOled: function () { return true; },
  refreshOledStats: function (settings, ps, cb) {
    cb({ panel_hours: 3500, screen_shift: 'on', logo_dimming: 'light' });
  }
};

var privacyMock = {
  isAdBlockActive: function () { return true; },
  collectPrivacy: function (cb) {
    cb({ adblock: { enabled: true, mode: 'full' } });
  }
};

var screensaversMock = {
  screensaverMode: function () { return 'stock'; },
  screensaverLevel: function () { return 'dim'; }
};

telemetry.init({
  luna: mockEnv.mockLuna,
  lunaCached: mockEnv.mockLunaCached,
  config: { port: 8080, allowControl: true },
  oled: oledMock,
  privacy: privacyMock,
  screensavers: screensaversMock,
  tvwebVersion: '0.36.0',
  mapPowerState: function (raw) {
    return { raw: raw, label: 'On', systemOn: true, screenOn: true };
  },
  isScreenSaver: function () { return false; }
});

console.log('Running test-telemetry.js ...');

// 1. eMMC wear tests
(function testDynamicRange() {
  var f = telemetry.formatDynamicRange;
  assert.strictEqual(f('sdr'), 'SDR');
  assert.strictEqual(f(''), 'SDR');
  assert.strictEqual(f('hdr'), 'HDR');
  assert.strictEqual(f('hdrALLM'), 'HDR \u00b7 Low latency');
  assert.strictEqual(f('dolbyHdrALLM'), 'Dolby Vision \u00b7 Low latency');
  assert.strictEqual(f('technicolorHdr'), 'Technicolor HDR');
  assert.strictEqual(f('hlg'), 'HLG');
  assert.strictEqual(f('hdr10Plus'), 'HDR10 Plus');
  console.log('  dynamic range names are readable');
})();

(function testEmmc() {
  var info = telemetry.emmcInfo();
  assert.strictEqual(info.wear, '0-10%', 'Expected 0-10% wear');
  assert.strictEqual(info.eol, 'Normal', 'Expected Normal EOL');
  assert.ok(info.health.indexOf('>90%') !== -1, 'Expected healthy drive');
  console.log('  ✓ emmcInfo parses healthy multi-region eMMC');
})();

// 2. onlineCpus tests
(function testOnlineCpus() {
  var cpus = telemetry.onlineCpus();
  assert.deepEqual(cpus, [0, 1, 2, 3], 'Expected 4 online cores');

  // Test custom range strings
  mockEnv.files['/sys/devices/system/cpu/online'] = '0,2-3\n';
  assert.deepEqual(telemetry.onlineCpus(), [0, 2, 3], 'Expected disjoint core range');

  // Test fallback to status line
  mockEnv.files['/sys/devices/system/cpu/online'] = null;
  assert.deepEqual(telemetry.onlineCpus('cpu_num: 2'), [0, 1], 'Expected fallback to cpu_num count');
  console.log('  ✓ onlineCpus handles ranges and status fallbacks');
})();

// CPU use is measured over the window, against every core present
(function testStatCpu() {
  function stat(rows) {
    mockEnv.files['/proc/stat'] = 'cpu  0 0 0 0 0 0 0 0 0 0\n' + rows.map(function (r, i) {
      return 'cpu' + r[0] + ' ' + r[1] + ' 0 0 ' + r[2] + ' 0 0 0 0 0 0';
    }).join('\n') + '\n';
  }
  // cpu0 and cpu1 online, 1000 ticks each in the window; cpu0 busy 200, cpu1 busy 100
  stat([[0, 1000, 9000], [1, 500, 9500]]);
  telemetry.statCpu(4, 100000);
  stat([[0, 1200, 9800], [1, 600, 10400]]);
  var r = telemetry.statCpu(4, 110000);
  assert.deepEqual(r.cores, { 0: 20, 1: 10 }, 'each online core against itself');
  assert.strictEqual(r.overall, 8, 'the whole processor, parked cores idle: 300 busy of 4 x 1000');
  // Asked again inside the window: the same reading, the window not cut short
  stat([[0, 1300, 9800], [1, 600, 10400]]);
  assert.strictEqual(telemetry.statCpu(4, 112000), r);
  // A core that goes offline drops out rather than being read as negative
  stat([[0, 1400, 10600]]);
  r = telemetry.statCpu(4, 120000);
  assert.deepEqual(Object.keys(r.cores), ['0']);
  assert.ok(r.overall >= 0 && r.overall <= 100);
  // Home Assistant's window runs from its own last publish, however often
  // the dashboards read in between
  stat([[0, 2000, 20000], [1, 2000, 20000]]);
  telemetry.cpuSincePublish(4, 190000);
  stat([[0, 2100, 20900], [1, 2100, 20900]]);
  telemetry.statCpu(4, 200000);
  stat([[0, 2400, 21600], [1, 2400, 21600]]);
  telemetry.statCpu(4, 210000);
  stat([[0, 2500, 22500], [1, 2500, 22500]]);
  assert.strictEqual(telemetry.cpuSincePublish(4, 250000), 8, '1000 busy of 4 x 3000 since the last publish, not the dashboards\' last window');
  delete mockEnv.files['/proc/stat'];
  console.log('  ✓ CPU use is measured over the window, against every core present');
})();

// 3. socMhz tests
(function testSocMhz() {
  // webOS 4 kHz format: 1200000 -> 1200
  mockEnv.files['/proc/lg/pm/frequency'] = '1200000\n';
  assert.strictEqual(telemetry.socMhz(), 1200, 'Expected 1200 MHz from kHz input');

  // webOS 9+ MHz format: 1200 -> 1200
  mockEnv.files['/proc/lg/pm/frequency'] = '1200\n';
  assert.strictEqual(telemetry.socMhz(), 1200, 'Expected 1200 MHz from MHz input');

  // Out of bounds clock
  mockEnv.files['/proc/lg/pm/frequency'] = '50\n';
  assert.strictEqual(telemetry.socMhz(), null, 'Expected null for impossible clock');
  console.log('  ✓ socMhz correctly scales kHz vs MHz across webOS versions');
})();

// 4. swapBacking tests
(function testSwapBacking() {
  mockEnv.files['/proc/swaps'] = 'Filename\t\t\t\tType\t\tSize\tUsed\tPriority\n/dev/block/zram0 partition\t524284\t120000\t-1\n';
  assert.strictEqual(telemetry.swapBacking(), 'zram', 'Expected zram swap backing');
  console.log('  ✓ swapBacking identifies zram');
})();

// 5. wifi tests
(function testWifi() {
  var w = telemetry.wifi();
  assert.ok(w, 'Expected wifi object');
  assert.strictEqual(w.link, 76, 'Expected link quality 76');
  assert.strictEqual(w.level, -63, 'Expected RSSI -63');
  console.log('  ✓ wifi parses wireless status and dBm level');
})();

// 6. HDMI ports tests
(function testHdmiPorts() {
  var ports = telemetry.hdmiPorts();
  assert.ok(ports.length >= 2, 'Expected at least 2 HDMI ports');

  // Port 0: HDMI 2.0 format
  var p0 = ports[0];
  assert.strictEqual(p0.connected, true);
  assert.strictEqual(p0.resolution, '3840x2160');
  assert.strictEqual(p0.refreshHz, 60);

  // Port 1: HDMI 2.1 format (Sig: format)
  var p1 = ports[1];
  assert.strictEqual(p1.connected, true);
  assert.strictEqual(p1.resolution, '3840x2160');
  assert.strictEqual(p1.refreshHz, 120);
  console.log('  ✓ hdmiPorts parses both HDMI 2.0 and HDMI 2.1 PHY timing nodes');
})();

// 6a. Stable Sync Info priority over RAW Sync Info
(function testStableSyncPriority() {
  mockEnv.files['/proc/lg/hdmi20/port2/status'] =
    '[RAW Sync Info]\n' +
    '  [9] Sig:[1920](0)x[1081](0)@[60]Hz\n' +
    '[Stable Sync Info]\n' +
    '  [15] Sig:[1920](0)x[1080](0)@[60]Hz\n' +
    'PHY Lock[1]\n' +
    'connected: on\n';

  assert.strictEqual(telemetry.getVideoSignal(2), '1920x1080 @ 60Hz', 'Stable sync resolution preferred over raw sync jitter');
  var p2 = telemetry.hdmiPorts()[2];
  assert.strictEqual(p2.resolution, '1920x1080', 'hdmiPorts uses stable sync resolution');
  assert.strictEqual(p2.refreshHz, 60);

  // Target port checks
  assert.strictEqual(telemetry.getVideoSignal(0), '3840x2160 @ 60Hz', 'targets port 0 specifically');
  assert.strictEqual(telemetry.getVideoSignal(1), '3840x2160 @ 120Hz', 'targets port 1 specifically');
  assert.strictEqual(telemetry.getVideoSignal(3), null, 'unconnected target port returns null');

  delete mockEnv.files['/proc/lg/hdmi20/port2/status'];
  console.log('  ✓ Stable Sync Info preferred over raw sync jitter and target port respected');
})();

// 6a2. isFreeSync is a mode: G-SYNC over HDMI reads 2, and is VRR
(function testVrrMode() {
  function vrrWith(mode) {
    mockEnv.files['/proc/lg/hdmi20/port3/status'] =
      'PHY Lock[1]\nconnected: on\n' +
      '[41] wasEDID[1], Disabled[0], isFreeSync[' + mode + '], isAllm[1], isMute[0]\n' +
      '[42] VRR Min[0]/Max[0], RepeaterHPD[0], isSleepMode[0], DDCMon[0]\n';
    var d = telemetry.getActiveHdmiDiagnostics(3);
    delete mockEnv.files['/proc/lg/hdmi20/port3/status'];
    return d.vrr;
  }
  assert.strictEqual(vrrWith(2), true, 'G-SYNC (HDMI Forum VRR) is VRR');
  assert.strictEqual(vrrWith(1), true, 'FreeSync is VRR');
  assert.strictEqual(vrrWith(0), false, 'off is not');
  console.log('  ✓ any VRR mode but off reads as VRR, G-SYNC included');
})();

// 6b. An HDMI input is active only while it is on screen
(function testHdmiActive() {
  var fg = 'com.webos.applicationManager/getForegroundAppInfo';
  var orig = mockEnv.luna[fg];
  telemetry.hdmiInputs(function (r) {
    assert.strictEqual(r.inputs[1].active, true, 'the selected input on screen is active');
    assert.strictEqual(r.inputs[0].active, false);
    mockEnv.luna[fg] = { returnValue: true, appId: 'io.github.rorygallagher2024.lg-webos-dashboard' };
    telemetry.hdmiInputs(function (r2) {
      assert.strictEqual(r2.inputs[1].active, false, 'the selected input behind another app is not');
      mockEnv.luna[fg] = orig;
      console.log('  ✓ an HDMI input is active only while it is on screen');
    });
  });
})();

(function testHdmiSeenKept() {
  var file = '/var/lib/tvweb/hdmi_seen';
  telemetry.noteHdmiSeen({ port: 1, phy_mode: 'FRL 48 Gbps', chroma: null, allm: false, vrr: true });
  assert.strictEqual(mockEnv.files[file], 'allm\nphy_mode\nvrr\n');
  mockEnv.files[file] = 'allm\nhdcp\n';
  telemetry.loadHdmiSeen();
  assert.strictEqual(telemetry.getCapabilitySignature().replace(',play_state', ''), 'allm,hdcp');
  delete mockEnv.files[file];
  telemetry.loadHdmiSeen();
  console.log('  ✓ the HDMI fields seen are kept across restarts');
})();

// 7. Format helpers
(function testFormatters() {
  assert.strictEqual(telemetry.formatPicMode('expert1'), 'ISF Expert (Bright)');
  assert.strictEqual(telemetry.formatSoundOutput('tv_speaker'), 'TV Speaker');
  assert.strictEqual(telemetry.formatSoundOutput('ext_speaker_optical'), 'Optical');
  assert.strictEqual(telemetry.formatSoundOutput('ext_speaker_builtin_lg_optical'), 'Optical');
  assert.strictEqual(telemetry.formatSoundOutput('ext_speaker_arc'), 'HDMI ARC');
  assert.strictEqual(telemetry.formatSoundOutput('mobile_phone'), 'Mobile Phone');
  assert.strictEqual(telemetry.formatPicMode('hdrCinemaBright'), 'HDR Cinema Bright');
  assert.strictEqual(telemetry.formatPicMode('hdrFilmMaker'), 'HDR Filmmaker');
  assert.strictEqual(telemetry.formatPicMode('dolbyHdrSomethingNew'), 'Dolby Vision Something New');
  assert.strictEqual(telemetry.formatDynamicRange('hdr10'), 'HDR10');
  console.log('  ✓ formatters map modes and dynamic ranges');
})();

(function testVolumeControl() {
  var vc = telemetry.volumeControl;
  // C2 (webOS 22): the newer service says how
  assert.strictEqual(vc({ adjustVolume: true, externalDeviceControl: false, volume: 9 }), 'level');
  assert.strictEqual(vc({ adjustVolume: false, externalDeviceControl: false, volume: 10 }), 'none', 'optical');
  assert.strictEqual(vc({ adjustVolume: false, externalDeviceControl: true, volumeSyncable: false, volume: 10 }), 'steps', 'HDMI ARC');
  assert.strictEqual(vc({ adjustVolume: false, externalDeviceControl: true, volumeSyncable: true, volume: 24 }), 'level',
    'a soundbar whose level the TV shows and sets (#406)');
  // B8 (webOS 4.4): -1, and the scenario is where the sound actually goes
  assert.strictEqual(vc(null, { volume: 3, scenario: 'mastervolume_tv_speaker' }), 'level');
  assert.strictEqual(vc(null, { volume: -1, scenario: 'mastervolume_ext_speaker_optical' }), 'none',
    'HDMI ARC chosen, no receiver: still optical');
  assert.strictEqual(vc(null, { volume: -1, scenario: 'mastervolume_ext_speaker_arc' }), 'steps');
  assert.strictEqual(vc(null, null), 'level');
  console.log('  ✓ the volume is set, stepped or left alone by where the sound goes');
})();

// 8. Capabilities test
(function testCapabilities() {
  var caps = telemetry.getCapabilities({ isOled: true });
  assert.strictEqual(caps.isOled, true);
  assert.strictEqual(caps.thermalPresent, true);
  assert.strictEqual(caps.emmcWearPresent, true);
  console.log('  ✓ getCapabilities produces filter flags');
})();

// 9. Installed apps tests
telemetry.refreshInstalledApps(function (apps) {
  assert.ok(Array.isArray(apps), 'Expected array of apps');
  assert.strictEqual(apps.length, 2);
  assert.strictEqual(apps[0].id, 'netflix');
  assert.strictEqual(apps[1].id, 'youtube.leanback.v4');
  console.log('  ✓ refreshInstalledApps parses apps from listApps');

  // Test webOS 6+ shape where listApps returns launchPoints (issue #145)
  telemetry.clearCache();
  var origListApps = mockEnv.luna['com.webos.applicationManager/listApps'];
  mockEnv.luna['com.webos.applicationManager/listApps'] = {
    returnValue: true,
    launchPoints: [
      { id: 'netflix', title: 'Netflix' },
      { id: 'com.webos.app.discovery', title: 'Apps' },
      { id: 'com.webos.app.container', title: 'Container' },
      { id: 'hidden.app', title: 'Hidden', visible: false }
    ]
  };

  telemetry.refreshInstalledApps(function (lpApps) {
    assert.strictEqual(lpApps.length, 2);
    assert.strictEqual(lpApps[0].id, 'com.webos.app.discovery');
    assert.strictEqual(lpApps[1].id, 'netflix');
    console.log('  ✓ refreshInstalledApps parses launchPoints array (webOS 6+ / issue #145)');

    // A live event expires the stats but keeps the app list: the next read
    // does not scan the apps again.
    telemetry.expireStats();
    mockEnv.luna['com.webos.applicationManager/listApps'] = { returnValue: true, launchPoints: [{ id: 'other', title: 'Other' }] };
    telemetry.refreshInstalledApps(function (kept) {
      assert.strictEqual(kept.length, 2);
      assert.strictEqual(kept[1].id, 'netflix');
      console.log('  ✓ expireStats keeps the installed app list');

      // ...until a minute has passed, when an app removed without an event
      // drops off the list.
      var realNow = Date.now;
      Date.now = function () { return realNow() + 61000; };
      telemetry.refreshInstalledApps(function (rescanned) {
        Date.now = realNow;
        assert.strictEqual(rescanned.length, 1);
        assert.strictEqual(rescanned[0].id, 'other');
        console.log('  ✓ the installed app list is read again after a minute');
      });
    });

    // Test fallback to listLaunchPoints when listApps returns empty/fails
    telemetry.clearCache();
    mockEnv.luna['com.webos.applicationManager/listApps'] = { returnValue: false };
    mockEnv.luna['com.webos.applicationManager/listLaunchPoints'] = {
      returnValue: true,
      launchPoints: [
        { id: 'amazon', title: 'Prime Video' }
      ]
    };

    telemetry.refreshInstalledApps(function (fallbackApps) {
      assert.strictEqual(fallbackApps.length, 1);
      assert.strictEqual(fallbackApps[0].id, 'amazon');
      console.log('  ✓ refreshInstalledApps falls back to listLaunchPoints');

      // Restore original handlers
      mockEnv.luna['com.webos.applicationManager/listApps'] = origListApps;
      mockEnv.luna['com.webos.applicationManager/listLaunchPoints'] = {
        returnValue: true,
        launchPoints: [
          { id: 'netflix', title: 'Netflix' },
          { id: 'youtube.leanback.v4', title: 'YouTube' }
        ]
      };

      // 10. Full collectStats test (async)
      telemetry.clearCache();
      telemetry.collectStats(function (stats) {
        assert.ok(stats, 'Expected stats payload');
        assert.strictEqual(stats.ok, true);
        assert.strictEqual(stats.tvwebVersion, '0.36.0');
        assert.strictEqual(stats.temp, 48);
        assert.ok(stats.mem && stats.mem.total > 0, 'Expected mem stats');
        assert.ok(stats.swap && stats.swap.total > 0, 'Expected swap stats');
        assert.strictEqual(stats.wifi.level, -63);
        assert.ok(stats.oled && stats.oled.panel_hours === 3500);
        assert.ok(Array.isArray(stats.apps) && stats.apps.length === 2);
        assert.strictEqual(stats.signal, '3840x2160 @ 120Hz', 'stats signal matches active HDMI 2 input');
        assert.ok(stats.hdmi_diag && stats.hdmi_diag.port === 1, 'stats hdmi_diag matches active port 1');

        console.log('  ✓ collectStats aggregates full telemetry payload including apps');

        // Internal app (Jellyfin/Moonfin/Netflix) foreground reporting null signal
        var origApp = mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'];
        mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = { returnValue: true, appId: 'org.jellyfin.webos' };
        telemetry.clearCache();
        telemetry.collectStats(function (internalStats) {
          assert.strictEqual(internalStats.signal, null, 'internal app yields null signal');
          assert.strictEqual(internalStats.hdmi_diag, null, 'internal app yields null hdmi_diag');

          // Switching to HDMI 1 (port 0)
          mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = { returnValue: true, appId: 'com.webos.app.hdmi1' };
          telemetry.clearCache();
          telemetry.collectStats(function (hdmi1Stats) {
            assert.strictEqual(hdmi1Stats.signal, '3840x2160 @ 60Hz', 'HDMI 1 yields port 0 signal');
            assert.ok(hdmi1Stats.hdmi_diag && hdmi1Stats.hdmi_diag.port === 0, 'HDMI 1 yields port 0 diagnostics');

            // Switching to HDMI 2 on B8 hardware where HDMI 2 routes to PHY port 2 (port 1 disconnected)
            mockEnv.files['/proc/lg/hdmi20/port2/status'] = mockEnv.files['/proc/lg/hdmi20/port1/status'];
            delete mockEnv.files['/proc/lg/hdmi20/port1/status'];
            mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = { returnValue: true, appId: 'com.webos.app.hdmi2' };
            telemetry.clearCache();
            telemetry.collectStats(function (b8Stats) {
              assert.strictEqual(b8Stats.signal, '3840x2160 @ 120Hz', 'HDMI 2 yields port 2 signal when port 1 has no signal (B8 routing)');
              assert.ok(b8Stats.hdmi_diag && b8Stats.hdmi_diag.port === 2, 'HDMI 2 yields port 2 diagnostics on B8 routing');
              mockEnv.files['/proc/lg/hdmi20/port1/status'] = mockEnv.files['/proc/lg/hdmi20/port2/status'];
              delete mockEnv.files['/proc/lg/hdmi20/port2/status'];

              mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = origApp;
              console.log('  ✓ active foreground app determines HDMI signal and diagnostics');

              // 11. LG's Always Ready display reads as switched off, not "Active"
              var settings = mockEnv.luna['com.webos.service.settings/getSystemSettings'].settings;
              settings.lifeOnScreenMode = 'allEnabled';
              mockEnv.luna['com.webos.service.tvpower/power2/getPowerState'] =
                { returnValue: true, state: 'ACTIVE', 'sub state': 'always on display' };
              telemetry.clearCache();
              telemetry.collectStats(function (first) {
                assert.strictEqual(first.alwaysReadyScreen, true);
                telemetry.clearCache();
                telemetry.collectStats(function (second) {
                  assert.strictEqual(second.powerState.raw, 'Always Ready');
                  delete settings.lifeOnScreenMode;
                  console.log('  ✓ the Always Ready display is reported as its own power state');

                  // 12. A clock stepped back does not keep serving the last stats
                  mockEnv.files['/proc/uptime'] = '99999.00 45678.90\n';
                  var realNow = Date.now;
                  Date.now = function () { return realNow() - 600000; };
                  telemetry.collectStats(function (third) {
                    Date.now = realNow;
                    // Asserted outside: collectStats swallows what its callbacks throw.
                    setImmediate(function () {
                      assert.strictEqual(third.uptime, 99999);
                      console.log('  ✓ a clock stepped back does not keep serving the last stats');
                      console.log('ALL test-telemetry.js assertions passed!\n');
                      mockEnv.restore();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
