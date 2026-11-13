'use strict';

var msg = require('./say').msg;
var fs = require('fs');
var path = require('path');
var readJson = require('./util').readJson;
var execFile = require('child_process').execFile;

var CATALOG = [
  {
    id: 'mycar',
    bin: 'com.webos.service.mycar',
    title: msg('srv.service.mycar', 'Car-to-Home Telematics'),
    unit: 'com.webos.service.mycar.service',
    upstart: null,
    badge: msg('srv.service.badge.ram', '{mb} MB RAM', { mb: '2.1' }),
    desc: msg('srv.service.mycar.desc', 'Hyundai/Kia Bluelink vehicle status listener in Home Dashboard. Unnecessary unless linking a connected vehicle.')
  },
  {
    id: 'camera',
    bin: 'com.webos.service.camera2',
    title: msg('srv.service.camera', 'USB Camera Listener'),
    unit: 'com.webos.service.camera.service',
    upstart: null,
    badge: msg('srv.service.badge.ram', '{mb} MB RAM', { mb: '2.5' }),
    desc: msg('srv.service.camera.desc', 'Background USB webcam detection daemon. Unnecessary unless a USB webcam is physically attached.')
  },
  {
    id: 'uploadd',
    bin: 'uploadd',
    title: msg('srv.service.uploadd', 'Telemetry & Diagnostics Uploader'),
    unit: 'uploadd.service',
    upstart: 'uploadd',
    badge: msg('srv.service.badge.telemetry', 'Telemetry'),
    desc: msg('srv.service.uploadd.desc', 'Uploads crash logs, diagnostic traces, and usage telemetry to LG servers.')
  },
  {
    id: 'rdxd',
    bin: 'rdxd',
    title: msg('srv.service.rdxd', 'Remote Diagnostics Daemon'),
    unit: 'rdxd.service',
    upstart: 'rdxd',
    badge: msg('srv.service.badge.flashWrites', 'Flash writes'),
    desc: msg('srv.service.rdxd.desc', 'Continuously logs diagnostic traces, core dumps, and event data to internal flash memory.')
  },
  {
    id: 'crashreportd',
    bin: 'crashreportd',
    title: msg('srv.service.crashreportd', 'Jira Crash Reporter'),
    unit: null,
    upstart: 'crashreportd',
    badge: msg('srv.service.badge.telemetry', 'Telemetry'),
    desc: msg('srv.service.crashreportd.desc', 'Background daemon on older webOS versions that generates automated crash reports.')
  },
  {
    id: 'contentminer',
    bin: 'contentminer',
    title: msg('srv.service.contentminer', 'ACR Content Miner'),
    unit: 'contentminer.service',
    upstart: null,
    badge: msg('srv.service.badge.ram', '{mb} MB RAM', { mb: '4.2' }),
    desc: msg('srv.service.contentminer.desc', 'Scans and indexes on-screen audio/video content for advertising and viewing habit telemetry.')
  },
  {
    id: 'nudge',
    bin: 'nudge',
    title: msg('srv.service.nudge', 'LG Promotions & Tips Popups'),
    unit: 'nudge.service',
    upstart: null,
    badge: msg('srv.service.badge.ram', '{mb} MB RAM', { mb: '3.1' }),
    desc: msg('srv.service.nudge.desc', 'Pushes marketing notifications, promotional popups, and feature tips to the TV interface.')
  },
  {
    id: 'remotelogger',
    bin: 'remotelogger',
    title: msg('srv.service.remotelogger', 'Remote Logging Daemon'),
    unit: 'remotelogger.service',
    upstart: 'remotelogger',
    badge: msg('srv.service.badge.ram', '{mb} MB RAM', { mb: '1.7' }),
    desc: msg('srv.service.remotelogger.desc', 'Ships system log messages to remote servers.')
  },
  /*
   * Started by the service hub whenever something calls it (Type=dynamic in
   * /usr/share/dbus-1/system-services), with no unit to stop or mask, so it is
   * held down by mounting a program that exits at once over its own: the hub
   * then starts that instead. A reboot or an unmount puts it back.
   * iconnectivity (com.webos.service.ics, UEI QuickSet) is what reverse-looks
   * up every address on the TV's network (#244). It is switched from the
   * Devices section, as Network device scans, beside LG's Auto device
   * detection, which on webOS 11 does not stop it (#1260), so it is not listed
   * with the others.
   */
  // QuickSet is also universal control's IR blaster (com.webos.service.ics/blaster):
  // held down, a set-top box set up for it stops answering the Magic Remote a few
  // seconds after start, and LG's set-up hangs (#1266).
  {
    id: 'iconnectivity',
    bin: 'iconnectivity',
    title: msg('srv.service.iconnectivity', 'Network Device Scans'),
    unit: null,
    upstart: null,
    stub: '/usr/sbin/iconnectivity',
    badge: msg('srv.service.badge.network', 'Network'),
    desc: msg('srv.service.iconnectivity.desc', 'Looks up every address on the home network to find devices for the Home Hub and LG\'s device setup. Off, they find no new devices.'),
    hidden: true
  },
  /*
   * iotframework asks iconnectivity for a scan every 300 s on webOS 11 (an
   * OLED65C2PUA, firmware 43.21.74). Held down, an hourly sweep was left (an
   * OLED65C34LA), and it serves the Home Hub's smart home devices, so it is no
   * longer offered: held down by an earlier release, it is put back at start.
   */
  {
    id: 'iotframework',
    bin: 'com.webos.iotframework',
    unit: null,
    upstart: null,
    stub: '/usr/palm/services/com.webos.iotframework/com.webos.iotframework',
    hidden: true,
    retired: true
  },
  /*
   * LG's voice assistant: the AI button, voice search and the microphone. Not
   * listed with the others: Remote keys switches it off while the AI button is
   * set, as with it running LG's voice screen opens over the app chosen (a C5,
   * webOS 11.2.0), and back on once the button is LG's again.
   */
  {
    id: 'voiceconductor',
    bin: 'voiceconductor',
    title: msg('srv.service.voiceconductor', 'LG Voice Assistant'),
    unit: 'voiceconductor.service',
    upstart: null,
    badge: '',
    desc: msg('srv.service.voiceconductor.desc', 'LG\'s voice assistant: the AI button, voice search and the microphone.'),
    hidden: true
  }
];

