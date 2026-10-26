// The Privacy tab.

/* ---- privacy panel ----------------------------------------------------
   Loaded on demand: it costs several Luna calls, so there is no reason to
   poll it alongside the 2s telemetry tick. */


function pvPill(on, goodWhenOff) {
  // For privacy, "off" is the desirable state, so the colouring is inverted
  // relative to the metrics above.
  const cls = goodWhenOff ? (on ? 'warn' : 'good') : (on ? 'bad' : 'idle');
  return `<span class="pill ${cls}">${esc(on ? t('common.on', 'On') : t('common.off', 'Off'))}</span>`;
}

function pvConsentPill(f, writable) {
  if (!writable) return pvPill(f.enabled, true);
  if (!f.settable) return pvPill(f.enabled, true).replace('class="pill ', 'class="pill fixed ');
  return renderToggle({
    cls: f.enabled ? 'warn' : 'good',
    label: f.enabled ? t('common.on', 'On') : t('common.off', 'Off'),
    next: f.enabled ? '0' : '1',
    attrs: 'data-key="' + esc(f.key) + '"'
  });
}

function pvRow(name, detail, pillHtml) {
  return `<div class="pv-row"><div><div class="n">${name}</div>` +
         `<div class="d">${detail}</div></div><div>${pillHtml}</div></div>`;
}

/*
 * The short view the tab leads with. The server works out what is still on,
 * so this and the TV dashboard count the same things; the rest of the tab
 * sits under Advanced, unchanged.
 */
function renderSimple(d) {
  const sm = d.simple;
  q('ps').hidden = !sm;
  if (!sm) return;
  q('ps-dot').className = 'ps-dot ' + (sm.total ? 'warn' : 'good');
  q('ps-head').textContent = sm.total
    ? (sm.total === 1 ? t('pv.stillOn.one', '1 thing is still on') : t('pv.stillOn', '{n} things are still on', { n: sm.total }))
    : t('pv.allOff', 'Tracking and ads are off');
  q('ps-sub').textContent = sm.total
    ? t('pv.allOff.hint', 'Switching it all off includes blocking LG\u2019s ad and tracking servers. If an app stops working afterwards, switch the blocker off under Advanced.')
    : t('pv.allOff.watch', 'If an LG update switches anything back on, it shows here.');
  q('ps-areas').innerHTML = sm.areas.map(a => {
    const n = a.items.length;
    return `<div class="ps-area">` +
      `<span class="ps-st${n ? ' warn' : ''}">${esc(n ? t('pv.areaOn', '{n} on', { n }) : t('common.off', 'Off'))}</span>` +
      `<div class="n">${esc(a.name)}</div><div class="d">${esc(a.detail)}</div>` +
      (n ? `<div class="on"><b>${esc(t('pv.stillOnLabel', 'Still on'))}</b> &middot; ${a.items.map(i => esc(i.label)).join(', ')}</div>` : '') +
      `</div>`;
  }).join('');
  const go = q('ps-go');
  if (!go.dataset.busy) {
    go.disabled = !sm.total || d.consentWritable === false;
    go.textContent = sm.total ? t('pv.switchAllOff', 'Switch it all off') : t('pv.allSwitchedOff', 'All switched off');
  }
  q('ps-keep').hidden = !sm.kept.length;
  q('ps-keep').textContent = sm.kept.length
    ? t('pv.kept', 'Left on because they run features: {names}. They can be switched off under Advanced.', { names: sm.kept.join(', ') })
    : '';
}

async function switchAllOff() {
  const go = q('ps-go'), msg = q('ps-msg');
  go.disabled = true;
  go.dataset.busy = '1';
  go.classList.add('busy');
  go.textContent = t('pv.switchingOff', 'Switching off\u2026');
  msg.textContent = '';
  try {
    const r = await sendCommand('privacyAllOff');
    msg.textContent = r && r.ok ? t('pv.done', 'Done.') : '';
  } finally {
    delete go.dataset.busy;
    go.classList.remove('busy');
  }
  loadPrivacy();
}

