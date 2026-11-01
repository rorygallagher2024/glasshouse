// The Audio tab: LG's sound settings, what the TV and its receiver report, and
// the separately installed, version-locked DTS helper.
let audioState = null;
let audioTimer = null;
let audioRevision = 0;
// Paired Bluetooth audio devices, shown in this tab and in Control > Sound: read on
// opening either, and on Refresh, never polled.
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
let audioChanging = false;
let audioArmed = false;
let audioArmTimer = null;

function audioPolling(on) {
  clearTimeout(audioTimer);
  audioTimer = null;
  if (!on) {
    audioArmed = false;
    clearTimeout(audioArmTimer);
    return;
  }
  audioTimer = setTimeout(() => loadAudio(true), 8000);
}

// As the page's other error banners (.err-note): what failed in bold, then why.
function audioError(message) {
  const el = q('audio-error');
  el.innerHTML = message ? `<b>${esc(t('audio.readFailed', 'The TV’s sound settings and audio readings could not be read.'))}</b>${esc(sentence(message))}` : '';
  el.hidden = !message;
}

async function audioRequest(body) {
  const res = await fetch(api(body ? '/api/audio' : '/api/audio?with=settings'), body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : { cache: 'no-store' });
  const r = await res.json();
  if (!res.ok || !r || r.ok === false) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
  return r;
}

// A poll (fromPoll true) leaves the Refresh button and any shown error alone.
async function loadAudio(fromPoll) {
  if (audioChanging) return;
  clearTimeout(audioTimer);
  audioTimer = null;
  const revision = ++audioRevision;
  const refresh = q('audio-refresh');
  if (fromPoll !== true) refresh.disabled = true;
  try {
    const st = await audioRequest();
    if (revision !== audioRevision) return;
    audioState = st;
    q('audio-readings').hidden = false;
    renderAudio();
    renderAudioSettings(st.lgSettings || []);
    if (fromPoll !== true) {
      if (!audioChanging) audioError('');
      loadAudioBluetooth();
    }
  } catch (e) {
    if (revision === audioRevision) {
      audioState = null;
      audioArmed = false;
      clearTimeout(audioArmTimer);
      q('audio-override').disabled = true;
      q('audio-readings').hidden = true;
      q('audio-sound-head').hidden = true;
      q('audio-settings').innerHTML = '';
      audioError(e.message);
    }
  } finally {
    if (revision === audioRevision) {
      refresh.disabled = false;
      q('audio-readings').setAttribute('aria-busy', 'false');
      if (activeTab === 'audio') audioPolling(true);
    }
  }
}

function audioDeclaration(value) {
  return value === true ? t('audio.advertised', 'Advertised') :
    value === false ? t('audio.notAdvertised', 'Not advertised') : t('audio.unknown', 'Unknown');
}

