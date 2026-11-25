// The screen saver tab.

let ssCurrent = 'stock';
let ssWritable = true;
let ssSwitching = false;
let ssSwitchPoll = null;
let ssBlockedReason = '';
let ssPrevBlockedReason = '';
let ssForceEntityRender = false;
let ssListItems = [];
let ssListMax = 100;

const SS_SWITCHING = t('ss.switching',
  'The TV is switching screen savers. The screen may stay dark for up to a minute, then it comes back on its own.');
const SS_ONLY_IN_APPS = t('ss.onlyInApps',
  'The screen saver can only be started while a webOS app is running, not from an HDMI input or Live TV.');
const SS_TV_OFF = t('ss.tvOff', 'The TV is off. Switch it on to start a screen saver.');

/*
 * Marks a button as refused, with the reason. Not `disabled`: a disabled button
 * receives no mouse events, so the browser never shows its title - and the
 * reason it cannot be pressed is the one thing someone hovering it wants.
 */
function refuseScreensaver(el, why) {
  if (!el) return;
  const blocked = !!why;
  el.classList.toggle('btn-off', blocked);
  /*
   * Only write when it changes. The page polls every two seconds, and a browser
   * cancels the tooltip it was about to show whenever the title is written -
   * even with the same text - so rewriting it on every tick means the tooltip
   * never survives long enough to appear.
   */
  setIfChanged(el, 'title', why || '');
  if (blocked) {
    if (el.getAttribute('aria-disabled') !== 'true') el.setAttribute('aria-disabled', 'true');
  } else if (el.hasAttribute('aria-disabled')) {
    el.removeAttribute('aria-disabled');
  }
}

function setIfChanged(el, prop, value) {
  if (el[prop] !== value) el[prop] = value;
}

function pressScreensaver(id) {
  const el = q(id);
  if (el && el.getAttribute('aria-disabled') === 'true') return;
  sendCommand('screensaver');
}

// Under a saver added on the TV or an installed app's, who made it, its
// license and what it does past the screen; under one that cannot be picked,
// why. Built-in savers carry only their author when one is named.
function ssMeta(m) {
  if (m.note) return `<div class="ss-meta bad">${esc(m.note)}</div>`;
  if (m.builtin !== false) {
    return m.author ? `<div class="ss-meta">${esc(t('ss.by', 'by {author}', { author: m.author }))}</div>` : '';
  }
  const bits = [m.fromApp ? t('ss.installedApp', 'Installed app') : t('ss.added', 'Added on this TV')];
  if (m.author) bits.push(t('ss.by', 'by {author}', { author: m.author }));
  if (m.license) bits.push(m.license);
  const cautions = (m.cautions || []).join(' ');
  return `<div class="ss-meta">${esc(bits.join(' · '))}</div>` +
    (cautions ? `<div class="ss-meta warn">${esc(cautions)}</div>` : '');
}

function ssModeVisible(m, d) {
  if (m.active) return true;
  if (m.needsHa && !d.haConfigured) return false;
  if (m.id === 'video' && (!m.available || m.note)) return false;
  return true;
}

async function loadScreensavers() {
  const box = q('ss-list');
  if (!box) return;
  let d;
  try {
    d = await (await fetch(api('/api/screensaver'))).json();
  } catch (e) { showErr(e.message); return; }
  if (!d || !d.ok) { showErr((d && d.error) || t('ss.readFailed', 'Could not read the screen savers')); return; }
  ssCurrent = d.current;
  ssSwitching = !!d.switching;
  renderSsExperimental(d);
  const locked = !d.writable || ssSwitching;

  box.innerHTML = d.modes.filter(m => ssModeVisible(m, d)).map(m => `
    <button class="ss-card${m.active ? ' on' : ''}" data-ss="${esc(m.id)}"
            ${(!m.available || locked) ? 'disabled' : ''}>
      <div class="ss-name"><span>${esc(m.label)}</span>${m.active ? `<span class="ss-tag">${t('ss.inUse', 'In use')}</span>` : ''}</div>
      <div class="ss-desc">${esc(m.description)}</div>${m.id === 'random' && m.active && d.staged ? `<div class="ss-meta">${t('ss.randomUpNext', 'Up next: {name}', { name: saverTitle(d.staged, d.modes) })}</div>` : ''}${ssMeta(m)}
    </button>`).join('');
  // The one in use in view, once: after that the list stays where it was scrolled to.
  const inUse = box.querySelector('.ss-card.on');
  if (inUse && !box.dataset.scrolled) {
    box.dataset.scrolled = '1';
    box.scrollTop = Math.max(0, inUse.offsetTop - (box.clientHeight - inUse.offsetHeight) / 2);
  }

  /* LG's own screen saver is not ours to draw, so brightness is offered only
     for the ones that are. */
  // An installed app's has its own settings, so no brightness from here either.
  const ours = d.current !== 'stock' && !d.modes.some(m => m.active && m.fromApp);
  q('ss-level-row').hidden = !ours;
  if (ours) {
    q('ss-bright-wrap').classList.toggle('disabled', !!locked);
    if (!ssBrightDragging) showSsBrightness(typeof d.brightness === 'number' ? d.brightness : (d.level === 'bright' ? 100 : 65));
  }

  // The option picked from the one in use's, where it has them.
  const active = d.modes.find(m => m.active);
  const choices = active && active.choices;
  q('ss-choice-row').hidden = !choices;
  if (choices) q('ss-choice-lbl').textContent = active.choicesLabel || t('ss.choice', 'Animation');
  if (choices) renderSsPick(choices, d.choice, locked);
  else ssPickOpen(false);

  // Value colour customization using the shared .pill-sel select where supported.
  const colors = active && active.colors;
  if (q('ss-color-row')) {
    q('ss-color-row').hidden = !(colors && colors.length);
    if (colors && colors.length) renderSsColorPick(colors, active.color, locked);
  }

  q('ss-news-row').hidden = !(active && active.newsFeeds);
  if (active && active.newsFeeds) renderNewsFeeds('ss-news', active.newsFeeds, !locked);

  q('ss-video-row').hidden = !(active && active.videoStyle);
  if (active && active.videoStyle) renderSsVideo(active.videoStyle, locked);

  q('ss-art-row').hidden = !(active && active.art);
  if (active && active.art) { ssArtState = Object.assign({}, ssArtState || {}, active.art, { writable: d.writable }); frameShowNow(ssArtState); }

  // Entities or ordered entity list declared by the active screen saver:
  const entities = active && active.entities;
  const entityList = active && active.entityList;
  const hasEnts = !!(entities && entities.length);
  const hasList = !!entityList;
  // Drawn in their dialog, open or not, so the tab's summary can read them.
  if (hasEnts) renderSsEntities(active.id, entities, d.haConfigured, locked);
  else if (hasList) renderSsEntityList(active.id, entityList, d.haConfigured, locked);

  // A Home Assistant screen saver: its options and entities in a dialog, and
  // a line on the tab saying what it reads.
  const haSaver = !!(active && (active.needsHa || hasEnts || hasList));
  ssHaPlaceRows(haSaver);
  q('ss-ha-row').hidden = !haSaver;
  if (haSaver) {
    q('ha-modal-title').textContent = active.label;
    q('ha-modal-sub').textContent = active.description || '';
    q('ha-sec-look').hidden = !q('ha-look').querySelector('.ss-level-row:not([hidden])');
  } else if (!q('ha-modal').hidden) closeHaSaverSettings();
  ssBlockedReason = (entityList && (!entityList.items || entityList.items.length < entityList.min))
    ? t('ss.entities.tooFew', 'Add at least {min} entities before starting this screen saver (OLED burn-in protection).', { min: entityList.min })
    : '';
  syncSsBlockedUi();
  if (haSaver) q('ss-ha-summary').textContent = haSaverSummary(entities, entityList, d.haConfigured);

  const isRandom = d.current === 'random';
  const poolRow = q('ss-pool-row');
  if (poolRow) {
    poolRow.hidden = !isRandom;
    if (isRandom) renderSsPool(d, locked);
  }
  /* Where LG's screen saver is built differently from ours, the TV has to
     restart its app manager to move between them, and nothing answers until it
     is back. Say so before, and hold the controls while it happens. */
  const extNote = (d.external && d.external.active)
    ? (t('ss.external.active', 'A third-party homebrew screen saver is currently active on the TV. Selecting a Glasshouse screen saver will replace it.') + ' ')
    : '';
  q('ss-note').textContent = extNote + (!d.writable
    ? t('ss.controlsOff', 'Controls are disabled in config.json, so the screen saver cannot be changed from here.')
    : ssSwitching ? SS_SWITCHING
    : d.held && d.current !== 'stock' ? t('ss.held', 'Custom screen savers are turned off on this TV for now, as they have not been tried on its webOS version. Switch to LG\'s screen saver to stop using this one now; otherwise it goes when the TV is next fully restarted.')
    : (d.slowSwitch ? t('ss.slowSwitch', 'On this TV, switching to or from the LG default takes about a minute, and the screen goes dark while it does.') + ' ' : '')
      + t('ss.firmwareNote', 'Note: if a firmware update is applied, the screen saver will be restored to the LG default.'));
  renderSsPowerOff(d);
  ssWritable = d.writable;
  // The status poll sets it from here on; this just saves waiting for it.
  if (ssSwitching) refuseScreensaver(q('ss-toggle'), SS_SWITCHING);

  clearTimeout(ssSwitchPoll);
  if (ssSwitching) ssSwitchPoll = setTimeout(() => { if (activeTab === 'screensaver') loadScreensavers(); }, 4000);
}

