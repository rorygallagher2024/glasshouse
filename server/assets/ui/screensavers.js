// The screen saver tab.

let ssCurrent = 'stock';
let ssWritable = true;
let ssSwitching = false;
let ssSwitchPoll = null;

const SS_SWITCHING = t('ss.switching',
  'The TV is switching screen savers. The screen may stay dark for up to a minute, then it comes back on its own.');
const SS_ONLY_IN_APPS = t('ss.onlyInApps',
  'The screen saver can only be started while a webOS app is running, not from an HDMI input or Live TV.');

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
// why. Glasshouse's own carry nothing more.
function ssMeta(m) {
  if (m.note) return `<div class="ss-meta bad">${esc(m.note)}</div>`;
  if (m.builtin !== false) return '';
  const bits = [m.fromApp ? t('ss.installedApp', 'Installed app') : t('ss.added', 'Added on this TV')];
  if (m.author) bits.push(t('ss.by', 'by {author}', { author: m.author }));
  if (m.license) bits.push(m.license);
  const cautions = (m.cautions || []).join(' ');
  return `<div class="ss-meta">${esc(bits.join(' · '))}</div>` +
    (cautions ? `<div class="ss-meta warn">${esc(cautions)}</div>` : '');
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

  box.innerHTML = d.modes.map(m => `
    <button class="ss-card${m.active ? ' on' : ''}" data-ss="${esc(m.id)}"
            ${(!m.available || locked) ? 'disabled' : ''}>
      <div class="ss-name"><span>${esc(m.label)}</span>${m.active ? `<span class="ss-tag">${t('ss.inUse', 'In use')}</span>` : ''}</div>
      <div class="ss-desc">${esc(m.description)}</div>${ssMeta(m)}
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

  // Entities declared by the active screen saver:
  const entities = active && active.entities;
  const entRow = q('ss-entities-row');
  if (entRow) {
    entRow.hidden = !entities || !entities.length;
    if (!entRow.hidden) renderSsEntities(active.id, entities, d.haConfigured, locked);
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

let ssEntitiesKey_ = '';
function renderSsEntities(saverId, entities, haConfigured, locked) {
  const container = q('ss-entities-list');
  const note = q('ss-entities-note');
  if (!container) return;

  if (note) {
    if (haConfigured === false) {
      note.textContent = t('ss.haNotConfigured', 'Home Assistant API is not configured. Set up the address and access token in the MQTT tab.');
      note.className = 'pv-sub warn';
    } else {
      note.textContent = t('ss.entities.desc', 'Values are read directly from Home Assistant while this screen saver is showing.');
      note.className = 'pv-sub';
    }
  }

  const key = (locked ? '1' : '0') + '|' + saverId + '|' + entities.map(e => e.id + '=' + e.entity).join(',');
  if (key === ssEntitiesKey_) return;
  ssEntitiesKey_ = key;

  let html = '';
  entities.forEach(e => {
    html += `
      <div class="ss-entity-field">
        <label for="ss-ent-${esc(e.id)}">${esc(e.label)}</label>
        <input type="text" id="ss-ent-${esc(e.id)}" data-slot="${esc(e.id)}" value="${esc(e.entity || '')}"
          placeholder="${esc(e.def || '')}" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}
          onchange="saveSsEntity('${esc(saverId)}', '${esc(e.id)}', this.value)">
      </div>`;
  });
  container.innerHTML = html;
}

async function saveSsEntity(saverId, slot, value) {
  const patch = {};
  patch[slot] = value.trim();
  await sendCommand('screensaverEntities', { saver: saverId, entities: patch });
  ssEntitiesKey_ = '';
  loadScreensavers();
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
  if (ev.key === 'Escape' || ev.key === 'Tab') { if (ev.key === 'Escape') ev.preventDefault(); ssPickOpen(false); q('ss-choice').focus(); }
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
 * Poweroff after: minutes of screen saver before the TV goes to standby.
 * Typed rather than picked, so any number of minutes will do; blank is off.
 */
function renderSsPowerOff(d) {
  const input = q('ss-poweroff'), btn = q('ss-poweroff-save'), desc = q('ss-poweroff-desc');
  if (!input) return;
  const n = d.powerOffMinutes || 0;
  // Not while someone is typing: the tab reloads under them.
  if (!input.dataset.dirty) input.value = n ? String(n) : '';
  input.disabled = btn.disabled = !d.writable;
  desc.textContent = !d.allowPower
    ? t('ss.powerOff.noPower', 'Power actions are off in config.json, so this cannot put the TV in standby.')
    : n === 1 ? t('ss.powerOff.onOne', 'The TV goes to standby once a screen saver has been on for a minute. Any button on the remote starts the count again.')
    : n ? t('ss.powerOff.on', 'The TV goes to standby once a screen saver has been on for {n} minutes. Any button on the remote starts the count again.', { n })
    : t('ss.powerOff.off', 'Minutes of screen saver before the TV goes to standby. Blank for never.');
}

async function saveSsPowerOff() {
  const input = q('ss-poweroff'), btn = q('ss-poweroff-save');
  btn.disabled = true; btn.classList.add('busy');
  try {
    // A refusal, such as a word for a number, is shown by sendCommand.
    const r = await sendCommand('screensaverPowerOff', input.value.trim());
    if (r && r.ok) delete input.dataset.dirty;
  } finally {
    btn.disabled = false; btn.classList.remove('busy');
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