/*
 * Once on the list, now never to be switched off; init() switches them back on
 * for anyone who had. tvdataexchanger left the video plane muted after power
 * on (docs/IMPLEMENTATION.md). Without alwaysready, Plex showed video stretched
 * vertically on an OLED65C4PUA (webOS 10.3.1, firmware 33.31.68) until the
 * service was back and the TV rebooted; Always Ready itself is switched off
 * under Advanced.
 */
var RETIRED = ['tvdataexchanger', 'alwaysready'];

var stateDir = '/var/lib/tvweb';
var disabledFilePath = null;
// run-parts skips any name containing a character outside a-zA-Z0-9-_, so the
// hook must not end in .sh. It once did, and never ran.
var initScriptPath = '/var/lib/webosbrew/init.d/20-tvweb-services';
var oldInitScriptPath = '/var/lib/webosbrew/init.d/20-services.sh';
var transientDir = '/run/systemd/transient';
// Prefixed to a stub's path, and the mount table read, for the tests.
var stubRoot = '';
var mountsPath = '/proc/mounts';
var run = execFile;

function stubFile() { return path.join(stateDir, 'service-stub'); }
function stubTarget(item) { return stubRoot + item.stub; }

function isStubbed(item) {
  var text = '';
  try { text = fs.readFileSync(mountsPath, 'utf8'); } catch (e) { return false; }
  var target = stubTarget(item);
  return text.split('\n').some(function (line) { return line.split(' ')[1] === target; });
}

function writeStubFile() {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, 493);
    fs.writeFileSync(stubFile(), '#!/bin/sh\nexit 0\n', { mode: 493 });
    fs.chmodSync(stubFile(), 493);
    return true;
  } catch (e) { return false; }
}