/*
 * The Animation picker. Options in a row under the same group go under its
 * heading; the button names the group and the option picked.
 */
let ssPickKey_ = '';
function renderSsPick(choices, current, locked) {
  const btn = q('ss-choice'), list = q('ss-pick-list');
  const cur = choices.find(c => c.id === current) || choices[0];
  btn.innerHTML = (cur.group ? `<span class="grp">${esc(cur.group)}</span>` : '') + esc(cur.label);
  btn.disabled = locked;
  // Rebuilt only when the options or the pick change, so an open list keeps where it is scrolled.
  const key = current + '|' + choices.length + '|' + (choices[0] && choices[0].id);
  if (key === ssPickKey_) return;
  ssPickKey_ = key;
  let html = '', group = null;
  choices.forEach(c => {
    if ((c.group || null) !== group) {
      group = c.group || null;
      if (group) html += `<div class="ss-pick-head" role="presentation">${esc(group)}</div>`;
    }
    html += `<div class="ss-pick-opt" role="option" id="ss-opt-${esc(c.id)}" data-id="${esc(c.id)}"
      aria-selected="${c.id === cur.id ? 'true' : 'false'}">${esc(c.label)}</div>`;
  });
  list.innerHTML = html;
}

let ssColorKey_ = '';
function renderSsColorPick(colors, current, locked) {
  const sel = q('ss-color');
  if (!sel) return;
  const cur = (colors.find(c => c.id === current) || colors[0]).id;
  const key = cur + '|' + colors.map(c => c.id + ':' + c.label).join(',');
  if (key !== ssColorKey_) {
    ssColorKey_ = key;
    sel.innerHTML = colors.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
    sel.value = cur;
  }
  sel.disabled = locked;
}

let ssEntitiesKey_ = '';
onHaEntitiesReset(() => { ssEntitiesKey_ = ''; });

function ssHaSlotLabel(e) {
  const m = /^sensor_(\d+)$/.exec(e.id);
  return m ? t('ss.sensorSlot', 'Sensor {n}', { n: m[1] }) : e.label;
}

function ssHaLookup(entityId) {
  return haEntityLookup(entityId);
}

function ssHaFriendlyHint(entityId) {
  if (!entityId) return t('ss.entityHidden', 'Hidden');
  const hit = ssHaLookup(entityId);
  if (!hit) return '';
  const parts = [];
  if (hit.name) parts.push(hit.name);
  if (hit.unit) parts.push('(' + hit.unit + ')');
  return parts.join(' ');
}

