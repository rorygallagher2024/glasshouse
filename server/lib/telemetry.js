/**
 * telemetry.js - Device telemetry, hardware detection, and procfs profiling for webOS
 *
 * Gathers system hardware info, CPU/memory stats, process tree profiling,
 * HDMI PHY receiver diagnostics, network throughput, and audio/picture configurations.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var msg = require('./say').msg;
var fs = require('fs');
var readTrimmed = require('./util').readTrimmed;
var toInt = require('./util').toInt;
var path = require('path');
var execFile = require('child_process').execFile;
var ha = require('./ha');
var timers = require('./timers');

var SOUND_OUTPUT_MAP = ha.SOUND_OUTPUT_MAP;

// LG's own reading where it exists. Models without it (the 55QNED826QB, webOS
// 7.6) still have the kernel's thermal zone, in millidegrees: 68000 = 68 C.
var LG_THERMAL = '/proc/lg/pm/temperature';
var SYS_THERMAL = '/sys/class/thermal/thermal_zone0/temp';
var THERMAL_SOURCE = fs.existsSync(LG_THERMAL) ? LG_THERMAL : fs.existsSync(SYS_THERMAL) ? SYS_THERMAL : null;
var THERMAL_PRESENT = !!THERMAL_SOURCE;
var EMMC_WEAR_PRESENT = fs.existsSync('/sys/block/mmcblk0/device/life_time');

var lunaFn = null;
var lunaCachedFn = null;
var configObj = null;
/** @type {typeof import('./oled')} */
var oledModule = null;
/** @type {typeof import('./privacy')} */
var privacyModule = null;
/** @type {typeof import('./screensavers')} */
var screensaversModule = null;
/** @type {typeof import('./game')} */
var gameModule = null;
var alwaysReadyScreenOn = false;
var tvwebVersionStr = '0.0.0';
var mapPowerStateFn = null;
var isScreenSaverFn = null;

var HARDWARE_INFO = {
  webos: null,
  socArch: null,
  ram: null,
  refreshRate: null,
  eyeSensor: null,
  cell: null,
  tconFirmware: null,
  tconModule: null
};

var hasLogoLight = null;   // null = not yet determined
var powerTimersSeen = null; // LG's On and Off Timers, once the TV's settings are read
var hasLightSensor = false;
var lightSensorFailures = 0;
var lastLightSensorProbe = 0;
/*
 * Whether the TV has reported a playback state, kept across restarts as the
 * HDMI fields are: Player State is withheld until it has, and while it lived
 * only in memory, each restart (a B8 waking from deep standby, say) took the
 * entity out of Home Assistant until something next played.
 */
var MEDIA_SEEN_FILE = '/var/lib/tvweb/media_seen';
var hasMediaState = false;
function noteMediaSeen() {
  if (hasMediaState) return;
  hasMediaState = true;
  try { fs.writeFileSync(MEDIA_SEEN_FILE, '1\n', 'utf8'); } catch (e) {}
}

// HDMI fields the TV has reported. Home Assistant only gets the entities for
// these, and withholding one deletes it there, so the set is kept across
// restarts: a restart with no source connected would otherwise remove them.
var HDMI_SEEN_FILE = '/var/lib/tvweb/hdmi_seen';
var hdmiSeen = {};

function loadHdmiSeen() {
  hdmiSeen = {};
  var saved = readTrimmed(HDMI_SEEN_FILE);
  if (!saved) return;
  var fields = saved.split('\n');
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].trim()) hdmiSeen[fields[i].trim()] = true;
  }
}

function noteHdmiSeen(diag) {
  if (!diag) return;
  var added = false;
  for (var f in diag) {
    if (f !== 'port' && diag[f] !== null && !hdmiSeen[f]) {
      hdmiSeen[f] = true;
      added = true;
    }
  }
  if (!added) return;
  try { fs.writeFileSync(HDMI_SEEN_FILE, Object.keys(hdmiSeen).sort().join('\n') + '\n', 'utf8'); }
  catch (e) {}
}

var prevNet = null;
var TEMP_HISTORY_MAX = 120;
var tempHistory = [];
var bootEpoch = 0;

var lastStats = null;
var lastStatsTime = 0;
var isCollecting = false;
var statsWaiters = [];

var EOL_MAP = { 1: 'Normal', 2: 'Warning', 3: 'Urgent' };
var EMMC_CACHE = null;
var SWAP_BACKING_CACHE = null;
var MAC_CACHE = {};
var cachedRemote = null;
var lastRemoteCheck = 0;
var cachedAppStorage = null;
var lastAppStorageCheck = 0;
var APP_STORAGE_TTL = 60000;
var CPU_WINDOW_MS = 700;

var lastPicModes = [];
var inputNameMap = {};
var lastInputScan = 0;
var installedApps = [];
// Every app's title by id, hidden ones included: the app list leaves out apps
// hidden from the home screen, but one can still be the app on screen.
var appTitles = {};
var lastAppsScan = 0;

var SOC_ARCH = {
  O22: 'Alpha 9 Gen 5 (O22)',
  O20: 'Alpha 9 Gen 3 (O20)',
  O18: 'Alpha 9 Gen 1 (O18)',
  M16P: 'Alpha 7 (M16P)',
  M16PLUS: 'Alpha 7 (M16P)'
};


function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  lunaCachedFn = opts.lunaCached;
  if (lunaFn) alwaysOnSupported();
  configObj = opts.config;
  oledModule = opts.oled;
  privacyModule = opts.privacy;
  screensaversModule = opts.screensavers;
  gameModule = opts.game;
  tvwebVersionStr = opts.tvwebVersion || '0.0.0';
  mapPowerStateFn = opts.mapPowerState;
  isScreenSaverFn = opts.isScreenSaver;
  loadHdmiSeen();
  hasMediaState = readTrimmed(MEDIA_SEEN_FILE) !== null;
}

function meminfo() {
  var out = {}, raw = readTrimmed('/proc/meminfo');
  if (!raw) return out;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

function emmcInfo() {
  if (EMMC_CACHE) return EMMC_CACHE;
  var raw = readTrimmed('/sys/block/mmcblk0/device/life_time');
  var eolRaw = readTrimmed('/sys/block/mmcblk0/device/pre_eol_info');
  var eol = EOL_MAP[parseInt(eolRaw, 16)] || 'unknown';
  if (!raw) {
    EMMC_CACHE = { life: 'unknown', wear: 'unknown', health: 'unknown', eol: eol, life_est_a: null, life_est_b: null };
    return EMMC_CACHE;
  }

  var parts = raw.split(/\s+/), wearList = [], minHealth = 100;
  // DEVICE_LIFE_TIME_EST_TYP_A and _B as the card gives them: 1 to 10 for each
  // tenth of the estimated life used, 11 beyond it, 0 where not defined.
  var estimates = parts.map(function (p) {
    var v = parseInt(p, 16);
    return v >= 1 && v <= 11 ? v : null;
  });
  for (var i = 0; i < parts.length; i++) {
    var n = parseInt(parts[i], 16);
    if (!n) continue;
    if (n >= 11) {
      wearList.push('>100%');
      minHealth = 0;
    } else {
      wearList.push(((n - 1) * 10) + '-' + (n * 10) + '%');
      var rem = 100 - (n * 10);
      if (rem < minHealth) minHealth = rem;
    }
  }

  var uniqWear = [];
  for (var u = 0; u < wearList.length; u++) {
    if (uniqWear.indexOf(wearList[u]) === -1) uniqWear.push(wearList[u]);
  }
  var wearStr = uniqWear.length ? uniqWear.join(' / ') : '0-10%';
  var healthStr = (minHealth >= 90) ? '>90% (Healthy)' : (minHealth + '% remaining');
  EMMC_CACHE = {
    life: wearStr,
    wear: wearStr,
    health: healthStr,
    eol: eol,
    life_est_a: estimates.length > 0 ? estimates[0] : null,
    life_est_b: estimates.length > 1 ? estimates[1] : null
  };
  return EMMC_CACHE;
}

// In millidegrees, which the kernel's thermal zone reads in; LG's file has
// whole degrees.
function socTempMillidegrees() {
  if (!THERMAL_SOURCE) return null;
  var t = toInt(readTrimmed(THERMAL_SOURCE), null);
  if (t !== null && THERMAL_SOURCE !== SYS_THERMAL) t = t * 1000;
  return (t !== null && t > 0) ? t : null;
}

function socTemp() {
  var mt = socTempMillidegrees();
  var t = mt === null ? null : Math.round(mt / 1000);
  return t > 0 ? t : null;
}

/*
 * CPU use from /proc/stat: the busy share of each online core over the time
 * since the last reading, and of the whole processor. LG's /proc/lg/pm/status
 * load line is an instant reading against the cores and clock that are up: on
 * a C2 it read 34% beside 6% measured, and with cores parked in a long standby
 * the same small load reads several times higher. Offline cores drop out of
 * /proc/stat, so only cores in both samples are compared, and they count as
 * idle in the whole-processor figure, which is against every core present.
 * A window under CPU_WINDOW_MS returns the last result, so a dashboard polling
 * every second does not cut the window that Home Assistant's figure covers.
 */
var CPU_WINDOW_MS = 5000;
// One window per reader: the dashboards' share one, and Home Assistant's
// publish keeps its own, so a dashboard open in standby does not shrink the
// minute that each published figure stands for to its last few seconds.
var cpuWindows = {};
function readCoreTicks() {
  var now = {};
  var lines = (readTrimmed('/proc/stat') || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^cpu(\d+)\s+(.*)$/);
    if (!m) continue;
    var f = m[2].trim().split(/\s+/).map(Number), total = 0;
    for (var j = 0; j < f.length; j++) total += f[j] || 0;
    now[m[1]] = { total: total, idle: (f[3] || 0) + (f[4] || 0) };
  }
  return now;
}

/*
 * Time each online core has spent in each mode since boot, in USER_HZ ticks,
 * and the boot time in seconds since the epoch, both from /proc/stat. Offline
 * cores are absent from it. guest and guest_nice are left out: the kernel
 * counts them in user and nice already.
 */
