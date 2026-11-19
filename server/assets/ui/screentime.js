// Screen-time limits, on the Advanced tab. Counted by watch time (history.js).

const ST_DAILY_MINUTES = [0, 30, 60, 90, 120, 180, 240, 300, 360, 480];
const ST_APP_MINUTES = [15, 30, 45, 60, 90, 120, 180, 240];
let screenTime = null;

function stActionLabel(a) {
  return {
    off: t('adv.screenTime.do.off', 'Switch the TV off'),
    screenOff: t('adv.screenTime.do.screenOff', 'Turn the screen off'),
    home: t('adv.screenTime.do.home', 'Go to Home'),
    warn: t('adv.screenTime.do.warn', 'Only warn')
  }[a];
}

function stMinutesLabel(m) {
  return m ? watchDuration(m * 60) : t('adv.screenTime.noLimit', 'No limit');
}

// Options for a select, keeping a value set in config.json that is not in the list.
function stOptions(sel, values, current, label) {
  const list = values.indexOf(current) === -1 ? values.concat([current]).sort((a, b) => a - b) : values;
  sel.innerHTML = list.map(v => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
  sel.value = String(current);
}

function stName(c) { return c.title || c.key; }

function renderScreenTime(d) {
  screenTime = d;
  const s = d.settings;
  const off = !d.writable;
  updateToggle('st-enabled', {
    cls: s.enabled ? 'good' : 'idle',
    label: s.enabled ? t('common.on', 'On') : t('common.off', 'Off'),
    on: s.enabled,
    disabled: off || (!s.enabled && !d.historyOn)
  });

  const note = q('st-note');
  let text = '';
  if (!d.historyOn) text = t('adv.screenTime.needsWatch', 'Counted by watch time, which is off. It is turned on in the Server tab.');
  else if (s.enabled && !d.clockSet) text = t('adv.screenTime.clockUnset', 'The TV’s clock is not set yet. The limits apply once it is.');
  else if (!d.allowPower && (s.action === 'off' || s.appAction === 'off')) {
    text = t('adv.screenTime.noPower', 'Power actions are turned off in the server’s config, so the TV cannot be switched off.');
  }
  note.textContent = text;
  note.hidden = !text;

  const today = q('st-today');
  today.hidden = d.watchedToday === null;
  if (d.watchedToday !== null) {
    today.textContent = t('adv.screenTime.today', 'Today so far: {time}', { time: watchDuration(d.watchedToday) });
  }

  stOptions(q('st-daily'), ST_DAILY_MINUTES, s.dailyMinutes, stMinutesLabel);
  for (const [id, v] of [['st-bed-from', s.bedtimeStart], ['st-bed-to', s.bedtimeEnd]]) {
    const el = q(id);
    if (!v || document.activeElement !== el) el.value = v;
  }
  const hasBedAny = Boolean(s.bedtimeStart || s.bedtimeEnd);
  const hasBedBoth = Boolean(s.bedtimeStart && s.bedtimeEnd);
  if (q('st-bed-clear')) {
    q('st-bed-clear').hidden = !hasBedAny;
    q('st-bed-clear').disabled = off;
  }
  const actions = (sel, list, v) => {
    sel.innerHTML = list.map(a => `<option value="${a}">${esc(stActionLabel(a))}</option>`).join('');
    sel.value = v;
  };
  actions(q('st-action'), ['off', 'screenOff', 'warn'], s.action);
  // A TV without LG's Home app (webOS 3 to 5) has only the ribbon, which leaves the app playing.
  actions(q('st-app-action'), d.homeApp ? ['home', 'off', 'screenOff', 'warn'] : ['off', 'screenOff', 'warn'], s.appAction);

  const byKey = {};
  d.choices.forEach(c => { byKey[c.key] = c; });
  const limited = Object.keys(s.apps).sort((a, b) => stName(byKey[a] || { key: a }).localeCompare(stName(byKey[b] || { key: b })));
  q('st-apps').innerHTML = limited.map(key => {
    const c = byKey[key] || { key, today: null };
    const used = c.today === null ? '' : t('adv.screenTime.used', '{time} today', { time: watchDuration(c.today) });
    return `<div class="st-app" data-key="${esc(key)}"><span class="st-name">${esc(stName(c))}</span>` +
      `<span class="st-used">${esc(used)}</span>` +
      `<select class="pill-sel" aria-label="${esc(t('adv.screenTime.minutes', 'Minutes a day'))}"></select>` +
      `<button type="button" class="link-btn">${esc(t('adv.screenTime.remove', 'Remove'))}</button></div>`;
  }).join('');
  for (const row of q('st-apps').children) {
    const key = row.dataset.key;
    const sel = row.querySelector('select');
    stOptions(sel, ST_APP_MINUTES, s.apps[key], stMinutesLabel);
    sel.disabled = off;
    sel.onchange = () => saveScreenTime({ apps: Object.assign({}, s.apps, { [key]: Number(sel.value) }) });
    const remove = row.querySelector('button');
    remove.disabled = off;
    remove.onclick = () => {
      const apps = Object.assign({}, s.apps);
      delete apps[key];
      saveScreenTime({ apps });
    };
  }

  const free = d.choices.filter(c => !(c.key in s.apps)).sort((a, b) => stName(a).localeCompare(stName(b)));
  q('st-add').innerHTML = `<option value="">${esc(t('adv.screenTime.add', 'Add a limit'))}</option>` +
    free.map(c => `<option value="${esc(c.key)}">${esc(stName(c))}</option>`).join('');
  q('st-add').disabled = off || !free.length;

  q('st-daily-row').hidden = !s.enabled;
  q('st-bed-row').hidden = !s.enabled;
  q('st-apps-row').hidden = !s.enabled;
  q('st-action-row').hidden = !s.enabled || (!s.dailyMinutes && !hasBedBoth);
  q('st-app-action-row').hidden = !s.enabled || !limited.length;

  for (const id of ['st-daily', 'st-bed-from', 'st-bed-to', 'st-action', 'st-app-action']) q(id).disabled = off;
}

async function loadScreenTime() {
  try {
    const d = await (await fetch(api('/api/screentime'), { cache: 'no-store' })).json();
    if (d.ok) renderScreenTime(d);
  } catch (e) { /* the section keeps what it showed */ }
}

async function saveScreenTime(patch) {
  try {
    const r = await fetch(api('/api/screentime'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || t('common.actionFailed', 'Action failed'));
    clearErr();
    renderScreenTime(d);
  } catch (e) {
    showErr(e.message);
    loadScreenTime();
  }
}

function toggleScreenTime() {
  if (screenTime) saveScreenTime({ enabled: !screenTime.settings.enabled });
}

// A new limit starts at an hour a day.
function addScreenTimeApp(key) {
  if (!key || !screenTime) return;
  saveScreenTime({ apps: Object.assign({}, screenTime.settings.apps, { [key]: 60 }) });
}

function clearBedtime() {
  if (q('st-bed-from')) q('st-bed-from').value = '';
  if (q('st-bed-to')) q('st-bed-to').value = '';
  saveScreenTime({ bedtimeStart: '', bedtimeEnd: '' });
}