function renderSsEntities(saverId, entities, haConfigured, locked) {
  const container = q('ss-entities-list');
  const note = q('ss-entities-note');
  const setup = q('ss-entities-setup');
  if (!container) return;

  if (note) {
    if (haConfigured === false) {
      note.textContent = t('ss.haNotConfigured', 'Home Assistant API is not configured. Save the address and access token in the HA and MQTT tab.');
      note.className = 'set-note warn';
    } else {
      note.textContent = t('ss.entities.desc', 'Choose which Home Assistant entities this screen saver reads and optional short display labels. Leave an entity blank to hide it.');
      note.className = 'set-note';
    }
  }
  if (setup) setup.hidden = haConfigured !== false;

  const haState = haEntitiesState();
  if (haConfigured && !haState.loaded && !haState.error) ensureHaEntities(() => loadScreensavers());

  // Do not rebuild inputs while the user is typing in or picking from them,
  // except after a save: a slot given its first entity gains its Label row
  // then (#1446), and focus, with what is being typed, is put back after.
  const active = document.activeElement;
  const inside = !!(active && container.contains(active));
  const pkOpen = !!(haPickerState.key && haPickerState.key.indexOf('ss:' + saverId + ':') === 0);
  if ((inside || pkOpen) && !ssForceEntityRender) return;
  ssForceEntityRender = false;
  const keep = inside && active.id ? { id: active.id, value: active.value,
    start: active.selectionStart, end: active.selectionEnd } : null;

  const key = (locked ? '1' : '0') + '|' + (haConfigured ? '1' : '0') + '|' +
    (haState.loaded ? haState.entities.length : -1) + '|' + saverId + '|' +
    entities.map(e => e.id + '=' + e.entity + ':' + (e.customLabel || '')).join(',');
  if (key === ssEntitiesKey_) return;
  ssEntitiesKey_ = key;

  let html = '';
  const hidePlaceholder = t('ss.entityHidden', 'Hidden');
  const chooseTitle = t('ss.chooseEntity', 'Choose entity');
  const clearTitle = t('ss.clearEntity', 'Clear');
  const labelTitle = t('ss.entityLabel', 'Label');
  const labelFallback = t('ss.entityLabelPlaceholder', 'Home Assistant name (optional override)');
  entities.forEach(e => {
    const hit = ssHaLookup(e.entity);
    const hint = ssHaFriendlyHint(e.entity);
    const labelPlaceholder = (hit && hit.name) ? hit.name : labelFallback;
    const pkKey = 'ss:' + saverId + ':' + e.id;
    html += `
      <div class="ss-entity-field">
        <div class="ss-entity-head">
          <label for="ss-ent-${esc(e.id)}">${esc(ssHaSlotLabel(e))}</label>
          ${hint ? `<span class="ss-entity-hint">${esc(hint)}</span>` : ''}
        </div>
        <div class="ss-ent-wrap">
          <input type="text" id="ss-ent-${esc(e.id)}" data-slot="${esc(e.id)}" data-saver="${esc(saverId)}"
            value="${esc(e.entity || '')}" placeholder="${esc(hidePlaceholder)}"
            autocomplete="off" spellcheck="false" aria-expanded="false" ${locked ? 'disabled' : ''}
            oninput="ssHaFilter('${esc(saverId)}', '${esc(e.id)}')"
            onkeydown="haPickerKeydown(event, '${esc(pkKey)}')"
            onchange="saveSsEntity('${esc(saverId)}', '${esc(e.id)}', this.value)">
          ${(haConfigured && !locked) ? `<button type="button" class="ss-ent-btn" title="${esc(chooseTitle)}" aria-label="${esc(chooseTitle)}" onclick="ssHaToggle('${esc(saverId)}', '${esc(e.id)}')">&#9662;</button>` : ''}
          ${(!locked && e.entity) ? `<button type="button" class="ss-ent-btn" title="${esc(clearTitle)}" aria-label="${esc(clearTitle)}" onclick="saveSsEntity('${esc(saverId)}', '${esc(e.id)}', '')">&times;</button>` : ''}
          <div class="ss-pick-list ss-ha-list ha-picker" id="ss-ha-list-${esc(e.id)}" hidden></div>
        </div>
        ${e.entity ? `<div class="ss-ent-label-row">
          <label for="ss-lbl-${esc(e.id)}">${esc(labelTitle)}</label>
          <input type="text" id="ss-lbl-${esc(e.id)}" value="${esc(e.customLabel || '')}" maxlength="64"
            placeholder="${esc(labelPlaceholder)}" autocomplete="off" ${locked ? 'disabled' : ''}
            onchange="saveSsEntityLabel('${esc(saverId)}', '${esc(e.id)}', this.value)">
        </div>` : ''}
      </div>`;
  });
  container.innerHTML = html;
  entities.forEach(e => {
    const slotId = e.id;
    const currentEntity = e.entity || '';
    haPickerRegister('ss:' + saverId + ':' + slotId, {
      listId: 'ss-ha-list-' + slotId,
      inputId: 'ss-ent-' + slotId,
      getCurrentId: () => currentEntity,
      onPick: id => ssHaPick(saverId, slotId, id)
    });
  });
  const back = keep && q(keep.id);
  if (back) {
    // A field tabbed to before the save came back keeps what was typed in it.
    if (typeof keep.value === 'string' && back.value !== keep.value) back.value = keep.value;
    back.focus();
    if (typeof keep.start === 'number') {
      try { back.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text field */ }
    }
  }
}

function ssHaCloseAll() {
  haPickerCloseAll();
}

function ssHaToggle(saverId, slot) {
  haPickerToggle('ss:' + saverId + ':' + slot);
}

function ssHaFilter(saverId, slot) {
  const input = document.getElementById('ss-ent-' + slot);
  if (!input) return;
  haPickerFilter('ss:' + saverId + ':' + slot, input.value);
}

function ssHaPick(saverId, slot, entityId) {
  ssHaCloseAll();
  if (slot === '_add') {
    const input = document.getElementById('ss-ent-_add');
    if (input) input.value = '';
    addSsListEntity(saverId, entityId);
    return;
  }
  const input = document.getElementById('ss-ent-' + slot);
  if (input) input.value = entityId;
  saveSsEntity(saverId, slot, entityId);
}

function syncSsBlockedUi() {
  const btn = q('ss-toggle');
  if (!btn) return;
  const ssOn = btn.classList.contains('on');
  if (!ssOn && ssBlockedReason) refuseScreensaver(btn, ssBlockedReason);
  else if (!ssOn && ssPrevBlockedReason && btn.title === ssPrevBlockedReason) refuseScreensaver(btn, '');
  ssPrevBlockedReason = ssBlockedReason;
}

function renderSsEntityList(saverId, entityList, haConfigured, locked) {
  const container = q('ss-entities-list');
  const note = q('ss-entities-note');
  const setup = q('ss-entities-setup');
  if (!container) return;

  const items = Array.isArray(entityList.items) ? entityList.items : [];
  ssListItems = items.map(it => ({ entity: it.entity || '', label: it.label || '' }));
  ssListMax = entityList.max || 100;

  if (note) {
    if (haConfigured === false) {
      note.textContent = t('ss.haNotConfigured', 'Home Assistant API is not configured. Save the address and access token in the HA and MQTT tab.');
      note.className = 'set-note warn';
    } else if (items.length < entityList.min) {
      note.textContent = t('ss.entityList.statusNeedMore',
        'Add at least {min} entities ({count} of {max} configured). Cycles in order and shifts pixels on every change to prevent OLED burn-in.',
        { min: entityList.min, count: items.length, max: ssListMax });
      note.className = 'set-note warn';
    } else {
      note.textContent = t('ss.entityList.statusReady',
        'Cycling through {count} of {max} entities in order. Leave a label blank to use the Home Assistant name.',
        { count: items.length, max: ssListMax });
      note.className = 'set-note';
    }
  }
  if (setup) setup.hidden = haConfigured !== false;

  const haState = haEntitiesState();
  if (haConfigured && !haState.loaded && !haState.error) ensureHaEntities(() => loadScreensavers());

  const active = document.activeElement;
  const pkOpen = !!(haPickerState.key && haPickerState.key.indexOf('ss:' + saverId + ':') === 0);
  if (!ssForceEntityRender && ((active && container.contains(active)) || pkOpen)) return;
  ssForceEntityRender = false;

  const key = 'list|' + (locked ? '1' : '0') + '|' + (haConfigured ? '1' : '0') + '|' +
    (haState.loaded ? haState.entities.length : -1) + '|' + saverId + '|' + ssListMax + '|' +
    items.map(it => it.entity + ':' + (it.label || '')).join(',');
  if (key === ssEntitiesKey_) return;
  ssEntitiesKey_ = key;

  const addLbl = t('ss.entityList.addLabel', 'Add entity');
  const addPh = t('ss.entityList.addPlaceholder', 'Search or type entity ID...');
  const addBtnLbl = t('ss.entityList.addBtn', 'Add');
  const chooseTitle = t('ss.chooseEntity', 'Choose entity');
  const upTitle = t('ss.entityList.moveUp', 'Move up');
  const downTitle = t('ss.entityList.moveDown', 'Move down');
  const rmTitle = t('ss.entityList.remove', 'Remove');
  const labelTitle = t('ss.entityLabel', 'Label');
  const customPh = t('ss.entityList.customLabelPlaceholder', 'Custom display label (optional)');
  const full = items.length >= ssListMax;
  const addPkKey = 'ss:' + saverId + ':_add';

  let html = `
    <div class="ss-li-head">
      <label for="ss-ent-_add">${esc(addLbl)}</label>
      <span class="ss-li-count num">${items.length} / ${ssListMax}</span>
    </div>
    <div class="ss-li-add">
      <div class="ss-ent-wrap">
        <input type="text" id="ss-ent-_add" data-saver="${esc(saverId)}" placeholder="${esc(addPh)}"
          autocomplete="off" spellcheck="false" aria-expanded="false" ${(locked || full) ? 'disabled' : ''}
          oninput="ssHaFilter('${esc(saverId)}', '_add')"
          onkeydown="if(!haPickerKeydown(event,'${esc(addPkKey)}')&&event.key==='Enter'){event.preventDefault();addSsListEntity('${esc(saverId)}');}">
        ${(haConfigured && !locked && !full) ? `<button type="button" class="ss-ent-btn" title="${esc(chooseTitle)}" aria-label="${esc(chooseTitle)}" onclick="ssHaToggle('${esc(saverId)}', '_add')">&#9662;</button>` : ''}
        <div class="ss-pick-list ss-ha-list ha-picker" id="ss-ha-list-_add" hidden></div>
      </div>
      <button type="button" class="ss-li-add-btn" ${(locked || full) ? 'disabled' : ''} onclick="addSsListEntity('${esc(saverId)}')">${esc(addBtnLbl)}</button>
    </div>`;

  if (items.length) {
    html += '<div class="ss-li-scroll">';
    items.forEach((it, idx) => {
      const hit = ssHaLookup(it.entity);
      const displayTitle = (hit && hit.name) ? hit.name : it.entity;
      const subId = (hit && hit.name)
        ? (it.entity + (hit.unit ? ' \u00b7 ' + hit.unit : ''))
        : (hit && hit.unit ? hit.unit : '');
      const lblPh = (hit && hit.name) ? hit.name : customPh;
      html += `
        <div class="ss-li-item">
          <div class="ss-li-top">
            <span class="ss-li-num num">${idx + 1}</span>
            <div class="ss-li-info" title="${esc(it.entity)}">
              <div class="ss-li-name">${esc(displayTitle)}</div>
              ${subId ? `<div class="ss-li-id">${esc(subId)}</div>` : ''}
            </div>
            <div class="ss-li-acts">
              <button type="button" title="${esc(upTitle)}" aria-label="${esc(upTitle)}" ${(locked || idx === 0) ? 'disabled' : ''} onclick="moveSsListEntity('${esc(saverId)}', ${idx}, -1)">&#8593;</button>
              <button type="button" title="${esc(downTitle)}" aria-label="${esc(downTitle)}" ${(locked || idx === items.length - 1) ? 'disabled' : ''} onclick="moveSsListEntity('${esc(saverId)}', ${idx}, 1)">&#8595;</button>
              <button type="button" title="${esc(rmTitle)}" aria-label="${esc(rmTitle)}" ${locked ? 'disabled' : ''} onclick="removeSsListEntity('${esc(saverId)}', ${idx})">&times;</button>
            </div>
          </div>
          <div class="ss-li-label">
            <label for="ss-li-lbl-${idx}">${esc(labelTitle)}</label>
            <input type="text" id="ss-li-lbl-${idx}" value="${esc(it.label || '')}" maxlength="64"
              placeholder="${esc(lblPh)}" autocomplete="off" ${locked ? 'disabled' : ''}
              onchange="saveSsListLabel('${esc(saverId)}', ${idx}, this.value)">
          </div>
        </div>`;
    });
    html += '</div>';
  }
  container.innerHTML = html;
  haPickerRegister('ss:' + saverId + ':_add', {
    listId: 'ss-ha-list-_add',
    inputId: 'ss-ent-_add',
    getUsedIds: () => ssListItems.map(it => it.entity),
    onPick: id => ssHaPick(saverId, '_add', id)
  });
}

async function commitSsEntityList(saverId, nextItems, forceRender) {
  ssHaCloseAll();
  const r = await sendCommand('screensaverEntities', { saver: saverId, entities: nextItems });
  if (r && r.ok) {
    ssListItems = nextItems;
    ssEntitiesKey_ = '';
    if (forceRender) ssForceEntityRender = true;
    loadScreensavers();
  }
}

function addSsListEntity(saverId, explicitId) {
  const input = document.getElementById('ss-ent-_add');
  const raw = explicitId !== undefined ? String(explicitId) : (input ? input.value : '');
  const trimmed = raw.trim();
  if (!trimmed) {
    if (input) input.focus();
    if (haEntitiesState().loaded) ssHaToggle(saverId, '_add');
    return;
  }
  if (ssListItems.length >= ssListMax) return;
  const next = ssListItems.concat([{ entity: trimmed, label: '' }]);
  if (input) input.value = '';
  commitSsEntityList(saverId, next, true);
}

function moveSsListEntity(saverId, idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= ssListItems.length) return;
  const next = ssListItems.slice();
  const tmp = next[idx];
  next[idx] = next[target];
  next[target] = tmp;
  commitSsEntityList(saverId, next, true);
}

function removeSsListEntity(saverId, idx) {
  if (idx < 0 || idx >= ssListItems.length) return;
  const next = ssListItems.slice();
  next.splice(idx, 1);
  commitSsEntityList(saverId, next, true);
}

function saveSsListLabel(saverId, idx, label) {
  if (idx < 0 || idx >= ssListItems.length) return;
  const next = ssListItems.slice();
  next[idx] = { entity: next[idx].entity, label: String(label || '').trim() };
  commitSsEntityList(saverId, next, false);
}

async function saveSsEntityPatch(saverId, slot, val) {
  ssHaCloseAll();
  const patch = {};
  patch[slot] = val;
  await sendCommand('screensaverEntities', { saver: saverId, entities: patch });
  ssEntitiesKey_ = '';
  ssForceEntityRender = true;
  loadScreensavers();
}

function saveSsEntity(saverId, slot, value) {
  return saveSsEntityPatch(saverId, slot, { entity: value.trim(), label: '' });
}

function saveSsEntityLabel(saverId, slot, label) {
  return saveSsEntityPatch(saverId, slot, { label: label.trim() });
}

function ssPickOpts() { return [...q('ss-pick-list').querySelectorAll('.ss-pick-opt')]; }

function ssPickOpen(open) {
  const list = q('ss-pick-list'), btn = q('ss-choice');
  if (open && btn.disabled) return;
  list.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) return;
  const sel = list.querySelector('[aria-selected="true"]') || ssPickOpts()[0];
  ssPickActive(sel);
  list.focus();
}

// The option the arrow keys are on, kept in view below its sticky heading.
function ssPickActive(el) {
  const list = q('ss-pick-list');
  ssPickOpts().forEach(o => o.classList.toggle('act', o === el));
  if (!el) return;
  list.setAttribute('aria-activedescendant', el.id);
  const head = 34, top = el.offsetTop - head, bottom = el.offsetTop + el.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

function ssPickKey(ev) {
  const list = q('ss-pick-list'), open = !list.hidden;
  const opts = ssPickOpts(), at = opts.indexOf(list.querySelector('.ss-pick-opt.act'));
  const go = i => { ev.preventDefault(); ssPickActive(opts[Math.max(0, Math.min(opts.length - 1, i))]); };
  if (!open) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(ev.key)) { ev.preventDefault(); ssPickOpen(true); }
    return;
  }
  if (ev.key === 'ArrowDown') return go(at + 1);
  if (ev.key === 'ArrowUp') return go(at - 1);
  if (ev.key === 'PageDown') return go(at + 10);
  if (ev.key === 'PageUp') return go(at - 10);
  if (ev.key === 'Home') return go(0);
  if (ev.key === 'End') return go(opts.length - 1);
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (opts[at]) pickSsChoice(opts[at].dataset.id); return; }
  // Escape closes an open list; with it closed, it is left for a dialog around it.
  if (ev.key === 'Escape' || ev.key === 'Tab') { if (ev.key === 'Escape' && !q('ss-pick-list').hidden) ev.preventDefault(); ssPickOpen(false); q('ss-choice').focus(); }
}

async function pickSsChoice(id) {
  ssPickOpen(false);
  q('ss-choice').focus();
  const cur = q('ss-pick-list').querySelector('[aria-selected="true"]');
  if (cur && cur.dataset.id === id) return;
  q('ss-choice').disabled = true;
  await sendCommand('screensaverMode', { mode: ssCurrent, choice: id });
  loadScreensavers();
}

/*
 * The Video saver's clock, date, weather and text, saved with Home's video
 * playlist (lib/home-wallpapers), which restages the saver with them.
 */
function renderSsVideo(style, locked) {
  const show = [['showClock', t('home.video.clock', 'Clock')], ['showDate', t('home.video.date', 'Date')],
    ['showWeather', t('home.video.weather', 'Weather')], ['showCaptions', t('home.video.captions', 'Captions')]];
  q('ss-video-show').innerHTML = show.map(([key, label]) => `<label class="ss-pool-item${locked ? ' dis' : ''}">
      <input type="checkbox" ${style[key] !== false ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="ssVideoStyle('${key}', this.checked)">
      <span class="ss-pool-name">${esc(label)}</span>
    </label>`).join('');
  const { corners, sizes, fonts } = homeVideoChoices();
  const fill = (id, options, value) => {
    const sel = q(id);
    if (document.activeElement !== sel) {
      sel.innerHTML = options.map(([v, label]) => `<option value="${esc(String(v))}">${esc(label)}</option>`).join('');
      sel.value = String(value);
    }
    sel.disabled = locked;
  };
  fill('ss-video-info-position', corners, style.infoPosition);
  fill('ss-video-info-size', HOME_VIDEO_SIZES.infoSize.map((size, i) => [size, sizes[i]]), style.infoSize);
  fill('ss-video-clock-font', fonts.map(([v, name]) => [v, t('ss.video.clockFont', 'Clock in {font}', { font: name })]), style.clockFont);
  fill('ss-video-text-font', fonts.map(([v, name]) => [v, t('ss.video.textFont', 'Text in {font}', { font: name })]), style.textFont);
  const colour = q('ss-video-text-color');
  if (document.activeElement !== colour) colour.value = style.textColor;
  colour.disabled = locked;
  q('ss-video-reset').disabled = locked;
}

async function ssVideoSave(videoStyle) {
  try { await homePost('/api/home/wallpapers', { videoStyle }); }
  catch (e) { showErr(e.message); }
  loadScreensavers();
}

function ssVideoStyle(key, value) {
  ssVideoSave({ [key]: value });
}

// Its own part of the look; the captions' place, size and face stay as the Home tab set them.
function ssVideoReset() {
  const { showClock, showDate, showWeather, infoPosition, infoSize, clockFont, textFont, textColor } = HOME_VIDEO_STYLE;
  ssVideoSave({ showClock, showDate, showWeather, infoPosition, infoSize, clockFont, textFont, textColor });
}

/*
 * The Art saver's pictures: the owner's own, uploaded here, and the museum
 * collections it may fetch from (lib/art); how long each stays, how it fits
 * the screen and when its label shows. A change takes effect with the next
 * picture, as the saver asks for each.
 */
let ssArtUploading = false;
let ssArtState = null;

function renderSsArt(art, locked) {
  ssArtState = art;
  const s = art.settings;
  const pics = art.pictures || [];
  // A switch pressed redraws its row: focus is kept on it, for the keyboard.
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fkey : '';
  const onOff = on => on ? t('common.on', 'On') : t('common.off', 'Off');
  const row = (key, name, desc, on, onclick) => `<div class="prot-row">
      <div class="prot-main">
        <div class="prot-title" id="frame-t-${esc(key)}">${esc(name)}</div>
        ${desc ? `<div class="prot-desc">${esc(desc)}</div>` : ''}
      </div>
      <div class="prot-status"><button type="button" class="pill pill-toggle ${on ? 'good' : 'idle'}" data-fkey="${esc(key)}"
        aria-pressed="${on ? 'true' : 'false'}" aria-labelledby="frame-t-${esc(key)}" onclick="${onclick}" ${locked ? 'disabled' : ''}>${esc(onOff(on))}</button></div>
    </div>`;

  q('ss-art-mine').innerHTML = row('mine', t('ss.art.mineShow', 'Show your pictures'),
    pics.length === 1 ? t('ss.art.mineOne', '1 picture added.') : t('ss.art.mineN', '{n} pictures added.', { n: pics.length }),
    s.mine, `ssArtSave({ mine: ${s.mine ? 'false' : 'true'} })`);

  q('ss-art-sources').innerHTML =
    [['space', t('ss.art.groupSpace', 'Space')], ['photos', t('ss.art.groupPhotos', 'Photography')], ['paintings', t('ss.art.groupPaintings', 'Paintings')]]
      .map(([group, name]) => {
        const list = art.collections.filter(c => (c.group || 'paintings') === group);
        if (!list.length) return '';
        const from = [...new Set(list.map(c => c.source))].join(', ');
        return `<section class="set-sec" aria-labelledby="frame-sec-${group}">
          <h3 class="pv-g" id="frame-sec-${group}">${esc(name)}<span class="c">${esc(from)}</span></h3>
          <div class="prot-table">${list.map(c => row(c.id, c.label, c.detail, c.on, `ssArtCollection('${esc(c.id)}', ${c.on ? 'false' : 'true'})`)).join('')}</div>
        </section>`;
      }).join('');

  const full = pics.length >= art.maxPictures;
  const busy = locked || ssArtUploading || art.uploading;
  q('ss-art-pics').innerHTML = `<div class="wall-card${ssArtUploading ? ' busy' : ''}">
      <button type="button" class="wall-screen" id="ss-art-add" data-fkey="add" onclick="ssArtChoose()" ${busy || full ? 'disabled' : ''}
          aria-label="${esc(t('ss.art.add', 'Add pictures'))}">
        ${full ? '' : `<span class="wall-add">${esc(t('ss.art.add', 'Add pictures'))}</span>`}
        ${ssArtUploading ? `<span class="wall-sending">${esc(t('home.wall.uploading', 'Uploading…'))}</span>` : ''}
      </button>
    </div>` + pics.map((id, i) => `<div class="wall-card has fixed">
      <div class="wall-screen" role="img" aria-label="${esc(t('home.wall.pictureN', 'Picture {n}', { n: i + 1 }))}"
          style="background-image:url('${esc(api('/api/art/image?id=p-' + encodeURIComponent(id)))}')"></div>
      <div class="wall-actions"><button type="button" class="wall-link" data-fkey="rm-${esc(id)}" onclick="ssArtRemove('${esc(id)}')" ${busy ? 'disabled' : ''}
        aria-label="${esc(t('ss.art.removeN', 'Remove picture {n}', { n: i + 1 }))}">${esc(t('home.wall.remove', 'Remove'))}</button></div>
    </div>`).join('');
  const add = q('ss-art-add');
  add.addEventListener('dragover', e => { if (busy || full) return; e.preventDefault(); add.classList.add('drop'); });
  add.addEventListener('dragleave', () => add.classList.remove('drop'));
  add.addEventListener('drop', e => {
    e.preventDefault();
    add.classList.remove('drop');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length && !busy && !full) ssArtUpload(files, art);
  });

  const folders = art.folders || [];
  const browsing = !q('ss-art-browse').hidden;
  q('ss-art-folders').innerHTML = folders.map(f => `<div class="prot-row">
      <div class="prot-main"><div class="prot-title">${esc(f.title || f.server)}</div><div class="prot-desc">${esc(f.server)}</div></div>
      <div class="prot-status"><button type="button" class="pill idle" data-fkey="f-${esc(f.key)}" onclick="ssArtRemoveFolder('${esc(f.key)}')" ${locked ? 'disabled' : ''}
        aria-label="${esc(t('ss.art.removeFolder', 'Remove {folder}', { folder: f.title || f.server }))}">${esc(t('home.wall.remove', 'Remove'))}</button></div>
    </div>`).join('') + (browsing ? '' : `<div class="prot-row">
      <div class="prot-main"><div class="prot-desc set-desc-only">${esc(folders.length ? t('ss.art.foldersMore', 'Pictures from a NAS or media server on your network, such as Plex or Jellyfin, over DLNA.')
        : t('ss.art.foldersNone', 'Pictures from a NAS or media server on your network, such as Plex or Jellyfin, over DLNA. None added yet.'))}</div></div>
      <div class="prot-status"><button type="button" class="pill idle" data-fkey="addfolder" onclick="ssArtBrowse()" ${locked || folders.length >= (art.maxFolders || 10) ? 'disabled' : ''}>${esc(t('ss.art.addFolderShort', 'Add folder'))}</button></div>
    </div>`);

  const fill = (id, options, value) => {
    const sel = q(id);
    if (document.activeElement !== sel) {
      sel.innerHTML = options.map(([v, label]) => `<option value="${esc(String(v))}">${esc(label)}</option>`).join('');
      sel.value = String(value);
    }
    sel.disabled = locked;
  };
  fill('ss-art-minutes', (art.secondChoices || [30, 60, 120, 300, 600, 900, 1800, 3600]).map(n => [n,
    n === 3600 ? t('ss.art.oneHour', '1 hour') : n === 60 ? t('ss.art.oneMinute', '1 minute')
      : n < 60 ? t('ss.art.nSeconds', '{n} seconds', { n }) : t('ss.art.nMinutes', '{n} minutes', { n: n / 60 })]), s.seconds);
  fill('ss-art-fit', [['fit', t('ss.art.fitWhole', 'Whole picture')], ['fill', t('ss.art.fitFill', 'Fill the screen')]], s.fit);
  fill('ss-art-caption', [['brief', t('ss.art.capBrief', 'Briefly')], ['always', t('ss.art.capAlways', 'Always')], ['off', t('ss.art.capOff', 'Off')]], s.caption);

  const where = [];
  const museums = [...new Set(art.collections.filter(c => c.on).map(c => c.source))];
  if (museums.length) {
    where.push(art.fetching ? t('ss.art.fetching', 'Fetching the next painting…')
      : t('ss.art.privacy3', 'Pictures from {sources} are free to show with their credit, which each one’s label carries, and stays on screen where its licence asks. The TV fetches them one at a time, and keeps only the last few and the next one or two.', { sources: museums.join(t('ss.art.and', ' and ')) }));
  }
  if (art.error) where.push(art.error);
  if (!s.mine && !museums.length && !folders.length) where.push(t('ss.art.nothing', 'Pick your pictures or a collection, or the screen saver has nothing to show.'));
  q('ss-art-where').textContent = where.join(' ');
  q('frame-modal-sub').textContent = frameSummary(art);

  if (focusKey) {
    const again = q('frame-modal').querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`);
    if (again && !again.disabled) again.focus();
  }
}

/*
 * Adding a network folder: the media servers found, then a server's folders,
 * one level at a time, each with how many pictures it holds.
 */
let ssArtPath = [];

async function ssArtGet(path) {
  const r = await (await fetch(api(path))).json();
  if (!r.ok) throw new Error(r.error || t('common.unknownError', 'unknown error'));
  return r;
}

async function ssArtBrowse() {
  const box = q('ss-art-browse');
  box.hidden = false;
  ssArtPath = [];
  box.innerHTML = `<p class="set-note" role="status">${esc(t('ss.art.looking', 'Looking for media servers on your network…'))}</p>`;
  if (ssArtState) renderSsArt(ssArtState, false);
  let r;
  try { r = await ssArtGet('/api/art/servers'); } catch (e) { box.innerHTML = `<p class="set-note">${esc(e.message)}</p>`; return; }
  const list = r.servers || [];
  box.innerHTML = (list.length
    ? `<div class="set-crumbs">${esc(t('ss.art.servers', 'Media servers'))}</div><div class="set-list">${list.map(sv => `<button type="button" class="set-item" onclick="ssArtOpen(${esc(JSON.stringify(JSON.stringify({ udn: sv.udn, name: sv.name })))}, '0', '')"><span>${esc(sv.name)}</span><span class="set-chev" aria-hidden="true">›</span></button>`).join('')}</div>`
    : `<p class="set-note">${esc(t('ss.art.noServers', 'No media servers answered. Check that one, such as Plex, Jellyfin or a NAS, is on and sharing over DLNA.'))}</p>`) +
    `<div class="set-actions"><button type="button" class="pill idle" onclick="ssArtBrowseClose()">${esc(t('common.cancel', 'Cancel'))}</button></div>`;
}

function ssArtBrowseClose() {
  q('ss-art-browse').hidden = true;
  ssArtPath = [];
  if (ssArtState) renderSsArt(ssArtState, false);
}

// One folder of a server; up goes back one level, or to the servers.
async function ssArtOpen(serverJson, id, title, up) {
  const sv = JSON.parse(serverJson);
  if (up) ssArtPath = ssArtPath.slice(0, -1);
  else if (id !== '0') ssArtPath.push({ id, title });
  else ssArtPath = [];
  const box = q('ss-art-browse');
  box.innerHTML = `<p class="set-note" role="status">${esc(t('ss.art.opening', 'Opening the folder…'))}</p>`;
  let r;
  try { r = await ssArtGet('/api/art/browse?udn=' + encodeURIComponent(sv.udn) + '&id=' + encodeURIComponent(id)); }
  catch (e) { box.innerHTML = `<p class="set-note">${esc(e.message)}</p><div class="set-actions"><button type="button" class="pill idle" onclick="ssArtBrowse()">${esc(t('ss.art.servers', 'Media servers'))}</button></div>`; return; }
  const svArg = esc(JSON.stringify(serverJson));
  const crumbs = [sv.name].concat(ssArtPath.map(p => p.title)).join(' / ');
  const parent = ssArtPath.length > 1 ? ssArtPath[ssArtPath.length - 2] : null;
  const back = ssArtPath.length
    ? `ssArtOpen(${svArg}, ${esc(JSON.stringify(parent ? parent.id : '0'))}, '', true)`
    : 'ssArtBrowse()';
  const folders = r.folders || [];
  box.innerHTML = `<div class="set-crumbs">${esc(crumbs)}</div>` +
    (folders.length ? `<div class="set-list">${folders.map(f => `<button type="button" class="set-item" onclick="ssArtOpen(${svArg}, ${esc(JSON.stringify(f.id))}, ${esc(JSON.stringify(f.title))})"><span>${esc(f.title)}</span><span class="set-chev" aria-hidden="true">›</span></button>`).join('')}</div>` : '') +
    `<p class="set-note">${esc(r.pictures === 1 ? t('ss.art.folderHasOne', 'This folder holds 1 picture.') : r.pictures ? t('ss.art.folderHas', 'This folder holds {n} pictures.', { n: r.pictures }) : t('ss.art.folderNone', 'This folder holds no JPEG pictures of its own.'))}</p>` +
    `<div class="set-actions">
      <button type="button" class="pill idle" onclick="${back}">${esc(t('ss.art.back', 'Back'))}</button>
      <button type="button" class="pill good" onclick="ssArtAddFolder(${svArg}, ${esc(JSON.stringify(id))})" ${r.pictures ? '' : 'disabled'}>${esc(t('ss.art.useFolder', 'Use this folder'))}</button>
      <button type="button" class="pill idle" onclick="ssArtBrowseClose()">${esc(t('common.cancel', 'Cancel'))}</button>
    </div>`;
}

async function ssArtAddFolder(serverJson, id) {
  const sv = JSON.parse(serverJson);
  const title = ssArtPath.length ? ssArtPath.map(p => p.title).join(' / ') : sv.name;
  try {
    const res = await fetch(api('/api/art'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addFolder: { udn: sv.udn, id, title } }) });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || t('common.unknownError', 'unknown error'));
  } catch (e) { showErr(e.message); return; }
  q('ss-art-browse').hidden = true;
  ssArtPath = [];
  frameChanged();
}

