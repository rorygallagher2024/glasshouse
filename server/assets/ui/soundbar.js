let soundbarSelection = '';
let soundbarBusy = false;
let soundbarPendingKey = '';
const soundbarQueue = [];
let soundbarWritable = false;
let soundbarHost = null;
let soundbarStream = null;
let soundbarDevice = null;
let soundbarTVVolume = null;
let soundbarOnline = false;
let soundbarSchema = '';
let soundbarMessage = '';
// After a fault the stream is closed rather than left to EventSource's own
// 1.5 s retry, since each reconnect opens a socket from the TV to the bar.
let soundbarRetry = null;
let soundbarRetryDelay = 0;
let soundbarHalted = false;

function soundbarGroups() {
  return [
    [t('ctl.playback', 'Playback'), {
      i_curr_func: t('game.input', 'Input'), i_vol: t('audio.bar.volume', 'Soundbar volume'), b_mute: t('ctl.mute', 'Mute'),
      i_av_sync: t('audio.bar.delay', 'Audio delay (ms)')
    }],
    [t('audio.bar.processing', 'Sound processing'), {
      i_curr_eq: t('srv.lgs.soundMode', 'Sound mode'), b_night_time: t('audio.bar.night', 'Night mode'),
      b_auto_vol: t('audio.bar.autoVol', 'Auto volume'), b_drc: t('audio.bar.drc', 'Dynamic range control'), b_neuralx: 'DTS Neural:X'
    }],
    [t('audio.bar.levels', 'Speaker levels'), {
      i_woofer_level: t('audio.bar.woofer', 'Subwoofer'), i_center_level: t('audio.bar.center', 'Center level'),
      i_side_level: t('audio.bar.side', 'Side level'), i_top_level: t('audio.bar.height', 'Height level'),
      i_rear_level: t('audio.bar.rear', 'Rear level'), i_dialog_level: t('audio.bar.dialog', 'Dialogue level')
    }],
    [t('audio.bar.tone', 'Tone controls'), {
      i_bass: t('audio.bar.bass', 'Bass'), i_middle: t('audio.bar.mid', 'Midrange'), i_treble: t('audio.bar.treble', 'Treble')
    }],
    [t('audio.bar.device', 'Device settings'), {
      b_auto_power: t('audio.bar.autoPower', 'Auto power'), i_back_light: t('adv.display', 'Display'),
      b_voice_feedback: t('audio.bar.voice', 'Voice feedback')
    }]
  ];
}

function soundbarChoice(key, value) {
  if (typeof value === 'boolean') return value ? t('common.on', 'On') : t('common.off', 'Off');
  if (key === 'i_curr_eq') {
    const names = { 0: t('srv.lgs.soundMode.standard', 'Standard'), 6: t('srv.lgs.soundMode.music', 'Music'),
      7: t('srv.lgs.soundMode.movie', 'Cinema'), 14: 'Bass Blast', 15: 'Dolby Atmos', 17: 'Bass Blast+',
      18: 'DTS:X', 19: 'AI Sound Pro', 21: t('srv.lgs.soundMode.sports', 'Sports'),
      22: t('tab.game', 'Game'), 26: 'Clear Voice Pro' };
    return names[value] || t('audio.bar.modeId', 'Mode {id}', { id: value });
  }
  if (key === 'i_curr_func') {
    const names = { 0: 'Wi-Fi', 1: 'Bluetooth', 4: 'OPT', 6: 'HDMI', 7: 'ARC', 8: 'Spotify',
      10: 'HDMI 2', 11: 'HDMI 3', 12: 'LG TV', 14: 'Chromecast', 15: 'OPT / HDMI ARC', 18: 'USB', 20: 'HDMI eARC' };
    return names[value] || t('audio.bar.inputId', 'Input {id}', { id: value });
  }
  if (key === 'i_back_light') {
    return [t('audio.bar.dim', 'Auto dim'), t('audio.bar.autoOff', 'Auto off'), t('common.on', 'On')][value] ||
      t('audio.bar.modeId', 'Mode {id}', { id: value });
  }
  return String(value);
}

