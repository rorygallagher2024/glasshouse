#!/usr/bin/env node
/*
 * Stands in for /usr/bin/luna-send in the start-up test (TVWEB_LUNA_SEND).
 * Answers from mock-env's table, as one line of JSON. With -i it answers once
 * and stays open, as a subscription does, until it is killed.
 *
 * FAKE_LUNA_CHAOS=1 makes the TV unreliable: some calls answer late, never
 * answer, answer with rubbish or an error, or die before answering; some
 * subscriptions drop after a few seconds. Which ones is fixed rather than
 * random, so a run takes the same time each time: the nth call with a given
 * uri and payload always misbehaves the same way (the count is kept under
 * FAKE_ROOT).
 *
 * FAKE_LUNA_SCRIPT names a JSON file { "<uri>": { steps: [{ delay: ms, out:
 * object | raw: string }], end: "hold" | "exit" | "fail" } }. A call to a
 * listed uri sends those lines in turn, as a streamed subscription does, then
 * holds the stream open, exits 0, or exits 1. FAKE_LUNA_LOG names a file that
 * gets each call's arguments, one JSON array per line.
 *
 * Strict ES5: the test runs on node 0.12.
 */
var mock = require('./mock-env').createMockEnv({ luna: {
  // As an OLED65B8SLC answers by default, or as the emulator's profile
  // (TV_PROFILE, scripts/emulate-tv.js) or TV_MODEL has it.
  'com.webos.service.tv.systemproperty/getSystemProperties': function (p) {
    var all = { modelName: 'OLED65B8SLC', firmwareVersion: '05.50.70', boardType: 'M16P_DVB_EU', sdkVersion: '4.4.3' };
    if (process.env.TV_PROFILE) {
      all = JSON.parse(process.env.TV_PROFILE);
    } else if (process.env.TV_MODEL === 'c2') {
      all = { modelName: 'OLED65C26LD', firmwareVersion: '03.33.95', boardType: 'O22N_DVB_EU', sdkVersion: '7.3.0' };
    } else if (process.env.TV_MODEL === 'c3') {
      all = { modelName: 'OLED65C35LA', firmwareVersion: '04.40.75', boardType: 'O23N_DVB_EU', sdkVersion: '8.3.0' };
    }
    var out = { returnValue: true };
    ((p && p.keys) || []).forEach(function (k) { if (all[k] !== undefined) out[k] = all[k]; });
    return out;
  },
  'com.webos.applicationManager/listApps': function () {
    return {
      returnValue: true,
      apps: [
        { id: 'netflix', title: 'Netflix', folderPath: '/media/cryptofs/apps/usr/palm/applications/netflix', removable: true },
        { id: 'youtube.leanback.v4', title: 'YouTube', folderPath: '/media/cryptofs/apps/usr/palm/applications/youtube.leanback.v4', removable: true },
        { id: 'com.plexapp.android', title: 'Plex', folderPath: '/media/cryptofs/apps/usr/palm/applications/com.plexapp.android', removable: true },
        { id: 'amazon', title: 'Prime Video', folderPath: '/media/cryptofs/apps/usr/palm/applications/amazon', removable: true },
        { id: 'com.webos.app.livetv', title: 'Live TV', folderPath: '/usr/palm/applications/com.webos.app.livetv', systemApp: true },
        { id: 'com.webos.app.hdmi1', title: 'HDMI 1', folderPath: '/usr/palm/applications/com.webos.app.hdmi1', systemApp: true },
        { id: 'com.webos.app.hdmi2', title: 'HDMI 2', folderPath: '/usr/palm/applications/com.webos.app.hdmi2', systemApp: true }
      ]
    };
  },
  'com.webos.applicationManager/running': function () {
    return {
      returnValue: true,
      running: [
        { id: 'netflix', appType: 'native' },
        { id: 'youtube.leanback.v4', appType: 'web' },
        { id: 'com.plexapp.android', appType: 'native' }
      ]
    };
  },
  'com.webos.service.recent/listRecents': function () {
    return {
      returnValue: true,
      recentsAppList: [
        { appId: 'netflix', title: 'Netflix', cardSnapShotFilePath: '/tmp/snapshots/netflix/snap.jpg' },
        { appId: 'youtube.leanback.v4', title: 'YouTube', cardSnapShotFilePath: '/tmp/snapshots/youtube/snap.jpg' },
        { appId: 'com.plexapp.android', title: 'Plex', cardSnapShotFilePath: '/tmp/snapshots/plex/snap.jpg' }
      ]
    };
  },
  'com.webos.service.recent/removeRecent': function () { return { returnValue: true }; },
  'com.webos.service.recent/removeAllRecents': function () { return { returnValue: true }; },
  'com.webos.service.config/getConfigs': function (p) {
    var configs = {
      'tv.model.logoLight': false,
      'com.webos.surfacemanager.keyFilters': [
        { file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleHotkeys' }
      ]
    };
    var out = {};
    ((p && p.configNames) || []).forEach(function (k) {
      if (configs[k] !== undefined) out[k] = configs[k];
    });
    return { returnValue: true, configs: out };
  },
  'com.webos.applicationManager/listLaunchPoints': function () {
    return {
      returnValue: true,
      launchPoints: [
        { id: 'netflix', title: 'Netflix', icon: '' },
        { id: 'youtube.leanback.v4', title: 'YouTube', icon: '' },
        { id: 'com.plexapp.android', title: 'Plex', icon: '' },
        { id: 'amazon', title: 'Prime Video', icon: '' }
      ]
    };
  },
  'com.webos.service.eim/getAllInputStatus': function () {
    return {
      returnValue: true,
      devices: [
        { id: 'HDMI_1', port: 1, label: 'Apple TV', activate: true, connected: true, hdmiPlugIn: true },
        { id: 'HDMI_2', port: 2, label: 'PlayStation 5', activate: false, connected: true, hdmiPlugIn: true },
        { id: 'HDMI_3', port: 3, label: 'HDMI 3', activate: false, connected: false, hdmiPlugIn: false },
        { id: 'HDMI_4', port: 4, label: 'HDMI 4', activate: false, connected: false, hdmiPlugIn: false }
      ]
    };
  },
  'com.webos.service.apiadapter/tv/getChannelList': function () {
    return {
      returnValue: true,
      channelList: [
        { channelId: '1_1_1_0_0_0_0', channelNumber: '1', channelName: 'BBC One HD' },
        { channelId: '1_1_2_0_0_0_0', channelNumber: '2', channelName: 'BBC Two HD' },
        { channelId: '1_1_3_0_0_0_0', channelNumber: '3', channelName: 'ITV1 HD' }
      ]
    };
  },
  'com.webos.service.utp.boot/getLastChannelId': function () {
    return { returnValue: true, channelId: '1_1_1_0_0_0_0' };
  },
  'com.webos.service.apiadapter/tv/getChannelCurrentProgramInfo': function () {
    return { returnValue: true, programName: 'News at Ten' };
  },
  'com.webos.applicationManager/getAppInfo': function (p) {
    return {
      returnValue: true,
      appInfo: {
        id: (p && p.id) || 'com.webos.app.home',
        type: 'web',
        title: 'Home',
        folderPath: '/usr/palm/applications/com.webos.app.home'
      }
    };
  },
  'com.palm.webappmanager/killApp': function () { return { returnValue: true }; },
  'com.webos.applicationManager/closeByAppId': function () { return { returnValue: true }; },
  'com.webos.applicationManager/launch': function () { return { returnValue: true }; },
  'com.webos.settingsservice/getSystemSettings': function () { return { returnValue: true, settings: {} }; },
  'com.webos.settingsservice/setSystemSettings': function () { return { returnValue: true }; },
  'com.webos.service.systemservice/getPreferences': function () { return { returnValue: true, timeFormat: 'HH24' }; },
  'com.webos.service.systemservice/setPreferences': function () { return { returnValue: true }; }
} });

var args = process.argv.slice(2);
var uri = null, payload = {}, subscribe = false;
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === '-n' || a === '-w' || a === '-a') { i++; continue; }
  if (a === '-i') { subscribe = true; continue; }
  if (a === '-f') continue;
  if (a.indexOf('luna://') === 0) { uri = a.slice(7); try { payload = JSON.parse(args[i + 1] || '{}'); } catch (e) {} i++; }
}

