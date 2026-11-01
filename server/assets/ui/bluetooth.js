// Bluetooth audio: the paired headphones and speakers on the Audio tab and in
// Control > Sound, finding and pairing new ones, and removing them.

// Read on opening either view and on Refresh; re-read only while a scan or request is followed.
let audioBt = null;
let audioBtRevision = 0;
let audioBtBusy = null;   // { address, action } while a connect or disconnect runs
let audioBtLoading = false;
let audioBtSelected = null;   // the address chosen in Control > Sound
// After a request the TV has taken but not finished: { address, action, name, since }.
// LG reports "connecting" for over 12 s before giving up on a device that is off (B8).
let audioBtFollow = null;
let audioBtFollowTimer = null;
let audioBtScanned = false;
const AUDIO_BT_RECHECK_MS = 2000;
const AUDIO_BT_FOLLOW_MS = 40000;

function audioBtError(message) {
  for (const id of ['audio-bt-error', 'sound-bt-error']) {
    const el = q(id);
    el.innerHTML = message ? `<b>${esc(t('audio.bt.failed', 'The Bluetooth request did not work.'))}</b>${esc(sentence(message))}` : '';
    el.hidden = !message;
  }
}

function audioBtNote(text) {
  q('audio-bt-note').textContent = text;
  q('sound-bt-note').textContent = text;
  q('sound-bt-note').hidden = !text;
}

// Both views' Refresh buttons and busy markers follow one working state. Disabling the
// focused Refresh drops focus, so it is given back when the work ends.
let audioBtRefocusId = null;
function audioBtWorking(on) {
  const active = document.activeElement;
  if (on && active && /^(audio|sound)-bt-refresh$/.test(active.id)) audioBtRefocusId = active.id;
  for (const id of ['audio-bt-refresh', 'sound-bt-refresh']) q(id).disabled = on;
  for (const id of ['audio-bt-list', 'sound-bt-pick']) q(id).setAttribute('aria-busy', String(on));
  if (!on && audioBtRefocusId) {
    if (document.activeElement === document.body) q(audioBtRefocusId).focus({ preventScroll: true });
    audioBtRefocusId = null;
  }
}

// Control > Sound reads the list when it is opened: on showing the tab with it open, or on opening it.
function loadControlBluetooth() {
  if (activeTab === 'control' && q('disc-sound').open) loadAudioBluetooth();
}

// quiet: a background re-read while a scan or request is followed, which must not
// grey the buttons for the moment it takes, or a click then does nothing.
async function loadAudioBluetooth(quiet) {
  if (audioBtBusy) return;
  quiet = quiet === true;
  const revision = ++audioBtRevision;
  if (!quiet) {
    audioBtLoading = true;
    audioBtWorking(true);
    if (!audioBtFollow) audioBtNote('');
    if (audioBt) renderAudioBluetooth();
  }
  try {
    const res = await fetch(api('/api/audio/bluetooth'), { cache: 'no-store' });
    const r = await res.json();
    if (revision !== audioBtRevision) return;
    if (!res.ok || !r || r.ok === false) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
    audioBt = r;
    audioBtError('');
  } catch (e) {
    if (revision !== audioBtRevision) return;
    audioBt = { available: true, writable: false, devices: [] };
    audioBtError(e.message);
  }
  if (!quiet) {
    audioBtLoading = false;
    audioBtWorking(false);
  }
  audioBtCheckFollow();
  renderAudioBluetooth();
  audioBtRecheck();
}

// Refresh pressed: a read can finish in a few ms, so the buttons say so for a moment.
async function audioBtRefresh() {
  const ids = ['audio-bt-refresh', 'sound-bt-refresh'];
  for (const id of ids) q(id).textContent = t('audio.bt.refreshing', 'Refreshing…');
  await Promise.all([loadAudioBluetooth(), new Promise(r => setTimeout(r, 600))]);
  for (const id of ids) q(id).textContent = t('audio.refresh', 'Refresh');
}

// Reads again while a scan runs or a request is still settling.
function audioBtRecheck() {
  clearTimeout(audioBtFollowTimer);
  audioBtFollowTimer = null;
  const scanning = !!(audioBt && audioBt.scan && audioBt.scan.running);
  if (scanning || audioBtFollow) audioBtFollowTimer = setTimeout(() => loadAudioBluetooth(true), AUDIO_BT_RECHECK_MS);
}

