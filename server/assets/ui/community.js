// Community catalog UI for the Screensaver and Home tabs (lib/catalog.js).

const commState = {
  screensaver: { loaded: false, busy: false, data: null },
  launcher: { loaded: false, busy: false, data: null },
  nosignal: { loaded: false, busy: false, data: null }
};

function commIds(kind) {
  if (kind === 'screensaver') {
    return { disc: 'disc-ss-community', summary: 'ss-community-summary', list: 'ss-community-list',
      note: 'ss-community-note', url: 'ss-community-url', btn: 'ss-community-url-btn',
      off: 'ss-community-url-off', refresh: 'ss-community-refresh' };
  }
  if (kind === 'nosignal') {
    return { disc: 'disc-ns-community', summary: 'ns-community-summary', list: 'ns-community-list',
      note: 'ns-community-note', url: 'ns-community-url', btn: 'ns-community-url-btn',
      off: 'ns-community-url-off', refresh: 'ns-community-refresh' };
  }
  return { disc: 'disc-home-community', summary: 'home-community-summary', list: 'home-community-list',
    note: 'home-community-note', url: 'home-community-url', btn: 'home-community-url-btn',
    off: 'home-community-url-off', refresh: 'home-community-refresh' };
}

function commOnToggle(kind) {
  const d = q(commIds(kind).disc);
  if (d && d.open && !commState[kind].loaded) loadCommunity(kind, false);
}

async function loadCommunity(kind, refresh) {
  const st = commState[kind];
  const ids = commIds(kind);
  if (!st || !q(ids.list)) return;
  const note = q(ids.note);
  if (refresh && note) note.textContent = t('community.refreshing', 'Refreshing catalog…');
  try {
    const url = api('/api/community?kind=' + encodeURIComponent(kind) + (refresh ? '&refresh=1' : ''));
    const r = await fetch(url, { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || t('community.loadFailed', 'Could not load the community catalog.'));
    st.loaded = true;
    st.data = d;
    if (note) note.textContent = d.error ? d.error : '';
    renderCommunity(kind);
  } catch (e) {
    if (note) note.textContent = e.message;
  }
}

function renderCommunity(kind) {
  const st = commState[kind];
  const ids = commIds(kind);
  const box = q(ids.list);
  const d = st && st.data;
  if (!box || !d) return;

  const items = Array.isArray(d.items) ? d.items : [];
  const installedCount = items.filter(x => x.installed).length;
  const updateCount = items.filter(x => x.updateAvailable && !x.revoked).length;
  const sum = q(ids.summary);
  if (sum) {
    sum.textContent = items.length
      ? (installedCount
        ? (updateCount
          ? t('community.summaryUpdates', '{total} available · {installed} installed · {updates} to update', { total: items.length, installed: installedCount, updates: updateCount })
          : t('community.summaryInstalled', '{total} available · {installed} installed', { total: items.length, installed: installedCount }))
        : t('community.summaryCount', '{total} available', { total: items.length }))
      : '';
  }

  const locked = !d.writable || st.busy;
  const urlOff = q(ids.off);
  const urlBtn = q(ids.btn);
  const urlIn = q(ids.url);
  const refBtn = q(ids.refresh);
  if (refBtn) refBtn.disabled = !!st.busy;
  if (urlOff) urlOff.hidden = !!d.urlInstallAllowed || !d.writable;
  if (urlBtn) urlBtn.disabled = locked || !d.urlInstallAllowed;
  if (urlIn) urlIn.disabled = locked || !d.urlInstallAllowed;

  if (!items.length) {
    box.innerHTML = `<div class="sub">${esc(t('community.empty', 'No community items are available right now.'))}</div>`;
    return;
  }

  box.innerHTML = items.map(item => {
    const meta = [];
    if (item.author) meta.push(t('ss.by', 'by {author}', { author: item.author }));
    if (item.installed && item.installedVersion) meta.push('v' + item.installedVersion);
    else if (item.version) meta.push('v' + item.version);
    if (item.license) meta.push(item.license);

    const preview = item.previewUrl
      ? `<img class="comm-preview" src="${esc(item.previewUrl)}" alt="" loading="lazy" onerror="this.remove()">`
      : '';
    const srcLink = item.sourceUrl
      ? `<a class="comm-src" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener">${esc(t('community.source', 'Source'))}</a>`
      : '';
    const statusTag = item.active
      ? `<span class="ss-tag">${esc(t('ss.inUse', 'In use'))}</span>`
      : item.installed
        ? `<span class="ss-tag">${esc(t('community.installed', 'Installed'))}</span>`
        : '';

    const actions = [];
    if (item.revoked) {
      if (item.installed) {
        actions.push(`<button type="button" class="pill bad" ${locked ? 'disabled' : ''} onclick="communityRemove('${esc(kind)}','${esc(item.id)}')">${esc(t('home.launcher.remove', 'Remove'))}</button>`);
      }
    } else if (!item.installed) {
      const lbl = item.size ? t('community.installSize', 'Install ({size})', { size: fmtSize(item.size) }) : t('community.install', 'Install');
      actions.push(`<button type="button" class="pill idle" ${locked ? 'disabled' : ''} onclick="communityInstall('${esc(kind)}','${esc(item.id)}')">${esc(lbl)}</button>`);
    } else {
      if (item.updateAvailable) {
        actions.push(`<button type="button" class="pill good" ${locked ? 'disabled' : ''} onclick="communityInstall('${esc(kind)}','${esc(item.id)}')">${esc(t('community.updateTo', 'Update to v{version}', { version: item.version }))}</button>`);
      }
      if (kind === 'launcher' && !item.active) {
        actions.push(`<button type="button" class="pill idle" ${locked ? 'disabled' : ''} onclick="homeLauncherUse('${esc(item.localId)}')">${esc(t('community.use', 'Use'))}</button>`);
      } else if (kind === 'nosignal' && !item.active) {
        actions.push(`<button type="button" class="pill idle" ${locked ? 'disabled' : ''} onclick="setNoSignal('${esc(item.localId)}')">${esc(t('community.use', 'Use'))}</button>`);
      }
      actions.push(`<button type="button" class="pill idle" ${locked ? 'disabled' : ''} onclick="communityRemove('${esc(kind)}','${esc(item.id)}')">${esc(t('home.launcher.remove', 'Remove'))}</button>`);
    }

    const revNote = item.revoked
      ? `<div class="pv-note warn">${esc(item.revokedReason || t('community.revokedDefault', 'Removed from the catalog for safety reasons. Uninstall it now.'))}</div>`
      : '';

    return `<div class="comm-card${item.installed ? ' installed' : ''}${item.revoked ? ' revoked' : ''}">
      ${preview}
      <div class="comm-body">
        <div class="comm-head">
          <div class="comm-title">${esc(item.title)}</div>
          ${statusTag}
        </div>
        ${item.description ? `<div class="comm-desc">${esc(item.description)}</div>` : ''}
        ${revNote}
        <div class="comm-meta">${esc(meta.join(' · '))}${meta.length && srcLink ? ' · ' : ''}${srcLink}</div>
        <div class="comm-actions">${actions.join('')}</div>
      </div>
    </div>`;
  }).join('');
}

async function communityRefreshTab(kind) {
  if (kind === 'screensaver') await loadScreensavers();
  else if (kind === 'nosignal') await loadInputs();
  else await loadHome();
}

async function communityInstall(kind, id) {
  const st = commState[kind];
  const ids = commIds(kind);
  const note = q(ids.note);
  if (!st || st.busy) return;
  st.busy = true;
  if (note) note.textContent = t('community.installing', 'Installing…');
  renderCommunity(kind);
  try {
    const r = await fetch(api('/api/community/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id })
    });
    const d = await r.json();
    if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || t('community.installFailed', 'Installation failed.'));
    if (note) note.textContent = '';
    await communityRefreshTab(kind);
    await loadCommunity(kind, false);
  } catch (e) {
    if (note) note.textContent = e.message;
  } finally {
    st.busy = false;
    renderCommunity(kind);
  }
}

