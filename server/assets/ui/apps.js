// The Apps tab: installed apps, tiles, background services and saved web pages.

let appsData = null;
/*
 * Tiles with a hide or unhide on its way, by id: true to hide. Kept across
 * redraws, and the list is read from the server again only once none are left,
 * so a quick run of clicks never shows a count part of the way through.
 */
const tilePending = {};
let appsLoading = false;

async function loadApps() {
  if (appsLoading) return;
  appsLoading = true;
  try {
    const r = await fetch(api('/api/apps'), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d && d.ok) {
      appsData = d;
      renderAppsPanel();
    }
  } catch (e) {
    console.error('loadApps failed:', e);
  } finally {
    appsLoading = false;
  }
}

// The address without its scheme, as a reminder of which page a tile opens.
function pageHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return url || ''; }
}

function renderSavedPages(d) {
  const pages = d.savedPages || [];
  q('apps-pages-summary').textContent = !pages.length ? t('apps.pages.none', 'None yet')
    : pages.length === 1 ? t('apps.pages.one', '1 page') : t('apps.pages.count', '{n} pages', { n: pages.length });
  q('page-add').hidden = !d.writable;
  q('apps-pages-list').innerHTML = pages.map(p => {
    const id = esc(p.launchPointId);
    const where = pageHost(p.address);
    return `<div class="prot-row" id="page-${id}">
      <div class="prot-main">
        <div class="prot-title">${esc(p.title)}</div>
        <div class="prot-desc">${esc(where || t('apps.pages.saved', 'Saved page'))}${p.renamed ? ' &middot; ' + esc(t('apps.pages.renamed', 'renamed')) : ''}</div>
      </div>
      <div class="prot-status page-acts">
        <button type="button" class="pill idle" onclick="editPage('${id}')" ${d.writable ? '' : 'disabled'}>${esc(t('apps.pages.edit', 'Edit'))}</button>
        <button type="button" class="pill bad" onclick="removePage('${id}')" ${d.writable ? '' : 'disabled'}>${esc(t('apps.pages.remove', 'Remove'))}</button>
      </div>
    </div>`;
  }).join('');
}

function editPage(lpId) {
  const p = ((appsData && appsData.savedPages) || []).find(x => x.launchPointId === lpId);
  const row = q('page-' + lpId);
  if (!p || !row) return;
  const id = esc(lpId);
  const cancel = `onkeydown="if(event.key==='Escape')renderSavedPages(appsData)"`;
  row.innerHTML = `<div class="prot-main">
      <form class="toast-form page-edit" onsubmit="event.preventDefault();savePage('${id}')">
        <input type="text" id="page-url-${id}" maxlength="2048" autocomplete="off" spellcheck="false"
          placeholder="${esc(t('apps.pages.url', 'Web address'))}" value="${esc(p.address)}" aria-label="${esc(t('apps.pages.url', 'Web address'))}" ${cancel}>
        <input type="text" id="page-name-${id}" maxlength="60" autocomplete="off" spellcheck="false"
          placeholder="${esc(p.renamed ? t('apps.pages.resetName', 'Empty puts back its own title') : t('apps.pages.name', 'Name'))}" value="${esc(p.title)}"
          aria-label="${esc(t('apps.pages.name', 'Name'))}" ${cancel}>
        <button type="submit">${esc(t('apps.pages.save', 'Save'))}</button>
        <button type="button" onclick="renderSavedPages(appsData)">${esc(t('common.cancel', 'Cancel'))}</button>
      </form>
      <div class="sub page-add-msg" id="page-msg-${id}" role="alert"></div>
    </div>`;
  const inp = q('page-name-' + lpId);
  inp.focus();
  inp.select();
}

async function addPage() {
  const url = q('page-add-url'), name = q('page-add-name'), btn = q('page-add-btn'), msg = q('page-add-msg');
  msg.textContent = '';
  if (!url.value.trim()) return url.focus();
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const r = await fetch(api('/api/apps/add-page'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: url.value, title: name.value })
    });
    const j = await r.json().catch(() => ({}));
    // Beside the field it is about, and in a sentence's case: the server's
    // messages are written to follow "Could not add it:" elsewhere.
    if (!r.ok || !j.ok) {
      const e = j.error || t('apps.pages.addFailed', 'Could not add it');
      msg.textContent = e.charAt(0).toUpperCase() + e.slice(1) + '.';
      url.focus();
    } else { url.value = ''; name.value = ''; }
  } catch (e) { msg.textContent = e.message; }
  finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
  loadApps();
}

async function removePage(lpId) {
  const p = ((appsData && appsData.savedPages) || []).find(x => x.launchPointId === lpId);
  if (!p || !confirm(t('apps.pages.remove.confirm', 'Remove "{name}" from the home screen?', { name: p.title }))) return;
  try {
    const r = await fetch(api('/api/apps/remove-page'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchPointId: lpId })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) showErr(j.error || t('apps.pages.removeFailed', 'Could not remove it'));
  } catch (e) { showErr(e.message); }
  loadApps();
}

async function savePage(lpId) {
  const name = q('page-name-' + lpId), url = q('page-url-' + lpId), msg = q('page-msg-' + lpId);
  if (!name || !url) return;
  msg.textContent = '';
  try {
    const r = await fetch(api('/api/apps/edit-page'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchPointId: lpId, title: name.value, address: url.value })
    });
    const j = await r.json().catch(() => ({}));
    // A refused edit stays open with the reason, so nothing typed is lost.
    if (!r.ok || !j.ok) {
      const e = j.error || t('apps.pages.saveFailed', 'Could not save it');
      msg.textContent = e.charAt(0).toUpperCase() + e.slice(1) + '.';
      return;
    }
  } catch (e) { msg.textContent = e.message; return; }
  loadApps();
}

/* Not renderApps: that one draws the launcher grid in the control tab, and a
   second declaration of the same name in this scope silently replaces it. */
