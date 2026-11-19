// The Metrics tab's HDMI view: the four ports, then each input with a device
// on it in detail: the mode it sends, how much of the link that takes, what
// the two ends agreed on, and how clean the link has been, from /api/hdmi's
// link (lib/hdmilink.js) and the picture's format from the stats.

let hdmiTimer = null;
let hdmiFormat = null;

function hdmiViewOpen() {
  return !document.hidden && typeof activeTab !== 'undefined' && activeTab === 'metrics' &&
    typeof metricsSubView !== 'undefined' && metricsSubView === 'hdmi';
}

function hdmiViewChanged() {
  if (hdmiViewOpen()) {
    if (!hdmiTimer) {
      loadHdmi();
      // The link's counters and times move; the ports otherwise load on change.
      hdmiTimer = setInterval(loadHdmi, 5000);
    }
  } else if (hdmiTimer) {
    clearInterval(hdmiTimer);
    hdmiTimer = null;
  }
}

document.addEventListener('visibilitychange', hdmiViewChanged);

// The stats' view of the picture on screen: its dynamic range and colour.
let hdmiLast = null;
function hdmiStats(d) {
  const had = hdmiFormat;
  hdmiFormat = {
    range: d.signal_format && d.signal_format.type_display || null,
    colorimetry: d.colorimetry || (d.picture_engine && d.picture_engine.colorimetry) || null,
    vrrType: d.source_frame_rate && d.source_frame_rate.vrr_type || null
  };
  // The view drew before the picture's format was known.
  if (!had && hdmiLast && hdmiViewOpen()) renderHdmiLinks(hdmiLast);
}

function hdmiAgo(at, now) {
  if (!at) return '—';
  const min = Math.max(0, Math.round((now - at) / 60000));
  if (min < 1) return t('metrics.hdmiv.lessMin', 'under a minute');
  if (min < 60) return t('metrics.perf.minutes', '{n} min', { n: min });
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return t('metrics.hdmiv.days', '{n} days', { n: Math.round(h / 24) });
  return m ? t('metrics.perf.hoursMinutes', '{h} h {m} min', { h, m }) : t('metrics.perf.hours', '{h} h', { h });
}

function hdmiGbps(g) {
  return t('metrics.hdmiv.gbps', '{n} Gbps', { n: g >= 10 ? g.toFixed(1) : g.toFixed(2) });
}

