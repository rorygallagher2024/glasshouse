// HDMI diagnostics, processes and CPU use.

function renderHdmiDiag(diag, colSpace) {
  const el = q('hdmi-diag-row');
  if (!el) return;
  const parts = [];
  if (diag) {
    if (diag.phy_mode) parts.push(esc(diag.phy_mode));
    if (diag.chroma) parts.push(esc(diag.chroma));
    if (diag.hdcp && diag.hdcp !== 'None') parts.push('HDCP ' + esc(diag.hdcp.replace(/^HDCP\s*/i, '')));
  }
  if (colSpace) parts.push(esc(colSpace));
  if (diag) {
    if (diag.allm) parts.push('ALLM');
    if (diag.vrr) parts.push('VRR');
    if (diag.qms) parts.push('QMS');
  }
  if (parts.length) {
    el.innerHTML = parts.join(' &middot; ');
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function loadHdmi() {
  try {
    const r = await fetch(api('/api/hdmi'), { cache: 'no-store' });
    const d = await r.json();
    const act = d.inputs.find(i => i.active);
    q('hdmi-cur').textContent = ': ' + (act ? act.label : t('metrics.hdmi.noInput', 'no active input'));
    q('hdmi-grid').innerHTML = d.inputs.map(i => {
      const s = i.signal;
      /* The resolution is the headline; the link figures sit under it. Both
         only exist for the port actually carrying signal - see hdmiInputs(),
         which refuses to guess a pairing it cannot prove. */
      const mode = s
        ? [s.resolution ? s.resolution.replace('x', '×') : null,
           s.refreshHz ? s.refreshHz + ' Hz' : null,
           s.interlaced ? t('metrics.hdmi.interlaced', 'interlaced') : null].filter(Boolean).join(' · ')
        : t('metrics.hdmi.noSignal', 'Device seen, no signal');
      const link = s
        ? [s.colorDepth, s.pixelClockMhz ? s.pixelClockMhz + ' MHz' : null]
            .filter(Boolean).join(' · ')
        : '';
      /* An empty port is just its number. Writing "HDMI 3 / Nothing connected"
         under a large 3 says the same thing three times, and leaves the one
         port that matters competing with three that do not. */
      if (!s && !i.deviceSeen) {
        return `<div class="port empty"><div class="ptop">` +
               `<span class="pn num">${i.port}</span></div></div>`;
      }
      const cls = i.active ? 'port live' : 'port seen';
      const state = i.active ? t('metrics.hdmi.active', 'Active') : t('metrics.hdmi.idle', 'Idle');
      return `<div class="${cls}">` +
             `<div class="ptop"><span class="pn num">${i.port}</span>` +
             `<span class="pst">${state}</span></div>` +
             `<div class="pl">${esc(i.label)}</div>` +
             `<div class="pd">${esc(mode)}${link ? ' · ' + esc(link) : ''}</div>` +
             `</div>`;
    }).join('');
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

async function loadProcesses() {
  try {
    const r = await fetch(api('/api/processes'), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    q('proc-cur').textContent = t('metrics.processes.summary', '{count} running · {mb} MB resident',
      { count: d.count, mb: d.totalMb.toLocaleString() });
    q('proc-list').innerHTML = d.top.map(p =>
      `<div class="proc"><div class="p-name">${esc(p.name)}</div>` +
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
          `<div class="proc"><div class="p-name">${esc(p.name)}</div>` +
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