// Answers once they have gone, so the list read straight after the switch shows it stopped.
function stopPrograms(item, cb) {
  var tries = 0;
  (function signal() {
    var pids = runningPrograms()[item.bin] || [];
    if (!pids.length || tries > 6) return cb();
    pids.forEach(function (pid) {
      try { process.kill(pid, tries === 6 ? 'SIGKILL' : 'SIGTERM'); } catch (e) {}
    });
    tries++;
    setTimeout(signal, 500);
  })();
}

// The program found running is stopped after the mount, so the hub's next start is the stub.
function stub(item, cb) {
  if (isStubbed(item)) return stopPrograms(item, function () { cb(true); });
  if (!writeStubFile()) return cb(false);
  run('mount', ['--bind', stubFile(), stubTarget(item)], function (err) {
    if (err) console.error('services: could not hold ' + item.id + ' down: ' + err.message);
    stopPrograms(item, function () { cb(!err); });
  });
}

// Each mount is undone; the hub starts the real program at the next call.
function unstub(item, cb) {
  if (!isStubbed(item)) return cb(true);
  run('umount', [stubTarget(item)], function (err) {
    if (err) console.error('services: could not put ' + item.id + ' back: ' + err.message);
    cb(!err);
  });
}

// For the uninstall: the paths a stub may be mounted on.
function stubTargets() {
  return CATALOG.filter(function (item) { return item.stub; }).map(stubTarget);
}

// The processes running, by program name, from each one's executable.
function runningPrograms() {
  var out = {}, pids = [];
  try { pids = fs.readdirSync('/proc'); } catch (e) { return out; }
  for (var i = 0; i < pids.length; i++) {
    if (!/^\d+$/.test(pids[i])) continue;
    try {
      var name = path.basename(fs.readlinkSync('/proc/' + pids[i] + '/exe'));
      (out[name] = out[name] || []).push(parseInt(pids[i], 10));
    } catch (e2) {}
  }
  return out;
}

/*
 * Stops any switched-off service found running. The boot hook stops them
 * once, but on webOS 9 the service hub launches some on demand whenever
 * something asks for them, outside the unit: uploadd was seen running 22s into
 * a C2's boot, before the hook got to it. The unit or job is stopped first, so
 * nothing supervising it starts it again; anything left is then signalled
 * directly, which is how one the hub launched ends.
 */
function enforce() {
  var disabled = readDisabledList();
  if (!disabled.length) return;
  var procs = runningPrograms(), systemctl = getSystemctl(), initctl = getInitctl();
  CATALOG.forEach(function (item) {
    if (item.stub && disabled.indexOf(item.id) !== -1 && fs.existsSync(stubTarget(item)) && !isStubbed(item)) {
      console.log('services: ' + item.id + ' was not held down while switched off, holding it');
      return stub(item, function () {});
    }
    var pids = item.bin && procs[item.bin];
    if (!pids || disabled.indexOf(item.id) === -1) return;
    console.log('services: ' + item.id + ' was running while switched off, stopping it');
    if (systemctl && item.unit) execFile(systemctl, ['stop', item.unit], function () {});
    if (initctl && item.upstart) execFile(initctl, ['stop', item.upstart], function () {});
    setTimeout(function () {
      var left = runningPrograms()[item.bin] || [];
      left.forEach(function (pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} });
    }, 3000);
  });
}

function startEnforcing() {
  setTimeout(enforce, 30000);
  setInterval(enforce, 5 * 60000);
}

function getSystemctl() {
  if (fs.existsSync('/bin/systemctl')) return '/bin/systemctl';
  if (fs.existsSync('/usr/bin/systemctl')) return '/usr/bin/systemctl';
  return null;
}

function getInitctl() {
  if (fs.existsSync('/sbin/initctl')) return '/sbin/initctl';
  if (fs.existsSync('/usr/sbin/initctl')) return '/usr/sbin/initctl';
  return null;
}

function getDisabledFile() {
  if (!disabledFilePath) {
    disabledFilePath = path.join(stateDir, 'disabled_services.json');
  }
  return disabledFilePath;
}

