// Installing apps from the Homebrew Channel catalog, a URL or an uploaded .ipk.

/* ---- Install apps (Homebrew Channel catalog) ---- */
let catalogData = null;
let catalogLoading = false;
let installSnap = null;     // last status from the server
let installTimer = null;
let installOwn = false;     // this page started or resumed the job, so it reports how it ended
let installSideload = null; // whether the server takes URL and upload installs; null until known
let uploading = false;
const INSTALL_BUSY = { downloading: 1, verifying: 1, installing: 1, elevating: 1 };

let catalogAgain = false;
async function loadCatalog(force) {
  // Asked again while a load is out: once more after it, so a change made
  // meanwhile is not lost with the dropped request.
  if (catalogLoading) { catalogAgain = true; return; }
  catalogLoading = true;
  try {
    const r = await fetch(api('/api/apps/catalog' + (force ? '?force=1' : '')), { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    catalogData = d;
    if (!r.ok && d.error) showErr(d.error);
  } catch (e) {
    catalogData = { ok: false, apps: [], error: e.message };
  } finally {
    catalogLoading = false;
  }
  renderCatalog();
  if (catalogAgain) { catalogAgain = false; loadCatalog(); }
}

// Error text starts lower-case; a host name at the start keeps its case.
function sentence(text) {
  text = String(text || '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(?![\w-])/i.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function installIdle() {
  return !installSnap || !(INSTALL_BUSY[installSnap.state] || installSnap.state === 'awaiting-confirm');
}

let catalogCategory = 'all';

function appCategory(a) {
  // If the repository provides an explicit category, use it directly
  if (a.category) {
    const c = String(a.category).toLowerCase().trim();
    if (c === 'game' || c === 'games' || c === 'emulator' || c === 'emulators') return 'game';
    if (c === 'screensaver' || c === 'screensavers') return 'screensaver';
    if (c === 'amblight' || c === 'ambilight' || c === 'lighting') return 'amblight';
    if (c === 'multimedia' || c === 'media' || c === 'video' || c === 'audio' || c === 'music' || c === 'streaming' || c === 'internet') return 'multimedia';
    if (c === 'utility' || c === 'utilities' || c === 'system' || c === 'tools') return 'utility';
    return c;
  }
  // Dynamic keyword and topic classification from package metadata (no hardcoded app IDs)
  const text = ((a.id || '') + ' ' + (a.title || '') + ' ' + (a.description || '')).toLowerCase();
  if (text.includes('screensaver') || text.includes('screen saver') || text.includes('idlegif')) return 'screensaver';
  if (text.includes('piccap') || text.includes('hyperion') || text.includes('hyperhdr') || text.includes('ambilight')) return 'amblight';
  if (!text.includes('terminal') && (text.includes('game') || text.includes('gaming') || text.includes('pinball') || text.includes('doom') || text.includes('retroarch') || text.includes('emulator') || text.includes('arcade') || text.includes('openttd') || text.includes('steam link') || text.includes('gamestream') || text.includes('punktfunk'))) {
    return 'game';
  }
  if (text.includes('player') || text.includes('jellyfin') || text.includes('plex') || text.includes('kodi') || text.includes('stream') || text.includes('media') || text.includes('video') || text.includes('music') || text.includes('audio') || text.includes('twitch') || text.includes('youtube') || text.includes('bilibili') || text.includes('crunchyroll') || text.includes('iptv') || text.includes('photo') || text.includes('gallery') || text.includes('immich') || text.includes('subsonic') || text.includes('cinema') || text.includes('decotv') || text.includes('tvheadend')) {
    return 'multimedia';
  }
  return 'utility';
}

function setCatalogCategory(cat) {
  catalogCategory = cat;
  const container = q('catalog-categories');
  if (container) {
    const btns = container.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].dataset.cat === cat);
    }
  }
  renderCatalog();
}

function matchesSearch(a, term) {
  if (!term) return true;
  return (a.title || '').toLowerCase().includes(term) || (a.id || '').toLowerCase().includes(term) ||
    (a.description || '').toLowerCase().includes(term);
}

/*
 * A long list shows CATALOG_PAGE apps and a button for more, rather than
 * pages, so a list rebuilt after an install keeps what was opened. A new
 * search or category starts again from the first. A row that is installing,
 * waiting for its preview, failed or flashing its outcome is always shown,
 * so its progress or error is not hidden with it.
 */
const CATALOG_PAGE = 10;
const catalogShown = { main: { limit: CATALOG_PAGE, key: '' }, others: { limit: CATALOG_PAGE, key: '' } };

