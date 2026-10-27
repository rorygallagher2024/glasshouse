#!/usr/bin/env node
/*
 * scripts/emulate-tv.js - Runs Glasshouse locally on macOS/Linux in a virtual TV environment.
 *
 * Simulates procfs, sysfs, Luna bus calls, installed apps, remote keys, recent apps,
 * and OLED care telemetry, allowing developers to preview and interact with:
 *   - The Web Dashboard:      http://localhost:8080/
 *   - The TV App Dashboard:   http://localhost:8080/assets/dashboard.html
 *   - Glasshouse Home:        http://localhost:8080/assets/home.html
 *
 * Usage:
 *   node scripts/emulate-tv.js [--port 8080] [--model c2|b8|c3|cx|c1] [--webos 6.5.3] [--home on|off] [--open]
 *
 * --webos reports another webOS version on the chosen model, to see how the
 * dashboards treat a version no profile covers.
 */
'use strict';

const child = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Parse command line arguments
const args = process.argv.slice(2);
let port = 8080;
let model = 'c2';
let autoOpen = false;
let webosOverride = null;
let homeOn = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[++i], 10); }
  else if (args[i] === '--model' && args[i + 1]) { model = args[++i].toLowerCase(); }
  else if (args[i] === '--webos' && args[i + 1]) { webosOverride = args[++i]; }
  else if (args[i] === '--home' && /^(on|off)$/.test(args[i + 1] || '')) { homeOn = args[++i] === 'on'; }
  else if (args[i] === '--open') { autoOpen = true; }
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node scripts/emulate-tv.js [options]');
    console.log('Options:');
    console.log('  --port <number>    HTTP port to bind (default: 8080)');
    console.log('  --model <c2|b8|c3|cx|c1> TV profile to simulate (default: c2)');
    console.log('  --webos <version>  webOS version to report instead of the profile\'s, e.g. 6.5.3');
    console.log('  --home <on|off>    start with Glasshouse Home switched on or off (default: on from webOS 7)');
    console.log('  --open             Automatically open the dashboard in browser');
    process.exit(0);
  }
}

// Model profiles
const PROFILES = {
  c2: {
    name: 'LG C2 (OLED65C26LD - webOS 9.2)',
    modelName: 'OLED65C26LD',
    boardType: 'O22N_DVB_EU',
    firmwareVersion: '03.33.95',
    sdkVersion: '7.3.0',
    webosVersion: '9.2.0',
    webosMajor: 9,
    oled: true
  },
  b8: {
    name: 'LG B8 (OLED65B8SLC - webOS 4.4)',
    modelName: 'OLED65B8SLC',
    boardType: 'M16P_DVB_EU',
    firmwareVersion: '05.50.70',
    sdkVersion: '4.4.3',
    webosVersion: '4.4.3',
    webosMajor: 4,
    oled: true
  },
  c3: {
    name: 'LG C3 (OLED65C35LA - webOS 10.3)',
    modelName: 'OLED65C35LA',
    boardType: 'O23N_DVB_EU',
    firmwareVersion: '04.40.75',
    sdkVersion: '8.3.0',
    webosVersion: '10.3.1',
    webosMajor: 10,
    oled: true
  },
  // The model, firmware and webOS version of test/fixtures/stats-cx-webos5.json.
  cx: {
    name: 'LG CX (OLED77CXAUA - webOS 5.6)',
    modelName: 'OLED77CXAUA',
    boardType: 'O20_ATSC_US',
    firmwareVersion: '04.60.65',
    sdkVersion: '5.6.0',
    webosVersion: '5.6.0',
    webosMajor: 5,
    oled: true
  },
  // webOS 6 as a C1 in #910 reported it; the model details are illustrative.
  c1: {
    name: 'LG C1 (OLED65C14LB - webOS 6.5)',
    modelName: 'OLED65C14LB',
    boardType: 'O21_DVB_EU',
    firmwareVersion: '03.36.30',
    sdkVersion: '6.5.3',
    webosVersion: '6.5.3',
    webosMajor: 6,
    oled: true
  }
};

if (!PROFILES[model]) {
  console.error(`Unknown model "${model}": one of ${Object.keys(PROFILES).join(', ')}`);
  process.exit(2);
}
const profile = Object.assign({}, PROFILES[model]);
if (webosOverride) {
  if (!/^\d+(\.\d+){1,3}$/.test(webosOverride)) {
    console.error(`--webos takes a version such as 6.5.3, not "${webosOverride}"`);
    process.exit(2);
  }
  profile.webosVersion = profile.sdkVersion = webosOverride;
  profile.webosMajor = parseInt(webosOverride, 10);
  profile.name = `${profile.name.replace(/ - webOS [^)]*\)$/, '')} - webOS ${webosOverride}, overridden)`;
}

function checkPortFree(p) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(p, '127.0.0.1');
  });
}

