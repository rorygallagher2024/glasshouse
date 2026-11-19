/**
 * lib/hdmilink.js - One HDMI input's link in detail, for the Metrics tab's
 * HDMI view: what the source sends, how much of the link it takes, what the
 * two ends agreed on, and how clean the link has been.
 *
 * It reads the status file LG's HDMI 2.0/2.1 driver writes for each receiver
 * (/proc/lg/hdmi20/port<n>/status). Its times are milliseconds since boot, so
 * they become clock times by the uptime. Realtek boards' files carry far less,
 * and give only what they have.
 *
 * Strict ES5: runs on node 0.12.
 */

var names = require('./names');

function field(text, re) {
  var m = String(text || '').match(re);
  return m ? m[1].trim() : null;
}

function int(v, radix) {
  if (v === null || v === undefined) return null;
  var n = parseInt(v, radix || 10);
  return isFinite(n) ? n : null;
}

// The bits a pixel takes on the wire. 4:2:2 always travels in 24 bits, up to
// 12 bits a component; 4:2:0 carries half the colour of 4:4:4.
function bitsPerPixel(chroma, bpc) {
  if (!bpc) bpc = 8;
  if (chroma === 'Y422') return 24;
  if (chroma === 'Y420') return bpc * 3 / 2;
  return bpc * 3;
}

/*
 * The link's rated speed. FRL runs every lane at its rate and codes 16 bits in
 * 18; TMDS runs three channels, up to 3.4 Gbps each ("3G") or 6 Gbps with
 * scrambling ("6G"), and codes 8 bits in 10.
 */
function linkCapacity(phyMode) {
  var mode = String(phyMode || '');
  var frl = mode.match(/^FRL\s+(\d+)G\s+(\d+)L\b/i);
  if (frl) {
    var lanes = parseInt(frl[2], 10), rate = parseInt(frl[1], 10);
    return { kind: 'frl', lanes: lanes, laneGbps: rate, rawGbps: rate * lanes };
  }
  var tmds = mode.match(/^(?:TMDS\s*)?([36])G$/i);
  if (tmds) {
    var raw = tmds[1] === '6' ? 18 : 10.2;
    return { kind: 'tmds', lanes: 3, laneGbps: Math.round(raw / 3 * 10) / 10, rawGbps: raw };
  }
  return null;
}

// The lanes' counters, in hex as the driver prints them.
function counters(raw, label) {
  var line = field(raw, new RegExp(label + '\\s+Valid/Error\\s*:\\s*([^\\n]+)', 'i'));
  if (!line) return null;
  var total = 0, valid = false;
  var re = /\[(\d)\]\[0x([0-9a-f]+)\]/gi, m;
  while ((m = re.exec(line))) {
    if (m[1] === '1') valid = true;
    total += parseInt(m[2], 16);
  }
  return valid ? total : null;
}

/*
 * The link on one receiver, or null when nothing is on its cable. uptimeMs
 * and now place the driver's times; timing is telemetry's parseTiming of the
 * same file.
 */