function pagedRows(which, key, apps, row) {
  const st = catalogShown[which];
  if (st.key !== key) { st.key = key; st.limit = CATALOG_PAGE; }
  const job = catalogJob();
  const keep = a => (job && job.appId === a.id && (job.repo || '') === (a.repo || '')) ||
    !!rowError[a.id] || !!uninstalling[a.id] || !!rowFlashing(a.id);
  const visible = apps.filter((a, i) => i < st.limit || keep(a));
  const more = apps.length - visible.length;
  const footer = more > 0 ? `<div class="catalog-more">
      <span class="sub">${esc(t('apps.install.shownOf', '{shown} of {total}', { shown: visible.length, total: apps.length }))}</span>
      <button type="button" class="pill idle" onclick="showMoreCatalog('${which}')">${esc(t('apps.install.showMore', 'Show {n} more', { n: Math.min(CATALOG_PAGE, more) }))}</button>
    </div>` : '';
  return visible.map(row).join('') + footer;
}

function showMoreCatalog(which) {
  catalogShown[which].limit += CATALOG_PAGE;
  if (which === 'main') renderCatalog();
  else renderOtherCatalogs();
}

function renderCatalog() {
  const list = q('apps-catalog-list');
  if (!list || !catalogData) return;
  renderOtherCatalogs();
  const d = catalogData;
  const apps = d.apps || [];
  const writable = !appsData || appsData.writable !== false;
  q('apps-catalog-summary').textContent = d.ok ? t('apps.count', '{n} apps', { n: apps.length }) : '';
  const msgEl = q('catalog-msg');
  msgEl.textContent = sentence(d.error);
  if (!d.ok) {
    list.innerHTML = `<div class="sub" style="padding:16px 0">${esc(t('apps.install.unavailable', 'The catalog could not be loaded. The TV needs internet access to reach it.'))}</div>`;
    return;
  }
  const term = q('catalog-search').value.trim().toLowerCase();
  const shown = apps.filter(a => (catalogCategory === 'all' || appCategory(a) === catalogCategory) && matchesSearch(a, term));
  if (!shown.length) {
    list.innerHTML = `<div class="sub" style="padding:16px 0">${esc(t('apps.install.noMatch', 'No apps match.'))}</div>`;
    return;
  }
  list.innerHTML = pagedRows('main', catalogCategory + '|' + term, shown, a => catalogRow(a, writable));
}

/*
 * One app's row, in the Homebrew Channel's list or the added catalogs'. from
 * names the catalog an app came from, in the added catalogs' list.
 */
function catalogRow(a, writable, from) {
  const idle = installIdle();
  const job = catalogJob();
  let label, cls = 'idle', off = !writable || !idle || !!uninstalling[a.id], isInstalled = false, fill = '';
  const flash = rowFlashing(a.id);
  if (job && job.appId === a.id && (job.repo || '') === (a.repo || '')) {
    label = jobLabel(job); cls = 'busy'; off = true;
    fill = ` style="--p:${job.state === 'awaiting-confirm' ? 0 : instProg.pct}%"`;
  }
  else if (uninstalling[a.id]) { label = t('apps.uninstall.working', 'Uninstalling\u2026'); cls = 'busy'; off = true; }
  else if (flash) { label = flash.label; cls = flash.cls; off = true; }
  else if (a.state === 'hbc') { label = t('apps.install.viaHbc', 'Updates through Homebrew Channel'); off = true; }
  else if (a.state === 'installed') { label = t('apps.uninstall.button', 'Uninstall'); cls = 'bad'; isInstalled = true; }
  else if (a.state === 'update') { label = t('apps.install.update', 'Update'); cls = 'warn'; }
  // state 'store': what the TV has under this id is the LG store's app, not
  // this one, so it is offered as not installed; the preview asks before
  // replacing the store's copy.
  else { label = t('apps.install.button', 'Install'); cls = 'good'; }
  const icon = a.iconUri
    ? `<img src="${esc(a.iconUri)}" width="38" height="38" loading="lazy" referrerpolicy="no-referrer" alt="" style="border-radius:8px;object-fit:contain;background:var(--w06);flex-shrink:0" onerror="this.style.visibility='hidden'">`
    : '<span style="width:38px;height:38px;flex-shrink:0"></span>';
  const meta = [a.version ? 'v' + a.version : '', from ? from(a) : '',
    a.state === 'update' && a.installedVersion ? t('apps.install.have', 'installed: v{version}', { version: a.installedVersion }) : ''
  ].filter(Boolean).join(' · ');
  const sizeBadge = (a.size && typeof fmtSize === 'function') ? fmtSize(a.size) : '';
  const root = a.rootRequired ? ` <span class="pill warn" style="padding:1px 8px">${esc(t('apps.install.rootBadge', 'root'))}</span>` : '';
  const clickFn = isInstalled
    ? `confirmUninstall('${jsq(a.id)}', '${jsq(a.title || a.id)}');`
    : `startInstall('${jsq(a.id)}', '${jsq(a.repo || '')}');`;
  return `<div class="prot-row">
    ${icon}
    <div class="prot-main">
      <div class="prot-title">${esc(a.title || a.id)}${root}${meta ? ` <span class="prot-sub">&middot; ${esc(meta)}</span>` : ''}</div>
      <div class="prot-desc">${esc(a.description || a.id)}</div>
      ${rowErrorNote(a.id)}
    </div>
    <div class="prot-status">
      ${sizeBadge ? `<span class="app-badge" title="${esc(t('apps.installed.storageTooltip', 'Storage footprint'))}">${esc(sizeBadge)}</span>` : ''}
      ${a.installedVersion !== null && a.installedVersion !== undefined && a.state !== 'store' && !uninstalling[a.id] ? `<button type="button" class="pill good" onclick="sendCommand('launchApp','${jsq(a.id)}')" ${writable ? '' : 'disabled'}>${esc(t('apps.launch.button', 'Launch'))}</button>` : ''}
      <button type="button" class="pill ${cls}" data-app="${esc(a.id)}" data-repo="${esc(a.repo || '')}" onclick="${clickFn}"${fill} ${off ? 'disabled' : ''}>${esc(label)}</button>
    </div>
  </div>`;
}