async function loadPrivacy() {
  try {
    const r = await fetch(api('/api/privacy'), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    renderSimple(d);
    renderLgSettings(d.lgSettings || []);

    /* The heading is what this section is about; the description explains it
       and the rows report it. Previously the heading was generic and the ACR
       description sat under it as if it explained the whole panel. */
    const a = d.acr || {};
    /*
     * One vocabulary across the panel: amber is the TV collecting something,
     * green is it not. The description says what the row is, never what the
     * pill beside it already says.
     */
    // Allowed and running are separate checks: on a CX with Live Plus off acr2
    // was not running after boot, yet one question started it, and it then ran
    // idle until stopped.
    const allowedBy = [].concat(a.livePlus === null || a.livePlus === undefined ? [] : [t('pv.acr.livePlus', 'Live Plus')],
      (a.consents || []).map(c => c.label));
    const svc = a.active ? ['warn', t('pv.acr.recognizing', 'Recognizing')]
      : a.running ? ['idle', t('pv.acr.idle', 'Running, idle')]
      : ['good', t('pv.notRunning', 'Not running')];
    q('pv-live').innerHTML =
      pvRow(esc(t('pv.acr.consents', 'Recognition consents')),
          esc(allowedBy.length ? t('pv.acr.consents.desc', 'Whether LG\u2019s ACR is allowed: {names}.', { names: allowedBy.join(', ') })
                               : t('pv.acr.consents.none', 'This TV has none of the switches LG\u2019s ACR reads.')),
          `<span class="pill ${a.consentOn ? 'warn' : 'good'}">${esc(a.consentOn ? t('common.on', 'On') : t('common.off', 'Off'))}</span>`) +
      pvRow(esc(t('pv.acr.service', 'Recognition service')),
          esc(t('pv.acr.service.desc', 'LG\u2019s ACR program, acr2, which captures what\u2019s on your screen to target ads at you. Anything that asks it a question starts it.')),
          `<span class="pill ${svc[0]}">${esc(svc[1])}</span>`) +
      pvRow(esc(t('pv.capture', 'Screen capturing')), esc(t('pv.capture.desc', 'Sampling frames from the screen for recognition.')),
          `<span class="pill ${a.capturing ? 'warn' : 'good'}">${esc(a.capturing ? t('pv.capturing', 'Capturing') : t('pv.stopped', 'Stopped'))}</span>`);

    // The switch on the TV itself, on the models that have one. Off is the
    // private setting, as everywhere in this panel.
    const mic = d.microphone;
    q('pv-mic-grp').hidden = !mic;
    q('pv-mic').innerHTML = mic ? pvRow(esc(mic.label), esc(mic.detail),
      `<span class="pill ${mic.on ? 'warn' : 'good'}">${esc(mic.on ? t('common.on', 'On') : t('common.off', 'Off'))}</span>`) : '';

    // advertising id
    const ad = d.advertisingId || {};
    // The identifier itself is never sent to the browser, so it cannot end up
    // in a screenshot. Presence is all that is useful here.
    /* "Assigned" set in the heading face read as a section title rather than
       the state of the ID. It is a reading like any other in this panel, so it
       gets a row and a pill. */
    // available === false means the call does not exist on this firmware, which
    // is not the same answer as "no identifier assigned".
    // stopped: LG's ad service is not running, and asking would start it.
    const adOk = ad.available !== false;
    const lmtOk = adOk || !!ad.lmtKnown;
    q('pv-adid').innerHTML = pvRow(esc(t('pv.adid.row', 'Advertising ID')),
      esc(ad.stopped ? t('pv.adid.stopped', 'LG\u2019s advertising service is not running, so it is not handing out an ID.')
            : !adOk ? t('pv.adid.unreadable', 'This firmware does not answer the call that reads it.')
            : ad.present ? t('pv.adid.hidden', 'The value is deliberately not displayed here.')
                         : t('pv.adid.none', 'No identifier is currently assigned.')),
      ad.stopped ? `<span class="pill good">${esc(t('pv.notRunning', 'Not running'))}</span>`
            : !adOk ? `<span class="pill idle">${esc(t('pv.notReadable', 'Not readable'))}</span>`
            : `<span class="pill ${ad.present ? 'warn' : 'good'}">${esc(ad.present ? t('pv.adid.assigned', 'Assigned') : t('pv.adid.noneShort', 'None'))}</span>`);
    q('pv-lmt').innerHTML = pvRow(
      esc(ad.limitTrackingLabel || t('pv.lmt', 'Limit ad tracking')),
      esc(lmtOk ? (ad.limitTrackingDetail || '') : t('pv.lmt.unknown', 'Read from the same call, so it is unknown here.')),
      !lmtOk ? `<span class="pill idle">${esc(t('pv.unknown', 'Unknown'))}</span>`
            : d.consentWritable
            ? renderToggle({
                id: 'lmt-toggle',
                cls: ad.limitTracking ? 'good' : 'warn',
                label: ad.limitTracking ? t('common.on', 'On') : t('common.off', 'Off'),
                next: ad.limitTracking ? '0' : '1'
              })
            : `<span class="pill ${ad.limitTracking ? 'good' : 'warn'}">${esc(ad.limitTracking ? t('common.on', 'On') : t('common.off', 'Off'))}</span>`);
    // The two ad actions go through the same service, so they cannot work
    // either, and with it stopped they would start it.
    for (const id of ['adid-reset', 'adcookies-clear']) {
      const btn = q(id);
      if (btn) btn.disabled = !adOk;
    }

    // consent flags
    const c = d.consent || { known: [], other: [] };
    const cw = !!d.consentWritable;
    // A flag with no label falls back to its raw key, the only name it has.
    // A flag cannot be off while an agreement it shares stays accepted, so the
    // rows it takes with it are named before the click, not after.
    const shared = f => f.sharesWith && f.sharesWith.length
      ? ` <span class="k">&middot; ${esc(t('pv.sharesWith', 'switching this off also switches off {names}', { names: f.sharesWith.join(', ') }))}</span>`
      : '';
    const rows = c.known.map(f => ({ ...f, name: f.label, detail: esc(f.detail || '') + shared(f) }))
      .concat((c.other || []).map(f => ({
        ...f,
        name: f.label || f.key,
        detail: esc(f.detail || '') + shared(f)
      })));
    let html = '';
    for (const [id, title, note] of (d.consentGroups || [['unknown', '']])) {
      let inGroup = rows.filter(f => (f.group || 'unknown') === id);
      if (!inGroup.length) continue;
      const on = inGroup.filter(f => f.enabled).length;
      // Counted before the collapse below, or the heading would report on the
      // rows that survived rather than on the flags.
      const groupTotal = inGroup.length;
      /*
       * Flags with no name, no description and no agreement behind them are
       * one line rather than one row each: five rows reading "tied to no
       * agreement on this firmware" tell a reader nothing they cannot learn
       * from one, and the count still says if any of them is on.
       */
      let anon = [];
      if (id === 'unknown') {
        anon = inGroup.filter(f => !f.settable && !f.documents);
        inGroup = inGroup.filter(f => !anon.includes(f));
      }
      // A server that predates the grouping sends no titles; one unlabelled
      // heading above every row is worse than none.
      html += '<div class="pv-grp">' +
              (title ? `<div class="pv-g"><span>${esc(title)}</span>` +
                       `<span class="c">${esc(t('pv.groupOn', '{on} of {total} on', { on, total: groupTotal }))}</span></div>` : '') +
              (note ? `<div class="pv-gn">${esc(note)}</div>` : '') +
              inGroup.map(f => pvRow(esc(f.name), f.detail, pvConsentPill(f, cw))).join('') +
              (anon.length ? pvRow(
                esc(anon.length === 1 ? t('pv.anon.one', '1 unidentified flag') : t('pv.anon', '{n} unidentified flags', { n: anon.length })),
                esc(t('pv.anon.desc', 'Recorded by the TV, tied to no agreement on this firmware and not writable.')),
                `<span class="pill fixed ${anon.some(f => f.enabled) ? 'warn' : 'good'}">` +
                  esc(anon.some(f => f.enabled)
                    ? t('pv.areaOn', '{n} on', { n: anon.filter(f => f.enabled).length })
                    : t('pv.allOffShort', 'All off')) + '</span>') : '') +
              '</div>';
    }
    q('pv-consent').innerHTML = html || `<div class="d">${esc(t('pv.consent.failed', 'Could not read the agreements file.'))}</div>`;
    // The menu path is set in bold inside the sentence, so it goes in after escaping.
    q('pv-consent-note').innerHTML = cw
      ? esc(t('pv.consent.note', 'These write to the TV and survive a reboot. A flag records what the TV stored \u2014 it is not proof LG honours it.'))
      : esc(t('pv.consent.readOnly', 'Controls are disabled in config.json, so these can only be read. Change them on the TV under {path}.'))
          .replace('{path}', '<b>' + esc(t('pv.consent.path', 'Settings \u2192 General \u2192 About This TV \u2192 User Agreements')) + '</b>');
    /* A folded section still has to say where it stands, or folding it just
       hides the answer. Off is the private setting, so the count is of the
       agreements that are on. */
    const allConsent = (c.known || []).concat(c.other || []);
    const onCount = allConsent.filter(f => f.enabled).length;
    q('pv-consent-cur').textContent = allConsent.length
      ? t('pv.groupOn', '{on} of {total} on', { on: onCount, total: allConsent.length }) : '';

    // services
    /*
     * Only the supervised ones. A bus-activated service starts when anything
     * asks it a question, and this panel asks, so its row could report
     * "stopped" on the first load after a boot and "running" ever after -
     * a value caused by looking at it. The server still reports them.
     */
    const dae = (d.daemons || []).filter(x => !x.onDemand);
    q('pv-daemons').innerHTML = dae.map(x => {
      const state = x.running ? t('pv.running', 'Running') : t('pv.stopped', 'Stopped');
      const cls = x.running ? 'idle' : 'good';
      const note = x.heldDown ? ` <span class="k">&middot; ${esc(t('pv.heldDown', 'kept stopped at boot'))}</span>` : '';
      const pill = `<span class="pill ${cls}">${esc(state)}</span>`;
      return pvRow(esc(x.label), esc(x.detail) + note, pill);
    }).join('');
    const liveOn = (d.acr && d.acr.active ? 1 : 0) + (d.acr && d.acr.capturing ? 1 : 0);
    const total = dae.length + 2;
    // The rows only report; switching off is the Apps tab's background
    // services switch, which the note points to.
    q('pv-running-note').textContent = t('pv.runningNow.note',
      'A service can be running with its permission switched off \u2014 it simply has nothing it is allowed to send. They are switched off in the Apps tab, under Turn off background services, which keeps them off across reboots. LG\'s recognition and advertising services are not listed: anything that asks them a question starts them, so this panel asks them only while they are running.');

    q('pv-running-cur').textContent = dae.length
      ? t('pv.runningOf', '{n} of {total} running', { n: dae.filter(x => x.running).length + liveOn, total }) : '';

    // ad blocker
    const ab = d.adblock || {};
    const mode = ab.mode || (ab.enabled ? 'full' : 'off');
    q('adblock-detail').textContent = mode === 'off'
      ? t('pv.adblock.off.detail', 'Nothing is blocked. LG\u2019s advertising and telemetry addresses work as normal.')
      : mode === 'ads'
      ? t('pv.adblock.ads.detail', 'Blocks advertising, tracking and diagnostics addresses. LG\'s app store and software updates still work.')
      : mode === 'full'
      ? t('pv.adblock.full.detail', 'Also blocks LG\'s platform services, so the LG ThinQ app can no longer control the TV, and the app store, software updates and LG Channels may stop working.')
      : '';
    q('adblock-help').hidden = mode === 'off';
    for (const m of ['off', 'ads', 'full']) {
      const btn = q('ab-' + m);
      if (btn) btn.classList.toggle('on', m === mode);
    }
    renderCustomHosts(ab.custom, mode);
  } catch (e) {
    q('pv-live').innerHTML = `<div class="d">${esc(t('pv.failed', 'Could not load privacy information \u2014 {error}', { error: e.message }))}</div>`;
  }
}

/*
 * Delegated: the rows are re-rendered on every load, so per-button listeners
 * would have to be reattached each time.
 */
q('pv-lmt').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('#lmt-toggle');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '...';
  await sendCommand('limitAdTracking', btn.dataset.next === '1');
  loadPrivacy();
});
q('pv-consent').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button.pill[data-key]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '...';
  const r = await sendCommand('consent', { key: btn.dataset.key, enabled: btn.dataset.next === '1' });
  if (!r || !r.ok) { btn.disabled = false; loadPrivacy(); return; }
  loadPrivacy();
});