function renderAudio() {
  const st = audioState;
  if (!st) return;
  const tv = st.tv;
  const receiver = st.receiver;
  const dts = tv.formats.find(f => f.id === 'dts');
  const summary = dts.advertised === true
    ? t('audio.dtsAdvertised', 'This TV advertises DTS')
    : dts.advertised === false ? t('audio.dtsNotAdvertised', 'This TV does not advertise DTS')
    : t('audio.dtsUnknown', 'DTS advertisement is unknown');
  if (q('audio-summary').textContent !== summary) q('audio-summary').textContent = summary;
  q('audio-identity').textContent = [st.identity.model, st.identity.firmware,
    tv.dtsDecoder === true ? t('audio.decoderPresent', 'LG DTS decoder present') :
      tv.dtsDecoder === false ? t('audio.decoderAbsent', 'LG DTS-core decoder not registered') : null].filter(Boolean).join(' · ');
  const noInput = t('audio.noInput', 'No audio reported');
  const source = st.live.input;
  const sourceText = source ? [source.codec, source.sampleRate ? (source.sampleRate / 1000) + ' kHz' : null].filter(Boolean).join(' · ') : noInput;
  const linkText = receiver.link === 'inactive' ? t('audio.linkInactive', 'No active ARC link') :
    receiver.link === 'unknown' ? t('audio.linkUnknown', 'Link unknown') : receiver.link;
  const item = (label, value, detail) => '<li><div class="audio-label">' + esc(label) + '</div><div class="audio-value">' + esc(value) + '</div>' +
    (detail ? '<div class="prot-desc">' + esc(detail) + '</div>' : '') + '</li>';
  const metadata = st.live.hdmi;
  const metadataText = metadata ? [t('audio.channels', '{count} channels', { count: metadata.channels }),
    metadata.sampleRate ? (metadata.sampleRate / 1000) + ' kHz' : null].filter(Boolean).join(' · ') : '';
  q('audio-path').innerHTML =
    item(t('audio.inputNow', 'Incoming audio'), sourceText, '') +
    (metadata ? item(t('audio.hdmiChannels', 'HDMI channel information'), metadataText,
      t('audio.hdmiMetadataHint', 'Channel metadata reported by the HDMI source. It can remain during a pause and does not confirm playback at the receiver.')) : '') +
    item(t('audio.outputNow', 'Sound output'), st.outputName || t('audio.unknown', 'Unknown'), st.live.output || '') +
    item(t('audio.receiverNow', 'Return channel'), linkText, receiver.name || '');
  q('audio-formats').innerHTML = tv.formats.map(f => '<tr><th scope="row">' + esc(f.name) + '</th>' +
    '<td class="' + (f.advertised === true ? 'audio-yes' : '') + '">' + esc(audioDeclaration(f.advertised)) + '</td>' +
    '<td class="' + (f.receiver === true ? 'audio-yes' : '') + '">' + esc(audioDeclaration(f.receiver)) + '</td></tr>').join('');
  q('audio-link-note').textContent = !receiver.formatsKnown
    ? t('audio.receiverUnknown', 'Receiver formats are unknown until an ARC/eARC receiver reports them. A connected HDMI device alone does not establish a working audio link.')
    : t('audio.receiverKnown', 'These are the receiver’s declarations. DTS-HD needs eARC; DTS:X is not established by a DTS-HD entry. Receiver lock still needs a playback check.');
  if (tv.input) q('audio-link-note').textContent += ' ' + t('audio.inputDeclaration', 'The TV column describes HDMI {port}.', { port: tv.input });
  const declarations = tv.playbackDeclarations;
  const playbackNames = { AC3: 'Dolby Digital', EAC3: 'Dolby Digital Plus', DTSH: 'DTS-HD', DTSE: 'DTS Express', WMAP: 'WMA Pro', WMAL: 'WMA Lossless', OPUS: 'Opus' };
  q('audio-playback').innerHTML = declarations === null
    ? '<p class="sub">' + esc(t('audio.playbackUnknown', 'The TV did not expose a playback declaration list.')) + '</p>'
    : declarations.map(f => '<div><span>' + esc(playbackNames[f.name] || f.name) + '</span><span>' + esc(f.channels
      ? t('audio.channels', '{count} channels', { count: f.channels }) : t('audio.unknown', 'Unknown')) + '</span></div>').join('');
  renderAudioOverride();
}

// The sound rows, then each input's audio format, live from the same read.
function renderAudioSettings(rows) {
  const focused = document.activeElement && document.activeElement.closest('#audio-settings [data-lgs]');
  const focusedId = focused && focused.dataset.lgs;
  const selected = rows.filter(r => r.section === 'sound').concat(rows.filter(r => r.column === 'audioFormat'));
  q('audio-sound-head').hidden = !selected.length;
  q('audio-settings').innerHTML = selected.map(r =>
    lgsRow(r).replace(/<(select|button|input)\b/, '<$1 aria-label="' + esc(r.title) + '"')).join('');
  if (!audioState.writable) q('audio-settings').querySelectorAll('button,select,input').forEach(el => { el.disabled = true; });
  if (focusedId) {
    const next = q('audio-settings').querySelector('[data-lgs="' + focusedId + '"]');
    if (next && !next.disabled) next.focus({ preventScroll: true });
  }
}

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

