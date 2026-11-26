// The Home tab: Glasshouse Home, a home screen of Glasshouse's own in place of LG's.

let homeStatus = null;
let homeLauncherActive = false;
let homeCat = null;      // what the TV's Home lists: apps, devices, picked channels, order
let homeLayout = null;
let homeChannels = null; // the TV's whole channel list, for picking
let homeArmed = null;    // the control waiting for its second press: 'hide'
let homeArmTimer = null;
let homeSaving = false;
let homeLoadRevision = 0;
let homeWallTimer = null;
let homeWallUploading = false;
// null until the server says; false on a TV Glasshouse Home is not offered on.
let homeAvailable = null;
// The Custom launcher section, shown while one is kept or once its button is pressed.
let homeLauncherOpen = false;
let homeLauncherBusy = false;

const HOME_ROWS = {
  app: () => t('home.row.apps', 'Apps'),
  dev: () => t('home.row.inputs', 'Inputs'),
  ch: () => t('home.row.channels', 'Channels'),
  rec: () => t('home.row.recommended', 'Recommended'),
  iptv: () => t('home.row.iptv', 'Internet TV'),
  ha: () => t('home.row.ha', 'Home Assistant')
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
  homeLauncherActive = !!(st.enabled || (st.bar && st.bar.enabled));
  if (q('tab-btn-home')) q('tab-btn-home').hidden = !homeAvailable;
  if (typeof renderInputs === 'function') renderInputs();
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
  await homeTvLoad();
  setHomeAvailable(homeStatus);
  if (!homeAvailable && activeTab === 'home') return showTab('control');
  renderHome();
  if (typeof renderInputs === 'function') renderInputs();
}

function homeWritable() { return !!(!homeSaving && homeStatus && (homeStatus.supported.ok || homeStatus.enabled || homeStatus.restorePending) && homeStatus.writable !== false); }

// The Home customisation section, whichever Home is the TV's: Open Home at
// power-on wherever LG has it, Glasshouse Home's own options while it is on,
// LG's Home's layout while that is, and hidden system apps, which apply to
// either Home.
// A launcher of the owner's own is the TV's Home, in Glasshouse Home's place.
function homeLauncherOn() {
  const st = homeStatus;
  return !!(st && st.enabled && st.launchers && st.launchers.chosen);
}

// Every launcher on offer, Minimal among them.
function homeLaunchersAll() {
  return (homeStatus && homeStatus.launchers && homeStatus.launchers.launchers) || [];
}

// Those of the owner's own, which the Custom launcher section lists.
function homeLaunchersKept() {
  return homeLaunchersAll().filter(l => l.source !== 'builtin');
}

function homeLauncherChosen() {
  const id = homeStatus && homeStatus.launchers && homeStatus.launchers.chosen;
  return homeLaunchersAll().filter(l => l.id === id)[0] || null;
}

let homeSubView = 'rows';

function setHomeSubView(view) {
  homeSubView = view || 'rows';
  syncHomeSubView();
}

function syncHomeSubView() {
  const pane = q('homepane');
  const nav = q('home-subnav');
  const box = q('home-custom');
  const useSubnav = !!(box && !box.classList.contains('lg-home') && !homeBarOn());
  if (nav) {
    nav.hidden = !useSubnav;
    const btns = nav.querySelectorAll('button[data-home-view]');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-home-view') === homeSubView);
    }
  }
  if (pane) {
    if (useSubnav) pane.setAttribute('data-home-view', homeSubView);
    else pane.removeAttribute('data-home-view');
  }
}

function renderHomeCustom(autoVal) {
  const st = homeStatus;
  const lg = st.lgHome;
  const inPlace = !!(st.enabled && st.supported.ok);
  const glasshouseOn = inPlace && !homeLauncherOn();
  const box = q('home-custom');
  if (box) {
    box.classList.toggle('lg-home', !glasshouseOn);
    box.classList.toggle('for-bar', homeBarOn());
  }
  const layout = q('disc-homescreen');
  const tiles = q('disc-system-tiles');
  if (tiles) tiles.hidden = !lg;
  if (lg) {
    renderHomeScreen(lg);
    renderSystemTiles(lg);
  }
  if (layout && (!lg || inPlace)) layout.hidden = true;
  const more = q('home-more');
  if (box) box.hidden = !(glasshouseOn || (more && !more.hidden) || autoVal !== undefined || (layout && !layout.hidden) || (tiles && !tiles.hidden));
  syncHomeSubView();
}

function homePreviewTiles(count) {
  if (!homeCat || !homeCat.apps || !homeCat.order || !homeCat.order.app) return [];
  const hidden = new Set((homeLayout && homeLayout.hidden && homeLayout.hidden.app) || []);
  const folder = new Set((homeLayout && homeLayout.folder) || []);
  const byId = new Map(homeCat.apps.map(a => [a.id, a]));
  const out = [];
  for (const id of homeCat.order.app) {
    if (id === 'lg-home' || hidden.has(id) || folder.has(id)) continue;
    const app = byId.get(id);
    if (app) out.push(app);
    if (out.length >= count) break;
  }
  return out;
}

function renderLauncherPreview(kind, st) {
  const clock = st && st.clockHour12 ? '9:40' : '21:40';
  if (kind === 'lg') {
    return `<span class="hm-s hm-s-lg">
      <span class="hm-lg-top"><i></i><i></i><i></i></span>
      <span class="hm-lg-hero"><span></span><span></span></span>
      <span class="hm-lg-cards"><i></i><i></i><i></i><i></i></span>
      <span class="hm-lg-apps"><i class="a1"></i><i class="a2"></i><i class="a3"></i><i class="a4"></i><i class="a5"></i><i class="a6"></i></span>
    </span>`;
  }
  if (kind === 'gh') {
    const presets = (st && st.colourPresets) || [];
    const c = (homeLayout && homeLayout.colours) || homeOwnLook(presets) || { text: '#ece7df', accent: '#e9ad55' };
    const alt = !!(homeLayout && homeLayout.view === 'alternative');
    const hl = (homeLayout && homeLayout.tileHighlight) || homeHighlightDefault();
    const bottom = !!(homeLayout && homeLayout.rowsBottom);
    const preview = !!(homeLayout && homeLayout.livePreview);
    const showClock = !homeLayout || homeLayout.showClock !== false;
    const apps = homePreviewTiles(4);
    const tiles = [0, 1, 2, 3].map(i => {
      const app = apps[i];
      const cls = `hm-gh-tile${i === 0 ? ' focus' : ''}`;
      return app && app.icon
        ? `<span class="${cls}"><img src="${esc(api(app.icon))}" alt=""></span>`
        : `<span class="${cls}"><i class="hm-gh-glyph"></i></span>`;
    }).join('');
    const inputs = [0, 1, 2].map(() => `<span class="hm-gh-tile inp"><i></i></span>`).join('');
    return `<span class="hm-s hm-s-gh${alt ? ' alt' : ''}${bottom ? ' bottom' : ''}" style="--look-text:${c.text};--look-accent:${c.accent};--look-highlight:${hl}">
      <span class="hm-gh-head">
        ${showClock ? `<span class="hm-gh-clock">${clock}</span>` : '<span></span>'}
        ${preview ? `<span class="hm-gh-pip"><i></i></span>` : ''}
      </span>
      <span class="hm-gh-rows">
        <span class="hm-gh-lbl">${esc(t('home.row.apps', 'Apps'))}</span>
        <span class="hm-gh-row">${tiles}</span>
        <span class="hm-gh-lbl">${esc(t('home.row.inputs', 'Inputs'))}</span>
        <span class="hm-gh-row">${inputs}</span>
      </span>
    </span>`;
  }
  if (kind === 'minimal') {
    return `<span class="hm-s hm-s-minimal">
      <span class="hm-min-clock">${clock}</span>
      <span class="hm-min-tabs"><span class="on">${esc(t('home.row.apps', 'Apps'))}</span><span>${esc(t('home.row.inputs', 'Inputs'))}</span></span>
      <span class="hm-min-list"><i class="on"></i><i></i><i></i><i></i></span>
    </span>`;
  }
  if (kind === 'bar') {
    const apps = homePreviewTiles(4);
    const tiles = [0, 1, 2, 3].map(i => {
      const app = apps[i];
      const cls = `hm-bar-tile${i === 0 ? ' focus' : ''}`;
      return app && app.icon
        ? `<span class="${cls}"><img src="${esc(api(app.icon))}" alt=""></span>`
        : `<span class="${cls}"><i></i></span>`;
    }).join('');
    return `<span class="hm-s hm-s-bar">
      <span class="hm-bar-scene"></span>
      <span class="hm-bar-shade"></span>
      <span class="hm-bar-clock">${clock}</span>
      <span class="hm-bar-dock">
        ${tiles}
        <span class="hm-bar-gap"></span>
        <span class="hm-bar-tile inp now"><i></i></span>
      </span>
    </span>`;
  }
  const own = homeLaunchersKept().find(l => l.id === 'own');
  let label = '&lt;/&gt;';
  if (own) {
    if (own.kind === 'web' && own.address) {
      try { label = esc(new URL(own.address).host); } catch (e) { label = esc(own.address); }
    } else {
      label = esc(own.title || 'Custom');
    }
  }
  return `<span class="hm-s hm-s-custom${own ? ' has' : ''}">
    <span class="hm-cus-win">
      <span class="hm-cus-bar"><i></i><i></i><i></i></span>
      <span class="hm-cus-body">
        <span class="hm-cus-tag">${label}</span>
        <span class="hm-cus-blocks"><i></i><i></i><i></i></span>
      </span>
    </span>
  </span>`;
}

