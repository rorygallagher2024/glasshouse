'use strict';
/*
 * lib/sysinfo.js - What the System info view says about the TV that the
 * stats do not: its board, storage and serial number, both network
 * addresses, the kernel and Node.js it runs, and the Homebrew Channel.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * None of it changes while Glasshouse runs, so it is read once, at the first
 * request. Each field is null where the TV does not give it: nyx's device
 * info is not on every webOS release, and its keys vary between them.
 */

var fs = require('fs');
var os = require('os');

var DEVICE_INFO = '/var/run/nyx/device_info.json';
var HBCHANNEL_APPINFO = '/media/developer/apps/usr/palm/applications/org.webosbrew.hbchannel/appinfo.json';
var CPU_MAX_FREQ = '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq';

var paths = { deviceInfo: DEVICE_INFO, hbchannel: HBCHANNEL_APPINFO, cpuMaxFreq: CPU_MAX_FREQ };
var cached = null;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function readText(p) {
  try { return String(fs.readFileSync(p, 'utf8')).trim(); } catch (e) { return null; }
}

// A string with something in it, else null. nyx leaves some keys empty or
// as placeholders on sets that do not have them.
function text(v) {
  if (typeof v !== 'string') return null;
  v = v.trim();
  if (!v || /^(n\/a|none|unknown|null|0+)$/i.test(v)) return null;
  return v;
}

// "AC:5A:F0:5B:C1:77" as the stats give a MAC, in lower case.
function mac(v) {
  v = text(v);
  if (!v || !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(v) || /^(00[:-]){5}00$/.test(v)) return null;
  return v.toLowerCase().replace(/-/g, ':');
}

// "8 GB", "2.5 GB": nyx's sizes, kept as they are when they read as one.
function size(v) {
  v = text(v);
  return v && /^\d+(\.\d+)?\s*[KMGT]i?B$/i.test(v) ? v.replace(/\s*([KMGT]i?B)$/i, ' $1') : null;
}

function parse(info, hb, maxKhz, kernel, node) {
  info = info && typeof info === 'object' ? info : {};
  var khz = parseInt(maxKhz, 10);
  return {
    board: text(info.board_type),
    hardwareRevision: text(info.hardware_revision),
    storage: size(info.storage_size),
    ram: size(info.ram_size),
    serial: text(info.serial_number),
    wifiMac: mac(info.wifi_addr),
    wiredMac: mac(info.wired_addr),
    kernel: text(kernel),
    node: text(node),
    hbchannel: hb && text(hb.version) ? text(hb.version) : null,
    cpuMaxHz: isFinite(khz) && khz > 0 ? khz * 1000 : null
  };
}

/**
 * The TV's fixed facts, read once.
 * @returns {Object}
 */
function read() {
  if (cached) return cached;
  cached = parse(readJson(paths.deviceInfo), readJson(paths.hbchannel), readText(paths.cpuMaxFreq),
    os.release(), process.version);
  return cached;
}

// For tests: read from elsewhere, and afresh.
function setPaths(p) {
  for (var k in p) paths[k] = p[k];
  cached = null;
}

module.exports = {
  read: read,
  parse: parse,
  setPaths: setPaths
};