function soundbarControl(row, label) {
  const id = 'soundbar-' + row.key;
  const change = value => soundbarRequest({ action: 'set', id: soundbarSelection, key: row.key, value });
  if (row.options) {
    const select = document.createElement('select');
    select.id = id;
    select.className = 'pill-sel';
    const choices = row.options.includes(row.value) ? row.options : [row.value, ...row.options];
    for (const value of choices) {
      const option = new Option(soundbarChoice(row.key, value), String(value), false, value === row.value);
      option.disabled = !row.options.includes(value);
      select.add(option);
    }
    select.onchange = () => change(Number(select.value));
    return select;
  }
  if (typeof row.value === 'boolean') {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'pill pill-toggle ' + (row.value ? 'good' : 'idle');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(row.value));
    button.textContent = soundbarChoice(row.key, row.value);
    button.onclick = () => change(button.getAttribute('aria-pressed') !== 'true');
    return button;
  }
  const range = document.createElement('span');
  range.className = 'lgs-range soundbar-range';
  const slider = document.createElement('input');
  Object.assign(slider, { type: 'range', id, min: row.min, max: row.max, step: row.step, value: row.value });
  const value = document.createElement('span');
  value.className = 'num';
  value.setAttribute('aria-hidden', 'true');
  value.textContent = slider.value;
  slider.oninput = () => { value.textContent = slider.value; };
  slider.onchange = () => change(Number(slider.value));
  range.append(slider, value);
  return range;
}

function soundbarRows(rows) {
  const list = q('audio-bar-rows');
  const byKey = new Map(rows.map(row => [row.key, row]));
  list.replaceChildren();
  for (const [title, labels] of soundbarGroups()) {
    const keys = Object.keys(labels).filter(key => byKey.has(key));
    if (!keys.length) continue;
    const group = document.createElement('section');
    group.className = 'soundbar-group';
    const heading = document.createElement('h3');
    heading.id = 'soundbar-group-' + keys[0];
    heading.textContent = title;
    group.setAttribute('aria-labelledby', heading.id);
    group.appendChild(heading);
    for (const key of keys) {
      const item = document.createElement('div');
      item.className = 'soundbar-row';
      const label = document.createElement('label');
      label.htmlFor = 'soundbar-' + key;
      label.textContent = labels[key];
      const caption = document.createElement('div');
      caption.appendChild(label);
      if (key === 'i_vol') {
        const note = document.createElement('small');
        note.id = 'soundbar-tv-volume';
        note.hidden = true;
        caption.appendChild(note);
      }
      item.append(caption, soundbarControl(byKey.get(key), labels[key]));
      group.appendChild(item);
    }
    list.appendChild(group);
  }
}

function soundbarReason(reason) {
  switch (reason) {
    case 'address': return t('audio.bar.badAddress', 'Enter the local IPv4 address of the soundbar.');
    case 'identity': case 'model': return t('audio.bar.wrong', 'Check the address and reconnect the soundbar.');
    case 'busy': return t('srv.audio.override.busy', 'An audio change is still in progress.');
    case 'unconfirmed': case 'invalid': return t('audio.bar.check', 'The soundbar could not confirm this setting.');
    case 'disabled': return t('tv.audio.readOnly', 'TV controls are disabled in the server configuration.');
    case 'save': return t('audio.bar.saveError', 'Could not save the soundbar connection.');
    default: return t('audio.bar.offline', 'Could not read the soundbar. Check its power and IP address.');
  }
}

function soundbarOnArc(device) {
  const input = device?.rows.find(row => row.key === 'i_curr_func');
  // ARC, the shared optical/HDMI ARC input, and HDMI eARC.
  return [7, 15, 20].includes(input?.value);
}

function soundbarReceiveDevice(device) {
  if (!soundbarOnArc(device)) soundbarTVVolume = null;
  soundbarDevice = device;
}

