// The Picture tab: LG's picture settings for the picture on screen, grouped as
// LG's own Picture menu groups them. Which settings show, their choices and
// their ranges are the TV's; a setting the TV lacks or hides is left out.
let pictureTimer = null;
let pictureRevision = 0;
let pictureShown = '';

function picturePolling(on) {
  clearTimeout(pictureTimer);
  pictureTimer = null;
  if (on) pictureTimer = setTimeout(() => loadPicture(true), 5000);
}

// The sections in LG's order. White balance and colour management are folded,
// as the calibration they are.
const PICTURE_GROUPS = [
  ['brightness', () => t('pic.brightness', 'Brightness')],
  ['colour', () => t('pic.colour', 'Colour')],
  ['clarity', () => t('pic.clarity', 'Clarity')],
  ['motion', () => t('pic.motion', 'Motion')],
  ['aspect', () => t('pic.aspect', 'Aspect ratio')]
];
const CMS_COLOURS = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow'];

// The input LG keeps these settings for, as the TV names it.
function pictureInput(dim, inputs) {
  const input = dim && dim.input;
  const port = /^hdmi(\d)$/.exec(input || '');
  if (port) {
    const name = (inputs || {})[input];
    return name && name.replace(/\s/g, '').toLowerCase() !== input ? name : 'HDMI ' + port[1];
  }
  if (input === 'default') return t('pic.input.apps', 'apps');
  if (input === 'dtv' || input === 'atv' || input === 'tv') return t('pic.input.tv', 'TV channels');
  return input || t('pic.input.unknown', 'this input');
}

function pictureRange(range) {
  return ({ sdr: 'SDR', hdr: 'HDR', hlg: 'HLG', dolbyHdr: 'Dolby Vision', technicolorHdr: 'Technicolor HDR' })[range] || range || '';
}

async function loadPicture(fromPoll) {
  clearTimeout(pictureTimer);
  pictureTimer = null;
  const revision = ++pictureRevision;
  try {
    const res = await fetch(api('/api/picture'), { cache: 'no-store' });
    const d = await res.json();
    if (!res.ok || !d || d.ok === false) throw new Error((d && d.error) || t('common.unknownError', 'unknown error'));
    if (revision !== pictureRevision) return;
    renderPicture(d, fromPoll === true);
    pictureError('');
  } catch (e) {
    if (revision === pictureRevision && fromPoll !== true) pictureError(e.message);
  } finally {
    if (revision === pictureRevision && activeTab === 'picture') picturePolling(true);
  }
}

function pictureError(message) {
  const el = q('pic-error');
  el.innerHTML = message ? `<b>${esc(t('pic.readFailed', 'The TV’s picture settings could not be read.'))}</b>${esc(sentence(message))}` : '';
  el.hidden = !message;
}

// The tab is shown only where the TV offers picture settings, as the Game tab
// is only where it has a Game Optimizer.
async function checkPictureTab() {
  let d;
  try { d = await (await fetch(api('/api/picture'), { cache: 'no-store' })).json(); } catch (e) { return; }
  setPictureAvailable(!!(d && d.available));
}

function setPictureAvailable(on) {
  if (q('tab-btn-picture')) q('tab-btn-picture').hidden = !on;
  if (!on && activeTab === 'picture') showTab('control');
}

