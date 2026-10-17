// The Home tab: Glasshouse Home, a home screen of Glasshouse's own in place of LG's.

let homeStatus = null;
let homeCat = null;      // what the TV's Home lists: apps, devices, picked channels, order
let homeLayout = null;
let homeChannels = null; // the TV's whole channel list, for picking
let homeArmed = null;    // the button waiting for its second press: 'on', 'off' or 'remove'
let homeArmTimer = null;
let homeSaving = false;
let homeLoadRevision = 0;
let homeWallTimer = null;

const HOME_ROWS = {
  app: () => t('home.row.apps', 'Apps'),
  dev: () => t('home.row.inputs', 'Inputs'),
  ch: () => t('home.row.channels', 'Channels')
};

async function homeGet(path) {
  const r = await (await fetch(api(path))).json();
  if (!r || r.ok === false) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
  return r;
}

async function homePost(path, body) {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const r = await res.json();
  if (!r || !r.ok) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
  return r;
}

async function loadHome(afterSave) {
  if (homeSaving && afterSave !== true) return;
  const revision = ++homeLoadRevision;
  try {
    const [st, cat] = await Promise.all([homeGet('/api/home'), homeGet('/api/home/catalogue')]);
    if (revision !== homeLoadRevision) return;
    homeStatus = st;
    homeCat = cat;
    homeLayout = st.layout;
  } catch (e) { showErr(e.message); return; }
  renderHome();
}

function homeWritable() { return !!(!homeSaving && homeStatus && (homeStatus.supported.ok || homeStatus.enabled || homeStatus.restorePending) && homeStatus.writable !== false); }

function renderHome() {
  const st = homeStatus;
  const state = q('home-state');
  const desc = q('home-state-desc');
  const btn = q('home-switch');
  if (!st || !state) return;
  if (st.restorePending) {
    state.textContent = t('home.restorePending', 'LG Home restoration is incomplete');
    desc.textContent = t('home.restoreRetry', 'Retry restoring LG Home before changing or removing Glasshouse Home.');
  } else if (!st.supported.ok) {
    state.textContent = t('home.unavailable', 'Not available on this TV');
    desc.textContent = st.supported.reason || '';
  } else if (!st.installed) {
    state.textContent = t('home.notInstalledTitle', 'Glasshouse Home is not installed');
    desc.textContent = t('home.installDesc', 'Adds the Glasshouse Home app to the TV. Nothing changes until it is switched on: LG\u2019s Home stays the TV\u2019s Home.');
  } else if (st.enabled) {
    state.textContent = t('home.isOn', 'Glasshouse Home is the TV’s Home');
    desc.textContent = st.active
      ? t('home.isOnDesc', 'The Home and Back buttons open it, and the TV starts on it unless it was switched off on an input.')
      : t('home.isOnPending', 'Switched on, but the TV does not yet name it as Home. It is set again within ten minutes.');
  } else {
    state.textContent = t('home.isOff', 'LG’s Home is the TV’s Home');
    desc.textContent = t('home.isOffDesc', 'Switching on keeps a copy of the TV’s Home settings first, and switching off puts them back exactly.');
  }
  const more = q('home-more');
  if (more) more.hidden = !st.supported.ok || !st.installed;
  const removeRow = q('home-remove-row');
  if (removeRow) removeRow.hidden = !st.installed || st.enabled || st.restorePending;
  const removeBtn = q('home-remove');
  if (removeBtn) {
    removeBtn.disabled = !homeWritable();
    removeBtn.className = 'pill ' + (homeArmed === 'remove' ? 'warn' : 'idle');
    removeBtn.textContent = homeArmed === 'remove' ? t('home.confirmRemove', 'Press again to remove') : t('home.removeBtn', 'Remove');
  }
  if (btn && st.supported.ok && !st.installed && !st.restorePending) {
    btn.disabled = !homeWritable();
    btn.className = 'pill idle';
    btn.textContent = t('home.install', 'Install Glasshouse Home');
  } else if (btn) {
    const wantOn = !(st.enabled || st.restorePending);
    const armed = homeArmed === (wantOn ? 'on' : 'off');
    btn.disabled = !homeWritable();
    btn.className = 'pill ' + (armed ? 'warn' : st.enabled ? 'good' : 'idle');
    btn.textContent = armed
      ? (wantOn ? t('home.confirmOn', 'Press again to switch on') : t('home.confirmOff', 'Press again to use LG Home'))
      : (st.restorePending ? t('home.retryRestore', 'Retry restoring LG Home') : wantOn ? t('home.switchOn', 'Use Glasshouse Home') : t('home.switchOff', 'Use LG Home'));
  }
  const snap = q('home-snapshot');
  if (snap) {
    snap.hidden = !st.snapshot;
    if (st.snapshot) {
      const s = st.snapshot.settings;
      snap.textContent = t('home.snapshot', 'Saved {when}: Home was {home}, the TV started on {input}, and the screen saver was {saver}.', {
        when: new Date(st.snapshot.takenAt).toLocaleString(),
        home: (s.defaultApps && s.defaultApps.home) || t('home.lgHome', 'LG Home'),
        input: homeAppName(s.lastInputApp),
        saver: s.screenSaverEnabled || '—'
      });
    }
  }
  const hist = q('home-history-note');
  if (hist) hist.hidden = st.history;
  renderHomeRows();
  renderHomeChannels();
  renderHomeIdle();
  renderHomeWalls();
  q('home-reset').disabled = !homeWritable();
}