function soundbarTVPlayback(stats) {
  if (!soundbarOnline || !soundbarOnArc(soundbarDevice)) return;
  const arc = stats.audio_output ? ['HDMI ARC', 'TV Speaker + HDMI ARC'].includes(stats.audio_output)
    : ['external_arc', 'ext_speaker_arc', 'tv_speaker_external_arc'].includes(stats.sound?.output_raw);
  const level = !stats.volume_control || stats.volume_control === 'level';
  const volume = arc && level && Number.isInteger(stats.volume) && stats.volume >= 0 && stats.volume <= 100
    ? stats.volume : null;
  if (volume !== soundbarTVVolume) {
    soundbarTVVolume = volume;
    soundbarRender();
  }
}

function soundbarRender() {
  const rows = soundbarDevice?.rows || [];
  const schema = JSON.stringify(rows.map(r => [r.key, typeof r.value, r.min, r.max, r.step, r.options,
    r.options && !r.options.includes(r.value) ? r.value : null]));
  if (schema !== soundbarSchema) {
    soundbarRows(rows);
    soundbarSchema = schema;
  }
  for (const row of rows) {
    const el = document.getElementById('soundbar-' + row.key);
    if (!el) continue;
    const value = row.value;
    if (row.key === 'i_vol') {
      const note = document.getElementById('soundbar-tv-volume');
      note.hidden = soundbarTVVolume === null || soundbarTVVolume === value || !soundbarOnline;
      note.textContent = note.hidden ? '' : t('audio.bar.tvVolume', 'TV-reported volume: {value}', { value: soundbarTVVolume });
    }
    const pending = row.key === soundbarPendingKey || soundbarQueue.some(change => change.key === row.key);
    if (typeof row.value === 'boolean') {
      el.setAttribute('aria-pressed', String(value));
      el.classList.toggle('good', value);
      el.classList.toggle('idle', !value);
      el.textContent = soundbarChoice(row.key, value);
    } else if (!pending && !el.matches('input:active')) {
      el.value = String(value);
      if (el.type === 'range') el.nextElementSibling.textContent = el.value;
    }
    el.disabled = !soundbarWritable || !soundbarOnline || pending || (soundbarBusy && !soundbarPendingKey);
  }
  q('audio-bar-host').disabled = !soundbarWritable;
  q('audio-bar-connect').disabled = q('audio-bar-forget').disabled = !soundbarWritable || soundbarBusy;
  q('audio-bar-refresh').disabled = soundbarBusy;
  q('audio-bar-forget').hidden = !soundbarSelection;
  const status = [soundbarDevice?.name, soundbarDevice?.model, soundbarMessage ||
    (soundbarHost !== null && !soundbarWritable && soundbarReason('disabled'))].filter(Boolean).join(' · ');
  if (q('audio-bar-status').textContent !== status) q('audio-bar-status').textContent = status;
}

function soundbarSelected(result) {
  if (typeof result.writable !== 'boolean') return;
  if (soundbarSelection !== result.id || soundbarHost !== result.host) {
    soundbarDevice = null;
    soundbarTVVolume = null;
    soundbarQueue.length = 0;
    soundbarOnline = false;
    q('audio-bar-host').value = result.host;
  }
  soundbarSelection = result.id;
  soundbarHost = result.host;
  soundbarWritable = result.writable;
}

function soundbarClose() {
  soundbarStream?.close();
  soundbarStream = null;
  soundbarTVVolume = null;
  soundbarQueue.length = 0;
  soundbarOnline = false;
}