function fmtMb(n) {
  return n > 0 && n < 524288 ? t('apps.install.mbUnder1', 'under 1 MB') : t('apps.install.mb', '{n} MB', { n: Math.round(n / 1048576) });
}

/* The update tab's bar, for installs: a download or upload moves it by what
   has arrived, up to 60%, and the steps after ease on towards their marks, as
   nothing reports how far through them the TV is. */
const instProg = makeProgress('inst-prog', 'inst-step', 'inst-bar', null, p => {
  const b = jobButton();
  if (b) b.style.setProperty('--p', p + '%');
});

/*
 * A catalog install or an uninstall shows on the app's own button, wherever
 * the list is scrolled to: busy while it runs, then the outcome for a moment
 * before the button becomes the next action. An error goes under the app's
 * name. Only an install from a URL or a file, which has no row, shows the
 * status and bar under its form.
 */
const ROW_FLASH_MS = 2500;
const rowFlash = {};      // id -> { label, cls, until }
const rowError = {};      // id -> { title, text }

// A row's error, as the page's error banner: what did not happen, then why.
function rowErrorNote(id) {
  const e = rowError[id];
  return e ? `<div class="err-note" role="alert"><b>${esc(e.title)}</b>${esc(e.text)}</div>` : '';
}
const uninstalling = {};  // id -> true

function catalogJob() {
  const s = installSnap;
  return s && s.source === 'catalog' && s.appId && (INSTALL_BUSY[s.state] || s.state === 'awaiting-confirm') ? s : null;
}

function jobButton() {
  const s = catalogJob();
  return s ? Array.from(document.querySelectorAll('#apps-catalog-list [data-app], #apps-others-list [data-app]'))
    .find(b => b.dataset.app === s.appId && b.dataset.repo === (s.repo || '')) : null;
}

function jobLabel(s) {
  switch (s.state) {
    case 'downloading': return t('apps.install.btn.downloading', 'Downloading');
    case 'verifying': return t('apps.install.btn.checking', 'Checking…');
    case 'installing': return t('apps.install.installing', 'Installing…');
    case 'elevating': return t('apps.install.btn.finishing', 'Finishing…');
    case 'awaiting-confirm': return t('apps.install.btn.review', 'Review…');
    default: return '';
  }
}

// Each poll: the job's button, without rebuilding the list under the pointer.
function paintJobButton() {
  const s = catalogJob(), b = jobButton();
  if (!s || !b) return;
  b.textContent = jobLabel(s);
  b.style.setProperty('--p', (s.state === 'awaiting-confirm' ? 0 : instProg.pct) + '%');
}

function flashRow(id, label, cls) {
  rowFlash[id] = { label, cls, until: Date.now() + ROW_FLASH_MS };
  setTimeout(() => { renderCatalog(); if (appsData) renderAppsPanel(); }, ROW_FLASH_MS + 50);
}