async function communityInstallUrl(kind) {
  const st = commState[kind];
  const ids = commIds(kind);
  const input = q(ids.url);
  const note = q(ids.note);
  const url = input ? input.value.trim() : '';
  if (!url || !st || st.busy) return;
  st.busy = true;
  if (note) note.textContent = t('community.installing', 'Installing…');
  renderCommunity(kind);
  try {
    const r = await fetch(api('/api/community/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, url })
    });
    const d = await r.json();
    if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || t('community.installFailed', 'Installation failed.'));
    if (input) input.value = '';
    if (note) note.textContent = '';
    await communityRefreshTab(kind);
    await loadCommunity(kind, false);
  } catch (e) {
    if (note) note.textContent = e.message;
  } finally {
    st.busy = false;
    renderCommunity(kind);
  }
}

async function communityRemove(kind, id) {
  const st = commState[kind];
  const ids = commIds(kind);
  const note = q(ids.note);
  if (!st || st.busy) return;
  st.busy = true;
  if (note) note.textContent = '';
  renderCommunity(kind);
  try {
    const r = await fetch(api('/api/community/remove'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id })
    });
    const d = await r.json();
    if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || t('community.removeFailed', 'Could not remove item.'));
    await communityRefreshTab(kind);
    await loadCommunity(kind, false);
  } catch (e) {
    if (note) note.textContent = e.message;
  } finally {
    st.busy = false;
    renderCommunity(kind);
  }
}