var CPU_MODES = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
function cpuTimes() {
  var out = { cpus: {}, btime: null };
  var lines = (readTrimmed('/proc/stat') || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^cpu(\d+)\s+(.*)$/);
    if (m) {
      var f = m[2].trim().split(/\s+/), modes = {};
      for (var j = 0; j < CPU_MODES.length; j++) {
        var v = parseInt(f[j], 10);
        if (!isNaN(v)) modes[CPU_MODES[j]] = v;
      }
      out.cpus[m[1]] = modes;
      continue;
    }
    var b = lines[i].match(/^btime\s+(\d+)/);
    if (b) out.btime = parseInt(b[1], 10);
  }
  return out;
}

function statCpu(totalCores, at, reader, minMs) {
  var t = at || Date.now();
  var w = cpuWindows[reader || 'stats'] || (cpuWindows[reader || 'stats'] = { prev: null, last: { cores: {}, overall: null } });
  if (w.prev && t - w.prev.time < (minMs === undefined ? CPU_WINDOW_MS : minMs)) return w.last;
  var now = readCoreTicks();
  var prev = w.prev;
  w.prev = { time: t, ticks: now };
  if (!prev) return w.last;
  var cores = {}, busy = 0, elapsed = 0;
  Object.keys(now).forEach(function (c) {
    var p = prev.ticks[c];
    if (!p) return;
    var dt = now[c].total - p.total, di = now[c].idle - p.idle;
    // A core taken offline and back can restart its counters.
    if (dt <= 0 || di < 0 || di > dt) return;
    cores[c] = Math.max(0, Math.min(100, Math.round(100 * (dt - di) / dt)));
    busy += dt - di;
    if (dt > elapsed) elapsed = dt;
  });
  var n = Math.max(totalCores || 0, Object.keys(now).length);
  w.last = {
    cores: cores,
    overall: elapsed > 0 && n > 0 ? Math.max(0, Math.min(100, Math.round(100 * busy / (elapsed * n)))) : null
  };
  return w.last;
}

// Home Assistant's figure: the whole processor since its previous publish.
function cpuSincePublish(totalCores, at) {
  return statCpu(totalCores, at, 'publish', 0).overall;
}

// The cores this processor has, online or not, from a range list such as "0-3".
function cpuRange(raw) {
  if (!raw) return null;
  var idx = [], parts = raw.trim().split(',');
  for (var i = 0; i < parts.length; i++) {
    var range = parts[i].split('-');
    var lo = parseInt(range[0], 10);
    var hi = range.length > 1 ? parseInt(range[1], 10) : lo;
    if (isNaN(lo) || isNaN(hi)) continue;
    for (var c = lo; c <= hi; c++) idx.push(c);
  }
  return idx.length ? idx : null;
}

function onlineCpus(status) {
  var idx = cpuRange(readTrimmed('/sys/devices/system/cpu/online'));
  if (idx) return idx;
  var m = (status || '').match(/cpu_num:\s*(\d+)/);
  if (!m) return null;
  var n = parseInt(m[1], 10), out = [];
  for (var k = 0; k < n; k++) out.push(k);
  return out;
}

// /proc/lg/pm/frequency is in kHz; a value of 10000 or under is read as MHz.
function socHz() {
  var v = toInt(readTrimmed('/proc/lg/pm/frequency'), 0);
  if (!v || v < 0) return null;
  var hz = v > 10000 ? v * 1000 : v * 1000000;
  return (hz >= 100e6 && hz <= 10000e6) ? hz : null;
}

function socMhz() {
  var hz = socHz();
  return hz === null ? null : Math.round(hz / 1e6);
}

function swapBacking() {
  if (SWAP_BACKING_CACHE !== null) return SWAP_BACKING_CACHE;
  var raw = readTrimmed('/proc/swaps');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null, bestSize = -1;
  for (var i = 1; i < lines.length; i++) {
    var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
    if (f.length < 3 || !f[0]) continue;
    var size = parseInt(f[2], 10);
    if (isNaN(size) || size <= bestSize) continue;
    bestSize = size;
    best = /zram/i.test(f[0]) ? 'zram' : (f[1] === 'file' ? 'file' : 'flash');
  }
  SWAP_BACKING_CACHE = best;
  return best;
}

function wifi() {
  var raw = readTrimmed('/proc/net/wireless');
  if (!raw) return null;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('wlan0') !== -1) {
      var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
      var link = parseFloat(f[2]), level = parseFloat(f[3]);
      if (!link && !level) return null;
      if (level > 127) level = level - 256;
      return { link: link, level: level };
    }
  }
  return null;
}

function ifaceRank(name) {
  var st = readTrimmed('/sys/class/net/' + name + '/operstate');
  if (st) {
    st = st.trim();
    if (st === 'up') return 2;
    if (st === 'down') return 0;
    return 1;
  }
  var car = readTrimmed('/sys/class/net/' + name + '/carrier');
  if (!car) return 1;
  return car.trim() === '1' ? 2 : 0;
}

function macAddress(iface) {
  if (!iface) return null;
  if (MAC_CACHE[iface]) return MAC_CACHE[iface];
  var raw = readTrimmed('/sys/class/net/' + iface + '/address');
  if (!raw) return null;
  var mac = raw.trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  if (mac === '00:00:00:00:00:00') return null;
  MAC_CACHE[iface] = mac;
  return mac;
}

function netBytes() {
  var raw = readTrimmed('/proc/net/dev');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null;
  for (var i = 0; i < lines.length; i++) {
    var idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    var name = lines[i].slice(0, idx).replace(/\s+/g, '');
    if (!name || name === 'lo') continue;
    var f = lines[i].slice(idx + 1).replace(/\s+/g, ' ').trim().split(' ');
    var rx = parseInt(f[0], 10), tx = parseInt(f[8], 10);
    if (isNaN(rx) || isNaN(tx)) continue;
    var rank = ifaceRank(name);
    if (!best || rank > best.rank || (rank === best.rank && rx > best.rx)) {
      best = { iface: name, rank: rank, rx: rx, tx: tx, t: Date.now() };
    }
  }
  return best;
}

/*
 * Active sizes of the progressive CTA-861 video codes (VICs), by code. A C4's
 * receiver measured 1920x1081 and 3840x2161 for 1080p and 2160p over TMDS,
 * with the VIC saying 16 and 97; it measured an FRL link right.
 */
var VIC_SIZES = (function () {
  var sizes = {};
  function add(codes, w, h) { for (var i = 0; i < codes.length; i++) sizes[codes[i]] = [w, h]; }
  add([1], 640, 480);
  add([2, 3], 720, 480);
  add([17, 18], 720, 576);
  add([4, 19, 60, 61, 62], 1280, 720);
  add([16, 31, 32, 33, 34, 63, 64], 1920, 1080);
  add([93, 94, 95, 96, 97, 103, 104, 105, 106, 107, 117, 118, 119, 120], 3840, 2160);
  add([98, 99, 100, 101, 102, 218, 219], 4096, 2160);
  return sizes;
})();

/*
 * One receiver's timing from its status file: the key: value lines of the
 * HDMI 2.0 driver, or the newer driver's Sig: line, which gives each size as
 * active(total). Stable Sync Info is preferred over RAW, whose line count
 * jitters. The newer driver's Pixel Clk field is the clock in kHz on TMDS but
 * not on FRL, where a 1188 MHz 4K 120 Hz signal reads 40000; there the clock
 * is worked out from the totals. On TMDS the totals will not do: with deep
 * colour the total width counts characters, 2752 at 10 bits and 3300 at 12
 * for 1080p's 2200.
 */