function audioBtCheckFollow() {
  const f = audioBtFollow;
  if (!f || !audioBt) return;
  const d = audioBt.devices.find(x => x.address === f.address);
  const wanted = f.action === 'disconnect' ? 'disconnected' : 'connected';
  const waited = Date.now() - f.since;
  if (f.action === 'remove' ? !d : d && d.state === wanted) {
    audioBtFollow = null;
    audioBtNote('');
    // A device just paired leaves the scan's list, which would then read as finding nothing.
    if (f.action === 'pair') audioBtScanned = false;
    loadAudio(true);
    return;
  }
  const gaveUp = (f.action === 'connect' || f.action === 'pair') && d && d.state === 'disconnected' && waited > 6000;
  if (!gaveUp && waited < AUDIO_BT_FOLLOW_MS) return;
  audioBtFollow = null;
  audioBtNote('');
  audioBtError(f.action === 'pair'
    ? t('audio.bt.pairFailed', 'Couldn’t pair with {name}. Check it is still in pairing mode and nearby, then find devices again.', { name: f.name })
    : f.action === 'connect'
      ? t('audio.bt.connectFailed', 'Couldn’t connect to {name}. Check it is switched on and nearby.', { name: f.name })
      : f.action === 'remove'
        ? t('audio.bt.removeSlow', '{name} is still paired. Refresh to check again.', { name: f.name })
        : t('audio.bt.disconnectSlow', '{name} has not disconnected yet. Refresh to check again.', { name: f.name }));
}

async function audioBtScan() {
  if (audioBtBusy || audioBtFollow || (audioBt && audioBt.scan && audioBt.scan.running)) return;
  audioBtError('');
  audioBtScanned = true;
  if (audioBt) audioBt.scan = { running: true, found: [], error: '' };
  renderAudioBluetooth();
  try {
    const res = await fetch(api('/api/audio/bluetooth'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'scan' })
    });
    const r = await res.json();
    if (!r || !r.ok) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
    if (Array.isArray(r.devices)) audioBt.devices = r.devices;
    audioBt.scan = r.scan;
  } catch (e) {
    if (audioBt) audioBt.scan = { running: false, found: [], error: '' };
    audioBtError(e.message);
  }
  renderAudioBluetooth();
  audioBtRecheck();
}

function renderAudioBluetoothScan(idle) {
  const scan = audioBt.scan || { running: false, found: [], error: '' };
  const btn = q('audio-bt-scan-btn');
  btn.textContent = scan.running ? t('audio.bt.finding', 'Searching…') : t('audio.bt.find', 'Find devices');
  btn.disabled = !idle || scan.running;
  btn.hidden = audioBt.writable !== true;
  q('audio-bt-scan').hidden = !audioBtScanned && !scan.running && !scan.found.length;
  q('audio-bt-scan').classList.toggle('none', !scan.found.length);
  q('audio-bt-scan-note').textContent = scan.running
    ? t('audio.bt.searching', 'Looking for speakers and headphones in pairing mode…')
    : scan.error ? t('audio.bt.scanFailed', 'The TV could not search for devices: {error}', { error: scan.error })
    : scan.found.length ? t('audio.bt.foundNote', 'Found nearby. Pair one to add it and switch the sound to it.')
    : t('audio.bt.noneFound', 'No new devices found. Put the speaker or headphones in pairing mode, then find devices again.');
  q('audio-bt-found').innerHTML = scan.found.map(d => {
    const name = d.name || t('audio.bt.unnamed', 'Unnamed device');
    const doing = audioBtBusy && audioBtBusy.address === d.address;
    const label = doing ? t('audio.bt.pairing', 'Pairing…') : t('audio.bt.pair', 'Pair');
    return '<div class="prot-row"><div class="prot-main"><div class="prot-title">' + esc(name) + '</div>' +
      '<div class="prot-desc">' + esc(t('audio.bt.notPaired', 'Not paired')) + '</div></div>' +
      `<div class="prot-status"><button type="button" class="pill ${doing ? 'busy' : 'good'}" data-bt-address="${esc(d.address)}" data-bt-action="pair"` +
      ` data-bt-name="${esc(name)}" aria-label="${esc(t('audio.bt.actionFor', '{action}: {name}', { action: label, name }))}"` +
      `${idle ? '' : ' disabled'}>${esc(label)}</button></div></div>`;
  }).join('');
}

