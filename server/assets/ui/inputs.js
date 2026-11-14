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
  const shown = [renderInputList(), renderInputBar(), renderNoSignal()];
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
  grp.hidden = !order.length;
  if (!order.length) return false;
  const writable = !!(inputsData && inputsData.writable);
  const layout = cat.layout || {};
  const hidden = (layout.hidden && layout.hidden.dev) || [];
  const unusedOff = layout.hideUnused === true;
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
  const rows = order.map((id, i) => {
    const d = byId[id], isShown = hidden.indexOf(id) === -1;
    const leftOut = !!(d.unused && unusedOff);
    const sub = d.tuner
      ? t('ctl.liveTv', 'Live TV')
      : (d.via ? t('home.dev.through', 'HDMI {port}, through {via}', { port: d.port, via: d.via }) : t('home.dev.port', 'HDMI {port}', { port: d.port }))
        + (d.unused ? ' · ' + t('home.dev.unused', 'Nothing connected') : '');
    return `<div class="prot-row home-tile${!isShown || leftOut ? ' home-hidden' : ''}"><div class="prot-main">
        <div class="prot-title" translate="no">${esc(d.name)}</div>
        <div class="prot-desc">${esc(sub)}</div></div>
      <div class="prot-status">
        ${leftOut ? `<span class="pill idle">${esc(t('home.leftOut', 'Left out'))}</span>` : ''}
        <button type="button" class="pill idle home-move" ${movable && i > 0 ? '' : 'disabled'} onclick="inputsMove(${i}, -1)" aria-label="${esc(t('home.earlier', 'Earlier'))}">↑</button>
        <button type="button" class="pill idle home-move" ${movable && i < order.length - 1 ? '' : 'disabled'} onclick="inputsMove(${i}, 1)" aria-label="${esc(t('home.later', 'Later'))}">↓</button>
        <button type="button" class="pill ${isShown ? 'good' : 'idle'}" ${writable ? '' : 'disabled'} data-dev="${esc(id)}" onclick="inputsToggleInput(this)">${esc(isShown ? t('home.shown', 'Shown') : t('home.hidden', 'Hidden'))}</button>
      </div></div>`;
  });
  q('inputs-list').innerHTML = [sortRow, unusedRow].concat(rows).join('');
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

// From the input bar's row to where its key is set.
function openRemoteKeys() {
  showTab('remote');
  const keys = q('disc-remotekeys');
  keys.open = true;
  keys.scrollIntoView({ block: 'start' });
}

/*
 * The input bar: the Input key's choice between LG's list of inputs and the
 * bar, which is the remote key's setting, made here; any other key is pointed
 * at the bar on the Remote tab.
 */
function renderInputBar() {
  const grp = q('inputs-grp-bar');
  const rk = appsData && appsData.remoteKeys;
  const bar = inputsData && inputsData.inputBar;
  // Offered where a key can be set to it: not where it is untried and switched off.
  const offered = !!(rk && bar && (bar.allowed || rk.keys.some(k => k.id === INPUT_BAR)));
  grp.hidden = !offered;
  if (!offered) return false;
  const opens = k => k.action === 'open' && k.id === INPUT_BAR;
  const input = rk.keys.find(k => k.key === 'input');
  const writable = !!(appsData.writable && inputsData.writable);
  // A TV whose Input key cannot be set has only the other keys' row.
  q('inputs-bar-choice').hidden = !input;
  if (input) {
    const ours = opens(input), lg = input.action === 'lg';
    q('inputs-bar-lg').className = 'pill ' + (lg ? 'good' : 'idle');
    q('inputs-bar-ours').className = 'pill ' + (ours ? 'good' : 'idle');
    q('inputs-bar-lg').disabled = q('inputs-bar-ours').disabled = !writable;
    q('inputs-bar-lg').setAttribute('aria-pressed', String(lg));
    q('inputs-bar-ours').setAttribute('aria-pressed', String(ours));
    q('inputs-bar-choice-note').textContent = ours
      ? t('inputs.bar.isOurs', 'Each press steps to the next input, and the TV switches a second after the last.')
      : lg ? t('inputs.bar.isLg', 'LG\u2019s own list of inputs, as the TV came.')
      : t('inputs.bar.isOther', 'Set to something else on the Remote tab: {opens}.', { opens: input.opens || t('apps.remoteKeys.doesNothing', 'Does nothing') });
  }
  const others = rk.keys.filter(k => k.key !== 'input' && opens(k)).map(k => k.title || k.key);
  q('inputs-bar-note').textContent = others.length
    ? t('inputs.bar.alsoBy', 'Also opened by {keys}. Any key can be set to Input bar under Remote keys.', { keys: others.join(', ') })
    : t('inputs.bar.anyKey', 'Any other key can open it too: set it to Input bar under Remote keys.');
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
  q('inputs-nosignal-desc').textContent = ns.restartPending
    ? t('ss.noSignal.pending', 'It takes effect once no input with a picture is on screen, such as at the Home screen.')
    : t('ss.noSignal.desc', 'Leaves out the animated picture and the line of advice under it, so an input with nothing coming in shows only \u201cNo Signal\u201d.');
  updateToggle('inputs-nosignal-btn', {
    cls: ns.on ? 'good' : 'idle',
    label: ns.on ? t('common.on', 'On') : t('common.off', 'Off'),
    on: !!ns.on,
    disabled: !inputsData.writable
  });
  return true;
}

async function toggleNoSignal() {
  const b = q('inputs-nosignal-btn');
  b.disabled = true;
  await sendCommand('plainNoSignal', !b.dataset.on);
  loadInputs();
}