function parseTiming(raw) {
  function field(re) { var m = raw.match(re); return m ? m[1].trim() : null; }
  var width = toInt(field(/horizontal-active:\s*(\d+)/), 0);
  var height = toInt(field(/vertical-active:\s*(\d+)/), 0);
  var refresh = toInt(field(/pixel-clock-V:\s*(\d+)/), 0);
  var clockKhz = toInt(field(/pixel-clock:\s*(\d+)/), 0);
  if (!width || !height) {
    var stablePart = raw.split(/\[Stable Sync Info\]/i)[1];
    var sig = (stablePart || raw).match(/Sig:\s*\[(\d+)\](?:\((\d+)\))?x\[(\d+)\](?:\((\d+)\))?@\[(\d+)\]\s*Hz/i);
    if (sig && toInt(sig[1], 0) > 0 && toInt(sig[3], 0) > 0) {
      width = toInt(sig[1], 0);
      height = toInt(sig[3], 0);
      refresh = toInt(sig[5], 0);
      var hTotal = toInt(sig[2], 0), vTotal = toInt(sig[4], 0);
      if (!clockKhz && /PHY Mode\[FRL/i.test(raw)) {
        if (hTotal && vTotal) clockKhz = hTotal * vTotal * refresh / 1000;
      } else if (!clockKhz) {
        clockKhz = toInt(((stablePart || raw).match(/Pixel Clk\[0*(\d+)\]/i) || [])[1], 0);
      }
      // The video code's size where the measured one is a line or two off it;
      // one further away is a mode the code does not describe.
      var vic = VIC_SIZES[toInt(((stablePart || raw).match(/VIC Code\[(\d+)\]/i) || [])[1], 0)];
      if (vic && Math.abs(vic[0] - width) <= 2 && Math.abs(vic[1] - height) <= 2) {
        width = vic[0];
        height = vic[1];
      }
    }
  }
  // The newer driver keeps a source's last timing in its stable section after
  // the source sleeps, with PHY Lock[0] and 5V still present, so where it
  // reports the lock, the lock alone says a source is sending.
  var lock = raw.match(/PHY\s+Lock\[(\d)\]/i);
  var hasTiming = width > 0 && height > 0 && (!lock || lock[1] === '1');
  return {
    connected: lock ? lock[1] === '1' : (/connected:\s*on/i.test(raw) || hasTiming),
    width: hasTiming ? width : null,
    height: hasTiming ? height : null,
    refreshHz: hasTiming && refresh ? refresh : null,
    pixelClockKhz: hasTiming && clockKhz ? clockKhz : null
  };
}

// The first connected port's timing, as numbers; width and height are null
// where a port is connected but the receiver gives no timing yet.
function readVideoTiming(targetPort) {
  var portsToScan = Array.isArray(targetPort)
    ? targetPort
    : (typeof targetPort === 'number' && targetPort >= 0 && targetPort < 4)
    ? [targetPort]
    : [0, 1, 2, 3];

  var anyConn = false;
  for (var i = 0; i < portsToScan.length; i++) {
    var raw = readTrimmed('/proc/lg/hdmi20/port' + portsToScan[i] + '/status');
    if (!raw) continue;
    var t = parseTiming(raw);
    if (!t.connected) continue;
    anyConn = true;
    if (t.width !== null) return { width: t.width, height: t.height, refresh_hz: t.refreshHz };
  }
  return anyConn ? { width: null, height: null, refresh_hz: null } : null;
}

function formatSignal(timing) {
  if (!timing) return null;
  if (timing.width === null) return 'Connected';
  return timing.width + 'x' + timing.height + (timing.refresh_hz === null ? '' : ' @ ' + timing.refresh_hz + 'Hz');
}

function getVideoSignal(targetPort) {
  return formatSignal(readVideoTiming(targetPort));
}

function readRemoteInfo() {
  var now = Date.now();
  if (cachedRemote && (now - lastRemoteCheck < 30000)) return cachedRemote;
  var raw = readTrimmed('/mnt/lg/cmn_data/mrcu/mrcu1.info');
  if (!raw) return cachedRemote || null;
  var bMatch = raw.match(/Battery\s*=\s*(\d+)/i);
  var nMatch = raw.match(/Name\s*=\s*([^\r\n]+)/i);
  var macMatch = raw.match(/BDAddr\s*=\s*([^\r\n]+)/i);
  var fwMatch = raw.match(/fwVer\s*=\s*([^\r\n]+)/i);
  if (!bMatch && !nMatch) return cachedRemote || null;
  cachedRemote = {
    battery: bMatch ? parseInt(bMatch[1], 10) : null,
    model: nMatch ? nMatch[1].trim() : null,
    mac: macMatch ? macMatch[1].trim() : null,
    firmware: fwMatch ? fwMatch[1].trim() : null,
    paired: true
  };
  lastRemoteCheck = Date.now();
  return cachedRemote;
}

function getActiveHdmiDiagnostics(targetPort) {
  var portsToScan = Array.isArray(targetPort)
    ? targetPort
    : (typeof targetPort === 'number' && targetPort >= 0 && targetPort < 4)
    ? [targetPort]
    : [0, 1, 2, 3];

  for (var i = 0; i < portsToScan.length; i++) {
    var diag = hdmiDiagnostics(readTrimmed('/proc/lg/hdmi20/port' + portsToScan[i] + '/status'), portsToScan[i]);
    if (diag) return diag;
  }
  return null;
}

/*
 * The HDMI 2.1 link lines of one receiver's status file, as the driver writes
 * them: phy_mode such as "FRL 12G 4L(R6)" or "6G", chroma such as "R444",
 * hdcp such as "HDCP23", and on TMDS the character clock in kHz. A receiver of
 * the HDMI 2.0 driver has none of them.
 */
function hdmiLinkFields(raw) {
  var stable = raw.split(/\[Stable Sync Info\]/i)[1] || raw;
  function field(text, re) { var m = text.match(re); return m ? m[1].trim() : null; }
  var qms = field(raw, /QMSMode\[(\d+)\]/i);
  var phyMode = field(raw, /PHY Mode\[([^\]]+)\]/i);
  return {
    phy_mode: phyMode,
    chroma: field(stable, /Video Format\[([^\]]+)\]/i),
    hdcp: field(raw, /Current HDCP Auth Version => (HDCP\w+)/i),
    // On FRL the field is no TMDS clock: 50000 on a 48 Gbps link.
    tmds_clock_khz: /^FRL/i.test(phyMode || '') ? null : toInt(field(stable, /TMDS Clk\[0*(\d+)\]/i), null),
    qms: qms === null ? null : qms === '1'
  };
}

// The on-screen input's diagnostics, as the dashboard and Home Assistant show them.
function hdmiDiagnostics(raw, port) {
  if (!raw) return null;
  var isConn = /connected:\s*on/i.test(raw) || /PHY\s+Lock\[1\]/i.test(raw) || /is5Vconnected\[1\]/i.test(raw);
  if (!isConn) return null;

  var link = hdmiLinkFields(raw);
  var allmMatch = raw.match(/isAllm\[(\d+)\]/i);
  var vrrMatch = raw.match(/isFreeSync\[(\d+)\]/i);
  var vrrMinMax = raw.match(/VRR Min\[(\d+)\]\/Max\[(\d+)\]/i);

  var phyMode = null;
  if (link.phy_mode) {
    var rawPhy = link.phy_mode;
    if (/FRL 12G 4L/i.test(rawPhy)) phyMode = 'FRL 48 Gbps';
    else if (/FRL 10G 4L/i.test(rawPhy)) phyMode = 'FRL 40 Gbps';
    else if (/FRL 8G 4L/i.test(rawPhy)) phyMode = 'FRL 32 Gbps';
    else if (/FRL 6G 4L/i.test(rawPhy)) phyMode = 'FRL 24 Gbps';
    else if (/FRL 6G 3L/i.test(rawPhy)) phyMode = 'FRL 18 Gbps';
    else if (/FRL 3G 3L/i.test(rawPhy)) phyMode = 'FRL 9 Gbps';
    else if (/3G/i.test(rawPhy)) phyMode = 'TMDS (3G)';
    else if (/6G/i.test(rawPhy)) phyMode = 'TMDS (6G)';
    else phyMode = rawPhy;
  }

  var format = null;
  if (link.chroma) {
    var rawFmt = link.chroma;
    if (rawFmt === 'R444') format = 'RGB 4:4:4';
    else if (rawFmt === 'Y444') format = 'YCbCr 4:4:4';
    else if (rawFmt === 'Y422') format = 'YCbCr 4:2:2';
    else if (rawFmt === 'Y420') format = 'YCbCr 4:2:0';
    else format = rawFmt;
  }

  var hdcp = null;
  if (link.hdcp) {
    var rawHdcp = link.hdcp;
    if (rawHdcp === 'HDCP23') hdcp = 'HDCP 2.3';
    else if (rawHdcp === 'HDCP22') hdcp = 'HDCP 2.2';
    else if (rawHdcp === 'HDCP14') hdcp = 'HDCP 1.4';
    else if (rawHdcp === 'HDCP0') hdcp = 'None';
    else hdcp = rawHdcp;
  }

  // isFreeSync is the VRR mode rather than a flag: 1 for FreeSync, 2 for
  // HDMI Forum VRR, which G-SYNC uses over HDMI (a PC at 4K120 on a C4,
  // webOS 24, #475). Any mode but 0 is VRR.
  var isVrr = (vrrMatch && vrrMatch[1] !== '0') ||
              (vrrMinMax && (parseInt(vrrMinMax[1], 10) > 0 || parseInt(vrrMinMax[2], 10) > 0));

  return {
    port: port,
    phy_mode: phyMode,
    chroma: format,
    hdcp: hdcp,
    allm: allmMatch ? (allmMatch[1] === '1') : null,
    vrr: (vrrMatch || vrrMinMax) ? !!isVrr : null,
    qms: link.qms
  };
}

// Every receiver's status file, read once for a collection, by receiver.
function readHdmiStatus() {
  var status = [];
  for (var p = 0; p < 4; p++) status.push(readTrimmed('/proc/lg/hdmi20/port' + p + '/status'));
  return status;
}

/*
 * The link on every HDMI input whose receiver has locked to a source, by the
 * input map: the cable and the handshake are there whichever input is on
 * screen. Without a map there is no telling which input a receiver is.
 */
function hdmiLinks(status, map) {
  if (!map) return null;
  var links = [];
  for (var n = 1; n <= 4; n++) {
    var raw = typeof map[n] === 'number' ? status[map[n]] : null;
    if (!raw || !/PHY\s+Lock\[1\]/i.test(raw)) continue;
    var link = hdmiLinkFields(raw);
    if (!link.phy_mode) continue;
    link.input = n;
    link.receiver = map[n];
    links.push(link);
  }
  return links;
}

/*
 * Whether a powered source is on each HDMI input's cable, by the input map:
 * is5Vconnected is the source's +5V on the cable, there with or without a
 * link, as from a streamer asleep. The HDMI 2.0 driver's files have no such
 * field, and their inputs are left out.
 */
function hdmiSources(status, map) {
  if (!map) return null;
  var sources = [];
  for (var n = 1; n <= 4; n++) {
    var raw = typeof map[n] === 'number' ? status[map[n]] : null;
    var fiveVolt = raw ? raw.match(/is5Vconnected\[(\d)\]/i) : null;
    if (!fiveVolt) continue;
    sources.push({ input: n, receiver: map[n], powered: fiveVolt[1] === '1' });
  }
  return sources;
}

/*
 * The receiver, /proc/lg/hdmi20/port<n>, behind each HDMI input, from the
 * input map LG's input service loads from configd. Boards wire them
 * differently: a C4 (o22n2) and a CX (o20) take the base table, HDMI 1 to 4
 * on receivers 3, 2, 1 and 0, and other boards override it. The TV chooses
 * among numbered tables by an index it does not expose; table 0 matched every
 * input on both TVs when swept. Asked once, as it cannot change, and
 * remembered once configd has answered at all. cb(map or null), where map[n] is
 * input n's receiver, or null for an input the board does not have.
 */
var HDMI_INPUT_MAP_KEY = 'inputMap.videoInputMapIndexInfo0';
var hdmiReceivers;
var hdmiReceiverWaiters = null;
function hdmiReceiverMap(cb) {
  if (hdmiReceivers !== undefined || !lunaFn) return cb(hdmiReceivers || null);
  if (hdmiReceiverWaiters) return hdmiReceiverWaiters.push(cb);
  hdmiReceiverWaiters = [cb];
  lunaFn('com.webos.service.config/getConfigs', { configNames: [HDMI_INPUT_MAP_KEY] }, function (r) {
    // A refusal is an answer too: asked again, it would cost a luna-send per collection.
    if (r) hdmiReceivers = r.returnValue !== false && r.configs ? parseInputMap(r.configs[HDMI_INPUT_MAP_KEY]) : null;
    var waiting = hdmiReceiverWaiters;
    hdmiReceiverWaiters = null;
    for (var i = 0; i < waiting.length; i++) waiting[i](hdmiReceivers || null);
  });
}