function audioBtStateLabel(state) {
  return state === 'connected' ? t('audio.bt.connected', 'Connected')
    : state === 'disconnected' ? t('audio.bt.disconnected', 'Not connected')
    : state === 'connecting' ? t('audio.bt.connecting', 'Connecting…')
    : t('audio.unknown', 'Unknown');
}

function renderAudioBluetooth() {
  if (!audioBt) return;
  // A TV without the service has nothing to show; one whose read failed keeps the section for its error.
  q('audio-bt').hidden = audioBt.available === false;
  q('sound-bt-set').hidden = audioBt.available === false;
  const focused = document.activeElement && document.activeElement.closest('#audio-bt-list [data-bt-address]');
  const focusedAddress = focused && focused.dataset.btAddress;
  const writable = audioBt.writable === true;
  const idle = writable && !audioBtBusy && !audioBtLoading && !audioBtFollow;
  q('audio-bt-list').innerHTML = audioBt.devices.map(d => {
    const name = d.name || t('audio.bt.unnamed', 'Unnamed device');
    const doing = audioBtBusy && audioBtBusy.address === d.address ? audioBtBusy.action : null;
    const action = d.state === 'connected' ? 'disconnect' : d.state === 'disconnected' ? 'connect' : null;
    const label = doing === 'connect' ? t('audio.bt.connecting', 'Connecting…')
      : doing === 'disconnect' ? t('audio.bt.disconnecting', 'Disconnecting…')
      : action === 'connect' ? t('audio.bt.connect', 'Connect') : t('audio.bt.disconnect', 'Disconnect');
    const button = action
      ? `<button type="button" class="pill ${doing === action ? 'busy' : action === 'connect' ? 'good' : 'idle'}" data-bt-address="${esc(d.address)}" data-bt-action="${action}"` +
        ` aria-label="${esc(t('audio.bt.actionFor', '{action}: {name}', { action: label, name }))}"` +
        `${idle ? '' : ' disabled'}>${esc(label)}</button>`
      : '';
    const removeLabel = doing === 'remove' ? t('audio.bt.removing', 'Removing…') : t('audio.bt.remove', 'Remove');
    const remove = `<button type="button" class="pill ${doing === 'remove' ? 'busy' : 'bad'}" data-bt-address="${esc(d.address)}" data-bt-action="remove"` +
      ` data-bt-name="${esc(name)}" aria-label="${esc(t('audio.bt.actionFor', '{action}: {name}', { action: removeLabel, name }))}"` +
      `${idle ? '' : ' disabled'}>${esc(removeLabel)}</button>`;
    return '<div class="prot-row"><div class="prot-main"><div class="prot-title">' + esc(name) + '</div>' +
      '<div class="prot-desc">' + esc(audioBtStateLabel(d.state)) + '</div></div>' +
      '<div class="prot-status">' + button + remove + '</div></div>';
  }).join('') || (audioBt.available === false || q('audio-bt-error').hidden === false ? '' :
    '<div class="prot-row"><div class="prot-main"><div class="prot-desc">' +
    esc(t('audio.bt.none', 'No paired Bluetooth audio devices.')) + '</div></div></div>');
  if (focusedAddress) {
    const next = q('audio-bt-list').querySelector('[data-bt-address="' + focusedAddress + '"]');
    if (next && !next.disabled) next.focus({ preventScroll: true });
  }
  renderAudioBluetoothScan(idle);
  renderSoundBluetooth(idle);
}

// The chooser in Control > Sound. Choosing a device only selects it: the button acts on it.
function renderSoundBluetooth(idle) {
  const devices = audioBt.devices;
  const select = q('sound-bt-select');
  if (!devices.some(d => d.address === audioBtSelected)) {
    const preferred = devices.find(d => d.state === 'connected') || devices[0];
    audioBtSelected = preferred ? preferred.address : null;
  }
  select.innerHTML = devices.map(d =>
    `<option value="${esc(d.address)}"${d.address === audioBtSelected ? ' selected' : ''}>` +
    esc(t('audio.bt.option', '{name} · {state}', { name: d.name || t('audio.bt.unnamed', 'Unnamed device'), state: audioBtStateLabel(d.state) })) +
    '</option>').join('') ||
    `<option value="">${esc(q('sound-bt-error').hidden ? t('audio.bt.none', 'No paired Bluetooth audio devices.') : '—')}</option>`;
  select.value = audioBtSelected || '';
  select.disabled = !idle || !devices.length;
  const chosen = devices.find(d => d.address === audioBtSelected);
  const action = q('sound-bt-action');
  const act = chosen && chosen.state === 'connected' ? 'disconnect' : chosen && chosen.state === 'disconnected' ? 'connect' : null;
  const doing = chosen && audioBtBusy && audioBtBusy.address === chosen.address ? audioBtBusy.action : null;
  action.hidden = !act;
  if (!act) return;
  const label = doing === 'connect' ? t('audio.bt.connecting', 'Connecting…')
    : doing === 'disconnect' ? t('audio.bt.disconnecting', 'Disconnecting…')
    : act === 'connect' ? t('audio.bt.connect', 'Connect') : t('audio.bt.disconnect', 'Disconnect');
  action.textContent = label;
  action.className = doing ? 'busy' : '';
  action.dataset.btAddress = chosen.address;
  action.dataset.btAction = act;
  action.setAttribute('aria-label', t('audio.bt.actionFor', '{action}: {name}',
    { action: label, name: chosen.name || t('audio.bt.unnamed', 'Unnamed device') }));
  action.disabled = !idle;
}