if (process.env.FAKE_LUNA_LOG) {
  try { require('fs').appendFileSync(process.env.FAKE_LUNA_LOG, JSON.stringify(args) + '\n'); } catch (e) {}
}

var scripted = null;
if (process.env.FAKE_LUNA_SCRIPT) {
  try { scripted = JSON.parse(require('fs').readFileSync(process.env.FAKE_LUNA_SCRIPT, 'utf8'))[uri] || null; } catch (e) {}
}
if (scripted) {
  process.stdin.on('end', function () { process.exit(0); });
  process.stdin.resume();
  var at = 0;
  (scripted.steps || []).forEach(function (step) {
    at += step.delay || 0;
    setTimeout(function () {
      process.stdout.write(step.raw !== undefined ? step.raw : JSON.stringify(step.out) + '\n');
    }, at);
  });
  setTimeout(function () {
    if (scripted.end === 'exit') process.exit(0);
    if (scripted.end === 'fail') process.exit(1);
  }, at + 20);
  if (scripted.end !== 'exit' && scripted.end !== 'fail') setInterval(function () {}, 60000);
  return;
}

var res = mock.luna[uri];
if (typeof res === 'function') res = res(payload);
if (!res) res = { returnValue: false, errorText: 'Unknown method "' + uri + '"' };
if (res.returnValue === undefined) res.returnValue = true;
if (subscribe) res.subscribed = true;