function detail(raw, o) {
  if (!raw) return null;
  o = o || {};
  if (/===== HDMI STATUS =====/.test(raw) || /^\s*phy_lock_status\s*:/m.test(raw)) return realtek(raw);

  var powered = field(raw, /is5Vconnected\[(\d)\]/i);
  var locked = field(raw, /PHY\s+Lock\[(\d)\]/i) === '1';
  if (powered !== '1' && !locked) return null;

  var stable = raw.split(/\[Stable Sync Info\]/i)[1] || raw;
  var sig = stable.match(/Sig:\[(\d+)\]\((\d+)\)x\[(\d+)\]\((\d+)\)@\[(\d+)\]Hz/i);
  var chromaKey = field(stable, /Video Format\[([^\]]+)\]/i);
  var bpc = int(field(stable, /DeepColorMode\[\s*(\d+)\s*BIT\]/i));
  var phyRaw = field(raw, /PHY Mode\[([^\]]+)\]/i);
  var cap = linkCapacity(phyRaw);
  var mm = raw.match(/VRR Min\[(\d+)\]\/Max\[(\d+)\]/i);
  var vrrMin = mm ? int(mm[1]) : null, vrrMax = mm ? int(mm[2]) : null;
  var vrrMode = field(raw, /isFreeSync\[(\d+)\]/i);

  // telemetry's parseTiming: the video code's size where the driver's is a
  // line off, and the pixel clock on TMDS, where deep colour inflates the totals.
  var tm = o.timing || null;
  var width = tm && tm.width ? tm.width : sig ? int(sig[1]) : null;
  var height = tm && tm.height ? tm.height : sig ? int(sig[3]) : null;
  var refresh = tm && tm.refreshHz ? tm.refreshHz : sig ? int(sig[5]) : null;
  var px = tm && tm.pixelClockKhz ? Math.round(tm.pixelClockKhz / 100) / 10 : null;
  if (px === null && sig) {
    var tot = int(sig[2]) * int(sig[4]) * int(sig[5]);
    if (tot > 0) px = Math.round(tot / 1e5) / 10;
  }
  /*
   * The rate the mode takes on the wire, coding included, as HDMI's own tables
   * give it against a link's rated speed: 4K 120 Hz RGB is 32.1 Gbps at 8 bits,
   * 40.1 at 10 and 48.1 at 12, which a 48 Gbps link carries.
   */
  var coding = cap && cap.kind === 'tmds' ? 10 / 8 : 18 / 16;
  var need = function (bits) { return px ? Math.round(px * bitsPerPixel(chromaKey, bits) * coding / 10) / 100 : null; };
  var fits = function (g) { return g !== null && cap ? g <= cap.rawGbps * 1.005 : null; };
  var payload = need(bpc);

  var at = function (ms) {
    ms = int(ms);
    if (!ms || typeof o.uptimeMs !== 'number' || typeof o.now !== 'number' || ms > o.uptimeMs) return null;
    return o.now - (o.uptimeMs - ms);
  };

  var frlErrors = counters(raw, 'FRL CED');
  var tmdsErrors = counters(raw, 'TMDS CED');
  var rsm = raw.match(/Reed Solomon Corrections Valid\/Count\s*:\s*\[(\d)\]\[0x([0-9a-f]+)\]/i);
  var isFrl = cap && cap.kind === 'frl';

  var out = {
    powered: powered === '1',
    locked: locked,
    width: width,
    height: height,
    totalWidth: sig ? int(sig[2]) : null,
    totalHeight: sig ? int(sig[4]) : null,
    refreshHz: refresh,
    vic: int(field(stable, /VIC Code\[(\d+)\]/i)),
    chroma: chromaKey ? names.hdmiChroma(chromaKey).display : null,
    chromaKey: chromaKey,
    bpc: bpc,
    pixelClockMhz: px,
    phyMode: phyRaw ? names.hdmiPhyMode(phyRaw).display : null,
    link: cap,
    payloadGbps: locked ? payload : null,
    // What the same mode would take at more bits a component.
    at10Gbps: locked && chromaKey !== 'Y422' ? need(10) : null,
    at12Gbps: locked && chromaKey !== 'Y422' ? need(12) : null,
    fits10: locked && chromaKey !== 'Y422' ? fits(need(10)) : null,
    fits12: locked && chromaKey !== 'Y422' ? fits(need(12)) : null,
    hdcp: (function (h) { return h ? names.hdmiHdcp(h).display : null; })(field(raw, /Current HDCP Auth Version => (HDCP\w+)/i)),
    allm: field(raw, /isAllm\[(\d+)\]/i) === '1',
    vrr: !!((vrrMode && vrrMode !== '0') || (vrrMin > 0 || vrrMax > 0)),
    vrrKind: vrrMode === '1' ? 'freesync' : vrrMode === '2' ? 'hdmi' : null,
    vrrMinHz: vrrMin > 0 ? vrrMin : null,
    vrrMaxHz: vrrMax > 0 ? vrrMax : null,
    qms: field(raw, /QMSMode\[(\d+)\]/i) === '1',
    dsc: field(raw, /\bDSC\[(\d+)\]/i) === '1',
    dolby: field(raw, /Dolby HDR Info\[(\d+)\]/i) === '1',
    errors: isFrl ? frlErrors : tmdsErrors,
    corrected: isFrl && rsm && rsm[1] === '1' ? parseInt(rsm[2], 16) : null,
    modeChanges: int(field(raw, /VideoChangeCount\[(\d+)\]/i)),
    connectedAt: at(field(raw, /Cable Connected Time\[(\d+)\]/i)),
    steadyAt: at(field(raw, /Stable Time Updated\[(\d+)\]/i))
  };
  // A source asleep leaves its last mode and counts in the file; without a
  // lock they describe nothing on the cable now.
  if (!locked) {
    ['width', 'height', 'totalWidth', 'totalHeight', 'refreshHz', 'vic', 'chroma', 'chromaKey', 'bpc', 'pixelClockMhz',
      'phyMode', 'link', 'hdcp', 'errors', 'corrected', 'modeChanges', 'steadyAt'].forEach(function (k) { out[k] = null; });
    out.allm = out.vrr = out.qms = out.dsc = out.dolby = false;
  }
  return out;
}

