// The OLED care tab.

let oledWritable = true;

// Built when the tab renders rather than at load, so the text is looked up
// after the page's language is known.
const OLED_ROWS = () => [
  { key: 'screenShift', name: t('oled.shift', 'Screen Shift'), sub: t('oled.shift.sub', 'Pixel orbiting'),
    desc: t('oled.shift.desc', 'Nudges the whole picture by a pixel at a time so a static edge never sits on the same line for long. Costs nothing visually.'),
    kind: 'shift' },
  { key: 'logoDimming', name: t('oled.logo', 'Logo Dimming'), sub: t('oled.logo.sub', 'Local dimming'),
    desc: t('oled.logo.desc', 'Dims only the static logos and banners a channel leaves in a corner, and leaves the rest of the picture alone.'),
    kind: 'logo' },
  { key: 'tpc', name: t('oled.tpc', 'Temporal Peak Control'), sub: 'ASBL', guarded: true,
    desc: t('oled.tpc.desc', 'Lowers overall brightness when a bright image is held, which is what makes a mostly-white screen fade after a few seconds. Switching it off keeps full brightness and puts more heat through the panel.'),
    kind: 'protection' },
  { key: 'gsr', name: t('oled.gsr', 'Global Stress Reduction'), sub: 'GSR', guarded: true,
    desc: t('oled.gsr.desc', 'Dims the whole screen when it detects a stationary element such as a HUD or news ticker. Switching it off stops the dimming and leaves that element burning in at full brightness.'),
    kind: 'protection' }
];

async function loadOledCare() {
  let d;
  try {
    d = await (await fetch(api('/api/oledcare'), { cache: 'no-store' })).json();
  } catch (e) { showErr(e.message); return; }
  if (!d || !d.ok) { showErr((d && d.error) || t('oled.readFailed', 'Could not read the panel protections')); return; }
  oledWritable = d.writable;

  const state = v => v === null || v === undefined ? null : !!v;
  const onOff = on => on ? t('common.on', 'On') : t('common.off', 'Off');
  const html = OLED_ROWS().map(r => {
    // Marked apart only when they can actually be changed here - the warning
    // that explains the colour is hidden otherwise.
    let pill, cls = (r.guarded && d.serviceControls) ? ' guarded' : '';
    if (r.kind === 'shift') {
      const on = /on/i.test(d.screenShift || '');
      pill = renderToggle({
        cls: on ? 'good' : 'idle',
        label: onOff(on),
        next: on ? 'off' : 'on',
        attrs: 'data-oled="screenShift"'
      });
    } else if (r.kind === 'logo') {
      const v = String(d.logoDimming || 'off').toLowerCase();
      const label = v === 'strong' ? t('oled.logo.high', 'High') : v === 'light' ? t('oled.logo.light', 'Light') : t('common.off', 'Off');
      pill = renderToggle({
        cls: v === 'off' ? 'idle' : 'good',
        label: label,
        next: v === 'off' ? 'light' : (v === 'light' ? 'strong' : 'off'),
        attrs: 'data-oled="logoDimming"'
      });
    } else {
      const on = state(d[r.key]);
      if (on === null) {
        /*
         * Not a pill: there is nothing to press and nothing to report, and a
         * greyed-out control reads as a fault. The protection is almost
         * certainly running - LG ships them on - the set just gives no way to
         * see or change it, which is what this says.
         */
        cls += ' silent';
        pill = `<span class="oled-none">${t('oled.notAdjustable', 'Not adjustable on this TV')}</span>`;
      } else if (!d.serviceControls) {
        pill = `<span class="pill ${on ? 'good' : 'bad'} fixed">${onOff(on)}</span>`;
      } else {
        pill = renderToggle({
          cls: on ? 'good' : 'bad',
          label: onOff(on),
          next: on ? '0' : '1',
          attrs: 'data-oled="' + esc(r.key) + '"'
        });
      }
    }
    return `<div class="oled-row${cls}">
      <div class="oled-main">
        <div class="oled-name">${r.name}<span class="oled-sub">${r.sub}</span></div>
        <div class="oled-desc">${r.desc}</div>
      </div>
      <div class="oled-ctl">${pill}</div>
    </div>`;
  }).join('');

  q('oled-rows').innerHTML = html;

  const hrs = v => v === null || v === undefined ? null :
    (v >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString());
  q('oc-hours').textContent = d.panelHours === null ? '—' : Number(d.panelHours).toLocaleString();
  const inHours = v => hrs(v) === null ? '\u2014' : t('oled.hoursShort', '{n} h', { n: hrs(v) });
  q('oc-comp').textContent = inHours(d.hoursUntilComp);
  q('oc-refr').textContent = inHours(d.hoursUntilRefresher);
  // compStatus and refresherStatus are the TV's own words, in English.
  q('oc-comp-sub').textContent = d.compStatus ? d.compStatus : t('oled.comp.sub', '4-hour short cycle');
  q('oc-refr-sub').textContent = d.refresherStatus ? d.refresherStatus : t('oled.refresher.sub', '2,000-hour calibration');
  const counts = [
    { n: d.compCycles, name: t('oled.cycles.comp', 'Short cycles completed'),
      desc: t('tv.oled.shortCyclesCompleted.hint', 'How many short compensation passes the panel has run.') },
    { n: d.refresherCycles, name: t('oled.cycles.refresher', 'Pixel refresher cycles'),
      desc: t('tv.oled.pixelRefresherCycles.hint', 'How many long calibrations the panel has run. These are the ones that matter for wear.') },
    { n: d.failureAlerts, name: t('oled.cycles.failures', 'Refresher failure alerts'),
      desc: t('oled.cycles.failures.desc', 'Maintenance passes the TV recorded as not finishing. Normally zero.') },
    { n: d.gsrStressCount, name: t('oled.cycles.gsr', 'GSR stress events'),
      desc: t('oled.cycles.gsr.desc', 'How often Global Stress Reduction has dimmed the screen for something static. A count that climbs quickly means the same image is held on screen for long stretches.') }
  ].filter(c => c.n !== null && c.n !== undefined);
  q('oc-cycles').innerHTML = counts.map(c => `<div class="oc-count">
      <div class="oc-count-top"><span>${esc(c.name)}</span><b class="num">${Number(c.n).toLocaleString()}</b></div>
      <div class="oc-count-desc">${esc(c.desc)}</div>
    </div>`).join('');
  q('oc-counts').hidden = !counts.length;
  q('oled-warn').hidden = !d.serviceControls;
  q('oled-rows').querySelectorAll('button.pill').forEach(b => { b.disabled = !d.writable; });
}

document.addEventListener('click', async ev => {
  if (!ev.target.closest) return;
  const btn = ev.target.closest('#oled-rows button.pill[data-oled]');
  if (!btn || btn.disabled) return;
  const key = btn.dataset.oled, next = btn.dataset.next;
  btn.disabled = true;
  if (key === 'screenShift') {
    await sendCommand('screenShift', next);
  } else if (key === 'logoDimming') {
    await sendCommand('logoDimming', next);
  } else {
    const on = next === '1';
    if (!on && !confirm(t('oled.protection.confirm', 'Switching this off removes a protection against burn-in. Continue?'))) {
      btn.disabled = false;
      return;
    }
    await sendCommand('oledProtection', { key, enabled: on });
  }
  loadOledCare();
});