function soundbarViewChanged() {
  if (activeTab !== 'audio' || !q('audio-bar').open || document.hidden) return soundbarClose();
  if (soundbarStream || soundbarRetry || soundbarHalted) return;
  const stream = new EventSource(api('/api/audio/soundbar/events'));
  soundbarStream = stream;
  soundbarMessage = t('tv.loading', 'Loading…');
  soundbarRender();
  stream.addEventListener('selection', event => {
    if (stream !== soundbarStream) return;
    soundbarSelected(JSON.parse(event.data));
    if (!soundbarSelection) { soundbarClose(); soundbarMessage = ''; }
    soundbarRender();
  });
  stream.onmessage = event => {
    if (stream !== soundbarStream) return;
    const device = JSON.parse(event.data);
    if (device.id !== soundbarSelection || device.host !== soundbarHost) return;
    if (!soundbarOnline) soundbarMessage = '';
    soundbarRetryDelay = 0;
    soundbarReceiveDevice(device);
    soundbarOnline = true;
    soundbarRender();
  };
  function lost(reason) {
    if (stream !== soundbarStream) return;
    soundbarQueue.length = 0;
    soundbarTVVolume = null;
    soundbarOnline = false;
    soundbarMessage = soundbarReason(reason);
    soundbarRender();
  }
  stream.addEventListener('fault', event => {
    if (stream !== soundbarStream) return;
    const reason = JSON.parse(event.data);
    lost(reason);
    soundbarClose();
    // Another dashboard chose a different bar: read the new selection now.
    if (reason === 'selection') return soundbarViewChanged();
    // Retrying cannot fix these. Refresh or Connect opens the stream again.
    if (['identity', 'model', 'address'].includes(reason)) {
      soundbarHalted = true;
      return;
    }
    soundbarRetryDelay = Math.min(60000, soundbarRetryDelay ? soundbarRetryDelay * 2 : 5000);
    soundbarRetry = setTimeout(() => {
      soundbarRetry = null;
      soundbarViewChanged();
    }, soundbarRetryDelay);
  });
  stream.onerror = () => { if (soundbarOnline || !soundbarMessage || soundbarMessage === t('tv.loading', 'Loading…')) lost('offline'); };
}

document.addEventListener('visibilitychange', soundbarViewChanged);
window.addEventListener('pagehide', soundbarClose);
window.addEventListener('pageshow', soundbarViewChanged);

async function soundbarRequest(body) {
  if (soundbarBusy) {
    if (soundbarPendingKey && body?.action === 'set') {
      soundbarQueue.push(body);
      soundbarRender();
    }
    return;
  }
  soundbarBusy = true;
  soundbarPendingKey = body?.action === 'set' ? body.key : '';
  const previous = soundbarDevice;
  soundbarMessage = body ? t('audio.changing', 'Changing…') : t('tv.loading', 'Loading…');
  const focusKey = body?.action === 'set' && body.key;
  soundbarRender();
  try {
    const response = await fetch(api('/api/audio/soundbar'), body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : { cache: 'no-store' });
    const result = await response.json();
    soundbarSelected(result);
    if (result.device && result.device.id === soundbarSelection && result.device.host === soundbarHost &&
        (!soundbarDevice || soundbarDevice === previous || !soundbarStream)) {
      soundbarReceiveDevice(result.device);
      if (result.ok || !soundbarStream) soundbarOnline = true;
    }
    if (!response.ok || !result.ok) throw new Error(result.error || soundbarReason(result.reason));
    soundbarMessage = '';
    // The bar answered, so a stream held back after a fault can open now.
    clearTimeout(soundbarRetry);
    soundbarRetry = null;
    soundbarHalted = false;
    if (body?.action === 'connect' || body?.action === 'forget') soundbarClose();
    if (soundbarSelection) soundbarViewChanged();
  } catch (err) {
    soundbarMessage = err.message;
  } finally {
    soundbarBusy = false;
    soundbarPendingKey = '';
    soundbarRender();
    if (focusKey && document.activeElement === document.body) {
      document.getElementById('soundbar-' + focusKey)?.focus({ preventScroll: true });
    }
    if (soundbarQueue.length) soundbarRequest(soundbarQueue.shift());
  }
}

function soundbarConnect() {
  soundbarRequest({ action: 'connect', host: q('audio-bar-host').value.trim(), id: soundbarSelection });
}
function soundbarForget() {
  soundbarRequest({ action: 'forget', id: soundbarSelection });
}
