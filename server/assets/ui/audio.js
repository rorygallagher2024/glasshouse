// The Audio tab: LG's sound settings, what the TV and its receiver report, and
// the separately installed, version-locked DTS helper.
let audioState = null;
let audioTimer = null;
let audioRevision = 0;
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
    if (fromPoll !== true && !audioChanging) audioError('');
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