function nativeDtsDescription(helper) {
  if (helper.active) {
    if (helper.hdCarrierActive) {
      if (helper.hdPayloadActive) return t('audio.nativeHdActive', 'DTS-HD forwarding is active. Complete DTS-HD MA or DTS:X frames are being sent over eARC. Check the receiver’s incoming format to confirm reception.');
      if (helper.hdReady && helper.stream && helper.stream.coreOnlyFrames > 0)
        return t('audio.nativeHdCore', 'The current stream is forwarding DTS core only.');
      return t('audio.nativeHdPreparing', 'Preparing DTS-HD output. Playback is muted while the output settles.');
    }
    return t('audio.overrideActive', 'The helper reports an active compressed forwarding route. Check the receiver’s incoming format to confirm DTS reception.');
  }
  if (helper.running) return (helper.mode === 'hd'
    ? t('audio.nativeHdWaiting', 'Enabled for TV apps with DTS-HD MA and DTS:X forwarding over eARC.')
    : t('audio.nativeWaiting', 'Enabled for TV apps using the shared audio pipeline. Forwards 48 kHz DTS core over eARC; DTS-HD extensions are not forwarded.')) +
    (helper.lastError ? ' ' + t('audio.nativeRefused', 'The last DTS stream was refused, so it did not play: {reason}', { reason: helper.lastError }) : '');
  return t('audio.overrideStopped', 'Enabled, but its service is not running. Disable the override before retrying.');
}

function renderAudioOverride() {
  const st = audioState;
  const helper = st.override;
  const on = helper.enabled || helper.running === true || helper.needsRestore === true;
  const btn = q('audio-override');
  q('audio-forwarding').hidden = !helper.offered;
  const dts = st.tv.formats.find(f => f.id === 'dts');
  btn.disabled = audioChanging || helper.busy || !st.writable || !(helper.available || helper.canDisable);
  btn.setAttribute('aria-pressed', String(on));
  btn.className = 'pill ' + (audioArmed ? 'warn' : on ? 'good' : 'idle');
  btn.textContent = audioChanging || helper.busy ? t('audio.changing', 'Changing…') : audioArmed ? t('audio.confirm', 'Press again to enable') :
    on ? t('audio.disable', 'Disable override') : helper.available ? t('audio.enable', 'Enable override') : t('audio.unavailable', 'Unavailable');
  q('audio-override-desc').textContent = on && !helper.verified ? helper.reason : helper.needsRestore
    ? t('audio.nativeRestore', 'A previous change needs restoration. Disable forwarding before enabling it again.') : on
    ? helper.backend === 'native-apps' ? nativeDtsDescription(helper)
      : helper.active ? t('audio.overrideActive', 'The helper reports an active compressed forwarding route. Check the receiver’s incoming format to confirm DTS reception.')
        : helper.running ? t('audio.overrideWaiting', 'Running and waiting for a matching DTS input on HDMI 3 over eARC.')
          : t('audio.overrideStopped', 'Enabled, but its service is not running. Disable the override before retrying.')
    : helper.available ? helper.backend === 'native-apps'
      ? helper.mode === 'hd'
        ? t('audio.nativeHdReady', 'Enable experimental DTS-HD MA and DTS:X forwarding for TV apps. Requires eARC, Pass Through and a DTS-HD receiver. Enabling restarts TV playback.')
        : t('audio.nativeReady', 'Enable DTS core forwarding for TV apps through the shared audio pipeline. Enabling restarts TV media playback. Requires eARC and Pass Through.')
      : t('audio.overrideReady', 'Experimental HDMI 3 to eARC forwarding is available with the checked helper. Changing it can briefly interrupt HDMI audio.')
      : dts && dts.advertised === true && st.tv.dtsDecoder === true
        ? t('audio.overrideNative', 'The TV already advertises DTS and has LG’s DTS decoder. Use its native audio settings first. No experimental forwarding profile is offered for this TV.')
        : helper.reason || t('audio.overrideUnknown', 'No validated DTS forwarding helper is available for this TV.');
}

async function audioOverride() {
  if (!audioState || audioChanging) return;
  const on = !(audioState.override.enabled || audioState.override.running === true || audioState.override.needsRestore === true);
  if (on && !audioArmed) {
    audioArmed = true;
    renderAudioOverride();
    clearTimeout(audioArmTimer);
    audioArmTimer = setTimeout(() => { audioArmed = false; if (audioState) renderAudioOverride(); }, 5000);
    return;
  }
  clearTimeout(audioArmTimer);
  audioArmed = false;
  audioChanging = true;
  // A read started before this write must not replace its confirmed result.
  ++audioRevision;
  clearTimeout(audioTimer);
  q('audio-refresh').disabled = true;
  renderAudioOverride();
  audioError('');
  try {
    const result = await audioRequest({ enabled: on });
    const writable = audioState.writable;
    audioState = result.status;
    audioState.writable = writable;
    renderAudio();
  } catch (e) { audioError(e.message); }
  finally { audioChanging = false; renderAudioOverride(); loadAudio(true); }
}
