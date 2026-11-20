// The Metrics tab's Performance view: the processor, memory, network and
// temperature over the last 5 minutes, hour or day, from the server's own
// history (lib/perfhistory.js), with the app in front marked on the timeline.

let perfRange = '5m';
try { perfRange = localStorage.getItem('perfRange') || '5m'; } catch (e) { /* private window */ }
if (['5m', '1h', '24h'].indexOf(perfRange) === -1) perfRange = '5m';
let perfTimer = null;
let perfInFlight = false;
let perfPolls = 0;
let perfLast = null;

const PERF_W = 1000, PERF_H = 200;

function perfOpen() {
  return !document.hidden && typeof activeTab !== 'undefined' && activeTab === 'metrics' &&
    typeof metricsSubView !== 'undefined' && metricsSubView === 'performance';
}

function perfViewChanged() {
  if (perfOpen()) {
    if (!perfTimer) {
      loadPerf();
      perfTimer = setInterval(loadPerf, perfRange === '24h' ? 60000 : 5000);
    }
  } else if (perfTimer) {
    clearInterval(perfTimer);
    perfTimer = null;
  }
}

document.addEventListener('visibilitychange', perfViewChanged);

function markPerfRange() {
  document.querySelectorAll('#perf-range [data-range]').forEach(b => {
    const on = b.getAttribute('data-range') === perfRange;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function setPerfRange(range) {
  perfRange = range;
  try { localStorage.setItem('perfRange', range); } catch (e) { /* private window */ }
  markPerfRange();
  if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
  perfViewChanged();
}

document.querySelectorAll('#perf-range [data-range]').forEach(b => {
  b.addEventListener('click', () => setPerfRange(b.getAttribute('data-range')));
});
/* Only the buttons at load: the dashboard's scripts are served as one, and
   activeTab (tabs.js) is not set until it runs. Showing the tab starts it. */
markPerfRange();

async function loadPerf() {
  if (perfInFlight) return;
  perfInFlight = true;
  try {
    const r = await fetch(api('/api/perf?range=' + perfRange), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    perfLast = d;
    renderPerf(d);
    // The process lists, less often: each read walks every process.
    if (perfPolls++ % 3 === 0 && typeof loadProcesses === 'function') loadProcesses();
  } catch (e) {
    q('perf-note').textContent = t('metrics.perf.failed', 'Could not read the history: {error}', { error: e.message });
  } finally {
    perfInFlight = false;
  }
}

// ---- Formatting -----------------------------------------------------------

function perfRate(bps) {
  if (bps == null) return '—';
  const k = bps / 1024;
  if (k < 1000) return t('metrics.perf.kbs', '{n} kB/s', { n: k < 10 ? k.toFixed(1) : Math.round(k) });
  return t('metrics.perf.mbs', '{n} MB/s', { n: (k / 1024).toFixed(1) });
}

function perfGb(kb) {
  return kb ? (kb / 1048576).toFixed(kb >= 10485760 ? 0 : 1) : '0';
}

function perfClock(ms, seconds) {
  const o = { hour: '2-digit', minute: '2-digit' };
  if (seconds) o.second = '2-digit';
  return new Date(ms).toLocaleTimeString([], o);
}

function perfDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return t('metrics.perf.minutes', '{n} min', { n: Math.max(1, m) });
  const h = Math.floor(m / 60), r = m % 60;
  return r ? t('metrics.perf.hoursMinutes', '{h} h {m} min', { h, m: r }) : t('metrics.perf.hours', '{h} h', { h });
}

// A round number at or above v, for an axis top: 1, 2 or 5 times a power of ten.
function perfNiceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function perfStats(values) {
  const v = values.filter(x => typeof x === 'number');
  if (!v.length) return null;
  let sum = 0, max = -Infinity, min = Infinity;
  v.forEach(x => { sum += x; if (x > max) max = x; if (x < min) min = x; });
  return { avg: sum / v.length, max, min, last: v[v.length - 1] };
}

// ---- Drawing --------------------------------------------------------------

/*
 * Runs of samples with no gap: a sample missing, or more than two and a half
 * steps after the last (the server was restarted), breaks the line rather
 * than drawing a slope across the time nothing was measured.
 */
function perfRuns(ts, ok, step) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < ts.length; i++) {
    if (!ok(i)) { cur = null; continue; }
    if (cur && ts[i] - ts[cur[cur.length - 1]] > step * 2.5) cur = null;
    if (!cur) { cur = []; runs.push(cur); }
    cur.push(i);
  }
  return runs;
}

/*
 * The spans the TV or its screen was off, from the events, as fractions of
 * the range, for shading.
 */
function perfOffSpans(d) {
  const spans = [];
  const list = (d.before ? [d.before] : []).concat(d.events || []);
  let offAt = null, kind = null;
  list.forEach(e => {
    const off = e.kind === 'off' || e.kind === 'screenOff';
    if (off && offAt === null) { offAt = Math.max(d.from, e.t); kind = e.kind; }
    else if (!off && offAt !== null) { spans.push({ a: offAt, b: e.t, kind }); offAt = null; }
  });
  if (offAt !== null) spans.push({ a: offAt, b: d.now, kind });
  return spans.filter(s => s.b > d.from);
}

/*
 * One chart: stacked areas from the baseline ('stack'), a line with a light
 * wash under it ('line'), or two series either side of a middle line
 * ('mirror', for download and upload). One axis, always: a measure of
 * another scale gets a chart of its own.
 */
function perfChart(el, d, o) {
  if (!el) return;
  const ts = d.samples.t, from = d.from, to = d.now, span = Math.max(1, to - from);
  const x = tm => ((tm - from) / span) * PERF_W;
  const lo = o.min || 0, hi = o.max;
  const y = v => PERF_H - ((v - lo) / (hi - lo)) * PERF_H;
  const mid = PERF_H / 2;
  const ym = (v, up) => up ? mid - (v / hi) * mid : mid + (v / hi) * mid;
  let svg = '';

  // The TV off: hatched, so a flat line there is not read as an idle TV.
  const hatch = 'perf-hatch-' + el.id;
  svg += `<defs><pattern id="${hatch}" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line class="perf-hatch" x1="0" y1="0" x2="0" y2="10"/></pattern></defs>`;
  perfOffSpans(d).forEach(s => {
    const a = x(Math.max(from, s.a)), b = x(Math.min(to, s.b));
    if (b - a > 0.5) svg += `<rect class="perf-off${s.kind === 'screenOff' ? ' screen' : ''}" fill="url(#${hatch})" x="${a.toFixed(1)}" y="0" width="${(b - a).toFixed(1)}" height="${PERF_H}"/>`;
  });

  // Recessive grid: the middle and the top.
  svg += `<line class="perf-grid-line" x1="0" x2="${PERF_W}" y1="${mid}" y2="${mid}"/>`;
  svg += `<line class="perf-grid-line" x1="0" x2="${PERF_W}" y1="0.5" y2="0.5"/>`;

  if (o.mode === 'stack') {
    const base = ts.map(() => 0);
    o.series.forEach(s => {
      const vals = d.samples[s.key];
      const runs = perfRuns(ts, i => typeof vals[i] === 'number', d.step);
      runs.forEach(run => {
        if (run.length < 2) return;
        const top = run.map(i => [x(ts[i]), y(Math.min(hi, base[i] + vals[i]))]);
        const bot = run.map(i => [x(ts[i]), y(Math.min(hi, base[i]))]).reverse();
        svg += `<path class="perf-area ${s.cls}" d="M${top.concat(bot).map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L')}Z"/>`;
        if (!s.quiet) svg += `<path class="perf-line ${s.cls}" d="M${top.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L')}"/>`;
      });
      ts.forEach((_, i) => { if (typeof vals[i] === 'number') base[i] += vals[i]; });
    });
  } else if (o.mode === 'mirror') {
    o.series.forEach((s, si) => {
      const vals = d.samples[s.key], up = si === 0;
      perfRuns(ts, i => typeof vals[i] === 'number', d.step).forEach(run => {
        if (run.length < 2) return;
        const pts = run.map(i => [x(ts[i]), ym(Math.min(hi, vals[i]), up)]);
        const line = pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
        svg += `<path class="perf-area ${s.cls}" d="M${pts[0][0].toFixed(1)} ${mid}L${line}L${pts[pts.length - 1][0].toFixed(1)} ${mid}Z"/>`;
        svg += `<path class="perf-line ${s.cls}" d="M${line}"/>`;
      });
    });
  } else {
    const s = o.series[0], vals = d.samples[s.key];
    perfRuns(ts, i => typeof vals[i] === 'number', d.step).forEach(run => {
      if (run.length < 2) return;
      const pts = run.map(i => [x(ts[i]), y(Math.max(lo, Math.min(hi, vals[i])))]);
      const line = pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
      svg += `<path class="perf-area wash ${s.cls}" d="M${pts[0][0].toFixed(1)} ${PERF_H}L${line}L${pts[pts.length - 1][0].toFixed(1)} ${PERF_H}Z"/>`;
      svg += `<path class="perf-line ${s.cls}" d="M${line}"/>`;
    });
  }

  // The app in front changing, as faint rules down the chart.
  (o.marks || []).forEach(m => {
    const mx = x(m.t);
    if (mx > 0 && mx < PERF_W) svg += `<line class="perf-mark" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="0" y2="${PERF_H}"/>`;
  });

  const secs = perfRange === '5m';
  const yTop = o.fmt(hi);
  const yBot = o.mode === 'mirror' ? o.fmt(hi) : o.fmt(lo);
  el.innerHTML =
    `<svg viewBox="0 0 ${PERF_W} ${PERF_H}" preserveAspectRatio="none" role="img" aria-label="${esc(o.label)}">${svg}</svg>` +
    `<span class="perf-y top num">${o.mode === 'mirror' ? '↓ ' : ''}${esc(yTop)}</span>` +
    `<span class="perf-y bot num">${o.mode === 'mirror' ? '↑ ' : ''}${esc(yBot)}</span>` +
    `<span class="perf-x left num">${esc(perfClock(from, secs))}</span>` +
    `<span class="perf-x right">${esc(t('metrics.perf.now', 'Now'))}</span>` +
    `<div class="perf-cross" hidden></div><div class="perf-tip" hidden></div>`;
  perfHover(el, d, o);
}

// The crosshair and its reading, for the sample nearest the pointer.
function perfHover(el, d, o) {
  const cross = el.querySelector('.perf-cross'), tip = el.querySelector('.perf-tip');
  const ts = d.samples.t;
  const at = e => {
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const tm = d.from + f * (d.now - d.from);
    let best = -1, bd = Infinity;
    for (let i = 0; i < ts.length; i++) {
      const dd = Math.abs(ts[i] - tm);
      if (dd < bd) { bd = dd; best = i; }
    }
    return bd <= d.step * 2 ? best : -1;
  };
  el.onpointermove = e => {
    const i = at(e);
    if (i < 0) { cross.hidden = true; tip.hidden = true; return; }
    const f = (ts[i] - d.from) / (d.now - d.from);
    cross.style.left = (f * 100) + '%';
    const rows = o.series.map(s => {
      const v = d.samples[s.key][i];
      return `<div><i class="perf-sw ${s.cls}"></i>${esc(s.label)}<b class="num">${typeof v === 'number' ? esc(o.fmt(v)) : '—'}</b></div>`;
    }).join('');
    const app = perfAppAt(d, ts[i]);
    tip.innerHTML = `<div class="perf-tip-t num">${esc(perfClock(ts[i], perfRange !== '24h'))}${app ? ' · <span translate="no">' + esc(app) + '</span>' : ''}</div>${rows}`;
    tip.style.left = f > 0.6 ? '' : 'calc(' + (f * 100) + '% + 12px)';
    tip.style.right = f > 0.6 ? 'calc(' + ((1 - f) * 100) + '% + 12px)' : '';
    cross.hidden = false;
    tip.hidden = false;
  };
  el.onpointerleave = () => { cross.hidden = true; tip.hidden = true; };
}

function perfEventName(e) {
  if (e.kind === 'off') return t('metrics.perf.tvOff', 'TV off');
  if (e.kind === 'screenOff') return t('metrics.perf.screenOff', 'Screen off');
  if (e.kind === 'on') return t('metrics.perf.tvOn', 'TV on');
  return e.title || e.key || '';
}

// What was in front at a moment, from the events.
function perfAppAt(d, tm) {
  let cur = d.before;
  (d.events || []).forEach(e => { if (e.t <= tm) cur = e; });
  return cur ? perfEventName(cur) : '';
}

// The changes of app along the processor chart, labelled where there is room.
function perfEventsStrip(d) {
  const el = q('perf-events');
  if (!el) return [];
  const span = Math.max(1, d.now - d.from);
  const marks = (d.events || []).filter(e => e.kind === 'app' || e.kind === 'off' || e.kind === 'on' || e.kind === 'screenOff');
  const width = el.getBoundingClientRect().width || 600;
  let lastPx = -Infinity;
  el.innerHTML = marks.map(e => {
    const f = (e.t - d.from) / span;
    const px = f * width;
    const room = px - lastPx > 130 && px < width - 30;
    if (room) lastPx = px;
    const name = perfEventName(e);
    return `<span class="perf-ev${room ? '' : ' tick'}${e.kind !== 'app' ? ' power' : ''}" style="left:${(f * 100).toFixed(2)}%" title="${esc(perfClock(e.t, false) + ' · ' + name)}">` +
      (room ? `<span translate="no">${esc(name)}</span>` : '') + `</span>`;
  }).join('');
  el.hidden = !marks.length;
  return marks;
}

function perfLegend(id, series, d, fmt) {
  const el = q(id);
  if (!el) return;
  el.innerHTML = series.map(s => {
    const st = perfStats(d.samples[s.key]);
    return `<span class="perf-leg"><i class="perf-sw ${s.cls}"></i>${esc(s.label)}<b class="num">${st ? esc(fmt(st.last)) : '—'}</b></span>`;
  }).join('');
}

function perfCores(d) {
  const el = q('perf-cores');
  if (!el) return;
  const cores = d.cores || [];
  const online = cores.filter(v => typeof v === 'number').length;
  el.innerHTML = cores.map((v, i) => {
    const parked = typeof v !== 'number';
    const label = parked ? t('metrics.perf.parked', 'Parked') : v + '%';
    return `<div class="perf-core${parked ? ' parked' : ''}" title="${esc(t('metrics.perf.core', 'Core {n}', { n: i + 1 }) + ': ' + label)}">` +
      `<div class="perf-core-bar"><b style="height:${parked ? 0 : Math.max(2, v)}%"></b></div>` +
      `<span class="perf-core-n num">${i + 1}</span></div>`;
  }).join('');
  el.setAttribute('aria-label', cores.map((v, i) =>
    t('metrics.perf.core', 'Core {n}', { n: i + 1 }) + ' ' + (typeof v === 'number' ? v + '%' : t('metrics.perf.parked', 'Parked'))).join(', '));
  return { online, total: cores.length };
}

function renderPerf(d) {
  const n = d.samples.t.length;
  const sinceMs = d.now - d.since;
  const note = q('perf-note');
  if (n < 2) {
    note.textContent = t('metrics.perf.gathering', 'Gathering readings. The charts fill in as Glasshouse takes one every 5 seconds.');
  } else if (d.since > d.from + d.step * 2) {
    note.textContent = t('metrics.perf.since', 'Glasshouse started {ago} ago, so the charts begin there.', { ago: perfDuration(sinceMs) });
  } else {
    note.textContent = '';
  }
  // Off for the whole range: said, as the charts are flat for that reason.
  const off = perfOffSpans(d);
  if (n >= 2 && off.length === 1 && off[0].a <= d.from + d.step && off[0].b >= d.now) {
    note.textContent = off[0].kind === 'screenOff'
      ? t('metrics.perf.allScreenOff', 'The screen was off for all of this range.')
      : t('metrics.perf.allOff', 'The TV was in standby for all of this range.');
  }

  const marks = perfEventsStrip(d).filter(e => e.kind === 'app');
  const pct = v => Math.round(v) + '%';

  // Processor.
  const cpuSeries = [
    { key: 'user', cls: 'sa', label: t('metrics.perf.user', 'Apps') },
    { key: 'sys', cls: 'sb', label: t('metrics.perf.system', 'System') },
    { key: 'io', cls: 'sn', label: t('metrics.perf.io', 'Waiting on storage'), quiet: true }
  ];
  const cpu = perfStats(d.samples.cpu);
  q('perf-cpu-now').textContent = cpu ? Math.round(cpu.last) : '—';
  const cores = perfCores(d) || { online: 0, total: 0 };
  const mhz = perfStats(d.samples.mhz);
  q('perf-cpu-sub').textContent = [
    cpu ? t('metrics.perf.avgPeak', 'Average {avg} · peak {peak}', { avg: pct(cpu.avg), peak: pct(cpu.max) }) : null,
    cores.total ? t('metrics.perf.coresOnline', '{online} of {total} cores online', cores) : null,
    mhz ? mhz.last + ' MHz' : null
  ].filter(Boolean).join('  ·  ');
  perfLegend('perf-cpu-legend', cpuSeries, d, pct);
  perfChart(q('perf-cpu-chart'), d, {
    mode: 'stack', max: 100, series: cpuSeries, fmt: pct, marks,
    label: t('metrics.perf.cpuLabel', 'Processor use over the range: average {avg}, peak {peak}',
      { avg: cpu ? pct(cpu.avg) : '—', peak: cpu ? pct(cpu.max) : '—' })
  });

  // Memory.
  const total = d.memTotal || 0;
  const memSeries = [
    { key: 'mem', cls: 'sa', label: t('metrics.perf.inUse', 'In use') },
    { key: 'cache', cls: 'sn', label: t('metrics.perf.cache', 'Cache'), quiet: true }
  ];
  const mem = perfStats(d.samples.mem), cache = perfStats(d.samples.cache);
  const gb = v => perfGb(v) + ' GB';
  q('perf-mem-now').textContent = mem && total ? Math.round(100 * mem.last / total) : '—';
  q('perf-mem-sub').textContent = mem && total
    ? t('metrics.perf.memOf', '{used} of {total} GB in use', { used: perfGb(mem.last), total: perfGb(total) }) +
      (cache ? '  ·  ' + t('metrics.perf.cacheOf', '{cache} GB cache', { cache: perfGb(cache.last) }) : '')
    : '';
  perfLegend('perf-mem-legend', memSeries, d, gb);
  perfChart(q('perf-mem-chart'), d, {
    mode: 'stack', max: total || 1, series: memSeries, fmt: gb, marks,
    label: t('metrics.perf.memLabel', 'Memory in use over the range: peak {peak}', { peak: mem ? gb(mem.max) : '—' })
  });

  // Network.
  const netSeries = [
    { key: 'rx', cls: 'sa', label: t('metrics.perf.down', 'Download') },
    { key: 'tx', cls: 'sb', label: t('metrics.perf.up', 'Upload') }
  ];
  const rx = perfStats(d.samples.rx), tx = perfStats(d.samples.tx);
  q('perf-net-now').innerHTML = rx ? '↓ ' + esc(perfRate(rx.last)) : '&mdash;';
  q('perf-net-sub').textContent = [
    tx ? '↑ ' + perfRate(tx.last) : null,
    rx ? t('metrics.perf.peakDown', 'Peak {rate} down', { rate: perfRate(rx.max) }) : null
  ].filter(Boolean).join('  ·  ');
  perfLegend('perf-net-legend', netSeries, d, perfRate);
  perfChart(q('perf-net-chart'), d, {
    mode: 'mirror', max: perfNiceMax(Math.max(65536, rx ? rx.max : 0, tx ? tx.max : 0)), series: netSeries, fmt: perfRate, marks,
    label: t('metrics.perf.netLabel', 'Network over the range: peak {down} down, {up} up',
      { down: rx ? perfRate(rx.max) : '—', up: tx ? perfRate(tx.max) : '—' })
  });

  // Temperature, where the TV has a sensor.
  const temp = perfStats(d.samples.temp);
  q('perf-temp').hidden = !temp;
  if (temp) {
    const deg = v => Math.round(v) + '°';
    q('perf-temp-now').textContent = Math.round(temp.last);
    q('perf-temp-sub').textContent = t('metrics.perf.minMax', 'Min {min} · max {max}', { min: deg(temp.min), max: deg(temp.max) });
    const lo = Math.max(0, Math.floor((temp.min - 5) / 5) * 5), hi = Math.ceil((temp.max + 5) / 5) * 5;
    perfChart(q('perf-temp-chart'), d, {
      mode: 'line', min: lo, max: hi, fmt: deg, marks,
      series: [{ key: 'temp', cls: 'st', label: t('metrics.temperature', 'Temperature') }],
      label: t('metrics.perf.tempLabel', 'Temperature over the range: {min} to {max}', { min: deg(temp.min), max: deg(temp.max) })
    });
  }
}

// The event labels are placed by width: placed again when it changes.
window.addEventListener('resize', () => { if (perfLast && perfOpen()) perfEventsStrip(perfLast); });
