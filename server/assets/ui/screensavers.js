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
  c('screensaver');
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
  const locked = !d.writable || ssSwitching;

  box.innerHTML = d.modes.map(m => `
    <button class="ss-card${m.active ? ' on' : ''}" data-ss="${esc(m.id)}"
            ${(!m.available || locked) ? 'disabled' : ''}>
      <div class="ss-name"><span>${esc(m.label)}</span>${m.active ? `<span class="ss-tag">${t('ss.inUse', 'In use')}</span>` : ''}</div>
      <div class="ss-desc">${esc(m.description)}</div>
    </button>`).join('');

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
    : d.held ? t('ss.held', 'Custom screen savers are turned off on this TV for now. On webOS 10 and later they can leave the picture, the sound and HDMI control off until the TV is unplugged. Switch to LG\'s screen saver to stop using this one now; otherwise it goes when the TV is next fully restarted.')
    : d.heldOverridden ? t('common.heldOverridden', 'Turned back on with allowOnWebos10 in config.json. On webOS 10 and later custom screen savers and tile hiding have left the picture, the sound and HDMI control off until the TV was unplugged (#366).')
    : (d.slowSwitch ? t('ss.slowSwitch', 'On this TV, switching to or from the LG default takes about a minute, and the screen goes dark while it does.') + ' ' : '')
      + t('ss.firmwareNote', 'Note: if a firmware update is applied, the screen saver will be restored to the LG default.'));
  ssWritable = d.writable;
  // The status poll sets it from here on; this just saves waiting for it.
  if (ssSwitching) refuseScreensaver(q('ss-toggle'), SS_SWITCHING);

  clearTimeout(ssSwitchPoll);
  if (ssSwitching) ssSwitchPoll = setTimeout(() => { if (activeTab === 'screensaver') loadScreensavers(); }, 4000);
}

document.addEventListener('click', async ev => {
  if (!ev.target.closest) return;

  const card = ev.target.closest('.ss-card[data-ss]');
  if (card && !card.disabled && !card.classList.contains('on')) {
    card.disabled = true;
    const r = await c('screensaverMode', { mode: card.dataset.ss });
    if (!r || !r.ok) card.disabled = false;
    loadScreensavers();
    return;
  }

  const lvl = ev.target.closest('button.ss-lvl[data-level]');
  if (lvl && !lvl.disabled && !lvl.classList.contains('on')) {
    lvl.disabled = true;
    // The mode goes with it: both are staged into the same file.
    const r = await c('screensaverMode', { mode: ssCurrent, level: lvl.dataset.level });
    if (!r || !r.ok) lvl.disabled = false;
    loadScreensavers();
  }
});