// The real luna-send goes when the server that started it does; its stdin
// closing is the sign here.
process.stdin.on('end', function () { process.exit(0); });
process.stdin.resume();

// A one-shot call ends once it has answered; a subscription stays open.
function answer() {
  process.stdout.write(JSON.stringify(res) + '\n', function () { if (!subscribe) process.exit(0); });
}

/*
 * Which call this is, among those with the same uri and payload: the first to
 * create <key>.<n> owns n, which holds when calls run side by side.
 */
function callNumber(key) {
  var fs = require('fs'), path = require('path');
  var dir = path.join(process.env.FAKE_ROOT || require('os').tmpdir(), 'fake-luna-calls');
  try { fs.mkdirSync(dir); } catch (e) {}
  for (var n = 0; ; n++) {
    try { fs.closeSync(fs.openSync(path.join(dir, key + '.' + n), 'wx')); return n; } catch (e) {
      if (e.code !== 'EEXIST') return 0;
    }
  }
}

function hashOf(text) {
  var h = 5381;
  for (var c = 0; c < text.length; c++) h = ((h * 33) ^ text.charCodeAt(c)) >>> 0;
  return h;
}

if (process.env.FAKE_LUNA_CHAOS) {
  // Each call takes the next of 20 slots: 2 late, 1 silent, 1 rubbish, 1
  // error, 1 dies, the rest answer. The hash sets where each uri starts, so
  // some fail on their first call and they do not all fail together.
  var key = String(hashOf(uri + ' ' + JSON.stringify(payload)));
  var slot = (callNumber(key) + hashOf(key)) % 20;
  if (subscribe) {
    answer();
    // Some subscriptions drop, as a restarting LG service does.
    if (slot % 10 < 3) setTimeout(function () { process.exit(1); }, 2000 + (slot % 10) * 2000);
    else setInterval(function () {}, 60000);
  } else if (slot < 2) {
    setTimeout(answer, 2000);                                 // late
  } else if (slot === 2) {
    setInterval(function () {}, 60000);                       // never answers
  } else if (slot === 3) {
    process.stdout.write('{"returnValue": tru', function () { process.exit(0); });   // rubbish
  } else if (slot === 4) {
    process.stdout.write(JSON.stringify({ returnValue: false, errorCode: -1, errorText: 'Service busy' }) + '\n',
      function () { process.exit(0); });
  } else if (slot === 5) {
    process.kill(process.pid, 'SIGABRT');                     // dies before answering
  } else {
    answer();
  }
} else {
  answer();
  if (subscribe) setInterval(function () {}, 60000);
}
