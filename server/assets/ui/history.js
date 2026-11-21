// Watch time: hours per app and input, from the server's history.

// The server keeps UTC hours; they are grouped into this browser's days.
const WATCH_DAYS_SHOWN = 14;
const WATCH_TOP = 5;
const SCREEN_OFF_KEY = 'screen_off';
const SCREEN_SAVER_KEY = 'screen_saver';
// The TV on with nothing watched: listed apart, and left out of the totals and bars.
const isIdleKey = k => k === SCREEN_OFF_KEY || k === SCREEN_SAVER_KEY;

function watchDuration(sec) {
  const m = Math.round(sec / 60), h = Math.floor(m / 60);
  return h ? t('metrics.uptime.hours', '{h}h {m}m', { h, m: m % 60 }) : t('metrics.uptime.mins', '{m}m', { m });
}

// The headline totals, which share a narrow column: hours to one decimal.
function watchTotal(sec) {
  return sec < 3600 ? watchDuration(sec) : t('metrics.watch.hours', '{h}h', { h: hrs(sec / 3600) });
}

function localDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Seconds per app for each local day, from { '2026-10-14T19': { app: s } }.
function watchByDay(hours) {
  const days = {};
  for (const h in hours) {
    const day = localDayKey(new Date(h + ':00:00Z'));
    const into = days[day] || (days[day] = {});
    for (const k in hours[h]) into[k] = (into[k] || 0) + hours[h][k];
  }
  return days;
}

function watchSum(days, fromDay, withIdle) {
  const out = {};
  for (const day in days) {
    if (day < fromDay) continue;
    for (const k in days[day]) {
      if (isIdleKey(k) && !withIdle) continue;
      out[k] = (out[k] || 0) + days[day][k];
    }
  }
  return out;
}

const total = byKey => Object.values(byKey).reduce((a, b) => a + b, 0);

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function watchName(key, titles) {
  if (key === SCREEN_OFF_KEY) return t('metrics.watch.screenOff', 'Screen off');
  if (key === SCREEN_SAVER_KEY) return t('metrics.watch.screenSaver', 'Screen saver');
  return titles[key] || key;
}

// Shown only while counting is on; the switch is on the Server tab.
function renderWatchTime(d) {
  const block = q('watchblock');
  if (q('metrics-sub-watch')) q('metrics-sub-watch').hidden = !d.enabled;
  if (!d.enabled && typeof metricsSubView !== 'undefined' && metricsSubView === 'watch' && typeof setMetricsSubView === 'function') {
    setMetricsSubView('overview');
  }
  block.hidden = !d.enabled;
  if (!d.enabled) return;

  const days = watchByDay(d.hours || {});
  const titles = d.titles || {};
  q('watch-today').textContent = watchTotal(total(watchSum(days, localDayKey(new Date()))));
  q('watch-week').textContent = watchTotal(total(watchSum(days, localDayKey(daysAgo(6)))));
  const month = watchSum(days, localDayKey(daysAgo(29)), true);
  q('watch-month').textContent = watchTotal(total(watchSum(days, localDayKey(daysAgo(29)))));

  // The most watched over 30 days get a shade each; the rest are Other.
  const ranked = Object.keys(month).filter(k => !isIdleKey(k)).sort((a, b) => month[b] - month[a]);
  const top = ranked.slice(0, WATCH_TOP);
  const shade = k => { const i = top.indexOf(k); return i === -1 ? WATCH_TOP : i; };

  const shown = [];
  for (let i = WATCH_DAYS_SHOWN - 1; i >= 0; i--) shown.push(daysAgo(i));
  const watchedOn = day => total(watchSum({ [day]: days[day] || {} }, day));
  const peak = Math.max(3600, ...shown.map(day => watchedOn(localDayKey(day))));
  q('watch-bars').innerHTML = shown.map(day => {
    const key = localDayKey(day), byKey = days[key] || {};
    const parts = Array(WATCH_TOP + 1).fill(0);
    for (const k in byKey) if (!isIdleKey(k)) parts[shade(k)] += byKey[k];
    const label = day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    const tip = t('metrics.watch.dayTip', '{day}: {time}', { day: label, time: watchDuration(watchedOn(key)) });
    return `<div class="wb" title="${esc(tip)}"><div class="wb-stack">` +
      parts.map((s, i) => s ? `<b class="ws${i}" style="height:${(s / peak * 100).toFixed(2)}%"></b>` : '').join('') +
      `</div><span class="wb-day">${esc(day.toLocaleDateString(undefined, { weekday: 'narrow' }))}</span></div>`;
  }).join('');

  const rows = top.map((k, i) => ({ name: watchName(k, titles), sec: month[k], cls: 'ws' + i }));
  const rest = ranked.slice(WATCH_TOP).reduce((a, k) => a + month[k], 0);
  if (rest) rows.push({ name: t('metrics.watch.other', 'Other'), sec: rest, cls: 'ws' + WATCH_TOP });
  if (month[SCREEN_OFF_KEY]) rows.push({ name: watchName(SCREEN_OFF_KEY, titles), sec: month[SCREEN_OFF_KEY], cls: 'ws-off' });
  if (month[SCREEN_SAVER_KEY]) rows.push({ name: watchName(SCREEN_SAVER_KEY, titles), sec: month[SCREEN_SAVER_KEY], cls: 'ws-saver' });
  q('watch-list').innerHTML = rows.length
    ? rows.map(r => `<div class="proc"><div class="p-name"><i class="w-sw ${r.cls}"></i>${esc(r.name)}</div>` +
        `<div class="p-mb">${esc(watchDuration(r.sec))}</div></div>`).join('')
    : `<div class="sub">${esc(t('metrics.watch.empty', 'Nothing counted yet. Time is counted while the screen is on.'))}</div>`;

  const note = q('watch-note');
  note.hidden = d.clockSet !== false;
  note.textContent = t('metrics.watch.clockUnset', 'The TV’s clock is not set yet, so the time since it started is added once it is.');
}

async function loadWatchTime() {
  try {
    const r = await fetch(api('/api/history?days=35'), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    renderWatchTime(d);
  } catch (e) {
    q('watch-list').innerHTML =
      `<div class="sub">${esc(t('metrics.watch.failed', 'Could not read watch time — {error}', { error: e.message }))}</div>`;
  }
}

/*
 * The numbers move while the tab is watched, as the other readings do: the
 * server counts the time in front up to the moment it is asked.
 */
const WATCH_REFRESH_MS = 30000;
let watchTimer = null;

function watchPolling(on) {
  clearInterval(watchTimer);
  watchTimer = null;
  if (!on || document.hidden) return;
  loadWatchTime();
  watchTimer = setInterval(loadWatchTime, WATCH_REFRESH_MS);
}

document.addEventListener('visibilitychange', () => watchPolling(activeTab === 'metrics'));
