// A soundbar is contacted when its section opens, on Refresh and after a change.
let soundbarSelection = '';
let soundbarBusy = false;
let soundbarWritable = false;

function soundbarLabels() {
  return {
    i_vol: t('ctl.volume', 'Volume'), b_mute: t('ctl.mute', 'Mute'),
    i_curr_eq: t('srv.lgs.soundMode', 'Sound mode'), i_curr_func: t('game.input', 'Input'),
    b_night_time: t('audio.bar.night', 'Night mode'), i_woofer_level: t('audio.bar.woofer', 'Subwoofer'),
    i_center_level: t('audio.bar.center', 'Center level'), i_top_level: t('audio.bar.height', 'Height level'),
    i_side_level: t('audio.bar.side', 'Side level'), i_rear_level: t('audio.bar.rear', 'Rear level'),
    i_dialog_level: t('audio.bar.dialog', 'Dialogue level'), i_bass: t('audio.bar.bass', 'Bass'),
    i_middle: t('audio.bar.mid', 'Midrange'), i_treble: t('audio.bar.treble', 'Treble'),
    b_drc: t('audio.bar.drc', 'Dynamic range control'), b_auto_vol: t('audio.bar.autoVol', 'Auto volume'),
    b_auto_power: t('audio.bar.autoPower', 'Auto power'), b_voice_feedback: t('audio.bar.voice', 'Voice feedback'),
    b_neuralx: 'DTS Neural:X', i_av_sync: t('audio.bar.delay', 'Audio delay (ms)'),
    i_back_light: t('adv.display', 'Display')
  };
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
  if (key === 'i_back_light') return [t('audio.bar.dim', 'Auto dim'), t('audio.bar.autoOff', 'Auto off'), t('common.on', 'On')][value];
  return String(value);
}

function soundbarRows(rows) {
  const labels = soundbarLabels();
  const list = q('audio-bar-rows');
  list.replaceChildren();
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'prot-row';
    const label = document.createElement('label');
    label.className = 'prot-main prot-title';
    label.textContent = labels[row.key];
    const select = document.createElement('select');
    select.className = 'pill-sel';
    label.htmlFor = select.id = 'soundbar-' + row.key;
    const options = row.options ? row.options.slice() : typeof row.value === 'boolean' ? [false, true] : [];
    if (!options.length) for (let n = row.min; n <= row.max; n += row.step) options.push(n);
    if (!options.includes(row.value)) options.unshift(row.value);
    for (const value of options) {
      const option = new Option(soundbarChoice(row.key, value), String(value), false, value === row.value);
      option.disabled = !!row.options && !row.options.includes(value);
      select.add(option);
    }
    select.onchange = () => soundbarRequest({ action: 'set', id: soundbarSelection, key: row.key,
      value: typeof row.value === 'boolean' ? select.value === 'true' : Number(select.value) });
    item.append(label, select);
    list.appendChild(item);
  }
}

function soundbarReason(reason) {
  switch (reason) {
    case 'address': return t('audio.bar.badAddress', 'Enter the local IPv4 address of the soundbar.');
    case 'identity': case 'model': return t('audio.bar.wrong', 'Check the address and reconnect the DS90TR.');
    case 'busy': return t('srv.audio.override.busy', 'An audio change is still in progress.');
    case 'unconfirmed': case 'invalid': return t('audio.bar.check', 'The soundbar could not confirm this setting. Refresh to see its current value.');
    case 'disabled': return t('tv.audio.readOnly', 'TV controls are disabled in the server configuration.');
    case 'save': return t('audio.bar.saveError', 'Could not save the soundbar connection.');
    default: return t('audio.bar.offline', 'Could not read the soundbar. Check its power and IP address.');
  }
}

async function soundbarRequest(body) {
  if (soundbarBusy) return;
  soundbarBusy = true;
  const status = q('audio-bar-status'), hostInput = q('audio-bar-host');
  status.textContent = body ? t('audio.changing', 'Changing…') : t('tv.loading', 'Loading…');
  const section = q('audio-bar');
  section.querySelectorAll('select,button,input').forEach(el => { el.disabled = true; });
  try {
    const response = await fetch(api('/api/audio/soundbar'), body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : { cache: 'no-store' });
    const result = await response.json();
    if (typeof result.writable === 'boolean') {
      soundbarSelection = result.id;
      soundbarWritable = result.writable;
      q('audio-bar-forget').hidden = !result.id;
      if (result.host || (result.ok && body && body.action === 'forget')) hostInput.value = result.host;
    }
    if (!response.ok || !result.ok) throw new Error(result.error || soundbarReason(result.reason));
    soundbarRows(result.device ? result.device.rows : []);
    status.textContent = [result.device && result.device.name, result.device && result.device.model,
      !result.writable && soundbarReason('disabled')].filter(Boolean).join(' · ');
  } catch (err) {
    soundbarRows([]);
    status.textContent = err.message;
  } finally {
    soundbarBusy = false;
    section.querySelectorAll('select,button,input').forEach(el => { el.disabled = !soundbarWritable; });
    q('audio-bar-refresh').disabled = false;
  }
}

function soundbarConnect() {
  soundbarRequest({ action: 'connect', host: q('audio-bar-host').value.trim(), id: soundbarSelection });
}
function soundbarForget() {
  soundbarRequest({ action: 'forget', id: soundbarSelection });
}