function rowFlashing(id) {
  const f = rowFlash[id];
  if (f && f.until > Date.now()) return f;
  delete rowFlash[id];
  return null;
}

// The catalog's own copy says what the TV now has, before the reload confirms
// it, in every list the app is in.
function setCatalogState(id, version) {
  if (!catalogData) return;
  (catalogData.apps || []).concat(catalogData.others || []).forEach(a => {
    if (a.id !== id || a.state === 'hbc') return;
    a.installedVersion = version;
    a.state = version === null ? 'none' : 'installed';
  });
}
const INST_MARK = { downloading: [55, 20000], verifying: [70, 3000], installing: [92, 15000], elevating: [97, 5000] };
let instStage = null;

// A message without the bar: an error, or nothing.
function setInstallStatus(text) {
  clearInterval(instProg.timer);
  instStage = null;
  instProg.set(0);
  q('inst-prog').classList.remove('done');
  q('inst-track').hidden = true;
  q('inst-step').textContent = text || '';
  q('install-status').hidden = !text;
}

function showInstallBar(label) {
  // A new job starts from empty, even straight after one finished full.
  if (instStage === null) instProg.set(0);
  q('install-status').hidden = false;
  q('inst-track').hidden = false;
  q('inst-prog').classList.remove('done');
  q('inst-step').textContent = label;
}

// By what has arrived, for a download or upload of known size.
function setInstallBytes(stage, label, done, total) {
  clearInterval(instProg.timer);
  showInstallBar(label);
  instStage = stage;
  instProg.set(Math.max(instProg.pct, Math.min(60, done / total * 60)));
}

function showInstallProgress(s) {
  const label = progressText(s);
  if (!label) return setInstallStatus('');
  const p = s.progress || {};
  if (s.state === 'downloading' && p.total) return setInstallBytes('downloading', label, p.bytes || 0, p.total);
  showInstallBar(label);
  if (instStage === s.state) return;
  instStage = s.state;
  const mark = INST_MARK[s.state] || [90, 10000];
  instProg.step(label, Math.max(instProg.pct, mark[0]), mark[1]);
}

function progressText(s) {
  const p = s.progress || {};
  switch (s.state) {
    case 'downloading':
      return p.total ? t('apps.install.downloading.of', 'Downloading {done} of {total}', { done: fmtMb(p.bytes || 0), total: fmtMb(p.total) })
        : t('apps.install.downloading', 'Downloading… {done}', { done: fmtMb(p.bytes || 0) });
    case 'verifying': return t('apps.install.verifying', 'Checking the package…');
    case 'installing': return t('apps.install.installing', 'Installing…');
    case 'elevating': return t('apps.install.elevating', 'Setting up root access…');
    default: return '';
  }
}

function renderPreview(pv) {
  const dir = pv.direction;
  const ver = pv.version, from = pv.installedVersion;
  q('inst-title').textContent = (pv.apps && pv.apps[0] && pv.apps[0].title) || pv.package;
  // Replacing the LG store's app: its version is the store's numbering, so
  // the two are not compared.
  q('inst-meta').textContent = pv.package + ' · ' + (
    pv.storeInstalled && from ? t('apps.install.dir.store', 'v{version}, in place of the LG store\'s v{from}', { from, version: ver })
    : dir === 'up' ? t('apps.install.dir.up', 'upgrade from v{from} to v{version}', { from, version: ver })
    : dir === 'down' ? t('apps.install.dir.down', 'downgrade from v{from} to v{version}', { from, version: ver })
    : dir === 'same' ? t('apps.install.dir.same', 'reinstall of v{version}', { version: ver })
    : t('apps.install.dir.new', 'new install of v{version}', { version: ver }));
  const apps = (pv.apps || []).map(a => a.id);
  q('inst-apps').textContent = apps.length > 1 ? t('apps.install.apps', 'Apps: {list}', { list: apps.join(', ') }) : '';
  const svc = pv.services || [];
  q('inst-services-row').hidden = !svc.length;
  q('inst-services').textContent = svc.length ? t('apps.install.services', 'Background services: {list}', { list: svc.join(', ') }) : '';
  q('inst-root').checked = false;
  // An update to an app that had root gets it back without the box ticked.
  const back = pv.reelevate || [];
  const rootNote = back.length ? t('apps.install.root.restored', 'Root is given back to {list} after this update, as before.', { list: back.join(', ') })
    : pv.rootRequired ? t('apps.install.root.needed', 'This app asks for its services to run as root, and may not work without it.') : '';
  q('inst-root-note').hidden = !rootNote;
  q('inst-root-note').textContent = rootNote;
  q('inst-cpu').hidden = !pv.cpuMismatch;
  q('inst-cpu').textContent = !pv.cpuMismatch ? ''
    : t('apps.install.cpu', 'Its programs are built for a different processor than this TV\'s and may not run.');
  q('inst-screensaver').hidden = !pv.isScreensaver;
  q('inst-screensaver').textContent = pv.isScreensaver
    ? t('apps.install.screensaver.listed', 'This app has a screen saver. Once it is installed, choose it on the Screen Saver tab, with Glasshouse’s own.') : '';
  q('inst-space').textContent = pv.freeBytes === null || pv.freeBytes === undefined ? ''
    : t('apps.install.space', 'Free space: {free}. Needed: about {need}.', { free: fmtMb(pv.freeBytes), need: fmtMb(pv.needBytes) });
  const showHash = pv.source !== 'catalog' && !!pv.sha256;
  q('inst-hash').hidden = !showHash;
  q('inst-hash').textContent = showHash ? 'sha256: ' + pv.sha256 : '';
  q('inst-store-row').hidden = !pv.storeInstalled;
  q('inst-replace').checked = false;
}