/*
 * LG's web apps run in one browser engine that stays up from boot, and it keeps
 * a looked-up address for about a minute: on a C2 (webOS 9.2) the Content
 * Store still failed 15 s after Everything was switched off and opened after a
 * minute, with LG's device sign-in fine throughout. So the note shows on
 * leaving Everything, for two minutes.
 */
let adblockReconnectTimer = null;

/*
 * Custom ad blocking: the owner's hosts list, kept on the TV. It can be
 * switched off without deleting it, and is used added to Glasshouse's list or
 * in place of it. Each action says how it went in the row itself, as the
 * page's error bar is out of sight this far down.
 */
let customHosts = null;
// How a list not yet uploaded will be used.
let customHostsMode = 'add';
// The last action's outcome, shown until the next: { text, bad }.
let customHostsNote = null;

function customHostsListText(cu) {
  if (!cu) return t('pv.adblock.custom.noList', 'None uploaded yet.');
  const when = cu.updated ? new Date(cu.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const names = t('pv.adblock.custom.summary', '{n} names', { n: cu.count });
  return [cu.file, names, when && t('pv.adblock.custom.uploaded', 'uploaded {date}', { date: when })].filter(Boolean).join(' · ');
}

function customHostsStatus(cu, mode) {
  if (!cu) return '';
  if (!cu.enabled) return t('pv.adblock.custom.isOff', 'Off: nothing in the file is blocked.');
  if (mode === 'off') return t('pv.adblock.custom.offNote', 'Nothing is blocked while the blocker is off.');
  const vars = { n: cu.count, own: cu.ownCount, shared: cu.shared };
  let text = cu.mode === 'add'
    ? t('pv.adblock.custom.addDetail', 'The file’s {n} names are blocked as well as Glasshouse’s {own} for this tier. In both: {shared}.', vars)
    : t('pv.adblock.custom.replaceDetail', 'Only the file’s {n} names are blocked, not Glasshouse’s {own} for this tier. In both: {shared}.', vars);
  // The ad blocker's own count: blocked software updates are a separate setting.
  return text + ' ' + t('pv.adblock.custom.total', 'The ad blocker blocks {n} names.', { n: cu.blocked });
}

function renderCustomHosts(cu, mode) {
  customHosts = cu || null;
  updateToggle('abc-enabled', {
    cls: cu && cu.enabled ? 'good' : 'idle',
    label: cu && cu.enabled ? t('common.on', 'On') : t('common.off', 'Off'),
    on: !!(cu && cu.enabled),
    disabled: !cu
  });
  q('abc-list').textContent = customHostsListText(cu);
  q('abc-upload').textContent = cu ? t('pv.adblock.custom.uploadNew', 'Upload a new file') : t('pv.adblock.custom.upload', 'Upload a file');
  q('abc-clear').hidden = !cu;
  q('abc-mode').value = cu ? cu.mode : customHostsMode;
  if (cu && cu.enabled && cu.mode === 'replace' && mode !== 'off') {
    q('adblock-detail').textContent = t('pv.adblock.custom.replacing',
      'Blocks the names in your hosts file and none of Glasshouse’s, on either tier.');
  }
  const el = q('abc-detail');
  el.textContent = customHostsNote ? customHostsNote.text : customHostsStatus(cu, mode);
  el.classList.toggle('bad', !!(customHostsNote && customHostsNote.bad));
  q('abc-summary').textContent = !cu ? t('pv.adblock.custom.notUsed', 'None')
    : cu.enabled ? t('pv.adblock.custom.onCount', 'On · {n} names', { n: cu.count })
    : t('common.off', 'Off');
}

function noteCustomHosts(text, bad) {
  // The server words some refusals for its log, starting in lower case.
  if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
  customHostsNote = text ? { text, bad: !!bad } : null;
  const el = q('abc-detail');
  if (!text) return;
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
}

async function postCustomHosts(body) {
  for (const id of ['abc-enabled', 'abc-upload', 'abc-clear', 'abc-mode']) q(id).disabled = true;
  try {
    const r = await fetch(api('/api/adblock/custom'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.ok) noteCustomHosts(null);
    else noteCustomHosts(j.error || t('common.actionFailed', 'Action failed'), true);
    return j;
  } catch (e) {
    noteCustomHosts(e.message, true);
    return null;
  } finally {
    for (const id of ['abc-upload', 'abc-clear', 'abc-mode']) q(id).disabled = false;
    await loadPrivacy();
  }
}

function toggleCustomHosts() {
  if (customHosts) postCustomHosts({ enabled: !customHosts.enabled });
}

function setCustomHostsMode(mode) {
  if (!customHosts) {
    customHostsMode = mode;
    return;
  }
  if (mode !== customHosts.mode) postCustomHosts({ mode });
}

async function uploadCustomHosts(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (f.size > 1000000) return noteCustomHosts(t('pv.adblock.custom.big', 'That file is over 1 MB.'), true);
  noteCustomHosts(t('pv.adblock.custom.uploading', 'Uploading {file}…', { file: f.name }));
  const mode = customHosts ? customHosts.mode : customHostsMode;
  const r = await postCustomHosts({ mode, text: await f.text(), file: f.name });
  // What the upload took and left out is said once, until the next action.
  if (r && r.ok && r.custom) {
    let text = t('pv.adblock.custom.saved', 'Saved {file}: {n} names.', { file: f.name, n: r.custom.count });
    if (r.skipped) text += ' ' + t('pv.adblock.custom.leftOut', 'Left out: {n}, as redirects or not host names.', { n: r.skipped });
    noteCustomHosts(text);
  }
}

async function clearCustomHosts() {
  if (!confirm(t('pv.adblock.custom.removeConfirm', 'Delete the hosts file from the TV?'))) return;
  customHostsMode = 'add';
  await postCustomHosts({ clear: true });
}

async function setAdBlockMode(mode) {
  const full = q('ab-full');
  const leavingFull = mode !== 'full' && !!(full && full.classList.contains('on'));
  if (mode === 'full' && !(full && full.classList.contains('on')) &&
      !confirm(t('pv.adblock.full.confirm', 'Everything also blocks LG\u2019s platform services, so the LG ThinQ app can no longer control the TV, and the app store, software updates and LG Channels may stop working. Switch to Everything?'))) return;
  for (const m of ['off', 'ads', 'full']) { const b = q('ab-' + m); if (b) b.disabled = true; }
  const r = await sendCommand('setAdBlock', mode);
  if (r && r.ok && leavingFull && q('adblock-reconnect')) {
    q('adblock-reconnect').hidden = false;
    clearTimeout(adblockReconnectTimer);
    adblockReconnectTimer = setTimeout(() => { q('adblock-reconnect').hidden = true; }, 120000);
  }
  await loadPrivacy();
  for (const m of ['off', 'ads', 'full']) { const b = q('ab-' + m); if (b) b.disabled = false; }
}

// Kept so the old control still works from anywhere that calls it.
function togglePrivacy() { showTab(activeTab === 'privacy' ? 'control' : 'privacy'); }

async function privAction(action) {
  const question = action === 'resetAdId' ? t('pv.adid.reset.confirm', 'Really reset the advertising ID?')
    : t('pv.cookies.clear.confirm', 'Really clear ad cookies?');
  if (!confirm(question)) return;
  const btn = q(action === 'resetAdId' ? 'adid-reset' : 'adcookies-clear');
  if (btn) btn.classList.add('busy');
  setBusy(true, 'tx');
  try {
    const r = await fetch(api('/api/control'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    setBusy(true, 'rx');
    const j = await r.json();
    if (!j.ok) { showErr(j.error || t('common.actionFailed', 'Action failed')); return; }
    if (action === 'resetAdId') {
      // The TV compared old and new for us; neither value came back.
      q('pv-adnote').textContent = j.changed
        ? t('pv.adid.reset.done', 'Reset \u2014 the TV issued a new identifier.')
        : t('pv.adid.reset.same', 'Reset was accepted, but the identifier did not change.');
    }
  } catch (e) { showErr(e.message); return; }
  finally {
    if (btn) btn.classList.remove('busy');
    setBusy(false);
  }
  setTimeout(loadPrivacy, 800);
}
