// Start-up: the opening tab, the column layout and the polling that drives the page.

/*
 * The restart drops this connection mid-flight, so failures here are expected
 * until the server is listening again. Give up after ~30s rather than spinning:
 * a config that stops the server booting needs the log, not another poll.
 */
async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(api('/api/caps'), { cache: 'no-store' });
      if (r.ok) {
        cfgMsg(t('mqtt.applied', 'Applied.'), 'good');
        q('cfg-save-btn').disabled = false;
        loadSettings();
        tick();
        return;
      }
    } catch (e) { /* still down */ }
  }
  cfgMsg(t('mqtt.notBack', 'Saved, but the server did not come back. Check the log on the TV.'), 'bad');
  q('cfg-save-btn').disabled = false;
}

/*
 * Which tab to open on. ?tab= names one; the older ?privacy=1 and ?controls=1
 * still work, since they are in bookmarks and in the screenshot tooling. Failing
 * both, the last tab this browser used.
 */
(function initTab() {
  const p = new URLSearchParams(location.search);
  let want = p.get('tab');
  if (!want && p.get('privacy') === '1') want = 'privacy';
  if (!want && p.get('apps') === '1') want = 'apps';
  if (!want && p.get('controls') === '1') want = 'control';
  // ?open= names a disclosure inside Metrics, so it has to pick that tab too -
  // otherwise the link opens something on a panel that is not showing.
  if (!want && p.get('open')) want = 'metrics';
  if (!want) { try { want = localStorage.getItem('tab'); } catch (e) { /* private window */ } }
  showTab(want || 'control');
  if (p.get('expand') === '1') document.querySelectorAll('.pv-d').forEach(d => d.open = true);
})();

const openSection = new URLSearchParams(location.search).get('open');
if ((openSection === 'metrics' || openSection === 'system') && q('disc-hwinfo')) q('disc-hwinfo').open = true;

if (openSection === 'processes' && q('disc-proc')) q('disc-proc').open = true;

/*
 * Fill the column containers. Runs when the number of columns changes and once
 * the first stats arrive - several groups are hidden until then, and measuring
 * before they appear puts everything in one column.
 *
 * Deliberately not run on expand: that is the whole point. A group stays where
 * the reader last saw it.
 */
function flowColumns(host, n) {
  if (!host) return;
  if (!host._items) host._items = Array.from(host.children);
  const items = host._items;
  while (host.firstChild) host.removeChild(host.firstChild);

  if (n < 2) {
    items.forEach(el => host.appendChild(el));
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'lcols';
  wrap.style.setProperty('--n', n);
  const cols = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'lcol';
    wrap.appendChild(c);
    cols.push(c);
  }
  host.appendChild(wrap);

  // Measure in one column, then give each group to whichever column is
  // shortest so far. Filling in document order left one column holding a
  // single group and stranded the last one at the foot of the page.
  items.forEach(el => cols[0].appendChild(el));
  const h = items.map(el => el.getBoundingClientRect().height);
  cols.forEach(c => { while (c.firstChild) c.removeChild(c.firstChild); });
  /*
   * data-col pins a group to a column, so related ones stay together however
   * tall they happen to be. It is ignored when there are fewer columns than
   * the number asks for, and anything unpinned goes to the shortest column.
   */
  const tally = new Array(n).fill(0);
  items.forEach((el, i) => {
    el.classList.remove('lhead');
    const pin = parseInt(el.getAttribute('data-col'), 10);
    let k;
    if (!isNaN(pin) && pin >= 0 && pin < n) {
      k = pin;
    } else {
      k = 0;
      for (let j = 1; j < n; j++) if (tally[j] < tally[k]) k = j;
    }
    cols[k].appendChild(el);
    tally[k] += h[i];
  });
  /*
   * Mark the top group of each column, rather than styling :first-child: the
   * column heading is in the list too and is display:none here, so the first
   * child is not always the first thing anyone can see.
   */
  cols.forEach(c => {
    const head = Array.prototype.find.call(c.children,
      el => el.getBoundingClientRect().height > 0);
    if (head) head.classList.add('lhead');
  });
}

/*
 * A hidden panel measures zero, which put every group in the first column, so
 * a host is only laid out while its tab is showing - and then only when the
 * column count has actually changed.
 */
function layoutHost(host, n, force) {
  if (!host || host.offsetParent === null) return;
  if (!force && host._cols === n) return;
  host._cols = n;
  flowColumns(host, n);
}

function relayout(force) {
  const w = window.innerWidth;
  layoutHost(document.querySelector('.col-controls'), w >= 820 ? 2 : 1, force);
  layoutHost(document.querySelector('.col-telemetry'), w >= 1280 ? 3 : (w >= 820 ? 2 : 1), force);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => relayout(false), 150);
});
relayout(true);

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(tick, 2000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    stopCpuPolling();
  } else {
    tick();
    startPolling();
    if (cpuPanelOpen()) startCpuPolling();
  }
});

tick();
startPolling();
loadUpdate();   // reads what the server already knows; it does not reach GitHub
