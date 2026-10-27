// The release check, in-place upgrade and rollback, and the app on the TV's home screen.

// Releases are cut on the upstream repo, so the tag link points there.
const REPO = 'https://github.com/rorygallagher2024/glasshouse';

// A git build's version carries its commit as build metadata, 0.80.1+55e51e5 or
// 0.80.1+55e51e5.dirty; releases and the updater know only the part before it.
const bareVersion = v => String(v || '').split('+')[0];

function setVersion(v) {
  const el = q('version');
  if (!v || el.dataset.v === v) return;   // static between restarts, so set it once
  const had = el.dataset.v;
  el.dataset.v = v;
  el.textContent = 'v' + v;
  // A git build's version may have no release yet, so it links to its commit.
  const commit = v.split('+')[1];
  el.href = commit ? REPO + '/commit/' + commit.split('.')[0] : REPO + '/releases/tag/v' + v;
  el.hidden = false;
  // It came back on a different version, so an upgrade landed: the "newer
  // version" hint beside this is now about the one that is running.
  if (had) loadUpdate();
}

// ---- release check and in-place upgrade ----
let updBusy = false;
// While an install or rollback has the server restarting: tick() should not dim
// the page or report the TV unreachable for an absence it was told to expect.
let updRestarting = false;
let updInstalled = null;
let updViaHomebrewChannel = false;
// What the last install or rollback came to, kept across re-renders until the next action.
let updArrival = '';

