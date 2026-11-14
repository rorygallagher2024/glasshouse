// The Inputs tab: which inputs are offered, the input bar, and the No Signal screen.

const INPUT_BAR = 'com.tvweb.inputbar';
let inputsData = null;
let inputsCat = null;
let inputsSaving = false;

async function loadInputs() {
  // The remote keys say whether a key opens the input bar; the Apps data has them.
  if (!appsData) loadApps();
  const [info, cat] = await Promise.all([
    fetch(api('/api/inputs'), { cache: 'no-store' }).then(r => r.json()).catch(() => null),
    homeGet('/api/home/catalogue').catch(() => null)
  ]);
  inputsData = info && info.ok ? info : null;
  if (!inputsSaving) inputsCat = cat;
  renderInputs();
}

function renderInputs() {
  const shown = [renderInputBar(), renderInputList(), renderNoSignal()];
  q('inputs-none').hidden = shown.some(Boolean);
}

/*
 * Glasshouse Home's Inputs row, which the input bar follows, here so it can be
 * arranged with Glasshouse Home switched off. Each change is saved to that
 * same layout.
 */
function renderInputList() {
  const grp = q('inputs-grp-list');
  const cat = inputsCat;
  const byId = {};
  ((cat && cat.devices) || []).forEach(d => { byId[d.id] = d; });
  const order = cat ? ((cat.order && cat.order.dev) || (cat.devices || []).map(d => d.id)).filter(id => byId[id]) : [];
  const rk = appsData && appsData.remoteKeys;
  const barUsed = !!(rk && rk.keys && rk.keys.some(k => k.action === 'open' && k.id === INPUT_BAR));
  const homeUsed = !!(cat && cat.enabled) || !!(typeof homeLauncherActive !== 'undefined' && homeLauncherActive);
  const show = order.length > 0 && (barUsed || homeUsed);
  grp.hidden = !show;
  if (!show) return false;
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains('inp-name-in')) return true;
  const writable = !!(inputsData && inputsData.writable);
  const layout = cat.layout || {};
  const hidden = (layout.hidden && layout.hidden.dev) || [];
  const unusedOff = layout.hideUnused === true;
  const showMedia = layout.showMediaServers === true;
  const sort = layout.sort && layout.sort.dev === 'recent' ? 'recent' : 'custom';
  const movable = writable && sort !== 'recent';
  const sortRow = `<div class="prot-row">
    <div class="prot-main"><div class="prot-title"><label for="inputs-sort">${esc(t('home.sort', 'Order'))}</label></div>
      <div class="prot-desc">${esc(sort === 'recent'
        ? t('home.sortRecentDesc', 'The tile opened last comes first, whether it was opened from Glasshouse Home or not. Tiles not yet opened follow in this row’s own order.')
        : t('home.sortCustomDesc', 'As arranged here, or by holding OK on Glasshouse Home.'))}</div></div>
    <div class="prot-status"><select id="inputs-sort" class="pill-sel" ${writable ? '' : 'disabled'} onchange="inputsSetSort(this.value)">
      <option value="custom"${sort === 'custom' ? ' selected' : ''}>${esc(t('home.sortCustom', 'Your order'))}</option>
      <option value="recent"${sort === 'recent' ? ' selected' : ''}>${esc(t('home.sortRecent', 'Last opened'))}</option>
    </select></div></div>`;
  const unusedRow = `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('home.hideUnused', 'Hide inputs with nothing connected'))}</div>
      <div class="prot-desc">${esc(t('home.hideUnusedDesc', 'Leaves inputs with nothing plugged in out of the Inputs row, instead of showing them greyed out. They still show while arranging.'))}</div></div>
    <div class="prot-status">${renderToggle({ id: 'home-hide-unused', cls: unusedOff ? 'good' : 'idle', label: unusedOff ? t('common.on', 'On') : t('common.off', 'Off'),
      on: unusedOff, disabled: !writable, onclick: `inputsSave({ hideUnused: ${unusedOff ? 'false' : 'true'} })` })}</div></div>`;
  const mediaRow = `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('inputs.showMediaServers', 'Show media servers'))}</div>
      <div class="prot-desc">${esc(t('inputs.showMediaServersDesc', 'Shows DLNA media servers discovered on your network alongside your TV’s inputs. Leave off to hide all current and future media servers.'))}</div></div>
    <div class="prot-status">${renderToggle({ id: 'inputs-show-media-servers', cls: showMedia ? 'good' : 'idle', label: showMedia ? t('common.on', 'On') : t('common.off', 'Off'),
      on: showMedia, disabled: !writable, onclick: `inputsSave({ showMediaServers: ${showMedia ? 'false' : 'true'} })` })}</div></div>`;
  const rows = order.map((id, i) => {
    const d = byId[id], isShown = hidden.indexOf(id) === -1;
    const leftOut = !!(d.unused && unusedOff);
    const ico = typeof window.glasshouseDevIcon === 'function' ? window.glasshouseDevIcon(d) : '';
    let path;
    if (d.tuner) path = t('ctl.liveTv', 'Live TV');
    else if (d.kind === 'dms') path = t('inputs.kind.dms', 'Media server');
    else if (d.kind === 'usb') path = t('inputs.kind.usb', 'USB');
    else if (d.kind === 'airplay') path = 'AirPlay';
    else if (d.kind === 'screenshare') path = t('inputs.kind.screenshare', 'Screen Share');
    else if (d.kind === 'allinputs') path = t('inputs.kind.allinputs', 'All inputs');
    else path = d.via ? t('home.dev.through', 'HDMI {port}, through {via}', { port: d.port, via: d.via }) : t('home.dev.port', 'HDMI {port}', { port: d.port });
    const isActionTile = !!(d.tuner || d.kind === 'airplay' || d.kind === 'screenshare' || d.kind === 'allinputs');
    const defName = d.defaultName || d.name;
    const nameHtml = d.tuner
      ? `<div class="inp-name" translate="no">${esc(d.name)}</div>`
      : `<input type="text" class="inp-name inp-name-in" translate="no" maxlength="60" value="${esc(d.name)}" placeholder="${esc(defName)}" data-dev-name="${esc(id)}" data-cur="${esc(d.name)}" data-def="${esc(defName)}" aria-label="${esc(t('inputs.nameLabel', 'Input name'))}" ${writable ? '' : 'disabled'} onkeydown="inputsNameKey(event, this)" onblur="inputsRename(this)">`;
    const stateHtml = isActionTile
      ? ''
      : leftOut
        ? `<span class="pill idle">${esc(t('home.leftOut', 'Left out'))}</span>`
        : d.unused
          ? `<span class="inp-status"><i></i>${esc(t('home.dev.unused', 'Nothing connected'))}</span>`
          : `<span class="inp-status conn"><i></i>${esc(t('home.dev.connected', 'Connected'))}</span>`;
    return `<div class="inp-card home-tile${!isShown || leftOut ? ' home-hidden' : ''}${d.unused ? ' inp-unused' : isActionTile ? '' : ' inp-conn'}">
      <div class="inp-head">
        <div class="inp-ico">${ico}</div>
        <div class="inp-txt">
          ${nameHtml}
          <div class="inp-port">${esc(path)}</div>
          ${stateHtml ? `<div class="inp-state">${stateHtml}</div>` : ''}
        </div>
      </div>
      <div class="inp-foot">
        <div class="inp-moves">
          <button type="button" class="pill idle home-move" ${movable && i > 0 ? '' : 'disabled'} onclick="inputsMove(${i}, -1)" aria-label="${esc(t('home.earlier', 'Earlier'))}">←</button>
          <button type="button" class="pill idle home-move" ${movable && i < order.length - 1 ? '' : 'disabled'} onclick="inputsMove(${i}, 1)" aria-label="${esc(t('home.later', 'Later'))}">→</button>
        </div>
        <button type="button" class="pill ${isShown ? 'good' : 'idle'}" ${writable ? '' : 'disabled'} data-dev="${esc(id)}" onclick="inputsToggleInput(this)">${esc(isShown ? t('home.shown', 'Shown') : t('home.hidden', 'Hidden'))}</button>
      </div>
    </div>`;
  });
  q('inputs-list').innerHTML = `<div class="prot-table">${sortRow}${unusedRow}${mediaRow}</div><div class="inp-grid">${rows.join('')}</div>`;
  return true;
}

