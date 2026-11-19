// The Metrics tab's System info view: what the TV is, what it runs, how it
// has been switched on and how it is on the network. A row shows only where
// the TV gives its value, as models and webOS releases differ in what they
// report; a section with no rows is left out.

let sysFacts = null;          // /api/sysinfo, read when the view opens
let sysFactsAt = 0;
let sysLastStats = null;
let sysSerialShown = false;
let sysRendered = '';

function sysinfoViewChanged() {
  if (typeof metricsSubView === 'undefined' || metricsSubView !== 'advanced') return;
  // The facts do not change; the power-on counts do, so they are read again
  // each time the view opens, at most once a minute.
  if (sysFacts && Date.now() - sysFactsAt < 60000) return renderSysinfo();
  fetch(api('/api/sysinfo'), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d && d.ok) { sysFacts = d; sysFactsAt = Date.now(); } renderSysinfo(); })
    .catch(() => renderSysinfo());
}

function sysinfoStats(d) {
  sysLastStats = d;
  renderSysinfo();
}

function sysUptime(s) {
  const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return dd ? t('metrics.uptime.days', '{d}d {h}h {m}m', { d: dd, h: hh, m: mm })
    : hh ? t('metrics.uptime.hours', '{h}h {m}m', { h: hh, m: mm })
    : t('metrics.uptime.mins', '{m}m', { m: mm });
}

// A time today as a clock time; an earlier one with its date.
function sysWhen(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + time;
}

/*
 * tvpower's power-on reasons, by the name it gives. The ones not here are
 * mostly named after an app whose remote button turned the TV on (netflix,
 * disneyplus), and read well enough with their words split.
 */
const SYS_ON_REASONS = {
  remoteKey: () => t('metrics.sys.on.remoteKey', 'Remote'),
  localKey: () => t('metrics.sys.on.localKey', 'Button on the TV'),
  hdmiCec: () => t('metrics.sys.on.hdmiCec', 'HDMI-CEC (another device)'),
  wakeOnWiFi: () => t('metrics.sys.on.wakeOnLan', 'Wake-on-LAN'),
  wakeOnLan: () => t('metrics.sys.on.wakeOnLan', 'Wake-on-LAN'),
  wol: () => t('metrics.sys.on.wakeOnLan', 'Wake-on-LAN'),
  onTimer: () => t('metrics.sys.on.onTimer', 'On Timer'),
  rebootByOnRegular: () => t('metrics.sys.on.routineRestart', 'Routine restart'),
  rebootByARRegular: () => t('metrics.sys.on.routineRestart', 'Routine restart'),
  rebootByFault: () => t('metrics.sys.on.faultRestart', 'Restart after a fault'),
  rebootByTimeout: () => t('metrics.sys.on.faultRestart', 'Restart after a fault'),
  reset: () => t('metrics.sys.on.restart', 'Restart'),
  acFailure: () => t('metrics.sys.on.mains', 'Mains power restored'),
  // The standby processor starting the TV from a full power-off.
  micomPower: () => t('metrics.sys.on.coldStart', 'Cold start'),
  ota: () => t('metrics.sys.on.update', 'Software update'),
  dial: () => t('metrics.sys.on.cast', 'Cast from a phone'),
  homekit: () => t('metrics.sys.on.homekit', 'HomeKit'),
  powerOnByWov: () => t('metrics.sys.on.voice', 'Voice'),
  aiKey: () => t('metrics.sys.on.voice', 'Voice')
};