function readDisabledList() {
  var list = readJson(getDisabledFile(), null);
  return Array.isArray(list) ? list : [];
}

function writeDisabledList(list) {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, 493); // 0755
    }
    fs.writeFileSync(getDisabledFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {}

  syncBootScript(list);
}

function syncBootScript(disabledList) {
  var initDir = path.dirname(initScriptPath);
  if (!fs.existsSync(initDir)) return;

  if (!disabledList || !disabledList.length) {
    try {
      if (fs.existsSync(initScriptPath)) fs.unlinkSync(initScriptPath);
    } catch (e) {}
    return;
  }

  /*
   * In the background: run-parts runs the hooks one at a time, and
   * daemon-reload alone took 7 s on a 50QNED87T6B (webOS 10.2.2), all of it
   * before 50-tvweb could put Glasshouse Home in place.
   */
  var lines = [
    '#!/bin/sh',
    '# tvweb managed disabled services',
    '('
  ];
  CATALOG.forEach(function (item) {
    if (!item.stub || disabledList.indexOf(item.id) === -1) return;
    var target = stubTarget(item);
    lines.push('[ -e "' + target + '" ] && [ -x "' + stubFile() + '" ] && ! grep -q " ' + target + ' " /proc/mounts && mount --bind "' + stubFile() + '" "' + target + '"');
  });
  lines.push('if which systemctl >/dev/null 2>&1; then');
  lines.push('  mkdir -p /run/systemd/transient');

  var upstartJobs = [];
  for (var i = 0; i < CATALOG.length; i++) {
    var item = CATALOG[i];
    if (disabledList.indexOf(item.id) !== -1) {
      if (item.unit) {
        lines.push('  ln -sf /dev/null "/run/systemd/transient/' + item.unit + '"');
        lines.push('  systemctl stop "' + item.unit + '" 2>/dev/null');
      }
      if (item.upstart) {
        upstartJobs.push(item.upstart);
      }
    }
  }
  lines.push('  systemctl daemon-reload 2>/dev/null');

  if (upstartJobs.length) {
    lines.push('elif which initctl >/dev/null 2>&1; then');
    for (var j = 0; j < upstartJobs.length; j++) {
      lines.push('  initctl stop "' + upstartJobs[j] + '" 2>/dev/null');
    }
  }
  lines.push('fi');
  lines.push(') </dev/null >/dev/null 2>&1 &');
  lines.push('');

  var text = lines.join('\n');
  try {
    // Written only where it differs: this runs at every server start.
    if (fs.existsSync(initScriptPath) && fs.readFileSync(initScriptPath, 'utf8') === text) return;
    fs.writeFileSync(initScriptPath, text, { mode: 493 }); // 0755
  } catch (e) {}
}

function serviceExists(item, systemctl, initctl) {
  if (item.stub) return fs.existsSync(stubTarget(item));
  if (systemctl && item.unit) {
    if (fs.existsSync('/etc/systemd/system/' + item.unit) ||
        fs.existsSync('/lib/systemd/system/' + item.unit) ||
        fs.existsSync('/usr/lib/systemd/system/' + item.unit)) {
      return true;
    }
  }
  if (initctl && item.upstart) {
    if (fs.existsSync('/etc/init/' + item.upstart + '.conf')) {
      return true;
    }
  }
  return false;
}

