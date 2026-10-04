// The MQTT and Home Assistant settings.

// ---- MQTT & Home Assistant settings ----
let cfgPasswordSet = false;

function toggleMqtt() { showTab(activeTab === 'mqtt' ? 'control' : 'mqtt'); }

function cfgToggle(id) {
  const b = q(id);
  b.classList.toggle('on');
  if (id === 'cfg-tls') cfgSyncTls();
  if (id === 'cfg-enabled') cfgSyncEnabled();
}

// The switch is part of the form, so it means nothing until the save restarts
// the server. Saying so beats a switch that looks like it has already acted.
function cfgSyncEnabled() {
  const on = q('cfg-enabled').classList.contains('on');
  q('cfg-enabled-note').textContent = on
    ? t('mqtt.enabled.on', 'The TV publishes telemetry and accepts commands over MQTT.')
    : t('mqtt.enabled.off', 'Nothing is published. The dashboard is unaffected.');
}

// Certificate verification is meaningless without TLS, so it follows it.
function cfgSyncTls() {
  const on = q('cfg-tls').classList.contains('on');
  q('cfg-verify').disabled = !on;
}

const CFG_STATE = {
  connected:  { pill: 'good', label: t('mqtt.state.connected', 'Connected') },
  connecting: { pill: 'warn', label: t('mqtt.state.connecting', 'Connecting') },
  error:      { pill: 'bad',  label: t('mqtt.state.error', 'Error') },
  disabled:   { pill: 'idle', label: t('common.off', 'Off') }
};

function cfgAge(ms) {
  if (ms == null) return t('mqtt.age.never', 'not yet');
  const s = Math.round(ms / 1000);
  if (s < 5) return t('mqtt.age.now', 'just now');
  if (s < 60) return t('mqtt.age.seconds', '{n}s ago', { n: s });
  if (s < 3600) return t('mqtt.age.minutes', '{n}m ago', { n: Math.round(s / 60) });
  return t('mqtt.age.hours', '{n}h ago', { n: Math.round(s / 3600) });
}

function renderCfgStatus(st) {
  const meta = CFG_STATE[st.state] || CFG_STATE.disabled;
  const pill = q('cfg-status-pill');
  pill.className = 'pill ' + meta.pill;
  pill.textContent = meta.label;

  const broker = st.tls ? t('mqtt.broker.tls', '{broker} over TLS', { broker: st.broker }) : st.broker;
  // st.detail is the server's own words, in English.
  const detail = st.detail ? st.detail.charAt(0).toUpperCase() + st.detail.slice(1) + '.' : '';
  let text;
  if (st.state === 'connected') {
    text = t('mqtt.status.connected', 'Publishing to {broker}. Last telemetry {age}.', { broker, age: cfgAge(st.lastPublishMs) });
  } else if (st.state === 'connecting') {
    text = (detail ? detail + ' ' : '') + t('mqtt.status.connecting', 'Reaching {broker}.', { broker });
  } else if (st.state === 'error') {
    text = t('mqtt.status.error', '{broker}: {detail}. Retrying every 5s.', { broker, detail: st.detail });
  } else {
    text = detail || t('mqtt.status.off', 'The bridge is off. Nothing is published.');
  }
  q('cfg-status-detail').textContent = text;
}

/*
 * Only while the pane is open. Saved settings do not take effect until the
 * restart, so this is also what shows whether the new broker took.
 */
let cfgStatusTimer = null;
function cfgPollStatus(on) {
  clearInterval(cfgStatusTimer);
  cfgStatusTimer = on ? setInterval(refreshCfgStatus, 5000) : null;
}

async function refreshCfgStatus() {
  try {
    const r = await fetch(api('/api/settings'), { cache: 'no-store' });
    const j = await r.json();
    if (j.ok && j.status) renderCfgStatus(j.status);
  } catch (e) { /* a restart drops this; the next poll picks it up */ }
}

function cfgMsg(text, kind) {
  const el = q('cfg-msg');
  el.textContent = text;
  el.className = 'cfg-msg' + (kind ? ' ' + kind : '');
}

let cfgEntities = { controls: true, oled: true, video: true, system: true, diagnostics: true, disabled: [] };
let cfgCatalogue = [];
let cfgCategories = [];