function renderUpdate(d) {
  const pill = q('upd-pill'), desc = q('upd-desc'), msg = q('upd-msg');
  const inst = q('upd-install'), roll = q('upd-rollback'), chk = q('upd-check');
  updInstalled = d.installed;
  updViaHomebrewChannel = !!d.viaHomebrewChannel;
  q('upd-title').textContent = t('server.version', 'Version {version}', { version: d.installed });

  const working = d.state === 'checking' || d.state === 'downloading' || d.state === 'installing';
  pill.className = 'pill ' + (d.state === 'error' ? 'bad'
    : d.available ? 'warn' : d.state === 'current' ? 'good' : 'idle');
  pill.textContent = d.state === 'error' ? t('server.state.failed', 'failed')
    : d.state === 'offline' ? t('server.state.offline', 'offline')
    : d.state === 'checking' ? t('server.state.checking', 'checking')
    : d.state === 'downloading' ? t('server.state.downloading', 'downloading')
    : d.state === 'installing' ? t('server.state.installing', 'installing')
    : d.available ? 'v' + d.latest
    : d.state === 'current' ? t('server.state.current', 'up to date')
    : d.state === 'installed' ? t('server.state.restarting', 'restarting')
    : t('server.state.unchecked', 'not checked');

  desc.textContent = !d.available ? ''
    : t('server.available', 'v{version} is out. Installing it replaces the server and restarts it.', { version: d.latest });
  desc.hidden = !d.available;
  renderWhatsNew(d);
  if (d.daemon !== undefined) {
    renderServerHealth(d.daemon);
  }

  updateToggle('upd-auto', {
    cls: d.autoCheck ? 'good' : 'idle',
    label: d.autoCheck ? t('common.on', 'On') : t('common.off', 'Off'),
    on: d.autoCheck,
    disabled: !d.writable
  });

  // Answers from actions that predate the setting leave it as it was.
  if (typeof d.tvUpdatesBlocked === 'boolean') {
    updateToggle('upd-tvblock', {
      cls: d.tvUpdatesBlocked ? 'good' : 'idle',
      label: d.tvUpdatesBlocked ? t('server.tvUpdates.blocked', 'Blocked') : t('server.tvUpdates.allowed', 'Allowed'),
      on: d.tvUpdatesBlocked,
      disabled: !d.writable
    });
  }

  // null until the server's first attempt ends; absent from older servers.
  const dt = q('srv-devtools');
  if (dt && d.devtools !== undefined) {
    const isOff = (d.devtools === 'off');
    // A TV with no firewall cannot close the port: no switch, and a line saying why.
    const noFirewall = (d.devtools === 'unsupported');
    dt.hidden = noFirewall;
    const note = q('srv-devtools-nofw');
    if (note) note.hidden = !noFirewall;
    const isOpen = (d.devtools === 'open' || d.devtools === 'allowed');
    updateToggle('srv-devtools', {
      cls: isOff ? 'idle' : isOpen ? (d.devtools === 'open' ? 'bad' : 'warn') : 'good',
      label: isOff ? t('server.devtools.off', 'Not running')
        : isOpen ? t('server.devtools.open', 'Open to the network')
        : t('server.devtools.closed', 'Closed to the network'),
      on: isOpen,
      disabled: !d.writable || isOff
    });
  }

  if (typeof d.allowTileHiding === 'boolean') {
    updateToggle('exp-tilehiding', {
      cls: d.allowTileHiding ? 'good' : 'idle',
      label: d.allowTileHiding ? t('common.on', 'On') : t('common.off', 'Off'),
      on: d.allowTileHiding,
      disabled: !d.writable
    });
  }

  if (typeof d.prometheusEnabled === 'boolean') {
    updateToggle('srv-prometheus', {
      cls: d.prometheusEnabled ? 'good' : 'idle',
      label: d.prometheusEnabled ? t('common.on', 'On') : t('common.off', 'Off'),
      on: d.prometheusEnabled,
      disabled: !d.writable
    });
  }
  if (d.watchHistory) {
    updateToggle('srv-watch', {
      cls: d.watchHistory.enabled ? 'good' : 'idle',
      label: d.watchHistory.enabled ? t('common.on', 'On') : t('common.off', 'Off'),
      on: d.watchHistory.enabled,
      disabled: !d.writable
    });
    const clear = q('srv-watch-clear');
    clear.hidden = !d.watchHistory.kept;
    clear.disabled = !d.writable;
  }
  if (d.ntpSettings) {
    renderNtp(d.ntp, d.ntpSettings, d.writable);
  }
  const portInput = q('port-input');
  if (portInput && d.daemon) {
    portInput.disabled = !d.writable;
    q('port-save').disabled = !d.writable;
    if (document.activeElement !== portInput && !portInput.dataset.dirty) portInput.value = d.daemon.port;
  }
  if (d.backupDaily) renderBackupDaily(d.backupDaily, d.writable);

  const hlRow = q('exp-homelayout-row');
  if (hlRow) {
    hlRow.hidden = !d.homeLayout;
    if (d.homeLayout) {
      updateToggle('exp-homelayout', {
        cls: d.homeLayout.allowed ? 'good' : 'idle',
        label: d.homeLayout.allowed ? t('common.on', 'On') : t('common.off', 'Off'),
        on: d.homeLayout.allowed,
        disabled: !d.writable
      });
    }
  }

  const ssRow = q('exp-screensaver-row');
  if (ssRow) {
    ssRow.hidden = !d.isWebos10;
    if (typeof d.allowExperimentalScreensavers === 'boolean') {
      updateToggle('exp-screensaver', {
        cls: d.allowExperimentalScreensavers ? 'good' : 'idle',
        label: d.allowExperimentalScreensavers ? t('common.on', 'On') : t('common.off', 'Off'),
        on: d.allowExperimentalScreensavers,
        disabled: !d.writable
      });
    }
  }

  msg.textContent = (d.state === 'error' || d.state === 'offline') ? (d.error || t('server.checkFailed', 'the check failed'))
    : d.state === 'installed' ? t('server.installed', 'Installed. The server is restarting - this page reconnects on its own.')
    : updArrival;

  chk.hidden = !d.writable;
  chk.disabled = working || updBusy;
  inst.hidden = !(d.available && d.writable);
  inst.disabled = working || updBusy;
  inst.textContent = t('server.install', 'Install v{version}', { version: d.latest });
  inst.dataset.v = d.latest || '';
  roll.hidden = !(d.rollbackTo && d.writable);
  roll.disabled = working || updBusy;
  roll.textContent = t('server.rollback', 'Roll back to v{version}', { version: d.rollbackTo });
  roll.dataset.v = d.rollbackTo || '';
  if (q('upd-prog').hidden) q('upd-btns').hidden = chk.hidden && inst.hidden;

  const vn = q('version-new');
  if (d.available) {
    vn.textContent = '\u2192 v' + d.latest;
    vn.href = REPO + '/releases/tag/v' + d.latest;
    vn.hidden = false;
  } else {
    vn.hidden = true;
  }
}