function renderPicture(d, fromPoll) {
  setPictureAvailable(d.available !== false);
  if (d.available === false) return;
  // A poll that finds nothing new leaves the page alone, and one that does
  // waits while a control is in use, so a slider is not redrawn under a drag.
  const shown = JSON.stringify([d.rows, d.dimension, d.writable]);
  if (fromPoll && shown === pictureShown) return;
  if (fromPoll && document.activeElement && document.activeElement.closest('#picpane select, #picpane input')) return;
  pictureShown = shown;

  const rows = d.rows || [];
  const mode = rows.find(r => r.id === 'pictureMode');
  const dim = d.dimension || {};
  q('pic-now').hidden = !mode;
  if (mode) {
    const name = (mode.choices.find(c => c.value === mode.value) || {}).label || mode.value;
    q('pic-mode').textContent = name;
    const range = pictureRange(dim.dynamicRange);
    q('pic-scope').textContent = range
      ? t('pic.scope', 'For {input}, in {range}. The TV keeps these settings for each input and picture mode, so they change with what is on screen.', { input: pictureInput(dim, d.inputs), range })
      : t('pic.scopeNoRange', 'For {input}. The TV keeps these settings for each input and picture mode, so they change with what is on screen.', { input: pictureInput(dim, d.inputs) });
    q('pic-mode-ctl').innerHTML = lgsControl(mode).replace(/<select\b/, '<select aria-label="' + esc(mode.title) + '"');
  }

  // Options of the mode itself, such as Filmmaker Mode's auto start, under it.
  const extra = rows.filter(r => r.group === 'mode' && r.id !== 'pictureMode');
  let html = extra.length ? '<div class="prot-table pic-extra">' + extra.map(pictureRow).join('') + '</div>' : '';
  PICTURE_GROUPS.forEach(([group, title]) => {
    const list = rows.filter(r => r.group === group);
    if (!list.length) return;
    html += '<div class="pv-sec pic-sec">' + esc(title()) + '</div><div class="prot-table">' + list.map(pictureRow).join('') + '</div>';
  });
  const wb = rows.filter(r => r.group === 'whiteBalance');
  if (wb.length) {
    html += '<details class="pv-d pic-fold" data-fold="wb"><summary><span class="pic-fold-t"><span>' + esc(t('pic.whiteBalance', 'White balance')) + '</span>' +
      '<span class="pv-sub">' + esc(t('pic.whiteBalance.desc', 'Two-point calibration of the white point: gain sets each colour in the bright tones, offset in the dark. Leave at 0 without a meter.')) + '</span></span></summary>' +
      '<div class="prot-table pic-wb">' + wb.map(pictureRow).join('') + '</div></details>';
  }
  const cms = rows.filter(r => r.group === 'cms');
  if (cms.length) html += cmsFold(cms);
  // Keep open folds open across a redraw.
  const open = [...q('pic-groups').querySelectorAll('details[open]')].map(x => x.dataset.fold);
  q('pic-groups').innerHTML = html;
  open.forEach(f => { const x = q('pic-groups').querySelector('details[data-fold="' + f + '"]'); if (x) x.open = true; });
  if (!d.writable) q('picpane').querySelectorAll('button[data-lgs],select[data-lgs],input[data-lgs]').forEach(el => { el.disabled = true; });
}

function pictureRow(r) {
  return lgsRow(r).replace(/<(select|button)\b/, '<$1 aria-label="' + esc(r.title) + '"');
}

// Six colours down, saturation, hue and luminance across, each colour named
// beside its own swatch.
function cmsFold(rows) {
  const parts = [['saturation', t('pic.cms.saturation', 'Saturation')], ['hue', t('pic.cms.hue', 'Hue')], ['luminance', t('pic.cms.luminance', 'Luminance')]];
  const names = { red: t('pic.cms.red', 'Red'), green: t('pic.cms.green', 'Green'), blue: t('pic.cms.blue', 'Blue'),
    cyan: t('pic.cms.cyan', 'Cyan'), magenta: t('pic.cms.magenta', 'Magenta'), yellow: t('pic.cms.yellow', 'Yellow') };
  const colours = CMS_COLOURS.filter(c => rows.some(r => r.cms === c));
  // Colour adjustment, where it switches them on, heads them, with why they are greyed out.
  const gate = rows.find(r => !r.cms);
  const off = rows.find(r => r.cms && r.inactive);
  const head = (gate ? '<div class="prot-table pic-cms-gate">' + lgsRow(gate) + '</div>' : '') +
    (off ? '<div class="sub pic-cms-note">' + esc(lgsInactive(off)) + '</div>' : '');
  // On a phone the columns stack, so each slider carries its own label.
  const cell = (c, part) => {
    const r = rows.find(x => x.cms === c && x.part === part[0]);
    return '<div><span class="pic-part">' + esc(part[1]) + '</span>' + (r ? lgsControl(r) : '<span class="na">&mdash;</span>') + '</div>';
  };
  return '<details class="pv-d pic-fold" data-fold="cms"><summary><span class="pic-fold-t"><span>' + esc(t('pic.cms', 'Colour management')) + '</span>' +
    '<span class="pv-sub">' + esc(t('pic.cms.desc', 'Adjusts one colour at a time: how strong it is, which way its hue leans, and how bright it is.')) + '</span></span></summary>' +
    head + '<div class="pic-cms' + (off ? ' off' : '') + '"><div class="hh"></div>' + parts.map(p => '<div class="hh">' + esc(p[1]) + '</div>').join('') +
    colours.map(c => '<div class="in"><i class="pic-sw" data-colour="' + c + '"></i>' + esc(names[c]) + '</div>' + parts.map(p => cell(c, p)).join('')).join('') +
    '</div></details>';
}