function renderEntitiesUI() {
  const container = q('cfg-ents');
  if (!container || !cfgCategories.length) return;

  const disabledSet = new Set(cfgEntities.disabled || []);
  let totalActive = 0;
  const totalEntities = cfgCatalogue.length;

  let entsHtml = '';
  for (const cat of cfgCategories) {
    const catEnts = cfgCatalogue.filter(e => e.cat === cat.id);
    const count = catEnts.length;
    const catOn = cfgEntities[cat.id] !== false;
    let activeInCat = 0;
    if (catOn) {
      for (const e of catEnts) {
        if (!disabledSet.has(e.id) && !disabledSet.has(e.type + '.' + e.id)) activeInCat++;
      }
    }
    totalActive += activeInCat;

    entsHtml += `
      <div class="pv-row">
        <div>
          <div class="n">${esc(cat.name)} <span class="cnt">${esc(count === 1 ? t('mqtt.entities.one', '(1 entity)') : t('mqtt.entities.count', '({n} entities)', { n: count }))}</span></div>
          <div class="d">${esc(cat.desc)}</div>
        </div>
        ${renderToggle({
          id: 'cfg-cat-' + cat.id,
          cls: catOn ? 'good' : 'idle',
          label: catOn ? t('mqtt.cat.enabled', 'Enabled') : t('mqtt.cat.disabled', 'Disabled'),
          onclick: "cfgToggleCat('" + cat.id + "')"
        })}
      </div>`;
  }
  container.innerHTML = entsHtml;

  const subContainer = q('cfg-subents');
  if (subContainer) {
    let subHtml = '';
    for (const cat of cfgCategories) {
      const catEnts = cfgCatalogue.filter(e => e.cat === cat.id);
      if (!catEnts.length) continue;
      const catOn = cfgEntities[cat.id] !== false;
      subHtml += `<div class="pv-g" style="margin-top:16px"><span>${esc(cat.name)}</span></div>`;
      subHtml += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr));gap:4px 12px;margin-top:8px">`;
      for (const e of catEnts) {
        const isDis = disabledSet.has(e.id) || disabledSet.has(e.type + '.' + e.id);
        const checked = catOn && !isDis;
        subHtml += `
          <label class="cfg-ent-chk${catOn ? '' : ' dis'}">
            <input type="checkbox" id="cfg-ent-${e.id}" data-id="${esc(e.id)}" data-type="${esc(e.type)}" data-cat="${esc(cat.id)}" ${checked ? 'checked' : ''} ${catOn ? '' : 'disabled'} onchange="cfgToggleEnt(this)">
            <span class="ent-name">${esc(e.name)} <span class="ent-type">${esc(e.type)}</span></span>
          </label>`;
      }
      subHtml += `</div>`;
    }
    subContainer.innerHTML = subHtml;
  }

  const countEl = q('cfg-fine-count');
  if (countEl) countEl.textContent = t('mqtt.entities.active', '{n} of {total} active', { n: totalActive, total: totalEntities });
}

function cfgToggleCat(catId) {
  cfgEntities[catId] = !(cfgEntities[catId] !== false);
  renderEntitiesUI();
}

function cfgToggleEnt(cb) {
  const id = cb.getAttribute('data-id');
  const type = cb.getAttribute('data-type');
  const dis = new Set(cfgEntities.disabled || []);
  if (cb.checked) {
    dis.delete(id);
    dis.delete(type + '.' + id);
  } else {
    dis.add(id);
  }
  cfgEntities.disabled = Array.from(dis);
  renderEntitiesUI();
}

async function loadSettings() {
  try {
    const r = await fetch(api('/api/settings'));
    const j = await r.json();
    if (!j.ok) { cfgMsg(j.error || t('mqtt.readFailed', 'Could not read settings'), 'bad'); return; }
    if (j.status) renderCfgStatus(j.status);
    const m = j.mqtt, d = j.device;
    q('cfg-host').value = m.host;
    q('cfg-port').value = m.port == null ? '' : m.port;
    q('cfg-user').value = m.username;
    q('cfg-pass').value = '';
    cfgPasswordSet = m.passwordSet;
    q('cfg-pass-hint').textContent = cfgPasswordSet
      ? t('mqtt.password.set', 'A password is set. Leave blank to keep it.')
      : t('mqtt.password.plain', 'Stored on the TV in plain text.');
    q('cfg-prefix').value = m.topicPrefix;
    q('cfg-disc').value = m.discoveryPrefix;
    q('cfg-devid').value = d.id;
    q('cfg-devname').value = d.name;
    q('cfg-interval').value = m.telemetryIntervalMs;
    q('cfg-enabled').classList.toggle('on', m.enabled);
    cfgSyncEnabled();
    q('cfg-tls').classList.toggle('on', m.tls);
    q('cfg-verify').classList.toggle('on', m.tlsRejectUnauthorized);
    cfgSyncTls();
    if (m.entities) cfgEntities = m.entities;
    if (m.categories) cfgCategories = m.categories;
    if (m.entityCatalogue) cfgCatalogue = m.entityCatalogue;
    renderEntitiesUI();
    q('cfg-save-btn').disabled = !j.writable;
    cfgMsg(j.writable
      ? t('mqtt.save.note', 'Saving restarts the server. The dashboard reconnects on its own.')
      : t('mqtt.controlsOff', 'Controls are disabled in config.json, so settings cannot be changed from here.'));
  } catch (e) { cfgMsg(e.message, 'bad'); }
}

async function saveSettings() {
  const body = {
    mqtt: {
      enabled: q('cfg-enabled').classList.contains('on'),
      host: q('cfg-host').value,
      port: q('cfg-port').value === '' ? null : q('cfg-port').value,
      tls: q('cfg-tls').classList.contains('on'),
      tlsRejectUnauthorized: q('cfg-verify').classList.contains('on'),
      username: q('cfg-user').value,
      topicPrefix: q('cfg-prefix').value,
      discoveryPrefix: q('cfg-disc').value,
      telemetryIntervalMs: q('cfg-interval').value || 10000,
      entities: {
        controls: cfgEntities.controls !== false,
        oled: cfgEntities.oled !== false,
        video: cfgEntities.video !== false,
        system: cfgEntities.system !== false,
        diagnostics: cfgEntities.diagnostics !== false,
        disabled: cfgEntities.disabled || []
      }
    },
    device: { id: q('cfg-devid').value, name: q('cfg-devname').value }
  };
  // An untouched password field means "keep the stored one", not "clear it".
  const pass = q('cfg-pass').value;
  if (pass !== '' || !cfgPasswordSet) body.mqtt.password = pass;

  q('cfg-save-btn').disabled = true;
  cfgMsg(t('mqtt.saving', 'Saving...'));
  try {
    const r = await fetch(api('/api/settings'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) { cfgMsg(j.error || t('mqtt.saveFailed', 'Save failed'), 'bad'); q('cfg-save-btn').disabled = false; return; }
    cfgMsg(t('mqtt.restarting', 'Saved. Restarting...'));
    await waitForServer();
  } catch (e) {
    cfgMsg(e.message, 'bad');
    q('cfg-save-btn').disabled = false;
  }
}