function parseInputMap(table) {
  var assignment = Array.isArray(table) && table[0] ? table[0].assignment : null;
  if (!assignment || typeof assignment !== 'object') return null;
  var map = {}, any = false;
  for (var n = 1; n <= 4; n++) {
    // "none" for an input the board does not have.
    var v = String(assignment['hdmi' + n]);
    map[n] = /^[0-3]$/.test(v) ? parseInt(v, 10) : null;
    if (map[n] !== null) any = true;
  }
  return any ? map : null;
}

/*
 * The signal on HDMI input hdmiNum, from its own receiver only: another
 * receiver's link belongs to another input. Without a map from the TV, input
 * n is looked for on receiver n - 1, then n, as a B8 has HDMI 2.
 */
function getHdmiSignal(hdmiNum, map, status) {
  if (typeof hdmiNum !== 'number' || hdmiNum < 1 || hdmiNum > 4) return null;
  var candidates = map ? [map[hdmiNum]] : [hdmiNum - 1, hdmiNum];
  for (var c = 0; c < candidates.length; c++) {
    var p = candidates[c];
    if (typeof p !== 'number' || p < 0 || p >= 4) continue;
    var raw = status ? status[p] : readTrimmed('/proc/lg/hdmi20/port' + p + '/status');
    if (!raw) continue;
    var t = parseTiming(raw);
    if (!t.connected) continue;
    return hdmiSignal({ width: t.width, height: t.height, refresh_hz: t.refreshHz }, hdmiDiagnostics(raw, p));
  }
  return null;
}

function hdmiSignal(timing, diag) {
  return { signal: formatSignal(timing), timing: timing.width === null ? null : timing, diag: diag };
}

function getPictureEngineInfo() {
  var raw = readTrimmed('/proc/lg/pe/hdr_status');
  if (!raw) return null;
  // Window [0] is the main picture window; fall back to the whole file if unindexed.
  var win0 = raw.match(/\[0\]\{([^}]+)\}/);
  var target = win0 ? win0[1] : raw;
  var colMatch = target.match(/colorimetry:\s*([^,\}]+)/i);
  var hdrMatch = target.match(/hdrStatus:\s*([^\(,\}\s]+)(?:\s*\(\s*([^\),\s]+)\s*\))?/i);

  var colorimetry = null;
  if (colMatch) {
    var rawCol = colMatch[1].trim().toLowerCase();
    if (rawCol === 'bt709') colorimetry = 'BT.709';
    else if (rawCol === 'bt2020') colorimetry = 'BT.2020';
    else if (rawCol === 'bt601') colorimetry = 'BT.601';
    else colorimetry = colMatch[1].trim();
  }

  var hdrMode = null;
  if (hdrMatch) {
    hdrMode = (hdrMatch[2] || hdrMatch[1]).trim().toLowerCase();
  }

  return {
    colorimetry: colorimetry,
    hdr_mode: hdrMode
  };
}


/*
 * How the volume can be changed with the sound going where it is now: 'level'
 * sets it; 'steps' takes only up and down, which the TV passes to a receiver
 * on HDMI ARC/eARC; 'none' not at all - over optical the TV refuses both with
 * "Current Scenario doesn't support volume change".
 *
 * The newer audio service says so outright: adjustVolume and
 * externalDeviceControl (C2, webOS 22, which still reports a level of 10 over
 * optical). volumeSyncable counts as settable too: an LG soundbar on eARC
 * whose level the TV shows and sets (SC9S on a C3, #406) is that case, and on
 * the C2 it is false over optical and over HDMI ARC with nothing answering.
 * The older one reports -1 for no level (B8, webOS 4.4; 58UH635V,
 * webOS 3.x), and its scenario is where the sound actually goes: a B8 set to
 * HDMI ARC with no receiver answering stays on ext_speaker_optical.
 */
function volumeControl(vs, sound) {
  if (vs && typeof vs.adjustVolume === 'boolean') {
    if (vs.adjustVolume || vs.volumeSyncable) return 'level';
    return vs.externalDeviceControl ? 'steps' : 'none';
  }
  if (sound && typeof sound.volume === 'number' && sound.volume < 0) {
    return /arc/.test(String(sound.scenario || '')) ? 'steps' : 'none';
  }
  return 'level';
}

/*
 * Whether a Bluetooth audio device is connected: choosing Bluetooth output
 * without one opens the TV's own pairing prompt and falls back to the
 * speakers. Paired is not enough - headphones switched off stay paired. A
 * Magic Remote is connected too, so the device class is read: major class 4
 * is audio/video (a headset is 0x240404, a remote 0x1f00). null until the
 * first answer.
 */
var btAudio = null;
function refreshBtAudio() {
  lunaCachedFn('com.webos.service.bluetooth2/device/getStatus', {}, 60000, function (r) {
    if (!r || r.returnValue === false || !Array.isArray(r.devices)) return;
    btAudio = r.devices.some(function (d) {
      return d && Array.isArray(d.connectedProfiles) && d.connectedProfiles.length > 0 &&
        ((Number(d.classOfDevice) >> 8) & 0x1f) === 4;
    });
  });
}

function formatSoundOutput(so) {
  if (!so) return 'TV Speaker';
  if (SOUND_OUTPUT_MAP[so]) return SOUND_OUTPUT_MAP[so];
  // A name not in the map is still shown readably: mobile_phone reads as
  // "Mobile Phone" rather than as the raw key.
  return String(so).replace(/_/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
}

function formatPicMode(mode) {
  if (!mode) return 'Standard';
  return ha.picModeName(mode);
}

/*
 * The picture setting's "dimension". LG's own picture settings code (webOS 9.2,
 * QuickSettings PictureModeInterfaces) knows sdr, hdr, dolbyHdr and
 * technicolorHdr, each of the three HDR kinds also with an ALLM suffix: the
 * source asked for Auto Low Latency Mode, the TV's game-style low-latency
 * picture. Anything else is shown readably rather than as one word in capitals.
 */
var DYNAMIC_RANGES = { sdr: 'SDR', hdr: 'HDR', dolbyHdr: 'Dolby Vision', technicolorHdr: 'Technicolor HDR' };

function formatDynamicRange(dr) {
  if (!dr) return 'SDR';
  var s = String(dr), low = /ALLM$/.test(s);
  if (low) s = s.slice(0, -4);
  var name = DYNAMIC_RANGES[s] ||
    s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^(sdr|hdr|hlg)/i, function (m) { return m.toUpperCase(); })
     .replace(/^./, function (c) { return c.toUpperCase(); });
  return low ? name + ' \u00b7 Low latency' : name;
}

function pictureModes(cb) {
  if (!lunaCachedFn) return cb([]);
  lunaCachedFn('com.webos.service.settings/getSystemSettingValues',
    { category: 'picture', key: 'pictureMode' }, 10000, function (res) {
      var arr = (res && res.values && res.values.arrayExt) || [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].visible === true && arr[i].active !== false) {
          out.push({ value: arr[i].value, label: formatPicMode(arr[i].value) });
        }
      }
      if (out.length) lastPicModes = out;
      cb(out);
    });
}

function refreshInputNames(cb) {
  if (Date.now() - lastInputScan < 60000 && Object.keys(inputNameMap).length > 0) {
    if (cb) cb(inputNameMap);
    return;
  }
  if (!lunaFn) {
    if (cb) cb(inputNameMap);
    return;
  }
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    if (res && res.devices && res.devices.length) {
      for (var i = 0; i < res.devices.length; i++) {
        var d = res.devices[i];
        if (d.appId && d.label) {
          var shortId = String(d.appId).replace('com.webos.app.', '');
          inputNameMap[shortId] = d.label;
        }
      }
      lastInputScan = Date.now();
    }
    if (cb) cb(inputNameMap);
  });
}

function parseAppList(raw) {
  var list = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var a = raw[i];
    if (a && a.id && a.title) appTitles[a.id] = a.title;
    if (a && a.id && a.visible !== false && a.id.indexOf('com.webos.app.container') !== 0) {
      if (!seen[a.id]) {
        seen[a.id] = true;
        list.push({
          id: a.id,
          title: a.title || a.id
        });
      }
    }
  }
  list.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });
  return list;
}

/*
 * A minute, not longer: an app removed from LG's own menu sends no event, and
 * the list is what Home Assistant's Launch App offers. At five minutes, an
 * uninstalled Spotify stayed on offer on a B8.
 */
var APPS_SCAN_MS = 60000;

function refreshInstalledApps(cb) {
  var now = Date.now();
  if (installedApps.length > 0 && now >= lastAppsScan && now - lastAppsScan < APPS_SCAN_MS) {
    if (cb) cb(installedApps);
    return;
  }
  if (!lunaFn) {
    if (cb) cb(installedApps);
    return;
  }
  lunaFn('com.webos.applicationManager/listApps', {}, function (res) {
    var raw = (res && (res.launchPoints || res.apps)) || null;
    if (Array.isArray(raw) && raw.length > 0) {
      installedApps = parseAppList(raw);
      lastAppsScan = Date.now();
      if (cb) cb(installedApps);
      return;
    }
    lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (lp) {
      var rawLp = (lp && (lp.launchPoints || lp.apps)) || null;
      if (Array.isArray(rawLp)) {
        installedApps = parseAppList(rawLp);
        lastAppsScan = Date.now();
      }
      if (cb) cb(installedApps);
    });
  });
}

