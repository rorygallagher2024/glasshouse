// The release check, in-place upgrade and rollback, and the app on the TV's home screen.

// Releases are cut on the upstream repo, so the tag link points there.
const REPO = 'https://github.com/rorygallagher2024/lg-webos-dashboard';

function setVersion(v) {
  const el = q('version');
  if (!v || el.dataset.v === v) return;   // static between restarts, so set it once
  const had = el.dataset.v;
  el.dataset.v = v;
  el.textContent = 'v' + v;
  el.href = REPO + '/releases/tag/v' + v;
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
// What the last install or rollback came to, kept across re-renders until the next action.
let updArrival = '';

function renderUpdate(d) {
  const pill = q('upd-pill'), desc = q('upd-desc'), msg = q('upd-msg');
  const inst = q('upd-install'), roll = q('upd-rollback'), chk = q('upd-check');
  updInstalled = d.installed;
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
    : d.viaHomebrewChannel
    ? t('server.available.hbc', 'v{version} is out. Update Glasshouse in the Homebrew Channel; the server follows within a few minutes.', { version: d.latest })
    : t('server.available', 'v{version} is out. Installing it replaces the server and restarts it.', { version: d.latest });
  desc.hidden = !d.available;

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

  msg.textContent = (d.state === 'error' || d.state === 'offline') ? (d.error || t('server.checkFailed', 'the check failed'))
    : d.state === 'installed' ? t('server.installed', 'Installed. The server is restarting - this page reconnects on its own.')
    : updArrival;

  chk.hidden = !d.writable;
  chk.disabled = working || updBusy;
  inst.hidden = !(d.available && d.writable && !d.viaHomebrewChannel);
  inst.disabled = working || updBusy;
  inst.textContent = t('server.install', 'Install v{version}', { version: d.latest });
  inst.dataset.v = d.latest || '';
  roll.hidden = !(d.rollbackTo && d.writable);
  roll.disabled = working || updBusy;
  roll.textContent = t('server.rollback', 'Roll back to v{version}', { version: d.rollbackTo });
  roll.dataset.v = d.rollbackTo || '';
  if (q('upd-prog').hidden) q('upd-btns').hidden = chk.hidden && inst.hidden && roll.hidden;

  const vn = q('version-new');
  if (d.available) {
    vn.textContent = '\u2192 v' + d.latest;
    vn.href = REPO + '/releases/tag/v' + d.latest;
    vn.hidden = false;
  } else {
    vn.hidden = true;
  }
}

async function loadUpdate() {
  try {
    const d = await (await fetch(api('/api/update'), { cache: 'no-store' })).json();
    if (d && d.ok) {
      renderUpdate(d);
      noteArrival(d);
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
  if (d.installed === (up || back)) {
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
 * progress, means the change did not happen.
 */
async function awaitRestart(version, doneLabel, param, confirmed, oldVersion) {
  updRestarting = true;
  // The work is done by now; what is left is waiting.
  updProg.set(Math.max(updProg.pct, 60));
  updProg.step(t('server.step.restarting', 'Restarting the server'), 95, 20000);
  const t0 = Date.now();
  for (;;) {
    await new Promise(res => setTimeout(res, 1500));
    const d = await fetchJson(api('/api/update'), {}, 3000);
    if (d && d.installed === version) break;
    if (d && !confirmed && d.installed === oldVersion && !/checking|downloading|installing/.test(d.state)) {
      updRestarting = false;
      updBusy = false;
      updProg.show(false);
      renderUpdate(d);
      q('upd-msg').textContent = t('server.notFinished', 'That did not finish. The TV is still on v{version}.', { version: oldVersion });
      return;
    }
    const waited = Date.now() - t0;
    q('upd-msg').textContent = waited > 240000 ? t('server.notBack', 'The server has not come back. See Updating in the README to roll back.')
      : waited > 30000 ? t('server.slow', 'Taking longer than usual - it can take up to two minutes.')
      : '';
  }
  q('upd-msg').textContent = '';
  updProg.done(doneLabel);
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
  q('upd-check').disabled = true;
  const r = await updControl('updateCheck');
  updBusy = false;
  if (r && r.ok && r.state !== 'checking') renderUpdate(r); else loadUpdate();
}

async function installUpdate() {
  const v = q('upd-install').dataset.v, from = updInstalled;
  if (!confirm(t('server.install.confirm', 'Install v{version}?\n\nThe server is replaced and restarted, and the previous version stays on the TV so it can be rolled back.', { version: v }))) return;
  updBusy = true;
  updArrival = '';
  q('upd-msg').textContent = '';
  updProg.show(true);
  updProg.step(t('server.step.downloading', 'Downloading v{version}', { version: v }), 45, 1500);
  let installing = false;
  const watch = setInterval(async () => {
    const d = await fetchJson(api('/api/update'), {}, 2500);
    if (!installing && d && d.state === 'installing') {
      installing = true;
      updProg.step(t('server.step.installing', 'Installing v{version}', { version: v }), 58, 1500);
    }
  }, 1000);
  const r = await updControl('update');
  clearInterval(watch);
  if (!r || (r.ok && r.updated)) return awaitRestart(v, t('server.step.updated', 'Updated to v{version}', { version: v }), 'updated', !!r, from);
  updBusy = false;
  updProg.show(false);
  await loadUpdate();
  q('upd-msg').textContent = r.ok ? (r.note || t('server.nothingNewer', 'Nothing newer to install.'))
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