async function ssArtRemoveFolder(key) {
  try {
    const res = await fetch(api('/api/art'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeFolder: key }) });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || t('common.unknownError', 'unknown error'));
  } catch (e) { showErr(e.message); }
  frameChanged();
}

/*
 * What the picture frame shows now, with Previous and Next, which it takes up
 * within a couple of seconds; offered only while it is on screen, as the
 * screen saver or the No Signal screen. Kept up to date while the row shows.
 */
function renderSsArtNow(art, box) {
  if (!box) return;
  const writable = art.writable !== undefined ? art.writable : ssWritable;
  const cur = art.current;
  const info = (cur && cur.info) || {};
  const words = cur
    ? [info.title || t('ss.art.yours', 'One of your pictures'), [info.artist, info.date].filter(Boolean).join(', '), info.credit].filter(Boolean)
    : [];
  const key = JSON.stringify([cur && cur.id, art.showing, art.canGoBack, writable]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const off = !art.showing || !writable;
  box.innerHTML = `<div class="ss-art-now-pic"${cur ? ` style="background-image:url('${esc(api('/api/art/image?id=' + encodeURIComponent(cur.id)))}')"` : ''}></div>
    <div class="ss-art-now-words">${words.length && art.showing
      ? words.map((w, i) => `<div class="${i ? 'prot-desc' : 'prot-title'}">${esc(w)}</div>`).join('')
      : `<div class="prot-desc">${esc(t('ss.art.notShowing', 'Not on screen. Previous and Next work while the picture frame shows, as the screen saver or on an input\u2019s No Signal screen.'))}</div>`}</div>
    <div class="ss-art-now-btns">
      <button type="button" class="pill idle" onclick="ssArtGo('prev')" ${off || !art.canGoBack ? 'disabled' : ''} aria-label="${esc(t('ss.art.prev', 'Previous'))}">\u2039 ${esc(t('ss.art.prev', 'Previous'))}</button>
      <button type="button" class="pill idle" onclick="ssArtGo('next')" ${off ? 'disabled' : ''} aria-label="${esc(t('ss.art.next', 'Next'))}">${esc(t('ss.art.next', 'Next'))} \u203a</button>
    </div>`;
}

/*
 * Now showing, on whichever of the two tabs shows it, and the line saying
 * where the pictures come from and how often they change.
 */
function frameShowNow(art) {
  renderSsArtNow(art, q('ss-art-now'));
  renderSsArtNow(art, q('inputs-art-now'));
  const sum = q('ss-art-summary');
  if (sum) sum.textContent = frameSummary(art);
  ssArtWatchNow();
}

function frameSummary(art) {
  const s = art.settings || {};
  const names = (art.collections || []).filter(c => c.on).map(c => c.label)
    .concat((art.folders || []).map(f => f.title || f.server));
  if (s.mine && (art.pictures || []).length) names.unshift(t('ss.art.mine', 'Your pictures'));
  if (!names.length) return t('ss.art.nothing', 'Pick your pictures or a collection, or the screen saver has nothing to show.');
  const from = names.length > 3
    ? t('ss.art.andMore', '{names} and {n} more', { names: names.slice(0, 2).join(', '), n: names.length - 2 })
    : names.join(', ');
  const n = s.seconds || 600;
  const every = n === 3600 ? t('ss.art.everyHour', 'A new picture every hour')
    : n === 60 ? t('ss.art.everyMinute', 'A new picture every minute')
    : n < 60 ? t('ss.art.everySeconds', 'A new picture every {n} seconds', { n })
    : t('ss.art.everyMinutes', 'A new picture every {n} minutes', { n: n / 60 });
  return t('ss.art.summary', '{from}. {every}.', { from, every });
}

// Kept up to date while it shows: on either tab, or in the dialog.
let ssArtNowTimer = null;
function ssArtWatchNow() {
  if (ssArtNowTimer) return;
  ssArtNowTimer = setInterval(() => {
    if (document.hidden) return;
    const shown = (activeTab === 'screensaver' && !q('ss-art-row').hidden) ||
      (activeTab === 'inputs' && q('inputs-frame') && !q('inputs-frame').hidden) || !q('frame-modal').hidden;
    if (shown) frameLoad(true);
  }, 3000);
}

/*
 * The picture frame's state, read again: Now showing on both tabs, and the
 * dialog's settings where it is open (not on the 3 s refresh, which would
 * redraw a list someone is scrolling).
 */
async function frameLoad(nowOnly) {
  let r;
  try { r = await (await fetch(api('/api/art'))).json(); } catch (e) { return null; }
  if (!r || !r.ok) return null;
  ssArtState = r;
  frameShowNow(r);
  if (!nowOnly && !q('frame-modal').hidden && !ssArtUploading) renderSsArt(r, !r.writable);
  return r;
}

function frameChanged() {
  return frameLoad(false);
}

/*
 * A Home Assistant screen saver's options (its Readings and Value colour rows)
 * are moved into its dialog while one is in use, and back where they were for
 * any other screen saver. A marker keeps their place on the tab.
 */
function ssHaPlaceRows(inDialog) {
  ['ss-choice-row', 'ss-color-row'].forEach(id => {
    const el = q(id);
    if (!el) return;
    if (!el._mark) {
      el._mark = document.createComment(id);
      el.parentNode.insertBefore(el._mark, el);
    }
    if (inDialog && el.parentNode !== q('ha-look')) q('ha-look').appendChild(el);
    if (!inDialog && el.parentNode !== el._mark.parentNode) el._mark.parentNode.insertBefore(el, el._mark.nextSibling);
  });
}

// What it reads, for the tab: the entities' labels, or how many a list holds.
function haSaverSummary(entities, entityList, haConfigured) {
  if (haConfigured === false) return t('ss.haNotConfigured', 'Home Assistant API is not configured. Save the address and access token in the HA and MQTT tab.');
  if (entityList) {
    const n = (entityList.items || []).length;
    const count = n === 1 ? t('ss.ha.listOne', '1 entity, one at a time.') : t('ss.ha.listN', '{n} entities, one at a time.', { n });
    return ssBlockedReason ? count + ' ' + ssBlockedReason : count;
  }
  const names = (entities || []).filter(e => e.entity).map(e => {
    const hit = ssHaLookup(e.entity);
    return e.customLabel || (hit && hit.name) || e.entity;
  });
  if (!names.length) return t('ss.ha.none', 'No entities chosen yet.');
  return (names.length > 3
    ? t('ss.art.andMore', '{names} and {n} more', { names: names.slice(0, 2).join(', '), n: names.length - 2 })
    : names.join(', ')) + '.';
}

function openHaSaverSettings() {
  setModalOpen(q('ha-modal'), q('ha-modal-close'));
}

function closeHaSaverSettings() {
  if (typeof ssHaCloseAll === 'function') ssHaCloseAll();
  ssPickOpen(false);
  setModalClose(q('ha-modal'));
}

/*
 * A settings dialog (set-modal) keeps the keyboard inside while it is open,
 * and gives focus back to what opened it when it closes.
 */
function setModalOpen(box, first) {
  box._opener = document.activeElement;
  box.hidden = false;
  if (!box._trapped) {
    box._trapped = true;
    box.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const all = [...box.querySelectorAll('button,select,input,a[href],[tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
      if (!all.length) return;
      const at = all.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
      else if (!e.shiftKey && at === all.length - 1) { e.preventDefault(); all[0].focus(); }
    });
  }
  if (first) first.focus();
}

function setModalClose(box) {
  box.hidden = true;
  const back = box._opener;
  box._opener = null;
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
}

function openFrameSettings() {
  const box = q('frame-modal');
  setModalOpen(box, q('frame-modal-close'));
  if (ssArtState && ssArtState.secondChoices) renderSsArt(ssArtState, ssArtState.writable === false);
  frameLoad(false);
}

function closeFrameSettings() {
  setModalClose(q('frame-modal'));
  q('ss-art-browse').hidden = true;
  ssArtPath = [];
}

async function ssArtGo(dir) {
  try {
    const res = await fetch(api('/api/art'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ go: dir }) });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || t('common.unknownError', 'unknown error'));
  } catch (e) { showErr(e.message); }
  // The screen takes it up within a couple of seconds.
  setTimeout(() => frameLoad(true), 2500);
}

