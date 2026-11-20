// The service menu section in the System tab.

async function loadServiceMenu() {
  let d;
  try {
    d = await (await fetch(api('/api/servicemenu'), { cache: 'no-store' })).json();
  } catch (e) { showErr(e.message); return; }
  if (!d || !d.ok) { showErr((d && d.error) || t('svc.readFailed', 'Could not read the service menu state')); return; }

  const dis = d.writable ? '' : 'disabled';
  let lockRow;
  if (!d.lockable) {
    lockRow = `<div class="prot-row silent">
        <div class="prot-main">
          <div class="prot-title">${t('svc.unlock', 'Unlock')}</div>
          <div class="prot-desc">${t('svc.unlock.none.desc', 'This TV does not lock its service menu, so there is nothing to unlock. Newer firmware shows a cut-down menu until it is unlocked.')}</div>
        </div>
        <div class="prot-status"><span class="oled-none">${t('svc.unlock.none', 'Not locked on this TV')}</span></div>
      </div>`;
  } else {
    const locked = d.locked;
    lockRow = `<div class="prot-row guarded">
        <div class="prot-main">
          <div class="prot-title">${t('svc.unlock', 'Unlock')}<span class="oled-sub">${locked
            ? t('svc.unlock.cutDown', 'Showing the cut-down menu') : t('svc.unlock.full', 'Showing the full menu')}</span></div>
          <div class="prot-desc">${t('svc.unlock.desc', 'Unlocked, the menu shows every page rather than the handful LG leaves in.')}
            <strong>${t('svc.unlock.restart', 'The TV has to be switched off and on again before this takes effect.')}</strong></div>
        </div>
        <div class="prot-status">
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
    <div class="prot-row">
      <div class="prot-main">
        <div class="prot-title">${t('svc.pin.title', 'Service PIN')}</div>
        <div class="prot-desc">${t('svc.pin.desc', 'Opening either menu asks for a four-digit PIN on the TV \u2014 usually 0413, though it varies by model and region. Send 0413 enters it on the TV without picking up the remote.')}</div>
      </div>
      <div class="prot-status">
        <button type="button" class="pill idle" data-svc="pin" data-pin="0413" ${dis}>${t('svc.pin.send', 'Send 0413')}</button>
      </div>
    </div>
    <div class="prot-row">
      <div class="prot-main">
        <div class="prot-title"><span translate="no">In Start</span><span class="oled-sub">${t('svc.inStart.sub', 'Diagnostics & panel')}</span></div>
        <div class="prot-desc">${t('svc.inStart.desc', 'System status, total power-on hours (UTT), firmware and SoC revisions, error logs, and OLED panel protections (TPC and GSR).')}</div>
      </div>
      <div class="prot-status">
        <button type="button" class="pill idle" data-svc="open" data-menu="inStart" ${dis}>${t('svc.open', 'Open')}</button>
      </div>
    </div>
    <div class="prot-row">
      <div class="prot-main">
        <div class="prot-title"><span translate="no">EZ Adjust</span><span class="oled-sub">${t('svc.ezAdjust.sub', 'Hardware & calibration')}</span></div>
        <div class="prot-desc">${t('svc.ezAdjust.desc', 'Hardware configuration, Tool Options (1\u20137), model and regional options, and factory white balance calibration.')}</div>
      </div>
      <div class="prot-status">
        <button type="button" class="pill idle" data-svc="open" data-menu="ezAdjust" ${dis}>${t('svc.open', 'Open')}</button>
      </div>
    </div>`;
}

document.addEventListener('click', async ev => {
  if (!ev.target.closest) return;
  const btn = ev.target.closest('#svc-rows button.pill[data-svc]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  if (btn.dataset.svc === 'open') {
    await sendCommand('serviceMenuOpen', { menu: btn.dataset.menu });
    btn.disabled = false;
    return;
  }
  if (btn.dataset.svc === 'pin') {
    const res = await sendCommand('serviceMenuPin', { pin: btn.dataset.pin || '0413' });
    btn.disabled = false;
    if (res && res.ok) {
      btn.textContent = t('svc.pin.sent', 'Sent');
      btn.classList.remove('idle');
      btn.classList.add('good');
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = t('svc.pin.send', 'Send 0413');
        btn.classList.remove('good');
        btn.classList.add('idle');
      }, 1500);
    }
    return;
  }
  const wantLocked = btn.dataset.next === '1';
  if (!wantLocked && !confirm(t('svc.unlock.confirm', 'Unlock the full service menu?\n\nIt can change panel calibration and hardware settings, and the TV must be switched off and on again before this takes effect.'))) {
    btn.disabled = false;
    return;
  }
  await sendCommand('serviceMenuLock', { locked: wantLocked });
  loadServiceMenu();
});
