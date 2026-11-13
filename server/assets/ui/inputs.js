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
  const order = cat ? ((cat.order && cat.order.dev) || (cat.devices || []).map(d => d.id)).filter(id => byId[id] && !byId[id].tuner) : [];
  grp.hidden = !order.length;
  if (!order.length) return false;
  const writable = !!(inputsData && inputsData.writable);
  const layout = cat.layout || {};
  const hidden = (layout.hidden && layout.hidden.dev) || [];
  const pill = (on, label, attrs) => `<button type="button" class="pill ${on ? 'good' : 'idle'}" ${writable ? '' : 'disabled'} ${attrs}>${esc(label)}</button>`;
  const rows = order.map(id => {
    const d = byId[id], isShown = hidden.indexOf(id) === -1;
    return `<div class="prot-row"><div class="prot-main">
        <div class="prot-title" translate="no">${esc(d.name)}</div>
        <div class="prot-desc">${esc(t('home.dev.port', 'HDMI {port}', { port: d.port }))}${d.unused ? ' · ' + esc(t('home.dev.unused', 'Nothing connected')) : ''}</div></div>
      <div class="prot-status">${pill(isShown, isShown ? t('home.shown', 'Shown') : t('home.hidden', 'Hidden'),
        `data-dev="${esc(id)}" onclick="inputsToggleInput(this)"`)}</div></div>`;
  });
  const unusedOff = layout.hideUnused === true;
  rows.push(`<div class="prot-row"><div class="prot-main">
      <div class="prot-title">${esc(t('apps.inputBar.hideUnused', 'Hide inputs with nothing connected'))}</div></div>
    <div class="prot-status">${pill(unusedOff, unusedOff ? t('common.on', 'On') : t('common.off', 'Off'),
      `onclick="inputsSave({ hideUnused: ${unusedOff ? 'false' : 'true'} })"`)}</div></div>`);
  q('inputs-list').innerHTML = rows.join('');
  return true;
}

async function inputsSave(patch) {
  inputsSaving = true;
  try { await homePost('/api/home/layout', patch); } catch (e) { showErr(e.message); }
  inputsSaving = false;
  loadInputs();
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