function sysReason(raw) {
  const f = SYS_ON_REASONS[raw];
  if (f) return f();
  const words = String(raw).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sysRow(title, value, desc, cls) {
  return `<div class="prot-row si-row"><div class="prot-main"><div class="prot-title">${esc(title)}</div>` +
    (desc ? `<div class="prot-desc">${esc(desc)}</div>` : '') + '</div>' +
    `<div class="prot-status si-val${cls ? ' ' + cls : ''}">${value}</div></div>`;
}

const sysText = v => `<span translate="no">${esc(v)}</span>`;

function sysOnOff(v) {
  return v ? `<span class="pill good">${esc(t('common.on', 'On'))}</span>`
    : `<span class="pill idle">${esc(t('common.off', 'Off'))}</span>`;
}

function sysSection(title, rows, extra) {
  rows = rows.filter(Boolean);
  if (!rows.length) return '';
  return `<div class="metrics-adv-sec"><div class="grp"><span>${esc(title)}</span>${extra || ''}</div>` +
    `<div class="prot-table">${rows.join('')}</div></div>`;
}

function sysinfoHtml(d, f) {
  d = d || {};
  f = f || {};
  const hw = d.hardware || {};
  const val = (title, v, desc) => v ? sysRow(title, sysText(v), desc) : '';

  // This TV
  const model = d.device && d.device.model && d.device.model !== 'webOS TV' ? d.device.model : null;
  // "2.5GB" from LG's environment, "2.5 GB" from nyx: one way, beside Storage.
  const ram = (hw.ram || f.ram || '').replace(/(\d)\s*([KMGT]B)$/i, '$1 $2');
  const swapMb = d.swap && d.swap.total ? Math.round(d.swap.total / 1024) : 0;
  const serial = f.serial
    ? sysRow(t('metrics.sys.serial', 'Serial number'),
      sysSerialShown ? sysText(f.serial)
        : `<button type="button" class="home-sub-btn si-reveal" data-sys-reveal>${esc(t('metrics.sys.show', 'Show'))}</button>`)
    : '';
  const tv = sysSection(t('metrics.sys.tv', 'This TV'), [
    val(t('metrics.sys.model', 'Model'), model),
    val(t('metrics.sys.board', 'Board'), f.board, t('metrics.sys.board.desc', 'Main board and broadcast system')),
    serial,
    val(t('metrics.sys.storage', 'Storage'), f.storage, t('metrics.sys.storage.desc', 'Built-in flash')),
    val(t('metrics.sys.memory', 'Memory'), ram, swapMb
      ? t('metrics.sys.memory.swap', 'Plus {mb} MB of compressed swap', { mb: swapMb }) : '')
  ]);

  // Software
  const osVer = (d.system && d.system.webos) || hw.webos;
  const fwVer = (d.system && d.system.firmware) || (d.device && d.device.firmware);
  const sw = sysSection(t('metrics.sys.software', 'Software'), [
    val('webOS', osVer, t('metrics.webos.desc', 'Operating system release version')),
    val(t('metrics.firmware', 'Firmware'), fwVer, t('metrics.firmware.desc', 'TV software build version')),
    val('Glasshouse', d.tvwebVersion && d.tvwebVersion !== '0.0.0' ? d.tvwebVersion : null),
    val(t('metrics.sys.hbchannel', 'Homebrew Channel'), f.hbchannel),
    val(t('metrics.sys.kernel', 'Linux kernel'), f.kernel),
    val('Node.js', f.node ? f.node.replace(/^v/, '') : null, t('metrics.sys.node.desc', 'The JavaScript runtime Glasshouse runs on'))
  ]);

  // Hardware
  const cores = d.coresTotal || 0;
  const ghz = f.cpuMaxHz ? (f.cpuMaxHz / 1e9).toFixed(1) : null;
  const cpuDesc = cores && ghz ? t('metrics.sys.cpu.coresGhz', '{n} cores, up to {ghz} GHz', { n: cores, ghz })
    : cores ? t('metrics.sys.cpu.cores', '{n} cores', { n: cores })
    : t('metrics.processor.desc', 'SoC platform and generation');
  const ps = d.panel_silicon || {};
  const cell = ps.cell && /[1-9a-zA-Z]/.test(ps.cell) ? ps.cell : null;
  const oled = d.oled || {};
  const hours = typeof oled.panel_hours === 'number' && oled.panel_hours > 0
    ? sysRow(t('metrics.sys.panelHours', 'Panel hours'), sysText(oled.panel_hours.toLocaleString()),
      t('metrics.sys.panelHours.desc', 'Hours the panel has been lit. OLED Care has its upkeep'))
    : '';
  const hwSec = sysSection(t('metrics.sys.hardware', 'Hardware'), [
    val(t('metrics.processor', 'Processor'), hw.soc_arch, cpuDesc),
    val(t('metrics.sys.refresh', 'Panel refresh rate'), hw.refresh_rate),
    val(t('metrics.oledCell', 'OLED Cell'), cell, t('metrics.oledCell.desc', 'Panel silicon cell identifier')),
    val(t('metrics.tcon', 'TCON Firmware'), ps.tcon_firmware, t('metrics.tcon.desc', 'Timing controller driving the panel')),
    hours
  ]);

  // Power
  const boot = d.bootTime ? Date.parse(d.bootTime) : NaN;
  const ps2 = d.powerState || {};
  const ontime = ps2.onTime && ps2.onTime.ontime > 0 && ps2.systemOn ? ps2.onTime.ontime : 0;
  const bool = v => typeof v === 'boolean';
  const power = sysSection(t('metrics.sys.power', 'Power'), [
    !isNaN(boot) && d.uptime ? sysRow(t('metrics.sys.upSince', 'Running since'), sysText(sysWhen(boot)),
      t('metrics.sys.upFor', 'Up {time}, counting standby', { time: sysUptime(d.uptime) })) : '',
    // A B8 (webOS 4) gives the reason without the time.
    ps2.onReason && ps2.systemOn ? sysRow(t('metrics.sys.lastOn', 'Last switched on'), sysText(sysReason(ps2.onReason)),
      ontime ? t('metrics.sys.lastOn.desc', '{time} ago', { time: sysUptime(ontime) }) : '') : '',
    // The System tab's settings, by its names; the server gives each only
    // where the TV has it.
    bool(d.quickBoot) ? sysRow(t('adv.quickBoot', 'Quick Boot'), sysOnOff(d.quickBoot),
      t('metrics.sys.quickStart.desc', 'Starts faster from standby')) : '',
    bool(d.alwaysReady) ? sysRow(t('adv.stayConnected', 'Stay connected when off'), sysOnOff(d.alwaysReady),
      t('metrics.sys.stayConnected.desc', 'On the network while switched off')) : '',
    bool(d.alwaysReadyScreen) ? sysRow(t('adv.alwaysReady', 'Always Ready'), sysOnOff(d.alwaysReadyScreen),
      t('metrics.sys.alwaysReady.desc', 'Shows a clock or artwork when switched off')) : '',
    bool(d.wakeOnLan) ? sysRow(t('adv.wol', 'Wake-on-LAN'), sysOnOff(d.wakeOnLan),
      t('metrics.sys.wol.desc', 'Turns on from a packet on the network')) : ''
  ]);

  // Switched on by: counted by Glasshouse, from when it was installed.
  const po = f.powerOns;
  let onBy = '';
  if (po && po.total) {
    const top = po.reasons.slice(0, 6);
    const rest = po.reasons.slice(6).reduce((a, r) => a + r.count, 0);
    const rows = top.map(r => sysRow(sysReason(r.reason), sysText(String(r.count))));
    if (rest) rows.push(sysRow(t('metrics.sys.on.other', 'Other'), sysText(String(rest))));
    const since = po.since ? `<span class="cur">${esc(t('metrics.sys.onBy.since', 'Since {date}',
      { date: new Date(po.since).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) }))}</span>` : '';
    onBy = sysSection(t('metrics.sys.onBy', 'Switched on by'), rows, since);
  }

  // Network
  const iface = (d.netTotal && d.netTotal.iface) || '';
  const onWifi = /^wl/.test(iface), onWired = /^eth/.test(iface);
  const wifiMac = f.wifiMac || (onWifi ? d.mac : null);
  const wiredMac = f.wiredMac || (onWired ? d.mac : null);
  const macDesc = used => used ? t('metrics.sys.mac.inUse', 'In use. Wake-on-LAN packets go to this one')
    : t('metrics.sys.mac.unused', 'Not in use');
  const signal = d.wifi && d.wifi.level ? t('metrics.sys.signal', 'Signal {dbm} dBm', { dbm: d.wifi.level }) : '';
  const net = sysSection(t('metrics.sys.network', 'Network'), [
    val(t('metrics.sys.hostname', 'Hostname'), d.hostname),
    val('IPv4', d.address),
    val('IPv6', d.address6),
    onWifi ? val(t('metrics.sys.wifi', 'Wi-Fi network'), d.ssid, signal) : '',
    val(t('metrics.sys.wifiMac', 'Wi-Fi MAC'), wifiMac, iface ? macDesc(onWifi) : ''),
    val(t('metrics.sys.wiredMac', 'Wired MAC'), wiredMac, iface ? macDesc(onWired) : '')
  ]);

  return [tv, sw, hwSec, power, onBy, net].filter(Boolean).join('');
}

function renderSysinfo() {
  const host = q('sysinfo');
  if (!host) return;
  if (typeof metricsSubView !== 'undefined' && metricsSubView !== 'advanced' && sysRendered) return;
  const html = sysinfoHtml(sysLastStats, sysFacts);
  if (html === sysRendered) return;
  sysRendered = html;
  host.innerHTML = html;
}

document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-sys-reveal]');
  if (!b) return;
  sysSerialShown = true;
  sysRendered = '';
  renderSysinfo();
});