async function ssArtSave(settings) {
  try {
    const res = await fetch(api('/api/art'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || t('common.unknownError', 'unknown error'));
  } catch (e) { showErr(e.message); }
  frameChanged();
}

function ssArtCollection(id, on) {
  const ids = ssArtState ? ssArtState.collections.filter(c => c.on && c.id !== id).map(c => c.id) : [];
  if (on) ids.push(id);
  ssArtSave({ collections: ids });
}

function ssArtChoose() {
  if (ssArtUploading) return;
  const input = q('ss-art-file');
  input.value = '';
  input.click();
}

function ssArtPicked(input) {
  const files = Array.from(input.files || []);
  if (files.length) ssArtUpload(files, ssArtState);
}

// One after another, as the TV takes one upload at a time.
async function ssArtUpload(files, art) {
  if (ssArtUploading || !art) return;
  const note = q('ss-art-note');
  const room = Math.max(0, art.maxPictures - (art.pictures || []).length);
  const take = files.slice(0, room);
  ssArtUploading = true;
  renderSsArt(art, false);
  let done = 0, failed = '';
  for (const file of take) {
    note.textContent = t('home.wall.uploadingOf', 'Uploading {n} of {total}…', { n: done + 1, total: take.length });
    try {
      const blob = await homePrepareWall(file);
      const res = await fetch(api('/api/art/upload'), { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const r = await res.json();
      if (!res.ok || !r.ok) throw new Error(r.error || t('home.wall.uploadFailed', 'The image could not be uploaded.'));
      done++;
    } catch (e) { failed = file.name + ': ' + e.message; }
  }
  ssArtUploading = false;
  const parts = [t('home.wall.uploadedN', '{n} of {total} uploaded.', { n: done, total: files.length })];
  if (files.length > take.length) parts.push(t('ss.art.room', 'The picture frame holds {max} of your pictures.', { max: art.maxPictures }));
  if (failed) parts.push(failed);
  note.textContent = parts.join(' ');
  frameChanged();
}

async function ssArtRemove(id) {
  try {
    const res = await fetch(api('/api/art'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: id }) });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || t('common.unknownError', 'unknown error'));
  } catch (e) { showErr(e.message); }
  frameChanged();
}