// What each release since the installed one brings: the summary at the top of
// its notes. Older releases have none, and are counted instead.
function renderWhatsNew(d) {
  const box = q('upd-new');
  if (!box) return;
  const list = (d.available && d.whatsNew) || [];
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  const more = d.whatsNewMore || 0;
  box.innerHTML = `<div class="upd-new-h">${esc(t('server.whatsNew', 'What\u2019s new'))}</div>` +
    list.map(r => `<div class="upd-new-r">
      <p><span class="upd-new-v">v${esc(r.version)}</span>${esc(r.summary)}</p>
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(t('server.fullNotes', 'Full release notes'))}</a>` : ''}
    </div>`).join('') +
    (more ? `<div class="upd-new-r"><a href="${esc(REPO + '/releases')}" target="_blank" rel="noopener">${esc(more === 1
      ? t('server.whatsNew.moreOne', 'And 1 more release')
      : t('server.whatsNew.more', 'And {n} more releases', { n: more }))}</a></div>` : '');
}

function renderServerHealth(dm) {
  const row = q('server-health-row');
  if (!row) return;
  if (!dm) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const bMem = q('server-badge-mem');
  const bUp = q('server-badge-uptime');

  if (bMem) {
    if (dm.rss) {
      const rssMb = Math.round(dm.rss / 1048576);
      bMem.textContent = t('server.health.memBadge', '{n} MB RAM', { n: rssMb });
      bMem.title = t('server.health.memTooltip', 'Memory (RSS)');
      bMem.hidden = false;
    } else {
      bMem.hidden = true;
    }
  }

  if (bUp) {
    if (dm.uptime != null) {
      const s = dm.uptime;
      const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
      const upStr = dd ? t('metrics.uptime.days', '{d}d {h}h {m}m', { d: dd, h: hh, m: mm })
        : (hh ? t('metrics.uptime.hours', '{h}h {m}m', { h: hh, m: mm })
        : t('server.health.uptimeMins', '{m}m', { m: mm || 1 }));
      bUp.textContent = t('server.health.up', 'Up {time}', { time: upStr });
      bUp.title = t('server.health.uptimeTooltip', 'Process uptime');
      bUp.hidden = false;
    } else {
      bUp.hidden = true;
    }
  }
}

async function loadUpdate() {
  try {
    const d = await (await fetch(api('/api/update'), { cache: 'no-store' })).json();
    if (d && d.ok) {
      renderUpdate(d);
      noteArrival(d);
      offerUpdatePopup(d);
    }
  } catch (e) { /* the footer hint is not worth an error banner */ }
}

// A page that ran an install or rollback reloads into the new version with
// ?updated= or ?rolledback=. Said once, then dropped from the address.
function noteArrival(d) {
  const p = new URLSearchParams(location.search);
  const up = p.get('updated'), back = p.get('rolledback');
  if (!up && !back) return;
  p.delete('updated');
  p.delete('rolledback');
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
  if (bareVersion(d.installed) === (up || back)) {
    updArrival = up ? t('server.arrived.updated', 'Updated to v{version}.', { version: up })
      : t('server.arrived.rolledBack', 'Rolled back to v{version}.', { version: back });
    q('upd-msg').textContent = updArrival;
  }
}

/*
 * The server says when it is downloading and installing, but nothing says how
 * long its restart will take - seconds usually, up to two minutes when the
 * watchdog has to step in - so the bar moves on time within each step and only
 * fills once the server answers on the version it was asked for.
 */
function makeProgress(boxId, stepId, barId, onShow, onSet) {
  return {
    timer: null,
    pct: 0,
    show(on) {
      clearInterval(this.timer);
      q(boxId).classList.remove('done');
      q(boxId).hidden = !on;
      if (onShow) onShow(on);
      this.set(0);
    },
    // Eases towards `to` without reaching it: 63% of the way there after `ms`.
    step(label, to, ms) {
      clearInterval(this.timer);
      q(stepId).textContent = label;
      const from = this.pct, t0 = Date.now();
      this.timer = setInterval(() => this.set(from + (to - from) * (1 - Math.exp(-(Date.now() - t0) / ms))), 250);
    },
    set(p) {
      this.pct = p;
      q(barId).style.width = p + '%';
      if (onSet) onSet(p);
    },
    done(label) {
      clearInterval(this.timer);
      q(stepId).textContent = label;
      q(boxId).classList.add('done');
      this.set(100);
    }
  };
}

const updProg = makeProgress('upd-prog', 'upd-step', 'upd-bar', on => { q('upd-btns').hidden = on; });

// With a deadline: a wedged server still accepts connections, and a request to
// it would otherwise wait out the browser's own timeout.
async function fetchJson(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, Object.assign({ cache: 'no-store', signal: ctl.signal }, opts));
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const updControl = (action, value) => fetchJson(api('/api/control'), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, value })
}, 120000);

/*
 * Waits for the server to answer on `version`, then reloads - this page belongs
 * to the version that was replaced. `confirmed` is false when the request itself
 * never came back; then the server answering on its old version, with nothing in
 * progress, means the change did not happen. `prog` and `msgEl` are the bar and
 * the message of whatever started it: the Server tab, or the update pop-up.
 */
async function awaitRestart(version, doneLabel, param, confirmed, oldVersion, prog = updProg, msgEl = q('upd-msg')) {
  updRestarting = true;
  // The work is done by now; what is left is waiting.
  prog.set(Math.max(prog.pct, 60));
  prog.step(t('server.step.restarting', 'Restarting the server'), 95, 20000);
  const t0 = Date.now();
  for (;;) {
    await new Promise(res => setTimeout(res, 1500));
    const d = await fetchJson(api('/api/update'), {}, 3000);
    if (d && bareVersion(d.installed) === version) break;
    if (d && !confirmed && d.installed === oldVersion && !/checking|downloading|installing/.test(d.state)) {
      updRestarting = false;
      updBusy = false;
      prog.show(false);
      renderUpdate(d);
      msgEl.textContent = t('server.notFinished', 'That did not finish. The TV is still on v{version}.', { version: oldVersion });
      return;
    }
    const waited = Date.now() - t0;
    msgEl.textContent = waited > 240000 ? t('server.notBack', 'The server has not come back. See Updating in the README to roll back.')
      : waited > 30000 ? t('server.slow', 'Taking longer than usual - it can take up to two minutes.')
      : '';
  }
  msgEl.textContent = '';
  prog.done(doneLabel);
  const u = new URL(location.href);
  u.searchParams.set('tab', 'server');
  u.searchParams.set(param, version);
  setTimeout(() => location.replace(String(u)), 1200);
}

/*
 * Opening the tab is the check. What is already known shows at once, and an
 * attempt under two minutes old stands - answered or not - so switching back and
 * forth between tabs does not reach GitHub, or retry an offline TV, each time.
 * Check now is the way to look again sooner.
 */
async function checkOnOpen() {
  const d = await fetchJson(api('/api/update'), {}, 5000);
  if (!d || !d.ok) return;
  renderUpdate(d);
  noteArrival(d);
  if (updBusy || !d.writable || (d.attemptedMs !== null && d.attemptedMs < 120000)) return;
  q('upd-pill').className = 'pill idle';
  q('upd-pill').textContent = t('server.state.checking', 'checking');
  const r = await updControl('updateCheck', 'open');
  if (r && r.ok && r.state !== 'checking') return renderUpdate(r);
  // Failed, or a check someone else started is still running.
  setTimeout(loadUpdate, r && r.state === 'checking' ? 2000 : 0);
}

async function checkNow() {
  updBusy = true;
  updArrival = '';
  q('upd-pill').className = 'pill idle';
  q('upd-pill').textContent = t('server.state.checking', 'checking');
  const btn = q('upd-check');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const r = await updControl('updateCheck');
    updBusy = false;
    if (r && r.ok && r.state !== 'checking') renderUpdate(r); else loadUpdate();
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

function installUpdate() {
  const v = q('upd-install').dataset.v;
  const prompt = updViaHomebrewChannel
    ? t('server.install.confirm.package', 'Install v{version}?\n\nThe Glasshouse app closes while its package is replaced, then the server restarts. No rollback copy is kept.', { version: v })
    : t('server.install.confirm', 'Install v{version}?\n\nThe server is replaced and restarted, and the previous version stays on the TV so it can be rolled back.', { version: v });
  if (!confirm(prompt)) return;
  return runInstall(v, updInstalled, updProg, q('upd-msg'));
}

// The install the Server tab's button and the update pop-up both run, each
// reporting on its own bar and message.
async function runInstall(v, from, prog, msgEl) {
  updBusy = true;
  updArrival = '';
  q('upd-msg').textContent = '';
  msgEl.textContent = '';
  prog.show(true);
  prog.step(t('server.step.downloading', 'Downloading v{version}', { version: v }), 45, 1500);
  let installing = false;
  const watch = setInterval(async () => {
    const d = await fetchJson(api('/api/update'), {}, 2500);
    if (!installing && d && d.state === 'installing') {
      installing = true;
      prog.step(t('server.step.installing', 'Installing v{version}', { version: v }), 58, 1500);
    }
  }, 1000);
  const r = await updControl('update');
  clearInterval(watch);
  if (!r || (r.ok && r.updated)) return awaitRestart(v, t('server.step.updated', 'Updated to v{version}', { version: v }), 'updated', !!r, from, prog, msgEl);
  updBusy = false;
  prog.show(false);
  await loadUpdate();
  msgEl.textContent = r.ok ? (r.note || t('server.nothingNewer', 'Nothing newer to install.'))
    : (r.error || t('server.updateFailed', 'The update failed.'));
}

async function toggleTvUpdates() {
  const b = q('upd-tvblock');
  b.disabled = true;
  const r = await sendCommand('blockTvUpdates', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

async function toggleAutoCheck() {
  const b = q('upd-auto');
  b.disabled = true;
  const r = await sendCommand('updateAutoCheck', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

// ---- update pop-up ----
/*
 * Off until switched on, and kept in this browser: the pop-up only ever shows
 * here, and so does dismissing it. A dismissed version is not offered again; the
 * next release is.
 */
const updPopProg = makeProgress('updpop-prog', 'updpop-step', 'updpop-bar', on => { q('updpop-btns').hidden = on; });
let updPopupOpener = null;

function updPopupOn() {
  try { return localStorage.getItem('updPopup') === '1'; } catch (e) { return false; }
}

function updPopupDismissedVersion() {
  try { return localStorage.getItem('updPopupDismissed') || ''; } catch (e) { return ''; }
}

function renderUpdatePopupToggle() {
  const on = updPopupOn();
  updateToggle('upd-popup', {
    cls: on ? 'good' : 'idle',
    label: on ? t('common.on', 'On') : t('common.off', 'Off'),
    on,
    disabled: false
  });
}

function toggleUpdatePopup() {
  const on = !updPopupOn();
  try {
    localStorage.setItem('updPopup', on ? '1' : '0');
    // Switching it on again offers the release that was dismissed before.
    if (on) localStorage.removeItem('updPopupDismissed');
  } catch (e) { /* private window */ }
  renderUpdatePopupToggle();
}

// Not while an install is under way, nor while the server is already busy with one.
function offerUpdatePopup(d) {
  if (!d.available || !updPopupOn() || !q('updpop').hidden || updBusy || updRestarting) return;
  if (d.state === 'downloading' || d.state === 'installing' || d.state === 'installed') return;
  if (updPopupDismissedVersion() === String(d.latest)) return;
  showUpdatePopup(d);
}

function showUpdatePopup(d) {
  const box = q('updpop');
  const canInstall = d.writable;
  box.dataset.v = d.latest;
  q('updpop-title').textContent = t('server.popup.title', 'v{version} is out', { version: d.latest });
  // The release's own one-line summary, written to be read at a glance.
  const news = (d.whatsNew || []).filter(r => r.summary);
  const latest = news.find(r => r.version === d.latest) || news[0];
  q('updpop-summary').textContent = latest ? latest.summary : '';
  q('updpop-summary').hidden = !latest;
  q('updpop-desc').textContent = !d.writable
    ? t('server.popup.desc.noControls', 'Controls are turned off in the config, so it cannot be installed from here.')
    : d.viaHomebrewChannel
    ? t('server.popup.desc.package', 'Installing it closes the Glasshouse app, replaces its package and restarts the server. No rollback copy is kept.')
    : t('server.popup.desc', 'Installing it replaces the server and restarts it. The previous version stays on the TV for rollback.');
  q('updpop-from').textContent = 'v' + d.installed;
  q('updpop-to').textContent = 'v' + d.latest;
  q('updpop-msg').textContent = '';
  q('updpop-install').hidden = !canInstall;
  q('updpop-btns').classList.toggle('one', !canInstall);
  updPopupOpener = document.activeElement;
  box.hidden = false;
  document.addEventListener('keydown', updPopupKeys);
  (canInstall ? q('updpop-install') : q('updpop-dismiss')).focus();
}

function closeUpdatePopup() {
  document.removeEventListener('keydown', updPopupKeys);
  q('updpop').hidden = true;
  if (updPopupOpener && updPopupOpener.focus) updPopupOpener.focus();
  updPopupOpener = null;
}

function dismissUpdatePopup() {
  if (updBusy || updRestarting) return;
  try { localStorage.setItem('updPopupDismissed', q('updpop').dataset.v); } catch (e) { /* private window */ }
  closeUpdatePopup();
}

// Escape dismisses; Tab stays inside, as the page behind it is not reachable.
function updPopupKeys(e) {
  if (e.key === 'Escape') return dismissUpdatePopup();
  if (e.key !== 'Tab') return;
  const open = Array.from(q('updpop').querySelectorAll('button')).filter(b => !b.hidden && !b.disabled && b.offsetParent !== null);
  if (!open.length) return;
  const first = open[0], last = open[open.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// The same install as the Server tab's button; the pop-up is the confirmation.
function installFromPopup() {
  return runInstall(q('updpop').dataset.v, updInstalled, updPopProg, q('updpop-msg'));
}

q('updpop').addEventListener('click', e => { if (e.target === q('updpop')) dismissUpdatePopup(); });
renderUpdatePopupToggle();

async function toggleExpTileHiding() {
  const b = q('exp-tilehiding');
  b.disabled = true;
  const r = await sendCommand('setTileHidingAllowed', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

// Network time (#633). A switch, and the server's box only while it is on:
// the server is kept while off, so switching back on needs no retyping.
let ntpEditing = false;

function renderNtp(n, cfg, writable) {
  const toggle = q('ntp-toggle'), form = q('ntp-form'), status = q('ntp-status'), input = q('ntp-server');
  if (!toggle) return;
  const on = cfg.enabled;
  if (on) ntpEditing = false;
  updateToggle('ntp-toggle', {
    cls: on ? 'good' : 'idle',
    label: on ? t('common.on', 'On') : t('common.off', 'Off'),
    on: on || ntpEditing,
    disabled: !writable
  });
  form.hidden = !(on || ntpEditing);
  q('ntp-save').disabled = !writable;
  input.disabled = !writable;
  if (document.activeElement !== input && !input.dataset.dirty) {
    input.value = cfg.server ? (cfg.port && cfg.port !== 123 ? hostPort(cfg.server, cfg.port) : cfg.server) : '';
  }
  status.classList.remove('row-err');
  if (ntpEditing) {
    status.hidden = false;
    status.textContent = t('server.ntp.enter', 'Enter the time server and save to switch this on.');
    return;
  }
  if (!on || !n) { status.hidden = true; return; }
  status.hidden = false;
  if (n.error) {
    status.classList.add('row-err');
    status.textContent = t('server.ntp.failing', 'The time server has not answered, so the TV keeps the time it has. {error}', { error: n.error });
  } else {
    status.textContent = n.setAgoS !== null
      ? t('server.ntp.setAgo', 'Set the clock {set}; last checked {checked}.',
          { set: cfgAge(n.setAgoS * 1000), checked: cfgAge(n.answeredAgoS * 1000) })
      : n.answeredAgoS !== null
        ? t('server.ntp.rightAgo', 'Checked {checked}: the clock was already right.', { checked: cfgAge(n.answeredAgoS * 1000) })
        : t('server.ntp.asking', 'Asking the time server\u2026');
  }
}

async function toggleNtp() {
  const b = q('ntp-toggle'), input = q('ntp-server');
  // Switching on with no server saved opens the box for one first.
  if (!b.dataset.on && !input.value.trim()) {
    ntpEditing = true;
    loadUpdate();
    q('ntp-form').hidden = false;
    input.focus();
    return;
  }
  // Switching off a box opened for a first server just closes it.
  if (ntpEditing) {
    ntpEditing = false;
    delete input.dataset.dirty;
    loadUpdate();
    return;
  }
  b.disabled = true;
  const r = await sendCommand('setNtpEnabled', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

async function saveNtpServer() {
  const input = q('ntp-server'), btn = q('ntp-save');
  if (!input.value.trim()) return input.focus();
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const r = await sendCommand('setNtpServer', input.value.trim());
    delete input.dataset.dirty;
    // A refusal, such as a mistyped address, is shown by sendCommand.
    if (r && r.ok) renderUpdate(r); else loadUpdate();
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

async function saveDashboardPort() {
  const input = q('port-input'), btn = q('port-save'), status = q('port-status');
  const port = input.value.trim();
  if (!port) return input.focus();
  status.hidden = true;
  status.classList.add('row-err');
  btn.disabled = true; btn.classList.add('busy');
  try {
    const r = await sendCommand('setDashboardPort', port);
    delete input.dataset.dirty;
    if (r && r.ok && r.restarting) {
      // The server comes back on the new port; this page's address is then stale.
      status.classList.remove('row-err');
      status.textContent = t('server.port.moving', 'Saved. The server is restarting on port {port}; this page opens there when it is back.', { port: r.newPort });
      status.hidden = false;
      const next = location.protocol + '//' + location.hostname + ':' + r.newPort + location.pathname + location.search + location.hash;
      // A browser that forbids the probe would otherwise wait here for good, so
      // after about fifteen seconds the page goes to the new address regardless.
      let tries = 0;
      const tryNext = () => {
        if (++tries > 8) { location.href = next; return; }
        fetch(location.protocol + '//' + location.hostname + ':' + r.newPort + '/api/caps', { mode: 'no-cors' })
          .then(() => { location.href = next; })
          .catch(() => { setTimeout(tryNext, 1500); });
      };
      setTimeout(tryNext, 2500);
    } else if (r && r.ok) {
      loadUpdate();
    }
    // A refusal, such as a port already in use, is shown by sendCommand.
  } finally {
    btn.disabled = false; btn.classList.remove('busy');
  }
}

// Advanced stays open in this browser once opened.
(function rememberServerAdvanced() {
  const adv = q('srv-adv');
  if (!adv) return;
  try { if (localStorage.getItem('srvAdvOpen') === '1') adv.open = true; } catch (e) {}
  adv.addEventListener('toggle', () => {
    try { localStorage.setItem('srvAdvOpen', adv.open ? '1' : '0'); } catch (e) {}
  });
})();

async function togglePrometheus() {
  const b = q('srv-prometheus');
  b.disabled = true;
  const r = await sendCommand('setPrometheusEnabled', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

async function toggleWatchTime() {
  const b = q('srv-watch');
  b.disabled = true;
  const r = await sendCommand('setHistoryEnabled', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

// Stopping keeps what is there; this deletes it.
async function clearWatchTime() {
  if (!confirm(t('server.watch.clearConfirm', 'Delete all watch time kept on the TV?'))) return;
  const r = await sendCommand('clearHistory');
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

// ---- settings backup ----
function backupMessage(text) {
  const m = q('backup-msg');
  m.textContent = text;
  m.hidden = !text;
}

// Hands a backup to the browser as a file named for its TV and day.
function downloadBackupFile(b) {
  const model = String((b.from && b.from.model) || 'tv').replace(/[^A-Za-z0-9_-]+/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
  a.download = `glasshouse-backup-${model}-${b.created.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function saveBackup() {
  try {
    const r = await fetch(api('/api/backup'), { cache: 'no-store' });
    const b = await r.json();
    if (!r.ok || b.format !== 'glasshouse-backup') throw new Error(b.error || r.status);
    downloadBackupFile(b);
    backupMessage(t('server.backup.saved', 'Saved {count} LG settings and Glasshouse’s own.', { count: Object.keys(b.lg || {}).length }));
  } catch (e) {
    backupMessage(t('server.backup.saveFailed', 'Could not make a backup — {error}', { error: e.message }));
  }
}

async function restoreBackup(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let b;
  try { b = JSON.parse(await file.text()); } catch (e) { b = null; }
  restoreBackupData(b);
}

async function restoreBackupData(b) {
  if (!b || b.format !== 'glasshouse-backup') {
    return backupMessage(t('server.backup.notBackup', 'That file is not a Glasshouse backup'));
  }
  const from = (b.from && b.from.model) || t('server.backup.unknownTv', 'an unknown TV');
  const when = b.created ? new Date(b.created).toLocaleString() : '?';
  if (!confirm(t('server.backup.confirm', 'Restore the settings saved from {tv} on {date}? This changes LG’s settings on this TV.', { tv: from, date: when }))) return;
  backupMessage(t('server.backup.restoring', 'Restoring…'));
  try {
    const r = await fetch(api('/api/backup'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || r.status);
    const lg = d.lg || {};
    let text = t('server.backup.restored', 'Changed {changed} LG settings, {same} were already so, {skipped} skipped as this TV does not have them or they are not available now.', {
      changed: (lg.applied || []).length, same: lg.unchanged || 0, skipped: (lg.skipped || []).length
    });
    if ((lg.failed || []).length) text += ' ' + t('server.backup.failedSome', '{count} could not be set.', { count: lg.failed.length });
    const apps = d.apps || {};
    if ((apps.toInstall || []).length) text += ' ' + t('server.backup.appsToInstall', '{count} apps from the backup can be installed from the Apps tab.', { count: apps.toInstall.length });
    if ((apps.manual || []).length) text += ' ' + t('server.backup.appsManual', 'Not in the Homebrew Channel catalog, to install by hand: {names}.', { names: apps.manual.map(a => a.title).join(', ') });
    if (d.restart) text += ' ' + t('server.backup.restarting', 'Glasshouse restarts to apply its own settings.');
    backupMessage(text);
  } catch (e) {
    backupMessage(t('server.backup.restoreFailed', 'Could not restore — {error}', { error: e.message }));
  }
}

// ---- daily backups, kept on the TV ----
function renderBackupDaily(daily, writable) {
  updateToggle('backup-daily', {
    cls: daily.enabled ? 'good' : 'idle',
    label: daily.enabled ? t('common.on', 'On') : t('common.off', 'Off'),
    on: daily.enabled,
    disabled: !writable
  });
  const list = q('backup-saved');
  list.hidden = !daily.saved.length;
  list.innerHTML = daily.saved.map(s => {
    const day = new Date(s.date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return `<div class="bk"><span class="bk-date">${esc(day)}</span>` +
      `<span class="bk-size">${esc(t('server.backup.kb', '{kb} KB', { kb: Math.max(1, Math.round(s.size / 1024)) }))}</span>` +
      `<button type="button" class="link-btn" data-name="${esc(s.name)}" data-do="download">${esc(t('server.backup.download', 'Download'))}</button>` +
      `<button type="button" class="link-btn" data-name="${esc(s.name)}" data-do="restore"${writable ? '' : ' disabled'}>${esc(t('server.backup.restoreSaved', 'Restore'))}</button></div>`;
  }).join('');
  for (const b of list.querySelectorAll('button')) {
    b.onclick = () => (b.dataset.do === 'download' ? downloadSavedBackup : restoreSavedBackup)(b.dataset.name);
  }
}

async function toggleBackupDaily() {
  const b = q('backup-daily');
  b.disabled = true;
  const r = await sendCommand('setBackupDaily', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

async function fetchSavedBackup(name) {
  const r = await fetch(api('/api/backup/saved?name=' + encodeURIComponent(name)), { cache: 'no-store' });
  const b = await r.json();
  if (!r.ok || b.format !== 'glasshouse-backup') throw new Error(b.error || r.status);
  return b;
}

async function downloadSavedBackup(name) {
  try {
    downloadBackupFile(await fetchSavedBackup(name));
  } catch (e) {
    backupMessage(t('server.backup.readFailed', 'Could not read that backup — {error}', { error: e.message }));
  }
}

async function restoreSavedBackup(name) {
  let b;
  try { b = await fetchSavedBackup(name); } catch (e) {
    return backupMessage(t('server.backup.readFailed', 'Could not read that backup — {error}', { error: e.message }));
  }
  restoreBackupData(b);
}

async function toggleExpScreensaver() {
  const b = q('exp-screensaver');
  b.disabled = true;
  const r = await sendCommand('setWebos10ScreensaversAllowed', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

async function toggleNetworkDebugger() {
  const b = q('srv-devtools');
  b.disabled = true;
  const r = await sendCommand('setNetworkDebuggerAllowed', !b.dataset.on);
  if (r && r.ok) renderUpdate(r); else loadUpdate();
}

// ---- the app on the TV's home screen ----
/*
 * Offered here because an in-place update installs no app: it copies files and
 * runs nothing, so without this the only way to get the tile is to re-run
 * deploy.sh. Hidden where the TV will not take an unsigned app.
 */
let tvAppBusy = false;

function renderTvApp(d) {
  const row = q('tvapp-row');
  if (!row) return;
  row.hidden = !(d && d.supported);
  updateToggle('tvapp-btn', {
    cls: d.installed ? 'good' : 'idle',
    label: d.installed ? t('server.tvApp.added', 'Added') : t('server.tvApp.notAdded', 'Not added'),
    on: d.installed,
    disabled: !d.writable || tvAppBusy
  });
  q('tvapp-desc').textContent = d.installed
    ? t('server.tvApp.desc.added', 'Opens this dashboard on the TV itself, driven by the remote. Remove it to take the tile off the home screen.')
    : t('server.tvApp.desc', 'Adds a tile that opens this dashboard on the TV itself, driven by the remote.');
}

async function loadTvApp() {
  try {
    const d = await (await fetch(api('/api/tvapp'), { cache: 'no-store' })).json();
    renderTvApp(d);
  } catch (e) { /* leave the row hidden */ }
}

async function toggleTvApp() {
  if (tvAppBusy) return;
  const btn = q('tvapp-btn');
  const adding = !btn.dataset.on;
  if (!adding && !confirm(t('server.tvApp.remove.confirm', "Take the dashboard off the TV's home screen?"))) return;
  tvAppBusy = true;
  btn.disabled = true;
  btn.textContent = adding ? t('server.tvApp.adding', 'Adding\u2026') : t('server.tvApp.removing', 'Removing\u2026');
  const r = await sendCommand(adding ? 'tvAppInstall' : 'tvAppRemove');
  tvAppBusy = false;
  if (!r || !r.ok) q('upd-msg').textContent = (r && r.error) || t('server.tvApp.failed', 'Could not change it.');
  loadTvApp();
}

async function rollbackUpdate() {
  const v = q('upd-rollback').dataset.v, from = updInstalled;
  if (!confirm(t('server.rollback.confirm', 'Put v{version} back?', { version: v }))) return;
  updBusy = true;
  updArrival = '';
  q('upd-msg').textContent = '';
  updProg.show(true);
  updProg.step(t('server.step.restoring', 'Restoring v{version}', { version: v }), 45, 1500);
  const r = await updControl('updateRollback');
  if (!r || r.ok) return awaitRestart(v, t('server.step.rolledBack', 'Rolled back to v{version}', { version: v }), 'rolledback', !!r, from);
  updBusy = false;
  updProg.show(false);
  await loadUpdate();
  q('upd-msg').textContent = r.error || t('server.rollbackFailed', 'The rollback failed.');
}
