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

// Under a saver added on the TV, who made it, its license and what it does
// past the screen; under one that cannot be picked, why. Glasshouse's own carry nothing more.
function ssMeta(m) {
  if (m.note) return `<div class="ss-meta bad">${esc(m.note)}</div>`;
  if (m.builtin !== false) return '';
  const bits = [t('ss.added', 'Added on this TV')];
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
  const ours = d.current !== 'stock';
  q('ss-level-row').hidden = !ours;
  if (ours) {
    q('ss-level').innerHTML = [['dim', t('ss.dim', 'Dim')], ['bright', t('ss.bright', 'Bright')]].map(([id, label]) =>
      `<button class="ss-lvl${d.level === id ? ' on' : ''}" data-level="${id}"
               ${locked ? 'disabled' : ''}>${label}</button>`).join('');
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

  const lvl = ev.target.closest('button.ss-lvl[data-level]');
  if (lvl && !lvl.disabled && !lvl.classList.contains('on')) {
    lvl.disabled = true;
    // The mode goes with it: both are staged into the same file.
    const r = await sendCommand('screensaverMode', { mode: ssCurrent, level: lvl.dataset.level });
    if (!r || !r.ok) lvl.disabled = false;
    loadScreensavers();
  }
});