// Realtek's file: whether a source is powered and locked, and the chroma.
function realtek(raw) {
  function rf(key) { var m = raw.match(new RegExp('^\\s*' + key + '\\s*:\\s*([^\\r\\n]+)', 'm')); return m ? m[1].trim() : null; }
  var locked = rf('phy_lock_status') === '1';
  var powered = rf('link_hdmi_5v') === '1';
  if (!locked && !powered) return null;
  return {
    powered: powered, locked: locked, width: null, height: null, refreshHz: null, chroma: null, bpc: null,
    pixelClockMhz: null, phyMode: null, link: null, payloadGbps: null, hdcp: null,
    allm: rf('allm_mode') === '1', vrr: null, qms: null, dsc: null, dolby: null,
    errors: null, corrected: null, modeChanges: null, connectedAt: null, steadyAt: null
  };
}

/*
 * The link's error counters cover a short interval and start again, so one
 * reading says little. Every 5 seconds each receiver with a lock adds its
 * counts here, from when Glasshouse first saw that cable connected; a new
 * connection, or losing the lock, starts again.
 */
var TALLY_MS = 5000;
var tallies = {};
var tallyTimer = null;
var tallyRead = null;
var tallyNow = function () { return Date.now(); };

function tallySample() {
  for (var r = 0; r < 4; r++) {
    var raw = tallyRead(r);
    var d = raw ? detail(raw, {}) : null;
    if (!d || !d.locked || d.errors === null) { delete tallies[r]; continue; }
    var cable = (raw.match(/Cable Connected Time\[(\d+)\]/i) || [])[1] || '';
    var t = tallies[r];
    if (!t || t.cable !== cable) t = tallies[r] = { cable: cable, since: tallyNow(), errors: 0, corrected: 0, readings: 0 };
    t.errors += d.errors;
    t.corrected += d.corrected || 0;
    t.readings++;
  }
}

function startTally(read, now) {
  tallyRead = read;
  if (now) tallyNow = now;
  if (tallyTimer) return;
  tallySample();
  tallyTimer = setInterval(tallySample, TALLY_MS);
  if (tallyTimer.unref) tallyTimer.unref();
}

function stopTally() {
  if (tallyTimer) clearInterval(tallyTimer);
  tallyTimer = null;
  tallies = {};
}

// The counts since then for one receiver, or null before a reading.
function tally(receiver) {
  var t = tallies[receiver];
  return t && t.readings ? { since: t.since, errors: t.errors, corrected: t.corrected, readings: t.readings } : null;
}

module.exports = {
  detail: detail,
  startTally: startTally,
  stopTally: stopTally,
  tallySample: tallySample,
  tally: tally,
  linkCapacity: linkCapacity,
  bitsPerPixel: bitsPerPixel
};
