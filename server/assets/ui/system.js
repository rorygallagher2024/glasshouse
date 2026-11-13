// HDMI diagnostics, processes and CPU use.

let currentHdmiInputs = null;
let currentHdmiDiag = null;
let currentColSpace = null;
let currentHdmiEarcPort = null;

function renderHdmiJackSvg() {
  return `<svg class="port-jack" viewBox="0 0 26 15" width="22" height="13" aria-hidden="true">` +
    `<path d="M 3,2 H 23 V 8 L 20,13 H 6 L 3,8 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
    `<rect x="7" y="5" width="12" height="2" rx="0.5" fill="currentColor"/>` +
  `</svg>`;
}

function formatColorDepth(cd) {
  if (!cd) return '';
  const m = String(cd).match(/^(\d+)\s*-?\s*(?:bit)?$/i);
  return m ? m[1] + '-bit' : String(cd);
}

function renderHdmiPort(i, diag, colSpace) {
  const s = i.signal;
  const isEarc = i.earc !== undefined ? i.earc : (currentHdmiEarcPort ? i.port === currentHdmiEarcPort : i.port === 2);
  const earcBadge = isEarc ? '<span class="port-cap" translate="no">eARC</span>' : '';
  const jackSvg = renderHdmiJackSvg();

  if (!s && !i.deviceSeen) {
    // A cable in the port with nothing on its other end, where the TV can tell.
    const emptyState = i.cableOnly ? t('metrics.hdmi.cableOnly', 'Cable only') : t('metrics.hdmi.empty', 'Empty');
    const unconnected = i.cableOnly ? t('metrics.hdmi.noDevice', 'Nothing on the other end') : t('metrics.hdmi.unconnected', 'Unconnected');
    return `<div class="port empty">` +
           `<div class="ptop">` +
             `<span class="pn num">${i.port}</span>` +
             `<div class="pstatus-wrap">${earcBadge}${jackSvg}<span class="pst">${emptyState}</span></div>` +
           `</div>` +
           `<div class="pl empty">${unconnected}</div>` +
           `</div>`;
  }

  const cls = i.active ? 'port live' : 'port seen';
  const state = i.active ? t('metrics.hdmi.active', 'Active') : t('metrics.hdmi.idle', 'Idle');
  const isMatchDiag = i.active || (diag && diag.port === i.port);

  const badges = [];
  if (s) {
    if (s.resolution) {
      const mode = [s.resolution.replace('x', '×'),
                    s.refreshHz ? s.refreshHz + ' Hz' : null,
                    s.interlaced ? t('metrics.hdmi.interlaced', 'interlaced') : null].filter(Boolean).join(' · ');
      badges.push(`<span class="hdmi-badge res num">${esc(mode)}</span>`);
    }
    const colorDepth = formatColorDepth(s.colorDepth);
    if (isMatchDiag && diag) {
      if (diag.phy_mode) badges.push(`<span class="hdmi-badge">${esc(diag.phy_mode)}</span>`);
      if (diag.chroma) badges.push(`<span class="hdmi-badge">${esc(diag.chroma)}</span>`);
      if (colorDepth) badges.push(`<span class="hdmi-badge">${esc(colorDepth)}</span>`);
      if (diag.hdcp && diag.hdcp !== 'None') badges.push(`<span class="hdmi-badge">HDCP ${esc(diag.hdcp.replace(/^HDCP\s*/i, ''))}</span>`);
      if (colSpace) badges.push(`<span class="hdmi-badge">${esc(colSpace)}</span>`);
      if (s.pixelClockMhz) badges.push(`<span class="hdmi-badge num">${s.pixelClockMhz} MHz</span>`);
      if (diag.allm) badges.push(`<span class="hdmi-badge feat" translate="no">ALLM</span>`);
      if (diag.vrr) badges.push(`<span class="hdmi-badge feat green" translate="no">VRR</span>`);
      if (diag.qms) badges.push(`<span class="hdmi-badge feat" translate="no">QMS</span>`);
    } else {
      if (colorDepth) badges.push(`<span class="hdmi-badge">${esc(colorDepth)}</span>`);
      if (s.pixelClockMhz) badges.push(`<span class="hdmi-badge num">${s.pixelClockMhz} MHz</span>`);
    }
  }

  const detailsHtml = badges.length
    ? `<div class="pbadges">${badges.join('')}</div>`
    : `<div class="pd">${t('metrics.hdmi.noSignal', 'Device seen, no signal')}</div>`;

  return `<div class="${cls}">` +
         `<div class="ptop">` +
           `<span class="pn num">${i.port}</span>` +
           `<div class="pstatus-wrap">${earcBadge}${jackSvg}<span class="pst">${state}</span></div>` +
         `</div>` +
         `<div class="pl">${esc(i.label)}</div>` +
         detailsHtml +
         `</div>`;
}

function renderHdmiGrid() {
  const grid = q('hdmi-grid');
  if (!grid || !currentHdmiInputs) return;
  grid.innerHTML = currentHdmiInputs.map(i => renderHdmiPort(i, currentHdmiDiag, currentColSpace)).join('');
}

function renderHdmiDiag(diag, colSpace) {
  currentHdmiDiag = diag;
  currentColSpace = colSpace;
  if (currentHdmiInputs) renderHdmiGrid();
  const el = q('hdmi-diag-row');
  if (el) el.hidden = true;
}

async function loadHdmi() {
  try {
    const r = await fetch(api('/api/hdmi'), { cache: 'no-store' });
    const d = await r.json();
    currentHdmiInputs = d.inputs;
    currentHdmiEarcPort = d.earcPort || null;
    const act = d.inputs.find(i => i.active);
    q('hdmi-cur').textContent = ': ' + (act ? act.label : t('metrics.hdmi.noInput', 'no active input'));
    renderHdmiGrid();
  } catch (e) {
    q('hdmi-grid').innerHTML = `<div class="sub">${esc(t('metrics.hdmi.failed', 'Could not read HDMI state \u2014 {error}', { error: e.message }))}</div>`;
  }
}

// Always on screen now, so it loads when the tab it sits on does.
let hdmiLoaded = false;
function loadHdmiOnce() {
  if (hdmiLoaded) return;
  hdmiLoaded = true;
  loadHdmi();
}

// The pid the TV's logs name a process by, muted beside its name.
function procPid(p) {
  return typeof p.pid === 'number' ? `<span class="p-pid">${p.pid}</span>` : '';
}

async function loadProcesses() {
  try {
    const r = await fetch(api('/api/processes'), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    q('proc-cur').textContent = t('metrics.processes.summary', '{count} running · {mb} MB resident',
      { count: d.count, mb: d.totalMb.toLocaleString() });
    q('proc-list').innerHTML = d.top.map(p =>
      `<div class="proc"><div class="p-name">${esc(p.name)}${procPid(p)}</div>` +
      `<div class="p-mb">${p.mb.toFixed(1)} MB</div></div>`).join('');
  } catch (e) {
    q('proc-list').innerHTML =
      `<div class="sub">${esc(t('metrics.processes.failed', 'Could not read the process list \u2014 {error}', { error: e.message }))}</div>`;
  }
}

let cpuTimer = null;
let cpuInFlight = false;

async function loadCpu() {
  // Each read holds the request open for the length of the sample, so a slow
  // one must not have a second stacked behind it.
  if (cpuInFlight) return;
  cpuInFlight = true;
  if (!q('cpu-list').firstChild) q('cpu-list').innerHTML = `<div class="sub">${esc(t('metrics.cpu.measuring', 'Measuring\u2026'))}</div>`;
  try {
    const r = await fetch(api('/api/cpu'), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    q('cpu-cur').textContent = t('metrics.cpu.summary', '{busy}% busy · {active} active', { busy: d.busy.toFixed(1), active: d.active });
    q('cpu-list').innerHTML = d.top.length
      ? d.top.map(p =>
          `<div class="proc"><div class="p-name">${esc(p.name)}${procPid(p)}</div>` +
          `<div class="p-mb">${p.pct.toFixed(1)}%</div></div>`).join('')
      : `<div class="sub">${esc(t('metrics.cpu.idle', 'Nothing used any CPU over the sample.'))}</div>`;
  } catch (e) {
    q('cpu-list').innerHTML =
      `<div class="sub">${esc(t('metrics.cpu.failed', 'Could not measure CPU usage \u2014 {error}', { error: e.message }))}</div>`;
  } finally {
    cpuInFlight = false;
  }
}

/*
 * Measured while the panel is open and not otherwise: every read costs the TV
 * two passes over /proc and holds a request open for the sample itself, which
 * is not worth spending on a panel nobody is looking at.
 */
function startCpuPolling() {
  if (cpuTimer) return;
  loadCpu();
  cpuTimer = setInterval(loadCpu, 3000);
}

function stopCpuPolling() {
  if (!cpuTimer) return;
  clearInterval(cpuTimer);
  cpuTimer = null;
}

function cpuPanelOpen() {
  const el = document.getElementById('disc-cpu');
  return !!(el && el.open);
}

(function wireCpuPanel() {
  const el = document.getElementById('disc-cpu');
  if (!el) return;
  el.addEventListener('toggle', function () {
    if (el.open) startCpuPolling(); else stopCpuPolling();
  });
  if (el.open) startCpuPolling();
})();

// Only poll while the panel is open; it costs a ps on the TV each time.
function onProcToggle(el) {
  /* Same as the HDMI panel: on open only. This one forks `ps`. */
  if (el.open) loadProcesses();
}

(function wireProcPanel() {
  const el = document.getElementById('disc-proc');
  if (el) el.addEventListener('toggle', function () { onProcToggle(el); });
})();
