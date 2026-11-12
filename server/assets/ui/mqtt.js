// The MQTT and Home Assistant settings.

// ---- MQTT & Home Assistant settings ----
let cfgPasswordSet = false;
let cfgHaEnabled = true;
let cfgHaUrl = '';
let cfgHaTokenSet = false;
let cfgHaWritable = true;

function toggleMqtt() { showTab(activeTab === 'mqtt' ? 'control' : 'mqtt'); }

function cfgToggle(id) {
  const b = q(id);
  b.classList.toggle('on');
  if (id === 'cfg-tls') cfgSyncTls();
  if (id === 'cfg-enabled') {
    cfgSyncEnabled();
    renderCfgStatus(cfgLastStatus);
  }
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

let cfgLastStatus = null;
let cfgLastPublishMs = null;
let cfgDevice = null;

function triggerMqttPacket(id) {
  const el = q(id);
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
  el.addEventListener('animationend', () => { el.classList.remove('pulse'); }, { once: true });
}

function formatMqttLinkMetric(st, isEnabled) {
  if (!isEnabled) return { text: t('common.off', 'Off'), title: '' };
  if (st.state === 'connected') {
    let metric = t('mqtt.net.reachable', 'Reachable');
    if (st.latencyMs != null) metric += ' · ' + t('mqtt.net.latency', '{ms} ms', { ms: st.latencyMs });
    if (st.lastPublishMs != null) metric += ' · ' + t('mqtt.net.pubAge', 'pub {age}', { age: cfgAge(st.lastPublishMs) });
    return { text: metric, title: '' };
  }
  if (st.state === 'connecting') {
    return { text: t('mqtt.state.connecting', 'Connecting'), title: '' };
  }
  if (st.state === 'error') {
    const detail = st.detail || t('mqtt.state.error', 'Error');
    return { text: t('mqtt.net.unreachable', 'Unreachable') + ': ' + detail, title: detail };
  }
  return { text: t('common.off', 'Off'), title: '' };
}

function resolveBrokerAddress(st) {
  if (st.broker) return st.broker;
  const hostInput = q('cfg-host');
  if (!hostInput || !hostInput.value) return '';
  const port = q('cfg-port') && q('cfg-port').value;
  const tls = q('cfg-tls') && q('cfg-tls').classList.contains('on');
  return hostPort(hostInput.value, port || (tls ? '8883' : '1883'));
}

function updateMqttPublishPulse(st, isEnabled) {
  if (!isEnabled || st.state !== 'connected' || st.lastPublishMs == null) return;
  const isNewPub = cfgLastPublishMs === null || st.lastPublishMs < cfgLastPublishMs;
  const isRecurrent = cfgLastPublishMs > 5000 && st.lastPublishMs <= 5000;
  if (isNewPub || isRecurrent) triggerMqttPacket('mqtt-packet-pub');
  cfgLastPublishMs = st.lastPublishMs;
}

function renderMqttTvNode(isEnabled) {
  const nameEl = q('mqtt-node-tv-name');
  if (nameEl) {
    nameEl.textContent = (cfgDevice && cfgDevice.name) || 'LG webOS TV';
  }
  const dotEl = q('mqtt-dot-tv');
  if (dotEl) {
    dotEl.className = 'mqtt-dot ' + (isEnabled ? 'good' : 'idle');
  }
}

function renderMqttBrokerNode(st, isEnabled) {
  const brokerText = resolveBrokerAddress(st);
  const nameEl = q('mqtt-node-broker-name');
  if (nameEl) nameEl.textContent = t('mqtt.net.server', 'MQTT server');
  const subEl = q('mqtt-node-broker-sub');
  if (subEl) {
    subEl.textContent = brokerText || t('mqtt.net.noBroker', 'No broker configured');
    subEl.title = brokerText;
  }
  const nodeEl = q('mqtt-node-broker');
  if (nodeEl) {
    nodeEl.title = (isEnabled && st.state === 'error' && st.detail) ? st.detail : '';
  }
  const tlsTag = q('mqtt-node-broker-tls');
  if (tlsTag) {
    const isTls = !!(st.tls || (q('cfg-tls') && q('cfg-tls').classList.contains('on')));
    tlsTag.hidden = !isTls;
  }
  const dotEl = q('mqtt-dot-broker');
  if (dotEl) {
    const pill = CFG_STATE[st.state] ? CFG_STATE[st.state].pill : 'idle';
    dotEl.className = 'mqtt-dot ' + (isEnabled ? pill : 'idle');
  }
}

function renderMqttTopology(st) {
  if (!st && !cfgLastStatus) return;
  if (st) cfgLastStatus = st;
  st = cfgLastStatus || { state: 'disabled' };

  const isEnabled = q('cfg-enabled') ? q('cfg-enabled').classList.contains('on') : (st.state !== 'disabled');
  const isErr = isEnabled && st.state === 'error';
  const netEl = q('mqtt-net');
  if (netEl) {
    netEl.classList.toggle('off', !isEnabled);
    netEl.classList.toggle('error', isErr);
  }

  renderMqttTvNode(isEnabled);

  const metric = formatMqttLinkMetric(st, isEnabled);
  const linkEl = q('mqtt-net-last-pub');
  if (linkEl) {
    linkEl.textContent = metric.text;
    linkEl.title = metric.title;
  }
  updateMqttPublishPulse(st, isEnabled);

  renderMqttBrokerNode(st, isEnabled);
}

function renderCfgStatus(st) {
  if (!st && !cfgLastStatus) return;
  if (st) cfgLastStatus = st;
  renderMqttTopology(cfgLastStatus);
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
    if (j.ok && j.homeAssistant && j.homeAssistant.status) renderHaStatus(j.homeAssistant.status);
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
  renderMqttTopology(cfgLastStatus);
}

// Part of the form, like the entity categories: it applies on Save & restart.
let cfgIcons = false;

function renderCfgIcons() {
  updateToggle('cfg-icons', {
    cls: cfgIcons ? 'good' : 'idle',
    label: cfgIcons ? t('mqtt.cat.enabled', 'Enabled') : t('mqtt.cat.disabled', 'Disabled')
  });
}

function cfgToggleIcons() {
  cfgIcons = !cfgIcons;
  renderCfgIcons();
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

async function loadSettings(keepMsg) {
  try {
    const r = await fetch(api('/api/settings'));
    const j = await r.json();
    if (!j.ok) { cfgMsg(j.error || t('mqtt.readFailed', 'Could not read settings'), 'bad'); return; }
    if (j.status) renderCfgStatus(j.status);
    const m = j.mqtt, d = j.device;
    cfgDevice = d;
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
    q('cfg-interval').value = m.telemetryIntervalMs;
    q('cfg-enabled').classList.toggle('on', m.enabled);
    cfgSyncEnabled();
    cfgIcons = !!j.iconServer;
    renderCfgIcons();
    q('cfg-tls').classList.toggle('on', m.tls);
    q('cfg-verify').classList.toggle('on', m.tlsRejectUnauthorized);
    cfgSyncTls();

    const ha = j.homeAssistant || {};
    cfgHaEnabled = ha.enabled !== false;
    cfgHaUrl = ha.url || '';
    cfgHaTokenSet = !!ha.tokenSet;
    cfgHaWritable = !!j.writable;
    const haUrlInput = q('cfg-ha-url');
    if (haUrlInput) {
      haUrlInput.value = cfgHaUrl;
      if (!cfgHaUrl && m.host) {
        haUrlInput.placeholder = 'http://' + m.host + ':8123';
      }
    }
    const haTokenInput = q('cfg-ha-token');
    if (haTokenInput) haTokenInput.value = '';
    const haTokenHint = q('cfg-ha-token-hint');
    if (haTokenHint) {
      haTokenHint.textContent = cfgHaTokenSet
        ? t('ha.token.set', 'A token is set. Leave blank to keep it.')
        : t('ha.token.hint', 'From your Home Assistant profile → Long-Lived Access Tokens.');
    }
    const haSaveBtn = q('cfg-ha-save-btn');
    if (haSaveBtn) haSaveBtn.disabled = !j.writable;
    const haToggleBtn = q('cfg-ha-enabled');
    if (haToggleBtn) haToggleBtn.disabled = !j.writable;
    renderHaEnabledToggle();
    const haMsgEl = q('cfg-ha-msg');
    if (haMsgEl && !keepMsg) {
      haMsgEl.textContent = '';
      haMsgEl.className = 'cfg-msg';
    }
    renderHaStatus(ha.status || null);
    if (cfgHaEnabled && cfgHaUrl && cfgHaTokenSet && cfgHaWritable) {
      checkHaStatus();
    }

    if (m.entities) cfgEntities = m.entities;
    if (m.categories) cfgCategories = m.categories;
    if (m.entityCatalogue) cfgCatalogue = m.entityCatalogue;
    renderEntitiesUI();
    renderMqttTopology(j.status);

    ['cfg-host', 'cfg-port', 'cfg-user', 'cfg-pass'].forEach(id => {
      const input = q(id);
      if (input && !input._mqttBound) {
        input._mqttBound = true;
        input.addEventListener('input', () => {
          renderMqttTopology(cfgLastStatus);
        });
      }
    });

    const saveBtn = q('cfg-save-btn');
    if (saveBtn) {
      saveBtn.disabled = !j.writable;
      saveBtn.classList.remove('busy');
    }
    if (!keepMsg) {
      cfgMsg(j.writable
        ? t('mqtt.save.note', 'Saving restarts the server. The dashboard reconnects on its own.')
        : t('mqtt.controlsOff', 'Controls are disabled in config.json, so settings cannot be changed from here.'));
    }
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
    device: { id: q('cfg-devid').value },
    iconServer: cfgIcons
  };
  // An untouched password field means "keep the stored one", not "clear it".
  const pass = q('cfg-pass').value;
  if (pass !== '' || !cfgPasswordSet) body.mqtt.password = pass;

  const haUrlEl = q('cfg-ha-url');
  const haTokenEl = q('cfg-ha-token');
  const haUrl = haUrlEl ? haUrlEl.value.trim() : '';
  const haToken = haTokenEl ? haTokenEl.value.trim() : '';
  if (haUrl !== '' || haToken !== '' || cfgHaUrl !== '' || cfgHaTokenSet) {
    body.homeAssistant = { enabled: cfgHaEnabled, url: haUrl };
    if (haToken !== '') body.homeAssistant.token = haToken;
  }

  const saveBtn = q('cfg-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add('busy'); }
  cfgMsg(t('mqtt.saving', 'Saving...'));
  try {
    const r = await fetch(api('/api/settings'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) {
      cfgMsg(j.error || t('mqtt.saveFailed', 'Save failed'), 'bad');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    cfgMsg(t('mqtt.restarting', 'Saved. Restarting...'));
    await waitForServer();
  } catch (e) {
    cfgMsg(e.message, 'bad');
    if (saveBtn) saveBtn.disabled = false;
  } finally {
    if (saveBtn) saveBtn.classList.remove('busy');
  }
}

function openHaSettings() {
  showTab('mqtt');
  const sec = q('ha-api-section');
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHaEnabledToggle() {
  const btn = q('cfg-ha-enabled');
  const note = q('cfg-ha-enabled-note');
  if (btn) btn.classList.toggle('on', cfgHaEnabled);
  if (note) {
    note.textContent = cfgHaEnabled
      ? t('ha.enabled.on', 'Screen savers can read configured Home Assistant entities.')
      : t('ha.enabled.off', 'Turned off. Home Assistant screen savers are disabled while keeping your saved address and token.');
  }
}

async function toggleHaEnabled() {
  if (!cfgHaWritable) return;
  const next = !cfgHaEnabled;
  cfgHaEnabled = next;
  renderHaEnabledToggle();

  const btn = q('cfg-ha-enabled');
  const msgEl = q('cfg-ha-msg');
  if (!(cfgHaUrl && cfgHaTokenSet)) {
    renderHaStatus(null);
    return;
  }

  if (btn) btn.disabled = true;
  if (msgEl) { msgEl.textContent = t('mqtt.saving', 'Saving...'); msgEl.className = 'cfg-msg'; }
  try {
    const r = await fetch(api('/api/ha/save'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next })
    });
    const j = await r.json();
    if (!j.ok) {
      cfgHaEnabled = !next;
      renderHaEnabledToggle();
      if (msgEl) { msgEl.textContent = j.error || t('mqtt.saveFailed', 'Save failed'); msgEl.className = 'cfg-msg bad'; }
      return;
    }
    cfgHaEnabled = j.enabled !== false;
    renderHaEnabledToggle();
    if (typeof resetHaEntitiesCache === 'function') resetHaEntitiesCache();
    if (typeof loadScreensavers === 'function') loadScreensavers();
    if (!cfgHaEnabled) {
      renderHaStatus(j.status || { state: 'disabled' });
      if (msgEl) { msgEl.textContent = ''; msgEl.className = 'cfg-msg'; }
      return;
    }
    await checkHaStatus(msgEl);
  } catch (e) {
    cfgHaEnabled = !next;
    renderHaEnabledToggle();
    if (msgEl) { msgEl.textContent = e.message; msgEl.className = 'cfg-msg bad'; }
  } finally {
    if (btn) btn.disabled = !cfgHaWritable;
  }
}

// The Home Assistant API's Connection box, drawn as the MQTT bridge's is: the
// TV, the link with how it last went, and Home Assistant at its address.
let haLastStatus = null;
let haLastReadMs = null;

function formatHaLinkMetric(st, statusObj) {
  if (st === 'disabled') return { text: t('common.off', 'Off'), title: '' };
  if (st === 'unconfigured') return { text: t('ha.notSet', 'Not set'), title: '' };
  if (st === 'checking') return { text: t('ha.status.checking', 'Checking...'), title: '' };
  if (st === 'connected') {
    let metric = t('mqtt.net.reachable', 'Reachable');
    if (statusObj && statusObj.latencyMs != null) metric += ' · ' + t('mqtt.net.latency', '{ms} ms', { ms: statusObj.latencyMs });
    if (statusObj && statusObj.lastReadMs != null) metric += ' · ' + t('ha.net.readAge', 'read {age}', { age: cfgAge(statusObj.lastReadMs) });
    return { text: metric, title: '' };
  }
  if (st === 'error') {
    const detail = (statusObj && statusObj.error) || t('mqtt.state.error', 'Error');
    return { text: t('mqtt.net.unreachable', 'Unreachable') + ': ' + detail, title: detail };
  }
  return { text: t('ha.savedStatus', 'Configured'), title: '' };
}

// A packet crosses the link each time a screen saver has read since the last poll.
function updateHaReadPulse(st, statusObj) {
  const readMs = statusObj && statusObj.lastReadMs;
  if (st !== 'connected' || readMs == null) { haLastReadMs = readMs == null ? null : readMs; return; }
  if (haLastReadMs === null || readMs < haLastReadMs) triggerMqttPacket('ha-packet-read');
  haLastReadMs = readMs;
}

function renderHaStatus(statusObj) {
  if (statusObj) haLastStatus = statusObj;
  else statusObj = haLastStatus;
  const st = !cfgHaEnabled ? 'disabled'
    : !(cfgHaUrl && cfgHaTokenSet) ? 'unconfigured'
    : (statusObj && statusObj.state) || 'unknown';
  const isOn = st !== 'disabled' && st !== 'unconfigured';

  const netEl = q('ha-net');
  if (netEl) {
    netEl.classList.toggle('off', !isOn);
    netEl.classList.toggle('error', st === 'error');
  }
  const tvName = q('ha-node-tv-name');
  if (tvName) tvName.textContent = (cfgDevice && cfgDevice.name) || 'LG webOS TV';
  const tvDot = q('ha-dot-tv');
  if (tvDot) tvDot.className = 'mqtt-dot ' + (isOn ? 'good' : 'idle');

  const metric = formatHaLinkMetric(st, statusObj);
  const metricEl = q('ha-net-metric');
  if (metricEl) {
    metricEl.textContent = metric.text;
    metricEl.title = metric.title;
  }
  updateHaReadPulse(st, statusObj);

  let address = cfgHaUrl;
  try { if (cfgHaUrl) address = new URL(cfgHaUrl).host; } catch (e) { /* shown as typed */ }
  const sub = q('ha-node-server-sub');
  if (sub) {
    sub.textContent = address || t('ha.net.noAddress', 'No address set');
    sub.title = cfgHaUrl;
  }
  const tls = q('ha-node-server-tls');
  if (tls) tls.hidden = !/^https:/i.test(cfgHaUrl);
  const serverNode = q('ha-node-server');
  if (serverNode) serverNode.title = st === 'error' ? metric.title : '';
  const serverDot = q('ha-dot-server');
  if (serverDot) {
    const dot = st === 'connected' ? 'good' : st === 'error' ? 'bad' : st === 'checking' ? 'warn' : 'idle';
    serverDot.className = 'mqtt-dot ' + dot;
  }
}

async function checkHaStatus(msgEl) {
  if (!(cfgHaEnabled && cfgHaUrl && cfgHaTokenSet)) {
    renderHaStatus(null);
    return;
  }
  renderHaStatus({ state: 'checking' });
  try {
    const r = await fetch(api('/api/ha/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const j = await r.json();
    if (j.ok) {
      renderHaStatus({ state: 'connected', message: j.message });
      if (msgEl) { msgEl.textContent = t('ha.connected', 'Connected: {msg}', { msg: j.message || 'OK' }); msgEl.className = 'cfg-msg good'; }
    } else {
      renderHaStatus({ state: 'error', error: j.error || t('ha.testFailed', 'Connection failed') });
      if (msgEl) { msgEl.textContent = j.error || t('ha.testFailed', 'Connection failed'); msgEl.className = 'cfg-msg bad'; }
    }
  } catch (e) {
    renderHaStatus({ state: 'error', error: e.message });
    if (msgEl) { msgEl.textContent = e.message; msgEl.className = 'cfg-msg bad'; }
  }
}

async function saveHaSettings() {
  const btn = q('cfg-ha-save-btn');
  const msgEl = q('cfg-ha-msg');
  if (!btn || !msgEl) return;
  const url = q('cfg-ha-url') ? q('cfg-ha-url').value.trim() : '';
  const token = q('cfg-ha-token') ? q('cfg-ha-token').value.trim() : '';
  const payload = { enabled: cfgHaEnabled, url: url };
  if (token !== '') payload.token = token;
  else if (url === '') payload.clearToken = true;

  btn.disabled = true;
  msgEl.textContent = t('mqtt.saving', 'Saving...');
  msgEl.className = 'cfg-msg';

  try {
    const r = await fetch(api('/api/ha/save'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!j.ok) {
      msgEl.textContent = j.error || t('mqtt.saveFailed', 'Save failed');
      msgEl.className = 'cfg-msg bad';
      return;
    }
    cfgHaEnabled = j.enabled !== false;
    cfgHaUrl = j.url || '';
    cfgHaTokenSet = !!j.tokenSet;
    renderHaEnabledToggle();
    const tokenInput = q('cfg-ha-token');
    if (tokenInput) tokenInput.value = '';
    const tokenHint = q('cfg-ha-token-hint');
    if (tokenHint) {
      tokenHint.textContent = cfgHaTokenSet
        ? t('ha.token.set', 'A token is set. Leave blank to keep it.')
        : t('ha.token.hint', 'From your Home Assistant profile → Long-Lived Access Tokens.');
    }
    if (typeof resetHaEntitiesCache === 'function') resetHaEntitiesCache();
    if (typeof loadScreensavers === 'function') loadScreensavers();

    if (!j.url && !j.tokenSet) {
      renderHaStatus(null);
      msgEl.textContent = t('ha.cleared', 'Cleared.');
      msgEl.className = 'cfg-msg';
      return;
    }
    if (!cfgHaEnabled) {
      renderHaStatus(j.status || { state: 'disabled' });
      msgEl.textContent = t('ha.savedOff', 'Saved (Home Assistant API is turned off).');
      msgEl.className = 'cfg-msg';
      return;
    }
    renderHaStatus({ state: 'checking' });
    const tr = await fetch(api('/api/ha/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const tj = await tr.json();
    if (tj.ok) {
      renderHaStatus({ state: 'connected', message: tj.message });
      msgEl.textContent = t('ha.savedConnected', 'Saved — Connected: {msg}', { msg: tj.message || 'OK' });
      msgEl.className = 'cfg-msg good';
    } else {
      renderHaStatus({ state: 'error', error: tj.error || '' });
      msgEl.textContent = t('ha.savedWarn', 'Saved (test failed: {err})', { err: tj.error || '' });
      msgEl.className = 'cfg-msg bad';
    }
  } catch (e) {
    msgEl.textContent = e.message;
    msgEl.className = 'cfg-msg bad';
  } finally {
    btn.disabled = false;
  }
}

async function testHaConnection() {
  const btn = q('cfg-ha-test-btn');
  const msgEl = q('cfg-ha-msg');
  if (!btn || !msgEl) return;
  const url = q('cfg-ha-url') ? q('cfg-ha-url').value.trim() : '';
  const token = q('cfg-ha-token') ? q('cfg-ha-token').value.trim() : '';

  btn.disabled = true;
  msgEl.textContent = t('ha.testing', 'Testing connection...');
  msgEl.className = 'cfg-msg';

  try {
    const r = await fetch(api('/api/ha/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, token: token || undefined })
    });
    const j = await r.json();
    const unsaved = (url !== cfgHaUrl) || (token !== '');
    if (j.ok) {
      if (!unsaved && cfgHaEnabled) renderHaStatus({ state: 'connected', message: j.message });
      msgEl.textContent = unsaved
        ? t('ha.connectedUnsaved', 'Connected: {msg} (click Save to apply)', { msg: j.message || 'OK' })
        : t('ha.connected', 'Connected: {msg}', { msg: j.message || 'OK' });
      msgEl.className = 'cfg-msg good';
    } else {
      if (!unsaved && cfgHaEnabled) renderHaStatus({ state: 'error', error: j.error || '' });
      msgEl.textContent = j.error || t('ha.testFailed', 'Connection failed');
      msgEl.className = 'cfg-msg bad';
    }
  } catch (e) {
    msgEl.textContent = e.message;
    msgEl.className = 'cfg-msg bad';
  } finally {
    btn.disabled = false;
  }
}