// The TV's reply is not taken as the result: the server reads the list again,
// and the state in it is what the row shows.
async function audioBluetoothAct(address, action, foundName) {
  if (audioBtBusy || audioBtFollow) return;
  const other = audioBt.devices.find(d => d.address !== address && d.state === 'connected');
  if (action === 'remove' && !confirm(t('audio.bt.removeConfirm',
    'Remove {name} from the TV? It will need pairing again before it can be used.', { name: foundName || t('audio.bt.unnamed', 'Unnamed device') }))) return;
  if ((action === 'connect' || action === 'pair') && other && !confirm(t('audio.bt.switchConfirm',
    'Connecting another device may disconnect {name} and change the sound output. Continue?',
    { name: other.name || t('audio.bt.unnamed', 'Unnamed device') }))) return;
  const fromControl = !!(document.activeElement && document.activeElement.closest('#sound-bt-set'));
  audioBtBusy = { address, action };
  audioBtLoading = false;
  ++audioBtRevision;  // Ignore any list read that started before this action.
  audioBtWorking(true);
  audioBtError('');
  audioBtNote(t('audio.bt.waiting', 'Waiting for the TV…'));
  renderAudioBluetooth();
  let error = null;
  let note = '';
  const known = audioBt.devices.find(x => x.address === address);
  const name = (known && known.name) || foundName || t('audio.bt.unnamed', 'Unnamed device');
  try {
    const res = await fetch(api('/api/audio/bluetooth'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, address })
    });
    const r = await res.json();
    if (r && Array.isArray(r.devices)) audioBt.devices = r.devices;
    if (!r || !r.ok) error = (r && r.error) || t('common.unknownError', 'unknown error');
    else if (!r.settled) {
      audioBtFollow = { address, action, name, since: Date.now() };
      note = action === 'pair' ? t('audio.bt.pairWait', 'Pairing with {name}…', { name })
        : action === 'remove' ? t('audio.bt.removeWait', 'Removing {name}…', { name })
        : action === 'connect' ? t('audio.bt.connectWait', 'Connecting to {name}…', { name })
        : t('audio.bt.disconnectWait', 'Disconnecting {name}…', { name });
    }
    if (action === 'pair' && audioBt.scan) audioBt.scan.running = false;
    if (action === 'pair' && r && r.ok && r.settled) audioBtScanned = false;
  } catch (e) {
    error = e.message;
  }
  audioBtBusy = null;
  audioBtWorking(false);
  if (error) audioBtError(error);
  audioBtNote(note);
  renderAudioBluetooth();
  const next = fromControl ? q('sound-bt-action') : q('audio-bt-list').querySelector('[data-bt-address="' + address + '"]');
  if (next && !next.disabled && !next.hidden) next.focus({ preventScroll: true });
  audioBtRecheck();
  // A connection can change the sound output shown above.
  if (!audioBtFollow) loadAudio(true);
}

document.addEventListener('click', e => {
  const b = e.target.closest('#audio-bt-list button[data-bt-action], #audio-bt-found button[data-bt-action], #sound-bt-action');
  if (b && !b.disabled && b.dataset.btAction) audioBluetoothAct(b.dataset.btAddress, b.dataset.btAction, b.dataset.btName);
});

document.addEventListener('change', e => {
  if (e.target.id !== 'sound-bt-select' || !audioBt) return;
  audioBtSelected = e.target.value;
  renderAudioBluetooth();
});

q('disc-sound').addEventListener('toggle', loadControlBluetooth);