// The GPU PLL's output in Hz.
function gpuClockHz() {
  var raw = readTrimmed('/proc/lg/sys/status');
  if (!raw) return null;
  var m = raw.match(/gpu pll out\s*:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function gpuClockMhz() {
  var hz = gpuClockHz();
  return hz === null ? null : Math.round(hz / 1000000);
}

function appStorage(cb) {
  var now = Date.now();
  if (cachedAppStorage && (now - lastAppStorageCheck < APP_STORAGE_TTL)) {
    return cb(cachedAppStorage);
  }
  execFile('/bin/df', ['-k', '/mnt/lg/appstore'], { timeout: 4000 }, function (err, stdout) {
    if (err) return cb(cachedAppStorage || null);
    var lines = String(stdout || '').trim().split('\n');
    var f = (lines[lines.length - 1] || '').split(/\s+/);
    if (f.length < 4) return cb(cachedAppStorage || null);
    var total = parseInt(f[1], 10), used = parseInt(f[2], 10), avail = parseInt(f[3], 10);
    if (!total) return cb(cachedAppStorage || null);
    cachedAppStorage = {
      totalMb: Math.round(total / 1024),
      usedMb: Math.round(used / 1024),
      freeMb: Math.round(avail / 1024),
      pct: Math.round(used / total * 100),
      // df -k's own figures, in KiB.
      totalKb: total,
      availKb: avail
    };
    lastAppStorageCheck = Date.now();
    cb(cachedAppStorage);
  });
}

function hdmiPorts() {
  var ports = [];
  for (var i = 0; i < 4; i++) {
    var raw = readTrimmed('/proc/lg/hdmi20/port' + i + '/status');
    if (!raw) continue;
    function field(re) { var m = raw.match(re); return m ? m[1].trim() : null; }
    var t = parseTiming(raw);
    var colorDepth = field(/deep-color-mode:\s*(\S+ \S+)/) || field(/DeepColorMode\[\s*([^\]]+)\]/);
    if (colorDepth) colorDepth = colorDepth.replace(/^[.\s]+/, '');
    var isInterlaced = /interlaced:\s*yes/i.test(raw) || /Interlaced\[1\]/i.test(raw);

    ports.push({
      port: i,
      connected: t.connected,
      resolution: t.width !== null ? (t.width + 'x' + t.height) : null,
      refreshHz: t.refreshHz,
      pixelClockMhz: t.pixelClockKhz !== null ? Math.round(t.pixelClockKhz / 100) / 10 : null,
      colorDepth: t.connected ? colorDepth : null,
      interlaced: t.connected ? isInterlaced : false
    });
  }
  return ports;
}

function hdmiInputs(cb) {
  if (!lunaFn) return cb({ ok: false, error: 'luna bus not available' });
  hdmiReceiverMap(function (receiverMap) {
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    // eim's activate marks the input last selected, and stays set while
    // another app is in front of it. Only the foreground app says whether the
    // input is on screen.
    lunaCachedFn('com.webos.applicationManager/getForegroundAppInfo', {}, 4000, function (fg) {
      var onScreen = (fg && fg.appId) || null;
      var devs = (res && res.devices) || [];
      var ports = hdmiPorts();
      var signalling = [];
      for (var p = 0; p < ports.length; p++) if (ports[p].connected) signalling.push(ports[p]);

      var inputs = [];
      var selectedIdx = -1;
      for (var d = 0; d < devs.length; d++) {
        if (!devs[d].id || String(devs[d].id).indexOf('HDMI') !== 0) continue;
        if (devs[d].activate) selectedIdx = inputs.length;
        var hasCec = devs[d].lastUniqueId !== undefined &&
                     devs[d].lastUniqueId !== 255 &&
                     devs[d].lastUniqueId !== -1;
        var seen = !!(hasCec || devs[d].hdmiPlugIn || devs[d].connected || (devs[d].subCount > 0));
        // HDMI_2 is com.webos.app.hdmi2, for firmware that leaves appId out.
        var appId = devs[d].appId || 'com.webos.app.' + String(devs[d].id).toLowerCase().replace('_', '');
        inputs.push({
          id: devs[d].id,
          port: devs[d].port,
          label: devs[d].label || devs[d].id,
          appId: appId,
          active: !!devs[d].activate && appId === onScreen,
          deviceSeen: seen,
          signal: null
        });
      }
      if (receiverMap) {
        for (var k = 0; k < inputs.length; k++) {
          var receiver = receiverMap[parseInt(String(inputs[k].id).replace('HDMI_', ''), 10)];
          for (var r = 0; r < signalling.length; r++) {
            if (signalling[r].port === receiver) inputs[k].signal = signalling[r];
          }
        }
        return cb({ ok: true, inputs: inputs, ports: ports, pairedUnambiguously: true });
      }
      // The selected input keeps its signal behind another app, so the pairing
      // does not depend on it being on screen.
      if (selectedIdx !== -1 && signalling.length === 1) {
        inputs[selectedIdx].signal = signalling[0];
      }
      cb({ ok: true, inputs: inputs, ports: ports, pairedUnambiguously: (selectedIdx !== -1 && signalling.length === 1) });
    });
  });
  });
}

function procName(comm, args) {
  var bin = String(args).split(/\s+/)[0].replace(/^.*\//, '');

  if (bin === 'WebAppMgr') {
    var app = args.match(/\/usr\/palm\/applications\/([^\/\s]+)/);
    if (app) return 'WebAppMgr (' + app[1].replace(/^com\.webos\.app\./, '') + ')';
    var type = args.match(/--type=(\w+)/);
    return 'WebAppMgr (' + (type ? type[1] : 'browser') + ')';
  }

  return (comm && comm.length < 15) ? comm : (bin || comm);
}

function sampleCpuTicks() {
  var out = { total: 0, procs: {} };
  try {
    var cpu = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
    for (var i = 1; i < cpu.length; i++) out.total += parseInt(cpu[i], 10) || 0;
  } catch (e) {
    return null;
  }
  var names;
  try { names = fs.readdirSync('/proc'); } catch (e2) { return null; }
  for (var n = 0; n < names.length; n++) {
    if (!/^\d+$/.test(names[n])) continue;
    try {
      var raw = fs.readFileSync('/proc/' + names[n] + '/stat', 'utf8');
      var close = raw.lastIndexOf(')');
      if (close < 0) continue;
      var f = raw.slice(close + 2).split(' ');
      out.procs[names[n]] = {
        ticks: (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0),
        comm: raw.slice(raw.indexOf('(') + 1, close)
      };
    } catch (e3) {}
  }
  return out;
}

function procCmdline(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')
             .replace(/\0+$/, '').replace(/\0/g, ' ');
  } catch (e) {
    return '';
  }
}