function renderHome() {
  const st = homeStatus;
  const desc = q('home-state-desc');
  const btn = q('home-switch');
  if (!st || !desc) return;
  // A TV without Glasshouse Home (a B8) has the tab for LG's Home's options alone.
  const glasshouse = st.supported.ok || st.enabled || st.restorePending;
  const hero = q('home-hero');
  if (hero) hero.hidden = !glasshouse;
  // webOS 5 and 6, where each switch restarts the TV's app manager.
  const restartNote = q('home-restart-note');
  if (restartNote) restartNote.hidden = !st.supported.restartsApps;
  if (st.restorePending) {
    desc.textContent = t('home.restoreRetry', 'Retry restoring LG Home before switching Glasshouse Home on again.');
  } else if (!st.supported.ok) {
    desc.textContent = st.supported.reason || '';
  } else if (homeLauncherOn()) {
    const title = homeLauncherChosen().title;
    desc.textContent = st.lgHomeOpen
      ? t('home.launcher.isOnLgOpenTitle', 'LG’s Home is open for now. {title} comes back when something else is opened, or Home is pressed.', { title })
      : t('home.launcher.isOnDescTitle', '{title} opens in LG’s Home’s place: with the Home and Back buttons, and when the TV wakes on Home.', { title });
  } else if (homeBarOn()) {
    desc.textContent = t('home.bar.isOnDesc', 'The Home button opens a row of your apps and inputs over the picture; Back or Home closes it. LG’s Home stays in its place, and its tile is at the end of the apps.');
  } else if (st.enabled) {
    desc.textContent = st.lgHomeOpen
      ? t('home.isOnLgOpen', 'LG’s Home is open for now. Glasshouse Home comes back when something else is opened, or Home is pressed.')
      : st.active
        ? t('home.isOnDesc', 'It opens in LG’s Home’s place: with the Home and Back buttons, and when the TV wakes on Home.')
        : t('home.isOnPending', 'Switched on, but LG’s Home is still in its place. Switching off and on again tries once more.');
  } else {
    desc.textContent = '';
  }
  desc.hidden = !desc.textContent;
  desc.className = 'pv-sub' + ((st.restorePending || (st.enabled && !st.active && !st.lgHomeOpen)) ? ' warn' : '');
  const exp = q('home-exp');
  if (exp) exp.hidden = !st.supported.ok || !(st.enabled || homeLauncherOpen);
  const notes = q('home-notes');
  if (notes) notes.hidden = desc.hidden && (!restartNote || restartNote.hidden) && (!exp || exp.hidden);
  const more = q('home-more');
  if (more) {
    // Glasshouse Bar shows the same Apps and Inputs rows as a launcher does.
    more.hidden = !st.supported.ok || !(st.enabled || homeBarOn());
    more.classList.toggle('for-launcher', homeLauncherOn() || homeBarOn());
    more.classList.toggle('for-bar', homeBarOn());
  }
  renderHomeLauncher();
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
  const previewRow = q('home-preview-row');
  if (previewRow) previewRow.hidden = !st.supported.ok;
  const previewPill = q('home-preview');
  if (previewPill) {
    const on = !!st.layout && st.layout.livePreview === true;
    updateToggle(previewPill, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    previewPill.disabled = !homeWritable();
  }
  // Its options, while it is on.
  // Omitted on webOS 3 and 4 (a B8, 4.4.3), where Live preview plays but the
  // last two do not and sound was not tried; webOS 5 and 6 also run standalone.
  const previewOptionsOff = st.supported.previewOptions === false || (st.supported.standalone === true && !st.supported.webos);
  [['home-preview-sound', 'previewSound'], ['home-preview-always', 'previewAlways'], ['home-preview-tile', 'previewInTile']].forEach(([id, field]) => {
    const row = q(id + '-row');
    if (row) row.hidden = !st.supported.ok || previewOptionsOff || !st.layout || st.layout.livePreview !== true;
    const btn = q(id);
    if (!btn) return;
    const on = !!st.layout && st.layout[field] === true;
    updateToggle(btn, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    btn.disabled = !homeWritable();
  });
  // Its size, while it is on and beside the clock. Plain CSS, so offered on every webOS.
  const sizeRow = q('home-preview-size-row');
  if (sizeRow) sizeRow.hidden = !st.supported.ok || !st.layout || st.layout.livePreview !== true || st.layout.previewInTile === true;
  // Not offered with no remote paired, or one whose battery cannot be read.
  const batteryRow = q('home-remote-battery-row');
  if (batteryRow) batteryRow.hidden = !st.supported.ok || st.remoteBatteryAvailable === false;
  const batterySel = q('home-remote-battery-sel');
  if (batterySel) {
    batterySel.value = (st.layout && st.layout.remoteBattery) || 'low';
    batterySel.disabled = !homeWritable();
  }
  const sizeSel = q('home-preview-size-sel');
  if (sizeSel) {
    sizeSel.value = (st.layout && st.layout.previewSize) || 'small';
    sizeSel.disabled = !homeWritable();
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
  HOME_OPT_IN.forEach(([key, id]) => {
    const el = q(id);
    if (!el) return;
    const on = !!st.layout && st.layout[key] === true;
    updateToggle(el, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    el.disabled = !homeWritable();
  });
  const soundSel = q('home-nav-sound-sel');
  if (soundSel) {
    soundSel.value = (st.layout && st.layout.navSound) || 'off';
    soundSel.disabled = !homeWritable();
    renderHomeNavSound(st);
  }
  const pointerSel = q('home-pointer-sound-sel');
  if (pointerSel) {
    const pointerName = (st.layout && st.layout.pointerSound) || 'off';
    pointerSel.value = pointerName;
    // Not shown with no Magic Remote paired to point, and unavailable while the pointer is switched off.
    const noPointer = st.layout && st.layout.showPointer === false;
    q('home-pointer-sound-row').hidden = !st.supported.ok || st.remoteBatteryAvailable === false;
    pointerSel.disabled = !homeWritable() || noPointer;
    q('home-pointer-sound-play').disabled = noPointer || pointerName === 'off' || (pointerName === 'own' && !(st.layout && st.layout.ownSound));
  }
  const fadeSel = q('home-card-fade-sel');
  if (fadeSel) {
    fadeSel.value = String(st.layout && typeof st.layout.cardFade === 'number' ? st.layout.cardFade : 20);
    fadeSel.disabled = !homeWritable() || !(st.layout && st.layout.appCards === true);
  }
  loadHomeCardIcons();
  renderHomeWeather(st);
  renderHomeInfo(st);
  renderHomeBoard(st);
  renderHomeNews(st);
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
  // On unless switched off, and for webOS 11 only.
  const wakeRow = q('home-reopen-wake-row');
  if (wakeRow) wakeRow.hidden = !st.supported.ok || !(parseInt(st.supported.webos, 10) >= 11);
  const wakeBtn = q('home-reopen-wake');
  if (wakeBtn) {
    const on = !st.layout || st.layout.reopenAfterWake !== false;
    updateToggle(wakeBtn, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    wakeBtn.disabled = !homeWritable();
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
  HOME_MOTION.forEach(key => {
    const btn = q('home-motion-' + key);
    if (!btn) return;
    btn.closest('.prot-row').hidden = !st.supported.ok;
    const on = !st.layout || st.layout[key] !== false;
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
  const barHaRow = q('home-bar-habar-row');
  if (barHaRow) barHaRow.hidden = !homeBarOn() || !st.haBarAvailable;
  const barHaBtn = q('home-bar-habar');
  if (barHaBtn) {
    const on = !!st.layout && st.layout.haBarInHomeBar === true;
    updateToggle(barHaBtn, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off'), on });
    barHaBtn.disabled = !homeWritable();
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
  /*
   * The choice of launcher: each as a 16:9 miniature TV screen with its name
   * and a short line beneath. The active one carries a badge on the screen
   * itself so the launcher's name stays visible.
   */
  const lgBtn = q('home-mode-lg');
  const chosenId = homeLauncherOn() ? st.launchers.chosen : null;
  const inUse = t('ss.inUse', 'In use');
  const ownKept = homeLaunchersKept().find(l => l.id === 'own');
  let customSub = t('home.customShort', 'Your own web app or page');
  if (ownKept) {
    if (ownKept.kind === 'web' && ownKept.address) {
      try { customSub = new URL(ownKept.address).host; } catch (e) { customSub = ownKept.address; }
    } else {
      customSub = ownKept.title || customSub;
    }
  }
  const choice = (el, kind, name, sub, on, hidden, disabled) => {
    if (!el) return;
    el.hidden = hidden;
    el.disabled = disabled;
    el.className = 'hm-card' + (on ? ' on' : '');
    el.innerHTML = `<span class="hm-screen">
        ${renderLauncherPreview(kind, st)}
        <span class="hm-badge"${on ? '' : ' hidden'}>${on ? esc(inUse) : ''}</span>
      </span>
      <span class="hm-meta">
        <span class="hm-name">${esc(name)}</span>
        <span class="hm-sub">${esc(sub)}</span>
      </span>`;
  };
  const cardBusy = !homeWritable() || homeLauncherBusy;
  if (btn) {
    if (st.restorePending) {
      if (lgBtn) lgBtn.hidden = true;
      choice(btn, 'gh', t('home.retryRestore', 'Retry restoring LG Home'), t('home.restorePending', 'LG Home restoration is incomplete'), false, false, cardBusy);
    } else {
      choice(lgBtn, 'lg', t('home.lgHome', 'LG Home'), t('home.lgHomeShort', 'LG\u2019s built-in home screen'), !st.enabled && !homeBarOn(), false, cardBusy);
      choice(btn, 'gh', t('home.title', 'Glasshouse Home'), t('home.ghShort', 'Clock, rows, wallpapers & preview'), st.enabled && !chosenId, false, cardBusy);
    }
  }
  const unavailable = !!st.restorePending || !st.supported.ok;
  choice(q('home-mode-minimal'), 'minimal', t('home.minimalName', 'Glasshouse Minimal'), t('home.minimalShort', 'Plain text lists on black'), chosenId === 'minimal',
    unavailable || !homeLaunchersAll().some(l => l.id === 'minimal'), cardBusy);
  // Offered where the input bar is: both are overlays over the picture.
  choice(q('home-mode-bar'), 'bar', t('home.bar.name', 'Glasshouse Bar'), t('home.bar.short', 'Bottom bar over the picture'), homeBarOn(),
    !st.bar || !st.bar.offered || !!st.restorePending, cardBusy);
  choice(q('home-mode-launcher'), 'custom', t('home.custom', 'Custom'), customSub, !!chosenId && chosenId !== 'minimal',
    unavailable, cardBusy);
  renderHomeCompat(st);
  const hist = q('home-history-note');
  if (hist) hist.hidden = st.history;
  renderHomeRows();
  renderHomeTv();
  renderHomeRecents();
  renderHomeChannels();
  renderHomeWalls();
  renderHomeColours();
  if (!homeDarkDragging) showHomeDarkening(homeLayout && typeof homeLayout.darkening === 'number' ? homeLayout.darkening : 100);
  const darkWrap = q('home-dark-wrap');
  if (darkWrap) darkWrap.classList.toggle('disabled', !homeWritable());
  q('home-reset').disabled = !homeWritable();
  homeGroupsShown();
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

// What a fresh Glasshouse Home starts with, the first preset (Pure white).
function homeDefaultLook() {
  const p = ((homeStatus && homeStatus.colourPresets) || [])[0];
  return p ? { text: p.text, accent: p.accent } : { text: '#ffffff', accent: '#ffffff' };
}

// The view's own look, saved as no colours chosen.
function homeOwnLook(presets) { return presets.find(p => p.own) || presets[0] || null; }

// The preset matching the chosen colours, the view's own when none are chosen, or null for custom ones.
function homeLookNow() {
  const presets = (homeStatus && homeStatus.colourPresets) || [];
  const c = homeLayout && homeLayout.colours;
  if (!c) return homeOwnLook(presets);
  return presets.find(p => p.text === c.text && p.accent === c.accent) || null;
}

// The view's built-in tile highlight colour when none is chosen.
function homeHighlightDefault() {
  return '#141310';
}

// Each preset as a small Glasshouse Home: the clock in its text, a row's name in the quieter shade, the accent's mark.
function renderHomeColours() {
  const box = q('home-looks');
  if (!box || !homeStatus) return;
  const presets = homeStatus.colourPresets || [];
  const names = HOME_LOOK_NAMES();
  const now = homeLookNow();
  const can = homeWritable() && !homeSaving;
  // The view's own look is saved as none chosen.
  // The sample clock in each preview is a fixed time, in the TV's own hour
  // cycle.
  const lookClock = homeStatus.clockHour12 ? `9:40 ${t('common.pm', 'PM')}` : '21:40';
  box.innerHTML = presets.map((p, i) => `<button type="button" class="home-look${now && now.id === p.id ? ' picked' : ''}"
      onclick="homeSaveLayout({ colours: ${p.own ? 'null' : `{ text: '${p.text}', accent: '${p.accent}' }`} })" ${can ? '' : 'disabled'}
      aria-pressed="${now && now.id === p.id}" style="--look-text:${p.text};--look-accent:${p.accent}">
      <span class="home-look-screen"><span class="home-look-clock">${lookClock}</span><span class="home-look-row">${esc(t('home.row.apps', 'Apps'))}</span><i></i></span>
      <span class="home-look-name">${esc(names[p.id] || p.id)}</span>
    </button>`).join('');
  const c = (homeLayout && homeLayout.colours) || homeOwnLook(presets) || { text: '#ece7df', accent: '#e9ad55' };
  const text = q('home-col-text'), accent = q('home-col-accent'), hl = q('home-col-highlight');
  if (text && document.activeElement !== text) text.value = c.text;
  if (accent && document.activeElement !== accent) accent.value = c.accent;
  const hlNow = (homeLayout && homeLayout.tileHighlight) || homeHighlightDefault();
  if (hl && document.activeElement !== hl) hl.value = hlNow;
  [text, accent, hl].forEach(el => { if (el) el.disabled = !can; });
  const reset = q('home-col-reset');
  const fresh = homeDefaultLook(), cur = homeLayout && homeLayout.colours;
  const hasHl = !!(homeLayout && homeLayout.tileHighlight);
  if (reset) reset.disabled = !can || (!hasHl && !!(cur && cur.text === fresh.text && cur.accent === fresh.accent));
}

// The animated background's colour presets, each as a small screen with a
// band of its light; shown while an animated background is chosen.
function HOME_ANIM_THEME_NAMES() {
  return { auto: t('home.animTheme.auto', 'Time of day'), blue: t('home.animTheme.blue', 'Night blue'),
    sunset: t('home.animTheme.sunset', 'Sunset'), emerald: t('home.animTheme.emerald', 'Emerald'),
    ember: t('home.animTheme.ember', 'Ember'), silver: t('home.animTheme.silver', 'Silver'),
    custom: t('home.animTheme.custom', 'Your own') };
}

function renderHomeAnimColours(lay, anim) {
  const wrap = q('home-anim-colours'), box = q('home-anim-themes');
  if (!wrap || !box) return;
  wrap.hidden = !lay || anim === 'off';
  if (wrap.hidden) return;
  const names = HOME_ANIM_THEME_NAMES();
  const now = lay.animTheme || 'auto';
  const can = homeWritable() && !homeSaving;
  const sample = th => th.sky
    ? `background:linear-gradient(#000,${th.sky})`
    : 'background:linear-gradient(90deg,#3a1a10,#0b3456 35%,#2a0f40 70%,#0a1a4a)';
  const line = th => th.light || '#7fb4ff';
  const themes = (lay.animThemes || []).concat([{ id: 'custom', sky: lay.animSky, light: lay.animLight }]);
  box.innerHTML = themes.map(th => `<button type="button" class="home-look${now === th.id ? ' picked' : ''}"
      onclick="homeSaveLayout({ animTheme: '${th.id}' })" ${can ? '' : 'disabled'} aria-pressed="${now === th.id}"
      style="--look-text:${line(th)}">
      <span class="home-look-screen" style="${sample(th)}"><span class="home-anim-band" style="background:${line(th)}"></span></span>
      <span class="home-look-name">${esc(names[th.id] || th.id)}</span>
    </button>`).join('');
  const sky = q('home-anim-sky'), light = q('home-anim-light');
  if (sky && document.activeElement !== sky) sky.value = lay.animSky || '#0a1f5c';
  if (light && document.activeElement !== light) light.value = lay.animLight || '#4f8dff';
  [sky, light].forEach(el => { if (el) el.disabled = !can; });
}

function homeAnimCustom() {
  homeSaveLayout({ animTheme: 'custom', animSky: q('home-anim-sky').value, animLight: q('home-anim-light').value });
}

function homeCustomColours() {
  homeSaveLayout({ colours: { text: q('home-col-text').value, accent: q('home-col-accent').value } });
}

function homeCustomHighlight() {
  homeSaveLayout({ tileHighlight: q('home-col-highlight').value });
}

function homeItem(kind, id) {
  const customApp = kind === 'app' && homeLayout && homeLayout.appNames && homeLayout.appNames[id];
  if (kind === 'app' && id === 'lg-home') {
    const def = t('home.lgHome', 'LG Home');
    return { title: customApp || def, defTitle: def, lg: true };
  }
  if (kind === 'iptv') {
    const tv = (homeCat.iptv || []).find(x => x.id === id);
    if (!tv) return null;
    const showLogos = !homeLayout || homeLayout.showTvLogos !== false;
    return { title: tv.name, icon: showLogos ? tv.logo : '', sub: tv.missing ? t('home.tv.gone', 'Not in the playlist any more') : tv.group };
  }
  const list = kind === 'app' ? homeCat.apps : homeCat.channels;
  const it = list.find(x => x.id === id);
  if (!it) return null;
  if (kind === 'ch') return { title: it.number + ' ' + it.name };
  if (kind === 'app') {
    const defTitle = it.defaultTitle || it.title;
    return { title: customApp || defTitle, defTitle, icon: it.icon };
  }
  return { title: it.title, icon: it.icon };
}

function renderHomeRows() {
  const box = q('home-rows');
  if (!box || !homeCat) return;
  const active = document.activeElement;
  if (active && active.closest && active.closest('#home-rows') && active.classList.contains('home-app-name')) return;
  const usable = homeWritable();
  const editable = !homeStatus || homeStatus.writable !== false;
  // Redrawing after each change keeps the rows that were open, and what was typed in the channel search.
  const open = box.children.length ? [...box.querySelectorAll('details[open]')].map(d => d.dataset.kind) : [];
  const filter = q('home-ch-filter') ? q('home-ch-filter').value : '';
  const haAvail = !!(homeStatus && homeStatus.haBarAvailable);
  const visibleRows = homeLayout.rows.map((kind, ri) => ({ kind, ri })).filter(x => x.kind !== 'ha' || haAvail);
  box.innerHTML = visibleRows.map(({ kind, ri }, vi) => {
    // A hidden row leaves the view whatever its tiles; arranging on the TV still shows it.
    const rowOff = kind === 'ha' ? homeLayout.haRow !== true : (homeLayout.hiddenRows || []).includes(kind);
    const toggleRowFn = kind === 'ha' ? 'homeToggleHaRow()' : `homeToggleRow('${kind}')`;
    const rowMove = `<span class="home-row-move">
          ${renderToggle({ cls: rowOff ? 'idle' : 'good', label: rowOff ? t('home.hidden', 'Hidden') : t('home.shown', 'Shown'),
            on: !rowOff, disabled: !usable, onclick: `event.preventDefault(); ${toggleRowFn}` })}
          <button type="button" class="pill idle" ${usable && vi > 0 ? '' : 'disabled'} onclick="event.preventDefault(); homeMoveRow(${ri}, -1)">${esc(t('home.rowUp', 'Row up'))}</button>
          <button type="button" class="pill idle" ${usable && vi < visibleRows.length - 1 ? '' : 'disabled'} onclick="event.preventDefault(); homeMoveRow(${ri}, 1)">${esc(t('home.rowDown', 'Row down'))}</button>
        </span>`;
    // The Home Assistant row shares habar.json; entity management lives on the HA & MQTT tab.
    if (kind === 'ha') {
      const haDesc = t('home.haRowDesc', 'Controls {n} entities from the Home Assistant bar.', { n: (homeStatus && homeStatus.haBarCount) || 0 });
      return `<div class="home-row" data-kind="ha"><div class="home-row-head"><span class="prot-title">${esc(HOME_ROWS.ha())}</span>${rowMove}</div><div class="sub" style="padding:2px 0 6px">${esc(haDesc)} <a href="?tab=mqtt" onclick="event.preventDefault(); showTab('mqtt');">${esc(t('home.haRowEdit', 'Edit on HA & MQTT'))}</a></div></div>`;
    }
    // The apps' cards come and go with their lists, so the row has its switch rather than tiles.
    if (kind === 'rec') {
      return `<details class="home-row" data-kind="rec"${open.includes('rec') ? ' open' : ''}>
      <summary><span class="prot-title">${esc(HOME_ROWS.rec())}</span>${rowMove}</summary>
      <div class="prot-table">${homeRecRow(usable)}</div>
    </details>`;
    }
    // Inputs are configured on the Inputs tab; only row order and visibility stay here.
    if (kind === 'dev') {
      return `<div class="home-row" data-kind="dev"><div class="home-row-head"><span class="prot-title">${esc(HOME_ROWS.dev())}</span>${rowMove}</div></div>`;
    }
    const order = homeCat.order[kind] || [];
    // A Last opened row is in the order the server sends; moving a tile means choosing Your order first.
    const recent = homeSort(kind) === 'recent';
    const movable = usable && !recent;
    const tiles = order.map((id, i) => {
      const it = homeItem(kind, id);
      if (!it) return '';
      // A custom launcher offers LG's Home in its own way, not as a tile from this row.
      if (id === 'lg-home' && homeLauncherOn()) return '';
      const hidden = kind !== 'ch' && homeLayout.hidden[kind].includes(id);
      const folded = kind === 'app' && (homeLayout.folder || []).includes(id);
      const cardButton = kind === 'app' && it.lg !== true && homeLayout.appCards === true;
      const icon = cardButton ? homeCardIconButton(id, it, editable)
        : it.icon ? `<img class="rk-ico" src="${esc(api(it.icon))}" alt="">` : '';
      const titleHtml = kind === 'app'
        ? `<input type="text" class="inp-name inp-name-in home-app-name" translate="no" maxlength="60" value="${esc(it.title)}" placeholder="${esc(it.defTitle)}" data-app-name="${esc(id)}" data-cur="${esc(it.title)}" data-def="${esc(it.defTitle)}" aria-label="${esc(t('home.appNameLabel', 'App name'))}" ${editable ? '' : 'disabled'} onkeydown="homeAppNameKey(event, this)" onblur="homeRenameApp(this)">`
        : `<span translate="no">${esc(it.title)}</span>`;
      return `<div class="prot-row home-tile${hidden || folded ? ' home-hidden' : ''}">
        <div class="prot-main"><div class="prot-title">${icon}${titleHtml}</div>
          ${it.sub ? `<div class="prot-desc">${esc(it.sub)}</div>` : ''}</div>
        <div class="prot-status">
          <button type="button" class="pill idle home-move" ${movable && i > 0 ? '' : 'disabled'} onclick="homeMoveTile('${kind}', ${i}, -1)" aria-label="${esc(t('home.earlier', 'Earlier'))}">↑</button>
          <button type="button" class="pill idle home-move" ${movable && i < order.length - 1 ? '' : 'disabled'} onclick="homeMoveTile('${kind}', ${i}, 1)" aria-label="${esc(t('home.later', 'Later'))}">↓</button>
          ${kind === 'app' ? homePlaceSelect(id, hidden, folded, usable) :
            kind === 'iptv' ? `<button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeTvRemoveFromRow('${jsq(id)}')">${esc(t('home.ch.remove', 'Remove'))}</button>` :
            kind === 'ch' ? `<button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeToggleChannel('${jsq(id)}')">${esc(t('home.ch.remove', 'Remove'))}</button>` :
            renderToggle({ cls: hidden ? 'idle' : 'good', label: hidden ? t('home.hidden', 'Hidden') : t('home.shown', 'Shown'),
              disabled: !usable, onclick: `homeToggleTile('${kind}', '${jsq(id)}')` })}
        </div></div>`;
    }).join('');
    const labelsOn = !homeLayout || homeLayout.showAppLabels !== false;
    const barLabelsRow = kind === 'app' ? `<div class="prot-row home-bar-only">
      <div class="prot-main"><div class="prot-title">${esc(t('home.showAppLabels', 'App labels'))}</div>
        <div class="prot-desc">${esc(t('home.showAppLabelsDesc', 'Under each app icon on Glasshouse Home and Glasshouse Bar. Off leaves the icons on their own.'))}</div></div>
      <div class="prot-status">${renderToggle({ id: 'home-bar-app-labels', cls: labelsOn ? 'good' : 'idle', label: labelsOn ? t('common.on', 'On') : t('common.off', 'Off'),
        on: labelsOn, disabled: !usable, onclick: "homeShow('showAppLabels')" })}</div></div>` : '';
    return `<details class="home-row" data-kind="${kind}"${open.includes(kind) ? ' open' : ''}>
      <summary><span class="prot-title">${esc(HOME_ROWS[kind]())}</span>
        ${rowMove}</summary>
      <div class="prot-table">${homeSortRow(kind, usable)}${barLabelsRow}${tiles || `<div class="sub">${esc(kind === 'ch' ? t('home.ch.empty', 'No channels yet. Add them below.') : kind === 'iptv' ? t('home.tv.rowEmpty', 'No channels yet. Add them in Internet TV below, or from the row on the TV.') : t('home.rowEmpty', 'Nothing to show in this row yet.'))}</div>`}</div>
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

function homeToggleHaRow() {
  homeSaveLayout({ haRow: homeLayout.haRow !== true });
}

async function homeToggleHaBarTile() {
  await homeSaveLayout({ haBarInHomeBar: homeLayout.haBarInHomeBar !== true });
  if (typeof loadHaBar === 'function' && typeof haBarConfigured !== 'undefined' && haBarConfigured) loadHaBar();
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

// homeSaving is cleared however the save ends: left set by a render or a
// reload that threw (the server restarting mid-save, say), it made every later
// change on the tab do nothing, with no error, until the page was reloaded.
async function homeSaveLayout(patch) {
  if (!homeWritable()) return;
  homeSaving = true;
  try {
    homeLoadRevision++;
    renderHome();
    try {
      const r = await homePost('/api/home/layout', patch);
      homeLayout = r.layout;
      homeStatus.layout = r.layout;
    } catch (e) { showErr(e.message); }
    await loadHome(true);
  } finally {
    homeSaving = false;
  }
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
  const haAvail = !!(homeStatus && homeStatus.haBarAvailable);
  let j = i + d;
  while (j >= 0 && j < rows.length && rows[j] === 'ha' && !haAvail) j += d;
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  homeSaveLayout({ rows });
}

/*
 * The apps kept out of the Recent apps panel (Back on Glasshouse Home), and
 * their last screen with them; their tiles stay on the Apps row.
 */
function renderHomeRecents() {
  const box = q('home-recents');
  if (!box || !homeLayout || !homeCat) return;
  const usable = homeWritable();
  const open = box.querySelector('details[open]') !== null;
  const out = homeLayout.excludedRecents || [];
  const apps = (homeCat.apps || []).slice().sort((a, b) => a.title.localeCompare(b.title));
  const rows = apps.map(a => {
    const hidden = out.includes(a.id);
    const icon = a.icon ? `<img class="rk-ico" src="${esc(api(a.icon))}" alt="">` : '';
    return `<div class="prot-row home-tile${hidden ? ' home-hidden' : ''}">
      <div class="prot-main"><div class="prot-title">${icon}<span translate="no">${esc(a.title)}</span></div></div>
      <div class="prot-status">${renderToggle({ cls: hidden ? 'idle' : 'good',
        label: hidden ? t('home.hidden', 'Hidden') : t('home.shown', 'Shown'),
        disabled: !usable, onclick: `homeToggleRecents('${jsq(a.id)}')` })}</div></div>`;
  }).join('');
  const summary = out.length ? t('home.recents.hiddenCount', '{n} hidden', { n: out.length }) : '';
  box.innerHTML = `<details class="home-row"${open ? ' open' : ''}>
    <summary><span class="prot-title">${esc(t('home.recents.title', 'Recent apps'))}</span>
      <span class="home-row-move">${summary ? `<span class="sub">${esc(summary)}</span>` : ''}</span></summary>
    <div class="sub">${esc(t('home.recents.desc', 'Apps hidden here never show in Glasshouse Home’s Recent apps (Back on Home), nor does their last screen. Their tiles stay on the Apps row.'))}</div>
    <div class="prot-table">${rows || `<div class="sub">${esc(t('home.rowEmpty', 'Nothing to show in this row yet.'))}</div>`}</div>
  </details>`;
}

function homeToggleRecents(id) {
  const list = (homeLayout.excludedRecents || []).slice();
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  homeSaveLayout({ excludedRecents: list });
}

function homeToggleRow(kind) {
  const off = (homeLayout.hiddenRows || []).slice();
  const i = off.indexOf(kind);
  if (i >= 0) off.splice(i, 1); else off.push(kind);
  homeSaveLayout({ hiddenRows: off });
}

function homeToggleTile(kind, id) {
  const hidden = Object.assign({}, homeLayout.hidden);
  const list = hidden[kind].slice();
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  hidden[kind] = list;
  homeSaveLayout({ hidden });
}

// An app is on the Apps row, in its More apps tile, or hidden.
function homePlaceSelect(id, hidden, folded, usable) {
  const place = hidden ? 'hidden' : folded ? 'folder' : 'row';
  const opt = (value, label) => `<option value="${value}"${place === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<select class="pill-sel" ${usable ? '' : 'disabled'} aria-label="${esc(t('home.place', 'Where it shows'))}"
      onchange="homeSetPlace('${jsq(id)}', this.value)">
    ${opt('row', t('home.shown', 'Shown'))}${opt('folder', t('home.folder.label', 'In More apps'))}${opt('hidden', t('home.hidden', 'Hidden'))}
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

function homeAppNameKey(e, el) {
  if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); el.value = el.dataset.cur || ''; el.blur(); }
}

function homeRenameApp(el) {
  const id = el.dataset.appName;
  const cur = el.dataset.cur || '';
  const def = el.dataset.def || '';
  const raw = el.value.replace(/\s+/g, ' ').trim();
  const next = raw || def;
  if (next === cur) { el.value = cur; return; }
  el.dataset.cur = next;
  if (homeLayout) {
    homeLayout.appNames = Object.assign({}, homeLayout.appNames);
    if (next === def) delete homeLayout.appNames[id];
    else homeLayout.appNames[id] = next;
  }
  homeSaveLayout({ appNames: { [id]: next === def ? '' : next } });
}

function homeResetLayout() { homeSaveLayout({ reset: true }); }

/*
 * A launcher not yet reported working on this TV's webOS (lib/compat): offered,
 * with a note saying so and links to report how it went, pre-filled with the
 * TV's model and versions. Nothing is sent unless the issue is submitted.
 */
// A warning with links to report how it went: `report` is one feature's
// { problem, works }, or a list of { name, report } where the note covers several.
function homeCompatNote(text, report) {
  // Copy details: the same lines the issue opens with, for someone without a
  // GitHub account to post elsewhere.
  const links = (r) => `<a href="${esc(r.problem)}" target="_blank" rel="noopener">${esc(t('compat.reportProblem', 'Report a problem'))}</a>
    &middot; <a href="${esc(r.works)}" target="_blank" rel="noopener">${esc(t('compat.reportWorks', 'Tell us it works'))}</a>${r.details
    ? ` &middot; <button type="button" class="link-btn" data-details="${esc(r.details)}" onclick="copyCompatDetails(this)">${esc(t('compat.copyDetails', 'Copy details'))}</button>` : ''}`;
  const rows = Array.isArray(report)
    ? report.map((x) => `<span class="home-compat-links">${esc(x.name)}: ${links(x.report)}</span>`).join('')
    : `<span class="home-compat-links">${links(report)}</span>`;
  return `<div class="pv-note warn home-compat-note">${esc(text)}${rows}</div>`;
}

async function copyCompatDetails(btn) {
  const label = t('compat.copyDetails', 'Copy details');
  try {
    await copyToClipboard(btn.dataset.details);
    btn.textContent = t('compat.copied', 'Copied');
  } catch (e) {
    btn.textContent = t('compat.copyFailed', 'Could not copy');
  }
  setTimeout(() => { btn.textContent = label; }, 2000);
}

function renderHomeCompat(st) {
  const box = q('home-compat');
  if (!box) return;
  const v = (st.supported && st.supported.webos) || '?';
  const home = !!(st.supported && st.supported.untried && st.supported.report);
  const bar = !!(st.bar && st.bar.offered && st.bar.standing === 'untried' && st.bar.report);
  // One note where both are untried, as on webOS 8, with each one's links.
  box.innerHTML = home && bar
    ? homeCompatNote(t('home.compat.untriedBoth', 'Glasshouse Home, Minimal, custom launchers and Glasshouse Bar have not yet been reported working on webOS {version}. If one misbehaves, choose LG Home to put everything back.', { version: v }),
        [{ name: t('home.title', 'Glasshouse Home'), report: st.supported.report }, { name: t('home.bar.name', 'Glasshouse Bar'), report: st.bar.report }])
    : home
    ? homeCompatNote(t('home.compat.untried', 'Glasshouse Home, Minimal and custom launchers have not yet been reported working on webOS {version}. If one misbehaves, choose LG Home to put everything back.', { version: v }), st.supported.report)
    : bar
    ? homeCompatNote(t('home.compat.untriedBar', 'Glasshouse Bar has not yet been reported working on webOS {version}. If it misbehaves, choose LG Home to put everything back.', { version: (st.bar.webos || v) }), st.bar.report)
    : '';
  // webOS 11: the Home key is LG's own, and Glasshouse changes its handler for the bar.
  if (st.bar && st.bar.native) box.innerHTML += `<div class="pv-note">${esc(t('home.bar.native', 'On this TV the Home key needs a change to LG’s key handler for Glasshouse Bar. Choosing the bar, or any other launcher after it, restarts the TV’s screen once, and the change is made again each time the TV starts.'))}</div>`;
}

function homeBarOn() { return !!(homeStatus && homeStatus.bar && homeStatus.bar.enabled); }

function homeShowUpdating(el) {
  const badge = el && el.querySelector('.hm-badge');
  if (badge) {
    badge.textContent = t('apps.service.updating', 'Updating…');
    badge.hidden = false;
  } else if (el) {
    el.textContent = t('apps.service.updating', 'Updating…');
  }
}

async function homeChooseBar(on) {
  if (!homeStatus || !homeWritable() || homeLauncherBusy) return;
  if (homeBarOn() === on) return;
  homeLauncherBusy = true;
  renderHome();
  homeShowUpdating(on ? q('home-mode-bar') : q('home-mode-lg'));
  try { await homePost('/api/home/bar', { on }); } catch (e) { showErr(e.message); }
  homeLauncherBusy = false;
  loadHome();
}

function homeChooseMode(wantOn) {
  if (!homeStatus) return;
  // LG Home from Glasshouse Bar.
  if (!wantOn && homeBarOn()) { homeChooseBar(false); return; }
  // Custom's settings belong to Custom alone.
  homeLauncherOpen = false;
  if (homeStatus.restorePending) { homeSwitch(); return; }
  // From the custom launcher to Glasshouse Home: the same place, another page.
  if (wantOn && homeLauncherOn()) { homeLauncherChoose(false); return; }
  if (Boolean(homeStatus.enabled) === Boolean(wantOn)) {
    if (wantOn && !homeStatus.supported.ok) homeSwitch();
    return;
  }
  homeSwitch();
}

async function homeSwitch() {
  if (!homeWritable() || homeLauncherBusy) return;
  const want = homeStatus.enabled || homeStatus.restorePending ? 'off' : 'on';
  homeLauncherBusy = true;
  renderHome();
  const btn = q('home-switch');
  const lgBtn = q('home-mode-lg');
  homeShowUpdating(want === 'off' && !homeStatus.restorePending && lgBtn ? lgBtn : btn);
  try {
    // Glasshouse Home's own button: the custom launcher left set up, but not chosen.
    if (want === 'on' && homeStatus.launchers && homeStatus.launchers.chosen) await homePost('/api/home/launcher', { choose: false });
    await homePost(want === 'on' ? '/api/home/enable' : '/api/home/disable');
  } catch (e) { showErr(e.message); }
  homeLauncherBusy = false;
  loadHome();
}

/*
 * Custom: with a launcher of the owner's own set up, it is chosen as the
 * others are; either way its settings open below, to set one up or change it.
 */
function homeChooseLauncher() {
  if (!homeStatus) return;
  const wasOpen = homeLauncherOpen;
  homeLauncherOpen = true;
  if (homeLaunchersKept().some(l => l.id === 'own')) homeLauncherUse('own');
  else renderHome();
  const box = q('home-launcher');
  if (box && !wasOpen) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function homeLauncherUse(id) {
  if (!homeWritable() || homeLauncherBusy) return;
  if (id !== 'own') homeLauncherOpen = false;
  if (homeLauncherOn() && homeStatus.launchers.chosen === id) return;
  homeLauncherChoose(id);
}

async function homeLauncherChoose(id) {
  homeLauncherBusy = true;
  renderHome();
  homeShowUpdating(id === 'minimal' ? q('home-mode-minimal') : id === 'own' ? q('home-mode-launcher') : q('home-switch'));
  try {
    await homePost('/api/home/launcher', { choose: id });
    if (id !== false && !homeStatus.enabled) await homePost('/api/home/enable');
  } catch (e) { showErr(e.message); }
  homeLauncherBusy = false;
  await loadHome();
}

function homeLauncherDesc(l) {
  if (l.kind === 'web') return t('home.launcher.nowWeb', 'Web page: {address}', { address: l.address });
  const parts = [];
  if (l.author) parts.push(t('ss.by', 'by {author}', { author: l.author }));
  if (l.version) parts.push('v' + l.version);
  if (parts.length) return parts.join(' · ');
  return l.files === 1
    ? t('home.launcher.nowAppOne', 'Uploaded: one file, {size}', { size: fmtSize(l.bytes) })
    : t('home.launcher.nowApp', 'Uploaded: {files} files, {size}', { files: l.files, size: fmtSize(l.bytes) });
}

function renderHomeLauncher() {
  const st = homeStatus;
  const box = q('home-launcher');
  if (!box || !st) return;
  const kept = homeLaunchersKept();
  // Only while Custom is the TV's Home, or its button was pressed to set one up.
  const customOn = homeLauncherOn() && st.launchers.chosen !== 'minimal';
  box.hidden = !st.supported.ok || !!st.restorePending || !(customOn || homeLauncherOpen);
  if (box.hidden) return;
  const busy = !homeWritable() || homeLauncherBusy;
  const chosen = st.enabled && st.launchers ? st.launchers.chosen : null;
  q('home-launchers').innerHTML = kept.map(l => `<div class="prot-row">
      <div class="prot-main"><div class="prot-title">${esc(l.title)}</div><div class="prot-desc">${esc(homeLauncherDesc(l))}</div></div>
      <div class="prot-status">
        ${l.id === chosen
          ? `<span class="ss-tag">${esc(t('ss.inUse', 'In use'))}</span>`
          : `<button type="button" class="pill idle" ${busy ? 'disabled' : ''} onclick="homeLauncherUse('${esc(l.id)}')">${esc(t('community.use', 'Use'))}</button>`}
        <button type="button" class="pill idle" ${busy ? 'disabled' : ''} onclick="homeLauncherRemove('${esc(l.id)}')">${esc(t('home.launcher.remove', 'Remove'))}</button>
      </div>
    </div>`).join('');
  ['home-launcher-pick', 'home-launcher-save'].forEach(id => { const b = q(id); if (b) b.disabled = busy; });
  // Held to what installing an app from a file is.
  const uploadOff = st.launcherUpload === false;
  q('home-launcher-upload-off').hidden = !uploadOff;
  if (uploadOff) q('home-launcher-pick').disabled = true;
  const url = q('home-launcher-url');
  const ownWeb = kept.filter(l => l.id === 'own' && l.kind === 'web')[0];
  if (url && ownWeb && !url.value && document.activeElement !== url) url.value = ownWeb.address;
}

function homeLauncherPick() {
  const input = q('home-launcher-file');
  input.value = '';
  input.click();
}

// Your own, set up: it becomes the TV's Home at once where Glasshouse Home already is.
async function homeLauncherDone() {
  const note = q('home-launcher-note');
  if (homeStatus.enabled) {
    await homePost('/api/home/launcher', { choose: 'own' });
    note.textContent = t('home.launcher.doneOn', 'Done. The TV’s Home shows it within a few seconds.');
  } else {
    note.textContent = t('home.launcher.doneOffCustom', 'Done. Press Custom above to make it the TV’s Home.');
  }
}

async function homeLauncherPicked(input) {
  const file = input.files[0];
  if (!file || !homeWritable() || homeLauncherBusy) return;
  const note = q('home-launcher-note');
  if (file.size > 50 * 1024 * 1024) { note.textContent = t('home.launcher.tooLarge', 'A launcher can be at most 50 MB.'); return; }
  homeLauncherBusy = true;
  note.textContent = t('home.launcher.uploading', 'Uploading {name}…', { name: file.name });
  renderHome();
  try {
    const res = await fetch(api('/api/home/launcher/upload?name=' + encodeURIComponent(file.name)), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file
    });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error(r.error || t('home.launcher.uploadFailed', 'The launcher could not be uploaded.'));
    await homeLauncherDone();
  } catch (e) { note.textContent = e.message; }
  homeLauncherBusy = false;
  await loadHome();
}

async function homeLauncherSaveAddress() {
  if (!homeWritable() || homeLauncherBusy) return;
  const note = q('home-launcher-note');
  homeLauncherBusy = true;
  note.textContent = '';
  renderHome();
  try {
    await homePost('/api/home/launcher', { address: q('home-launcher-url').value.trim() });
    await homeLauncherDone();
  } catch (e) { note.textContent = e.message; }
  homeLauncherBusy = false;
  await loadHome();
}

// Removed while it is the TV's Home, Glasshouse Home takes its place.
async function homeLauncherRemove(id) {
  if (!homeWritable() || homeLauncherBusy) return;
  homeLauncherBusy = true;
  q('home-launcher-note').textContent = '';
  renderHome();
  try {
    await homePost('/api/home/launcher', { remove: id });
    if (id === 'own') q('home-launcher-url').value = '';
  } catch (e) { q('home-launcher-note').textContent = e.message; }
  homeLauncherBusy = false;
  await loadHome();
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
  try {
    renderHome();
    await homePost('/api/home/start-layout', { hideLgHomeAtStart: want });
  } catch (e) { showErr(e.message); } finally {
    homeSaving = false;
  }
  loadHome();
}

function homePicture() {
  homeSaveLayout({ picture: homeLayout.picture !== true });
}

function homeLivePreview() {
  homeSaveLayout({ livePreview: homeLayout.livePreview !== true });
}

function homePreviewOption(field) {
  homeSaveLayout({ [field]: homeLayout[field] !== true });
}

// The details Glasshouse Home shows unless switched off, and their toggles.
const HOME_SHOW = [['showClock', 'home-show-clock'], ['showLastOn', 'home-show-last'], ['showAppCount', 'home-show-count'], ['showAppLabels', 'home-show-app-labels'], ['showCec', 'home-show-cec'], ['showTvLogos', 'home-show-tv-logos'], ['showPointer', 'home-show-pointer']];

/*
 * The weather: off, from Home Assistant, or from Open-Meteo for a place found
 * by name here. The search goes through the TV's server, which asks Open-Meteo.
 */
let homeWeatherFound = [];

function placeLabel(p) {
  return [p.name, p.admin, p.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
}

function renderHomeWeather(st) {
  const sel = q('home-weather-sel');
  if (!sel) return;
  const source = (st.layout && st.layout.weather) || 'ha';
  sel.value = source;
  sel.disabled = !homeWritable();
  const panel = q('home-weather-place');
  panel.hidden = !st.supported.ok || source !== 'internet';
  const place = st.layout && st.layout.weatherPlace;
  q('home-weather-chosen').textContent = place
    ? t('home.weather.showing', 'Showing the weather for {place}.', { place: placeLabel(place) })
    : t('home.weather.choose', 'Search for your town, then choose it from the list.');
  q('home-weather-go').disabled = !homeWritable();
}

function homePreviewSize(value) {
  homeSaveLayout({ previewSize: value });
}

function homeRemoteBattery(value) {
  homeSaveLayout({ remoteBattery: value });
}

function homeWeatherSource(value) {
  homeSaveLayout({ weather: value });
}

async function homeWeatherSearch() {
  const query = q('home-weather-q').value.trim();
  const box = q('home-weather-results');
  if (query.length < 2) { box.textContent = ''; return; }
  box.textContent = t('home.weather.searching', 'Searching…');
  try {
    const r = await fetch(api('/api/home/weather/places?q=' + encodeURIComponent(query) + '&lang=' + encodeURIComponent(I18N.lang())));
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || r.status);
    homeWeatherFound = d.places || [];
    if (!homeWeatherFound.length) { box.textContent = t('home.weather.none', 'No places found by that name.'); return; }
    box.innerHTML = homeWeatherFound.map((p, i) =>
      `<button type="button" class="pill idle" onclick="homeWeatherPick(${i})">${esc(placeLabel(p))}</button>`).join('');
  } catch (e) {
    box.textContent = t('home.weather.searchFailed', 'Could not search: {error}', { error: e.message });
  }
}

function homeWeatherPick(i) {
  const place = homeWeatherFound[i];
  if (!place) return;
  q('home-weather-results').textContent = '';
  homeSaveLayout({ weather: 'internet', weatherPlace: place });
}

/*
 * The lines beside the clock: off, entities chosen here, or lines Home
 * Assistant sends. Each of the four takes an entity, optionally one of its
 * attributes in place of its state, a label and a few words before the value.
 * The entity list comes from Home Assistant's API, as the screen savers' does,
 * and is read once.
 */
const HOME_INFO_SLOTS = 4;
let homeHaList = null;       // { configured, entities, error } once read
let homeHaListReading = false;
onHaEntitiesReset(() => { homeHaList = null; homeHaListReading = false; });

haPickerRegister('home:info', {
  listId: 'home-info-picker',
  inputId: 'home-info-add',
  getUsedIds: () => (homeInfoList || []).map(l => l.entity),
  onPick: id => {
    const inp = q('home-info-add');
    if (inp) inp.value = id;
    homeInfoAdd();
  }
});

function homeInfoFilter() {
  const inp = q('home-info-add');
  if (inp) haPickerFilter('home:info', inp.value);
}

function homeInfoTogglePicker() {
  haPickerToggle('home:info');
}

async function homeReadHaList() {
  if (homeHaList || homeHaListReading) return;
  homeHaListReading = true;
  await ensureHaEntities(st => {
    homeHaList = { configured: st.configured, entities: st.entities, error: st.error };
    homeHaListReading = false;
    if (homeStatus) renderHomeInfo(homeStatus);
  });
}

// The lines as last saved or edited here: edits change this copy and save it
// whole, so two quick changes cannot undo each other.
let homeInfoList = null;
let homeInfoMsgTimer = null;

function homeInfoSay(text, warn) {
  const msg = q('home-info-msg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.className = 'home-info-msg' + (warn ? ' warn' : '');
  clearTimeout(homeInfoMsgTimer);
  if (text && !warn) homeInfoMsgTimer = setTimeout(() => { msg.textContent = ''; }, 4000);
}

function renderHomeInfo(st) {
  const sel = q('home-info-sel');
  if (!sel) return;
  // Each source only where it can work: entities with the Home Assistant API
  // set up on the HA & MQTT tab, sent lines with MQTT. With neither, no row.
  const can = st.haLines || { api: false, mqtt: false };
  const row = q('home-info-row');
  if (row) row.hidden = !st.supported.ok || !(can.api || can.mqtt);
  // Disabled too: Safari shows an option that is only hidden.
  [['entities', can.api], ['ha', can.mqtt]].forEach(([v, ok]) => {
    const o = sel.querySelector('option[value="' + v + '"]');
    o.hidden = !ok;
    o.disabled = !ok;
  });
  let source = (st.layout && st.layout.info) || 'entities';
  // A source that can no longer work reads as off until it can again.
  if ((source === 'entities' && !can.api) || (source === 'ha' && !can.mqtt)) source = 'off';
  sel.value = source;
  sel.disabled = !homeWritable();
  const panel = q('home-info-panel');
  panel.hidden = !st.supported.ok || source === 'off';
  if (panel.hidden) return;
  const note = q('home-info-note');
  const entities = source === 'entities';
  q('home-info-addbox').hidden = !entities;
  if (!entities) {
    note.textContent = t('home.info.haDesc', 'A Home Assistant automation sends the lines to the TV\'s Home Info Push entity, as a list of up to four, each with a label and a value. The Home Assistant guide has an example.');
    note.className = 'sub';
    q('home-info-lines').innerHTML = '';
    return;
  }
  homeReadHaList();
  if (homeHaList && homeHaList.error) {
    note.textContent = homeHaList.error;
    note.className = 'set-note warn';
  } else {
    note.textContent = t('home.info.entitiesDesc', 'Each line shows one Home Assistant entity, read every 30 seconds while Home is on screen. A date reads as today, tomorrow or a weekday, and a number has its unit.');
    note.className = 'sub';
  }
  if (!homeInfoList || !homeSaving) homeInfoList = ((st.layout && st.layout.infoLines) || []).map(l => Object.assign({}, l));
  homeInfoDraw();
}

// The list, drawn from homeInfoList. Not drawn again under a field being
// typed in: its change saves, and the next draw shows it.
function homeInfoDraw() {
  const lines = homeInfoList || [];
  const locked = !homeWritable();
  const full = lines.length >= HOME_INFO_SLOTS;
  q('home-info-count').textContent = lines.length + ' / ' + HOME_INFO_SLOTS;
  // An entity id, the same in every language.
  q('home-info-add').placeholder = 'sensor.bin_collection';
  q('home-info-add').disabled = locked || full;
  if (q('home-info-pick-btn')) q('home-info-pick-btn').disabled = locked || full;
  q('home-info-add-btn').disabled = locked || full;
  q('home-info-add-hint').textContent = full ? t('home.info.full', 'Four lines at most: remove one to add another.')
    : t('home.info.addHint', 'Start typing to pick one of Home Assistant\'s entities.');
  const box = q('home-info-lines');
  const typing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (typing) return;
  const dis = locked ? 'disabled' : '';
  const field = (i, key, label, value, max, hint) => `
        <div class="home-info-field">
          <label for="home-info-${key}-${i}">${esc(label)}</label>
          <div class="home-info-input">
            <input type="text" id="home-info-${key}-${i}" value="${esc(value || '')}" maxlength="${max}" ${dis}
              autocomplete="off" spellcheck="false" onchange="homeInfoField(${i}, '${key}', this.value)">
            <div class="home-info-hint">${esc(hint)}</div>
          </div>
        </div>`;
  let html = '';
  if (lines.length) html += '<div class="ss-li-scroll home-info-list">';
  lines.forEach((l, i) => {
    const hit = haEntityLookup(l.entity) || (homeHaList ? homeHaList.entities.find(e => e.id === l.entity) : null);
    const own = (hit && hit.name) || l.entity;
    // How the line reads beside the clock, with a made-up value.
    const value = l.attribute ? t('home.info.tomorrow', 'tomorrow') : '…' + (hit && hit.unit ? ' ' + hit.unit : '');
    const shown = (l.label || own) + ' · ' + (l.before ? l.before + ' ' : '') + value;
    html += `
      <div class="ss-li-item">
        <div class="ss-li-top">
          <span class="ss-li-num num">${i + 1}</span>
          <div class="ss-li-info" title="${esc(l.entity)}">
            <div class="ss-li-name">${esc(own)}</div>
            ${hit && hit.name ? `<div class="ss-li-id">${esc(l.entity)}</div>` : ''}
          </div>
          <div class="ss-li-acts">
            <button type="button" title="${esc(t('ss.entityList.moveUp', 'Move up'))}" aria-label="${esc(t('ss.entityList.moveUp', 'Move up'))}" ${(locked || i === 0) ? 'disabled' : ''} onclick="homeInfoMove(${i}, -1)">&#8593;</button>
            <button type="button" title="${esc(t('ss.entityList.moveDown', 'Move down'))}" aria-label="${esc(t('ss.entityList.moveDown', 'Move down'))}" ${(locked || i === lines.length - 1) ? 'disabled' : ''} onclick="homeInfoMove(${i}, 1)">&#8595;</button>
            <button type="button" title="${esc(t('ss.entityList.remove', 'Remove'))}" aria-label="${esc(t('ss.entityList.remove', 'Remove'))}" ${dis} onclick="homeInfoRemove(${i})">&times;</button>
          </div>
        </div>
        <details class="home-info-more"${l.label || l.attribute || l.before ? ' open' : ''}>
        <summary>${esc(t('home.info.customise', 'Customise'))}</summary>
        ${field(i, 'label', t('home.info.name', 'Name'), l.label, 32, t('home.info.nameHint', 'Optional. Replaces the entity\'s own name.'))}
        ${field(i, 'attribute', t('home.info.attributeLabel', 'Attribute'), l.attribute, 64, t('home.info.attributeHint', 'Optional. An attribute such as next_date, shown instead of the state.'))}
        ${field(i, 'before', t('home.info.beforeLabel', 'Text before'), l.before, 24, t('home.info.beforeHint', 'Optional. Words in front of the value, such as collected.'))}
        </details>
        <div class="home-info-preview">${esc(t('home.info.preview', 'Shows as: {line}', { line: shown }))}</div>
      </div>`;
  });
  if (lines.length) html += '</div>';
  box.innerHTML = html;
}

function homeInfoCommit(lines) {
  homeInfoList = lines;
  homeInfoDraw();
  homeSaveLayout({ infoLines: lines });
}

function homeInfoAdd() {
  const input = q('home-info-add');
  const entity = input.value.trim().toLowerCase();
  const lines = (homeInfoList || []).map(l => Object.assign({}, l));
  if (!entity) {
    homeInfoSay(t('home.info.needEntity', 'Type or pick an entity first.'), true);
    input.focus();
    homeInfoTogglePicker();
    return;
  }
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entity)) {
    homeInfoSay(t('home.info.badEntity', 'An entity looks like sensor.bin_collection: a domain, a dot and a name.'), true);
    return;
  }
  if (homeHaList && homeHaList.entities.length && !haEntityLookup(entity) && !homeHaList.entities.some(e => e.id === entity)) {
    homeInfoSay(t('home.info.noSuchEntity', 'Home Assistant has no entity called {entity}.', { entity }), true);
    return;
  }
  if (lines.length >= HOME_INFO_SLOTS) return;
  haPickerCloseAll();
  lines.push({ entity, attribute: '', label: '', before: '' });
  input.value = '';
  homeInfoCommit(lines);
  const hit = haEntityLookup(entity) || (homeHaList ? homeHaList.entities.find(e => e.id === entity) : null);
  homeInfoSay(t('home.info.added', 'Added {name} as line {n}.', { name: (hit && hit.name) || entity, n: lines.length }));
}

function homeInfoRemove(i) {
  const lines = (homeInfoList || []).slice();
  const gone = lines.splice(i, 1)[0];
  homeInfoCommit(lines);
  if (gone) homeInfoSay(t('home.info.removed', 'Removed line {n}.', { n: i + 1 }));
}

function homeInfoMove(i, by) {
  const lines = (homeInfoList || []).slice();
  const j = i + by;
  if (j < 0 || j >= lines.length) return;
  [lines[i], lines[j]] = [lines[j], lines[i]];
  homeInfoCommit(lines);
}

function homeInfoField(i, key, value) {
  const lines = (homeInfoList || []).map(l => Object.assign({}, l));
  if (!lines[i]) return;
  lines[i][key] = value.trim();
  homeInfoList = lines;
  homeSaveLayout({ infoLines: lines });
}

function homeInfoSource(value) {
  homeSaveLayout({ info: value });
}

// The board: off, or a board Home Assistant sends.
function renderHomeBoard(st) {
  const sel = q('home-board-sel');
  if (!sel) return;
  // Sent over MQTT, so the row is shown only with MQTT set up, as the values
  // at a glance' sources are, and reads as off while MQTT is not.
  const mqtt = !!(st.haLines && st.haLines.mqtt);
  const row = q('home-board-row');
  if (row) row.hidden = !st.supported.ok || !mqtt;
  sel.value = mqtt ? ((st.layout && st.layout.board) || 'off') : 'off';
  sel.disabled = !homeWritable();
  const panel = q('home-board-panel');
  panel.hidden = !st.supported.ok || sel.value === 'off';
  if (panel.hidden) return;
  const place = q('home-board-place');
  place.value = st.layout && st.layout.boardStrip ? 'strip' : 'beside';
  place.disabled = !homeWritable();
}

/*
 * News feeds, added one at a time, up to three, on the Home tab for the strip
 * and on the Screensaver tab for the News saver, both saved as Home's
 * newsFeeds. prefix names a place's ids. The add form is built once and kept
 * out of the list, which is drawn again after each change, so a redraw never
 * takes what is being typed.
 */
const NEWS_SLOTS = 3;
const newsLists = {};
const newsMsgTimers = {};

function newsSay(prefix, text, warn) {
  const msg = q(prefix + '-msg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.className = 'home-info-msg' + (warn ? ' warn' : '');
  clearTimeout(newsMsgTimers[prefix]);
  if (text && !warn) newsMsgTimers[prefix] = setTimeout(() => { msg.textContent = ''; }, 4000);
}

function newsForm(prefix, box) {
  if (q(prefix + '-add')) return;
  box.innerHTML = `
    <div class="home-info-addbox">
      <div class="ss-li-head">
        <label for="${prefix}-add">${esc(t('home.news.add', 'Add a feed'))}</label>
        <span class="ss-li-count num" id="${prefix}-count"></span>
      </div>
      <div class="ss-li-add">
        <input type="url" id="${prefix}-add" maxlength="2048" autocomplete="off" spellcheck="false"
          aria-describedby="${prefix}-hint ${prefix}-msg" onkeydown="if(event.key==='Enter'){event.preventDefault();newsAdd('${prefix}');}">
        <button type="button" class="ss-li-add-btn" id="${prefix}-add-btn" onclick="newsAdd('${prefix}')">${esc(t('ss.entityList.addBtn', 'Add'))}</button>
      </div>
      <div class="home-info-hint" id="${prefix}-hint"></div>
      <div class="home-info-msg" id="${prefix}-msg" role="status" aria-live="polite"></div>
    </div>
    <div id="${prefix}-list"></div>`;
  // An address, the same in every language.
  q(prefix + '-add').placeholder = 'https://';
}

function renderNewsFeeds(prefix, feeds, writable) {
  const box = q(prefix + '-feeds');
  if (!box) return;
  newsForm(prefix, box);
  newsLists[prefix] = (feeds || []).map(f => ({ url: f.url, name: f.name || '' }));
  newsDraw(prefix, writable);
}

function newsDraw(prefix, writable) {
  const lines = newsLists[prefix] || [];
  const locked = writable === false;
  const full = lines.length >= NEWS_SLOTS;
  q(prefix + '-count').textContent = lines.length + ' / ' + NEWS_SLOTS;
  q(prefix + '-add').disabled = locked || full;
  q(prefix + '-add-btn').disabled = locked || full;
  q(prefix + '-hint').textContent = full ? t('home.news.full', 'Three feeds at most: remove one to add another.')
    : t('home.news.addHint', 'The address of an RSS or Atom feed, such as a news site\'s.');
  const list = q(prefix + '-list');
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const key = JSON.stringify(lines) + locked;
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  const dis = locked ? 'disabled' : '';
  let html = lines.length ? '<div class="ss-li-scroll home-info-list">' : '';
  lines.forEach((f, i) => {
    html += `
      <div class="ss-li-item">
        <div class="ss-li-top">
          <span class="ss-li-num num">${i + 1}</span>
          <div class="ss-li-info" title="${esc(f.url)}">
            <div class="ss-li-name" id="${prefix}-title-${i}">${esc(f.name || newsHost(f.url))}</div>
            <div class="ss-li-id">${esc(f.url)}</div>
          </div>
          <div class="ss-li-acts">
            <button type="button" title="${esc(t('ss.entityList.moveUp', 'Move up'))}" aria-label="${esc(t('ss.entityList.moveUp', 'Move up'))}" ${(locked || i === 0) ? 'disabled' : ''} onclick="newsMove('${prefix}', ${i}, -1)">&#8593;</button>
            <button type="button" title="${esc(t('ss.entityList.moveDown', 'Move down'))}" aria-label="${esc(t('ss.entityList.moveDown', 'Move down'))}" ${(locked || i === lines.length - 1) ? 'disabled' : ''} onclick="newsMove('${prefix}', ${i}, 1)">&#8595;</button>
            <button type="button" title="${esc(t('ss.entityList.remove', 'Remove'))}" aria-label="${esc(t('ss.entityList.remove', 'Remove'))}" ${dis} onclick="newsRemove('${prefix}', ${i})">&times;</button>
          </div>
        </div>
        <div class="home-info-preview news-feed-status" id="${prefix}-status-${i}" role="status"></div>
        <details class="home-info-more"${f.name ? ' open' : ''}>
          <summary>${esc(t('home.info.customise', 'Customise'))}</summary>
          <div class="home-info-field">
            <label for="${prefix}-name-${i}">${esc(t('home.info.name', 'Name'))}</label>
            <div class="home-info-input">
              <input type="text" id="${prefix}-name-${i}" value="${esc(f.name)}" maxlength="40" ${dis}
                autocomplete="off" spellcheck="false" onchange="newsName('${prefix}', ${i}, this.value)">
              <div class="home-info-hint">${esc(t('home.news.nameHint', 'Optional. Shown before its headlines in place of the feed\'s own name.'))}</div>
            </div>
          </div>
        </details>
      </div>`;
  });
  if (lines.length) html += '</div>';
  list.innerHTML = html;
  newsCheck(prefix);
}

function newsHost(url) {
  const m = /^https?:\/\/(?:www\.)?([^\/:?#]+)/i.exec(url || '');
  return m ? m[1] : url;
}

/*
 * Under each feed, what the server made of it: its name and how many
 * headlines it has, or why it could not be read. The server reads a feed at
 * once when it is new, so a wrong address shows straight after it is added.
 */
async function newsCheck(prefix) {
  const lines = newsLists[prefix] || [];
  lines.forEach((f, i) => {
    const el = q(`${prefix}-status-${i}`);
    if (el) { el.textContent = t('home.news.checking', 'Reading the feed…'); el.className = 'home-info-preview news-feed-status'; }
  });
  if (!lines.length) return;
  let r = null;
  try { r = await homeGet('/api/news/status'); } catch (e) { r = null; }
  lines.forEach((f, i) => {
    const el = q(`${prefix}-status-${i}`);
    if (!el) return;
    const st = r && r.feeds && r.feeds.find(x => x.url === f.url);
    if (!st) { el.textContent = ''; return; }
    if (st.ok) {
      el.textContent = t('home.news.feedOk', '{source}: {n} headlines', { source: st.source, n: st.count });
      el.className = 'home-info-preview news-feed-status good';
      const title = q(`${prefix}-title-${i}`);
      if (title && !f.name && st.source) title.textContent = st.source;
    } else {
      el.textContent = st.error === 'feed' ? t('home.news.notFeed', 'Read, but it is not an RSS or Atom feed. Check the address.')
        : st.error === 'size' ? t('home.news.tooBig', 'Larger than 2 MB, so it is not read.')
        : t('home.news.fetchFailed', 'Could not be read. Check the address, and that the TV is online.');
      el.className = 'home-info-preview news-feed-status warn';
    }
  });
}

async function newsCommit(prefix, list) {
  newsLists[prefix] = list;
  newsDraw(prefix, true);
  try { await homePost('/api/home/layout', { newsFeeds: list }); } catch (e) { showErr(e.message); }
  newsCheck(prefix);
  if (prefix === 'home-news') loadHome(true); else loadScreensavers();
}

function newsAdd(prefix) {
  const input = q(prefix + '-add');
  const url = input.value.trim();
  const list = (newsLists[prefix] || []).slice();
  if (!url) { newsSay(prefix, t('home.news.needUrl', 'Type a feed\'s address first.'), true); input.focus(); return; }
  if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) {
    newsSay(prefix, t('home.news.badUrl', 'A feed\'s address starts with http:// or https://.'), true);
    return;
  }
  if (list.some(f => f.url === url)) { newsSay(prefix, t('home.news.dupe', 'That feed is already in the list.'), true); return; }
  if (list.length >= NEWS_SLOTS) return;
  list.push({ url, name: '' });
  input.value = '';
  newsSay(prefix, t('home.news.added', 'Added as feed {n}. Reading it now.', { n: list.length }));
  newsCommit(prefix, list);
}

function newsRemove(prefix, i) {
  const list = (newsLists[prefix] || []).slice();
  list.splice(i, 1);
  newsSay(prefix, t('home.news.removed', 'Removed feed {n}.', { n: i + 1 }));
  newsCommit(prefix, list);
}

function newsMove(prefix, i, by) {
  const list = (newsLists[prefix] || []).slice();
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  newsCommit(prefix, list);
}

function newsName(prefix, i, value) {
  const list = (newsLists[prefix] || []).map(f => Object.assign({}, f));
  if (!list[i]) return;
  list[i].name = value.trim();
  newsLists[prefix] = list;
  homePost('/api/home/layout', { newsFeeds: list }).catch(e => showErr(e.message));
}

function renderHomeNews(st) {
  const sel = q('home-news-sel');
  if (!sel) return;
  const on = !!(st.layout && st.layout.news);
  sel.value = on ? 'on' : 'off';
  sel.disabled = !homeWritable();
  const panel = q('home-news-panel');
  panel.hidden = !st.supported.ok || !on;
  if (!panel.hidden) renderNewsFeeds('home-news', st.layout.newsFeeds, homeWritable());
  const style = q('home-news-style');
  style.value = st.layout.newsStyle || 'flip';
  style.disabled = !homeWritable();
  const speed = q('home-news-speed');
  speed.value = st.layout.newsSpeed || 'slow';
  speed.disabled = !homeWritable();
}

function homeBoardStrip(on) {
  homeSaveLayout({ boardStrip: on });
}

function homeNewsOn(on) {
  homeSaveLayout({ news: on });
}

function homeBoardSource(value) {
  homeSaveLayout({ board: value });
}

function homeShow(key) {
  homeSaveLayout({ [key]: homeLayout[key] === false });
}

// Off until switched on: apps as cards and the pulse on the one in focus.
const HOME_OPT_IN = [['appCards', 'home-app-cards'], ['focusPulse', 'home-focus-pulse']];
function homeOptIn(key) {
  homeSaveLayout({ [key]: homeLayout[key] !== true });
}

function homeCardFade(v) {
  homeSaveLayout({ cardFade: Number(v) });
}

function homeNavSound(v) {
  homeSaveLayout({ navSound: v });
}

function homePointerSound(v) {
  homeSaveLayout({ pointerSound: v });
}

/*
 * The card icons on the TV (lib/home cardIconNames), read once a visit: each
 * app's row picks one of them, or uploads one under its title's name.
 */
let homeCardIcons = null;
let homeCardIconTarget = null;
let homeCardIconNote = null;
async function loadHomeCardIcons() {
  if (homeCardIcons) return;
  try {
    const r = await (await fetch(api('/api/home/card-icons'))).json();
    homeCardIcons = (r && r.names) || [];
  } catch (e) { homeCardIcons = []; }
  // Only the dialog's search offers them; the rows are left as drawn, so an
  // owner's open section stays open.
  if (homeCardIconTarget) renderHomeCardIconModal();
}

// An app title as a card icon is named, as lib/home cardIconKey: "YouTube Music" is youtube_music.
function homeCardIconKey(title) {
  return String(title || '').toLowerCase().replace(/&/g, ' and ').replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

// An app's card in its row: what Home shows on it, opening the icon dialog.
function homeCardIconButton(id, it, editable) {
  const app = ((homeCat && homeCat.apps) || []).find(a => a.id === id);
  const inner = app && app.card ? `<img src="${esc(api(app.card))}" alt="">`
    : it.icon ? `<img class="home-card-own" src="${esc(api(it.icon))}" alt="">` : '';
  return `<button type="button" class="home-card-btn" data-card-app="${esc(id)}" ${editable ? '' : 'disabled'}
    onclick="homeCardIconOpen(this.dataset.cardApp)" title="${esc(t('home.cardIconEdit', 'Change the card icon'))}"
    aria-label="${esc(t('home.cardIconEditFor', 'Card icon for {app}', { app: it.title }))}">${inner}</button>`;
}

function homeCardIconApp(id) {
  return ((homeCat && homeCat.apps) || []).find(a => a.id === id) || { id, title: '' };
}

function homeCardIconOpen(id) {
  homeCardIconTarget = id;
  homeCardIconNote = null;
  renderHomeCardIconModal();
  const box = q('home-card-modal');
  box.hidden = false;
  q('home-card-modal-close').focus();
}

function homeCardIconClose() {
  q('home-card-modal').hidden = true;
  homeCardIconTarget = null;
}

// The dialog for the app it is open for, drawn again after each change.
function renderHomeCardIconModal() {
  const id = homeCardIconTarget;
  if (!id || !q('home-card-modal')) return;
  const app = homeCardIconApp(id);
  const chosen = (homeLayout && homeLayout.appIcons && homeLayout.appIcons[id]) || '';
  const shown = app.card ? (/[?&]name=([a-z0-9_]+)/.exec(app.card) || [])[1] : '';
  q('home-card-modal-title').textContent = t('home.cardIconEditFor', 'Card icon for {app}', { app: app.title });
  q('home-card-modal-preview').innerHTML = app.card ? `<img src="${esc(api(app.card))}" alt="">`
    : app.icon ? `<img class="home-card-own" src="${esc(api(app.icon))}" alt="">` : '';
  q('home-card-modal-state').textContent = shown
    ? t('home.cardIconShowing', 'Showing {name}.png', { name: shown })
    : t('home.cardIconNone', 'No card icon yet: Home shows the app’s own icon on the card.');
  q('home-card-modal-upload').textContent = shown ? t('home.cardIconReplace', 'Replace') : t('home.cardIconUpload', 'Upload');
  q('home-card-modal-remove').hidden = !shown;
  const names = homeCardIcons || [];
  const list = q('home-card-icon-list');
  if (list.dataset.count !== String(names.length)) {
    list.innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
    list.dataset.count = String(names.length);
  }
  const pick = q('home-card-modal-pick');
  pick.value = chosen;
  pick.placeholder = t('home.cardIconSearch', 'Search {count} icons by name', { count: names.length });
  q('home-card-modal-auto').hidden = !chosen;
  q('home-card-modal-pickrow').hidden = !names.length;
  const note = q('home-card-modal-note');
  note.textContent = homeCardIconNote ? homeCardIconNote.text : '';
  const busy = !!(homeCardIconNote && homeCardIconNote.busy);
  ['home-card-modal-upload', 'home-card-modal-remove', 'home-card-modal-pick', 'home-card-modal-auto'].forEach(k => { q(k).disabled = busy || !homeWritable(); });
}

// One of the icons on the TV by name, or with none (Match by name), the one its title matches.
function homeSetCardIcon(el) {
  const id = homeCardIconTarget;
  if (!id) return;
  const name = el ? el.value.trim().toLowerCase() : '';
  if (name && !(homeCardIcons || []).includes(name)) {
    homeCardIconNote = { id, text: t('home.cardIconUnknown', 'There is no icon named {name} on the TV.', { name }) };
    return renderHomeCardIconModal();
  }
  homeCardIconNote = null;
  homeLayout.appIcons = Object.assign({}, homeLayout.appIcons);
  if (name) homeLayout.appIcons[id] = name; else delete homeLayout.appIcons[id];
  homeSaveLayout({ appIcons: { [id]: name } }).then(() => renderHomeCardIconModal());
}

function homeCardIconUpload() {
  const input = q('home-card-icon-file');
  input.value = '';
  input.click();
}

function homeCardIconDrop(e) {
  e.preventDefault();
  q('home-card-modal-preview').classList.remove('drag');
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) homeCardIconSend(file);
}

// Any picture, drawn whole on a clear 640 x 360 PNG: the card's 16:9 at over
// twice the size it is shown, which the server holds icons to.
async function homePrepareCardIcon(file) {
  if (!/^image\/(jpeg|png|webp|svg\+xml)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error(t('home.cardIconChoose', 'Choose a PNG, JPEG, WebP or SVG image up to 10 MB.'));
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t('home.wall.unreadable', 'The image could not be opened.')));
      img.src = url;
    });
    const W = 640, H = 360;
    const w = img.naturalWidth || W, h = img.naturalHeight || H;
    const scale = Math.min(W / w, H / h);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(img, (W - w * scale) / 2, (H - h * scale) / 2, w * scale, h * scale);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 1024 * 1024) throw new Error(t('home.wall.tooLarge', 'The prepared image is too large. Choose a smaller image.'));
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

function homeCardIconPicked(input) {
  if (input.files[0]) homeCardIconSend(input.files[0]);
}

async function homeCardIconSend(file) {
  const id = homeCardIconTarget;
  if (!file || !id || !homeWritable()) return;
  const app = homeCardIconApp(id);
  const chosen = (homeLayout.appIcons || {})[id];
  // Its chosen icon is replaced; otherwise it is named for its title, which it
  // then takes by name, or for its app id where the title has no letters for one.
  const byTitle = homeCardIconKey(app.title);
  const name = chosen || byTitle || ('app_' + homeCardIconKey(id)).slice(0, 80);
  homeCardIconNote = { id, text: t('home.cardIconUploading', 'Uploading…'), busy: true };
  renderHomeCardIconModal();
  try {
    const blob = await homePrepareCardIcon(file);
    const res = await fetch(api('/api/home/card-icons/upload?name=' + encodeURIComponent(name)), {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob
    });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error(r.error || t('home.wall.uploadFailed', 'The image could not be uploaded.'));
    homeCardIcons = r.names || homeCardIcons;
    if (!chosen && !byTitle) await homeSaveLayout({ appIcons: { [id]: name } });
    homeCardIconNote = { id, text: t('home.cardIconDone', 'Uploaded. Home shows it within a few seconds.') };
  } catch (e) { homeCardIconNote = { id, text: e.message }; }
  await loadHome();
  renderHomeCardIconModal();
}

async function homeCardIconRemove() {
  const id = homeCardIconTarget;
  const app = homeCardIconApp(id);
  const name = app.card ? (/[?&]name=([a-z0-9_]+)/.exec(app.card) || [])[1] : '';
  if (!id || !name || !homeWritable()) return;
  homeCardIconNote = null;
  try {
    const r = await homePost('/api/home/card-icons/remove', { name });
    homeCardIcons = r.names || [];
  } catch (e) { homeCardIconNote = { id, text: e.message }; }
  await loadHome();
  renderHomeCardIconModal();
}

// The own sound: its file on the TV, shown with Upload and Remove while it is chosen.
function renderHomeNavSound(st) {
  const name = (st.layout && st.layout.navSound) || 'off';
  const own = st.layout && st.layout.ownSound;
  const box = q('home-nav-sound-own');
  if (!box) return;
  const usable = homeWritable();
  q('home-nav-sound-play').disabled = name === 'off' || (name === 'own' && !own);
  box.hidden = name !== 'own';
  q('home-nav-sound-upload').disabled = !usable;
  q('home-nav-sound-remove').hidden = !own;
  q('home-nav-sound-remove').disabled = !usable;
  const note = q('home-nav-sound-note');
  if (!note.dataset.busy) {
    note.textContent = own
      ? t('home.navSound.ownFile', '{type}, {size} KB', { type: own.type.replace('audio/', '').replace('mpeg', 'mp3').toUpperCase(), size: Math.max(1, Math.round(own.size / 1024)) })
      : t('home.navSound.ownNone', 'No sound uploaded yet.');
  }
}

let homeNavPreview = null;
function homeNavSoundPlay(which) {
  const name = q(which === 'pointer' ? 'home-pointer-sound-sel' : 'home-nav-sound-sel').value;
  if (name === 'off') return;
  if (homeNavPreview) homeNavPreview.pause();
  homeNavPreview = new Audio(api('/api/home/nav-sound?name=' + encodeURIComponent(name) + '&t=' + Date.now()));
  homeNavPreview.play().catch(() => {});
}

async function homeNavSoundPicked(input) {
  const file = input.files[0];
  input.value = '';
  if (!file || !homeWritable()) return;
  const note = q('home-nav-sound-note');
  note.dataset.busy = '1';
  note.textContent = t('home.cardIconUploading', 'Uploading…');
  try {
    if (file.size > 512 * 1024) throw new Error(t('home.navSound.tooLarge', 'Choose an OGG, WAV or MP3 file of up to 512 KB.'));
    const res = await fetch(api('/api/home/nav-sound/upload'), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file
    });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error(r.error || t('home.navSound.uploadFailed', 'The sound could not be uploaded.'));
    delete note.dataset.busy;
  } catch (e) { note.textContent = e.message; setTimeout(() => { delete note.dataset.busy; }, 8000); }
  await loadHome();
}

async function homeNavSoundRemove() {
  if (!homeWritable()) return;
  try { await homePost('/api/home/nav-sound/remove', {}); }
  catch (e) { q('home-nav-sound-note').textContent = e.message; }
  await loadHome();
}

function homeSearch() {
  homeSaveLayout({ search: homeLayout.search !== true });
}

function homeAlternative() {
  homeSaveLayout({ view: homeLayout.view === 'alternative' ? 'standard' : 'alternative' });
}

function homeAnim(style) {
  homeSaveLayout({ wallAnim: style });
}

/*
 * The background, as one choice of three with only that one's settings
 * shown: None is no animation over the Black wallpaper, Pictures no
 * animation over a picture set or the owner's own, Animated one of the
 * scenes. Switching back returns to the set or scene last used here.
 */
const HOME_ANIMS = ['waves', 'particles', 'aquarium', 'aurora', 'glow', 'stars', 'ripples'];
const homeBgLast = { scene: 'waves', set: 'landscape' };
let homeBgSelectedKind = null;
// The Video wallpaper's and screen saver's own look, as lib/home-wallpapers keeps it.
// The Screen savers tab sets the rest of it (ui/screensavers.js).
const HOME_VIDEO_STYLE = { showClock: true, showDate: true, showWeather: true, showCaptions: true,
  infoPosition: 'top-right', captionPosition: 'top-left', clockFont: 'Outfit', textFont: 'Manrope', captionFont: 'Manrope',
  textColor: '#ece7df', infoSize: 100, captionSize: 32 };
// Sizes in Home's 1920-wide pixels; 100 and 32 are Home's own clock and caption.
const HOME_VIDEO_SIZES = { infoSize: [72, 86, 100, 128], captionSize: [24, 32, 40, 48] };

// The four corners, sizes and faces, as both tabs offer them.
function homeVideoChoices() {
  return {
    corners: [['top-left', t('home.video.topLeft', 'Top left')], ['top-right', t('home.video.topRight', 'Top right')],
      ['bottom-left', t('home.video.bottomLeft', 'Bottom left')], ['bottom-right', t('home.video.bottomRight', 'Bottom right')]],
    sizes: [t('home.video.small', 'Small'), t('home.video.medium', 'Medium'), t('home.video.large', 'Large'), t('home.video.extraLarge', 'Extra large')],
    fonts: [['Outfit', 'Outfit'], ['Manrope', 'Manrope']]
  };
}

function homeVideoStyle() {
  return Object.assign({}, HOME_VIDEO_STYLE, (homeStatus && homeStatus.wallpapers && homeStatus.wallpapers.videoStyle) || {});
}

function homeVideoCount() {
  const count = q('home-video-urls').value.split(/\r?\n/).filter(value => value.trim()).length;
  const max = (homeStatus && homeStatus.wallpapers && homeStatus.wallpapers.maxVideoSources) || 50;
  q('home-video-count').textContent = t('home.video.sourceCount', '{count} links, up to {max} videos', { count, max });
}

// Shuffle and the look save as they are changed; the links wait for Save, as reading a playlist takes a moment.
async function homeVideoOptions(patch) {
  if (!homeWritable() || homeWallUploading) return;
  homeWallUploading = 'video-options';
  renderHomeBg();
  try {
    const r = await homePost('/api/home/wallpapers', patch);
    if (r.wallpapers) homeStatus.wallpapers = r.wallpapers;
  } catch (e) { showErr(e.message); }
  finally {
    homeWallUploading = false;
    renderHomeBg();
  }
}

function homeVideoShuffle() {
  homeVideoOptions({ videoShuffle: !(homeStatus.wallpapers || {}).videoShuffle });
}

function homeVideoShow(key) {
  homeVideoOptions({ videoStyle: { [key]: homeVideoStyle()[key] === false } });
}

function homeVideoStyleSet(patch) {
  homeVideoOptions({ videoStyle: patch });
}

function renderHomeVideo(busy) {
  const walls = homeStatus.wallpapers || {}, style = homeVideoStyle();
  const videoUrls = q('home-video-urls');
  if (!videoUrls) return;
  if (document.activeElement !== videoUrls) videoUrls.value = (walls.videoInputs || walls.videoUrls || []).join('\n');
  homeVideoCount();
  videoUrls.disabled = busy;
  q('home-video-save').disabled = busy;
  q('home-video-save').textContent = homeWallUploading === 'video' ? t('home.video.saving', 'Reading the playlist…') : t('home.video.save', 'Save videos');
  const pill = (el, on) => {
    updateToggle(el, { cls: on ? 'good' : 'idle', label: on ? t('common.on', 'On') : t('common.off', 'Off') });
    el.disabled = busy;
  };
  pill(q('home-video-shuffle'), !!walls.videoShuffle);
  pill(q('home-video-show-captions'), style.showCaptions !== false);
  const { corners, sizes, fonts } = homeVideoChoices();
  const choices = (id, key, options) => {
    q(id).innerHTML = options.map(([value, label]) =>
      `<button type="button" class="${style[key] === value ? 'on' : ''}" ${busy ? 'disabled' : ''} aria-pressed="${style[key] === value}"
        onclick="homeVideoStyleSet(${esc(JSON.stringify({ [key]: value }))})">${esc(label)}</button>`).join('');
  };
  choices('home-video-caption-position', 'captionPosition', corners);
  choices('home-video-caption-size', 'captionSize', HOME_VIDEO_SIZES.captionSize.map((size, i) => [size, sizes[i]]));
  choices('home-video-caption-font', 'captionFont', fonts);
}

function homeBgKind() {
  const anim = (homeLayout && homeLayout.wallAnim) || 'off';
  const choice = (homeStatus && homeStatus.wallpapers && homeStatus.wallpapers.choice) || 'own';
  const saved = anim !== 'off' ? 'animated' : choice === 'black' ? 'none' : choice === 'video' ? 'video' : 'pictures';
  // A kind picked here that the TV has not taken yet (Video before its first Save) shows until it does.
  if (homeBgSelectedKind === saved) homeBgSelectedKind = null;
  return homeBgSelectedKind || saved;
}

function renderHomeBg() {
  const kindBox = q('home-bg-kind');
  if (!kindBox || !homeStatus) return;
  const kind = homeBgKind(), busy = !homeWritable() || !!homeWallUploading;
  const anim = (homeLayout && homeLayout.wallAnim) || 'off';
  const choice = (homeStatus.wallpapers && homeStatus.wallpapers.choice) || 'own';
  if (anim !== 'off') homeBgLast.scene = anim;
  if (choice !== 'black' && choice !== 'video') homeBgLast.set = choice;
  const kinds = [['none', t('home.bg.none', 'None')], ['pictures', t('home.bg.pictures', 'Pictures')], ['animated', t('home.bg.animated', 'Animated')], ['video', t('home.bg.video', 'Video')]];
  kindBox.innerHTML = kinds.map(([k, label]) => `<button type="button" class="${k === kind ? 'on' : ''}" ${busy ? 'disabled' : ''}
    aria-pressed="${k === kind}" onclick="homeBgChoose('${k}')">${esc(label)}</button>`).join('');
  q('home-bg-pictures').hidden = kind !== 'pictures';
  q('home-bg-animated').hidden = kind !== 'animated';
  q('home-bg-video').hidden = kind !== 'video';
  renderHomeVideo(busy);
  const dark = document.querySelector('#homepane .home-dark') || document.querySelector('.home-dark');
  if (dark) dark.hidden = kind === 'none';
  const names = { waves: t('home.anim.waves', 'Light waves'), particles: t('home.anim.particles', 'Particles'),
    aquarium: t('home.anim.aquarium', 'Aquarium'), aurora: t('home.anim.aurora', 'Aurora'), glow: t('home.anim.glow', 'Glow'),
    stars: t('home.anim.stars', 'Constellations'), ripples: t('home.anim.ripples', 'Ripples') };
  q('home-anim-scenes').innerHTML = HOME_ANIMS.map(k => `<button type="button" class="${k === anim ? 'on' : ''}" ${busy ? 'disabled' : ''}
    aria-pressed="${k === anim}" onclick="homeAnim('${k}')">${esc(names[k])}</button>`).join('');
  renderHomeAnimColours(homeLayout, anim);
}

async function homeBgChoose(kind) {
  if (!homeWritable() || homeWallUploading || kind === homeBgKind()) return;
  homeBgSelectedKind = kind;
  renderHomeBg();
  const choice = (homeStatus.wallpapers && homeStatus.wallpapers.choice) || 'own';
  if (kind === 'animated') return homeSaveLayout({ wallAnim: homeBgLast.scene });
  if (homeLayout && homeLayout.wallAnim && homeLayout.wallAnim !== 'off') await homeSaveLayout({ wallAnim: 'off' });
  if (kind === 'none' && choice !== 'black') return homeWallSet('black');
  if (kind === 'video') {
    const walls = homeStatus.wallpapers || {};
    q('home-video-urls').value = (walls.videoInputs || walls.videoUrls || []).join('\n');
    // With videos saved, they play now; without, the section waits for its first Save.
    if ((walls.videoUrls || []).length && choice !== 'video') return homeWallSet('video');
    renderHomeBg();
    return;
  }
  if (kind === 'pictures' && (choice === 'black' || choice === 'video')) return homeWallSet(homeBgLast.set);
  renderHomeBg();
}

async function homeVideoSave() {
  if (!homeWritable() || homeWallUploading) return;
  const note = q('home-video-note');
  const urls = q('home-video-urls').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  note.textContent = '';
  homeWallUploading = 'video';
  renderHomeBg();
  try {
    if (homeLayout && homeLayout.wallAnim && homeLayout.wallAnim !== 'off') await homeSaveLayout({ wallAnim: 'off' });
    const r = await homePost('/api/home/wallpapers', { videoUrls: urls, videoShuffle: !!(homeStatus.wallpapers || {}).videoShuffle });
    const n = ((r.wallpapers || {}).videoUrls || []).length;
    note.textContent = n ? t('home.video.saved', '{count} videos ready.', { count: n }) : '';
  } catch (e) { note.textContent = e.message; }
  finally {
    homeWallUploading = false;
    await loadHome();
    renderHomeWalls();
  }
}

function homeReopenWake() {
  homeSaveLayout({ reopenAfterWake: homeLayout.reopenAfterWake === false });
}

function homeRowsBottom() {
  homeSaveLayout({ rowsBottom: homeLayout.rowsBottom !== true });
}

function homeFade() {
  homeSaveLayout({ fade: homeLayout.fade !== true });
}

// Glasshouse Home's kinds of motion other than the fade, each on unless switched off.
const HOME_MOTION = ['wallDrift', 'wallCrossfade', 'smoothScroll', 'slidePanels'];
function homeMotion(key) {
  homeSaveLayout({ [key]: homeLayout[key] === false });
}

// A group shows only while it has a row to show: LG's Home leaves only Starting
// up, and Glasshouse Bar, which leaves LG's Home in place, the rows it follows
// too (home-bar-row: Smooth scrolling).
function homeGroupsShown() {
  const lgHome = q('home-custom').classList.contains('lg-home');
  const bar = homeBarOn();
  document.querySelectorAll('#home-custom .home-group').forEach(g => {
    const shown = [...g.querySelectorAll('.prot-row')].filter(r => !r.hidden &&
      !(lgHome && r.classList.contains('home-gh-row') && !(bar && r.classList.contains('home-bar-row'))));
    g.hidden = !shown.length;
    // Hidden rows can come last, so the last shown one is marked to drop its line.
    g.querySelectorAll('.prot-row').forEach(r => r.classList.toggle('last', r === shown[shown.length - 1]));
  });
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
  renderHomeBg();
  const walls = homeStatus.wallpapers || {};
  const has = walls.slots || {};
  const busy = !homeWritable() || !!homeWallUploading || walls.uploading;
  const names = HOME_WALL_NAMES();
  const now = homeWallNow();
  const c = (homeLayout && homeLayout.colours) || homeOwnLook(homeStatus.colourPresets || []) || { text: '#ece7df', accent: '#e9ad55' };
  // The owner's own pictures are uploaded to the times of day; a set's are shown as they are.
  const choice = walls.choice || 'own';
  const own = choice === 'own';
  const getting = walls.fetching || (/^set:/.test(homeWallUploading || '') ? homeWallUploading.slice(4) : '');
  const choiceBox = q('home-wall-choice');
  if (choiceBox) {
    const label = { black: t('home.wall.setBlack', 'Black'), landscape: t('home.wall.setLandscape', 'Landscape'),
      abstract: t('home.wall.setAbstract', 'Abstract'), own: t('home.wall.setOwn', 'Your own'),
      shuffle: t('home.wall.setShuffle', 'Your own, shuffled'), video: t('home.bg.video', 'Video') };
    // Black is the background's None, chosen above.
    choiceBox.innerHTML = (walls.choices || ['black', 'landscape', 'abstract', 'own']).filter(name => name !== 'black' && name !== 'video').map(name =>
      `<button type="button" class="${name === choice ? 'on' : ''}${name === getting ? ' busy' : ''}" ${busy ? 'disabled' : ''}
        aria-pressed="${name === choice}" onclick="homeWallSet('${name}')">${esc(name === getting ? t('home.wall.examplesBusy', 'Downloading…') : label[name] || name)}</button>`).join('');
  }
  const shuffled = choice === 'shuffle';
  q('home-wall-intro').textContent = shuffled
    ? t('home.wall.introShuffle', 'Pictures of your own, up to {max}, shown one at a time in a random order: each comes round once before any comes again.', { max: walls.maxPictures || 50 })
    : t('home.wall.introPictures', 'A picture for each part of the day: one of the picture sets, or your own.');
  q('home-wall-help').hidden = !own && !shuffled;
  q('home-wall-clear').hidden = !own && !shuffled;
  q('home-wall-clear').disabled = busy || (shuffled ? !(walls.pictures || []).length : !walls.available);
  if (q('home-wall-day')) q('home-wall-day').hidden = shuffled;
  box.hidden = shuffled;
  q('home-wall-shuffle').hidden = !shuffled;
  clearTimeout(homeWallTimer);
  if (walls.uploading) homeWallTimer = setTimeout(() => { if (activeTab === 'home') loadHome(); }, 2000);
  if (shuffled) return renderHomeShuffle(walls, busy, c);

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

/*
 * The shuffled collection: how often a new picture comes, a card to add more
 * (several at once, or dropped on it), and each picture with Remove.
 */
function renderHomeShuffle(walls, busy, c) {
  const pictures = walls.pictures || [], max = walls.maxPictures || 50, full = pictures.length >= max;
  const minutes = (homeLayout && homeLayout.wallShuffleMinutes) || 10;
  const sel = q('home-shuffle-minutes');
  sel.innerHTML = ((homeLayout && homeLayout.shuffleMinutes) || [1, 5, 10, 15, 30, 60]).map(m =>
    `<option value="${m}" ${m === minutes ? 'selected' : ''}>${esc(m === 60 ? t('home.wall.everyHour', '1 hour') : t('home.wall.everyMinutes', '{n} min', { n: m }))}</option>`).join('');
  sel.disabled = !homeWritable();
  const box = q('home-shuffle');
  box.style.setProperty('--look-text', c.text);
  box.style.setProperty('--look-accent', c.accent);
  const sending = homeWallUploading === 'shuffle' || (walls.uploading && !homeWallUploading);
  const adder = `<div class="wall-card${sending ? ' busy' : ''}" data-add="1">
      <button type="button" class="wall-screen" id="home-shuffle-add" onclick="homeShuffleChoose()" ${busy || full ? 'disabled' : ''}
          aria-label="${esc(t('home.wall.addPictures', 'Add pictures'))}">
        ${full ? '' : `<span class="wall-add">${esc(t('home.wall.addPictures', 'Add pictures'))}</span>`}
        ${sending ? `<span class="wall-sending">${esc(t('home.wall.uploading', 'Uploading…'))}</span>` : ''}
      </button>
      <div class="wall-actions"><span class="wall-count">${esc(t('home.wall.pictureCount', '{n} of {max}', { n: pictures.length, max }))}</span></div>
    </div>`;
  box.innerHTML = adder + pictures.map((id, i) => `<div class="wall-card has fixed" data-picture="${esc(id)}">
      <button type="button" class="wall-screen" tabindex="-1" disabled aria-label="${esc(t('home.wall.pictureN', 'Picture {n}', { n: i + 1 }))}"
          style="background-image:url('${esc(api('/api/home/wallpaper?slot=shuffle&id=' + encodeURIComponent(id)))}')"></button>
      <div class="wall-actions"><button type="button" class="wall-link" onclick="homeShuffleRemove('${esc(id)}')" ${busy ? 'disabled' : ''}>${esc(t('home.wall.remove', 'Remove'))}</button></div>
    </div>`).join('');
  // Images dropped on the card to add are added, as many as there is room for.
  const add = q('home-shuffle-add');
  add.addEventListener('dragover', e => { if (busy || full) return; e.preventDefault(); add.classList.add('drop'); });
  add.addEventListener('dragleave', () => add.classList.remove('drop'));
  add.addEventListener('drop', e => {
    e.preventDefault();
    add.classList.remove('drop');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length && !busy && !full) homeUploadShuffle(files);
  });
}

function homeShuffleMinutes(v) {
  homeSaveLayout({ wallShuffleMinutes: Number(v) });
}

function homeShuffleChoose() {
  if (!homeWritable() || homeWallUploading) return;
  const input = q('home-shuffle-file');
  input.value = '';
  input.click();
}

function homeShufflePicked(input) {
  const files = Array.from(input.files || []);
  if (files.length) homeUploadShuffle(files);
}

// One after another, as the TV takes one upload at a time; what does not fit is said.
async function homeUploadShuffle(files) {
  if (!homeWritable() || homeWallUploading) return;
  const note = q('home-wall-upload-note');
  const walls = (homeStatus && homeStatus.wallpapers) || {};
  const room = Math.max(0, (walls.maxPictures || 50) - (walls.pictures || []).length);
  const take = files.slice(0, room);
  homeWallUploading = 'shuffle';
  note.textContent = '';
  renderHomeWalls();
  let done = 0, failed = '';
  for (const file of take) {
    note.textContent = t('home.wall.uploadingOf', 'Uploading {n} of {total}…', { n: done + 1, total: take.length });
    try {
      const blob = await homePrepareWall(file);
      const res = await fetch(api('/api/home/wallpapers/upload?slot=shuffle'), {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob
      });
      const r = await res.json();
      if (!res.ok || !r.ok) throw new Error(r.error || t('home.wall.uploadFailed', 'The image could not be uploaded.'));
      done++;
    } catch (e) { failed = file.name + ': ' + e.message; }
  }
  homeWallUploading = false;
  const parts = [t('home.wall.uploadedN', '{n} of {total} uploaded.', { n: done, total: files.length })];
  if (files.length > take.length) parts.push(t('home.wall.shuffleRoom', 'The collection holds {max} pictures.', { max: walls.maxPictures || 50 }));
  if (failed) parts.push(failed);
  note.textContent = parts.join(' ');
  await loadHome();
  renderHomeWalls();
}

async function homeShuffleRemove(id) {
  if (!homeWritable() || homeWallUploading) return;
  q('home-wall-upload-note').textContent = '';
  try { await homePost('/api/home/wallpapers', { removePicture: id }); }
  catch (e) { q('home-wall-upload-note').textContent = e.message; }
  await loadHome();
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

// An image as the JPEG the TV takes: within 1920 x 1080, the size Glasshouse
// Home is drawn at, which the server holds uploads to.
async function homePrepareWall(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) {
    throw new Error(t('home.wall.chooseImage', 'Choose a JPEG, PNG or WebP image up to 25 MB.'));
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t('home.wall.unreadable', 'The image could not be opened.')));
      img.src = url;
    });
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
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

async function homeUploadWall(slot, file) {
  if (!file || !homeWritable() || homeWallUploading) return;
  const note = q('home-wall-upload-note');
  homeWallUploading = slot;
  note.textContent = '';
  renderHomeWalls();
  try {
    const blob = await homePrepareWall(file);
    const res = await fetch(api('/api/home/wallpapers/upload?slot=' + slot), {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob
    });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error(r.error || t('home.wall.uploadFailed', 'The image could not be uploaded.'));
    note.textContent = t('home.wall.uploadDone', 'Image uploaded. Home updates within a few seconds.');
  } catch (e) { note.textContent = e.message; }
  finally {
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
  const shuffled = homeStatus && homeStatus.wallpapers && homeStatus.wallpapers.choice === 'shuffle';
  try { await homePost('/api/home/wallpapers', shuffled ? { removePictures: true } : { removeUploads: true }); }
  catch (e) { q('home-wall-upload-note').textContent = e.message; }
  await loadHome();
}

/* The wallpaper's darkening behind the text and rows, in 5% steps, saved on
   release as OLED light is. */
let homeDarkDragging = false;

function showHomeDarkening(v) {
  if (q('home-dark-slider')) q('home-dark-slider').value = v;
  if (q('home-dark-fill')) q('home-dark-fill').style.width = v + '%';
  if (q('home-dark-lbl')) q('home-dark-lbl').textContent = v === 0 ? t('common.off', 'Off') : v + '%';
}

function initHomeDarkSlider() {
  const wrap = q('home-dark-wrap');
  const slider = q('home-dark-slider');
  if (!wrap || !slider) return;
  let active = false;
  const at = e => {
    const r = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 20) * 5));
  };
  const save = v => { showHomeDarkening(v); return homeSaveLayout({ darkening: v }); };
  const stop = e => {
    active = false;
    homeDarkDragging = false;
    wrap.classList.remove('dragging');
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !homeWritable()) return;
    active = true;
    homeDarkDragging = true;
    wrap.classList.add('dragging');
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    showHomeDarkening(at(e));
  });
  wrap.addEventListener('pointermove', e => { if (active) showHomeDarkening(at(e)); });
  wrap.addEventListener('pointerup', e => {
    if (!active) return;
    stop(e);
    save(at(e));
  });
  wrap.addEventListener('pointercancel', e => {
    if (!active) return;
    stop(e);
    showHomeDarkening(homeLayout && typeof homeLayout.darkening === 'number' ? homeLayout.darkening : 100);
  });
  slider.addEventListener('keydown', e => {
    const steps = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 25, PageDown: -25 };
    let v;
    if (steps[e.key]) v = Number(slider.value) + steps[e.key];
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = 100;
    else return;
    e.preventDefault();
    if (homeWritable()) save(Math.max(0, Math.min(100, v)));
  });
}

initHomeDarkSlider();
