// Home Assistant control bar settings and TV launch on the HA & MQTT tab.

const HA_BAR_MAX = 16;
// What the bar can act on, as lib/habar.js formatTile has it: any other
// entity is a reading on the TV already, so its Control button has nothing
// to switch. test-habar.js checks the two agree.
const HA_BAR_CONTROLLED = ['light', 'switch', 'input_boolean', 'fan', 'climate', 'cover', 'lock', 'scene', 'script', 'button', 'input_button'];
let haBarEntities = [];
let haBarConfigured = false;
let haBarShowHints = true;
let haBarMsgTimer = null;

if (typeof haPickerRegister === 'function') {
  haPickerRegister('ha:bar', {
    listId: 'ha-bar-picker',
    inputId: 'ha-bar-add',
    getUsedIds: () => haBarEntities.map(item => item.id),
    onPick: id => {
      const inp = q('ha-bar-add');
      if (inp) inp.value = id;
      haBarAdd();
    }
  });
}

function haBarFilter() {
  const inp = q('ha-bar-add');
  if (inp) haPickerFilter('ha:bar', inp.value);
}

function haBarTogglePicker() {
  haPickerToggle('ha:bar');
}

function haBarDomainName(id) {
  const dot = String(id || '').indexOf('.');
  const domain = dot > 0 ? id.slice(0, dot) : '';
  if (!domain) return '';
  if (typeof haDomainLabel === 'function') return haDomainLabel(domain);
  return domain;
}

function setHaBarMsg(text, kind) {
  const el = q('ha-bar-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = kind ? 'cfg-msg ' + kind : 'cfg-msg';
  clearTimeout(haBarMsgTimer);
  if (text && kind !== 'bad') {
    haBarMsgTimer = setTimeout(() => { el.textContent = ''; el.className = 'cfg-msg'; }, 4000);
  }
}

function renderHaBar() {
  const sec = q('ha-bar-section');
  if (!sec) return;
  sec.hidden = !haBarConfigured;
  if (!haBarConfigured) return;

  const count = q('ha-bar-count');
  if (count) count.textContent = t('ha.bar.countOf', '{n} of {max}', { n: haBarEntities.length, max: HA_BAR_MAX });
  const full = haBarEntities.length >= HA_BAR_MAX;
  const addInp = q('ha-bar-add');
  const addBtn = q('ha-bar-add-btn');
  const pickBtn = q('ha-bar-pick-btn');
  if (addInp) addInp.disabled = !cfgHaWritable || full;
  if (addBtn) addBtn.disabled = !cfgHaWritable || full;
  if (pickBtn) pickBtn.disabled = !cfgHaWritable || full;

  const actions = q('ha-bar-actions');
  if (actions) actions.hidden = !haBarEntities.length;
  const optsWrap = q('ha-bar-opts-wrap');
  if (optsWrap) optsWrap.hidden = !haBarEntities.length;
  const homeNote = q('ha-bar-home-note');
  if (homeNote) homeNote.hidden = !haBarEntities.length;
  const legend = q('ha-bar-legend');
  if (legend) legend.hidden = !haBarEntities.length;
  const hintsBtn = q('ha-bar-hints-btn');
  if (hintsBtn) {
    updateToggle(hintsBtn, { cls: haBarShowHints ? 'good' : 'idle', label: haBarShowHints ? t('common.on', 'On') : t('common.off', 'Off'), on: haBarShowHints });
    hintsBtn.disabled = !cfgHaWritable || !haBarEntities.length;
  }
  const openBtn = q('ha-bar-open-btn');
  if (openBtn) openBtn.disabled = !cfgHaWritable || !haBarEntities.length;
  const prevLink = q('ha-bar-preview-link');
  if (prevLink) prevLink.href = api('/assets/habar.html');

  const listEl = q('ha-bar-list');
  if (!listEl) return;
  if (!haBarEntities.length) {
    listEl.innerHTML = '<div class="ha-bar-empty">' + esc(t('ha.bar.emptyAdd', 'Nothing on the bar yet. Add a light, a switch or a scene to start.')) + '</div>';
    return;
  }
  const placeholder = esc(t('ha.bar.labelPlaceholder', 'Optional label'));
  const upLbl = esc(t('common.moveUp', 'Move up'));
  const dnLbl = esc(t('common.moveDown', 'Move down'));
  const rmLbl = esc(t('common.remove', 'Remove'));
  const ctlLbl = esc(t('ha.bar.control', 'Control'));
  const roLbl = esc(t('ha.bar.readOnly', 'Read only'));
  const dis = cfgHaWritable ? '' : ' disabled';
  listEl.innerHTML = haBarEntities.map((item, i) => {
    const info = typeof haEntityLookup === 'function' ? haEntityLookup(item.id) : null;
    const title = (info && info.name) ? info.name : item.id;
    const dom = haBarDomainName(item.id);
    const meta = dom ? dom + ' · ' + item.id : item.id;
    const controlled = HA_BAR_CONTROLLED.indexOf(item.id.split('.')[0]) !== -1;
    const ctl = controlled
      ? '<button type="button" class="ha-bar-ctl" aria-pressed="' + (item.control !== false) + '" aria-label="' + ctlLbl + '" title="' + ctlLbl +
          '" onclick="haBarControl(' + i + ', ' + (item.control === false) + ')"' + dis + '>&#10003;</button>'
      : '<button type="button" class="ha-bar-ctl" aria-pressed="false" aria-label="' + roLbl + '" title="' + roLbl + '" disabled>&#10003;</button>';
    return '<div class="ha-bar-row">' +
      '<div class="ha-bar-ent"><div class="nm">' + esc(title) + '</div><div class="id">' + esc(meta) + '</div></div>' +
      '<input type="text" class="ha-bar-label" value="' + esc(item.label || '') + '" placeholder="' + placeholder + '" onchange="haBarLabel(' + i + ', this.value)"' + dis + '>' +
      '<div class="ss-li-acts">' +
        ctl +
        '<button type="button" aria-label="' + upLbl + '" title="' + upLbl + '" onclick="haBarMove(' + i + ', -1)"' + (i === 0 || !cfgHaWritable ? ' disabled' : '') + '>&uarr;</button>' +
        '<button type="button" aria-label="' + dnLbl + '" title="' + dnLbl + '" onclick="haBarMove(' + i + ', 1)"' + (i === haBarEntities.length - 1 || !cfgHaWritable ? ' disabled' : '') + '>&darr;</button>' +
        '<button type="button" aria-label="' + rmLbl + '" title="' + rmLbl + '" onclick="haBarRemove(' + i + ')"' + dis + '>&times;</button>' +
      '</div></div>';
  }).join('');
}

async function loadHaBar() {
  try {
    const r = await fetch(api('/api/ha/bar'));
    const j = await r.json();
    if (!j || !j.ok) return;
    haBarConfigured = !!j.configured;
    haBarShowHints = j.showHints !== false;
    haBarEntities = Array.isArray(j.entities) ? j.entities : [];
    renderHaBar();
    if (haBarConfigured && typeof ensureHaEntities === 'function') {
      ensureHaEntities(() => { renderHaBar(); });
    }
  } catch (e) {}
}

async function saveHaBar() {
  try {
    const r = await fetch(api('/api/ha/bar'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entities: haBarEntities })
    });
    const j = await r.json();
    if (!j || !j.ok) {
      setHaBarMsg((j && j.error) || t('mqtt.saveFailed', 'Save failed'), 'bad');
      return false;
    }
    haBarEntities = j.entities || [];
    if (typeof j.showHints === 'boolean') haBarShowHints = j.showHints;
    renderHaBar();
    if (typeof loadHome === 'function' && typeof homeStatus !== 'undefined' && homeStatus) loadHome(true);
    setHaBarMsg(t('ha.bar.saved', 'Saved.'), 'good');
    return true;
  } catch (e) {
    setHaBarMsg(e.message, 'bad');
    return false;
  }
}