// An input's app id as the TV names the input: HDMI 2, Live TV.
function homeAppName(id) {
  const m = /^com\.webos\.app\.hdmi(\d)$/.exec(id || '');
  if (m) return t('home.dev.port', 'HDMI {port}', { port: m[1] });
  if (id === 'com.webos.app.livetv') return t('home.liveTv', 'Live TV');
  if (id === 'com.tvweb.home') return t('home.title', 'Glasshouse Home');
  return id || '\u2014';
}

function homeItem(kind, id) {
  if (kind === 'app' && id === 'lg-home') return { title: t('home.lgHome', 'LG Home'), lg: true };
  const list = kind === 'app' ? homeCat.apps : kind === 'dev' ? homeCat.devices : homeCat.channels;
  const it = list.find(x => x.id === id);
  if (!it) return null;
  if (kind === 'dev' && it.unused) return { title: it.name, sub: t('home.dev.unused', 'Nothing connected') };
  if (kind === 'dev') return { title: it.name, sub: it.via ? t('home.dev.through', 'HDMI {port}, through {via}', { port: it.port, via: it.via }) : t('home.dev.port', 'HDMI {port}', { port: it.port }) };
  if (kind === 'ch') return { title: it.number + ' ' + it.name };
  return { title: it.title, icon: it.icon };
}

