// The Control and Advanced tabs: power, volume, backlight, toasts, URLs and the TV's switches.

let errTimer = null;
function clearErr() {
  if (errTimer) { clearTimeout(errTimer); errTimer = null; }
  const e = q('err');
  if (e) { e.textContent = ''; e.style.display = 'none'; }
  const offMsg = q('offline-msg');
  if (offMsg) offMsg.style.display = '';
  const off = q('offline');
  const isOffline = q('panels') && q('panels').classList.contains('stale') && (Date.now() - lastOk > 6000);
  if (off && !isOffline) off.hidden = true;
}

function showErr(m) {
  if (errTimer) clearTimeout(errTimer);
  const off = q('offline'), offMsg = q('offline-msg'), e = q('err');
  if (offMsg) offMsg.style.display = 'none';
  if (e) { e.textContent = m; e.style.display = 'inline'; }
  if (off) off.hidden = false;
  errTimer = setTimeout(clearErr, 6000);
}

// An Advanced tab setting: its row shows only once the TV reports a value.
function advPill(row, id, on) {
  const r = q('row-' + row), b = q(id);
  if (r) r.hidden = on === undefined;
  if (!b || on === undefined) return;
  updateToggle(b, {
    cls: on ? 'good' : 'idle',
    label: on ? t('common.on', 'On') : t('common.off', 'Off'),
    on: on
  });
}
function flip(id) { const el = q(id); return el && el.dataset.on ? 'off' : 'on'; }
function toggleLight(which) { sendCommand(which, flip(which === 'standbyLight' ? 'lt_standby' : 'lt_logo')); }
function toggleQuickBoot() { sendCommand('quickBoot', flip('btn_quickboot')); }
function toggleLgLogo() { sendCommand('lgLogo', flip('btn_lglogo')); }
function togglePiccap() { sendCommand('piccap', flip('btn_piccap')); }
function toggleWol() { sendCommand('wakeOnLan', flip('btn_wol')); }
function toggleDeviceDetection() { sendCommand('deviceDetection', flip('btn_devdetect')); }
function toggleAlwaysReady() { sendCommand('alwaysReady', flip('btn_ar')); }
function toggleAlwaysReadyScreen() { sendCommand('alwaysReadyScreen', flip('btn_ars')); }

