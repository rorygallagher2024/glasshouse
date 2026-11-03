// LG's own settings as controls, used by the Privacy, Advanced, Game, Audio
// and Picture tabs.

/* LG's own settings from lgsettings.js, as switches: its ads and promotions,
   and what it may upload. Only the rows the TV reports come back, so a
   section with none stays hidden. */
function renderLgSettings(rows) {
  renderLgSection(rows, 'promotions', 'pv-promo');
  renderLgSection(rows, 'uploads', 'pv-uploads');
}
function renderLgSection(rows, section, box) {
  const own = rows.filter(r => r.section === section);
  const d = q(box + '-d');
  if (d) d.hidden = !own.length;
  const cur = q(box + '-cur');
  if (cur) {
    const onCount = own.filter(r => r.on).length;
    cur.textContent = own.length
      ? t('pv.groupOn', '{on} of {total} on', { on: onCount, total: own.length }) : '';
  }
  const table = q(box);
  if (table) table.innerHTML = own.map(r =>
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
  const b = e.target.closest('#pv-promo button[data-id], #pv-uploads button[data-id]');
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
    // A picture setting reads as LG's menu shows it; its track, where it has
    // one, shows what the slider changes.
    const fmt = r.section === 'picture' ? (r.track || 'signed') : '';
    const cls = r.track ? ' class="lgs-track" data-track="' + esc(r.track) + '"' : '';
    return '<label class="lgs-range"><input type="range"' + id + cls + (fmt ? ' data-fmt="' + fmt + '"' : '') +
      ' min="' + r.min + '" max="' + r.max + '" step="1" value="' + r.value + '"' +
      ' aria-label="' + esc(r.title) + '"><span class="num">' + esc(lgsNumber(r.min, r.value, fmt)) + '</span></label>';
  }
  return renderToggle({
    cls: r.on ? 'good' : 'idle',
    label: r.on ? t('common.on', 'On') : t('common.off', 'Off'),
    attrs: 'data-lgs="' + esc(r.id) + '" data-on="' + (r.on ? '0' : '1') + '"' + (r.active === false ? ' disabled' : '')
  });
}

// A range either side of 0 reads the way LG labels it: balance as Left and
// Right, tint as R and G, colour temperature as Warm and Cool, and the rest of
// the picture settings as signed numbers.
function lgsNumber(min, v, fmt) {
  if (min >= 0 || v === 0) return String(v);
  if (fmt === 'tint') return v < 0 ? t('lgs.tintRed', 'R{n}', { n: -v }) : t('lgs.tintGreen', 'G{n}', { n: v });
  if (fmt === 'temperature') return v < 0 ? t('lgs.warm', 'Warm {n}', { n: -v }) : t('lgs.cool', 'Cool {n}', { n: v });
  if (fmt) return v < 0 ? '\u2212' + (-v) : '+' + v;
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
  if (range) range.nextElementSibling.textContent = lgsNumber(Number(range.min), Number(range.value), range.dataset.fmt);
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

// One of lgsettings.js's rows, for a .prot-table.
function lgsRow(r) {
  return '<div class="prot-row"><div class="prot-main"><div class="prot-title">' + esc(r.title) + '</div>' +
    '<div class="prot-desc">' + esc(r.desc) + (r.active === false ? ' ' + esc(lgsInactive(r)) : '') +
    '</div></div><div class="prot-status">' + lgsControl(r) + '</div></div>';
}

// Why a setting is greyed out: colour management says which (lgsettings.js colourManagementState).
function lgsInactive(r) {
  if (r.inactive === 'game') return t('pic.cms.game', 'Not used in Game mode.');
  if (r.inactive === 'colourAdjustment') return t('pic.cms.needsUser', 'Set Colour adjustment to User Selection to use these.');
  return r.section === 'picture'
    ? t('lgs.pictureInactive', 'Not available in the current picture mode, or for what is on screen.')
    : t('lgs.inactive', 'Not available with the TV’s current input or sound output.');
}

// The Advanced tab's HDMI inputs and the SIMPLINK rows in Devices. Sound, and
// each input's audio format, are on the Audio tab.
var advLgsDevices = false;   // read by tick(), which can run before this line on the first load
async function loadAdvSettings() {
  let d;
  try { d = await (await fetch(api('/api/lgsettings?section=hdmi,devices'), { cache: 'no-store' })).json(); } catch (e) { return; }
  const devices = (d.rows || []).filter(r => r.section === 'devices');
  const hdmi = (d.rows || []).filter(r => r.section === 'hdmi' && r.column !== 'audioFormat');
  q('adv-hdmi').hidden = !hdmi.length;
  q('adv-lgs-hdmi').innerHTML = hdmi.length ? hdmiTable(hdmi, d.dimensions || {}, d.inputs) : '';
  advLgsDevices = devices.length > 0;
  if (advLgsDevices) q('adv-devices').hidden = false;
  q('adv-lgs-devices').innerHTML = devices.map(lgsRow).join('');
}
