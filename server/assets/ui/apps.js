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
  btn.disabled = true;
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
  btn.disabled = false;
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
        return `<div class="prot-row">
          <img src="${iconUrl}" width="38" height="38" style="border-radius:8px;object-fit:contain;background:var(--w06);flex-shrink:0" onerror="this.style.display='none'">
          <div class="prot-main">
            <div class="prot-title">${title} <span class="prot-sub">&middot; ${id}</span></div>
            <div class="prot-desc">${esc(meta || t('apps.installed.app', 'Installed app'))}</div>
            ${rowError[app.id] ? `<div class="prot-desc row-err">${esc(rowError[app.id])}</div>` : ''}
          </div>
          <div class="prot-status">
            <button type="button" class="pill ${uninstalling[app.id] ? 'busy' : 'bad'}" onclick="confirmUninstall('${jsq(app.id)}', '${jsq(app.title || app.id)}')" ${!d.writable || uninstalling[app.id] ? 'disabled' : ''}>${esc(uninstalling[app.id] ? t('apps.uninstall.working', 'Uninstalling\u2026') : t('apps.uninstall.button', 'Uninstall'))}</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  renderSavedPages(d);

  // Render System Tiles
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
  if (warningBox) {
    warningBox.hidden = !tileHidingEnabled || !!d.tileHidingHeld;
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
      tilesList.innerHTML = tiles.map(tile => {
        const title = esc(tile.title || tile.id);
        const id = esc(tile.id);
        const iconUrl = api('/api/apps/icon?id=' + encodeURIComponent(tile.id));
        const pending = tilePending.hasOwnProperty(tile.id);
        const isHidden = willHide(tile);
        return `<div class="prot-row">
          <img src="${iconUrl}" width="38" height="38" style="border-radius:8px;object-fit:contain;background:var(--w06);flex-shrink:0" onerror="this.style.display='none'">
          <div class="prot-main">
            <div class="prot-title">${title} <span class="prot-sub">&middot; ${id}</span></div>
            <div class="prot-desc">${esc(isHidden ? t('apps.tile.hidden.desc', 'Hidden from home launcher ribbon') : t('apps.tile.visible.desc', 'Visible on home launcher ribbon'))}</div>
          </div>
          <div class="prot-status">
            ${renderToggle({
              id: 'btn-tile-' + id,
              cls: isHidden ? 'warn' : 'good',
              label: pending ? (isHidden ? t('apps.tile.hiding', 'Hiding\u2026') : t('apps.tile.restoring', 'Restoring\u2026'))
                : isHidden ? t('apps.tile.hidden', 'Hidden') : t('apps.tile.visible', 'Visible'),
              disabled: !d.writable || pending,
              onclick: "toggleTileVisibility('" + id + "', " + (!isHidden) + ")"
            })}
          </div>
        </div>`;
      }).join('');
    }
  }

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
            <div class="prot-status" style="display:flex;align-items:center;gap:10px">
              ${badge ? `<span class="pv-badge" style="font-size:11px;padding:3px 8px;border-radius:6px;background:var(--w06);color:var(--t2)">${badge}</span>` : ''}
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

async function toggleService(serviceId, makeDisabled) {
  const btn = document.getElementById('btn-svc-' + serviceId);
  if (btn) {
    btn.disabled = true;
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
    rowError[appId] = sentence(error);
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
  renderAppsPanel();
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
  const tile = !error && appsData && (appsData.systemTiles || []).find(x => x.id === appId);
  if (tile) tile.hidden = makeHidden;
  if (Object.keys(tilePending).length) renderAppsPanel();
  else await loadApps();
  if (error) alert(t('apps.tile.failed', 'Could not update tile: {error}', { error }));
}

async function setTileHiding(enabled) {
  const btnOff = q('tile-hiding-off');
  const btnOn = q('tile-hiding-on');
  if (btnOff) btnOff.disabled = true;
  if (btnOn) btnOn.disabled = true;
  try {
    const res = await fetch(api('/api/apps/tile-hiding'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    });
    const d = await res.json();
    if (d && d.ok) {
      if (appsData) {
        appsData.tileHidingEnabled = enabled;
        renderAppsPanel();
      }
      await loadApps();
    } else {
      alert(t('apps.tiles.failed', 'Could not update tile hiding: {error}', { error: (d && d.error) || t('common.unknownError', 'unknown error') }));
      renderAppsPanel();
    }
  } catch (e) {
    alert(t('apps.tiles.failed', 'Could not update tile hiding: {error}', { error: e.message }));
    renderAppsPanel();
  } finally {
    if (btnOff) btnOff.disabled = false;
    if (btnOn) btnOn.disabled = false;
  }
}