function applyOptimistic(action, value) {
  if (action === 'volume') {
    const v = Number(value) || 0;
    setLease('volume', v);
    if (q('vol-slider')) q('vol-slider').value = v;
    if (q('vol-fill')) q('vol-fill').style.width = v + '%';
    if (q('vol') && !muted) q('vol').textContent = v;
  } else if (action === 'mute') {
    const m = !!value;
    setLease('mute', m);
    muted = m;
    if (q('mute')) q('mute').classList.toggle('on', m);
    if (q('vol-wrap')) q('vol-wrap').classList.toggle('muted', m);
    const curVol = q('vol-slider') ? q('vol-slider').value : '';
    if (q('vol')) q('vol').textContent = m ? t('ctl.muted', 'MUTED') : curVol;
  } else if (action === 'sleepTimer') {
    const st = String(value);
    setLease('sleepTimer', st);
    ['off','10','30','60','90','120'].forEach(v => {
      const b = q('sl_' + v);
      if (b) b.classList.toggle('on', st === v);
    });
    if (q('tl-cur')) {
      q('tl-cur').textContent = st === 'off' ? t('common.off', 'Off') : t('ctl.sleep.minutes', '{n} min', { n: st });
    }
  } else if (action === 'pictureMode') {
    const pm = String(value);
    setLease('pictureMode', pm);
    const box = q('picmodes');
    if (box) {
      for (let b of box.querySelectorAll('button')) {
        const matches = b.id.replace('pm_', '') === pm;
        b.classList.toggle('on', matches);
        if (matches && q('picmode-lbl')) q('picmode-lbl').textContent = b.textContent.toUpperCase();
      }
    }
  } else if (action === 'energySaving') {
    const es = String(value);
    setLease('energySaving', es);
    if (q('energy-lbl')) q('energy-lbl').textContent = (ENERGY_STEPS[es] || es || '—').toUpperCase();
    const esBox = q('energysteps');
    if (esBox) {
      for (let b of esBox.querySelectorAll('button')) {
        b.classList.toggle('on', b.id.replace('es_', '') === es);
      }
    }
  } else if (action === 'soundOutput') {
    const so = String(value);
    setLease('soundOutput', so);
    holdVolumeControls();
    const soBtns = q('soundouts') ? q('soundouts').querySelectorAll('button') : [];
    for (let b of soBtns) {
      const matches = b.id.replace('so_', '') === so;
      b.classList.toggle('on', matches);
      if (matches && q('soundout-lbl')) q('soundout-lbl').textContent = b.textContent.toUpperCase();
    }
  } else if (action === 'input') {
    const inp = String(value);
    setLease('input', inp);
    const inBtns = q('inputs') ? q('inputs').querySelectorAll('button') : [];
    for (let b of inBtns) {
      const matches = b.id === 'in_' + inp;
      b.classList.toggle('on', matches);
      if (matches && q('currapp-lbl')) q('currapp-lbl').textContent = b.textContent.toUpperCase();
    }
  } else if (action === 'launchApp') {
    const appId = String(value);
    setLease('input', appId);
    const inBtns = q('inputs') ? q('inputs').querySelectorAll('button') : [];
    for (let b of inBtns) b.classList.toggle('on', false);
    const appBtns = q('apps') ? q('apps').querySelectorAll('button') : [];
    for (let b of appBtns) {
      const matches = b.id === 'app_' + appId.replace(/[^a-zA-Z0-9_-]/g, '_') || b.id === 'app_com_webos_app_' + appId;
      b.classList.toggle('on', matches);
      if (matches && q('currapp-lbl')) q('currapp-lbl').textContent = b.textContent.toUpperCase();
    }
  } else if (action === 'quickBoot') {
    const on = value === 'on' || value === true;
    setLease('quickBoot', on);
    advPill('quickboot', 'btn_quickboot', on);
  } else if (action === 'alwaysReady') {
    const on = value === 'on' || value === true;
    setLease('alwaysReady', on);
    advPill('ar', 'btn_ar', on);
    arOffRow(on ? lastArOff : undefined);
  } else if (action === 'alwaysReadyScreen') {
    const on = value === 'on' || value === true;
    setLease('alwaysReadyScreen', on);
    advPill('ars', 'btn_ars', on);
  } else if (action === 'wakeOnLan') {
    const on = value === 'on' || value === true;
    setLease('wakeOnLan', on);
    advPill('wol', 'btn_wol', on);
  } else if (action === 'lgLogo') {
    const on = value === 'on' || value === true;
    setLease('lgLogo', on);
    advPill('lglogo', 'btn_lglogo', on);
  } else if (action === 'piccap') {
    const on = value === 'on' || value === true;
    setLease('piccap', on);
    advPill('piccap', 'btn_piccap', on);
  } else if (action === 'standbyLight') {
    const on = value === 'on' || value === true;
    setLease('standbyLight', on);
    advPill('standby', 'lt_standby', on);
  } else if (action === 'logoLight') {
    const on = value === 'on' || value === true;
    setLease('logoLight', on);
    advPill('logolight', 'lt_logo', on);
  } else if (action === 'deviceDetection') {
    const on = value === 'on' || value === true;
    setLease('deviceDetection', on);
    advPill('devdetect', 'btn_devdetect', on);
  }
}

async function sendCommand(action, value) {
  setBusy(true, 'tx');
  applyOptimistic(action, value);
  try {
    const r = await fetch(api('/api/control'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, value })
    });
    setBusy(true, 'rx');
    const j = await r.json();
    if (!j.ok) {
      clearLease(action);
      showErr(j.error || t('common.actionFailed', 'Action failed'));
      setTimeout(tick, 0);
    } else {
      clearErr();
    }
    setTimeout(tick, 320);
    return j;
  } catch (e) {
    clearLease(action);
    showErr(e.message);
    setTimeout(tick, 0);
  } finally {
    if (action === 'soundOutput') volSettleUntil = 0;
    setBusy(false);
  }
}
// Shown only while Always-on is on: with it off, the TV sleeps every night anyway.
function arOffRow(win) {
  const row = q('row-aroff'), sel = q('sel_aroff');
  if (!row || !sel) return;
  row.hidden = !win;
  if (!win || document.activeElement === sel) return;
  const pad = h => String(h).padStart(2, '0') + ':00';
  if (!sel.options.length) {
    for (let h = 0; h < 24; h++) sel.add(new Option(pad(h) + ' – ' + pad((h + 5) % 24), String(h)));
  }
  const start = parseInt(win.start, 10);
  // LG's menu can set minutes; show such a window as it is rather than round it.
  let custom = sel.querySelector('option[data-custom]');
  if (win.start.slice(3) !== '00') {
    if (!custom) { custom = new Option('', ''); custom.dataset.custom = '1'; custom.disabled = true; sel.add(custom, 0); }
    custom.textContent = win.start + ' – ' + win.end;
    sel.value = '';
  } else {
    if (custom) custom.remove();
    sel.value = String(start);
  }
}