function renderAppsPanel() {
  if (!appsData) return;
  const d = appsData;

  // Render Installed Apps
  const instList = q('apps-installed-list');
  const instSummary = q('apps-installed-summary');
  const installed = d.installed || [];

  const appCount = n => n === 1 ? t('apps.count.one', '1 app') : t('apps.count', '{n} apps', { n });
  if (instSummary) instSummary.textContent = appCount(installed.length);

  if (instList) {
    if (installed.length === 0) {
      instList.innerHTML = `<div class="sub" style="padding:16px 0">${esc(t('apps.installed.none', 'No removable apps found on the TV.'))}</div>`;
    } else {
      instList.innerHTML = installed.map(app => {
        const title = esc(app.title || app.id);
        const id = esc(app.id);
        const iconUrl = api('/api/apps/icon?id=' + encodeURIComponent(app.id));
        const meta = [app.version ? 'v' + app.version : '', app.vendor || ''].filter(Boolean).join(' · ');
        const sizeBadge = (app.size && typeof fmtSize === 'function') ? fmtSize(app.size) : '';
        return `<div class="prot-row">
          <img src="${iconUrl}" width="38" height="38" style="border-radius:8px;object-fit:contain;background:var(--w06);flex-shrink:0" onerror="this.style.display='none'">
          <div class="prot-main">
            <div class="prot-title">${title}</div>
            <div class="prot-desc">${esc(meta || t('apps.installed.app', 'Installed app'))}</div>
            ${rowErrorNote(app.id)}
          </div>
          <div class="prot-status">
            ${sizeBadge ? `<span class="app-badge" title="${esc(t('apps.installed.storageTooltip', 'Storage footprint'))}">${esc(sizeBadge)}</span>` : ''}
            <button type="button" class="pill good" onclick="sendCommand('launchApp','${jsq(app.id)}')" ${!d.writable || uninstalling[app.id] ? 'disabled' : ''}>${esc(t('apps.launch.button', 'Launch'))}</button>
            <button type="button" class="pill ${uninstalling[app.id] ? 'busy' : 'bad'}" onclick="confirmUninstall('${jsq(app.id)}', '${jsq(app.title || app.id)}')" ${!d.writable || uninstalling[app.id] ? 'disabled' : ''}>${esc(uninstalling[app.id] ? t('apps.uninstall.working', 'Uninstalling\u2026') : t('apps.uninstall.button', 'Uninstall'))}</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  renderSavedPages(d);

  renderPreload(d);
  renderQuickAccess(d);
  renderRemoteKeys(d);

  // Render Background Services
  const svcsList = q('apps-services-list');
  const svcsDisc = q('disc-system-services');
  const svcsSummary = q('apps-services-summary');
  const svcs = d.services || [];

  if (svcsDisc) {
    if (!svcs.length) {
      svcsDisc.hidden = true;
    } else {
      svcsDisc.hidden = false;
      const numDisabled = svcs.filter(s => s.disabled).length;
      if (svcsSummary) {
        svcsSummary.textContent = numDisabled > 0
          ? t('apps.services.disabledOf', '{disabled} disabled of {n}', { disabled: numDisabled, n: svcs.length })
          : svcs.length === 1 ? t('apps.services.one', '1 service') : t('apps.services.count', '{n} services', { n: svcs.length });
      }
      if (svcsList) {
        svcsList.innerHTML = svcs.map(svc => {
          const id = esc(svc.id);
          const title = esc(svc.title);
          const badge = esc(svc.badge || '');
          const desc = esc(svc.desc || '');
          const unit = esc(svc.unit || '');
          const isDisabled = !!svc.disabled;
          const stillRunning = isDisabled && svc.running;
          return `<div class="prot-row">
            <div class="prot-main">
              <div class="prot-title">${title} <span class="prot-sub">&middot; ${unit}</span></div>
              <div class="prot-desc">${desc}</div>
            </div>
            <div class="prot-status">
              ${badge ? `<span class="app-badge">${badge}</span>` : ''}
              ${renderToggle({
                id: 'btn-svc-' + id,
                cls: isDisabled ? 'warn' : 'good',
                label: stillRunning ? t('apps.service.stillRunning', 'Disabled, still running') : isDisabled ? t('apps.service.disabled', 'Disabled') : t('apps.service.active', 'Active'),
                disabled: !d.writable,
                onclick: "toggleService('" + id + "', " + (!isDisabled) + ")",
                attrs: stillRunning ? `title="${esc(t('apps.service.restarted', 'Switched off, but something on the TV has started it again.'))}"` : ''
              })}
            </div>
          </div>`;
        }).join('');
      }
    }
  }
}

// The remote's Quick Access keys: holding 1 to 9 opens what is set here.
// Quick Access (lib/quickaccess.js): a tile per number key, laid out as the
// remote's number pad, each showing what holding it opens. Choosing a tile
// opens a picker under its row, as Remote keys does.
let qaData = null;      // the last quickAccess answer, for the picker
let qaOpen = null;      // the key whose picker is open
let qaCols = 0;
let qaWritable = false;

function renderQuickAccess(d) {
  const disc = q('disc-quickaccess');
  const list = q('apps-qa-list');
  const qa = d.quickAccess;
  if (!disc) return;
  disc.hidden = !qa;
  if (!qa) return;
  const set = qa.keys.filter(k => k.id).length;
  if (q('apps-qa-summary')) q('apps-qa-summary').textContent = t('apps.quickAccess.count', '{n} of 9 set', { n: set });
  qaData = qa;
  qaWritable = !!d.writable;
  // Left alone while a choice is being made in it.
  if (!list || (qaOpen && list.contains(document.activeElement))) return;
  list.innerHTML = `<div class="rk-grid qa-grid">${qa.keys.map(k => {
    const does = k.id
      ? `${rkIcon(k.id)}<span translate="no">${esc(k.title)}</span>`
      : `<span class="rk-lg">${esc(t('apps.quickAccess.none', 'Nothing set'))}</span>`;
    const note = !k.installed && k.id ? `<span class="qa-note" translate="no">${esc(k.id)}</span>`
      : k.lgDefault ? `<span class="qa-note">${esc(t('apps.quickAccess.lgDefault', 'Set by LG'))}</span>` : '';
    return `<button type="button" class="rk-key qa-key-tile${k.id ? ' rk-changed' : ''}" data-key="${k.key}"
        aria-expanded="false" aria-label="${esc(t('apps.quickAccess.keyLabel', 'Key {key}', { key: k.key }) + ': ' + (k.id ? k.title : t('apps.quickAccess.none', 'Nothing set')))}"
        ${qaWritable ? '' : 'disabled'} onclick="toggleQuickAccessKey(this)">
      <span class="qa-num">${k.key}</span>
      <span class="rk-does">${does}</span>
      ${note}
    </button>`;
  }).join('')}</div>`;
  if (qaOpen) {
    const tile = list.querySelector(`.qa-key-tile[data-key="${qaOpen}"]`);
    qaOpen = null;
    if (tile) toggleQuickAccessKey(tile);
  }
}

// The picker goes in after the last tile of the chosen one's row, as for
// Remote keys, with None, the inputs and the apps.
function toggleQuickAccessKey(tile) {
  const was = qaOpen;
  closeQuickAccessPicker();
  if (!qaData || String(was) === tile.dataset.key) return;
  const k = qaData.keys.find(x => String(x.key) === tile.dataset.key);
  if (!k) return;
  qaOpen = k.key;
  tile.classList.add('rk-open');
  tile.setAttribute('aria-expanded', 'true');
  const grid = tile.parentElement;
  const tiles = Array.from(grid.children).filter(el => el.classList.contains('qa-key-tile'));
  const cols = rkColumns(grid);
  qaCols = cols;
  const i = tiles.indexOf(tile);
  const after = tiles[Math.min(tiles.length - 1, (Math.floor(i / cols) + 1) * cols - 1)];
  const opt = (value, html) => `<button type="button" class="rk-opt${value === (k.id || '') ? ' on' : ''}"
      data-value="${esc(value)}" aria-pressed="${value === (k.id || '')}" onclick="chooseQuickAccessKey(this)">${html}</button>`;
  const inputs = qaData.choices.filter(c => c.kind === 'input');
  const apps = qaData.choices.filter(c => c.kind === 'app');
  // A key set to something not offered here (a channel, a hidden LG app) still shows it.
  const gone = k.id && !qaData.choices.some(c => c.id === k.id) ? opt(k.id, `<span translate="no">${esc(k.title)}</span>`) : '';
  const label = t('apps.quickAccess.keyLabel', 'Key {key}', { key: k.key });
  const pick = document.createElement('div');
  pick.className = 'rk-pick';
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', label);
  pick.innerHTML = `<div class="rk-pick-head"><span>${esc(label)}</span>
      <button type="button" class="rk-close" onclick="closeQuickAccessPicker(true)">${esc(t('apps.remoteKeys.close', 'Close'))}</button></div>
    <div class="rk-opts">${opt('', esc(t('apps.quickAccess.reset', 'None')))}${gone}</div>
    ${inputs.length ? `<div class="rk-sub">${esc(t('apps.quickAccess.inputs', 'Inputs'))}</div>
    <div class="rk-opts">${inputs.map(c => opt(c.id, `<span translate="no">${esc(c.title)}</span>`)).join('')}</div>` : ''}
    ${apps.length ? `<div class="rk-sub">${esc(t('apps.quickAccess.apps', 'Apps'))}</div>
    <div class="rk-opts">${apps.map(c => opt(c.id, `${rkIcon(c.id)}<span translate="no">${esc(c.title)}</span>`)).join('')}</div>` : ''}`;
  after.after(pick);
  rkAimArrow(tile, pick);
  const on = pick.querySelector('.rk-opt.on') || pick.querySelector('.rk-opt');
  if (on) on.focus({ preventScroll: true });
}

function closeQuickAccessPicker(refocus) {
  const list = q('apps-qa-list');
  const pick = list && list.querySelector('.rk-pick');
  if (pick) pick.remove();
  const tile = list && qaOpen ? list.querySelector(`.qa-key-tile[data-key="${qaOpen}"]`) : null;
  if (tile) {
    tile.classList.remove('rk-open');
    tile.setAttribute('aria-expanded', 'false');
    if (refocus) tile.focus();
  }
  qaOpen = null;
}

async function chooseQuickAccessKey(btn) {
  const key = qaOpen;
  if (!key) return;
  document.querySelectorAll('#apps-qa-list .rk-pick .rk-opt').forEach(b => { b.disabled = true; });
  btn.classList.add('busy');
  let error = null;
  try {
    const res = await fetch(api('/api/quickaccess'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: Number(key), id: btn.dataset.value })
    });
    const r = await res.json();
    if (!r || !r.ok) error = (r && r.error) || t('common.unknownError', 'unknown error');
  } catch (e) {
    error = e.message;
  }
  closeQuickAccessPicker(true);
  if (error) alert(t('apps.quickAccess.failed', 'Could not change it: {error}', { error }));
  await loadApps();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && qaOpen) closeQuickAccessPicker(true);
});
// As for Remote keys: the picker moves only when the columns change.
window.addEventListener('resize', () => {
  if (!qaOpen) return;
  const list = q('apps-qa-list');
  const tile = list && list.querySelector(`.qa-key-tile[data-key="${qaOpen}"]`);
  const pick = list && list.querySelector('.rk-pick');
  if (!tile || !pick) return;
  if (rkColumns(tile.parentElement) === qaCols) return rkAimArrow(tile, pick);
  const key = qaOpen;
  closeQuickAccessPicker(false);
  toggleQuickAccessKey(list.querySelector(`.qa-key-tile[data-key="${key}"]`));
});

// What the remote's keys do (lib/remotekeys.js): a tile per key, grouped as
// the remote groups them, each showing what it does now. Choosing a tile opens
// a picker under its row with As LG has it, Nothing, the media controls, the
// inputs and the apps.
const RK_GROUPS = [
  { id: 'streaming', title: () => t('apps.remoteKeys.streaming', 'Streaming buttons'),
    keys: ['netflix', 'amazon', 'disneyplus', 'rakutentv', 'lgchannels', 'hulu', 'iplayer', 'freeviewplay', 'slingtv'] },
  { id: 'assistant', title: () => t('apps.remoteKeys.assistant', 'Voice assistant buttons'), keys: ['voice', 'alexa', 'googleassistant'] },
  { id: 'colour', title: () => t('apps.remoteKeys.colour', 'Color keys'), keys: ['red', 'green', 'yellow', 'blue'] },
  // Anything else, including keys a later server offers.
  { id: 'other', title: () => t('apps.remoteKeys.other', 'Other keys'), keys: null }
];
// The colour keys' own colours, the one place colour is the key's name.
const RK_COLOURS = { red: 'var(--red)', green: 'var(--green)', yellow: '#f2c230', blue: 'var(--blue)' };
// The volume controls' own glyphs; the rest share the play/pause one.
const RK_MEDIA_GLYPHS = { 'media:volumeUp': '🔊', 'media:volumeDown': '🔉', 'media:mute': '🔇' };
let rkData = null;     // the last remoteKeys answer, for the picker
let rkOpen = null;     // the key whose picker is open
let rkCols = 0;        // the columns its grid had when it opened
let rkWritable = false;
let rkMoreOpen = false;  // the other countries' keys, folded until opened

function rkIcon(id) {
  return `<img class="rk-ico" src="${esc(api('/api/apps/icon?id=' + encodeURIComponent(id)))}" alt="" onerror="this.style.visibility='hidden'">`;
}

// What a key does, as its tile shows it.
function rkDoes(k, kindOf) {
  if (k.action === 'lg') return `<span class="rk-lg">${esc(t('apps.remoteKeys.lg', 'As LG has it'))}</span>`;
  if (k.action === 'nothing') return `<span class="rk-none" aria-hidden="true">⦸</span>${esc(t('apps.remoteKeys.doesNothing', 'Does nothing'))}`;
  if (kindOf(k.id) === 'switcher') return `<span class="rk-none" aria-hidden="true">⇄</span>${esc(t('apps.remoteKeys.inputSwitcher', 'Input switcher'))}`;
  if (kindOf(k.id) === 'action') return `<span class="rk-none" aria-hidden="true">◼</span>${esc(k.opens)}`;
  if (kindOf(k.id) === 'media') return `<span class="rk-none" aria-hidden="true">${RK_MEDIA_GLYPHS[k.id] || '⏯'}</span>${esc(k.opens)}`;
  const icon = kindOf(k.id) === 'app' ? rkIcon(k.id) : '';
  return `${icon}<span translate="no">${esc(k.opens)}</span>`;
}

function renderRemoteKeys(d) {
  const disc = q('disc-remotekeys');
  const list = q('apps-rk-list');
  const rk = d.remoteKeys;
  if (!disc) return;
  disc.hidden = !rk;
  if (!rk) return;
  const changed = rk.keys.filter(k => k.action !== 'lg').length;
  if (q('apps-rk-summary')) {
    q('apps-rk-summary').textContent = changed
      ? t('apps.remoteKeys.count', '{n} changed', { n: changed })
      : t('apps.remoteKeys.asLg', 'As LG has it');
  }
  rkData = rk;
  rkWritable = !!d.writable;
  // Left alone while a choice is being made in it.
  if (!list || (rkOpen && list.contains(document.activeElement))) return;
  const kinds = {};
  rk.choices.forEach(c => { kinds[c.id] = c.kind; });
  const kindOf = id => kinds[id] || 'app';
  const tile = k => {
    const dot = RK_COLOURS[k.key] ? `<i class="rk-dot" style="background:${RK_COLOURS[k.key]}"></i>` : '';
    const label = k.action === 'open' && (kindOf(k.id) === 'media' || kindOf(k.id) === 'action') ? k.opens
      : k.action === 'open' ? t('apps.remoteKeys.opens', 'Opens {app}', { app: k.opens })
      : k.action === 'nothing' ? t('apps.remoteKeys.doesNothing', 'Does nothing') : t('apps.remoteKeys.lg', 'As LG has it');
    return `<button type="button" class="rk-key${k.action !== 'lg' ? ' rk-changed' : ''}" data-key="${esc(k.key)}"
        aria-expanded="false" aria-label="${esc(t('apps.remoteKeys.keyLabel', '{key} key', { key: k.title }) + ': ' + label)}"
        ${rkWritable ? '' : 'disabled'} onclick="toggleRemoteKey(this)">
      <span class="rk-name" translate="no">${dot}${esc(k.title)}</span>
      <span class="rk-does">${rkDoes(k, kindOf)}</span>
    </button>`;
  };
  // A key only another country's remotes have waits at the end, folded away,
  // unless it has been changed.
  const away = rk.keys.filter(k => k.elsewhere && k.action === 'lg');
  const placed = new Set(away.map(k => k.key));
  const groups = RK_GROUPS.map(g => {
    // In the group's own order, as the remote has them.
    const inGroup = g.keys ? g.keys.map(name => rk.keys.find(k => k.key === name)).filter(Boolean) : rk.keys;
    const keys = inGroup.filter(k => !placed.has(k.key));
    keys.forEach(k => placed.add(k.key));
    if (!keys.length) return '';
    return `<div class="rk-grp">${esc(g.title())}</div>
      <div class="rk-grid">${keys.map(tile).join('')}</div>`;
  }).join('');
  const more = away.length ? `<details class="rk-more"${rkMoreOpen ? ' open' : ''} ontoggle="rkMoreOpen = this.open">
      <summary class="rk-grp">${esc(t('apps.remoteKeys.elsewhere', 'Buttons on remotes sold elsewhere ({n})', { n: away.length }))}</summary>
      <div class="rk-grid">${away.map(tile).join('')}</div></details>` : '';
  list.innerHTML = groups + more;
  if (rkOpen) {
    const tile = list.querySelector(`.rk-key[data-key="${CSS.escape(rkOpen)}"]`);
    rkOpen = null;
    if (tile) toggleRemoteKey(tile);
  }
}

// Opens a key's picker as a full row after the tile's own row, so the tiles
// around it keep their places; the arrow points up at the tile.
function toggleRemoteKey(tile) {
  const list = q('apps-rk-list');
  const was = rkOpen;
  closeRemoteKeyPicker();
  if (!rkData || !list || was === tile.dataset.key) return;
  const k = rkData.keys.find(x => x.key === tile.dataset.key);
  if (!k) return;
  rkOpen = k.key;
  tile.classList.add('rk-open');
  tile.setAttribute('aria-expanded', 'true');
  const grid = tile.parentElement;
  const tiles = Array.from(grid.children).filter(el => el.classList.contains('rk-key'));
  const cols = rkColumns(grid);
  rkCols = cols;
  const i = tiles.indexOf(tile);
  const after = tiles[Math.min(tiles.length - 1, (Math.floor(i / cols) + 1) * cols - 1)];
  const cur = k.action === 'open' ? k.id : k.action;
  const opt = (value, html, extra) => `<button type="button" class="rk-opt${value === cur ? ' on' : ''}${extra || ''}"
      data-value="${esc(value)}" aria-pressed="${value === cur}" onclick="chooseRemoteKey(this)">${html}</button>`;
  const media = rkData.choices.filter(c => c.kind === 'media');
  const inputs = rkData.choices.filter(c => c.kind === 'input');
  const apps = rkData.choices.filter(c => c.kind === 'app');
  // LG's input switcher and Screen off, beside As LG has it and Nothing.
  const switchers = rkData.choices.filter(c => c.kind === 'switcher')
    .map(c => opt(c.id, `<span aria-hidden="true">⇄</span> ${esc(t('apps.remoteKeys.inputSwitcher', 'Input switcher'))}`)).join('') +
    rkData.choices.filter(c => c.kind === 'action').map(c => opt(c.id, `<span aria-hidden="true">◼</span> ${esc(c.title)}`)).join('');
  // A key set to something no longer offered (an app since removed) still shows it.
  const gone = k.action === 'open' && !rkData.choices.some(c => c.id === k.id)
    ? opt(k.id, `<span translate="no">${esc(k.opens)}</span>`) : '';
  const pick = document.createElement('div');
  pick.className = 'rk-pick';
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', t('apps.remoteKeys.keyLabel', '{key} key', { key: k.title }));
  pick.innerHTML = `<div class="rk-pick-head"><span translate="no">${esc(t('apps.remoteKeys.keyLabel', '{key} key', { key: k.title }))}</span>
      <button type="button" class="rk-close" onclick="closeRemoteKeyPicker(true)">${esc(t('apps.remoteKeys.close', 'Close'))}</button></div>
    ${k.blocksApp ? `<div class="pv-note">${esc(t('apps.remoteKeys.blocksAlexa', 'Setting this key stops Alexa from opening until it is As LG has it again. Amazon still shows that Alexa is loading for a few seconds.'))}</div>` : ''}
    ${k.replacesVoice ? `<div class="pv-note">${esc(t('apps.remoteKeys.replacesVoice', 'Set to anything else, this button no longer starts voice control. As LG has it brings it back.'))}</div>` : ''}
    ${k.turnsOffVoice ? `<div class="pv-note">${esc(t('apps.remoteKeys.turnsOffVoice', 'Setting this key switches off LG\'s voice assistant, so voice search, the AI assistant and the microphone stop working until it is As LG has it again.'))}</div>` : ''}
    <div class="rk-opts">${opt('lg', esc(t('apps.remoteKeys.lg', 'As LG has it')))}${k.noNothing ? '' : opt('nothing', `<span aria-hidden="true">⦸</span> ${esc(t('apps.remoteKeys.nothing', 'Nothing'))}`)}${switchers}${gone}</div>
    ${media.length ? `<div class="rk-sub">${esc(t('apps.remoteKeys.media', 'Media'))}</div>
    <div class="rk-opts">${media.map(c => opt(c.id, esc(c.title))).join('')}</div>` : ''}
    ${inputs.length ? `<div class="rk-sub">${esc(t('apps.remoteKeys.inputs', 'Inputs'))}</div>
    <div class="rk-opts">${inputs.map(c => opt(c.id, `<span translate="no">${esc(c.title)}</span>`)).join('')}</div>` : ''}
    ${apps.length ? `<div class="rk-sub">${esc(t('apps.remoteKeys.apps', 'Apps'))}</div>
    <div class="rk-opts">${apps.map(c => opt(c.id, `${rkIcon(c.id)}<span translate="no">${esc(c.title)}</span>`)).join('')}</div>` : ''}`;
  after.after(pick);
  rkAimArrow(tile, pick);
  const on = pick.querySelector('.rk-opt.on') || pick.querySelector('.rk-opt');
  if (on) on.focus({ preventScroll: true });
}

function rkColumns(grid) {
  return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
}

// The arrow sits under the middle of the chosen tile.
function rkAimArrow(tile, pick) {
  const g = tile.parentElement.getBoundingClientRect(), r = tile.getBoundingClientRect();
  pick.style.setProperty('--rk-arrow', Math.round(r.left - g.left + r.width / 2) + 'px');
}

function closeRemoteKeyPicker(refocus) {
  const list = q('apps-rk-list');
  const pick = list && list.querySelector('.rk-pick');
  if (pick) pick.remove();
  const tile = list && rkOpen ? list.querySelector(`.rk-key[data-key="${CSS.escape(rkOpen)}"]`) : null;
  if (tile) {
    tile.classList.remove('rk-open');
    tile.setAttribute('aria-expanded', 'false');
    if (refocus) tile.focus();
  }
  rkOpen = null;
}

async function chooseRemoteKey(btn) {
  const key = rkOpen;
  if (!key) return;
  const v = btn.dataset.value;
  const body = v === 'lg' || v === 'nothing' ? { key, action: v } : { key, action: 'open', id: v };
  document.querySelectorAll('#apps-rk-list .rk-pick .rk-opt').forEach(b => { b.disabled = true; });
  btn.classList.add('busy');
  let error = null;
  try {
    const res = await fetch(api('/api/remotekeys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const r = await res.json();
    if (!r || !r.ok) error = (r && r.error) || t('common.unknownError', 'unknown error');
  } catch (e) {
    error = e.message;
  }
  closeRemoteKeyPicker(true);
  if (error) alert(t('apps.remoteKeys.failed', 'Could not change it: {error}', { error }));
  await loadApps();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && rkOpen) closeRemoteKeyPicker(true);
});
// A phone's address bar showing or hiding is a resize too, so the picker stays
// open: it moves only when the columns change, and its arrow follows the tile.
window.addEventListener('resize', () => {
  if (!rkOpen) return;
  const list = q('apps-rk-list');
  const tile = list && list.querySelector(`.rk-key[data-key="${CSS.escape(rkOpen)}"]`);
  const pick = list && list.querySelector('.rk-pick');
  if (!tile || !pick) return;
  if (rkColumns(tile.parentElement) === rkCols) return rkAimArrow(tile, pick);
  const key = rkOpen;
  closeRemoteKeyPicker(false);
  toggleRemoteKey(list.querySelector(`.rk-key[data-key="${CSS.escape(key)}"]`));
});

// System apps hidden from LG's Home screen, and from Glasshouse Home, on the
// Home tab (lgHomeOptions in lib/routes.js).
function renderSystemTiles(d) {
  const appCount = n => n === 1 ? t('apps.count.one', '1 app') : t('apps.count', '{n} apps', { n });
  const tileHidingEnabled = !!d.tileHidingEnabled;
  const tilesDisc = q('disc-system-tiles');
  const tilesList = q('apps-tiles-list');
  const hiddenCount = q('apps-hidden-count');
  const tilesSummary = q('apps-tiles-summary');
  const warningBox = q('tile-hiding-warning');
  const btnOff = q('tile-hiding-off');
  const btnOn = q('tile-hiding-on');
  const tiles = d.systemTiles || [];
  // A tile with a hide or unhide on its way counts as it will be.
  const willHide = tile => tilePending.hasOwnProperty(tile.id) ? tilePending[tile.id] : !!tile.hidden;
  const numHidden = tiles.filter(willHide).length;

  if (tilesDisc) {
    tilesDisc.hidden = d.tileHidingAvailable === false;
  }

  if (btnOff && btnOn) {
    btnOff.classList.toggle('on', !tileHidingEnabled);
    btnOn.classList.toggle('on', tileHidingEnabled);
    btnOff.disabled = !d.writable;
    btnOn.disabled = !d.writable || (!!d.tileHidingHeld && !tileHidingEnabled);
  }
  // Only where the TV has no nudge: there each cold boot restarts sam to hide
  // the tiles again, which is what blanks the screen for a moment.
  if (warningBox) {
    warningBox.hidden = !tileHidingEnabled || !!d.tileHidingHeld || d.tileHidingNudge === true;
  }
  q('tile-hiding-held').hidden = !d.tileHidingHeld;
  q('tile-hiding-overridden').hidden = !d.tileHidingOverridden;

  if (hiddenCount) {
    if (!tileHidingEnabled) {
      hiddenCount.style.display = 'none';
    } else {
      hiddenCount.style.display = '';
      hiddenCount.textContent = numHidden > 0
        ? t('apps.tiles.hiddenOf', '{hidden} hidden of {n} apps', { hidden: numHidden, n: tiles.length })
        : t('apps.tiles.allVisible', 'All {n} apps visible', { n: tiles.length });
    }
  }

  if (tilesSummary) {
    if (!tileHidingEnabled) {
      tilesSummary.textContent = t('common.off', 'Off');
    } else {
      tilesSummary.textContent = numHidden > 0 ? t('apps.tiles.hidden', '{n} hidden', { n: numHidden }) : appCount(tiles.length);
    }
  }

  if (tilesList) {
    if (!tileHidingEnabled) {
      tilesList.innerHTML = `<div class="sub" style="padding:16px 0">${esc(t('apps.tiles.stock', 'All built-in apps are visible (stock behavior). Select On (Custom) above to hide apps from the home launcher.'))}</div>`;
    } else if (tiles.length === 0) {
      tilesList.innerHTML = `<div class="sub" style="padding:16px 0">${esc(t('apps.tiles.none', 'No eligible system apps found.'))}</div>`;
    } else {
      // A tile per app, as Remote keys has: choosing one hides or shows it.
      tilesList.innerHTML = `<div class="rk-grid">${tiles.map(tile => {
        const pending = tilePending.hasOwnProperty(tile.id);
        const isHidden = willHide(tile);
        const state = pending ? (isHidden ? t('apps.tile.hiding', 'Hiding\u2026') : t('apps.tile.restoring', 'Restoring\u2026'))
          : isHidden ? t('apps.tile.hidden', 'Hidden') : t('apps.tile.shown', 'Shown');
        const name = tile.title || tile.id;
        return `<button type="button" class="rk-key sys-tile${isHidden ? ' sys-hidden sys-changed' : ''}" aria-pressed="${isHidden}"
            aria-label="${esc(name + ': ' + state)}" ${!d.writable || pending ? 'disabled' : ''}
            onclick="toggleTileVisibility('${jsq(tile.id)}', ${!isHidden})">
          <span class="rk-does">${rkIcon(tile.id)}<span translate="no">${esc(name)}</span></span>
          <span class="rk-name">${esc(state)}</span>
        </button>`;
      }).join('')}</div>`;
    }
  }
}

// Apps LG keeps loaded in the background (#624).
// Parts of LG's Home screen, and inputs as tiles on it (lib/homescreen.js).
function renderHomeScreen(d) {
  const disc = q('disc-homescreen');
  const hs = d.homeScreen;
  if (!disc) return;
  disc.hidden = !hs;
  if (!hs) return;
  // On webOS 10 the feature is experimental: shown, but off until switched on.
  const exp = hs.experimental;
  const usable = !!d.writable && (!exp || exp.allowed);
  const expBox = q('apps-home-exp');
  if (expBox) {
    expBox.hidden = !exp;
    if (exp) {
      updateToggle('btn-home-allow', {
        cls: exp.allowed ? 'good' : 'idle',
        label: exp.allowed ? t('common.on', 'On') : t('common.off', 'Off'),
        on: exp.allowed,
        disabled: !d.writable
      });
    }
  }
  const hidden = hs.parts.filter(p => !p.shown).length;
  const summary = q('apps-home-summary');
  if (summary) {
    summary.textContent = hidden
      ? t('apps.home.hiddenOf', '{n} of {total} hidden', { n: hidden, total: hs.parts.length })
      : t('apps.home.asLg', 'As LG has it');
  }
  const parts = q('apps-home-parts');
  if (parts) {
    parts.innerHTML = hs.parts.map(p => `<div class="prot-row">
      <div class="prot-main">
        <div class="prot-title">${esc(p.title)}</div>
        <div class="prot-desc">${esc(p.desc)}</div>
      </div>
      <div class="prot-status">
        ${renderToggle({
          id: 'btn-home-' + esc(p.id),
          cls: p.shown ? 'good' : 'idle',
          label: p.shown ? t('apps.home.shown', 'Shown') : t('apps.home.hidden', 'Hidden'),
          disabled: !usable,
          onclick: "setHomePart('" + esc(p.id) + "', " + (!p.shown) + ")"
        })}
      </div>
    </div>`).join('');
  }
  const inputs = q('apps-home-inputs');
  const inputsHead = q('apps-home-inputs-h');
  const showInputs = !!(hs.inputs && hs.inputs.length);
  if (inputsHead) inputsHead.hidden = !showInputs;
  if (inputs) {
    inputs.hidden = !showInputs;
    // A tile per input, as for the system apps: choosing one adds or removes it.
    inputs.innerHTML = showInputs ? `<div class="rk-grid">${hs.inputs.map(i => toggleTile({
      id: 'btn-home-' + i.id,
      appId: 'com.webos.app.' + i.id,
      name: i.title,
      state: i.onHome ? t('apps.home.onHome', 'On Home') : t('apps.home.notOnHome', 'Not on Home'),
      dim: !i.onHome,
      changed: false,
      disabled: !usable,
      onclick: "setHomeInput('" + jsq(i.id) + "', " + (!i.onHome) + ")"
    })).join('')}</div>` : '';
  }
  const restore = q('btn-home-restore');
  if (restore) {
    restore.disabled = !usable;
    restore.textContent = t('apps.home.restore', 'Put back LG’s Home screen');
  }
}

/*
 * A tile that switches one thing on or off: the app's icon and name, and its
 * state beneath, dimmed while off. The state is orange where it is a change
 * from LG's own setting. For the inputs on Home and the apps kept ready, as
 * for the system apps.
 */
function toggleTile(o) {
  return `<button type="button" class="rk-key sys-tile${o.dim ? ' sys-hidden' : ''}${o.changed ? ' sys-changed' : ''}" id="${esc(o.id)}"
      aria-pressed="${!o.dim}" aria-label="${esc(o.name + ': ' + o.state)}" ${o.disabled ? 'disabled' : ''}
      onclick="${o.onclick}">
    <span class="rk-does">${rkIcon(o.appId)}<span translate="no">${esc(o.name)}</span></span>
    ${o.note ? `<span class="qa-note">${esc(o.note)}</span>` : ''}
    <span class="rk-name">${esc(o.state)}</span>
  </button>`;
}

// While a change is on its way: a tile says so in its state line, a plain
// button in its label.
function markBusy(btn) {
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('busy');
  const state = btn.querySelector('.rk-name');
  (state || btn).textContent = t('apps.service.updating', 'Updating\u2026');
}

async function postHomeScreen(btnId, body) {
  const btn = q(btnId);
  markBusy(btn);
  let error = null;
  try {
    const res = await fetch(api('/api/homescreen'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const r = await res.json();
    if (!r || !r.ok) error = (r && r.error) || t('common.unknownError', 'unknown error');
  } catch (e) {
    error = e.message;
  } finally {
    if (btn) btn.classList.remove('busy');
  }
  if (error) alert(t('apps.home.failed', 'Could not change the Home screen: {error}', { error }));
  loadHome();
}

function setHomePart(id, shown) { return postHomeScreen('btn-home-' + id, { part: id, shown }); }
function setHomeInput(id, onHome) { return postHomeScreen('btn-home-' + id, { input: id, onHome }); }
function restoreHome() { return postHomeScreen('btn-home-restore', { restore: true }); }

// The experimental switch, from the Apps tab or Server -> Advanced.
async function toggleHomeLayoutAllowed(btnId) {
  const b = q(btnId);
  const turnOn = !(b && b.dataset.on);
  if (turnOn && !confirm(t('apps.home.exp.confirm', 'Switch on Home screen layout?\n\nOn webOS 10 Glasshouse lays its own Home screen layout over LG\u2019s each time the TV starts, so LG\u2019s can show for a moment first, and it has been tried on only a few TVs. Put back LG\u2019s Home screen, or switching this off, undoes it.'))) return;
  await postHomeScreen(btnId, { allow: turnOn });
  if (typeof loadUpdate === 'function') loadUpdate();
}

function renderPreload(d) {
  const disc = q('disc-preload');
  const list = q('apps-preload-list');
  const summary = q('apps-preload-summary');
  const apps = d.preload || [];
  if (!disc) return;
  disc.hidden = !apps.length;
  if (!apps.length) return;
  const numOff = apps.filter(a => a.off).length;
  if (summary) {
    summary.textContent = numOff
      ? t('apps.preload.offOf', '{off} switched off of {n}', { off: numOff, n: apps.length })
      : apps.length === 1 ? t('apps.preload.one', '1 app') : t('apps.preload.count', '{n} apps', { n: apps.length });
  }
  if (!list) return;
  // A tile per app: choosing one switches it off or keeps it ready. Some of
  // LG's apps have no icon (Yandex Alice on a C2); the space stays, so the
  // names line up.
  list.innerHTML = `<div class="rk-grid">${apps.map(a => toggleTile({
    id: 'btn-preload-' + a.id,
    appId: a.id,
    name: a.title,
    note: [a.memoryMb ? t('apps.preload.size', 'about {mb} MB when loaded', { mb: a.memoryMb }) : '',
      a.loaded ? t('apps.preload.loaded', 'loaded now') : ''].filter(Boolean).join(' · '),
    state: a.off ? t('apps.preload.off', 'Switched off') : t('apps.preload.kept', 'Kept ready'),
    dim: a.off,
    changed: a.off,
    disabled: !d.writable,
    onclick: "togglePreload('" + jsq(a.id) + "', " + (!a.off) + ")"
  })).join('')}</div>`;
}

async function togglePreload(appId, makeOff) {
  const btn = q('btn-preload-' + appId);
  markBusy(btn);
  let error = null;
  try {
    const res = await fetch(api('/api/preload/toggle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: appId, off: makeOff })
    });
    const d = await res.json();
    if (d && d.ok) {
      const item = appsData && (appsData.preload || []).find(a => a.id === appId);
      if (item) item.off = makeOff;
    } else {
      error = (d && d.error) || t('common.unknownError', 'unknown error');
    }
  } catch (e) {
    error = e.message;
  } finally {
    if (btn) btn.classList.remove('busy');
  }
  if (appsData) renderPreload(appsData);
  if (error) alert(t('apps.preload.failed', 'Could not change it: {error}', { error }));
}

async function toggleService(serviceId, makeDisabled) {
  const btn = document.getElementById('btn-svc-' + serviceId);
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = t('apps.service.updating', 'Updating\u2026');
  }
  try {
    const res = await fetch(api('/api/services/toggle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: serviceId, disabled: makeDisabled })
    });
    const d = await res.json();
    if (d && d.ok) {
      if (appsData && appsData.services) {
        const item = appsData.services.find(s => s.id === serviceId);
        if (item) item.disabled = makeDisabled;
        renderAppsPanel();
      }
    } else {
      if (btn) {
        btn.disabled = false;
        btn.textContent = makeDisabled ? t('apps.service.active', 'Active') : t('apps.service.disabled', 'Disabled');
      }
      alert(t('apps.service.failed', 'Could not update service: {error}', { error: (d && d.error) || t('common.unknownError', 'unknown error') }));
    }
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = makeDisabled ? t('apps.service.active', 'Active') : t('apps.service.disabled', 'Disabled');
    }
    alert(t('apps.service.failed', 'Could not update service: {error}', { error: e.message }));
  } finally {
    if (btn) btn.classList.remove('busy');
  }
}

/*
 * From the catalog or the installed list, which can both show the app: both
 * say it is going while it does (about ten seconds with tiles hidden, as the
 * home screen restarts), then the catalog's says so for a moment and the
 * installed list's row goes.
 */
async function confirmUninstall(appId, appTitle) {
  if (!confirm(t('apps.uninstall.confirm', 'Uninstall "{name}" from the TV?\n\nThis will permanently delete the application and its stored data.', { name: appTitle }))) {
    return;
  }
  delete rowError[appId];
  uninstalling[appId] = true;
  renderCatalog();
  renderAppsPanel();
  let error = null;
  try {
    const res = await fetch(api('/api/apps/uninstall'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: appId })
    });
    const d = await res.json();
    if (!d || !d.ok) error = (d && d.error) || t('common.unknownError', 'unknown error');
  } catch (e) {
    error = e.message;
  }
  delete uninstalling[appId];
  if (error) {
    rowError[appId] = { title: t('apps.uninstall.notRemoved', '{name} was not uninstalled.', { name: appTitle }), text: sentence(error) };
    showErr(t('apps.uninstall.failed', 'Could not uninstall {name}: {error}', { name: appTitle, error }));
  } else {
    if (appsData && appsData.installed) appsData.installed = appsData.installed.filter(a => a.id !== appId);
    setCatalogState(appId, null);
    flashRow(appId, t('apps.uninstall.removed', 'Removed'), 'idle flash');
  }
  renderCatalog();
  renderAppsPanel();
  loadApps();
  loadCatalog();
}

async function toggleTileVisibility(appId, makeHidden) {
  if (tilePending.hasOwnProperty(appId)) return;
  tilePending[appId] = makeHidden;
  renderHome();
  const ep = makeHidden ? '/api/apps/hide' : '/api/apps/unhide';
  let error = null;
  try {
    const res = await fetch(api(ep), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: appId })
    });
    const d = await res.json();
    if (!d || !d.ok) error = (d && d.error) || t('common.unknownError', 'unknown error');
  } catch (e) {
    error = e.message;
  }
  delete tilePending[appId];
  const lg = homeStatus && homeStatus.lgHome;
  const tile = !error && lg && (lg.systemTiles || []).find(x => x.id === appId);
  if (tile) tile.hidden = makeHidden;
  if (Object.keys(tilePending).length) renderHome();
  else await loadHome();
  if (error) alert(t('apps.tile.failed', 'Could not update tile: {error}', { error }));
}

async function setTileHiding(enabled) {
  const btnOff = q('tile-hiding-off');
  const btnOn = q('tile-hiding-on');
  const target = enabled ? btnOn : btnOff;
  if (btnOff) btnOff.disabled = true;
  if (btnOn) btnOn.disabled = true;
  if (target) target.classList.add('busy');
  try {
    const res = await fetch(api('/api/apps/tile-hiding'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    });
    const d = await res.json();
    if (d && d.ok) {
      if (homeStatus && homeStatus.lgHome) {
        homeStatus.lgHome.tileHidingEnabled = enabled;
        renderHome();
      }
      await loadHome();
    } else {
      alert(t('apps.tiles.failed', 'Could not update tile hiding: {error}', { error: (d && d.error) || t('common.unknownError', 'unknown error') }));
      renderHome();
    }
  } catch (e) {
    alert(t('apps.tiles.failed', 'Could not update tile hiding: {error}', { error: e.message }));
    renderHome();
  } finally {
    if (target) target.classList.remove('busy');
    if (btnOff) btnOff.disabled = false;
    if (btnOn) btnOn.disabled = false;
  }
}
