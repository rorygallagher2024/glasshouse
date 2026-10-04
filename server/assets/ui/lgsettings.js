// LG's own settings as controls, used by the Privacy, Advanced and Game tabs.

/* LG's own settings from lgsettings.js, as switches. Only the rows the TV
   reports come back, so a section with none stays hidden. */
function renderLgSettings(rows) {
  const promo = rows.filter(r => r.section === 'promotions');
  const d = q('pv-promo-d');
  if (d) d.hidden = !promo.length;
  const cur = q('pv-promo-cur');
  if (cur) {
    const onCount = promo.filter(r => r.on).length;
    cur.textContent = promo.length
      ? t('pv.groupOn', '{on} of {total} on', { on: onCount, total: promo.length }) : '';
  }
  q('pv-promo').innerHTML = promo.map(r =>
    `<div class="prot-row"><div class="prot-main"><div class="prot-title">${esc(r.title)}</div>` +
    `<div class="prot-desc">${esc(r.desc)}</div></div>` +
    `<div class="prot-status">${renderToggle({
      cls: r.on ? 'warn' : 'good',
      label: r.on ? t('common.on', 'On') : t('common.off', 'Off'),
      next: r.on ? '0' : '1',
      attrs: 'data-id="' + esc(r.id) + '"'
    })}</div></div>`).join('');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('#pv-promo button[data-id]');
  if (!b) return;
  b.disabled = true;
  await sendCommand('lgSetting', { id: b.dataset.id, on: b.dataset.next === '1' });
  loadPrivacy();
});

/* ---- LG's own settings --------------------------------------------------
   One row of lgsettings.js as a control: a pill for a switch, a list for a
   choice, a stepper for a number. After a change, the loader named by the
   nearest data-reload redraws the rows. */
function lgsControl(r) {
  // A setting the TV has greyed out, such as Deep Colour off an HDMI input.
  const id = ' data-lgs="' + esc(r.id) + '"' + (r.active === false ? ' disabled' : '');
  if (r.type === 'choice') {
    return '<select class="pill-sel"' + id + '>' +
      r.choices.map(c => '<option value="' + esc(c.value) + '"' + (c.value === r.value ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') +
      '</select>';
  }
  if (r.type === 'number') {
    return '<label class="lgs-range"><input type="range"' + id + ' min="' + r.min + '" max="' + r.max + '" step="1" value="' + r.value + '"' +
      ' aria-label="' + esc(r.title) + '"><span class="num">' + esc(lgsNumber(r.min, r.value)) + '</span></label>';
  }
  return renderToggle({
    cls: r.on ? 'good' : 'idle',
    label: r.on ? t('common.on', 'On') : t('common.off', 'Off'),
    attrs: 'data-lgs="' + esc(r.id) + '" data-on="' + (r.on ? '0' : '1') + '"' + (r.active === false ? ' disabled' : '')
  });
}

// A range either side of 0, as balance's is, reads the way LG labels it.
function lgsNumber(min, v) {
  if (min >= 0 || v === 0) return String(v);
  return v < 0 ? t('lgs.left', 'Left {n}', { n: -v }) : t('lgs.right', 'Right {n}', { n: v });
}

async function setLgs(el, value) {
  const box = el.closest('[data-reload]');
  await sendCommand('lgSetting', value === true || value === false ? { id: el.dataset.lgs, on: value } : { id: el.dataset.lgs, value });
  if (box && typeof window[box.dataset.reload] === 'function') window[box.dataset.reload]();
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-lgs]');
  if (!b) return;
  b.disabled = true;
  setLgs(b, b.dataset.on === '1');
});
document.addEventListener('change', e => {
  const sel = e.target.closest('select[data-lgs]');
  if (sel) setLgs(sel, sel.value);
  const range = e.target.closest('input[type=range][data-lgs]');
  if (range) setLgs(range, Number(range.value));
});
document.addEventListener('input', e => {
  const range = e.target.closest('input[type=range][data-lgs]');
  if (range) range.nextElementSibling.textContent = lgsNumber(Number(range.min), Number(range.value));
});