function renderHomeRows() {
  const box = q('home-rows');
  if (!box || !homeCat) return;
  const usable = homeWritable();
  // Redrawing after each change keeps the rows that were open, and what was typed in the channel search.
  const open = box.children.length ? [...box.querySelectorAll('details[open]')].map(d => d.dataset.kind) : [homeLayout.rows[0]];
  const filter = q('home-ch-filter') ? q('home-ch-filter').value : '';
  box.innerHTML = homeLayout.rows.map((kind, ri) => {
    const order = homeCat.order[kind] || [];
    const tiles = order.map((id, i) => {
      const it = homeItem(kind, id);
      if (!it) return '';
      const hidden = kind !== 'ch' && homeLayout.hidden[kind].includes(id);
      const icon = it.icon ? `<img class="rk-ico" src="${esc(api(it.icon))}" alt="">` : '';
      return `<div class="prot-row home-tile${hidden ? ' home-hidden' : ''}">
        <div class="prot-main"><div class="prot-title">${icon}<span translate="no">${esc(it.title)}</span></div>
          ${it.sub ? `<div class="prot-desc">${esc(it.sub)}</div>` : ''}</div>
        <div class="prot-status">
          <button type="button" class="pill idle home-move" ${usable && i > 0 ? '' : 'disabled'} onclick="homeMoveTile('${kind}', ${i}, -1)" aria-label="${esc(t('home.earlier', 'Earlier'))}">↑</button>
          <button type="button" class="pill idle home-move" ${usable && i < order.length - 1 ? '' : 'disabled'} onclick="homeMoveTile('${kind}', ${i}, 1)" aria-label="${esc(t('home.later', 'Later'))}">↓</button>
          ${it.lg ? `<span class="pill idle">${esc(t('home.alwaysShown', 'Always shown'))}</span>` :
            kind === 'ch' ? `<button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeToggleChannel('${jsq(id)}')">${esc(t('home.ch.remove', 'Remove'))}</button>` :
            renderToggle({ cls: hidden ? 'idle' : 'good', label: hidden ? t('home.hidden', 'Hidden') : t('home.shown', 'Shown'),
              disabled: !usable, onclick: `homeToggleTile('${kind}', '${jsq(id)}')` })}
        </div></div>`;
    }).join('');
    return `<details class="home-row" data-kind="${kind}"${open.includes(kind) ? ' open' : ''}>
      <summary><span class="prot-title">${esc(HOME_ROWS[kind]())}</span>
        <span class="home-row-move">
          <button type="button" class="pill idle" ${usable && ri > 0 ? '' : 'disabled'} onclick="event.preventDefault(); homeMoveRow(${ri}, -1)">${esc(t('home.rowUp', 'Row up'))}</button>
          <button type="button" class="pill idle" ${usable && ri < homeLayout.rows.length - 1 ? '' : 'disabled'} onclick="event.preventDefault(); homeMoveRow(${ri}, 1)">${esc(t('home.rowDown', 'Row down'))}</button>
        </span></summary>
      <div class="prot-table">${tiles || `<div class="sub">${esc(kind === 'ch' ? t('home.ch.empty', 'No channels yet. Add them below.') : t('home.rowEmpty', 'Nothing to show in this row yet.'))}</div>`}</div>
      ${kind === 'ch' ? homeChannelPicker() : ''}
    </details>`;
  }).join('');
  if (q('home-ch-filter')) q('home-ch-filter').value = filter;
}

async function homeSaveLayout(patch) {
  if (!homeWritable()) return;
  homeSaving = true;
  homeLoadRevision++;
  renderHome();
  try {
    const r = await homePost('/api/home/layout', patch);
    homeLayout = r.layout;
    homeStatus.layout = r.layout;
  } catch (e) { showErr(e.message); }
  await loadHome(true);
  homeSaving = false;
  renderHome();
}

function homeMoveTile(kind, i, d) {
  if (!homeWritable()) return;
  const order = homeCat.order[kind].slice();
  const j = i + d;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  // Only this row: the others keep following their own default order.
  homeSaveLayout({ order: { [kind]: order } });
}

function homeMoveRow(i, d) {
  const rows = homeLayout.rows.slice();
  const j = i + d;
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  homeSaveLayout({ rows });
}

function homeToggleTile(kind, id) {
  const hidden = Object.assign({}, homeLayout.hidden);
  const list = hidden[kind].slice();
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  hidden[kind] = list;
  homeSaveLayout({ hidden });
}

function homeResetLayout() { homeSaveLayout({ reset: true }); }

function homeArm(what) {
  homeArmed = what;
  clearTimeout(homeArmTimer);
  homeArmTimer = setTimeout(() => { homeArmed = null; renderHome(); }, 5000);
  renderHome();
}

async function homeInstall() {
  const btn = q('home-switch');
  if (btn) { btn.disabled = true; btn.textContent = t('tv.home.installing', 'Installing\u2026'); }
  try { await homePost('/api/home/install'); } catch (e) { showErr(e.message); }
  loadHome();
}

async function homeRemove() {
  if (homeArmed !== 'remove') return homeArm('remove');
  homeArmed = null;
  clearTimeout(homeArmTimer);
  const btn = q('home-remove');
  if (btn) { btn.disabled = true; btn.textContent = t('tv.home.removing', 'Removing\u2026'); }
  try { await homePost('/api/home/remove'); } catch (e) { showErr(e.message); }
  loadHome();
}

// The master switch: one press arms it, a second within five seconds acts.
async function homeSwitch() {
  if (!homeWritable()) return;
  if (!homeStatus.installed && !homeStatus.enabled && !homeStatus.restorePending) return homeInstall();
  const want = homeStatus.enabled || homeStatus.restorePending ? 'off' : 'on';
  if (homeArmed !== want) {
    homeArmed = want;
    clearTimeout(homeArmTimer);
    homeArmTimer = setTimeout(() => { homeArmed = null; renderHome(); }, 5000);
    return renderHome();
  }
  homeArmed = null;
  clearTimeout(homeArmTimer);
  const btn = q('home-switch');
  if (btn) { btn.disabled = true; btn.textContent = t('apps.service.updating', 'Updating…'); }
  try {
    await homePost(want === 'on' ? '/api/home/enable' : '/api/home/disable');
  } catch (e) { showErr(e.message); }
  loadHome();
}

// Added channels are the Channels row; this finds more to add. Built once, then only its list redraws.
function homeChannelPicker() {
  return `<div class="home-ch-add">
    <div class="prot-title">${esc(t('home.ch.addTitle', 'Add channels'))}</div>
    <input type="search" id="home-ch-filter" class="home-ch-filter" placeholder="${esc(t('home.ch.find', 'Find a channel'))}" oninput="renderHomeChannels()">
    <div class="prot-table home-ch-list" id="home-ch-list"></div>
  </div>`;
}

async function homeLoadChannels() {
  const box = q('home-ch-list');
  if (box) box.innerHTML = `<div class="sub">${esc(t('home.ch.loading', 'Reading the TV’s channels…'))}</div>`;
  try {
    const r = await homeGet('/api/home/channels');
    homeChannels = r.channels;
  } catch (e) { showErr(e.message); homeChannels = null; }
  renderHomeChannels();
}

function renderHomeChannels() {
  const box = q('home-ch-list');
  const filterBox = q('home-ch-filter');
  if (!box || !homeLayout) return;
  const picked = homeLayout.channels;
  if (filterBox) filterBox.hidden = !homeChannels || !homeChannels.length;
  if (!homeChannels) {
    box.innerHTML = `<button type="button" class="pill idle" onclick="homeLoadChannels()">${esc(t('home.ch.show', 'Show the TV’s channels'))}</button>`;
    return;
  }
  if (!homeChannels.length) {
    box.innerHTML = `<div class="sub">${esc(t('home.ch.none', 'This TV has no channels tuned, so the Channels row stays empty.'))}</div>`;
    return;
  }
  const filter = (filterBox && filterBox.value || '').toLowerCase();
  const usable = homeWritable();
  const rows = homeChannels
    .filter(c => !picked.includes(c.id))
    .filter(c => !filter || (c.number + ' ' + c.name).toLowerCase().includes(filter))
    .map(c => `<div class="prot-row"><div class="prot-main"><div class="prot-title"><span class="num">${esc(c.number)}</span> ${esc(c.name)}</div>
        ${c.radio ? `<div class="prot-desc">${esc(t('home.ch.radio', 'Radio'))}</div>` : ''}</div>
        <div class="prot-status"><button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeToggleChannel('${jsq(c.id)}')">${esc(t('home.ch.add', 'Add'))}</button></div></div>`);
  box.innerHTML = rows.join('') || `<div class="sub">${esc(filter ? t('home.ch.noMatch', 'No channel matches that.') : t('home.ch.allAdded', 'Every channel is on Home.'))}</div>`;
}

function homeToggleChannel(id) {
  const list = homeLayout.channels.slice();
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  homeSaveLayout({ channels: list });
}

function renderHomeIdle() {
  const dim = q('home-idle-dim');
  const off = q('home-idle-off');
  if (!dim || !homeLayout) return;
  if (document.activeElement !== dim) dim.value = String(homeLayout.idle.dimAfter);
  if (document.activeElement !== off) off.value = String(homeLayout.idle.panelOffAfter);
  dim.disabled = off.disabled = !homeWritable();
}

function homeSetIdle() {
  homeSaveLayout({ idle: { dimAfter: +q('home-idle-dim').value, panelOffAfter: +q('home-idle-off').value } });
}

// The four wallpapers, by the hours each is shown.
function renderHomeWalls() {
  const box = q('home-walls');
  if (!box) return;
  const walls = homeStatus.wallpapers || {};
  const button = q('home-wall-download');
  button.disabled = !homeWritable() || walls.downloading;
  button.textContent = walls.downloading ? t('home.wall.downloading', 'Downloading wallpapers…')
    : walls.available ? t('home.wall.remove', 'Remove wallpapers') : t('home.wall.download', 'Download wallpapers');
  q('home-wall-error').textContent = walls.error || '';
  clearTimeout(homeWallTimer);
  if (walls.downloading) homeWallTimer = setTimeout(() => { if (activeTab === 'home') loadHome(); }, 2000);
  if (!walls.available) { box.innerHTML = ''; return; }
  if (box.children.length) return;
  const slots = [
    ['morning', t('home.wall.morning', 'Morning, 06:00 to 11:00')],
    ['afternoon', t('home.wall.afternoon', 'Afternoon, 11:00 to 17:00')],
    ['evening', t('home.wall.evening', 'Evening, 17:00 to 21:00')],
    ['night', t('home.wall.night', 'Night, 21:00 to 06:00')]
  ];
  box.innerHTML = slots.map(([key, label]) => `<figure class="home-wall">
    <img src="${esc(api('/api/home/wallpaper?slot=' + key))}" alt="" loading="lazy"><figcaption class="sub">${esc(label)}</figcaption></figure>`).join('');
}

async function homeDownloadWalls() {
  if (!homeWritable()) return;
  q('home-wall-download').disabled = true;
  try { await homePost('/api/home/wallpapers', { remove: !!(homeStatus.wallpapers && homeStatus.wallpapers.available) }); }
  catch (e) { showErr(e.message); }
  loadHome();
}