async function inputsSave(patch) {
  inputsSaving = true;
  try { await homePost('/api/home/layout', patch); } catch (e) { showErr(e.message); }
  inputsSaving = false;
  loadInputs();
  if (typeof homeStatus !== 'undefined' && homeStatus) loadHome(true);
}

function inputsSetSort(value) {
  const layout = (inputsCat && inputsCat.layout) || {};
  const cur = layout.sort && layout.sort.dev === 'recent' ? 'recent' : 'custom';
  if (value === cur) return;
  inputsSave({ sort: { dev: value } });
}

function inputsMove(i, d) {
  const cat = inputsCat;
  const byId = {};
  ((cat && cat.devices) || []).forEach(x => { byId[x.id] = x; });
  const order = cat ? ((cat.order && cat.order.dev) || (cat.devices || []).map(x => x.id)).filter(id => byId[id]) : [];
  const j = i + d;
  if (j < 0 || j >= order.length) return;
  const next = order.slice();
  [next[i], next[j]] = [next[j], next[i]];
  inputsSave({ order: { dev: next } });
}

function inputsToggleInput(btn) {
  btn.disabled = true;
  const id = btn.dataset.dev;
  const layout = (inputsCat && inputsCat.layout) || {};
  const hidden = ((layout.hidden && layout.hidden.dev) || []).filter(x => x !== id);
  if (btn.classList.contains('good')) hidden.push(id);
  inputsSave({ hidden: { dev: hidden } });
}