async function haBarAdd() {
  const inp = q('ha-bar-add');
  if (!inp) return;
  const id = inp.value.trim();
  if (!id) return;
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) {
    setHaBarMsg(t('ha.bar.badEntity', 'Enter an entity ID such as light.living_room.'), 'bad');
    return;
  }
  if (haBarEntities.some(item => item.id === id)) {
    setHaBarMsg(t('ha.bar.duplicate', 'Already on the bar.'), 'bad');
    return;
  }
  if (haBarEntities.length >= HA_BAR_MAX) return;
  haBarEntities.push({ id: id, label: '' });
  if (await saveHaBar()) inp.value = '';
  else haBarEntities.pop();
}

async function haBarRemove(idx) {
  const prev = haBarEntities.slice();
  haBarEntities.splice(idx, 1);
  if (!(await saveHaBar())) {
    haBarEntities = prev;
    renderHaBar();
  }
}

async function haBarMove(idx, dir) {
  const next = idx + dir;
  if (next < 0 || next >= haBarEntities.length) return;
  const prev = haBarEntities.slice();
  const moved = haBarEntities.splice(idx, 1)[0];
  haBarEntities.splice(next, 0, moved);
  if (!(await saveHaBar())) {
    haBarEntities = prev;
    renderHaBar();
  }
}

async function haBarLabel(idx, val) {
  if (!haBarEntities[idx]) return;
  const prev = haBarEntities[idx].label || '';
  haBarEntities[idx].label = String(val || '').trim();
  if (!(await saveHaBar())) {
    haBarEntities[idx].label = prev;
    renderHaBar();
  }
}

async function haBarControl(idx, on) {
  if (!haBarEntities[idx]) return;
  const prev = haBarEntities[idx].control;
  if (on) delete haBarEntities[idx].control;
  else haBarEntities[idx].control = false;
  if (!(await saveHaBar())) {
    if (prev === false) haBarEntities[idx].control = false;
    else delete haBarEntities[idx].control;
    renderHaBar();
  }
}

async function haBarToggleHints() {
  if (!cfgHaWritable || !haBarEntities.length) return;
  const btn = q('ha-bar-hints-btn');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(api('/api/ha/bar'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showHints: !haBarShowHints })
    });
    const j = await r.json();
    if (!j || !j.ok) {
      setHaBarMsg((j && j.error) || t('mqtt.saveFailed', 'Save failed'), 'bad');
      return;
    }
    haBarShowHints = j.showHints !== false;
    renderHaBar();
    setHaBarMsg(t('ha.bar.saved', 'Saved.'), 'good');
  } catch (e) {
    setHaBarMsg(e.message, 'bad');
  } finally {
    renderHaBar();
  }
}

async function openHaBarOnTv() {
  const btn = q('ha-bar-open-btn');
  if (btn) btn.disabled = true;
  setHaBarMsg(t('ha.bar.opening', 'Opening on TV...'));
  try {
    const r = await fetch(api('/api/ha/bar/open'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const j = await r.json();
    if (j && j.ok) setHaBarMsg(t('ha.bar.opened', 'Opened on the TV.'), 'good');
    else setHaBarMsg((j && j.error) || t('ha.bar.openFailed', 'Could not open on the TV.'), 'bad');
  } catch (e) {
    setHaBarMsg(e.message, 'bad');
  } finally {
    if (btn) btn.disabled = !cfgHaWritable || !haBarEntities.length;
  }
}