async function pickSsColor(id) {
  const sel = q('ss-color');
  if (sel) sel.disabled = true;
  await sendCommand('screensaverColor', { saver: ssCurrent, color: id });
  loadScreensavers();
}

function saverTitle(id, modes) {
  const m = (modes || []).find(x => x.id === id);
  return m ? m.label : id;
}

function renderSsPool(d, locked) {
  const box = q('ss-pool-box');
  const countEl = q('ss-pool-count');
  if (!box) return;
  const pool = (d.random && d.random.pool) || [];
  const candidates = (d.modes || []).filter(m => m.id !== 'stock' && m.id !== 'random' && !m.fromApp && ssModeVisible(m, d));
  if (countEl) countEl.textContent = t('ss.poolCount', '{n} of {total} selected', { n: pool.length, total: candidates.length });
  const allBtn = q('ss-pool-all'), noneBtn = q('ss-pool-none');
  if (allBtn) allBtn.disabled = locked;
  if (noneBtn) noneBtn.disabled = locked;
  box.innerHTML = candidates.map(m => {
    const inPool = pool.includes(m.id);
    const dis = locked || !m.available;
    return `<label class="ss-pool-item${dis ? ' dis' : ''}">
      <input type="checkbox" data-id="${esc(m.id)}" ${inPool ? 'checked' : ''} ${dis ? 'disabled' : ''} onchange="ssPoolToggle('${esc(m.id)}')">
      <span class="ss-pool-name">${esc(m.label)}</span>
    </label>`;
  }).join('');
}