function renderSideload() {
  q('sideload-off').hidden = installSideload !== false;
  q('sideload-box').hidden = installSideload !== true;
  const off = !installIdle() || uploading;
  ['sl-url', 'sl-sha', 'sl-url-btn', 'sl-file', 'sl-file-btn'].forEach(id => { q(id).disabled = off; });
  const disableBtn = q('btn-sideload-disable');
  if (disableBtn) disableBtn.hidden = !installSnap || installSnap.sideloadVia !== 'config';
  const cur = q('apps-sideload-summary');
  if (cur) cur.textContent = installSideload ? t('common.on', 'On') : t('common.off', 'Off');
  renderOtherCatalogs();
}

async function toggleSideload(enable) {
  if (enable) {
    if (!confirm(t('apps.sideload.enable.confirm', 'Allow installing apps from a URL or an uploaded file?\n\nPackages from outside the catalog are unvetted and can run anything on the TV. Only install packages you trust.'))) return;
  }
  const btn = q(enable ? 'btn-sideload-enable' : 'btn-sideload-disable');
  if (btn) btn.classList.add('busy');
  try {
    const r = await fetch(api('/api/apps/install/sideload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enable })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || t('apps.sideload.failed', 'Could not update sideload setting'));
    installSideload = !!d.sideload;
    if (installSnap) installSnap.sideloadVia = d.sideloadVia;
    renderSideload();
  } catch (e) {
    showErr(e.message);
  } finally {
    if (btn) btn.classList.remove('busy');
  }
}

function isAddedCatalog(repo) {
  return !!repo && !!catalogData && (catalogData.repos || []).some(r => r.url === repo);
}

// repo: the catalog of a catalog install.
function prepareInstallTarget(source, repo) {
  const isSideload = source === 'url' || source === 'file';
  const other = !isSideload && isAddedCatalog(repo);
  const targetDisc = isSideload ? q('disc-sideload-apps') : other ? q('disc-other-catalogs') : q('disc-install-apps');
  const targetAnchor = isSideload
    ? (installSideload ? q('sideload-box') : q('sideload-off'))
    : other ? q('apps-others-list') : q('apps-catalog-list');
  // The preview goes with the status, so it is in the section that is open.
  ['install-status', 'install-modal'].forEach(id => {
    const el = q(id);
    if (targetDisc && targetAnchor && el && el.parentElement !== targetDisc) targetDisc.insertBefore(el, targetAnchor);
  });
  return targetDisc;
}

function renderInstall() {
  const s = installSnap;
  const panel = q('install-panel');
  const modal = q('install-modal');
  renderSideload();
  if (!s) return;
  const targetDisc = prepareInstallTarget(s.source, s.repo);
  if (s.state === 'awaiting-confirm' && s.preview) {
    if (targetDisc) targetDisc.open = true;
    if (panel.dataset.job !== s.jobId) {
      panel.dataset.job = s.jobId;
      renderPreview(s.preview);
    }
    const wasHidden = modal ? modal.hidden : panel.hidden;
    panel.hidden = false;
    if (modal) modal.hidden = false;
    q('inst-confirm').disabled = false;
    q('inst-cancel').disabled = false;
    if (wasHidden) q('inst-confirm').focus();
    // Hidden, not cleared: confirming carries the bar on from where it stood.
    q('install-status').hidden = true;
  } else {
    panel.hidden = true;
    if (modal) modal.hidden = true;
    delete panel.dataset.job;
    showInstallProgress(s);
  }
  if (s.source === 'catalog') {
    q('install-status').hidden = true;
    paintJobButton();
  }
}

function installEnded(s) {
  if (s.source === 'catalog' && s.appId) {
    setInstallStatus('');
    if (s.state === 'installed') {
      setCatalogState(s.appId, (s.result && s.result.version) || '');
      flashRow(s.appId, t('apps.install.installed', 'Installed'), 'good flash');
    } else if (s.state === 'error' || s.state === 'interrupted') {
      const app = (catalogData ? (catalogData.apps || []).concat(catalogData.others || []) : [])
        .find(x => x.id === s.appId && (!s.repo || x.repo === s.repo));
      rowError[s.appId] = {
        title: t('apps.install.notInstalled', '{name} was not installed.', { name: (app && app.title) || s.appId }),
        text: sentence(s.error || t('common.unknownError', 'unknown error'))
      };
      showErr(s.error || t('common.unknownError', 'unknown error'));
    }
    renderCatalog();
    loadApps();
    loadCatalog();
    return;
  }
  if (s.state === 'installed') {
    const r = s.result || {};
    clearInterval(instProg.timer);
    instStage = 'installed';
    showInstallBar('');
    instStage = null;
    instProg.done(t('apps.install.done', 'Installed {name} v{version}.', { name: r.title || r.package || '', version: r.version || '' }));
    setTimeout(() => { if (installIdle()) setInstallStatus(''); }, 8000);
  } else if (s.state === 'error' || s.state === 'interrupted') {
    showErr(s.error || t('common.unknownError', 'unknown error'));
    setInstallStatus(sentence(s.error));
  }
  loadApps();
  loadCatalog();
}

async function pollInstall() {
  clearTimeout(installTimer);
  installTimer = null;
  let s;
  try {
    const r = await fetch(api('/api/apps/install/status'), { cache: 'no-store' });
    s = await r.json();
    if (!r.ok || !s.ok) throw new Error(s.error || 'HTTP ' + r.status);
  } catch (e) {
    // The server may be restarting; keep asking while a job was ours.
    if (installOwn) installTimer = setTimeout(pollInstall, 2000);
    return;
  }
  const was = installSnap;
  const wasIdle = installIdle();
  installSnap = s;
  if (typeof s.sideload === 'boolean') installSideload = s.sideload;
  if (INSTALL_BUSY[s.state] || s.state === 'awaiting-confirm') installOwn = true;
  renderInstall();
  if (INSTALL_BUSY[s.state]) installTimer = setTimeout(pollInstall, 1000);
  else if (s.state === 'awaiting-confirm') installTimer = setTimeout(pollInstall, 5000);   // the preview expires
  const finished = s.state === 'installed' || s.state === 'error' || s.state === 'interrupted' || s.state === 'idle';
  if (installOwn && finished && (!was || was.state !== s.state || was.jobId !== s.jobId)) {
    installOwn = false;
    if (s.state !== 'idle') installEnded(s);
  }
  if (wasIdle !== installIdle()) renderCatalog();
}

async function installPost(path, body) {
  const r = await fetch(api(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || t('apps.install.failed', 'The install could not be started'));
  return j;
}

// repo: the catalog the app is from, which an id in more than one needs.
function startInstall(appId, repo) {
  delete rowError[appId];
  prepareInstallTarget('catalog', repo);
  // The server goes straight on to install unless the preview has a choice or a warning in it.
  const body = { id: appId, auto: true };
  if (repo) body.repo = repo;
  startJob('/api/apps/install/fetch', body);
}

/* ---- Other app catalogs ---- */
function renderOtherCatalogs() {
  const list = q('apps-others-list');
  if (!list || !catalogData) return;
  const repos = catalogData.repos || [];
  const others = catalogData.others || [];
  const writable = !appsData || appsData.writable !== false;
  const canChange = installSideload === true && writable;
  q('apps-catalogs-summary').textContent = !repos.length ? t('apps.catalogs.none', 'None')
    : repos.length === 1 ? t('apps.catalogs.one', '1 catalog')
    : t('apps.catalogs.count', '{n} catalogs', { n: repos.length });
  q('catalogs-off').hidden = installSideload !== false;
  q('catalog-add-form').hidden = !canChange;
  const labels = {};
  repos.forEach(r => { labels[r.url] = r.label; });
  q('apps-catalogs-repos').innerHTML = repos.map(r => `<div class="prot-row">
      <div class="prot-main">
        <div class="prot-title" translate="no">${esc(r.label)}</div>
        <div class="prot-desc catalog-url" translate="no">${esc(r.url)}</div>
        ${r.error ? `<div class="err-note" role="alert"><b>${esc(t('apps.catalogs.unread', 'This catalog could not be read.'))}</b>${esc(sentence(r.error))}</div>` : ''}
      </div>
      <div class="prot-status">
        <span class="app-badge">${esc(t('apps.count', '{n} apps', { n: r.count }))}</span>
        <button type="button" class="pill bad" data-repo-url="${esc(r.url)}" onclick="removeCatalog(this.dataset.repoUrl)" ${canChange ? '' : 'disabled'}>${esc(t('apps.catalogs.remove', 'Remove'))}</button>
      </div>
    </div>`).join('');
  // A search box once there are more apps than one screenful.
  const search = q('others-search');
  q('others-search-form').hidden = others.length <= CATALOG_PAGE && !search.value;
  const term = search.value.trim().toLowerCase();
  const shown = others.filter(a => matchesSearch(a, term) ||
    (labels[a.repo] || '').toLowerCase().includes(term));
  if (!shown.length && others.length) {
    list.innerHTML = `<div class="sub" style="padding:16px 0">${esc(t('apps.install.noMatch', 'No apps match.'))}</div>`;
    return;
  }
  list.innerHTML = pagedRows('others', term, shown, a => catalogRow(a, writable,
    x => t('apps.catalogs.from', 'from {catalog}', { catalog: labels[x.repo] || x.repo })));
}

async function changeCatalogs(body, btn) {
  q('catalogs-msg').textContent = '';
  if (btn) btn.classList.add('busy');
  try {
    await installPost('/api/apps/install/repos', body);
    await loadCatalog(true);
    return true;
  } catch (e) {
    q('catalogs-msg').textContent = sentence(e.message);
    return false;
  } finally {
    if (btn) btn.classList.remove('busy');
  }
}

async function addCatalog() {
  const input = q('catalog-url');
  const url = input.value.trim();
  if (!url) return;
  if (!confirm(t('apps.catalogs.add.confirm', 'Add this catalog?\n\nWhoever runs it chooses what it offers to install, and its apps are not vetted by the Homebrew Channel. Only add a catalog you trust.'))) return;
  q('catalog-add-btn').disabled = true;
  if (await changeCatalogs({ action: 'add', url }, q('catalog-add-btn'))) input.value = '';
  q('catalog-add-btn').disabled = false;
}

async function removeCatalog(url) {
  if (!confirm(t('apps.catalogs.remove.confirm', 'Remove this catalog? Apps installed from it stay on the TV.'))) return;
  await changeCatalogs({ action: 'remove', url });
}

function startUrlInstall() {
  const url = q('sl-url').value.trim();
  if (!url) return;
  const btn = q('sl-url-btn');
  if (btn) btn.classList.add('busy');
  prepareInstallTarget('url');
  startJob('/api/apps/install/url', { url, sha256: q('sl-sha').value.trim() })
    .finally(() => { if (btn) btn.classList.remove('busy'); });
}

async function startJob(path, body) {
  if (!installIdle() || uploading) return;
  q('catalog-msg').textContent = '';
  installOwn = true;
  try {
    const j = await installPost(path, body);
    installSnap = j.install;
    renderInstall();
    renderCatalog();
    pollInstall();
  } catch (e) {
    installOwn = false;
    installFailed(e.message);
  }
}

function installFailed(text) {
  showErr(text);
  q('catalog-msg').textContent = sentence(text);
}

// The browser sends the file as it is: application/octet-stream is the one
// body type the server accepts for an upload, and XHR reports progress.
function uploadIpk() {
  const f = q('sl-file').files[0];
  if (!f || !installIdle() || uploading) return;
  const btn = q('sl-file-btn');
  if (btn) btn.classList.add('busy');
  prepareInstallTarget('file');
  q('catalog-msg').textContent = '';
  uploading = true;
  renderSideload();
  const fail = text => {
    if (btn) btn.classList.remove('busy');
    uploading = false;
    renderSideload();
    setInstallStatus('');
    installFailed(text);
  };
  const xhr = new XMLHttpRequest();
  xhr.open('POST', api('/api/apps/install/upload'));
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = ev => {
    if (!ev.lengthComputable) return;
    uploadStatus(ev.loaded, ev.total);
  };
  xhr.onerror = () => fail(t('apps.install.uploadFailed', 'The upload did not finish'));
  xhr.onload = () => {
    if (btn) btn.classList.remove('busy');
    let j = {};
    try { j = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status !== 200 || !j.ok) return fail(j.error || t('apps.install.failed', 'The install could not be started'));
    uploading = false;
    installOwn = true;
    installSnap = j.install;
    q('sl-file').value = '';
    renderInstall();
    renderCatalog();
    pollInstall();
  };
  uploadStatus(0, f.size);
  xhr.send(f);
}

function uploadStatus(done, total) {
  setInstallBytes('uploading', t('apps.install.uploading', 'Uploading… {done} of {total}', { done: fmtMb(done), total: fmtMb(total) }), done, total);
}

async function confirmInstall() {
  const s = installSnap;
  if (!s || s.state !== 'awaiting-confirm') return;
  const pv = s.preview;
  if (pv.storeInstalled && !q('inst-replace').checked) {
    showErr(t('apps.install.store.needTick', 'Tick the box to replace the store version.'));
    return;
  }
  const elevate = q('inst-root').checked;
  // A package from a URL, a file or an added catalog has not been vetted by the
  // Homebrew Channel, so root for its services is confirmed a second time,
  // naming each one.
  if (elevate && !pv.vetted &&
      !confirm(t('apps.install.root.confirm', 'Run these services as root?\n\n{list}\n\nRoot gives a service full control of the TV. Only continue if the package comes from someone trusted.', { list: (pv.services || []).join('\n') }))) return;
  q('inst-confirm').disabled = true;
  q('inst-cancel').disabled = true;
  if (q('install-modal')) q('install-modal').hidden = true;
  try {
    const j = await installPost('/api/apps/install/confirm', {
      jobId: s.jobId, elevate, replaceStore: q('inst-replace').checked,
      // The server asks for the services shown in the preview before it gives
      // root to a package the Homebrew Channel has not vetted.
      confirmRoot: elevate && !pv.vetted ? (pv.services || []) : undefined
    });
    installSnap = j.install;
    renderInstall();
    renderCatalog();
    pollInstall();
  } catch (e) {
    showErr(e.message);
    pollInstall();
  }
}

async function cancelInstall() {
  const s = installSnap;
  if (!s) return;
  try {
    await installPost('/api/apps/install/cancel', { jobId: s.jobId });
    installOwn = false;
  } catch (e) { showErr(e.message); }
  installSnap = null;
  if (q('install-modal')) q('install-modal').hidden = true;
  q('install-panel').hidden = true;
  setInstallStatus('');
  renderCatalog();
  pollInstall();
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = q('install-modal');
    if (modal && !modal.hidden) cancelInstall();
  }
});

// ---- apps from a restored backup ----
/* The apps a restore found missing here and the catalog has. Each is
   installed as one picked from the catalog: its preview stops for a choice
   such as root, and otherwise goes straight on. */
let restoredApps = [];
let restoringApps = false;

function renderRestoredApps() {
  const box = q('restore-apps');
  box.hidden = !restoredApps.length;
  if (!restoredApps.length) return;
  q('restore-apps-text').textContent = t('apps.restore.text', 'From a restored backup, not installed here: {names}.', { names: restoredApps.map(a => a.title).join(', ') });
  q('restore-apps-install').disabled = restoringApps;
  q('restore-apps-dismiss').disabled = restoringApps;
}

async function loadRestoredApps() {
  try {
    const r = await fetch(api('/api/backup/apps'), { cache: 'no-store' });
    const d = await r.json();
    restoredApps = (d.ok && d.apps) || [];
  } catch (e) {
    restoredApps = [];
  }
  renderRestoredApps();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Until the install that was started has finished, one way or another.
async function installSettled() {
  await sleep(1500);
  while (!installIdle() || installOwn) await sleep(1000);
}

async function installRestoredApps() {
  if (restoringApps || !installIdle()) return;
  restoringApps = true;
  renderRestoredApps();
  try {
    for (const a of restoredApps.slice()) {
      startInstall(a.id);
      await installSettled();
    }
  } finally {
    restoringApps = false;
    await loadRestoredApps();
  }
}

async function dismissRestoredApps() {
  try {
    await fetch(api('/api/backup/apps/clear'), { method: 'POST' });
  } catch (e) {}
  restoredApps = [];
  renderRestoredApps();
}