function collectCpuProcesses(cb, retried) {
  var first = sampleCpuTicks();
  if (!first) return cb({ ok: false, error: 'could not read /proc' });

  setTimeout(function () {
    var second = sampleCpuTicks();
    if (!second) return cb({ ok: false, error: 'could not read /proc' });

    var elapsed = second.total - first.total;
    if (elapsed <= 0) {
      if (retried) return cb({ ok: false, error: msg('srv.cpu.stuck', 'the CPU counters did not move') });
      return collectCpuProcesses(cb, true);
    }

    var rows = [], busy = 0;
    for (var pid in second.procs) {
      if (!second.procs.hasOwnProperty(pid)) continue;
      var was = first.procs[pid];
      if (!was) continue;
      var delta = second.procs[pid].ticks - was.ticks;
      if (delta <= 0) continue;
      var pct = delta / elapsed * 100;
      busy += pct;
      rows.push({ name: procName(second.procs[pid].comm, procCmdline(pid)), pct: Math.round(pct * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.pct - a.pct; });
    cb({
      ok: true,
      windowMs: CPU_WINDOW_MS,
      busy: Math.round(busy * 10) / 10,
      active: rows.length,
      top: rows.slice(0, 10)
    });
  }, CPU_WINDOW_MS);
}

function collectProcesses(cb) {
  execFile('/bin/ps', ['-eo', 'rss,comm,args'], { timeout: 4000, maxBuffer: 1024 * 1024 }, function (err, stdout) {
    if (err) return cb({ ok: false, error: msg('srv.processes.failed', 'could not read process list') });
    var lines = String(stdout || '').split('\n'), rows = [], total = 0, count = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/);
      if (!m) continue;
      var rss = parseInt(m[1], 10);
      count++;
      total += rss;
      rows.push({ name: procName(m[2], m[3]), mb: Math.round(rss / 1024 * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.mb - a.mb; });
    cb({
      ok: true,
      count: count,
      totalMb: Math.round(total / 1024),
      top: rows.slice(0, 10)
    });
  });
}

function socArchName(raw) {
  if (!raw) return null;
  var key = String(raw).replace(/^_+|_+$/g, '').toUpperCase();
  if (!key) return null;
  return SOC_ARCH[key] || key;
}

function detectWebosVersion(sdkVersion) {
  var raw = readTrimmed('/etc/issue') || readTrimmed('/etc/issue.net') || '';
  var m = raw.match(/webOS(?:\s+TV)?\s+([\d\.]+)/i);
  if (m) return m[1];
  var sf = readTrimmed('/etc/starfish-release') || '';
  var sm = sf.match(/release\s+([\d\.]+)/i);
  if (sm) return sm[1];
  if (sdkVersion) return String(sdkVersion);
  return null;
}

function detectHardwareInfo(sdkVersion, cb) {
  HARDWARE_INFO.webos = detectWebosVersion(sdkVersion);
  var envRaw = readTrimmed('/var/luna/preferences/environmentCondition');
  if (envRaw) {
    try {
      var env = JSON.parse(envRaw);
      var bStr = env.boardTypeStr || env.socChip || readTrimmed('/proc/lg/base/chip_name') || '';
      if (bStr) {
        bStr = bStr.trim();
        HARDWARE_INFO.socArch = socArchName(bStr);
      }
      if (env.ddrSize) HARDWARE_INFO.ram = env.ddrSize;
      if (env.panelOutputFrameRate) HARDWARE_INFO.refreshRate = env.panelOutputFrameRate + ' Hz';
      if (env.digitalEyeMode) HARDWARE_INFO.eyeSensor = env.digitalEyeMode;
      else if (env.isDigitalEye === 'true') HARDWARE_INFO.eyeSensor = 'Digital Eye';
    } catch (e) {}
  }
  if (!HARDWARE_INFO.socArch) {
    var chip = readTrimmed('/proc/lg/base/chip_name');
    if (chip) HARDWARE_INFO.socArch = socArchName(chip.trim());
  }

  if (!lunaFn) {
    if (cb) cb();
    return;
  }

  lunaFn('com.webos.service.panelcontroller/getOledCellInfo', {}, function (cellRes) {
    if (cellRes && cellRes.cellInfo) HARDWARE_INFO.cell = cellRes.cellInfo;
    lunaFn('com.webos.service.panelcontroller/getOledTconInfo', {}, function (tconRes) {
      if (tconRes && tconRes.tconParamForInstart) {
        HARDWARE_INFO.tconFirmware = tconRes.tconParamForInstart.tconFpgaFirmwareVer || null;
        HARDWARE_INFO.tconModule = tconRes.tconParamForInstart.tconModuleInfo || null;
      }
      if (cb) cb();
    });
  });
}

// Tries left, and the wait between them, when the model name does not come
// back at start: a lost answer otherwise leaves "webOS TV" until a restart.
var DEVICE_INFO_TRIES = 3;
var DEVICE_INFO_RETRY_MS = 3000;

function detectDeviceInfo(cb, triesLeft) {
  if (!lunaFn) {
    if (cb) cb();
    return;
  }
  if (triesLeft === undefined) triesLeft = DEVICE_INFO_TRIES - 1;
  lunaFn('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['modelName', 'firmwareVersion', 'boardType', 'sdkVersion'] },
    function (res) {
      if (!(res && res.modelName) && triesLeft > 0) {
        console.error('device: model name not read, trying again');
        return setTimeout(function () { detectDeviceInfo(cb, triesLeft - 1); }, DEVICE_INFO_RETRY_MS);
      }
      if (!(res && res.modelName)) console.error('device: model name could not be read');
      if (configObj && configObj.device) {
        if (res && res.modelName) {
          if (!configObj.device.model || configObj.device.model === 'OLED65B8SLC' || configObj.device.model === 'webOS TV') {
            configObj.device.model = res.modelName;
          }
          if (!configObj.device.name || configObj.device.name === 'LG webOS TV' || configObj.device.name === 'LG OLED B8 TV') {
            configObj.device.name = 'LG ' + res.modelName;
          }
          if (res.firmwareVersion) {
            configObj.device.sw_version = res.firmwareVersion;
          }
          console.log('device detected: ' + (configObj.device.name || 'LG TV') + ' (model: ' + configObj.device.model + ') fw: ' + (res.firmwareVersion || '?'));
        }
        if (!configObj.device.name) configObj.device.name = 'LG webOS TV';
        if (!configObj.device.model) configObj.device.model = 'webOS TV';
      }
      detectHardwareInfo((res && res.sdkVersion) || null, function () {
        if (cb) cb();
      });
    }
  );
}

var frontLightsWaiters = null;

function detectFrontLights(cb) {
  if (hasLogoLight !== null) {
    if (cb) cb(hasLogoLight);
    return;
  }
  if (!lunaFn) {
    if (cb) cb(false);
    return;
  }
  if (frontLightsWaiters) {
    if (cb) frontLightsWaiters.push(cb);
    return;
  }
  frontLightsWaiters = cb ? [cb] : [];
  lunaFn('com.webos.service.tv.systemproperty/getSystemProperties',
       { keys: ['tv.model.logoLight'] }, function (res) {
    var v = res && res['tv.model.logoLight'];
    hasLogoLight = (v === true);
    var waiters = frontLightsWaiters;
    frontLightsWaiters = null;
    if (waiters) {
      for (var i = 0; i < waiters.length; i++) {
        try {
          waiters[i](hasLogoLight);
        } catch (e) {}
      }
    }
  });
}

// LG stores the hour and minute as separate strings, "1" and "0" for 01:00.
function clockTime(h, m) {
  function pad2(v) { v = parseInt(v, 10) || 0; return (v < 10 ? '0' : '') + v; }
  return pad2(h) + ':' + pad2(m);
}

function pushTemp(t) {
  if (typeof t !== 'number' || isNaN(t) || t <= 0) return;
  tempHistory.push(t);
  if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
}

function bootTime(uptimeSec) {
  var computed = Date.now() - uptimeSec * 1000;
  if (Math.abs(computed - bootEpoch) > 30000) bootEpoch = computed;
  return new Date(bootEpoch).toISOString();
}

function clearCache() {
  lastStats = null;
  lastAppsScan = 0;
  lastLightSensorProbe = 0;
}

/*
 * For a live event, which makes the next stats read fresh but leaves what
 * clearCache resets: a volume step or a source change installs no app, and
 * the light sensor's backoff has nothing to do with either.
 */
function expireStats() {
  lastStats = null;
}

function collectStats(cb) {
  var now = Date.now();
  if (lastStats && now >= lastStatsTime && now - lastStatsTime < 1500) {
    return cb(lastStats);
  }

  statsWaiters.push(cb);
  refreshBtAudio();
  if (isCollecting) return;
  isCollecting = true;

  var safetyTimeout = setTimeout(function () {
    if (isCollecting) {
      console.log('warning: stats collection safety timeout reached');
      flushStats(lastStats || { ok: false, error: 'timeout' });
    }
  }, 4500);

  function flushStats(result) {
    clearTimeout(safetyTimeout);
    lastStats = result;
    lastStatsTime = Date.now();
    isCollecting = false;
    var waiters = statsWaiters.slice(0);
    statsWaiters = [];
    for (var w = 0; w < waiters.length; w++) {
      try { waiters[w](result); } catch (e) {}
    }
  }

  var mi = meminfo();
  var status = readTrimmed('/proc/lg/pm/status') || '';
  var coreMatch = status.match(/load:\s*([\d\s]+)/);
  var coreSlots = coreMatch ? coreMatch[1].trim().split(/\s+/).map(Number) : [];
  var liveCpus = onlineCpus(status);
  var present = cpuRange(readTrimmed('/sys/devices/system/cpu/present'));
  var coresTotal = present ? present.length : coreSlots.length;
  var cpu = statCpu(coresTotal);
  var coreLoads = [];
  var measured = Object.keys(cpu.cores).sort(function (a, b) { return Number(a) - Number(b); });
  if (measured.length) {
    coreLoads = measured.map(function (c) { return cpu.cores[c]; });
    if (!coresTotal) coresTotal = measured.length;
  } else if (!coreSlots.length) {
    coreLoads = [];
  } else if (liveCpus) {
    for (var ci = 0; ci < liveCpus.length; ci++) {
      if (liveCpus[ci] < coreSlots.length) coreLoads.push(coreSlots[liveCpus[ci]]);
    }
  } else {
    coreLoads = coreSlots;
  }

  var n = netBytes();
  var rate = null;
  if (n && prevNet && n.iface === prevNet.iface && n.t > prevNet.t && n.rx >= prevNet.rx) {
    var dt = (n.t - prevNet.t) / 1000;
    rate = { rx: Math.round((n.rx - prevNet.rx) / dt), tx: Math.round((n.tx - prevNet.tx) / dt) };
  }
  if (n) prevNet = n;

  var peInfo = getPictureEngineInfo();
  var times = cpuTimes();
  var uptimeSec = Math.floor(parseFloat(readTrimmed('/proc/uptime') || '0'));

  var devCfg = (configObj && configObj.device) || {};
  var out = {
    ok: true,
    time: Date.now(),
    tvwebVersion: tvwebVersionStr,
    device: {
      id: devCfg.id || 'lg_tv',
      name: devCfg.name || 'LG webOS TV',
      model: devCfg.model || 'webOS TV'
    },
    system: {
      webos: HARDWARE_INFO.webos,
      firmware: devCfg.sw_version || null
    },
    hardware: {
      webos: HARDWARE_INFO.webos,
      soc_arch: HARDWARE_INFO.socArch,
      ram: HARDWARE_INFO.ram,
      refresh_rate: HARDWARE_INFO.refreshRate,
      eye_sensor: HARDWARE_INFO.eyeSensor
    },
    panel_silicon: HARDWARE_INFO.cell ? {
      cell: HARDWARE_INFO.cell,
      tcon_firmware: HARDWARE_INFO.tconFirmware,
      tcon_module: HARDWARE_INFO.tconModule
    } : null,
    remote: readRemoteInfo(),
    temp: socTemp(),
    tempMillidegrees: socTempMillidegrees(),
    temps: null,
    load: cpu.overall !== null ? cpu.overall
      : coreLoads.length
      ? Math.round(coreLoads.reduce(function (a, b) { return a + b; }, 0) / coreLoads.length)
      : toInt(readTrimmed('/proc/lg/pm/current_load'), null),
    loadPeak: coreLoads.length
      ? Math.max.apply(null, coreLoads)
      : toInt(readTrimmed('/proc/lg/pm/current_load'), null),
    mhz: socMhz(),
    cpuHz: socHz(),
    cpuTimes: times.cpus,
    cores: coreLoads,
    coresTotal: coresTotal || coreSlots.length,
    mem: { total: mi.MemTotal || 0, avail: mi.MemAvailable || 0 },
    swap: { total: mi.SwapTotal || 0, free: mi.SwapFree || 0, backing: swapBacking() },
    uptime: uptimeSec,
    bootTime: bootTime(uptimeSec),
    btime: times.btime,
    loadavg: (readTrimmed('/proc/loadavg') || '').split(' ').slice(0, 3),
    wifi: wifi(),
    net: rate,
    netTotal: n ? { rx: n.rx, tx: n.tx, iface: n.iface } : null,
    mac: n ? macAddress(n.iface) : null,
    emmc: emmcInfo(),
    signal: null,
    signal_timing: null,
    hdmi_diag: null,
    source_frame_rate: null,
    hdmi_links: null,
    hdmi_sources: null,
    picture_engine: peInfo,
    colorimetry: peInfo ? peInfo.colorimetry : null,
    inputs: inputNameMap
  };

  pushTemp(out.temp);
  out.temps = tempHistory.slice();

  refreshInputNames();

  if (!lunaFn || !lunaCachedFn) {
    return flushStats(out);
  }

  /*
   * In LG's Always Ready display the TV is switched off to the user, but
   * power/getPowerState still reads "Active"; only power2 has a sub state for
   * it. Asked only while Always Ready is on, so TVs without it make no extra
   * call.
   */
  function alwaysReadyShowing(next) {
    if (!alwaysReadyScreenOn) return next(false);
    lunaFn('com.webos.service.tvpower/power2/getPowerState', {}, function (p2) {
      next(!!(p2 && p2['sub state'] === 'always on display'));
    });
  }

  hdmiReceiverMap(function (receiverMap) {
    var hdmiStatus = readHdmiStatus();
    out.hdmi_links = hdmiLinks(hdmiStatus, receiverMap);
    out.hdmi_sources = hdmiSources(hdmiStatus, receiverMap);
  alwaysReadyShowing(function (showing) {
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var rawPower = pw ? (pw.state || pw.processing) : null;
    if (showing && rawPower === 'Active') rawPower = 'Always Ready';
    /*
     * No answer is not "off". Mapped, a failed read reported the TV switched
     * off, which Home Assistant showed and which swapped the MQTT will; left
     * out, the live state keeps what it last knew.
     */
    out.powerState = mapPowerStateFn && rawPower ? mapPowerStateFn(rawPower) : null;
    out.screenSaver = isScreenSaverFn ? isScreenSaverFn(out.powerState) : false;
    out.screensaverMode = screensaversModule ? screensaversModule.screensaverMode() : 'stock';
    out.screensaverLevel = screensaversModule ? screensaversModule.screensaverLevel() : 'dim';

  // The whole category, for the sleep timer and LG's On and Off Timers.
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'time' }, 30000, function (tm) {
    out.sleepTimer = (tm && tm.settings && tm.settings.sleepTimer) || 'off';
    out.powerTimers = timers.fromSettings(tm && tm.returnValue !== false ? tm.settings : null);
    if (tm && tm.returnValue !== false) powerTimersSeen = out.powerTimers || {};

  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'option', keys: ['standByLight', 'logoLight', 'powerOnLight', 'quickStartMode'] }, 60000, function (op) {
    var os = (op && op.settings) || {};
    out.lights = {
      standby: os.standByLight === 'on',
      logo: os.logoLight === 'on',
      powerOn: os.powerOnLight === 'on',
      hasLogo: hasLogoLight === true
    };
    if (os.quickStartMode !== undefined) {
      out.quickBoot = os.quickStartMode === 'on';
    }
    out.gpuMhz = gpuClockMhz();
    out.gpuHz = gpuClockHz();

  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'network', keys: ['wolwowlOnOff'] }, 60000, function (nw) {
    var wol = nw && nw.settings && nw.settings.wolwowlOnOff;
    if (wol !== undefined) out.wakeOnLan = wol === true || wol === 'true';

  // A C2 on webOS 9.2 has this key and a B8 on 4.4 does not, so the switch is
  // offered only where the TV reports one.
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'other', keys: ['lgLogoDisplay'] }, 60000, function (ot) {
    var logo = ot && ot.settings && ot.settings.lgLogoDisplay;
    if (logo !== undefined) out.lgLogo = logo === 'on' || logo === true;

  /*
   * LG's device detection (UEI QuickSet), which finds a set-top box and smart
   * lights, plugs and switches for the Home Dashboard. On a C2 (webOS 9.2) its
   * iconnectivity service reverse-looks-up every address on the local network,
   * three times over, each time the TV switches on: 759 lookups in two
   * minutes, and none with this off. Asked on its own so a TV without it does
   * not lose the rest.
   */
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'other', keys: ['ueiEnable'] }, 60000, function (ue) {
    var uei = ue && ue.returnValue !== false && ue.settings && ue.settings.ueiEnable;
    if (uei !== undefined && uei !== null && uei !== false) out.deviceDetection = uei === 'on' || uei === true;

  // LG's Always-on: holds the TV in Active Standby when switched off, so
  // this server stays reachable. A C2 on webOS 9.2 has it; a B8 on 4.4 does not.
  // It is suspended for five hours a night, when a switched-off TV sleeps fully.
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'general', keys: ['alwaysOn', 'alwaysOnDisableStartHour', 'alwaysOnDisableStartMinute',
                                     'alwaysOnDisableEndHour', 'alwaysOnDisableEndMinute'] }, 60000, function (gn) {
    var gs = (gn && gn.settings) || {};
    // Only where the TV has the feature: a B8 keeps an alwaysOn value of "on"
    // without it, and setup offered to keep it connected when off.
    var ar = alwaysOnSupport === true ? gs.alwaysOn : undefined;
    if (ar !== undefined) out.alwaysReady = ar === 'on' || ar === true;
    if (ar !== undefined && gs.alwaysOnDisableStartHour !== undefined && gs.alwaysOnDisableEndHour !== undefined) {
      out.alwaysReadyOff = {
        start: clockTime(gs.alwaysOnDisableStartHour, gs.alwaysOnDisableStartMinute),
        end: clockTime(gs.alwaysOnDisableEndHour, gs.alwaysOnDisableEndMinute)
      };
    }

  // LG's Always Ready, a separate setting from Always-on: 'off', 'allEnabled'
  // (wallpaper) or 'alwaysReady' (dark). Asked on its own so a TV without it
  // keeps the Always-on readings above.
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'general', keys: ['lifeOnScreenMode'] }, 60000, function (lo) {
    var los = lo && lo.returnValue !== false && lo.settings && lo.settings.lifeOnScreenMode;
    if (los) out.alwaysReadyScreen = alwaysReadyScreenOn = los !== 'off';

  lunaCachedFn('com.palm.connectionmanager/getStatus', {}, 60000, function (cm) {
    var w = cm && cm.wifi;
    out.ssid = (w && w.ssid) ? w.ssid : null;

  function probeLightSensor(next) {
    if (!hasLightSensor && lightSensorFailures >= 3 && (Date.now() - lastLightSensorProbe < 600000)) {
      out.lightSensor = null;
      out.backlight = null;
      return next();
    }
    lastLightSensorProbe = Date.now();
    lunaCachedFn('com.webos.service.tv.display/getLightSensorData', {}, 30000, function (ls) {
      if (!ls || ls.returnValue === false) {
        lightSensorFailures++;
      } else {
        lightSensorFailures = 0;
      }
      var lux = null, sd = (ls && ls.sensorData) || [];
      for (var li = 0; li < sd.length; li++) {
        if (sd[li].property === 'visibleLuminance' || sd[li].property === 'luminance') {
          if (sd[li].value !== 65535 && sd[li].value !== null) lux = sd[li].value;
        }
      }
      out.lightSensor = (lux === null) ? null : { lux: lux };
      if (out.lightSensor) hasLightSensor = true;
      out.backlight = (ls && typeof ls.backlightValue === 'number') ? ls.backlightValue : null;
      next();
    });
  }

  lunaCachedFn('com.webos.service.tv.display/getDimmingStatus', {}, 15000, function (dim) {
    out.dimming = (dim && dim.status) || null;

  probeLightSensor(function () {

  appStorage(function (st) {
    out.appStorage = st;

  lunaCachedFn('com.webos.audio/getSoundOut', {}, 10000, function (sound) {
    if (sound) {
      out.volume = sound.volume;
      out.muted = !!sound.muted;
      out.audio_output = sound.scenario ?
        formatSoundOutput(String(sound.scenario).replace(/^mastervolume_/, '')) : 'Internal';
    }
  masterVolume(function (vs) {
    // With an eARC soundbar controlling the volume, getSoundOut reports 0 and
    // the newer service has the soundbar's level (#406).
    if (vs) {
      if (typeof vs.volume === 'number') out.volume = vs.volume;
      if (typeof vs.muteStatus === 'boolean') out.muted = vs.muteStatus;
    }
    out.volume_control = volumeControl(vs, sound);
    if (out.volume_control !== 'level') out.volume = null;
    lunaCachedFn('com.webos.service.settings/getSystemSettings',
      { category: 'sound', keys: ['soundOutput', 'soundMode'] }, 15000,
      function (snd) {
        var rawSnd = (snd && snd.settings && snd.settings.soundOutput) ? snd.settings.soundOutput : (sound && sound.scenario ? sound.scenario : 'tv_speaker');
        out.sound = {
          output: formatSoundOutput(rawSnd),
          output_raw: rawSnd,
          bt_audio: btAudio,
          mode: (snd && snd.settings && snd.settings.soundMode) || 'standard'
        };

        lunaCachedFn('com.webos.service.acb/getForegroundAppInfo', {}, 4000, function (acb) {
        var pipe = (acb && Array.isArray(acb.acbs)) ? acb.acbs[0] : null;
        if (pipe && pipe.playStateNow) {
          out.media = {
            state: String(pipe.playStateNow),
            playerType: pipe.playerType || null,
            fullScreen: pipe.isFullScreen !== false
          };
          noteMediaSeen();
        } else if (acb && acb.returnValue !== false && Array.isArray(acb.acbs) && hasMediaState) {
          // The media service answered with nothing playing (a screen saver,
          // the home screen): idle, where no answer at all stays unknown.
          out.media = { state: 'idle', playerType: null, fullScreen: false };
        }

        lunaCachedFn('com.webos.applicationManager/getForegroundAppInfo', {}, 4000, function (app) {
          var inputShown = false;
          if (app && app.appId) {
            var shortApp = String(app.appId).replace('com.webos.app.', '');
            out.app = shortApp;
            out.app_id = app.appId;
            // Inputs by the names given them in the TV's settings, apps by
            // their titles; the id only when neither is known.
            var isInput = inputNameMap[shortApp] && inputNameMap[shortApp] !== shortApp;
            out.app_name = inputNameMap[shortApp] || appTitles[app.appId] || shortApp;
            out.display_title = isInput ?
              (inputNameMap[shortApp] + ' (' + shortApp.toUpperCase() + ')') : out.app_name;

            var hdmiMatch = String(app.appId).match(/^com\.webos\.app\.hdmi([1-4])$/i);
            var isScreenOff = out.screenSaver || (out.powerState && (out.powerState.screenOn === false || String(out.powerState.raw || out.powerState.state || '').toLowerCase() === 'off'));
            if (hdmiMatch && !isScreenOff) {
              inputShown = true;
              var sigObj = getHdmiSignal(parseInt(hdmiMatch[1], 10), receiverMap, hdmiStatus);
              out.signal = sigObj ? sigObj.signal : null;
              out.signal_timing = sigObj ? sigObj.timing : null;
              out.hdmi_diag = sigObj ? sigObj.diag : null;
              if (out.hdmi_diag) noteHdmiSeen(out.hdmi_diag);
            } else {
              out.signal = null;
              out.signal_timing = null;
              out.hdmi_diag = null;
            }
          } else if (app && app.appId === '') {
            out.signal = null;
            out.signal_timing = null;
            out.hdmi_diag = null;
          }
          if (out.screenSaver || (out.powerState && (out.powerState.screenOn === false || String(out.powerState.raw || out.powerState.state || '').toLowerCase() === 'off'))) {
            out.signal = null;
            out.signal_timing = null;
            out.hdmi_diag = null;
          }

          sourceFrameRate(app, inputShown, function (fr) {
          out.source_frame_rate = fr;
          lunaCachedFn('com.webos.service.settings/getSystemSettings',
            { category: 'picture', keys: ['backlight', 'pictureMode', 'energySaving', 'screenShift', 'logoLuminanceAdjust'] },
            10000, function (pic) {
              if (pic && pic.settings) {
                var rawDr = (pic.dimension && pic.dimension.dynamicRange) ? pic.dimension.dynamicRange : null;
                out.picture = {
                  dynamicRange: formatDynamicRange(rawDr),
                  // As the TV gave it, null where it gave none, which the
                  // display string above shows as SDR.
                  dynamicRange_raw: rawDr,
                  mode: formatPicMode(pic.settings.pictureMode),
                  mode_raw: pic.settings.pictureMode || 'standard',
                  backlight: toInt(pic.settings.backlight, 50),
                  // As read, null where the TV gave none rather than the 50
                  // the dashboards show.
                  backlight_raw: toInt(pic.settings.backlight, null),
                  energySaving: pic.settings.energySaving || 'off',
                  screenShift: pic.settings.screenShift || 'off',
                  logoLuminanceAdjust: pic.settings.logoLuminanceAdjust || 'off',
                  modes: []
                };
              }
              pictureModes(function (modes) {
                if (out.picture) out.picture.modes = modes;
                refreshInstalledApps(function (apps) {
                  out.apps = apps || [];
                  out.privacy = {
                    adblock: {
                      enabled: privacyModule ? privacyModule.isAdBlockActive() : false,
                      count: (privacyModule && privacyModule.adBlockList) ? privacyModule.adBlockList('full').length : 0
                    }
                  };
                  if (!oledModule) {
                    out.capabilities = {
                      oled: false,
                      thermal: THERMAL_PRESENT,
                      emmcWear: EMMC_WEAR_PRESENT
                    };
                    out.oled = null;
                    return flushStats(out);
                  }
                  oledModule.detectOled(function (oledPanel) {
                    out.capabilities = {
                      oled: oledPanel,
                      thermal: THERMAL_PRESENT,
                      emmcWear: EMMC_WEAR_PRESENT
                    };
                    if (!oledPanel) {
                      out.oled = null;
                      return flushStats(out);
                    }
                    oledModule.refreshOledStats((pic && pic.settings) ? pic.settings : null, out.powerState, function (oledData) {
                      out.oled = oledData;
                      flushStats(out);
                    });
                  });
                });
              });
            }
          );
          });
        });
        });
      }
    );
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
  });
  });
  });
  });
  });
}

/*
 * The frame rate of the HDMI source on screen, from game.js. Off an input, or
 * with the screen off, its bind is dropped; a failed foreground read leaves it.
 */
function sourceFrameRate(app, inputShown, cb) {
  if (!gameModule || !app || typeof app.appId !== 'string') return cb(null);
  gameModule.read(inputShown ? app.appId : '', function (r) {
    cb(r ? { hz: r.frameRate, vrr_type: r.vrrType, port: r.port } : null);
  });
}

/*
 * The newer audio service's volumeStatus, cached like the other reads. A TV
 * without it (a B8, webOS 4, says "Unknown method") is not asked again: each
 * question starts a luna-send.
 */
var masterVolumeSupported = null;
function masterVolume(cb) {
  if (masterVolumeSupported === false) return cb(null);
  lunaCachedFn('com.webos.service.audio/master/getVolume', {}, 10000, function (r, raw) {
    // A refusal can arrive unparsed, as luna-send's text only.
    if (/unknown (method|service)/i.test(String((r && r.errorText) || raw || ''))) masterVolumeSupported = false;
    var vs = r && r.returnValue !== false && r.volumeStatus;
    if (vs && typeof vs === 'object') masterVolumeSupported = true;
    cb(vs && typeof vs === 'object' ? vs : null);
  });
}

/*
 * Whether the TV has LG's Always-on, from whether its settings service
 * describes the setting: a C2 (webOS 9.2) does; a B8 (webOS 4.4) has an
 * alwaysOn value but answers "no result in DB" for its description. Asked
 * once, as it cannot change. cb(true|false).
 */
var alwaysOnSupport = null;
var alwaysOnWaiters = null;
function alwaysOnSupported(cb) {
  cb = cb || function () {};
  if (alwaysOnSupport !== null || !lunaFn) return cb(alwaysOnSupport === true);
  if (alwaysOnWaiters) return alwaysOnWaiters.push(cb);
  alwaysOnWaiters = [cb];
  lunaFn('com.webos.service.settings/getSystemSettingDesc', { category: 'general', keys: ['alwaysOn'] }, function (r, raw) {
    var desc = r && r.returnValue !== false && Array.isArray(r.results) ? r.results[0] : null;
    // Remembered only once the TV has answered either way, not after a timeout.
    if (desc) alwaysOnSupport = !(desc.ui && desc.ui.visible === false);
    else if (r || /no result/i.test(String(raw || ''))) alwaysOnSupport = false;
    var waiting = alwaysOnWaiters;
    alwaysOnWaiters = null;
    for (var i = 0; i < waiting.length; i++) waiting[i](alwaysOnSupport === true);
  });
}

function getCapabilities(extra) {
  extra = extra || {};
  return {
    hasRemoteInfo: !!readRemoteInfo(),
    hasPnwash: fs.existsSync('/mnt/lg/cmn_data/pnwash/completedOffRsCount'),
    hasCell: !!(HARDWARE_INFO && HARDWARE_INFO.cell),
    hasHdmiProc: fs.existsSync('/proc/lg/hdmi20'),
    hasMediaState: hasMediaState,
    hasHdrStatus: fs.existsSync('/proc/lg/pe/hdr_status'),
    socArch: HARDWARE_INFO && HARDWARE_INFO.socArch,
    hasLogoLight: hasLogoLight,
    hasOnTimer: powerTimersSeen ? !!powerTimersSeen.on : null,
    hasOffTimer: powerTimersSeen ? !!powerTimersSeen.off : null,
    thermalPresent: THERMAL_PRESENT,
    emmcWearPresent: EMMC_WEAR_PRESENT,
    hasLightSensor: hasLightSensor,
    updateCheck: !!extra.updateCheck,
    hdmiSeen: hdmiSeen,
    hasGpuClock: gpuClockMhz() !== null,
    isOled: !!extra.isOled,
    hasRemoteButtons: !!extra.hasRemoteButtons,
    userEntities: extra.userEntities || {}
  };
}

function getInstalledApps() {
  return installedApps;
}

function getPictureModes() {
  return lastPicModes;
}

function getCapabilitySignature() {
  var cap = [];
  for (var hs in hdmiSeen) cap.push(hs);
  if (hasMediaState) cap.push('play_state');
  if (powerTimersSeen) {
    cap.push('timers_read');
    if (powerTimersSeen.on) cap.push('on_timer');
    if (powerTimersSeen.off) cap.push('off_timer');
  }
  return cap.sort().join(',');
}

module.exports = {
  THERMAL_PRESENT: THERMAL_PRESENT,
  EMMC_WEAR_PRESENT: EMMC_WEAR_PRESENT,
  HARDWARE_INFO: HARDWARE_INFO,
  inputNameMap: inputNameMap,
  init: init,
  meminfo: meminfo,
  emmcInfo: emmcInfo,
  onlineCpus: onlineCpus,
  statCpu: statCpu,
  alwaysOnSupported: alwaysOnSupported,
  cpuSincePublish: cpuSincePublish,
  socMhz: socMhz,
  socHz: socHz,
  cpuTimes: cpuTimes,
  gpuClockMhz: gpuClockMhz,
  swapBacking: swapBacking,
  wifi: wifi,
  macAddress: macAddress,
  netBytes: netBytes,
  getVideoSignal: getVideoSignal,
  readRemoteInfo: readRemoteInfo,
  getActiveHdmiDiagnostics: getActiveHdmiDiagnostics,
  getHdmiSignal: getHdmiSignal,
  hdmiReceiverMap: hdmiReceiverMap,
  hdmiLinks: hdmiLinks,
  hdmiSources: hdmiSources,
  readHdmiStatus: readHdmiStatus,
  getPictureEngineInfo: getPictureEngineInfo,
  formatSoundOutput: formatSoundOutput,
  volumeControl: volumeControl,
  formatPicMode: formatPicMode,
  formatDynamicRange: formatDynamicRange,
  pictureModes: pictureModes,
  refreshInputNames: refreshInputNames,
  refreshInstalledApps: refreshInstalledApps,
  getInstalledApps: getInstalledApps,
  getPictureModes: getPictureModes,
  getCapabilitySignature: getCapabilitySignature,
  loadHdmiSeen: loadHdmiSeen,
  noteHdmiSeen: noteHdmiSeen,
  appStorage: appStorage,
  hdmiPorts: hdmiPorts,
  hdmiInputs: hdmiInputs,
  collectProcesses: collectProcesses,
  collectCpuProcesses: collectCpuProcesses,
  detectWebosVersion: detectWebosVersion,
  detectHardwareInfo: detectHardwareInfo,
  detectDeviceInfo: detectDeviceInfo,
  detectFrontLights: detectFrontLights,
  detectLogoLight: detectFrontLights,
  collectStats: collectStats,
  clearCache: clearCache,
  expireStats: expireStats,
  getCapabilities: getCapabilities
};