async function ssPoolToggle(id) {
  await sendCommand('screensaverRandomPool', { toggle: id });
  loadScreensavers();
}

async function ssPoolSelectAll(selectAll) {
  let d;
  try {
    d = await (await fetch(api('/api/screensaver'))).json();
  } catch (e) { return; }
  if (!d || !d.modes) return;
  const candidates = d.modes.filter(m => m.id !== 'stock' && m.id !== 'random' && !m.fromApp && m.available !== false);
  const ids = selectAll ? candidates.map(m => m.id) : [];
  await sendCommand('screensaverRandomPool', ids);
  loadScreensavers();
}

/*
 * Power off after: minutes of screen saver before the TV goes to standby,
 * picked from a list and saved at once. A number set another way, in
 * config.json or typed here before, is kept in the list.
 */
const SS_POWEROFF_CHOICES = [0, 15, 30, 60, 120, 240];
function renderSsPowerOff(d) {
  const sel = q('ss-poweroff'), desc = q('ss-poweroff-desc');
  if (!sel) return;
  const n = d.powerOffMinutes || 0;
  const list = SS_POWEROFF_CHOICES.includes(n) ? SS_POWEROFF_CHOICES : SS_POWEROFF_CHOICES.concat(n).sort((x, y) => x - y);
  const html = list.map(m => '<option value="' + m + '"' + (m === n ? ' selected' : '') + '>' +
    esc(m ? t('ctl.sleep.minutes', '{n} min', { n: m }) : t('common.off', 'Off')) + '</option>').join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.value = String(n);
  sel.disabled = !d.writable;
  desc.textContent = !d.allowPower
    ? t('ss.powerOff.noPower', 'Power actions are off in config.json, so this cannot put the TV in standby.')
    : n === 1 ? t('ss.powerOff.onOne', 'The TV goes to standby once a screen saver has been on for a minute. Any button on the remote starts the count again.')
    : n ? t('ss.powerOff.on', 'The TV goes to standby once a screen saver has been on for {n} minutes. Any button on the remote starts the count again.', { n })
    : t('ss.powerOff.offPick', 'How long a screen saver runs before the TV goes to standby.');
}

