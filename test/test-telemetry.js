/**
 * test/test-telemetry.js - Unit tests for telemetry subsystem
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
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

// The frame rate game.js reads for the app on screen.
var gameAsked = [];
var gameMock = {
  read: function (appId, cb) {
    gameAsked.push(appId);
    cb(appId ? { frameRate: 119, vrrType: 'gsync', port: 'HDMI2' } : null);
  }
};

telemetry.init({
  luna: mockEnv.mockLuna,
  game: gameMock,
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

(function testSignalHdr() {
  assert.deepEqual(telemetry.signalFormat(require('./fixtures/videooutput-cx-webos5-hdr.json')), {
    type: 'hdr10', eotf: 'pq', colorimetry: 'BT2020_RGBORYCbCr', encoding: 'YCbCr422',
    max_luminance: 400, min_luminance: 0.0049, max_cll: 0, max_fall: 0,
    game_mode: false, freesync: false
  });
  assert.strictEqual(telemetry.signalFormat(require('./fixtures/videooutput-c4-webos9-standby.json')), null);
  assert.strictEqual(telemetry.signalFormat({ returnValue: false }), null);
  // Without static metadata there is no EOTF or luminance, and colormetry
  // other than FUTURE is the colorimetry itself.
  assert.deepEqual(telemetry.signalFormat({ video: [
    { sink: 'MAIN', connected: false, videoInfo: null },
    { sink: 'SUB0', connected: true, videoInfo: { hdrType: 'DOLBY_VISION', colormetry: 'BT709', isGameMode: 1, freesyncEnabled: 1 } }
  ] }), {
    type: 'dolby_vision', eotf: null, colorimetry: 'BT709', encoding: null,
    max_luminance: null, min_luminance: null, max_cll: null, max_fall: null,
    game_mode: true, freesync: true
  });
  assert.strictEqual(telemetry.signalFormat({ video: [
    { sink: 'MAIN', connected: true, videoInfo: { hdrType: 'NONE', colormetry: 'BT709' } }
  ] }).type, 'sdr', 'an SDR source is sdr, not none');
  assert.strictEqual(telemetry.signalFormat({ video: [
    { sink: 'MAIN', connected: true, videoInfo: { hdrType: 'DOLBY_LL' } }
  ] }).type, 'dolby_vision_low_latency', 'player-led Dolby Vision');
  console.log('  ✓ signalFormat reads the connected sink\'s format and HDR metadata');
})();

(function testEmmc() {
  var info = telemetry.emmcInfo();
  assert.strictEqual(info.wear, '0-10%', 'Expected 0-10% wear');
  assert.strictEqual(info.eol, 'Normal', 'Expected Normal EOL');
  assert.ok(info.health.indexOf('>90%') !== -1, 'Expected healthy drive');
  assert.strictEqual(info.life_est_a, 1, 'the type A estimate as the card gives it');
  assert.strictEqual(info.life_est_b, 1);
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

// The clock in hertz, unrounded
(function testSocHz() {
  mockEnv.files['/proc/lg/pm/frequency'] = '1400500\n';
  assert.strictEqual(telemetry.socHz(), 1400500000, 'kHz kept to the kHz');
  assert.strictEqual(telemetry.socMhz(), 1401);
  mockEnv.files['/proc/lg/pm/frequency'] = '1200\n';
  assert.strictEqual(telemetry.socHz(), 1200000000);
  mockEnv.files['/proc/lg/pm/frequency'] = '50\n';
  assert.strictEqual(telemetry.socHz(), null);
  delete mockEnv.files['/proc/lg/pm/frequency'];
  console.log('  ✓ socHz gives the clock in hertz');
})();

// Each online core's time by mode, and the boot time, from /proc/stat
(function testCpuTimes() {
  // From a C4: two of four cores online. The last two columns are guest time,
  // which user and nice already count.
  mockEnv.files['/proc/stat'] = [
    'cpu  226653 42 89823 3463643 705 0 3055 0 0 0',
    'cpu0 103220 12 39911 1425675 208 0 2878 0 7 0',
    'cpu1 90592 13 34823 1434212 230 0 86 0 0 0',
    'intr 123 0 0',
    'btime 1791204921',
    'processes 4567'
  ].join('\n') + '\n';
  assert.deepEqual(telemetry.cpuTimes(), {
    cpus: {
      0: { user: 103220, nice: 12, system: 39911, idle: 1425675, iowait: 208, irq: 0, softirq: 2878, steal: 0 },
      1: { user: 90592, nice: 13, system: 34823, idle: 1434212, iowait: 230, irq: 0, softirq: 86, steal: 0 }
    },
    btime: 1791204921
  });
  mockEnv.files['/proc/stat'] = null;
  assert.deepEqual(telemetry.cpuTimes(), { cpus: {}, btime: null });
  delete mockEnv.files['/proc/stat'];
  console.log('  ✓ cpuTimes reads each core\'s time by mode, and btime');
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
  assert.strictEqual(p0.pixelClockMhz, 594, 'pixel-clock: is in kHz');

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

// 6a1. A PC at 1080p 60 in deep colour over TMDS: the total width counts
// characters, so the clock is the Pixel Clk field.
(function testDeepColourClock() {
  ['8', '10', '12'].forEach(function (depth) {
    mockEnv.files['/proc/lg/hdmi20/port2/status'] =
      fs.readFileSync(path.join(__dirname, 'fixtures', 'hdmi20-c4', 'port0-1080p-' + depth + 'bit.status'), 'utf8');
    var deep = telemetry.hdmiPorts()[2];
    assert.strictEqual(deep.pixelClockMhz, 148.5, depth + '-bit TMDS');
    assert.strictEqual(deep.resolution, '1920x1080', depth + '-bit TMDS, VIC 16');
  });
  delete mockEnv.files['/proc/lg/hdmi20/port2/status'];
  console.log('  ✓ the pixel clock on a deep-colour TMDS link is the receiver\'s Pixel Clk');
})();

// 6a1b. The VIC's size over a measured one a line off it, as a C4 measures
// TMDS; a measured size the VIC does not describe is kept.
(function testVicSize() {
  function sizeWith(sig, vic) {
    mockEnv.files['/proc/lg/hdmi20/port2/status'] =
      '[Stable Sync Info]\n  [15] Sig:' + sig + ' (0). vo/ho:(65530)/(2152)\n' +
      '  [17] VIC Code[' + vic + '] / VIC Vfreq[600] / DeepColorMode[ 8BIT]\nPHY Lock[1]\n';
    return telemetry.hdmiPorts()[2];
  }
  // A C4's streamer at 2160p 60 over TMDS: Sig:[3840](4400)x[2161](2250), VIC 97.
  mockEnv.files['/proc/lg/hdmi20/port2/status'] =
    fs.readFileSync(path.join(__dirname, 'fixtures', 'hdmi20-c4', 'port3-2160p.status'), 'utf8');
  var p = telemetry.hdmiPorts()[2];
  assert.strictEqual(p.resolution, '3840x2160', 'VIC 97 is 2160p');
  assert.strictEqual(p.pixelClockMhz, 594, 'the Pixel Clk field, in kHz on TMDS');
  assert.strictEqual(telemetry.getVideoSignal(2), '3840x2160 @ 60Hz');
  assert.strictEqual(sizeWith('[2560](2720)x[1440](1481)@[60]Hz', 16).resolution, '2560x1440',
    'a size far from the VIC\'s is kept');
  assert.strictEqual(sizeWith('[1920](2200)x[1081](1125)@[60]Hz', 0).resolution, '1920x1081',
    'no VIC, no correction');
  delete mockEnv.files['/proc/lg/hdmi20/port2/status'];
  console.log('  ✓ the VIC\'s size is used where the measured one is a line off it');
})();

// 6a1c. A C4's streamer asleep on its input: PHY Lock[0] and 5V present, with
// its last 2160p 60 timing left in the stable section.
(function testSleepingSource() {
  mockEnv.files['/proc/lg/hdmi20/port2/status'] =
    fs.readFileSync(path.join(__dirname, 'fixtures', 'hdmi20-c4', 'port3-asleep.status'), 'utf8');
  var p = telemetry.hdmiPorts()[2];
  assert.strictEqual(p.connected, false, 'no lock, no source sending');
  assert.strictEqual(p.resolution, null, 'the leftover timing is not reported');
  assert.strictEqual(p.pixelClockMhz, null);
  assert.strictEqual(telemetry.getVideoSignal(2), null);
  // The same receiver locked reads as before.
  mockEnv.files['/proc/lg/hdmi20/port2/status'] =
    fs.readFileSync(path.join(__dirname, 'fixtures', 'hdmi20-c4', 'port3-2160p.status'), 'utf8');
  assert.strictEqual(telemetry.hdmiPorts()[2].connected, true);
  delete mockEnv.files['/proc/lg/hdmi20/port2/status'];
  console.log('  ✓ a sleeping source\'s leftover timing is not a signal');
})();

// 6a1d. A powered source on each input's cable, linked or not, by the input map.
(function testHdmiSources() {
  function fixture(name) {
    return fs.readFileSync(path.join(__dirname, 'fixtures', 'hdmi20-c4', name + '.status'), 'utf8');
  }
  var status = [fixture('port0'), fixture('port1'), null, fixture('port3-asleep')];
  assert.deepEqual(telemetry.hdmiSources(status, { 1: 3, 2: 2, 3: 1, 4: 0 }), [
    { input: 1, receiver: 3, powered: true },
    { input: 3, receiver: 1, powered: false },
    { input: 4, receiver: 0, powered: true }
  ], 'asleep without a lock is still powered; an unread receiver is left out');
  assert.deepEqual(telemetry.hdmiSources(['connected: on\n', null, null, null], { 1: 0 }), [],
    'the HDMI 2.0 driver\'s files have no 5V field');
  console.log('  ✓ a powered source is told from a link, by the input map');
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

// 6a. The signal's timing as numbers, beside the string made from them, and
// none for a port connected before the receiver has a timing
(function testSignalTiming() {
  var r = telemetry.getHdmiSignal(2, { 2: 1 });
  assert.strictEqual(r.signal, '3840x2160 @ 120Hz');
  assert.deepEqual(r.timing, { width: 3840, height: 2160, refresh_hz: 120 });
  var orig = mockEnv.files['/proc/lg/hdmi20/port0/status'];
  mockEnv.files['/proc/lg/hdmi20/port0/status'] = 'connected: on\n';
  var bare = telemetry.getHdmiSignal(1, { 1: 0 });
  mockEnv.files['/proc/lg/hdmi20/port0/status'] = orig;
  assert.strictEqual(bare.signal, 'Connected');
  assert.strictEqual(bare.timing, null);
  console.log('  ✓ the signal\'s timing is kept as numbers beside its string');
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

// 8. Picture engine info parsing tests
(function testPictureEngineInfo() {
  var orig = mockEnv.files['/proc/lg/pe/hdr_status'];

  // SDR source after HDR content: hdrStatus is hdr10(sdr)
  mockEnv.files['/proc/lg/pe/hdr_status'] =
    'VPQ_PQ_MODE_INFO=\n' +
    '[0]{hdrStatus:hdr10(sdr),colorimetry:bt601,peakLuminance:1000,supportPrime:0,reserved:255}\n' +
    '[1]{hdrStatus:sdr(sdr),colorimetry:bt601,peakLuminance:0,supportPrime:0,reserved:255}\n';
  var pe1 = telemetry.getPictureEngineInfo();
  assert.deepEqual(pe1, { colorimetry: 'BT.601', hdr_mode: 'sdr' });

  // Active HDR10: hdrStatus is hdr10(hdr10)
  mockEnv.files['/proc/lg/pe/hdr_status'] =
    'VPQ_PQ_MODE_INFO=\n' +
    '[0]{hdrStatus:hdr10(hdr10),colorimetry:bt2020,peakLuminance:1000,supportPrime:0,reserved:255}\n' +
    '[1]{hdrStatus:sdr(sdr),colorimetry:bt601,peakLuminance:0,supportPrime:0,reserved:255}\n';
  var pe2 = telemetry.getPictureEngineInfo();
  assert.deepEqual(pe2, { colorimetry: 'BT.2020', hdr_mode: 'hdr10' });

  // Standard SDR: hdrStatus is sdr(sdr)
  mockEnv.files['/proc/lg/pe/hdr_status'] =
    'VPQ_PQ_MODE_INFO=\n' +
    '[0]{hdrStatus:sdr(sdr),colorimetry:bt709,peakLuminance:1000,supportPrime:0,reserved:255}\n' +
    '[1]{hdrStatus:sdr(sdr),colorimetry:bt601,peakLuminance:0,supportPrime:0,reserved:255}\n';
  var pe3 = telemetry.getPictureEngineInfo();
  assert.deepEqual(pe3, { colorimetry: 'BT.709', hdr_mode: 'sdr' });

  // HLG: hdrStatus is hlg(hlg)
  mockEnv.files['/proc/lg/pe/hdr_status'] =
    'VPQ_PQ_MODE_INFO=\n' +
    '[0]{hdrStatus:hlg(hlg),colorimetry:bt2020,peakLuminance:1000,supportPrime:0,reserved:255}\n';
  var pe4 = telemetry.getPictureEngineInfo();
  assert.deepEqual(pe4, { colorimetry: 'BT.2020', hdr_mode: 'hlg' });

  // Unparenthesized fallback
  mockEnv.files['/proc/lg/pe/hdr_status'] = 'hdrStatus:hdr10,colorimetry:bt2020\n';
  var pe5 = telemetry.getPictureEngineInfo();
  assert.deepEqual(pe5, { colorimetry: 'BT.2020', hdr_mode: 'hdr10' });

  // Missing file returns null
  delete mockEnv.files['/proc/lg/pe/hdr_status'];
  assert.strictEqual(telemetry.getPictureEngineInfo(), null);

  mockEnv.files['/proc/lg/pe/hdr_status'] = orig;
  console.log('  ✓ getPictureEngineInfo parses active signal and drops fixed peak luminance');
})();

// 9. Capabilities test
(function testCapabilities() {
  var caps = telemetry.getCapabilities({ isOled: true });
  assert.strictEqual(caps.isOled, true);
  assert.strictEqual(caps.thermalPresent, true);
  assert.strictEqual(caps.emmcWearPresent, true);
  console.log('  ✓ getCapabilities produces filter flags');
})();

// 9a. Process lists carry the pid
(function testParseProcesses() {
  var lines = ['  PID   RSS COMMAND          COMMAND'];
  for (var i = 1; i <= 11; i++) {
    lines.push('  ' + (100 + i) + '  ' + (i * 1024) + ' worker' + i + '          /usr/bin/worker' + i + ' --slot ' + i);
  }
  lines.push(' 3794 40960 hal-gal          /usr/sbin/hal-gal -d --config /etc/hal gal.conf');
  lines.push(' 4120 20480                  /usr/bin/kitchen-relay');
  lines.push(' 4121 15360                  /usr/bin/livingroom-feeder --room living room');
  var out = lines.join('\n') + '\n';

  var r = telemetry.parseProcesses(out, false);
  assert.strictEqual(r.count, 14);
  assert.strictEqual(r.top.length, 10, 'ten largest by default');
  assert.deepEqual(r.top[0], { pid: 3794, name: 'hal-gal', mb: 40 });
  assert.deepEqual(r.top[1], { pid: 4120, name: 'kitchen-relay', mb: 20 });
  assert.deepEqual(r.top[2], { pid: 4121, name: 'livingroom-feeder', mb: 15 });
  assert.deepEqual(r.top[3], { pid: 111, name: 'worker11', mb: 11 });

  var all = telemetry.parseProcesses(out, true);
  assert.strictEqual(all.top.length, 14, 'every process with all');
  assert.deepEqual(all.top[13], { pid: 101, name: 'worker1', mb: 1 });
  assert.strictEqual(all.totalMb, r.totalMb);
  console.log('  ✓ parseProcesses reads pids, a blank comm, and every process with all');
})();

(function testCpuProcessRows() {
  var first = { total: 1000, procs: {
    '3794': { ticks: 100, comm: 'hal-gal' },
    '812': { ticks: 50, comm: 'surfacemgr' },
    '900': { ticks: 10, comm: 'idle-one' }
  } };
  var second = { total: 2000, procs: {
    '3794': { ticks: 350, comm: 'hal-gal' },
    '812': { ticks: 100, comm: 'surfacemgr' },
    '900': { ticks: 10, comm: 'idle-one' },
    '950': { ticks: 40, comm: 'just-started' }
  } };
  // Read from /proc for the name, so kept off the real host's processes.
  mockEnv.files['/proc/3794/cmdline'] = '/usr/sbin/hal-gal\0-d\0';
  mockEnv.files['/proc/812/cmdline'] = null;
  var r = telemetry.cpuProcessRows(first, second, 1000);
  assert.deepEqual(r.rows, [
    { pid: 3794, name: 'hal-gal', pct: 25 },
    { pid: 812, name: 'surfacemgr', pct: 5 }
  ]);
  assert.strictEqual(r.busy, 30);
  console.log('  ✓ cpuProcessRows carries the pid of each busy process');
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

      // 10. Full collectStats test (async). configd has no input map, so
      // HDMI 1 and 2 are on receivers 3 and 2 by the base table.
      var hdmiFiles = mockEnv.files;
      hdmiFiles['/proc/lg/hdmi20/port3/status'] = hdmiFiles['/proc/lg/hdmi20/port0/status'];
      hdmiFiles['/proc/lg/hdmi20/port2/status'] = hdmiFiles['/proc/lg/hdmi20/port1/status'];
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
        assert.ok(stats.hdmi_diag && stats.hdmi_diag.port === 2, 'stats hdmi_diag matches HDMI 2\'s receiver 2');
        assert.deepEqual(stats.source_frame_rate, { hz: 119, vrr_type: 'gsync', port: 'HDMI2' });
        assert.deepEqual(gameAsked, ['com.webos.app.hdmi2']);
        assert.deepEqual(stats.picture_engine, { colorimetry: 'BT.709', hdr_mode: 'sdr' });
        assert.strictEqual(stats.colorimetry, 'BT.709');
        assert.strictEqual(stats.signal_format, null, 'no videooutput reply, no signal format');
        // The mock's picture settings have no dimension: shown as SDR, but not
        // reported as the TV's own value.
        assert.strictEqual(stats.picture.dynamicRange, 'SDR');
        assert.strictEqual(stats.picture.dynamicRange_raw, null);
        // Nor a backlight: the dashboards' 50, and null as read.
        assert.strictEqual(stats.picture.backlight, 50);
        assert.strictEqual(stats.picture.backlight_raw, null);

        console.log('  ✓ collectStats aggregates full telemetry payload including apps');

        // Internal app (Jellyfin/Moonfin/Netflix) foreground reporting null signal
        var origApp = mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'];
        mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = { returnValue: true, appId: 'org.jellyfin.webos' };
        telemetry.clearCache();
        telemetry.collectStats(function (internalStats) {
          assert.strictEqual(internalStats.signal, null, 'internal app yields null signal');
          assert.strictEqual(internalStats.hdmi_diag, null, 'internal app yields null hdmi_diag');
          assert.strictEqual(internalStats.source_frame_rate, null, 'internal app yields no frame rate');
          assert.strictEqual(gameAsked[gameAsked.length - 1], '', 'off an input, game.js is told so');

          // Switching to HDMI 1 (receiver 3)
          mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = { returnValue: true, appId: 'com.webos.app.hdmi1' };
          telemetry.clearCache();
          telemetry.collectStats(function (hdmi1Stats) {
            assert.strictEqual(hdmi1Stats.signal, '3840x2160 @ 60Hz', 'HDMI 1 yields receiver 3\'s signal');
            assert.ok(hdmi1Stats.hdmi_diag && hdmi1Stats.hdmi_diag.port === 3, 'HDMI 1 yields receiver 3\'s diagnostics');

            // HDMI 2 with receiver 2 idle takes nothing from receiver 1.
            delete hdmiFiles['/proc/lg/hdmi20/port2/status'];
            delete hdmiFiles['/proc/lg/hdmi20/port3/status'];
            mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = { returnValue: true, appId: 'com.webos.app.hdmi2' };
            telemetry.clearCache();
            telemetry.collectStats(function (idleStats) {
              assert.strictEqual(idleStats.signal, null, 'receiver 1 is not HDMI 2\'s');
              assert.strictEqual(idleStats.hdmi_diag, null);

              mockEnv.luna['com.webos.applicationManager/getForegroundAppInfo'] = origApp;
              console.log('  ✓ active foreground app determines HDMI signal and diagnostics');

              // 11. LG's Always Ready display reads as switched off, not "Active"
              var settings = mockEnv.luna['com.webos.service.settings/getSystemSettings'].settings;
              settings.lifeOnScreenMode = 'allEnabled';
              settings.backlight = '57';
              mockEnv.luna['com.webos.service.tvpower/power2/getPowerState'] =
                { returnValue: true, state: 'ACTIVE', 'sub state': 'always on display' };
              telemetry.clearCache();
              telemetry.collectStats(function (first) {
                assert.strictEqual(first.alwaysReadyScreen, true);
                assert.strictEqual(first.picture.backlight, 57);
                assert.strictEqual(first.picture.backlight_raw, 57);
                telemetry.clearCache();
                telemetry.collectStats(function (second) {
                  assert.strictEqual(second.powerState.raw, 'Always Ready');
                  delete settings.lifeOnScreenMode;
                  delete settings.backlight;
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
