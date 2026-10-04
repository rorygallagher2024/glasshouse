// The service menu tab.

async function loadServiceMenu() {
  let d;
  try {
    d = await (await fetch(api('/api/servicemenu'), { cache: 'no-store' })).json();
  } catch (e) { showErr(e.message); return; }
  if (!d || !d.ok) { showErr((d && d.error) || t('svc.readFailed', 'Could not read the service menu state')); return; }

  const dis = d.writable ? '' : 'disabled';
  let lockRow;
  if (!d.lockable) {
    lockRow = `<div class="oled-row silent">
        <div class="oled-main">
          <div class="oled-name">${t('svc.unlock', 'Unlock')}</div>
          <div class="oled-desc">${t('svc.unlock.none.desc', 'This TV does not lock its service menu, so there is nothing to unlock. Newer firmware shows a cut-down menu until it is unlocked.')}</div>
        </div>
        <div class="oled-ctl"><span class="oled-none">${t('svc.unlock.none', 'Not locked on this TV')}</span></div>
      </div>`;
  } else {
    const locked = d.locked;
    lockRow = `<div class="oled-row guarded">
        <div class="oled-main">
          <div class="oled-name">${t('svc.unlock', 'Unlock')}<span class="oled-sub">${locked
            ? t('svc.unlock.cutDown', 'Showing the cut-down menu') : t('svc.unlock.full', 'Showing the full menu')}</span></div>
          <div class="oled-desc">${t('svc.unlock.desc', 'Unlocked, the menu shows every page rather than the handful LG leaves in.')}
            <strong>${t('svc.unlock.restart', 'The TV has to be switched off and on again before this takes effect.')}</strong></div>
        </div>
        <div class="oled-ctl">
          ${renderToggle({
            cls: locked ? 'bad' : 'good',
            label: locked ? t('svc.locked', 'Locked') : t('svc.unlocked', 'Unlocked'),
            next: locked ? '0' : '1',
            disabled: !d.writable,
            attrs: 'data-svc="lock"'
          })}
        </div>
      </div>`;
  }

  q('svc-rows').innerHTML = lockRow + `
    <div class="oled-row">
      <div class="oled-main">
        <div class="oled-name">${t('svc.open', 'Open')}<span class="oled-sub">${t('svc.open.sub', 'On the TV screen')}</span></div>
        <div class="oled-desc">${t('svc.open.desc', 'Puts the menu on the TV, where it asks for a four-digit PIN \u2014 usually 0413, though it varies by model and region. EZ Adjust is the picture and panel menu; In Start is the wider one.')}</div>
      </div>
      <div class="oled-ctl">
        <button class="pill" data-svc="open" data-menu="ezAdjust" ${dis}>EZ Adjust</button>
        <button class="pill" data-svc="open" data-menu="inStart" ${dis}>In Start</button>
      </div>
    </div>`;
}

document.addEventListener('click', async ev => {
  if (!ev.target.closest) return;
  const btn = ev.target.closest('#svc-rows button.pill[data-svc]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  if (btn.dataset.svc === 'open') {
    await c('serviceMenuOpen', { menu: btn.dataset.menu });
    btn.disabled = false;
    return;
  }
  const wantLocked = btn.dataset.next === '1';
  if (!wantLocked && !confirm(t('svc.unlock.confirm', 'Unlock the full service menu?\n\nIt can change panel calibration and hardware settings, and the TV must be switched off and on again before this takes effect.'))) {
    btn.disabled = false;
    return;
  }
  await c('serviceMenuLock', { locked: wantLocked });
  loadServiceMenu();
});