function inputsNameKey(e, el) {
  if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); el.value = el.dataset.cur || ''; el.blur(); }
}

function inputsRename(el) {
  const id = el.dataset.devName;
  const cur = el.dataset.cur || '';
  const def = el.dataset.def || '';
  const raw = el.value.replace(/\s+/g, ' ').trim();
  const next = raw || def;
  if (next === cur) { el.value = cur; return; }
  el.dataset.cur = next;
  inputsSave({ deviceNames: { [id]: next === def ? '' : next } });
}

function renderInputsPreview(kind) {
  if (kind === 'inplg') {
    return `<span class="hm-s hm-s-inplg">
      <span class="hm-bar-scene"></span>
      <span class="hm-inplg-panel"><i class="on"></i><i></i><i></i><i></i></span>
    </span>`;
  }
  if (kind === 'inpbar') {
    return `<span class="hm-s hm-s-inpbar">
      <span class="hm-bar-scene"></span>
      <span class="hm-bar-shade"></span>
      <span class="hm-inpbar-row">
        <span class="hm-inpbar-tile focus now"><i></i><b></b></span>
        <span class="hm-inpbar-tile"><i></i><b></b></span>
        <span class="hm-inpbar-tile"><i></i><b></b></span>
      </span>
    </span>`;
  }
  if (kind === 'nslg') {
    return `<span class="hm-s hm-s-nslg">
      <span class="hm-nslg-box"><b>No Signal</b><i></i><i></i></span>
    </span>`;
  }
  if (kind === 'nsicon') {
    return `<span class="hm-s hm-s-nsicon">
      <svg class="hm-nsicon-svg" viewBox="0 0 128 64" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 32H34M42 26H34V38H42"/>
        <path d="M42 24L48 18H66V46H48L42 40Z"/>
        <path d="M52 24V40M57 24V40"/>
        <path d="M66 23H79V41H66M72.5 27.5V29.5M72.5 34.5V36.5"/>
        <path d="M95 12V23H108V41H95V52M101.5 28V36"/>
      </svg>
    </span>`;
  }
  return `<span class="hm-s hm-s-nsplain"><span class="hm-nsplain-txt">No Signal</span></span>`;
}

function setInputsCard(btn, kind, title, sub, active, disabled) {
  if (!btn) return;
  btn.className = 'hm-card' + (active ? ' on' : '');
  btn.disabled = !!disabled;
  btn.setAttribute('aria-pressed', String(!!active));
  const badge = active ? t('ss.inUse', 'In use') : '';
  btn.innerHTML = `<span class="hm-screen">
      ${renderInputsPreview(kind)}
      <span class="hm-badge"${badge ? '' : ' hidden'}>${esc(badge)}</span>
    </span>
    <span class="hm-meta">
      <span class="hm-name">${esc(title)}</span>
      <span class="hm-sub">${esc(sub)}</span>
    </span>`;
}

/*
 * The input bar: the Input key's choice between LG's list of inputs and the
 * bar, which is the remote key's setting, made here.
 */