async function saveSsPowerOff() {
  const sel = q('ss-poweroff');
  sel.disabled = true;
  try {
    await sendCommand('screensaverPowerOff', sel.value === '0' ? '' : sel.value);
  } finally {
    sel.disabled = false;
    loadScreensavers();
  }
}

/*
 * Where LG's screen saver is a Flutter app and custom ones are untried (webOS 11
 * and later), they are experimental (#366): the switch is here, where people look for them, as
 * well as under Server → Advanced, and turning it on asks first.
 */
function renderSsExperimental(d) {
  const box = q('ss-exp');
  if (!box) return;
  const shown = !!(d.held || d.heldOverridden);
  box.hidden = !shown;
  if (!shown) return;
  const on = !!d.heldOverridden;
  q('ss-exp-title').textContent = on
    ? t('ss.exp.onTitle', 'Custom screen savers: on (experimental)')
    : t('ss.exp.title', 'Custom screen savers are experimental on this TV');
  q('ss-exp-desc').textContent = t('ss.exp.desc', 'They have not been tried on this webOS version. Before Glasshouse 0.98.1, on webOS 10, using one sometimes left the picture, the sound and HDMI control off until the TV was unplugged.');
  updateToggle('ss-exp-btn', {
    cls: on ? 'good' : 'idle',
    label: on ? t('common.on', 'On') : t('common.off', 'Off'),
    on: on,
    disabled: !d.writable
  });
}

async function toggleSsExperimental() {
  const b = q('ss-exp-btn');
  const turnOn = !b.dataset.on;
  if (turnOn && !confirm(t('ss.exp.confirm', 'Switch on custom screen savers?\n\nThey have not been tried on this webOS version. Before Glasshouse 0.98.1, on webOS 10, using one sometimes left the picture, the sound and HDMI control off until the TV was unplugged. Unplugging the TV for a minute puts it right.'))) return;
  b.disabled = true;
  await sendCommand('setWebos10ScreensaversAllowed', turnOn);
  loadScreensavers();
}

document.addEventListener('click', async ev => {
  if (!ev.target.closest) return;

  const card = ev.target.closest('.ss-card[data-ss]');
  if (card && !card.disabled && !card.classList.contains('on')) {
    card.disabled = true;
    const r = await sendCommand('screensaverMode', { mode: card.dataset.ss });
    if (!r || !r.ok) card.disabled = false;
    loadScreensavers();
    return;
  }

  // The Animation list: an option picks it; a click anywhere else closes it.
  const opt = ev.target.closest('.ss-pick-opt[data-id]');
  if (opt) { pickSsChoice(opt.dataset.id); return; }
  if (!ev.target.closest('#ss-pick') && !q('ss-pick-list').hidden) ssPickOpen(false);
});

/* Brightness, in 5% steps from 5%, sent on release: each value restages the
   screen saver, and one on screen is closed and shown again for it. 65% and
   100% are the Dim and Bright each screen saver was drawn at before. */
let ssBrightDragging = false;

function showSsBrightness(v) {
  q('ss-bright-slider').value = v;
  q('ss-bright-fill').style.width = v + '%';
  q('ss-bright-lbl').textContent = v + '%';
}

function initSsBrightSlider() {
  const wrap = q('ss-bright-wrap'), slider = q('ss-bright-slider');
  let active = false, keyTimer = 0;
  const clamp = v => Math.max(5, Math.min(100, v));
  const at = e => {
    const r = wrap.getBoundingClientRect();
    return clamp(Math.round(((e.clientX - r.left) / r.width) * 20) * 5);
  };
  const save = async v => {
    showSsBrightness(v);
    wrap.classList.add('disabled');
    // The mode goes with it: both are staged into the same file.
    await sendCommand('screensaverMode', { mode: ssCurrent, brightness: v });
    loadScreensavers();
  };
  const stop = e => {
    active = false;
    ssBrightDragging = false;
    wrap.classList.remove('dragging');
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || wrap.classList.contains('disabled')) return;
    active = true;
    ssBrightDragging = true;
    wrap.classList.add('dragging');
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    showSsBrightness(at(e));
  });
  wrap.addEventListener('pointermove', e => { if (active) showSsBrightness(at(e)); });
  wrap.addEventListener('pointerup', e => {
    if (!active) return;
    stop(e);
    save(at(e));
  });
  wrap.addEventListener('pointercancel', e => {
    if (!active) return;
    stop(e);
    loadScreensavers();
  });
  slider.addEventListener('keydown', e => {
    const steps = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 25, PageDown: -25 };
    let v;
    if (steps[e.key]) v = Number(slider.value) + steps[e.key];
    else if (e.key === 'Home') v = 5;
    else if (e.key === 'End') v = 100;
    else return;
    e.preventDefault();
    if (wrap.classList.contains('disabled')) return;
    // Sent once the keys stop, not per step.
    v = clamp(v);
    showSsBrightness(v);
    ssBrightDragging = true;
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => { ssBrightDragging = false; save(v); }, 700);
  });
}

initSsBrightSlider();