function init(options) {
  if (options && options.stateDir) {
    stateDir = options.stateDir;
    disabledFilePath = path.join(stateDir, 'disabled_services.json');
  }
  if (options && options.stubRoot !== undefined) stubRoot = options.stubRoot;
  if (options && options.mounts) mountsPath = options.mounts;
  if (options && options.run) run = options.run;
  if (options && options.initDir) {
    initScriptPath = path.join(options.initDir, path.basename(initScriptPath));
    oldInitScriptPath = path.join(options.initDir, path.basename(oldInitScriptPath));
  }

  var disabled = readDisabledList();
  // A stubbed entry no longer offered is put back, as a retired unit is unmasked below.
  CATALOG.forEach(function (item) {
    if (item.retired && item.stub && (disabled.indexOf(item.id) !== -1 || isStubbed(item))) {
      unstub(item, function (ok) { if (ok) console.log('services: ' + item.id + ' put back, as it is no longer offered'); });
    }
  });
  var kept = disabled.filter(function (id) {
    return RETIRED.indexOf(id) === -1 && !CATALOG.some(function (item) { return item.id === id && item.retired; });
  });
  if (kept.length !== disabled.length) {
    disabled = kept;
    writeDisabledList(disabled);
  }
  try {
    if (fs.existsSync(oldInitScriptPath)) fs.unlinkSync(oldInitScriptPath);
  } catch (e) {}
  // Written again at each start, so a hook from an earlier release takes this one's form.
  syncBootScript(disabled);
  CATALOG.forEach(function (item) {
    if (item.stub && disabled.indexOf(item.id) !== -1 && fs.existsSync(stubTarget(item))) stub(item, function () {});
  });

  var systemctl = getSystemctl();

  if (systemctl) {
    try {
      if (!fs.existsSync(transientDir)) {
        fs.mkdirSync(transientDir, 493);
      }
      var reloaded = false, unmasked = [];

      // Unmask the retired units, which an earlier version may have masked
      for (var d = 0; d < RETIRED.length; d++) {
        var depMask = path.join(transientDir, RETIRED[d] + '.service');
        if (fs.existsSync(depMask)) {
          try {
            fs.unlinkSync(depMask);
            unmasked.push(RETIRED[d] + '.service');
            reloaded = true;
          } catch (e) {}
        }
      }

      for (var i = 0; i < CATALOG.length; i++) {
        var item = CATALOG[i];
        if (item.unit && disabled.indexOf(item.id) !== -1) {
          var maskFile = path.join(transientDir, item.unit);
          if (!fs.existsSync(maskFile)) {
            try {
              fs.symlinkSync('/dev/null', maskFile);
              reloaded = true;
            } catch (e) {}
          }
        }
      }
      if (reloaded) {
        execFile(systemctl, ['daemon-reload'], function () {
          if (unmasked.length) execFile(systemctl, ['start'].concat(unmasked), function () {});
        });
      }
    } catch (e) {}
  }
}

function getServices(cb) {
  var systemctl = getSystemctl();
  var initctl = getInitctl();

  var stubbable = CATALOG.some(function (item) { return item.stub && !item.hidden && serviceExists(item); });
  if (!systemctl && !initctl && !stubbable) {
    return cb({ ok: true, supported: false, services: [] });
  }

  var disabledList = readDisabledList();
  var available = [];

  for (var i = 0; i < CATALOG.length; i++) {
    var item = CATALOG[i];
    if (!item.hidden && serviceExists(item, systemctl, initctl)) {
      available.push({
        id: item.id,
        title: item.title,
        badge: item.badge,
        desc: item.desc,
        unit: item.unit || item.upstart || item.bin,
        disabled: disabledList.indexOf(item.id) !== -1,
        running: false
      });
    }
  }

  if (!available.length) {
    return cb({ ok: true, supported: true, services: [] });
  }

  // Probe running state for available services
  var procs = runningPrograms();
  var pending = available.length;
  function doneOne() {
    pending--;
    if (pending <= 0) {
      cb({ ok: true, supported: true, services: available });
    }
  }

  for (var j = 0; j < available.length; j++) {
    (function (svc) {
      // Probed even when switched off: the setting says what was asked for,
      // not what the TV did, and the two differed while the boot hook was
      // never run.
      var catItem = null;
      for (var k = 0; k < CATALOG.length; k++) {
        if (CATALOG[k].id === svc.id) { catItem = CATALOG[k]; break; }
      }
      // The program itself counts as well as the unit or job: on webOS 9 the
      // service hub launches some of these on demand, outside the unit that
      // systemd reports on (uploadd, observed 22s into a boot on a C2).
      var seen = !!(catItem && catItem.bin && procs[catItem.bin]);
      if (systemctl && catItem && catItem.unit) {
        execFile(systemctl, ['is-active', catItem.unit], function (err, stdout) {
          svc.running = seen || (!err && String(stdout).trim() === 'active');
          doneOne();
        });
      } else if (initctl && catItem && catItem.upstart) {
        execFile(initctl, ['status', catItem.upstart], function (err, stdout) {
          svc.running = seen || (!err && String(stdout).indexOf('start/running') !== -1);
          doneOne();
        });
      } else {
        svc.running = seen;
        doneOne();
      }
    })(available[j]);
  }
}