function renderInputBar() {
  const grp = q('inputs-grp-bar');
  const rk = appsData && appsData.remoteKeys;
  const bar = inputsData && inputsData.inputBar;
  const opens = k => k.action === 'open' && k.id === INPUT_BAR;
  const input = rk && rk.keys && rk.keys.find(k => k.key === 'input');
  // Offered where the Input key can be set to it: not where it is untried and switched off.
  const offered = !!(rk && input && bar && (bar.allowed || opens(input)));
  grp.hidden = !offered;
  if (!offered) return false;
  const writable = !!(appsData.writable && inputsData.writable);
  const ours = opens(input), lg = input.action === 'lg';
  setInputsCard(q('inputs-bar-lg'), 'inplg', t('inputs.bar.lg', 'LG\u2019s list'),
    t('inputs.bar.isLg', 'LG\u2019s own list of inputs, as the TV came.'), lg, !writable);
  setInputsCard(q('inputs-bar-ours'), 'inpbar', t('apps.inputBar', 'Glasshouse Input bar'),
    t('inputs.bar.isOurs', 'Each press steps to the next input, and the TV switches a second after the last.'), ours, !writable);
  const note = q('inputs-bar-choice-note');
  note.hidden = lg || ours;
  note.textContent = lg || ours ? ''
    : t('inputs.bar.isOther', 'Set to something else on the Remote tab: {opens}.', { opens: input.opens || t('apps.remoteKeys.doesNothing', 'Does nothing') });
  const layout = (inputsCat && inputsCat.layout) || {};
  const transparent = layout.inputBarTransparent === true;
  q('inputs-bar-opts').innerHTML = `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('inputs.bar.transparent', 'Transparent tiles'))}</div>
      <div class="prot-desc">${esc(t('inputs.bar.transparentDesc', 'Lets the picture show through the bar\u2019s tiles.'))}</div></div>
    <div class="prot-status">${renderToggle({ id: 'inputs-bar-transparent', cls: transparent ? 'good' : 'idle', label: transparent ? t('common.on', 'On') : t('common.off', 'Off'),
      on: transparent, disabled: !writable, onclick: `inputsSave({ inputBarTransparent: ${transparent ? 'false' : 'true'} })` })}</div></div>`;
  return true;
}

async function setInputKey(ours) {
  q('inputs-bar-lg').disabled = q('inputs-bar-ours').disabled = true;
  try {
    await homePost('/api/remotekeys', ours ? { key: 'input', action: 'open', id: INPUT_BAR } : { key: 'input', action: 'lg' });
  } catch (e) { showErr(e.message); }
  await loadApps();
  loadInputs();
}

/*
 * LG's No Signal screen as just "No Signal": offered where the TV's own screen
 * is the one the server knows how to change.
 */
function renderNoSignal() {
  const grp = q('inputs-grp-nosignal');
  const ns = (inputsData && inputsData.noSignal) || {};
  grp.hidden = !ns.available;
  if (!ns.available) return false;
  const writable = !!(inputsData && inputsData.writable);
  const mode = ns.mode || (ns.on ? 'plain' : 'lg');
  setInputsCard(q('inputs-nosignal-lg'), 'nslg', t('inputs.noSignal.lg', 'LG\u2019s screen'),
    t('inputs.noSignal.lgDesc', 'Picture and advice with \u201cNo Signal\u201d.'), mode === 'lg', !writable);
  setInputsCard(q('inputs-nosignal-plain'), 'nsplain', t('ss.noSignal.plain', 'Just \u201cNo Signal\u201d'),
    t('ss.noSignal.desc', 'Leaves out the animated picture and the line of advice under it, so an input with nothing coming in shows only \u201cNo Signal\u201d.'), mode === 'plain', !writable);
  setInputsCard(q('inputs-nosignal-icon'), 'nsicon', t('inputs.noSignal.icon', 'Disconnected cable'),
    t('inputs.noSignal.iconDesc', 'Shows a subtle disconnected cable icon instead of \u201cNo Signal\u201d.'), mode === 'icon', !writable);
  const desc = q('inputs-nosignal-desc');
  desc.hidden = !ns.restartPending;
  desc.textContent = ns.restartPending
    ? t('ss.noSignal.pending', 'It takes effect once no input with a picture is on screen, such as at the Home screen.')
    : '';
  return true;
}

async function setNoSignal(mode) {
  const ns = (inputsData && inputsData.noSignal) || {};
  const cur = ns.mode || (ns.on ? 'plain' : 'lg');
  const next = mode === 'icon' || mode === 'plain' ? mode : 'lg';
  if (cur === next) return;
  q('inputs-nosignal-lg').disabled = q('inputs-nosignal-plain').disabled = q('inputs-nosignal-icon').disabled = true;
  await sendCommand('plainNoSignal', next);
  loadInputs();
}