/* OLED light, or Backlight on an LCD. Sent once on release, like volume, and
   held by a lease so the next tick does not snap it back before the TV has
   taken it. */
let blDragging = false;

function showBacklight(v) {
  if (q('bl-slider')) q('bl-slider').value = v;
  if (q('bl-fill')) q('bl-fill').style.width = v + '%';
  if (q('bl-lbl')) q('bl-lbl').textContent = v;
}

function initBacklightSlider() {
  const wrap = q('bl-wrap');
  const slider = q('bl-slider');
  if (!wrap || !slider) return;
  let active = false;
  const at = e => {
    const r = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)));
  };
  const send = async v => {
    showBacklight(v);
    setLease('backlight', v);
    await sendCommand('backlight', v);
  };
  const stop = e => {
    active = false;
    blDragging = false;
    wrap.classList.remove('dragging');
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    active = true;
    blDragging = true;
    wrap.classList.add('dragging');
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    showBacklight(at(e));
  });
  wrap.addEventListener('pointermove', e => { if (active) showBacklight(at(e)); });
  wrap.addEventListener('pointerup', async e => {
    if (!active) return;
    stop(e);
    await send(at(e));
  });
  wrap.addEventListener('pointercancel', e => {
    if (!active) return;
    stop(e);
    clearLease('backlight');
    setTimeout(tick, 0);
  });
  slider.addEventListener('keydown', async e => {
    const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    let v;
    if (steps[e.key]) v = Number(slider.value) + steps[e.key];
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = 100;
    else return;
    e.preventDefault();
    await send(Math.max(0, Math.min(100, v)));
  });
}

let volDragging = false;
let volActive = false;
// While a sound output change settles: the server answers once the TV has
// moved the sound over, and until then the volume and mute may be refused.
// The time limit only covers an answer that never comes.
let volSettleUntil = 0;

function holdVolumeControls() {
  volSettleUntil = Date.now() + 10000;
  if (q('vol-slider')) q('vol-slider').disabled = true;
  if (q('vol-wrap')) q('vol-wrap').classList.add('off');
  if (q('mute')) q('mute').disabled = true;
  if (q('vol-steps')) q('vol-steps').querySelectorAll('button').forEach(b => { b.disabled = true; });
}

function setVolFromPointer(e) {
  const wrap = q('vol-wrap');
  if (!wrap) return 0;
  const rect = wrap.getBoundingClientRect();
  const pct = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
  const slider = q('vol-slider');
  const fill = q('vol-fill');
  if (slider) slider.value = pct;
  if (fill) fill.style.width = pct + '%';
  const volEl = q('vol');
  if (volEl) volEl.textContent = pct;
  wrap.classList.remove('muted');
  muted = false;
  const muteBtn = q('mute');
  if (muteBtn) muteBtn.classList.remove('on');
  return pct;
}

function initVolSlider() {
  const wrap = q('vol-wrap');
  const slider = q('vol-slider');
  if (!wrap || !slider) return;

  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || slider.disabled) return;
    volActive = true;
    volDragging = true;
    wrap.classList.add('dragging');
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    setVolFromPointer(e);
  });

  wrap.addEventListener('pointermove', e => {
    if (!volActive) return;
    setVolFromPointer(e);
  });

  async function finishVol(e) {
    if (!volActive) return;
    volActive = false;
    wrap.classList.remove('dragging');
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
    const val = setVolFromPointer(e);
    setLease('volume', val);
    volDragging = false;
    await sendCommand('volume', val);
  }

  function cancelVol(e) {
    if (!volActive) return;
    volActive = false;
    volDragging = false;
    wrap.classList.remove('dragging');
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
    clearLease('volume');
    setTimeout(tick, 0);
  }

  wrap.addEventListener('pointerup', finishVol);
  wrap.addEventListener('pointercancel', cancelVol);

  slider.addEventListener('keydown', async e => {
    let step = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -1;
    else if (e.key === 'PageUp') step = 10;
    else if (e.key === 'PageDown') step = -10;
    else if (e.key === 'Home') {
      e.preventDefault();
      slider.value = 0;
      if (q('vol-fill')) q('vol-fill').style.width = '0%';
      if (q('vol')) q('vol').textContent = 0;
      wrap.classList.remove('muted');
      muted = false;
      if (q('mute')) q('mute').classList.remove('on');
      setLease('volume', 0);
      await sendCommand('volume', 0);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      slider.value = 100;
      if (q('vol-fill')) q('vol-fill').style.width = '100%';
      if (q('vol')) q('vol').textContent = 100;
      wrap.classList.remove('muted');
      muted = false;
      if (q('mute')) q('mute').classList.remove('on');
      setLease('volume', 100);
      await sendCommand('volume', 100);
      return;
    }
    if (step !== 0) {
      e.preventDefault();
      const current = Number(slider.value) || 0;
      const next = Math.max(0, Math.min(100, current + step));
      slider.value = next;
      if (q('vol-fill')) q('vol-fill').style.width = next + '%';
      if (q('vol')) q('vol').textContent = next;
      wrap.classList.remove('muted');
      muted = false;
      if (q('mute')) q('mute').classList.remove('on');
      setLease('volume', next);
      await sendCommand('volume', next);
    }
  });
}
initVolSlider();
initBacklightSlider();