function toggleService(id, disabled, cb) {
  switchService(id, disabled, cb, false);
}

// For what owns a hidden entry: Remote keys and the voice assistant, and the Devices section's network scans.
function switchHidden(id, disabled, cb) {
  switchService(id, disabled, cb, true);
}

function switchService(id, disabled, cb, hiddenToo) {
  var catItem = null;
  for (var i = 0; i < CATALOG.length; i++) {
    if (CATALOG[i].id === id) { catItem = CATALOG[i]; break; }
  }
  if (!catItem || catItem.retired || (catItem.hidden && !hiddenToo)) {
    return cb({ ok: false, error: 'Unknown service ID: ' + id });
  }

  var systemctl = getSystemctl();
  var initctl = getInitctl();
  if (!systemctl && !initctl && !catItem.stub) {
    return cb({ ok: false, error: msg('srv.service.unsupported', 'Service management is not supported on this platform') });
  }

  var list = readDisabledList();
  var idx = list.indexOf(id);

  if (disabled) {
    if (idx === -1) list.push(id);
  } else {
    if (idx !== -1) list.splice(idx, 1);
  }
  writeDisabledList(list);

  if (catItem.stub) {
    return (disabled ? stub : unstub)(catItem, function (ok) {
      if (!ok) return cb({ ok: false, error: msg('srv.service.stubFailed', 'The TV did not allow the change') });
      cb({ ok: true, id: id, disabled: !!disabled, running: false });
    });
  } else if (systemctl && catItem.unit) {
    var maskFile = path.join(transientDir, catItem.unit);
    if (disabled) {
      try {
        if (!fs.existsSync(transientDir)) fs.mkdirSync(transientDir, 493);
        if (!fs.existsSync(maskFile)) fs.symlinkSync('/dev/null', maskFile);
      } catch (e) {}
      execFile(systemctl, ['daemon-reload'], function () {
        execFile(systemctl, ['stop', catItem.unit], function () {
          cb({ ok: true, id: id, disabled: true, running: false });
        });
      });
    } else {
      try {
        if (fs.existsSync(maskFile)) fs.unlinkSync(maskFile);
      } catch (e) {}
      execFile(systemctl, ['daemon-reload'], function () {
        execFile(systemctl, ['start', catItem.unit], function () {
          cb({ ok: true, id: id, disabled: false, running: true });
        });
      });
    }
  } else if (initctl && catItem.upstart) {
    var cmd = disabled ? 'stop' : 'start';
    execFile(initctl, [cmd, catItem.upstart], function () {
      cb({ ok: true, id: id, disabled: !!disabled, running: !disabled });
    });
  } else {
    cb({ ok: true, id: id, disabled: !!disabled });
  }
}

// Whether the TV has this catalog service, so that it can be switched off.
function available(id) {
  var systemctl = getSystemctl(), initctl = getInitctl();
  for (var i = 0; i < CATALOG.length; i++) {
    if (CATALOG[i].id === id) return serviceExists(CATALOG[i], systemctl, initctl);
  }
  return false;
}

function isDisabled(id) {
  return readDisabledList().indexOf(id) !== -1;
}

module.exports = {
  init: init,
  CATALOG: CATALOG,
  getServices: getServices,
  toggleService: toggleService,
  switchHidden: switchHidden,
  isDisabled: isDisabled,
  available: available,
  stubTargets: stubTargets,
  startEnforcing: startEnforcing
};
