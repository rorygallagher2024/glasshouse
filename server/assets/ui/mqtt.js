// The MQTT and Home Assistant settings.

// ---- MQTT & Home Assistant settings ----
let cfgPasswordSet = false;
let cfgTls = false;
let cfgVerify = false;
let cfgHaEnabled = true;
let cfgHaUrl = '';
let cfgHaTokenSet = false;
let cfgHaWritable = true;
let cfgHaVerify = true;
let cfgHaSavedVerify = true;

function toggleMqtt() { showTab(activeTab === 'mqtt' ? 'control' : 'mqtt'); }

function cfgToggle(id) {
  if (id === 'cfg-tls') {
    cfgTls = !cfgTls;
    cfgSyncTls();
    renderCfgStatus(cfgLastStatus);
    return;
  }
  if (id === 'cfg-verify') {
    if (!cfgTls) return;
    cfgVerify = !cfgVerify;
    cfgSyncTls();
    renderCfgStatus(cfgLastStatus);
    return;
  }
  q(id).classList.toggle('on');
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
  const tlsOn = !!cfgTls;
  const verOn = !!cfgVerify;
  updateToggle('cfg-tls', {
    cls: tlsOn ? 'good' : 'idle',
    label: tlsOn ? t('mqtt.cat.enabled', 'Enabled') : t('mqtt.cat.disabled', 'Disabled'),
    on: tlsOn
  });
  updateToggle('cfg-verify', {
    cls: tlsOn && verOn ? 'good' : 'idle',
    label: verOn ? t('mqtt.cat.enabled', 'Enabled') : t('mqtt.cat.disabled', 'Disabled'),
    on: verOn,
    disabled: !tlsOn
  });
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
  return hostPort(hostInput.value, port || (cfgTls ? '8883' : '1883'));
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
    const isTls = !!(st.tls || cfgTls);
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

// The media_player entity (lib/ha.js mediaPlayerConfig): part of the form too.
let cfgMediaPlayer = false;

function renderCfgMediaPlayer() {
  updateToggle('cfg-mediaplayer', {
    cls: cfgMediaPlayer ? 'good' : 'idle',
    label: cfgMediaPlayer ? t('mqtt.cat.enabled', 'Enabled') : t('mqtt.cat.disabled', 'Disabled')
  });
}

function cfgToggleMediaPlayer() {
  cfgMediaPlayer = !cfgMediaPlayer;
  renderCfgMediaPlayer();
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
    cfgMediaPlayer = !!m.universalMediaPlayer;
    renderCfgMediaPlayer();
    cfgTls = !!m.tls;
    cfgVerify = !!m.tlsRejectUnauthorized;
    cfgSyncTls();

    const ha = j.homeAssistant || {};
    cfgHaEnabled = ha.enabled !== false;
    cfgHaUrl = ha.url || '';
    cfgHaTokenSet = !!ha.tokenSet;
    cfgHaWritable = !!j.writable;
    cfgHaVerify = ha.tlsRejectUnauthorized !== false;
    cfgHaSavedVerify = cfgHaVerify;
    const haUrlInput = q('cfg-ha-url');
    if (haUrlInput) {
      haUrlInput.value = cfgHaUrl;
      if (!cfgHaUrl && m.host) {
        haUrlInput.placeholder = 'http://' + m.host + ':8123';
      }
      if (!haUrlInput._haBound) {
        haUrlInput._haBound = true;
        haUrlInput.addEventListener('input', renderHaVerifyToggle);
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
    renderHaVerifyToggle();
    if (!keepMsg) setHaFeedback('');
    renderHaStatus(ha.status || null);
    if (cfgHaEnabled && cfgHaUrl && cfgHaTokenSet && cfgHaWritable) {
      checkHaStatus(false);
    }
    if (typeof loadHaBar === 'function') loadHaBar();

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
      tls: cfgTls,
      tlsRejectUnauthorized: cfgVerify,
      username: q('cfg-user').value,
      topicPrefix: q('cfg-prefix').value,
      discoveryPrefix: q('cfg-disc').value,
      telemetryIntervalMs: q('cfg-interval').value || 10000,
      universalMediaPlayer: cfgMediaPlayer,
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
  if (haUrl !== '' || haToken !== '' || cfgHaUrl !== '' || cfgHaTokenSet || cfgHaVerify !== cfgHaSavedVerify) {
    body.homeAssistant = { enabled: cfgHaEnabled, url: haUrl, tlsRejectUnauthorized: cfgHaVerify };
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
      ? t('ha.enabled.on', 'Glasshouse can read the Home Assistant entities chosen for its screen savers, control bar and values at a glance on Glasshouse Home.')
      : t('ha.enabled.off', 'Turned off. The Home Assistant screen savers, control bar and entity values at a glance are unavailable. The saved address and token are kept.');
  }
}

function renderHaVerifyToggle() {
  const row = q('cfg-ha-verify-row');
  const urlVal = q('cfg-ha-url') ? q('cfg-ha-url').value.trim() : cfgHaUrl;
  if (row) row.hidden = !/^https:/i.test(urlVal);
  updateToggle('cfg-ha-verify', {
    cls: cfgHaVerify ? 'good' : 'idle',
    label: cfgHaVerify ? t('mqtt.cat.enabled', 'Enabled') : t('mqtt.cat.disabled', 'Disabled'),
    on: cfgHaVerify,
    disabled: !cfgHaWritable
  });
}

function toggleHaVerify() {
  if (!cfgHaWritable) return;
  cfgHaVerify = !cfgHaVerify;
  renderHaVerifyToggle();
}

function setHaFeedback(text, kind, title) {
  const msgEl = q('cfg-ha-msg');
  const errEl = q('cfg-ha-error');
  if (kind === 'bad') {
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'cfg-msg'; }
    if (errEl) {
      errEl.hidden = false;
      if (title && title !== text && typeof esc === 'function') {
        errEl.innerHTML = '<b>' + esc(title) + '</b>' + esc(text || '');
      } else {
        errEl.textContent = text || '';
      }
    }
    return;
  }
  if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
  if (msgEl) {
    msgEl.textContent = text || '';
    msgEl.className = kind ? 'cfg-msg ' + kind : 'cfg-msg';
  }
}

async function toggleHaEnabled() {
  if (!cfgHaWritable) return;
  const next = !cfgHaEnabled;
  cfgHaEnabled = next;
  renderHaEnabledToggle();

  const btn = q('cfg-ha-enabled');
  if (!(cfgHaUrl && cfgHaTokenSet)) {
    renderHaStatus(null);
    return;
  }

  if (btn) btn.disabled = true;
  setHaFeedback(t('mqtt.saving', 'Saving...'));
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
      const saveErrTitle = t('mqtt.saveFailed', 'Save failed');
      setHaFeedback(j.error || saveErrTitle, 'bad', j.error ? saveErrTitle : '');
      return;
    }
    cfgHaEnabled = j.enabled !== false;
    renderHaEnabledToggle();
    if (typeof resetHaEntitiesCache === 'function') resetHaEntitiesCache();
    if (typeof loadScreensavers === 'function') loadScreensavers();
    if (typeof loadHaBar === 'function') loadHaBar();
    if (!cfgHaEnabled) {
      renderHaStatus(j.status || { state: 'disabled' });
      setHaFeedback('');
      return;
    }
    await checkHaStatus(true);
  } catch (e) {
    cfgHaEnabled = !next;
    renderHaEnabledToggle();
    setHaFeedback(e.message, 'bad', t('mqtt.saveFailed', 'Save failed'));
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
    if (statusObj && statusObj.updateMode === 'websocket') {
      metric += ' · ' + (statusObj.wsConnected
        ? t('ha.updateMode.wsPushing', 'pushing changes')
        : t('ha.updateMode.wsReconnecting', 'reconnecting…'));
    }
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

async function checkHaStatus(showFeedback) {
  if (!(cfgHaEnabled && cfgHaUrl && cfgHaTokenSet)) {
    renderHaStatus(null);
    return;
  }
  renderHaStatus({ state: 'checking' });
  const errTitle = t('ha.testFailed', 'Connection failed');
  try {
    const r = await fetch(api('/api/ha/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const j = await r.json();
    if (j.ok) {
      renderHaStatus({ state: 'connected', message: j.message });
      if (showFeedback) setHaFeedback(t('ha.connected', 'Connected: {msg}', { msg: j.message || 'OK' }), 'good');
    } else {
      renderHaStatus({ state: 'error', error: j.error || errTitle });
      if (showFeedback) setHaFeedback(j.error || errTitle, 'bad', j.error ? errTitle : '');
    }
  } catch (e) {
    renderHaStatus({ state: 'error', error: e.message });
    if (showFeedback) setHaFeedback(e.message, 'bad', errTitle);
  }
}

async function saveHaSettings() {
  const btn = q('cfg-ha-save-btn');
  if (!btn) return;
  const url = q('cfg-ha-url') ? q('cfg-ha-url').value.trim() : '';
  const token = q('cfg-ha-token') ? q('cfg-ha-token').value.trim() : '';
  const payload = { enabled: cfgHaEnabled, url: url, tlsRejectUnauthorized: cfgHaVerify };
  if (token !== '') payload.token = token;
  else if (url === '') payload.clearToken = true;

  const saveErrTitle = t('mqtt.saveFailed', 'Save failed');
  btn.disabled = true;
  setHaFeedback(t('mqtt.saving', 'Saving...'));

  try {
    const r = await fetch(api('/api/ha/save'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!j.ok) {
      setHaFeedback(j.error || saveErrTitle, 'bad', j.error ? saveErrTitle : '');
      return;
    }
    cfgHaEnabled = j.enabled !== false;
    cfgHaUrl = j.url || '';
    cfgHaTokenSet = !!j.tokenSet;
    cfgHaVerify = j.tlsRejectUnauthorized !== false;
    cfgHaSavedVerify = cfgHaVerify;
    renderHaEnabledToggle();
    renderHaVerifyToggle();
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
    if (typeof loadHaBar === 'function') loadHaBar();

    if (!j.url && !j.tokenSet) {
      renderHaStatus(null);
      setHaFeedback(t('ha.cleared', 'Cleared.'));
      return;
    }
    if (!cfgHaEnabled) {
      renderHaStatus(j.status || { state: 'disabled' });
      setHaFeedback(t('ha.savedOff', 'Saved (Home Assistant API is turned off).'));
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
      setHaFeedback(t('ha.savedConnected', 'Saved — Connected: {msg}', { msg: tj.message || 'OK' }), 'good');
    } else {
      renderHaStatus({ state: 'error', error: tj.error || '' });
      setHaFeedback(t('ha.savedWarn', 'Saved (test failed: {err})', { err: tj.error || '' }), 'bad');
    }
  } catch (e) {
    setHaFeedback(e.message, 'bad', saveErrTitle);
  } finally {
    btn.disabled = false;
  }
}

async function testHaConnection() {
  const btn = q('cfg-ha-test-btn');
  if (!btn) return;
  const url = q('cfg-ha-url') ? q('cfg-ha-url').value.trim() : '';
  const token = q('cfg-ha-token') ? q('cfg-ha-token').value.trim() : '';

  const errTitle = t('ha.testFailed', 'Connection failed');
  btn.disabled = true;
  setHaFeedback(t('ha.testing', 'Testing connection...'));

  try {
    const r = await fetch(api('/api/ha/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, token: token || undefined, tlsRejectUnauthorized: cfgHaVerify })
    });
    const j = await r.json();
    const unsaved = (url !== cfgHaUrl) || (token !== '') || (cfgHaVerify !== cfgHaSavedVerify);
    if (j.ok) {
      if (!unsaved && cfgHaEnabled) renderHaStatus({ state: 'connected', message: j.message });
      setHaFeedback(unsaved
        ? t('ha.connectedUnsaved', 'Connected: {msg} (click Save to apply)', { msg: j.message || 'OK' })
        : t('ha.connected', 'Connected: {msg}', { msg: j.message || 'OK' }), 'good');
    } else {
      if (!unsaved && cfgHaEnabled) renderHaStatus({ state: 'error', error: j.error || '' });
      setHaFeedback(j.error || errTitle, 'bad', j.error ? errTitle : '');
    }
  } catch (e) {
    setHaFeedback(e.message, 'bad', errTitle);
  } finally {
    btn.disabled = false;
  }
}