function toggleMute() {
  muted = !muted;
  setLease('mute', muted);
  q('mute').classList.toggle('on', muted);
  if (q('vol-wrap')) q('vol-wrap').classList.toggle('muted', muted);
  const s = q('vol-slider');
  q('vol').textContent = muted ? t('ctl.muted', 'MUTED') : (!s || s.disabled ? '—' : s.value);
  sendCommand('mute', muted);
}
async function sendToast() {
  const inp = q('toast-input');
  const msg = inp ? inp.value.trim() : '';
  if (!msg) return;
  const btn = q('btn-toast');
  if (btn) btn.disabled = true;
  try {
    await sendCommand('toast', msg);
    if (inp) inp.value = '';
    const tc = q('toast-count');
    if (tc) tc.textContent = '0/120';
    if (btn) {
      const label = btn.textContent;
      btn.textContent = t('ctl.toast.sent', 'Sent');
      btn.classList.add('on');
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove('on');
        btn.disabled = false;
      }, 1400);
    }
  } catch (e) {
    if (btn) btn.disabled = false;
  }
}
const toastInp = q('toast-input');
if (toastInp) {
  toastInp.addEventListener('input', () => {
    const el = q('toast-count');
    if (el) el.textContent = toastInp.value.length + '/120';
  });
}
async function openUrl() {
  const inp = q('url-input');
  let url = inp ? inp.value.trim() : '';
  if (!url) return;
  // "google.com" is what people type; the TV only takes a full address.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  const btn = q('btn-url');
  if (btn) btn.disabled = true;
  try {
    const r = await sendCommand('launch_url', url);
    if (r && r.ok && inp) inp.value = '';
    if (btn) {
      const label = btn.textContent;
      // The browser takes a moment to come up, so say it went rather than
      // leaving a button that looks like it did nothing.
      if (r && r.ok) {
        btn.textContent = t('ctl.openUrl.opened', 'Opened');
        btn.classList.add('on');
      }
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove('on');
        btn.disabled = false;
      }, 1400);
    }
  } catch (e) {
    if (btn) btn.disabled = false;
  }
}
// True while the TV is in Active Standby: switched off but still up, finishing
// panel compensation. The power button then turns it back on instead.
let pwStandby = false;

// installSnap is only set once the Apps tab has polled, so ask the server when
// it is unknown. An unreachable server counts as no install: the warning must
// not stand in the way of a reboot.
async function installRunning() {
  let s = installSnap;
  if (!s) {
    try {
      const r = await fetch(api('/api/apps/install/status'), { cache: 'no-store' });
      s = await r.json();
    } catch (e) { return false; }
  }
  return !!(s && INSTALL_BUSY[s.state]);
}

async function powerAction(a) {
  if (a === 'powerOn') return sendCommand(a);
  if (await installRunning() &&
      !confirm(t('ctl.power.installBusy', 'An app install is in progress. Interrupting it may leave the app half-installed. Continue anyway?'))) return;
  const msg = a === 'reboot'
    ? t('ctl.reboot.confirm', 'Reboot the TV now? It will be unavailable for about a minute.')
    : t('ctl.powerOff.confirm', 'Power off the TV now?');
  if (confirm(msg)) sendCommand(a);
}

// Switched off in config.json, the power buttons are not offered at all.
fetch(api('/api/caps')).then(r => r.json()).then(cp => {
  if (!cp.allowPower) q('pwset').hidden = true;
}).catch(() => {});