async function getAvailablePort(desiredPort) {
  if (await checkPortFree(desiredPort)) return desiredPort;
  console.log(`Port ${desiredPort} is in use; picking an available port...`);
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function main() {
  const chosenPort = await getAvailablePort(port);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-emulate-'));

  const webosVer = profile.webosVersion || profile.sdkVersion;

  // Seed mock files
  const mockEnv = require(path.join(ROOT, 'test', 'mocks', 'mock-env')).createMockEnv();
  const files = Object.assign({}, mockEnv.files, {
    '/etc/issue': `webOS ${webosVer} \\n \\l\n`,
    '/etc/issue.net': `webOS ${webosVer}\n`,
    '/etc/starfish-release': `Starfish release ${webosVer} (broadway)\n`,
    '/proc/lg/pm/temperature': '42\n',
    '/var/luna/preferences/environmentCondition': JSON.stringify({ boardTypeStr: profile.boardType, socChip: profile.boardType })
  });

  for (const f of Object.keys(files)) {
    if (files[f] === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), files[f]);
  }

  for (const d of [
    'var/run', 'var/luna/preferences', 'var/lib/tvweb', 'tmp/snapshots/netflix',
    'tmp/snapshots/youtube', 'tmp/snapshots/plex', 'usr/lib/qt5/qml/KeyFilters'
  ]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }

  if (profile.oled) {
    fs.writeFileSync(path.join(root, 'var/luna/preferences/paneltype_oled'), '');
  }

  // Create mock snapshots (empty 1x1 jpg/png placeholders)
  const dummyJpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  fs.writeFileSync(path.join(root, 'tmp/snapshots/netflix/snap.jpg'), dummyJpg);
  fs.writeFileSync(path.join(root, 'tmp/snapshots/youtube/snap.jpg'), dummyJpg);
  fs.writeFileSync(path.join(root, 'tmp/snapshots/plex/snap.jpg'), dummyJpg);

  // Key filters in Qt5 KeyFilters for remote keys detection
  const keyFilterSource = `
    case WebOS.Key_webOS_Netflix:
    case WebOS.Key_webOS_Amazon:
    case WebOS.Key_webOS_Disneyplus:
    case WebOS.Key_webOS_Rakuten:
    case WebOS.Key_webOS_TVGuide:
    case WebOS.Key_webOS_InputSource:
    case WebOS.Key_webOS_Red:
    case WebOS.Key_webOS_Green:
    case WebOS.Key_webOS_Yellow:
    case WebOS.Key_webOS_Blue:
  `;
  fs.writeFileSync(path.join(root, 'usr/lib/qt5/qml/KeyFilters/appLaunch.js'), keyFilterSource);

  // Config with full controls enabled
  const cfg = path.join(root, 'var/lib/tvweb/config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: chosenPort,
    host: '0.0.0.0',
    allowControl: true,
    allowPower: true,
    allowExperimentalHome: true,
    token: ''
  }, null, 2));

  // Glasshouse Home starts switched on where main supports it, webOS 7 and
  // later. Seeded on where it is not, the Home tab shows a switch-off left
  // unfinished, which no real TV would have; --home on is for a branch that
  // adds a version. Switching it here does nothing: nothing is mounted.
  const homeCfg = {
    enabled: homeOn === null ? profile.webosMajor >= 7 : homeOn,
    rows: ['app', 'dev', 'ch'],
    order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' },
    hidden: {
      app: [
        'com.webos.app.lgchannels',
        'com.webos.app.sportsteamsettings',
        'com.webos.app.lifeonscreen',
        'amazon.alexa.view',
        'com.webos.app.camera'
      ],
      dev: [],
      ch: []
    },
    channels: [
      { id: '1_1_1_0_0_0_0', name: 'BBC One HD', number: '1' },
      { id: '1_1_2_0_0_0_0', name: 'BBC Two HD', number: '2' },
      { id: '1_1_3_0_0_0_0', name: 'ITV1 HD', number: '3' }
    ],
    hintSeen: true,
    picture: false
  };
  fs.writeFileSync(path.join(root, 'var/lib/tvweb/home.json'), JSON.stringify(homeCfg, null, 2));

  const fakeLuna = path.join(ROOT, 'test', 'mocks', 'fake-luna-send.js');

  console.log(`\n======================================================`);
  console.log(`  📺 Starting Glasshouse TV Emulator`);
  console.log(`  TV Model: ${profile.name}`);
  console.log(`  Local Port: ${chosenPort}`);
  console.log(`======================================================\n`);

  const srv = child.spawn(process.execPath, [
    path.join(ROOT, 'test', 'mocks', 'boot-server.js'),
    '--config', cfg
  ], {
    env: Object.assign({}, process.env, {
      FAKE_ROOT: root,
      TVWEB_LUNA_SEND: fakeLuna,
      TV_MODEL: model,
      // What the mock system property service answers (test/mocks/fake-luna-send.js).
      TV_PROFILE: JSON.stringify({ modelName: profile.modelName, firmwareVersion: profile.firmwareVersion,
        boardType: profile.boardType, sdkVersion: profile.sdkVersion })
    })
  });

  srv.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('[INFO]') || s.includes('[WARN]') || s.includes('[ERR]')) {
      process.stdout.write(s);
    }
  });

  srv.stderr.on('data', d => {
    process.stderr.write(d);
  });

  function cleanup() {
    console.log('\nStopping emulator...');
    try { srv.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    try { srv.kill('SIGKILL'); } catch (e) {}
  });

  // Wait for server to bind
  const base = `http://localhost:${chosenPort}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      await new Promise((resolve, reject) => {
        http.get(`${base}/api/stats`, res => {
          if (res.statusCode === 200) resolve();
          else reject(new Error('status ' + res.statusCode));
        }).on('error', reject);
      });
      ready = true;
      break;
    } catch (e) {}
  }

  if (!ready) {
    console.error('Failed to start server within 10 seconds.');
    cleanup();
    return;
  }

  console.log(`\n✨ TV Emulator is READY! Open these in your browser:\n`);
  console.log(`  🌐 Web Dashboard:      ${base}/`);
  console.log(`  📺 TV App Dashboard:   ${base}/assets/dashboard.html`);
  console.log(`  🏠 Glasshouse Home:    ${base}/assets/home.html`);
  console.log(`\n  (Press Ctrl+C to stop the emulator)\n`);

  if (autoOpen) {
    const cmd = process.platform === 'darwin' ? `open "${base}/"` : (process.platform === 'win32' ? `start "" "${base}/"` : `xdg-open "${base}/"`);
    child.exec(cmd);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
