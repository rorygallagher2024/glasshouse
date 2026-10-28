// The Home tab: Glasshouse Home, a home screen of Glasshouse's own in place of LG's.

let homeStatus = null;
let homeCat = null;      // what the TV's Home lists: apps, devices, picked channels, order
let homeLayout = null;
let homeChannels = null; // the TV's whole channel list, for picking
let homeArmed = null;    // the control waiting for its second press: 'on', 'off' or 'hide'
let homeArmTimer = null;
let homeSaving = false;
let homeLoadRevision = 0;
let homeWallTimer = null;
let homeWallUploading = false;
// null until the server says; false on a TV Glasshouse Home is not offered on.
let homeAvailable = null;

const HOME_ROWS = {
  app: () => t('home.row.apps', 'Apps'),
  dev: () => t('home.row.inputs', 'Inputs'),
  ch: () => t('home.row.channels', 'Channels'),
  rec: () => t('home.row.recommended', 'Recommended')
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

// The tab, as Game's, only where the server offers Glasshouse Home.
function setHomeAvailable(st) {
  homeAvailable = st.available !== false;
  if (q('tab-btn-home')) q('tab-btn-home').hidden = !homeAvailable;
}

async function loadHomeAvailable() {
  try { setHomeAvailable(await homeGet('/api/home')); } catch (e) {}
}

async function loadHome(afterSave) {
  if (homeSaving && afterSave !== true) return;
  const revision = ++homeLoadRevision;
  try {
    const [st, cat] = await Promise.all([homeGet('/api/home?with=lghome'), homeGet('/api/home/catalogue')]);
    if (revision !== homeLoadRevision) return;
    homeStatus = st;
    homeCat = cat;
    homeLayout = st.layout;
  } catch (e) { showErr(e.message); return; }
  setHomeAvailable(homeStatus);
  if (!homeAvailable && activeTab === 'home') return showTab('control');
  renderHome();
}

function homeWritable() { return !!(!homeSaving && homeStatus && (homeStatus.supported.ok || homeStatus.enabled || homeStatus.restorePending) && homeStatus.writable !== false); }

// The Home customisation section, whichever Home is the TV's: Open Home at
// power-on wherever LG has it, Glasshouse Home's own options while it is on,
// LG's Home's layout while that is, and hidden system apps, which apply to
// either Home.
function renderHomeCustom(autoVal) {
  const st = homeStatus;
  const lg = st.lgHome;
  const glasshouseOn = !!(st.enabled && st.supported.ok);
  const box = q('home-custom');
  if (box) box.classList.toggle('lg-home', !glasshouseOn);
  const layout = q('disc-homescreen');
  const tiles = q('disc-system-tiles');
  if (tiles) tiles.hidden = !lg;
  if (lg) {
    renderHomeScreen(lg);
    renderSystemTiles(lg);
  }
  if (layout && (!lg || glasshouseOn)) layout.hidden = true;
  if (box) box.hidden = !(glasshouseOn || autoVal !== undefined || (layout && !layout.hidden) || (tiles && !tiles.hidden));
}

function renderHome() {
  const st = homeStatus;
  const state = q('home-state');
  const desc = q('home-state-desc');
  const btn = q('home-switch');
  if (!st || !state) return;
  // A TV without Glasshouse Home (a B8) has the tab for LG's Home's options alone.
  const glasshouse = st.supported.ok || st.enabled || st.restorePending;
  const hero = q('home-hero');
  if (hero) hero.hidden = !glasshouse;
  if (st.restorePending) {
    state.textContent = t('home.restorePending', 'LG Home restoration is incomplete');
    desc.textContent = t('home.restoreRetry', 'Retry restoring LG Home before switching Glasshouse Home on again.');
  } else if (!st.supported.ok) {
    state.textContent = t('home.unavailable', 'Not available on this TV');
    desc.textContent = st.supported.reason || '';
  } else if (st.enabled) {
    state.textContent = t('home.isOn', 'Glasshouse Home is the TV’s Home');
    desc.textContent = st.lgHomeOpen
      ? t('home.isOnLgOpen', 'LG’s Home is open for now. Glasshouse Home comes back when something else is opened, or Home is pressed.')
      : st.active
        ? t('home.isOnDesc', 'It opens in LG’s Home’s place: with the Home and Back buttons, and when the TV wakes on Home.')
        : t('home.isOnPending', 'Switched on, but LG’s Home is still in its place. Switching off and on again tries once more.');
  } else {
    state.textContent = t('home.isOff', 'LG’s Home is the TV’s Home');
    desc.textContent = t('home.isOffDesc', 'Nothing of LG’s is changed: Glasshouse Home is laid over LG’s Home while on, and switching off takes it away.');
  }
  const dot = q('home-dot');
  // Orange only when something needs attention: switched on but not in LG's
  // Home's place, or a switch-off left unfinished. LG's Home opened on purpose
  // (its tile, or holding Home) leaves Glasshouse Home the TV's Home.
  if (dot) dot.className = 'ps-dot' + (st.restorePending ? ' warn' : st.enabled ? (st.active || st.lgHomeOpen ? ' good' : ' warn') : '');
  const more = q('home-more');
  if (more) more.hidden = !st.supported.ok || !st.enabled;
  const autoRow = q('home-autolaunch-row');
  const autoLeased = typeof getLease === 'function' ? getLease('homeAutoLaunch', st.homeAutoLaunch) : undefined;
  const autoVal = autoLeased !== undefined ? autoLeased : st.homeAutoLaunch;
  if (autoRow) autoRow.hidden = autoVal === undefined;
  renderHomeCustom(autoVal);
  const autoBtn = q('home-autolaunch');
  if (autoBtn && autoVal !== undefined) {
    const on = !!autoVal;
    updateToggle(autoBtn, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off'), on: on });
    // LG's own setting: changeable wherever the TV has it, Glasshouse Home or not.
    autoBtn.disabled = homeSaving || st.writable === false;
  }
  const hideRow = q('home-hide-lg-row');
  // webOS 9 only: newer TVs have no layout file for LG's Home to start on.
  if (hideRow) hideRow.hidden = !st.supported.ok || st.hideLgHomeAtStartAvailable === false;
  const picRow = q('home-picture-row');
  if (picRow) picRow.hidden = !st.supported.ok;
  const pic = q('home-picture');
  if (pic) {
    const on = !!st.layout && st.layout.picture === true;
    updateToggle(pic, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    pic.disabled = !homeWritable();
  }
  document.querySelectorAll('.home-show-row').forEach(row => { row.hidden = !st.supported.ok; });
  // Alternative View's rows have no titles, so no app count beside them.
  const altView = !!st.layout && st.layout.view === 'alternative';
  HOME_SHOW.forEach(([key, id]) => {
    const el = q(id);
    if (!el) return;
    const on = !st.layout || st.layout[key] !== false;
    const unused = key === 'showAppCount' && altView;
    updateToggle(el, { cls: on && !unused ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    el.disabled = !homeWritable() || unused;
  });
  const countAlt = q('home-show-count-alt');
  if (countAlt) countAlt.hidden = !altView;
  const searchRow = q('home-search-row');
  if (searchRow) searchRow.hidden = !st.supported.ok;
  const searchPill = q('home-search');
  // Greyed while the ad blocker blocks LG's search; the setting itself is kept.
  const searchBlocked = st.layout && st.layout.searchBlocked;
  if (searchPill) {
    const on = !!(st.layout && st.layout.search === true);
    updateToggle(searchPill, { cls: on && !searchBlocked ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    searchPill.disabled = !homeWritable() || !!searchBlocked;
  }
  const blockedNote = q('home-search-blocked');
  if (blockedNote) {
    blockedNote.hidden = !searchBlocked;
    if (searchBlocked) q('home-search-blocked-text').textContent = searchBlocked.by === 'list'
      ? t('home.searchBlockedList', 'Unavailable: the ad blocker\u2019s hosts list blocks {host}, which LG\u2019s search needs, so the search mark is hidden on Glasshouse Home. Take {host} out of the list to use it. This switch keeps its setting.', { host: searchBlocked.host })
      : t('home.searchBlockedLevel', 'Unavailable: the ad blocker\u2019s Everything setting blocks {host}, which LG\u2019s search needs, so the search mark is hidden on Glasshouse Home. Set the ad blocker to Ads & telemetry or off to use it. This switch keeps its setting.', { host: searchBlocked.host });
  }
  // Fading, as Picture details.
  [['home-fade', 'fade'], ['home-rows-bottom', 'rowsBottom']].forEach(([id, field]) => {
    const row = q(id + '-row');
    if (row) row.hidden = !st.supported.ok;
    const btn = q(id);
    if (!btn) return;
    const on = !!st.layout && st.layout[field] === true;
    updateToggle(btn, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    btn.disabled = !homeWritable();
  });
  const altRow = q('home-alternative-row');
  if (altRow) altRow.hidden = !st.supported.ok;
  const alt = q('home-alternative');
  if (alt) {
    const on = !!st.layout && st.layout.view === 'alternative';
    updateToggle(alt, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    alt.disabled = !homeWritable();
  }
  const hide = q('home-hide-lg');
  if (hide) {
    const armed = homeArmed === 'hide';
    updateToggle(hide, {
      cls: armed ? 'warn' : st.hideLgHomeAtStart ? 'good' : 'idle',
      label: armed ? t('home.hideLgConfirm', 'Press again to hide it') : st.hideLgHomeAtStart ? t('common.on', 'On') : t('common.off', 'Off')
    });
    hide.disabled = !homeWritable();
  }
  const lgBtn = q('home-mode-lg');
  if (btn) {
    const wantOn = !(st.enabled || st.restorePending);
    const armed = homeArmed === (wantOn ? 'on' : 'off');
    if (st.restorePending) {
      if (lgBtn) lgBtn.hidden = true;
      btn.disabled = !homeWritable();
      btn.className = armed ? 'warn' : '';
      btn.textContent = armed ? t('home.confirmOff', 'Press again to use LG Home') : t('home.retryRestore', 'Retry restoring LG Home');
    } else {
      if (lgBtn) {
        lgBtn.hidden = false;
        lgBtn.disabled = !homeWritable();
        lgBtn.className = !st.enabled ? 'on' : armed ? 'warn' : '';
        lgBtn.textContent = st.enabled
          ? (armed ? t('home.confirmOff', 'Press again to use LG Home') : t('home.switchOff', 'Use LG Home'))
          : t('home.lgHome', 'LG Home');
      }
      btn.disabled = !homeWritable();
      btn.className = st.enabled ? 'on' : armed ? 'warn' : '';
      btn.textContent = !st.enabled
        ? (armed ? t('home.confirmOn', 'Press again to switch on') : t('home.switchOn', 'Use Glasshouse Home'))
        : t('home.title', 'Glasshouse Home');
    }
  }
  const hist = q('home-history-note');
  if (hist) hist.hidden = st.history;
  renderHomeRows();
  renderHomeChannels();
  renderHomeWalls();
  renderHomeColours();
  q('home-reset').disabled = !homeWritable();
}

const HOME_LOOK_NAMES = () => ({
  warm: t('home.colours.warm', 'Warm'),
  glasshouse: t('home.colours.glasshouse', 'Glasshouse'),
  pure: t('home.colours.pure', 'Pure white'),
  white: t('home.colours.white', 'White'),
  ice: t('home.colours.ice', 'Ice'),
  rose: t('home.colours.rose', 'Rose'),
  lilac: t('home.colours.lilac', 'Lilac')
});

// The preset matching the chosen colours, the first (the view's own) when none are chosen, or null for custom ones.
function homeLookNow() {
  const presets = (homeStatus && homeStatus.colourPresets) || [];
  const c = homeLayout && homeLayout.colours;
  if (!c) return presets[0] || null;
  return presets.find(p => p.text === c.text && p.accent === c.accent) || null;
}

// Each preset as a small Glasshouse Home: the clock in its text, a row's name in the quieter shade, the accent's mark.
function renderHomeColours() {
  const box = q('home-looks');
  if (!box || !homeStatus) return;
  const presets = homeStatus.colourPresets || [];
  const names = HOME_LOOK_NAMES();
  const now = homeLookNow();
  const can = homeWritable() && !homeSaving;
  // The first preset is the view's own colours, saved as none chosen.
  // The sample clock in each preview is a fixed time, in the TV's own hour
  // cycle.
  const lookClock = homeStatus.clockHour12 ? `9:40 ${t('common.pm', 'PM')}` : '21:40';
  box.innerHTML = presets.map((p, i) => `<button type="button" class="home-look${now && now.id === p.id ? ' picked' : ''}"
      onclick="homeSaveLayout({ colours: ${i === 0 ? 'null' : `{ text: '${p.text}', accent: '${p.accent}' }`} })" ${can ? '' : 'disabled'}
      aria-pressed="${now && now.id === p.id}" style="--look-text:${p.text};--look-accent:${p.accent}">
      <span class="home-look-screen"><span class="home-look-clock">${lookClock}</span><span class="home-look-row">${esc(t('home.row.apps', 'Apps'))}</span><i></i></span>
      <span class="home-look-name">${esc(names[p.id] || p.id)}</span>
    </button>`).join('');
  const c = (homeLayout && homeLayout.colours) || presets[0] || { text: '#ece7df', accent: '#e9ad55' };
  const text = q('home-col-text'), accent = q('home-col-accent');
  if (text && document.activeElement !== text) text.value = c.text;
  if (accent && document.activeElement !== accent) accent.value = c.accent;
  [text, accent].forEach(el => { if (el) el.disabled = !can; });
  const reset = q('home-col-reset');
  if (reset) reset.disabled = !can || !(homeLayout && homeLayout.colours);
}

function homeCustomColours() {
  homeSaveLayout({ colours: { text: q('home-col-text').value, accent: q('home-col-accent').value } });
}

function homeItem(kind, id) {
  if (kind === 'app' && id === 'lg-home') return { title: t('home.lgHome', 'LG Home'), lg: true };
  const list = kind === 'app' ? homeCat.apps : kind === 'dev' ? homeCat.devices : homeCat.channels;
  const it = list.find(x => x.id === id);
  if (!it) return null;
  if (kind === 'dev' && it.unused) return { title: it.name, sub: t('home.dev.unused', 'Nothing connected'), unused: true };
  if (kind === 'dev') return { title: it.name, sub: it.via ? t('home.dev.through', 'HDMI {port}, through {via}', { port: it.port, via: it.via }) : t('home.dev.port', 'HDMI {port}', { port: it.port }) };
  if (kind === 'ch') return { title: it.number + ' ' + it.name };
  return { title: it.title, icon: it.icon };
}

function renderHomeRows() {
  const box = q('home-rows');
  if (!box || !homeCat) return;
  const usable = homeWritable();
  // Redrawing after each change keeps the rows that were open, and what was typed in the channel search.
  const open = box.children.length ? [...box.querySelectorAll('details[open]')].map(d => d.dataset.kind) : [];
  const filter = q('home-ch-filter') ? q('home-ch-filter').value : '';
  box.innerHTML = homeLayout.rows.map((kind, ri) => {
    const rowMove = `<span class="home-row-move">
          <button type="button" class="pill idle" ${usable && ri > 0 ? '' : 'disabled'} onclick="event.preventDefault(); homeMoveRow(${ri}, -1)">${esc(t('home.rowUp', 'Row up'))}</button>
          <button type="button" class="pill idle" ${usable && ri < homeLayout.rows.length - 1 ? '' : 'disabled'} onclick="event.preventDefault(); homeMoveRow(${ri}, 1)">${esc(t('home.rowDown', 'Row down'))}</button>
        </span>`;
    // The apps' cards come and go with their lists, so the row has its switch rather than tiles.
    if (kind === 'rec') {
      return `<details class="home-row" data-kind="rec"${open.includes('rec') ? ' open' : ''}>
      <summary><span class="prot-title">${esc(HOME_ROWS.rec())}</span>${rowMove}</summary>
      <div class="prot-table">${homeRecRow(usable)}</div>
    </details>`;
    }
    const order = homeCat.order[kind] || [];
    // A Last opened row is in the order the server sends; moving a tile means choosing Your order first.
    const recent = homeSort(kind) === 'recent';
    const movable = usable && !recent;
    const tiles = order.map((id, i) => {
      const it = homeItem(kind, id);
      if (!it) return '';
      const hidden = kind !== 'ch' && homeLayout.hidden[kind].includes(id);
      const folded = kind === 'app' && (homeLayout.folder || []).includes(id);
      // Hidden or not, an input with nothing plugged in is left out by the row's switch.
      const leftOut = kind === 'dev' && it.unused && homeLayout.hideUnused === true;
      const icon = it.icon ? `<img class="rk-ico" src="${esc(api(it.icon))}" alt="">` : '';
      return `<div class="prot-row home-tile${hidden || folded || leftOut ? ' home-hidden' : ''}">
        <div class="prot-main"><div class="prot-title">${icon}<span translate="no">${esc(it.title)}</span></div>
          ${it.sub ? `<div class="prot-desc">${esc(it.sub)}</div>` : ''}</div>
        <div class="prot-status">
          ${leftOut ? `<span class="pill idle">${esc(t('home.leftOut', 'Left out'))}</span>` : ''}
          <button type="button" class="pill idle home-move" ${movable && i > 0 ? '' : 'disabled'} onclick="homeMoveTile('${kind}', ${i}, -1)" aria-label="${esc(t('home.earlier', 'Earlier'))}">↑</button>
          <button type="button" class="pill idle home-move" ${movable && i < order.length - 1 ? '' : 'disabled'} onclick="homeMoveTile('${kind}', ${i}, 1)" aria-label="${esc(t('home.later', 'Later'))}">↓</button>
          ${kind === 'app' ? homePlaceSelect(id, it, hidden, folded, usable) :
            kind === 'ch' ? `<button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeToggleChannel('${jsq(id)}')">${esc(t('home.ch.remove', 'Remove'))}</button>` :
            renderToggle({ cls: hidden ? 'idle' : 'good', label: hidden ? t('home.hidden', 'Hidden') : t('home.shown', 'Shown'),
              disabled: !usable, onclick: `homeToggleTile('${kind}', '${jsq(id)}')` })}
        </div></div>`;
    }).join('');
    return `<details class="home-row" data-kind="${kind}"${open.includes(kind) ? ' open' : ''}>
      <summary><span class="prot-title">${esc(HOME_ROWS[kind]())}</span>
        ${rowMove}</summary>
      <div class="prot-table">${homeSortRow(kind, usable)}${kind === 'dev' ? homeUnusedRow(usable) : ''}${tiles || `<div class="sub">${esc(kind === 'ch' ? t('home.ch.empty', 'No channels yet. Add them below.') : t('home.rowEmpty', 'Nothing to show in this row yet.'))}</div>`}</div>
      ${kind === 'ch' ? homeChannelPicker() : ''}
    </details>`;
  }).join('');
  if (q('home-ch-filter')) q('home-ch-filter').value = filter;
}

// The Recommended row's switch, with how many cards the apps have listed.
function homeRecRow(usable) {
  const on = homeLayout.recommended === true;
  const n = homeCat && homeCat.sources ? homeCat.sources.recommended : false;
  const shown = (homeCat.order.rec || []).length;
  const count = !on ? '' : n === null ? t('home.recUnavailable', 'This TV did not list any recommendations.')
    : !shown ? t('home.recNone', 'None of this TV\u2019s apps list any yet.')
    : t('home.recCount', '{n} on Glasshouse Home now', { n: shown });
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('home.recommended', 'Show the apps’ recommendations'))}</div>
      <div class="prot-desc">${esc(t('home.recommendedDesc', 'The titles Netflix, Prime Video, Disney+, HBO Max, YouTube and other apps put on LG’s Home, such as Continue watching, as a row of cards. OK opens the app at the title. An app hidden from the Apps row shows none.'))}</div>
      <div class="prot-desc">${esc(t('home.recommendedPrivacy', 'The cards’ pictures are loaded from each app’s own servers, as on LG’s Home.'))}</div>
      ${count ? `<div class="prot-desc">${esc(count)}</div>` : ''}</div>
    <div class="prot-status">${renderToggle({ id: 'home-recommended', cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off'),
      on, disabled: !usable, onclick: 'homeRecommended()' })}</div>
  </div>`;
}

function homeRecommended() {
  homeSaveLayout({ recommended: homeLayout.recommended !== true });
}

// The Inputs row's one choice of what it shows.
function homeUnusedRow(usable) {
  const on = homeLayout.hideUnused === true;
  // An On and Off pill, as the tab's other switches are.
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('home.hideUnused', 'Hide inputs with nothing connected'))}</div>
      <div class="prot-desc">${esc(t('home.hideUnusedDesc', 'Leaves inputs with nothing plugged in out of the Inputs row, instead of showing them greyed out. They still show while arranging.'))}</div></div>
    <div class="prot-status">${renderToggle({ id: 'home-hide-unused', cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off'),
      on, disabled: !usable, onclick: 'homeHideUnused()' })}</div>
  </div>`;
}

function homeSort(kind) { return homeLayout.sort && homeLayout.sort[kind] === 'recent' ? 'recent' : 'custom'; }

function homeSortRow(kind, usable) {
  const sort = homeSort(kind);
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title"><label for="home-sort-${kind}">${esc(t('home.sort', 'Order'))}</label></div>
      <div class="prot-desc">${esc(sort === 'recent'
        ? t('home.sortRecentDesc', 'The tile opened last comes first, whether it was opened from Glasshouse Home or not. Tiles not yet opened follow in this row’s own order.')
        : t('home.sortCustomDesc', 'As arranged here, or by holding OK on Glasshouse Home.'))}</div></div>
    <div class="prot-status"><select id="home-sort-${kind}" class="pill-sel" ${usable ? '' : 'disabled'} onchange="homeSetSort('${kind}', this.value)">
      <option value="custom"${sort === 'custom' ? ' selected' : ''}>${esc(t('home.sortCustom', 'Your order'))}</option>
      <option value="recent"${sort === 'recent' ? ' selected' : ''}>${esc(t('home.sortRecent', 'Last opened'))}</option>
    </select></div></div>`;
}

function homeSetSort(kind, value) {
  if (value === homeSort(kind)) return;
  homeSaveLayout({ sort: { [kind]: value } });
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

/*
 * An app is on the Apps row, in its More apps tile, or hidden. The LG Home
 * tile is the way back to LG's Home, so it is never hidden, but it may go in
 * the folder, where it is still reached.
 */
function homePlaceSelect(id, it, hidden, folded, usable) {
  const place = hidden ? 'hidden' : folded ? 'folder' : 'row';
  const opt = (value, label) => `<option value="${value}"${place === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<select class="pill-sel" ${usable ? '' : 'disabled'} aria-label="${esc(t('home.place', 'Where it shows'))}"
      onchange="homeSetPlace('${jsq(id)}', this.value)">
    ${opt('row', t('home.shown', 'Shown'))}${opt('folder', t('home.folder.label', 'In More apps'))}${it.lg ? '' : opt('hidden', t('home.hidden', 'Hidden'))}
  </select>`;
}

function homeSetPlace(id, place) {
  const hidden = Object.assign({}, homeLayout.hidden);
  hidden.app = hidden.app.filter(x => x !== id);
  const folder = (homeLayout.folder || []).filter(x => x !== id);
  if (place === 'hidden') hidden.app.push(id);
  if (place === 'folder') folder.push(id);
  homeSaveLayout({ hidden, folder });
}

function homeResetLayout() { homeSaveLayout({ reset: true }); }

function homeChooseMode(wantOn) {
  if (!homeStatus) return;
  if (homeStatus.restorePending) { homeSwitch(); return; }
  if (Boolean(homeStatus.enabled) === Boolean(wantOn)) {
    if (wantOn && !homeStatus.supported.ok) homeSwitch();
    return;
  }
  homeSwitch();
}

// The master switch: one press arms it, a second within five seconds acts.
async function homeSwitch() {
  if (!homeWritable()) return;
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
  const lgBtn = q('home-mode-lg');
  const activeBtn = want === 'off' && !homeStatus.restorePending && lgBtn ? lgBtn : btn;
  if (btn) btn.disabled = true;
  if (lgBtn) lgBtn.disabled = true;
  if (activeBtn) activeBtn.textContent = t('apps.service.updating', 'Updating…');
  try {
    await homePost(want === 'on' ? '/api/home/enable' : '/api/home/disable');
  } catch (e) { showErr(e.message); }
  loadHome();
}

// Hiding LG's Home is what can leave a TV without one, so switching it on takes a second press.
async function homeHideLg() {
  if (!homeWritable()) return;
  const want = !homeStatus.hideLgHomeAtStart;
  if (want && homeArmed !== 'hide') {
    homeArmed = 'hide';
    clearTimeout(homeArmTimer);
    homeArmTimer = setTimeout(() => { homeArmed = null; renderHome(); }, 5000);
    return renderHome();
  }
  homeArmed = null;
  clearTimeout(homeArmTimer);
  homeSaving = true;
  renderHome();
  try {
    await homePost('/api/home/start-layout', { hideLgHomeAtStart: want });
  } catch (e) { showErr(e.message); }
  homeSaving = false;
  loadHome();
}

function homePicture() {
  homeSaveLayout({ picture: homeLayout.picture !== true });
}

// The details Glasshouse Home shows unless switched off, and their toggles.
const HOME_SHOW = [['showClock', 'home-show-clock'], ['showLastOn', 'home-show-last'], ['showAppCount', 'home-show-count'], ['showCec', 'home-show-cec']];

function homeShow(key) {
  homeSaveLayout({ [key]: homeLayout[key] === false });
}

function homeSearch() {
  homeSaveLayout({ search: homeLayout.search !== true });
}

function homeAlternative() {
  homeSaveLayout({ view: homeLayout.view === 'alternative' ? 'standard' : 'alternative' });
}

function homeRowsBottom() {
  homeSaveLayout({ rowsBottom: homeLayout.rowsBottom !== true });
}

function homeFade() {
  homeSaveLayout({ fade: homeLayout.fade !== true });
}

function homeHideUnused() {
  homeSaveLayout({ hideUnused: homeLayout.hideUnused !== true });
}

// Added channels are the Channels row; this finds more to add. Built once, then only its list redraws.
function homeChannelPicker() {
  return `<div class="home-ch-add">
    <div class="prot-row">
      <div class="prot-main"><div class="prot-title">${esc(t('home.ch.addTitle', 'Add channels'))}</div>
        <div class="prot-desc">${esc(t('home.ch.addDesc', 'From those the TV has tuned.'))}</div></div>
      <div class="prot-status" id="home-ch-show"></div>
    </div>
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
  // The button beside the row's title, until the channels have been read.
  const show = q('home-ch-show');
  if (show) show.innerHTML = homeChannels ? '' :
    `<button type="button" class="pill idle" onclick="homeLoadChannels()">${esc(t('home.ch.show', 'Show channels'))}</button>`;
  if (!homeChannels) {
    box.innerHTML = '';
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

// The four wallpapers, by the hours each is shown, as the view picks them
// (home.html): night runs past midnight. sample is the time each preview's
// clock shows.
const HOME_WALL_SLOTS = [
  { key: 'morning', from: 6, to: 11, sample: [8, 30] },
  { key: 'afternoon', from: 11, to: 17, sample: [14, 0] },
  { key: 'evening', from: 17, to: 21, sample: [19, 30] },
  { key: 'night', from: 21, to: 6, sample: [23, 10] }
];
const HOME_WALL_NAMES = () => ({
  morning: t('home.wall.slotMorning', 'Morning'), afternoon: t('home.wall.slotAfternoon', 'Afternoon'),
  evening: t('home.wall.slotEvening', 'Evening'), night: t('home.wall.slotNight', 'Night')
});

// A time in the TV's own hour cycle, as Glasshouse Home shows it.
function homeWallTime(h, m) {
  const mm = String(m || 0).padStart(2, '0');
  if (!homeStatus || !homeStatus.clockHour12) return String(h % 24).padStart(2, '0') + ':' + mm;
  return ((h + 11) % 12 + 1) + ':' + mm + ' ' + (h % 24 < 12 ? t('common.am', 'AM') : t('common.pm', 'PM'));
}

function homeWallNow() {
  const h = new Date().getHours();
  return HOME_WALL_SLOTS.find(w => w.from < w.to ? h >= w.from && h < w.to : h >= w.from || h < w.to).key;
}

function homeWallUrl(key, walls) {
  return api('/api/home/wallpaper?slot=' + key + '&v=' + encodeURIComponent(walls.revision || ''));
}

function renderHomeWalls() {
  const box = q('home-walls');
  if (!box || !homeStatus) return;
  const walls = homeStatus.wallpapers || {};
  const has = walls.slots || {};
  const busy = !homeWritable() || !!homeWallUploading || walls.uploading;
  const names = HOME_WALL_NAMES();
  const now = homeWallNow();
  const c = (homeLayout && homeLayout.colours) || ((homeStatus.colourPresets || [])[0]) || { text: '#ece7df', accent: '#e9ad55' };
  // The owner's own pictures are uploaded to the times of day; a set's are shown as they are.
  const choice = walls.choice || 'own';
  const own = choice === 'own';
  const getting = walls.fetching || (/^set:/.test(homeWallUploading || '') ? homeWallUploading.slice(4) : '');
  const choiceBox = q('home-wall-choice');
  if (choiceBox) {
    const label = { black: t('home.wall.setBlack', 'Black'), landscape: t('home.wall.setLandscape', 'Landscape'),
      abstract: t('home.wall.setAbstract', 'Abstract'), own: t('home.wall.setOwn', 'Your own') };
    choiceBox.innerHTML = (walls.choices || ['black', 'landscape', 'abstract', 'own']).map(name =>
      `<button type="button" class="${name === choice ? 'on' : ''}${name === getting ? ' busy' : ''}" ${busy ? 'disabled' : ''}
        aria-pressed="${name === choice}" onclick="homeWallSet('${name}')">${esc(name === getting ? t('home.wall.examplesBusy', 'Downloading…') : label[name] || name)}</button>`).join('');
  }
  q('home-wall-help').hidden = !own;
  q('home-wall-clear').hidden = !own;
  q('home-wall-clear').disabled = busy || !walls.available;
  clearTimeout(homeWallTimer);
  if (walls.uploading) homeWallTimer = setTimeout(() => { if (activeTab === 'home') loadHome(); }, 2000);

  // The day strip: midnight to midnight, night split at midnight.
  const day = q('home-wall-day');
  if (day) {
    const parts = [['night', 0, 6], ['morning', 6, 11], ['afternoon', 11, 17], ['evening', 17, 21], ['night', 21, 24]];
    const d = new Date();
    const at = (d.getHours() + d.getMinutes() / 60) / 24 * 100;
    day.innerHTML = `<div class="wall-day-bar">${parts.map(([key, from, to]) => `<button type="button" class="wall-day-part${has[key] ? ' has' : ''}${key === now ? ' now' : ''}" data-slot="${key}"
        style="flex:${to - from}${has[key] ? `;background-image:url('${esc(homeWallUrl(key, walls))}')` : ''}"
        ${own ? `onclick="homeWallChoose('${key}')"` : 'tabindex="-1"'} ${busy || !own ? 'disabled' : ''} title="${esc(names[key])}" aria-label="${esc(names[key])}"></button>`).join('')}
      <span class="wall-day-needle" style="left:${at.toFixed(2)}%"><b>${esc(t('home.wall.now', 'Now'))}</b></span></div>
      <div class="wall-day-scale">${[0, 6, 12, 18, 24].map(h => `<span style="left:${h / 24 * 100}%">${esc(homeWallTime(h, 0))}</span>`).join('')}</div>`;
  }

  box.style.setProperty('--look-text', c.text);
  box.style.setProperty('--look-accent', c.accent);
  box.innerHTML = HOME_WALL_SLOTS.map(w => {
    const key = w.key, set = !!has[key];
    const fetching = !!getting;
    const sending = homeWallUploading === key || fetching || (walls.uploading && !homeWallUploading);
    return `<div class="wall-card${set ? ' has' : ''}${key === now ? ' now' : ''}${sending ? ' busy' : ''}${own ? '' : ' fixed'}" data-slot="${key}">
      <button type="button" class="wall-screen" ${own ? `onclick="homeWallChoose('${key}')"` : 'tabindex="-1"'} ${busy || !own ? 'disabled' : ''}
          aria-label="${esc(t('home.wall.choose', 'Choose a picture for {name}', { name: names[key] }))}"
          ${set ? `style="background-image:url('${esc(homeWallUrl(key, walls))}')"` : ''}>
        <span class="wall-clock">${esc(homeWallTime(w.sample[0], w.sample[1]))}</span>
        <span class="wall-row">${esc(t('home.row.apps', 'Apps'))}</span><i></i>
        ${set || !own ? '' : `<span class="wall-add">${esc(t('home.wall.add', 'Add a picture'))}</span>`}
        ${key === now ? `<span class="wall-badge">${esc(t('home.wall.now', 'Now'))}</span>` : ''}
        ${sending ? `<span class="wall-sending">${esc(fetching ? t('home.wall.examplesBusy', 'Downloading…') : t('home.wall.uploading', 'Uploading…'))}</span>` : ''}
      </button>
      <div class="wall-meta">
        <span class="wall-name">${esc(names[key])}</span>
        <span class="wall-hours">${esc(homeWallTime(w.from, 0))} – ${esc(homeWallTime(w.to, 0))}</span>
      </div>
      <div class="wall-actions">${set && own ? `<button type="button" class="wall-link" onclick="homeWallChoose('${key}')" ${busy ? 'disabled' : ''}>${esc(t('home.wall.replace', 'Replace'))}</button>
        <button type="button" class="wall-link" onclick="homeWallRemove('${key}')" ${busy ? 'disabled' : ''}>${esc(t('home.wall.remove', 'Remove'))}</button>`
        : ''}</div>
    </div>`;
  }).join('');
  // An image dropped on a time of day, or on its part of the strip, is its picture.
  document.querySelectorAll('#home-walls .wall-screen, #home-wall-day .wall-day-part').forEach(el => {
    const slot = el.closest('[data-slot]').dataset.slot;
    el.addEventListener('dragover', e => { if (busy || !own) return; e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file && !busy && own) homeUploadWall(slot, file);
    });
  });
}

let homeWallSlot = null;
function homeWallChoose(key) {
  if (!homeWritable() || homeWallUploading) return;
  homeWallSlot = key;
  const input = q('home-wall-file');
  input.value = '';
  input.click();
}

function homeWallPicked(input) {
  const file = input.files[0];
  if (file && homeWallSlot) homeUploadWall(homeWallSlot, file);
}

async function homeUploadWall(slot, file) {
  if (!file || !homeWritable() || homeWallUploading) return;
  const note = q('home-wall-upload-note');
  homeWallUploading = slot;
  note.textContent = '';
  renderHomeWalls();
  let url;
  try {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) {
      throw new Error(t('home.wall.chooseImage', 'Choose a JPEG, PNG or WebP image up to 25 MB.'));
    }
    url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t('home.wall.unreadable', 'The image could not be opened.')));
      img.src = url;
    });
    // Glasshouse Home is drawn at 1920 x 1080; the server refuses anything larger.
    const scale = Math.min(1, 1920 / img.naturalWidth, 1080 / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob || blob.size > 5 * 1024 * 1024) throw new Error(t('home.wall.tooLarge', 'The prepared image is too large. Choose a smaller image.'));
    const res = await fetch(api('/api/home/wallpapers/upload?slot=' + slot), {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob
    });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error(r.error || t('home.wall.uploadFailed', 'The image could not be uploaded.'));
    note.textContent = t('home.wall.uploadDone', 'Image uploaded. Home updates within a few seconds.');
  } catch (e) { note.textContent = e.message; }
  finally {
    if (url) URL.revokeObjectURL(url);
    homeWallUploading = false;
    await loadHome();
    renderHomeWalls();
  }
}

async function homeWallRemove(key) {
  if (!homeWritable() || homeWallUploading) return;
  q('home-wall-upload-note').textContent = '';
  try { await homePost('/api/home/wallpapers', { remove: key }); }
  catch (e) { q('home-wall-upload-note').textContent = e.message; }
  await loadHome();
}

// Black, a picture set, or the owner's own pictures; a set is downloaded to the
// TV the first time it is chosen.
async function homeWallSet(name) {
  if (!homeWritable() || homeWallUploading) return;
  const note = q('home-wall-upload-note');
  note.textContent = '';
  homeWallUploading = 'set:' + name;
  renderHomeWalls();
  try { await homePost('/api/home/wallpapers', { choose: name }); }
  catch (e) { note.textContent = e.message; }
  finally {
    homeWallUploading = false;
    await loadHome();
    renderHomeWalls();
  }
}

async function homeClearUploads() {
  if (!homeWritable() || homeWallUploading) return;
  q('home-wall-upload-note').textContent = '';
  try { await homePost('/api/home/wallpapers', { removeUploads: true }); }
  catch (e) { q('home-wall-upload-note').textContent = e.message; }
  await loadHome();
}