function hdmiChip(label, on, title) {
  return '<span class="hdmi-chip' + (on ? ' on' : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
    '<i aria-hidden="true"></i>' + esc(label) + '<span class="sr-only">' + esc(on ? t('metrics.hdmiv.on', 'on') : t('metrics.hdmiv.off', 'off')) + '</span></span>';
}

function hdmiBandwidth(l) {
  const cap = l.link;
  if (!cap || l.payloadGbps == null) return '';
  const pct = g => Math.min(100, g / cap.rawGbps * 100).toFixed(2);
  const marks = [];
  if (l.at10Gbps != null && l.bpc < 10) marks.push([l.at10Gbps, t('metrics.hdmiv.bit10', '10-bit')]);
  if (l.at12Gbps != null && l.bpc < 12) marks.push([l.at12Gbps, t('metrics.hdmiv.bit12', '12-bit')]);
  const how = cap.kind === 'frl'
    ? t('metrics.hdmiv.frl', 'FRL, {lanes} lanes at {rate} Gbps', { lanes: cap.lanes, rate: cap.laneGbps })
    : t('metrics.hdmiv.tmds', 'TMDS, 3 channels, up to {rate} Gbps', { rate: cap.rawGbps });
  let room = '';
  if (l.fits12 && l.bpc < 12) room = t('metrics.hdmiv.room12', 'At this resolution and refresh rate, the link has room for 12-bit colour.');
  else if (l.fits10 && l.bpc < 10) room = t('metrics.hdmiv.room10', 'At this resolution and refresh rate, the link has room for 10-bit colour, not 12-bit.');
  else if (l.fits10 === false && l.bpc < 10) room = t('metrics.hdmiv.noRoom', 'At this resolution and refresh rate, the link has no room for more colour depth.');
  return '<div class="hdmi-bw">' +
    '<div class="hdmi-row"><span class="hdmi-lbl">' + esc(t('metrics.hdmiv.bandwidth', 'Bandwidth')) + '</span>' +
    '<span class="hdmi-val"><b>' + esc(hdmiGbps(l.payloadGbps)) + '</b> ' + esc(t('metrics.hdmiv.ofLink', 'of {n}', { n: hdmiGbps(cap.rawGbps) })) + '</span></div>' +
    '<div class="hdmi-bar" role="img" aria-label="' + esc(t('metrics.hdmiv.barLabel', 'The picture uses {used} of the link’s {total}', { used: hdmiGbps(l.payloadGbps), total: hdmiGbps(cap.rawGbps) })) + '">' +
      '<b style="width:' + pct(l.payloadGbps) + '%"></b>' +
      marks.map(m => '<i class="hdmi-mark' + (m[0] > cap.rawGbps * 1.005 ? ' over' : '') + (m[0] / cap.rawGbps > 0.9 ? ' end' : '') + '" style="left:' + pct(m[0]) + '%"><span>' + esc(m[1]) + '</span></i>').join('') +
    '</div>' +
    '<div class="hdmi-sub">' + esc(how) + (room ? '. ' + esc(room) : '.') + '</div>' +
    '</div>';
}

function hdmiLinkCard(i, now) {
  const l = i.link;
  const name = esc(t('metrics.hdmiv.port', 'HDMI {n}', { n: i.port })) + (i.label && !/^HDMI\s*\d$/i.test(i.label) ? ' <span class="hdmi-name">' + esc(i.label) + '</span>' : '');
  const state = i.active ? ['live', t('metrics.hdmiv.onScreen', 'On screen')]
    : l.locked ? ['idle', t('metrics.hdmiv.linked', 'Linked, not on screen')]
      : ['idle', t('metrics.hdmiv.asleep', 'Device on, no picture')];
  const head = '<div class="perf-top"><div><div class="grp">' + name + '</div>' +
    (l.locked && l.width ? '<div class="perf-big num">' + l.width + ' × ' + l.height + (l.refreshHz ? ' <small>' + l.refreshHz + ' Hz</small>' : '') + '</div>' : '') +
    '</div><span class="pill ' + state[0] + '">' + esc(state[1]) + '</span></div>';
  if (!l.locked) {
    return '<div class="perf-card hdmi-card asleep">' + head +
      '<div class="hdmi-sub">' + esc(t('metrics.hdmiv.asleepNote', 'The device on this cable is powered but not sending a picture: asleep, or showing nothing until it is chosen.')) + '</div></div>';
  }
  const fmt = i.active && hdmiFormat ? hdmiFormat : null;
  const desc = [l.chroma, l.bpc ? t('metrics.hdmiv.bits', '{n}-bit', { n: l.bpc }) : null,
    fmt && fmt.range, fmt && fmt.colorimetry && fmt.colorimetry !== 'NODATA' ? fmt.colorimetry : null].filter(Boolean).join(' · ');
  const vrrTitle = l.vrr && l.vrrMinHz && l.vrrMaxHz ? t('metrics.hdmiv.vrrRange', '{min} to {max} Hz', { min: l.vrrMinHz, max: l.vrrMaxHz }) : '';
  const chips = [
    l.hdcp && l.hdcp !== 'None' ? hdmiChip(l.hdcp, true) : hdmiChip('HDCP', false),
    hdmiChip(l.vrr && vrrTitle ? 'VRR ' + vrrTitle : 'VRR', l.vrr),
    hdmiChip('ALLM', l.allm, t('metrics.hdmiv.allmTitle', 'The source asks for the TV’s low-latency game picture')),
    hdmiChip('QMS', l.qms, t('metrics.hdmiv.qmsTitle', 'The source changes refresh rate without the screen going blank')),
    hdmiChip('DSC', l.dsc, t('metrics.hdmiv.dscTitle', 'The picture is compressed to fit the link')),
    l.dolby ? hdmiChip('Dolby Vision', true) : ''
  ].join('');
  // Zero is good news; any other count means little without the rate, as a
  // fast link carries hundreds of billions of bits a second.
  const errTone = l.errors === 0 ? ' good' : '';
  const errText = l.errors == null ? '\u2014' : l.errors === 0 ? t('metrics.hdmiv.noErrors', 'None') : String(l.errors);
  let errNote = l.errorsSince ? t('metrics.hdmiv.inLast', 'in {time}', { time: hdmiAgo(l.errorsSince, now) }) : '';
  if (l.errors > 0 && l.errorsSince && l.link) {
    const bits = l.link.rawGbps * 1e9 * Math.max(1, (now - l.errorsSince) / 1000);
    const per = bits / l.errors;
    const rate = per >= 1e12 ? t('metrics.hdmiv.perTrillion', '1 bit in {n} trillion', { n: Math.round(per / 1e12) })
      : per >= 1e9 ? t('metrics.hdmiv.perBillion', '1 bit in {n} billion', { n: Math.round(per / 1e9) })
        : t('metrics.hdmiv.perMillion', '1 bit in {n} million', { n: Math.max(1, Math.round(per / 1e6)) });
    errNote = errNote + ', ' + t('metrics.hdmiv.about', 'about {rate}', { rate });
  }
  const health = [
    [t('metrics.hdmiv.errors', 'Link errors'), '<span class="num' + errTone + '">' + esc(errText) + '</span>' +
      (errNote ? '<small class="hdmi-err-note">' + esc(errNote) + '</small>' : '')],
    [t('metrics.hdmiv.connected', 'Connected for'), esc(hdmiAgo(l.connectedAt, now))],
    [t('metrics.hdmiv.steady', 'Picture steady for'), esc(hdmiAgo(l.steadyAt, now))],
    [t('metrics.hdmiv.changes', 'Mode changes'), l.modeChanges == null ? '—' : '<span class="num">' + l.modeChanges + '</span>']
  ].map(x => '<div class="hdmi-stat"><div class="hdmi-lbl">' + esc(x[0]) + '</div><div class="hdmi-stat-v">' + x[1] + '</div></div>').join('');
  const tech = [
    [t('metrics.hdmiv.vic', 'Video code (VIC)'), l.vic || '—'],
    [t('metrics.hdmiv.total', 'Total timing'), l.totalWidth && l.totalHeight ? l.totalWidth + ' × ' + l.totalHeight : '—'],
    [t('metrics.hdmiv.clock', 'Pixel clock'), l.pixelClockMhz ? l.pixelClockMhz + ' MHz' : '—'],
    [t('metrics.hdmiv.linkMode', 'Link'), l.phyMode || '—']
  ].map(x => '<div><dt>' + esc(x[0]) + '</dt><dd class="num">' + esc(String(x[1])) + '</dd></div>').join('');
  return '<div class="perf-card perf-wide hdmi-card">' + head +
    (desc ? '<div class="perf-sub hdmi-desc">' + esc(desc) + '</div>' : '') +
    hdmiBandwidth(l) +
    '<div class="hdmi-chips">' + chips + '</div>' +
    '<div class="hdmi-health">' + health + '</div>' +
    '<details class="hdmi-tech"><summary>' + esc(t('metrics.hdmiv.tech', 'Technical details')) + '</summary><dl>' + tech + '</dl></details>' +
    '</div>';
}

function renderHdmiLinks(d) {
  hdmiLast = d;
  const box = q('hdmi-links');
  if (!box) return;
  const now = Date.now();
  const withLink = (d.inputs || []).filter(i => i.link).sort((a, b) =>
    (b.active - a.active) || ((b.link.locked ? 1 : 0) - (a.link.locked ? 1 : 0)) || (a.port - b.port));
  // Open technical details stay open across refreshes.
  const open = {};
  box.querySelectorAll('.hdmi-card').forEach(c => { const dt = c.querySelector('details'); if (dt && dt.open) open[c.getAttribute('data-port')] = true; });
  box.innerHTML = withLink.length
    ? withLink.map(i => hdmiLinkCard(i, now).replace('class="perf-card', 'data-port="' + i.port + '" class="perf-card')).join('')
    : '<div class="perf-card perf-wide hdmi-card"><div class="hdmi-sub">' + esc((d.inputs || []).some(i => i.signal)
      // Older drivers (a C9 on webOS 4) give the mode alone, on the ports above.
      ? t('metrics.hdmiv.modeOnly', 'This TV reports only the mode each input sends, shown on its port above.')
      : t('metrics.hdmiv.none', 'No device on any HDMI input is switched on.')) + '</div></div>';
  box.querySelectorAll('.hdmi-card').forEach(c => { if (open[c.getAttribute('data-port')]) { const dt = c.querySelector('details'); if (dt) dt.open = true; } });
}