/*
 * HDMI inputs, a row each. A B8 keeps Deep Colour per port; a C2 keeps one,
 * for the input on screen, which LG reports as the dimension's gameInput, so
 * it goes in that input's row.
 */
function hdmiTable(rows, dims, inputs) {
  const cols = [['deepColor', t('lgs.hdmi.deepColor', 'Deep Colour')], ['audioFormat', t('lgs.hdmi.audioFormat', 'Audio format')]]
    .filter(c => rows.some(r => r.column === c[0]));
  const single = rows.find(r => r.column === 'deepColor' && !r.port);
  const on = /^hdmi(\d)$/.exec((dims.other && dims.other.gameInput) || '');
  const onPort = on ? Number(on[1]) : 0;
  const ports = [1, 2, 3, 4].filter(n => rows.some(r => r.port === n) || (single && n === onPort));
  const cell = (n, col) => {
    const r = rows.find(x => x.port === n && x.column === col) || (col === 'deepColor' && n === onPort ? single : null);
    return '<div>' + (r ? lgsControl(r) : '<span class="na">&mdash;</span>') + '</div>';
  };
  const intro = [t('lgs.hdmi.intro.deepColor', 'Deep Colour lets an input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree a change.')];
  if (single) intro.push(t('lgs.hdmi.intro.gameOptimizer', 'Turning it off also turns off Game Optimizer for that input.'));
  if (cols.some(c => c[0] === 'audioFormat'))
    intro.push(t('lgs.hdmi.intro.audioFormat', 'Audio format decides whether Dolby Atmos and DTS reach a soundbar or receiver: Bitstream passes them on, PCM asks for plain audio.'));
  intro.push(t('lgs.hdmi.intro.onScreen', 'As in LG\u2019s own menu, only the input on screen can be changed.'));
  return '<div class="pv-sub">' + esc(intro.join(' ')) + '</div>' +
    '<div class="hdmi-grid" style="grid-template-columns:minmax(150px,1.3fr)' + ' minmax(130px,1fr)'.repeat(cols.length) + '">' +
    '<div class="hh">' + esc(t('lgs.hdmi.input', 'Input')) + '</div>' + cols.map(c => '<div class="hh">' + esc(c[1]) + '</div>').join('') +
    ports.map(n => {
      const port = 'hdmi' + n, name = (inputs || lastInputNames)[port];
      const label = name && name.replace(/\s/g, '').toLowerCase() !== port ? name : 'HDMI ' + n;
      return '<div class="in"><b>' + esc(label) + '</b>' + (label !== 'HDMI ' + n ? '<span>HDMI ' + n + '</span>' : '') + '</div>' +
        cols.map(c => cell(n, c[0])).join('');
    }).join('') + '</div>';
}

// The Advanced tab's Sound section, and the SIMPLINK rows in Devices.
var advLgsDevices = false;   // read by tick(), which can run before this line on the first load
async function loadAdvSettings() {
  let d;
  try { d = await (await fetch(api('/api/lgsettings?section=sound,hdmi,devices'), { cache: 'no-store' })).json(); } catch (e) { return; }
  const row = r => '<div class="prot-row"><div class="prot-main"><div class="prot-title">' + esc(r.title) + '</div>' +
    '<div class="prot-desc">' + esc(r.desc) + (r.active === false ? ' ' + esc(t('lgs.inactive', 'Not available with the TV’s current input or sound output.')) : '') +
    '</div></div><div class="prot-status">' + lgsControl(r) + '</div></div>';
  const sound = (d.rows || []).filter(r => r.section === 'sound');
  const devices = (d.rows || []).filter(r => r.section === 'devices');
  const hdmi = (d.rows || []).filter(r => r.section === 'hdmi');
  q('adv-hdmi').hidden = !hdmi.length;
  q('adv-lgs-hdmi').innerHTML = hdmi.length ? hdmiTable(hdmi, d.dimensions || {}, d.inputs) : '';
  q('adv-sound').hidden = !sound.length;
  q('adv-lgs-sound').innerHTML = sound.map(row).join('');
  advLgsDevices = devices.length > 0;
  if (advLgsDevices) q('adv-devices').hidden = false;
  q('adv-lgs-devices').innerHTML = devices.map(row).join('');
}
