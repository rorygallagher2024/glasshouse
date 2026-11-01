// ---------------------------------------------------------------- Internet TV channels

/*
 * The full-screen channel manager under the Home tab: a subscription's
 * groups on the left, the channels of one group or a search in the middle,
 * and the lineup on the right, numbered as the TV numbers it (lib/iptv-lineup).
 * A whole group added follows the provider; channels picked one by one keep
 * the owner's order; up to 60 are starred for Home's row. Narrow screens get
 * one pane at a time.
 *
 * Rows are selected (click, Shift-click for a range, a header box for all)
 * and the bar at the bottom acts on the selection. Every edit can be taken
 * back with Undo; the server keeps the last 20.
 */
const tvm = {
  open: false,
  pane: 'groups',         // the pane shown on a narrow screen
  playlists: [],
  pl: null,
  groups: null,           // { pl, list, total, channels, cut }
  filter: '',
  showHidden: false,
  view: null,             // { kind: 'group'|'search', group, q, list, total, page, busy, gen, inGroup }
  lineup: null,           // /api/iptv/lineup
  collapsed: {},          // section id -> true
  favsOpen: false,        // Home's row listed in full to arrange it, rather than as a line of names
  editing: null,          // { kind: 'name'|'section'|'from', id }
  armed: null,            // 'clear' while Clear the lineup waits for its second press
  sel: { scope: null, ids: new Set(), anchor: null, items: new Map() },
  menu: false,            // the bar's Add to or Move to list
  toast: null,
  poll: null,
  drag: null
};
const TVM_PAGE = 100;
const TVM_ALL_MAX = 2000;

// Controls can be off in config.json; the server says so with the playlists.
function tvmWritable() { return !tvm.status || tvm.status.writable !== false; }

async function tvmOpen(pane) {
  tvm.open = true;
  if (pane) tvm.pane = pane;
  setQueryParam('tv', 'channels');
  document.documentElement.classList.add('tvm-on');
  q('tvm').hidden = false;
  renderTvm();
  await tvmLoad();
  const f = q('tvm-find');
  if (f && !matchMedia('(pointer: coarse)').matches) f.focus();
}

function tvmClose() {
  tvm.open = false;
  clearTimeout(tvm.poll);
  tvmSelClear();
  setQueryParam('tv', null);
  document.documentElement.classList.remove('tvm-on');
  q('tvm').hidden = true;
  if (typeof homeTvLoad === 'function') homeTvLoad().then(() => { renderHomeTv(); loadHome(); });
}

function setQueryParam(key, value) {
  const s = new URLSearchParams(location.search);
  if (value === null) s.delete(key); else s.set(key, value);
  history.replaceState(history.state, '', location.pathname + (s.toString() ? '?' + s : '') + location.hash);
}

function tvmTyping(el) { return el && (el.tagName === 'INPUT' && el.type !== 'checkbox' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'); }

document.addEventListener('keydown', e => {
  if (!tvm.open) return;
  const typing = tvmTyping(e.target);
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (tvm.menu) { tvm.menu = false; return renderTvmDock(); }
    if (tvm.editing) { tvm.editing = null; return renderTvmLineup(); }
    if (e.target && e.target.id === 'tvm-find' && e.target.value) { e.target.value = ''; return tvmFind(''); }
    if (tvm.sel.ids.size) return tvmSelClear();
    return tvmClose();
  }
  if (typing) return;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return tvmUndo(); }
  if (mod && e.key.toLowerCase() === 'a') {
    const scope = tvm.sel.scope || (tvm.view ? 'channels' : null);
    if (scope) { e.preventDefault(); tvmSelAll(scope, tvmShownKeys(scope), true); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && tvm.sel.ids.size && tvm.sel.scope !== 'groups') {
    e.preventDefault();
    tvmBarAction('out');
  }
});

// A click anywhere but the bar's open list closes it.
document.addEventListener('click', e => {
  if (tvm.open && tvm.menu && !e.target.closest('.tvm-dock-wrap')) { tvm.menu = false; renderTvmDock(); }
});

async function tvmLoad() {
  try {
    const st = await homeGet('/api/iptv/playlists');
    tvm.playlists = st.playlists.filter(p => p.ready);
    tvm.status = st;
  } catch (e) { tvm.playlists = []; }
  if (!tvm.pl || !tvm.playlists.some(p => p.id === tvm.pl)) tvm.pl = tvm.playlists.length ? tvm.playlists[0].id : null;
  await Promise.all([tvmLoadGroups(), tvmLoadLineup()]);
  renderTvm();
}

async function tvmLoadGroups() {
  if (!tvm.pl) { tvm.groups = null; return; }
  try {
    const r = await homeGet('/api/iptv/groups?pl=' + encodeURIComponent(tvm.pl));
    tvm.groups = { pl: tvm.pl, list: r.groups, total: r.total, channels: r.channels, cut: r.cut };
  } catch (e) { tvm.groups = { pl: tvm.pl, list: [], total: 0, channels: 0, error: e.message }; }
}

/*
 * The lineup, and again every two seconds while the TV reads channels for it
 * (a group just added has no channels until the select job has run).
 */
async function tvmLoadLineup() {
  try { tvm.lineup = await homeGet('/api/iptv/lineup'); } catch (e) { tvm.lineup = null; }
  clearTimeout(tvm.poll);
  const waiting = tvm.lineup && (tvm.lineup.sections.some(s => s.state === 'pending') || tvm.lineup.channels.some(c => c.pending));
  if (waiting && tvm.open) {
    tvm.poll = setTimeout(async () => {
      await tvmLoadLineup();
      renderTvmLineup();
      if (tvm.view) tvmMark();
      renderTvmChannels();
      await tvmLoadGroups();
      renderTvmGroups();
      renderTvmHead();
    }, 2000);
  }
}

/*
 * One edit. say, when given, makes the message shown after it from the
 * reply and the lineup's size before; bulk and destructive edits say what
 * they did, with Undo beside it.
 */
async function tvmEdit(body, keepView, say) {
  const before = tvm.lineup ? tvm.lineup.channels.length : 0;
  try {
    const r = await homePost('/api/iptv/lineup', body);
    await tvmLoadLineup();
    if (!keepView && tvm.view) tvmMark();
    tvmSelPrune();
    renderTvmLineup();
    renderTvmChannels();
    tvmLoadGroups().then(() => { renderTvmGroups(); renderTvmHead(); });
    renderTvmHead();
    if (say) tvmToast(say(r, before), true);
    return r;
  } catch (e) {
    tvmToast(tvmError(e.message), false, true);
    return null;
  }
}

async function tvmUndo() {
  if (!tvm.lineup || !tvm.lineup.undo) return;
  tvmSelClear();
  const r = await tvmEdit({ action: 'undo' });
  if (r) tvmToast(t('home.tvm.undone', 'Undone.'), false);
}

function tvmError(code) {
  const max = tvm.lineup ? tvm.lineup.max : 2000;
  return {
    full: t('home.tvm.err.full', 'Home’s row holds {n} channels. Take a star off one first.', { n: tvm.lineup ? tvm.lineup.maxFavourites : 60 }),
    'lineup-full': t('home.tvm.err.lineupFull', 'The lineup holds {n} channels. Take a section or some channels out first.', { n: max.toLocaleString() }),
    sections: t('home.tvm.err.sections', 'The lineup holds 100 sections.'),
    'not-in-lineup': t('home.tvm.err.notIn', 'Add the channel to the lineup before starring it.'),
    from: t('home.tvm.err.from', 'A section starts at a whole number from 1 to 9999.'),
    'too-big': t('home.tvm.err.tooBig', 'That is more than the TV takes in one change. Add them in smaller batches.'),
    undo: t('home.tvm.err.undo', 'There is nothing to undo. The TV forgets past edits when it restarts.')
  }[code] || code;
}

// A message at the foot of the page, with Undo when the edit can be taken back.
function tvmToast(text, undo, error) {
  clearTimeout(tvm.toast && tvm.toast.timer);
  tvm.toast = { text, undo: !!undo, error: !!error, timer: setTimeout(() => { tvm.toast = null; renderTvmToast(); }, undo ? 9000 : 5000) };
  renderTvmToast();
}

function renderTvmToast() {
  const box = q('tvm-toast');
  if (!box) return;
  const m = tvm.toast;
  box.hidden = !m;
  if (!m) return;
  box.className = 'tvm-toast' + (m.error ? ' err' : '');
  box.innerHTML = `<span>${esc(m.text)}</span>${m.undo ? `<button type="button" class="tvm-toast-btn" onclick="tvmUndo()">${esc(t('home.tvm.undo', 'Undo'))}</button>` : ''}`;
}

function tvmPlural(n, one, many) { return n === 1 ? one : many; }

// The lineup's channels, by id, for marking search and group results.
function tvmLineupIndex() {
  const out = {};
  (tvm.lineup ? tvm.lineup.channels : []).forEach(c => { out[c.id] = c; });
  return out;
}

function tvmMark() {
  const idx = tvmLineupIndex();
  (tvm.view.list || []).forEach(c => {
    const l = idx[c.pl + ':' + c.key];
    c.added = !!l;
    c.lnum = l ? l.number : '';
    c.fav = !!(l && l.fav);
  });
}

function tvmPlayable(c) { return !c.headers && !c.drm && !c.unsupported; }

// ---- providers' names

/*
 * A provider's name as the page shows it: the tier or country before it
 * ("VIP: ", "UK| ") as a quiet prefix, quality marks ("ᴴᴰ ʰᵉᵛᶜ", a trailing
 * "HEVC HD") as tags, capitals in title case, and decoration ("◉") gone.
 * Nothing is dropped, so variants still tell apart. Home does the same in
 * home.html's tidyName, where the prefix and most tags go.
 */
const TVM_SUPER = { 'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E', 'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I', 'ᴶ': 'J', 'ᴷ': 'K', 'ᴸ': 'L', 'ᴹ': 'M', 'ᴺ': 'N',
  'ᴼ': 'O', 'ᴾ': 'P', 'ᴿ': 'R', 'ᵀ': 'T', 'ᵁ': 'U', 'ⱽ': 'V', 'ᵂ': 'W', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g',
  'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v',
  'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+' };
const TVM_SUPER_RE = /[\u1d2c-\u1d6a\u1d9c-\u1dbf\u02b0-\u02ff\u2070-\u209f\u2c7d\u00b9\u00b2\u00b3]+/g;
const TVM_MARK = '(?:HD|FHD|UHD|SD|LQ|4K|8K|HEVC|H\\.?26[45]|RAW|HDR|\\d{2,3} ?FPS|\\d{3,4}P)';
// One or more quality marks ending a name, alone or joined by slashes: " HEVC HD", " HD/4K".
const TVM_TAIL_RE = new RegExp('\\s+(' + TVM_MARK + '(?:/' + TVM_MARK + ')*)$', 'i');
const TVM_WORDS = new Set(['and', 'the', 'of', 'on', 'in', 'at', 'to', 'for', 'one', 'two', 'sky', 'mix', 'box', 'max', 'now', 'plus', 'gold', 'life', 'kids',
  'news', 'live', 'main', 'event', 'club', 'arena', 'extra', 'film', 'films', 'sport', 'sports', 'more', 'red', 'blue', 'jr', 'pop', 'fox', 'hits', 'all', 'mtv']);
const TVM_ACRONYMS = new Set(['CITV', 'EWTN', 'ESPN', 'HBO', 'AMC', 'TCM', 'MTV', 'DAZN', 'BEIN', 'RTE', 'TG4', 'ORF', 'ZDF', 'ARD', 'RAI']);
const tvmTidyCache = new Map();

function tvmTitleCase(s) {
  if (/[a-z]/.test(s)) return s;
  // Short words and ones with no vowel (CBBC, CNBC) stay as acronyms.
  return s.replace(/[A-Z][A-Z0-9'\u00c0-\u00de]*/g, w => (w.length <= 3 && !TVM_WORDS.has(w.toLowerCase())) || !/[AEIOUY]/.test(w) || TVM_ACRONYMS.has(w)
    ? w : w.charAt(0) + w.slice(1).toLowerCase());
}

function tvmTidy(raw) {
  raw = String(raw || '');
  if (tvmTidyCache.has(raw)) return tvmTidyCache.get(raw);
  const tags = [];
  const tag = t0 => { t0 = t0.toUpperCase(); if (t0 && !tags.includes(t0)) tags.push(t0); };
  let name = raw.replace(TVM_SUPER_RE, m => { tag(Array.from(m, ch => TVM_SUPER[ch] || '').join('')); return ' '; });
  // Decoration, and the emoji selectors some providers leave without their emoji.
  name = name.replace(/[\u2190-\u21ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u200d]+/g, ' ');
  let pre = '';
  name = name.replace(/^\s*(?:\[([^\]]{1,8})\]|([A-Z0-9+]{2,6})\s*[:|\u2022-])\s*/, (m, a, b) => { pre = a || b; return ''; });
  name = name.replace(/\s+/g, ' ').replace(/[\s\/|:&-]+$/, '');
  const tail = [];
  for (let m; (m = name.match(TVM_TAIL_RE)); ) { tail.unshift(...m[1].replace(/\s/g, '').split('/')); name = name.slice(0, m.index); }
  tail.forEach(tag);
  name = name.replace(/^[\s\/|:&-]+|[\s\/|:&-]+$/g, '');
  // Nothing but a prefix and marks ("4K| ᵁᴴᴰ"): the prefix is the name.
  if (!name && pre) { name = pre; pre = ''; }
  const out = { pre, name: tvmTitleCase(name) || raw, tags };
  if (tvmTidyCache.size > 20000) tvmTidyCache.clear();
  tvmTidyCache.set(raw, out);
  return out;
}

// A name as markup: prefix, name (cut with an ellipsis), tags. A name the owner chose stands as written.
function tvmNameHtml(raw, opts) {
  const o = opts || {};
  if (o.asWritten) return `<span class="tvm-nm" translate="no"><span class="tvm-c-name">${esc(raw)}</span></span>`;
  const n = tvmTidy(raw);
  return `<span class="tvm-nm" translate="no" title="${esc(raw)}">${n.pre && !o.noPre ? `<span class="tvm-pre">${esc(n.pre)}</span>` : ''}<span class="tvm-c-name">${esc(n.name)}</span>${
    n.tags.length ? `<span class="tvm-tags">${n.tags.map(x => `<i>${esc(x)}</i>`).join('')}</span>` : ''}</span>`;
}

// Plain text for messages: the tidy name and nothing else.
function tvmPlain(raw) { return tvmTidy(raw).name; }

// A group as plain text, its country or tier kept: "UK General".
function tvmGroupLabel(raw) {
  const n = tvmTidy(raw);
  return n.pre ? n.pre + ' ' + n.name : n.name;
}

// ---- selection

/*
 * One selection at a time, in one pane (scope): groups by name, channels by
 * id (kept with their details, so a selection can grow over several searches),
 * or the lineup's channels by id.
 */
function tvmSelKeys(scope) {
  if (scope === 'groups') {
    const { shown, hidden } = tvmShownGroups();
    return shown.concat(tvm.showHidden ? hidden : []).map(g => g.name);
  }
  return tvm.view ? tvm.view.list.map(c => c.pl + ':' + c.key) : [];
}

// The rows drawn, in order: a run or Select all never reaches into a folded section.
function tvmShownKeys(scope) {
  const box = document.querySelector(`#tvm [data-scope="${scope}"]`);
  return box ? Array.from(box.querySelectorAll('[data-sel]'), row => row.dataset.sel) : [];
}

function tvmSelTake(scope) {
  if (tvm.sel.scope !== scope) {
    tvm.sel.scope = scope;
    tvm.sel.ids = new Set();
    tvm.sel.items = new Map();
    tvm.sel.anchor = null;
    tvm.menu = false;
  }
}

function tvmSelRemember(scope, id) {
  if (scope !== 'channels' || tvm.sel.items.has(id)) return;
  const c = tvm.view && tvm.view.list.find(x => x.pl + ':' + x.key === id);
  if (c) tvm.sel.items.set(id, c);
}

function tvmSelSet(scope, id, on) {
  tvmSelTake(scope);
  if (on) { tvm.sel.ids.add(id); tvmSelRemember(scope, id); } else { tvm.sel.ids.delete(id); tvm.sel.items.delete(id); }
}

function tvmSelAll(scope, keys, on) {
  tvmSelTake(scope);
  keys.forEach(id => tvmSelSet(scope, id, on));
  if (!tvm.sel.ids.size) tvm.sel.scope = null;
  tvmSyncSel();
}

function tvmSelClear() {
  tvm.sel = { scope: null, ids: new Set(), anchor: null, items: new Map() };
  tvm.menu = false;
  tvmSyncSel();
}

// After an edit: lineup ids that are gone leave the selection.
function tvmSelPrune() {
  if (tvm.sel.scope !== 'lineup') return;
  const idx = tvmLineupIndex();
  tvm.sel.ids.forEach(id => { if (!idx[id]) tvm.sel.ids.delete(id); });
  if (!tvm.sel.ids.size) tvm.sel.scope = null;
}

/*
 * A click in a list: on a row (not on its buttons) it selects or unselects
 * it, and with Shift every row between it and the last one clicked.
 */
function tvmRowClick(e, scope) {
  const t0 = e.target;
  if (t0.closest('button, a, select, input:not(.tvm-cb)')) return;
  const row = t0.closest('[data-sel]');
  if (!row) return;
  if (t0.closest('.tvm-c-name, .tvm-lc-main') && e.detail > 1) return;
  const id = row.dataset.sel;
  const on = !(tvm.sel.scope === scope && tvm.sel.ids.has(id));
  if (e.shiftKey && tvm.sel.scope === scope && tvm.sel.anchor) {
    const keys = tvmShownKeys(scope);
    const a = keys.indexOf(tvm.sel.anchor), b = keys.indexOf(id);
    if (a !== -1 && b !== -1) {
      keys.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(k => tvmSelSet(scope, k, true));
      tvm.sel.anchor = id;
      if (document.getSelection) document.getSelection().removeAllRanges();
      return tvmSyncSel();
    }
  }
  tvmSelSet(scope, id, on);
  tvm.sel.anchor = id;
  if (!tvm.sel.ids.size) tvm.sel.scope = null;
  tvmSyncSel();
}

// The rows' and header boxes' state from the selection, without drawing the lists again.
function tvmSyncSel() {
  const root = q('tvm');
  if (!root) return;
  root.dataset.selecting = tvm.sel.ids.size ? tvm.sel.scope : '';
  root.querySelectorAll('[data-sel]').forEach(row => {
    const scope = row.closest('[data-scope]').dataset.scope;
    const on = tvm.sel.scope === scope && tvm.sel.ids.has(row.dataset.sel);
    row.classList.toggle('sel', on);
    const cb = row.querySelector('.tvm-cb');
    if (cb) cb.checked = on;
  });
  root.querySelectorAll('[data-selall]').forEach(box => {
    const scope = box.closest('[data-scope]').dataset.scope;
    const keys = tvmAllKeys(box.dataset.selall);
    const n = tvm.sel.scope === scope ? keys.filter(k => tvm.sel.ids.has(k)).length : 0;
    box.checked = !!keys.length && n === keys.length;
    box.indeterminate = n > 0 && n < keys.length;
  });
  renderTvmDock();
}

// What a header box selects: 'view' (the middle's list), 'groups', or a section id.
function tvmAllKeys(what) {
  if (what === 'view') return tvmSelKeys('channels');
  if (what === 'groups') return tvmSelKeys('groups');
  return tvm.lineup ? tvm.lineup.channels.filter(c => c.sid === what).map(c => c.id) : [];
}

async function tvmSelAllBox(box) {
  const what = box.dataset.selall;
  const scope = box.closest('[data-scope]').dataset.scope;
  const on = box.checked;
  // A group longer than one page: the rest is read first, so all means all.
  if (on && what === 'view' && tvm.view && tvm.view.kind === 'group' && tvm.view.list.length < tvm.view.total) await tvmBrowseAll();
  tvmSelAll(scope, tvmAllKeys(what), on);
}

// ---- the bar for the selection

function tvmSelChannels() {
  const idx = tvmLineupIndex();
  const list = Array.from(tvm.sel.items.values());
  return {
    list,
    addable: list.filter(c => !idx[c.pl + ':' + c.key] && tvmPlayable(c)),
    inLineup: list.filter(c => idx[c.pl + ':' + c.key])
  };
}

function renderTvmDock() {
  const box = q('tvm-dock');
  if (!box) return;
  const s = tvm.sel, n = s.ids.size;
  box.hidden = !n;
  if (!n) { box.innerHTML = ''; return; }
  const usable = tvmWritable() ? '' : 'disabled';
  const btn = (act, label, primary) => `<button type="button" class="tvm-dock-btn${primary ? ' primary' : ''}" ${usable} onclick="tvmBarAction('${act}')">${esc(label)}</button>`;
  let acts = [];
  if (s.scope === 'groups') {
    const list = (tvm.groups ? tvm.groups.list : []).filter(g => s.ids.has(g.name));
    const addable = list.filter(g => !g.section).length, hidden = list.filter(g => g.hidden).length;
    const inLineup = tvmGroupsInLineup(list).length;
    if (addable) acts.push(btn('groups-add', addable === 1 ? t('home.tvm.bar.addGroup', 'Add the whole group') : t('home.tvm.bar.addGroups', 'Add {n} whole groups', { n: addable }), true));
    if (inLineup) acts.push(btn('groups-remove', t('home.tvm.bar.removeFromGroups', 'Take their {n} out', { n: inLineup.toLocaleString() })));
    if (list.length - hidden) acts.push(btn('groups-hide', t('home.tvm.bar.hide', 'Hide')));
    if (hidden) acts.push(btn('groups-show', t('home.tvm.bar.show', 'Show again')));
  } else if (s.scope === 'channels') {
    const { addable, inLineup } = tvmSelChannels();
    if (addable.length) {
      acts.push(btn('add', t('home.tvm.bar.add', 'Add {n} to the lineup', { n: addable.length }), true));
      acts.push(btn('add-star', t('home.tvm.bar.addStar', 'Add and star')));
      const common = tvmCommonGroup(addable);
      acts.push(tvmMenuButton(t('home.tvm.bar.addTo', 'Add to…'), tvmSectionMenu('add', common ? tvmGroupLabel(common) : '')));
    }
    if (inLineup.length) acts.push(btn('out', t('home.tvm.bar.out', 'Take {n} out', { n: inLineup.length })));
  } else if (s.scope === 'lineup') {
    const idx = tvmLineupIndex();
    const list = Array.from(s.ids).map(id => idx[id]).filter(Boolean);
    const stars = list.filter(c => c.fav).length;
    if (list.length - stars) acts.push(btn('star', t('home.tvm.bar.star', 'Star {n}', { n: list.length - stars }), true));
    if (stars) acts.push(btn('unstar', t('home.tvm.bar.unstar', 'Unstar {n}', { n: stars })));
    acts.push(tvmMenuButton(t('home.tvm.bar.move', 'Move to…'), tvmSectionMenu('move', '')));
    if (list.length === 1) acts.push(btn('rename', t('home.tvm.rename', 'Rename')));
    acts.push(btn('out', t('home.tvm.bar.outAll', 'Take out')));
  }
  box.innerHTML = `<span class="tvm-dock-n num">${esc(t('home.tvm.bar.selected', '{n} selected', { n: n.toLocaleString() }))}</span>
    <span class="tvm-dock-acts">${acts.join('')}</span>
    <button type="button" class="tvm-dock-x" aria-label="${esc(t('home.tvm.bar.clear', 'Clear the selection'))}" title="${esc(t('home.tvm.bar.clear', 'Clear the selection'))}" onclick="tvmSelClear()">${TVM_ICON.cross}</button>`;
}

function tvmMenuButton(label, menu) {
  return `<span class="tvm-dock-wrap"><button type="button" class="tvm-dock-btn" ${tvmWritable() ? '' : 'disabled'} aria-haspopup="menu" aria-expanded="${tvm.menu === label}"
    onclick="tvm.menu = tvm.menu === ${tvmArg(label)} ? false : ${tvmArg(label)}; renderTvmDock()">${esc(label)}</button>${tvm.menu === label ? menu : ''}</span>`;
}

// The group every one of these channels is in, or ''.
function tvmCommonGroup(list) {
  return list.length && list.every(c => c.group === list[0].group) ? list[0].group || '' : '';
}

/*
 * Where selected channels can go: a section of picked channels, or a new one
 * (named after their group when they share one). kind is 'add' or 'move'.
 */
function tvmSectionMenu(kind, name) {
  const picks = (tvm.lineup ? tvm.lineup.sections : []).filter(x => x.kind === 'pick');
  const go = kind === 'add' ? 'tvmAddTo' : 'tvmMoveTo';
  return `<div class="tvm-menu" role="menu">
    ${picks.map(x => `<button type="button" role="menuitem" onclick="${go}(${tvmArg(x.id)})"><span class="num">${esc(String(x.start))}</span> <span translate="no">${esc(tvmSectionTitle(x))}</span></button>`).join('')}
    <button type="button" role="menuitem" onclick="${go}('new', ${tvmArg(name)})"><span class="num">+</span> ${esc(name
      ? t('home.tvm.bar.newSectionNamed', 'A new section, {name}', { name }) : t('home.tvm.bar.newSection', 'A new section'))}</button>
  </div>`;
}

async function tvmAddTo(target, name) {
  tvm.menu = false;
  const { addable } = tvmSelChannels();
  if (!addable.length) return;
  tvmSelClear();
  const r = await tvmEdit({ action: 'add', section: target, name: target === 'new' ? name || t('home.tvm.newSectionName', 'New section') : undefined,
    channels: addable.map(c => ({ pl: c.pl, key: c.key, name: c.name, group: c.group })) }, false, (r, before) => {
    const sec = tvm.lineup.sections.find(x => x.id === r.section);
    return t('home.tvm.said.addedTo', 'Added {n} to {name}.', { n: r.lineup - before, name: sec ? tvmSectionTitle(sec) : '' });
  });
  if (r && r.section) {
    tvm.collapsed[r.section] = false;
    if (target === 'new' && !name) tvmStartEdit('section', r.section);
    tvmScrollTo(r.section);
  }
}

async function tvmMoveTo(target) {
  tvm.menu = false;
  const idx = tvmLineupIndex();
  // In number order, whatever order they were clicked in.
  const ids = tvm.lineup.channels.filter(c => tvm.sel.ids.has(c.id)).map(c => c.id);
  if (!ids.length) return;
  // A new section goes where the first of them was.
  const at = target === 'new' ? Math.max(0, tvm.lineup.sections.findIndex(x => x.id === idx[ids[0]].sid)) : undefined;
  const name = target === 'new' ? t('home.tvm.newSectionName', 'New section') : undefined;
  tvmSelClear();
  const r = await tvmEdit({ action: 'move', ids, section: target, name, at }, false, r => {
    const sec = tvm.lineup.sections.find(x => x.id === r.section);
    return target === 'new' ? t('home.tvm.said.movedNew', 'Moved {n} to a new section. Name it here.', { n: ids.length })
      : t('home.tvm.said.moved', 'Moved {n} to {name}.', { n: ids.length, name: sec ? tvmSectionTitle(sec) : '' });
  });
  if (r && r.section) {
    tvm.collapsed[r.section] = false;
    if (target === 'new') tvmStartEdit('section', r.section);
    tvmScrollTo(r.section);
  }
}

async function tvmBarAction(act) {
  const s = tvm.sel;
  if (!s.ids.size) return;
  if (s.scope === 'groups') {
    const list = (tvm.groups ? tvm.groups.list : []).filter(g => s.ids.has(g.name));
    tvmSelClear();
    if (act === 'groups-add') {
      const names = list.filter(g => !g.section).map(g => g.name);
      const r = await tvmEdit({ action: 'add-group', pl: tvm.pl, groups: names }, false,
        () => names.length === 1 ? t('home.tvm.said.addedGroup', 'Added {name}. The TV is reading its channels.', { name: tvmPlain(names[0]) })
          : t('home.tvm.said.addedGroups', 'Added {n} groups. The TV is reading their channels.', { n: names.length }));
      if (r && r.section) { tvm.collapsed[r.section] = false; tvmScrollTo(r.section); }
    } else if (act === 'groups-remove') {
      // Whole groups go as sections; channels picked from them go one by one; one edit, one Undo.
      const sections = list.filter(g => g.section).map(g => g.section);
      const ids = tvmGroupsInLineup(list).filter(c => !sections.includes(c.sid)).map(c => c.id);
      tvmEdit({ action: 'remove', ids, sections }, false, (r, before) => t('home.tvm.said.out', 'Took {n} out of the lineup.', { n: before - r.lineup }));
    } else {
      const hide = act === 'groups-hide';
      const names = list.filter(g => !!g.hidden !== hide).map(g => g.name);
      tvmEdit({ action: 'hide', pl: tvm.pl, groups: names, hidden: hide }, true,
        () => hide ? t('home.tvm.said.hid', 'Hid {n} {groups}.', { n: names.length, groups: tvmPlural(names.length, t('home.tvm.group1', 'group'), t('home.tvm.groupN', 'groups')) })
          : t('home.tvm.said.shown', 'Showing {n} {groups} again.', { n: names.length, groups: tvmPlural(names.length, t('home.tvm.group1', 'group'), t('home.tvm.groupN', 'groups')) }));
    }
    return;
  }
  if (s.scope === 'channels') {
    const { addable, inLineup } = tvmSelChannels();
    if (act === 'add' || act === 'add-star') {
      if (!addable.length) return;
      tvmSelClear();
      tvmEdit({ action: 'add', favourite: act === 'add-star', channels: addable.map(c => ({ pl: c.pl, key: c.key, name: c.name, group: c.group })) }, false,
        (r, before) => act === 'add-star' && r.full ? t('home.tvm.said.addedFull', 'Added {n}. Home’s row filled up before all were starred.', { n: r.lineup - before })
          : act === 'add-star' ? t('home.tvm.said.addedStarred', 'Added {n} and starred them.', { n: r.lineup - before })
          : t('home.tvm.said.added', 'Added {n} to the lineup.', { n: r.lineup - before }));
    } else if (act === 'out') {
      if (!inLineup.length) return;
      tvmSelClear();
      tvmEdit({ action: 'remove', ids: inLineup.map(c => c.pl + ':' + c.key) }, false,
        (r, before) => t('home.tvm.said.out', 'Took {n} out of the lineup.', { n: before - r.lineup }));
    }
    return;
  }
  const ids = tvm.lineup.channels.filter(c => s.ids.has(c.id)).map(c => c.id);
  // Every action ends the selection, so the next click starts a new one.
  tvmSelClear();
  if (act === 'rename') {
    tvm.collapsed[tvm.lineup.channels.find(c => c.id === ids[0]).sid] = false;
    return tvmStartEdit('name', ids[0]);
  }
  if (act === 'star' || act === 'unstar') {
    tvmEdit({ action: 'star', ids, on: act === 'star' }, true, r => act === 'unstar' ? t('home.tvm.said.unstarred', 'Took {n} off Home’s row.', { n: ids.length })
      : r.full ? t('home.tvm.said.starFull', 'Starred {n}. Home’s row is full.', { n: r.starred || 0 })
      : t('home.tvm.said.starred', 'Starred {n} for Home’s row.', { n: r.starred || 0 }));
  } else if (act === 'out') {
    tvmEdit({ action: 'remove', ids }, false, (r, before) => t('home.tvm.said.out', 'Took {n} out of the lineup.', { n: before - r.lineup }));
  }
}

// ---- the subscription's groups

function tvmGroupState(g) {
  if (g.section) return { cls: 'all', text: t('home.tvm.wholeGroup', 'Whole group') };
  if (g.inLineup) return { cls: 'some', text: t('home.tvm.someOf', '{n} of {total}', { n: g.inLineup.toLocaleString(), total: g.count.toLocaleString() }) };
  return { cls: '', text: g.count.toLocaleString() };
}

function tvmShownGroups() {
  if (!tvm.groups) return { shown: [], hidden: [] };
  const f = tvm.filter.trim().toLowerCase();
  const match = g => !f || g.name.toLowerCase().includes(f);
  return {
    shown: tvm.groups.list.filter(g => !g.hidden && match(g)),
    hidden: tvm.groups.list.filter(g => g.hidden && match(g))
  };
}

function renderTvmGroups() {
  const box = q('tvm-groups');
  if (!box || !tvm.open) return;
  const top = box.scrollTop;
  const g = tvm.groups;
  if (!g) { box.innerHTML = `<div class="tvm-empty">${esc(t('home.tvm.noPlaylist', 'Add a playlist on the Home tab first.'))}</div>`; return; }
  const { shown, hidden } = tvmShownGroups();
  const open = tvm.view && tvm.view.kind === 'group' ? tvm.view.group : null;
  const filtered = tvm.filter.trim();
  const row = (gr, underPre) => {
    const st = tvmGroupState(gr);
    return `<li class="tvm-g${gr.name === open ? ' on' : ''}${gr.hidden ? ' hid' : ''}" data-sel="${esc(gr.name)}">
      <input type="checkbox" class="tvm-cb" aria-label="${esc(t('home.tvm.selectGroup', 'Select {name}', { name: gr.name }))}">
      <button type="button" class="tvm-g-open" onclick="tvmOpenGroup(${tvmArg(gr.name)})">${gr.name ? tvmNameHtml(gr.name, { noPre: underPre }) : `<span class="tvm-nm"><span class="tvm-c-name">${esc(t('home.tv.ungrouped', 'Channels'))}</span></span>`}
        <span class="tvm-g-count num ${st.cls}">${esc(st.text)}</span></button></li>`;
  };
  // Unfiltered, the groups fall under their country or tier ("UK", "US", "VIP") where the provider prefixes them.
  const list = gs => {
    if (filtered) return gs.map(g => row(g, false)).join('');
    let last = null;
    return gs.map(g => {
      const pre = tvmTidy(g.name).pre;
      const head = pre !== last && pre ? `<li class="tvm-g-pre" aria-hidden="true">${esc(pre)}</li>` : '';
      last = pre;
      return head + row(g, !!pre);
    }).join('');
  };
  box.innerHTML = `
    ${filtered && shown.length > 1 ? `<label class="tvm-all"><input type="checkbox" class="tvm-cb" data-selall="groups" onchange="tvmSelAllBox(this)">
      <span>${esc(t('home.tvm.selectMatching', 'Select the {n} matching', { n: shown.length }))}</span></label>` : ''}
    <ul class="tvm-list">${list(shown) || `<li class="tvm-empty">${esc(t('home.tv.nothing', 'Nothing matches.'))}</li>`}</ul>
    ${hidden.length ? `<button type="button" class="tvm-link" aria-expanded="${tvm.showHidden}" onclick="tvm.showHidden = !tvm.showHidden; renderTvmGroups()">
      ${esc(tvm.showHidden ? t('home.tvm.hiddenHide', 'Hidden groups ({n})', { n: hidden.length }) : t('home.tvm.hiddenShow', 'Show hidden groups ({n})', { n: hidden.length }))}</button>
      ${tvm.showHidden ? `<ul class="tvm-list">${hidden.map(g => row(g, false)).join('')}</ul>` : ''}` : ''}
    ${g.cut ? `<div class="tvm-note">${esc(t('home.tvm.groupsCut', 'Only the first groups are listed. Search finds channels in all of them.'))}</div>` : ''}`;
  box.scrollTop = top;
  tvmSyncSel();
}

// A string as a JavaScript argument inside a double-quoted attribute.
function tvmArg(s) { return esc(JSON.stringify(String(s))); }

let tvmFilterTimer = null;
function tvmFilter(v) {
  tvm.filter = v;
  clearTimeout(tvmFilterTimer);
  tvmFilterTimer = setTimeout(renderTvmGroups, 120);
}

// ---- the middle: a group's channels, or a search

async function tvmOpenGroup(name) {
  tvm.view = { kind: 'group', group: name, q: '', list: [], total: 0, page: 0, busy: false, gen: 0 };
  const f = q('tvm-find');
  if (f) f.value = '';
  tvm.pane = 'channels';
  renderTvmGroups();
  renderTvmPanes();
  await tvmBrowse(0);
}

async function tvmBrowse(page) {
  const v = tvm.view;
  const gen = ++v.gen;
  v.busy = true;
  renderTvmChannels();
  try {
    const r = await homeGet(`/api/iptv/browse?pl=${encodeURIComponent(tvm.pl)}&group=${encodeURIComponent(v.group)}&page=${page}&size=${TVM_PAGE}`);
    if (gen !== v.gen || tvm.view !== v) return;
    v.list = page ? v.list.concat(r.channels) : r.channels;
    v.total = r.total;
    v.page = page;
  } catch (e) { if (gen === v.gen) tvmToast(e.message, false, true); }
  v.busy = false;
  tvmMark();
  renderTvmChannels();
}

// Every page of the open group, up to 2,000 channels.
async function tvmBrowseAll() {
  const v = tvm.view;
  while (tvm.view === v && v.list.length < Math.min(v.total, TVM_ALL_MAX)) {
    const n = v.list.length;
    await tvmBrowse(v.page + 1);
    if (v.list.length === n) break;
  }
}

let tvmFindTimer = null;
function tvmFind(value) {
  clearTimeout(tvmFindTimer);
  tvmFindTimer = setTimeout(() => tvmSearch(value), 300);
}

async function tvmSearch(value) {
  const term = value.trim();
  const inGroup = tvm.view && tvm.view.kind === 'group' ? tvm.view.group : tvm.view && tvm.view.inGroup || '';
  if (term.length < 2) {
    if (inGroup) return tvmOpenGroup(inGroup);
    tvm.view = null;
    return renderTvmChannels();
  }
  // The box at the top searches everything; "Only in" narrows it to the group that was open.
  const v = tvm.view = { kind: 'search', q: term, inGroup, scope: tvm.view && tvm.view.scope !== undefined ? tvm.view.scope : false,
    list: [], total: 0, busy: true, gen: 1 };
  tvm.pane = 'channels';
  renderTvmPanes();
  renderTvmChannels();
  try {
    const r = await homeGet(`/api/iptv/search?pl=${encodeURIComponent(tvm.pl)}&q=${encodeURIComponent(term)}&group=${encodeURIComponent(v.scope ? v.inGroup : '')}`);
    if (tvm.view !== v) return;
    v.list = r.channels;
    v.total = r.total;
  } catch (e) { if (tvm.view === v) tvmToast(e.message, false, true); }
  v.busy = false;
  tvmMark();
  renderTvmChannels();
}

function tvmScope(on) {
  if (!tvm.view) return;
  tvm.view.scope = on;
  tvmSearch(tvm.view.q);
}

function tvmMarks(c) {
  return [c.dupe ? t('home.tv.dupe', '{n} of {total}', { n: c.dupe.split('/')[0], total: c.dupe.split('/')[1] }) : '',
    c.headers ? t('home.tv.headersShort', 'Needs headers') : '', c.drm ? t('home.tv.drmShort', 'DRM') : '',
    c.unsupported ? t('home.tv.formatShort', 'Can’t play') : ''].filter(Boolean);
}

// The lineup's channels from any of these groups of the open playlist.
function tvmGroupsInLineup(groups) {
  const names = new Set(groups.map(g => g.name));
  return tvm.lineup ? tvm.lineup.channels.filter(c => c.pl === tvm.pl && names.has(c.group)) : [];
}

// The open group's channels that are in the lineup, whether or not their page is loaded.
function tvmGroupInLineup(group) {
  return tvm.lineup ? tvm.lineup.channels.filter(c => c.pl === tvm.pl && c.group === group) : [];
}

function renderTvmChannels() {
  const box = q('tvm-channels');
  if (!box || !tvm.open) return;
  const v = tvm.view;
  const usable = tvmWritable() ? '' : 'disabled';
  if (!v) {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
    box.innerHTML = `<div class="tvm-empty tvm-start">
      <p>${esc(t('home.tvm.startTitle2', 'Open a group, or search every channel from the box at the top.'))}</p>
      <p>${esc(t('home.tvm.startDesc', 'A whole group added to the lineup follows the provider: channels it adds later join, and ones it drops go. Channels picked one by one stay as you order them.'))}</p>
      <dl class="tvm-keys">
        <dt><kbd>${esc(t('home.tvm.keyClick', 'Click'))}</kbd></dt><dd>${esc(t('home.tvm.keyClickDo', 'selects a channel; the bar at the bottom acts on all selected'))}</dd>
        <dt><kbd>⇧</kbd> <kbd>${esc(t('home.tvm.keyClick', 'Click'))}</kbd></dt><dd>${esc(t('home.tvm.keyShiftDo', 'selects every one between'))}</dd>
        <dt><kbd>${esc(t('home.tvm.keyDelete', 'Delete'))}</kbd></dt><dd>${esc(t('home.tvm.keyDeleteDo', 'takes the selected out of the lineup'))}</dd>
        <dt><kbd>${esc(mod)}</kbd> <kbd>Z</kbd></dt><dd>${esc(t('home.tvm.keyUndoDo', 'undoes the last change'))}</dd>
      </dl></div>`;
    return;
  }
  const g = v.kind === 'group' ? (tvm.groups && tvm.groups.list.find(x => x.name === v.group)) : null;
  let head = '';
  if (v.kind === 'group') {
    const sec = g && g.section && tvm.lineup && tvm.lineup.sections.find(s => s.id === g.section);
    const some = sec ? [] : tvmGroupInLineup(v.group);
    head = `<div class="tvm-ch-head">
      <h3>${v.group ? tvmNameHtml(v.group) : esc(t('home.tv.ungrouped', 'Channels'))}</h3>
      <div class="tvm-sub">${esc(v.busy && !v.list.length ? t('home.tv.loadingGroup', 'Reading the group…') : t('home.tv.channels', '{n} channels', { n: v.total.toLocaleString() }))}</div>
      <div class="tvm-actions">${sec
        ? `<span class="tvm-state all">${esc(t('home.tvm.inAsSectionRange', 'In the lineup as {name}, {from} to {to}', { name: tvmSectionTitle(sec), from: sec.start, to: sec.end }))}</span>
           <button type="button" class="pill idle" onclick="tvmScrollTo(${tvmArg(sec.id)})">${esc(t('home.tvm.show', 'Show it'))}</button>
           <button type="button" class="pill idle" ${usable} onclick="tvmRemoveSections([${tvmArg(sec.id)}])">${esc(t('home.tvm.removeGroup', 'Remove the group'))}</button>`
        : `<button type="button" class="pill good" ${usable} ${v.total ? '' : 'disabled'} onclick="tvmAddGroup(${tvmArg(v.group)})" title="${esc(t('home.tvm.addGroupTip', 'Channels the provider adds to the group later join too'))}">${esc(t('home.tvm.addGroup', 'Add the whole group'))}</button>
           ${some.length ? `<button type="button" class="pill idle" ${usable} onclick="tvmTakeOutGroup(${tvmArg(v.group)})">${esc(t('home.tvm.takeOutN', 'Take the {n} out', { n: some.length }))}</button>` : ''}`}
      </div>
      ${tvmSelAllHtml('view', v.kind === 'group' ? t('home.tvm.selectAllN', 'Select all {n}', { n: v.total.toLocaleString() }) : '')}</div>`;
  } else {
    const total = v.total > v.list.length ? t('home.tv.matchesSome', 'The first {n} of {total}', { n: v.list.length, total: v.total.toLocaleString() }) : t('home.tv.matches', '{n} found', { n: v.total });
    const addable = v.list.filter(c => !c.added && tvmPlayable(c));
    head = `<div class="tvm-ch-head">
      <h3>${esc(t('home.tvm.searchTitle', 'Channels named “{q}”', { q: v.q }))}</h3>
      <div class="tvm-sub">${esc(v.busy ? t('home.tv.searchingDash', 'Searching…') : total)}</div>
      <div class="tvm-actions">
        ${addable.length > 1 ? `<button type="button" class="pill good" ${usable} onclick="tvmAddShown()">${esc(v.total > v.list.length ? t('home.tvm.addShownN', 'Add the {n} shown', { n: addable.length }) : t('home.tvm.addFound', 'Add all {n}', { n: addable.length }))}</button>` : ''}
        ${v.inGroup ? `<label class="tvm-check"><input type="checkbox" ${v.scope ? 'checked' : ''} onchange="tvmScope(this.checked)"> ${esc(t('home.tvm.onlyIn', 'Only in {group}', { group: tvmGroupLabel(v.inGroup) }))}</label>` : ''}
      </div>
      ${v.list.length ? tvmSelAllHtml('view', t('home.tvm.selectAllN', 'Select all {n}', { n: v.list.length })) : ''}</div>`;
  }
  // Inside a group, its own country or tier on every channel says nothing.
  const groupPre = v.kind === 'group' ? tvmTidy(v.group).pre : '';
  const rows = v.list.map((c, i) => {
    const off = !tvmPlayable(c);
    const marks = tvmMarks(c);
    const where = v.kind === 'search' && !v.scope ? c.group : '';
    const id = c.pl + ':' + c.key;
    return `<li class="tvm-c${c.added ? ' in' : ''}${off ? ' off' : ''}" data-sel="${esc(id)}">
      <input type="checkbox" class="tvm-cb" aria-label="${esc(t('home.tvm.selectCh', 'Select {name}', { name: c.name }))}">
      <span class="tvm-c-main">${tvmNameHtml(c.name, { noPre: !!groupPre && tvmTidy(c.name).pre === groupPre })}
        ${where || marks.length ? `<span class="tvm-c-meta">${esc([where ? tvmGroupLabel(where) : ''].concat(marks).filter(Boolean).join(', '))}</span>` : ''}</span>
      ${c.added ? `<span class="tvm-c-in num${c.fav ? ' fav' : ''}" title="${esc(t('home.tvm.inAt', 'In the lineup at {n}', { n: c.lnum }))}">${esc(c.lnum)}</span>` : '<span></span>'}
      <button type="button" class="tvm-quick${c.added ? ' out' : ''}" ${usable} ${!off || c.added ? '' : 'disabled'} onclick="tvmToggle(${i})">${esc(c.added ? t('home.tvm.quickOut', 'Take out') : t('home.tvm.quickAdd', 'Add'))}</button></li>`;
  }).join('');
  const more = v.kind === 'group' && v.list.length < v.total
    ? `<button type="button" class="tvm-link" onclick="tvmBrowse(${v.page + 1})">${esc(t('home.tv.more', 'Show {n} more of {total}', { n: Math.min(TVM_PAGE, v.total - v.list.length), total: v.total.toLocaleString() }))}</button>` : '';
  const top = box.scrollTop;
  box.innerHTML = head + `<ul class="tvm-list">${rows || (v.busy ? '' : `<li class="tvm-empty">${esc(t('home.tv.nothing', 'Nothing matches.'))}</li>`)}</ul>` + more;
  box.scrollTop = top;
  tvmSyncSel();
}

function tvmSelAllHtml(what, label) {
  return `<label class="tvm-all"><input type="checkbox" class="tvm-cb" data-selall="${esc(what)}" onchange="tvmSelAllBox(this)"><span>${esc(label || t('home.tvm.selectAll', 'Select all'))}</span></label>`;
}

async function tvmToggle(i) {
  const c = tvm.view && tvm.view.list[i];
  if (!c) return;
  if (c.added) await tvmEdit({ action: 'remove', ids: [c.pl + ':' + c.key] });
  else await tvmEdit({ action: 'add', channels: [{ pl: c.pl, key: c.key, name: c.name, group: c.group }] });
}

function tvmAddShown() {
  const list = tvm.view.list.filter(c => !c.added && tvmPlayable(c));
  if (list.length) tvmEdit({ action: 'add', channels: list.map(c => ({ pl: c.pl, key: c.key, name: c.name, group: c.group })) }, false,
    (r, before) => t('home.tvm.said.added', 'Added {n} to the lineup.', { n: r.lineup - before }));
}

async function tvmAddGroup(group) {
  const r = await tvmEdit({ action: 'add-group', pl: tvm.pl, group }, false,
    () => t('home.tvm.said.addedGroup', 'Added {name}. The TV is reading its channels.', { name: tvmPlain(group) }));
  if (r && r.section) { tvm.collapsed[r.section] = false; tvmScrollTo(r.section); }
}

function tvmTakeOutGroup(group) {
  const ids = tvmGroupInLineup(group).map(c => c.id);
  if (ids.length) tvmEdit({ action: 'remove', ids }, false, (r, before) => t('home.tvm.said.out', 'Took {n} out of the lineup.', { n: before - r.lineup }));
}

// ---- the lineup

function tvmSectionTitle(s) {
  if (s.name) return s.name;
  if (s.kind === 'group') return s.group ? tvmGroupLabel(s.group) : t('home.tv.ungrouped', 'Channels');
  return t('home.tv.myChannels', 'My channels');
}

function tvmSectionNote(s) {
  if (s.state === 'gone') return t('home.tvm.secGone', 'Its playlist was removed.');
  if (s.state === 'pending') return t('home.tvm.secPending', 'The TV is reading its channels…');
  if (s.kind === 'pick') return t('home.tvm.secPick', 'Picked one by one');
  const parts = [t('home.tvm.secGroup', 'Follows {name}’s group', { name: s.playlist || '' })];
  if (s.except) parts.push(t('home.tvm.secExcept', '{n} taken out', { n: s.except }));
  if (s.cut) parts.push(t('home.tvm.secCut', 'only its first 1,000'));
  return parts.join(', ');
}

// A section's first number, large, and its last under it.
function tvmRange(s) {
  return `<span class="tvm-first">${esc(String(s.start))}</span>${s.count > 1 ? `<span class="tvm-last">${esc(t('home.tvm.to', 'to {n}', { n: s.end }))}</span>` : ''}`;
}

function tvmSectionCollapsed(s, count) {
  return tvm.collapsed[s.id] !== undefined ? tvm.collapsed[s.id] : (s.kind === 'group' && count > 24);
}

function renderTvmLineup() {
  const box = q('tvm-lineup');
  if (!box || !tvm.open) return;
  const lu = tvm.lineup;
  const can = tvmWritable(), usable = can ? '' : 'disabled';
  renderTvmLineupTools();
  if (!lu) { box.innerHTML = ''; return; }
  const top = box.scrollTop;
  const bySection = {};
  lu.channels.forEach(c => { (bySection[c.sid] = bySection[c.sid] || []).push(c); });
  const favs = lu.favourites.map(id => lu.channels.find(c => c.id === id)).filter(Boolean);
  const ed = tvm.editing;
  const favsOpen = !!tvm.favsOpen;

  const favHtml = `<section class="tvm-row-fav" aria-labelledby="tvm-fav-h">
    <div class="tvm-sec-head"><div class="tvm-spine"><span class="tvm-star-big" aria-hidden="true">${TVM_ICON.starOn}</span></div>
      <div class="tvm-sec-main"><h3 id="tvm-fav-h">${esc(t('home.tvm.rowTitle', 'Home’s row'))}</h3>
        <div class="tvm-sub">${esc(favs.length ? t('home.tvm.rowCount', '{n} of {max} starred, in this order', { n: favs.length, max: lu.maxFavourites })
          : t('home.tvm.rowEmpty', 'Star channels in the lineup to put them on Glasshouse Home’s Internet TV row.'))}</div></div>
      ${favs.length ? `<div class="tvm-sec-acts">
        <button type="button" class="tvm-count num" aria-expanded="${favsOpen}" onclick="tvm.favsOpen = ${!favsOpen}; renderTvmLineup()">${esc(favsOpen ? t('home.tvm.rowHide', 'Hide the order') : t('home.tvm.rowShow', 'Arrange the order'))}
          <span aria-hidden="true">${favsOpen ? TVM_ICON.up : TVM_ICON.down}</span></button>
        <button type="button" class="tvm-textbtn" ${usable} onclick="tvmUnstarAll()">${esc(t('home.tvm.unstarAll', 'Unstar all'))}</button></div>` : ''}
    </div>
    ${favs.length && !favsOpen ? `<ol class="tvm-tiles" aria-label="${esc(t('home.tvm.rowTitle', 'Home’s row'))}">${favs.map(c => `<li><button type="button" class="tvm-tile"
        onclick="tvmShowChannel(${tvmArg(c.id)})" title="${esc(c.name)}">${tvmTileLogo(c)}<span class="tvm-tile-num num">${esc(c.number)}</span>
        <span class="tvm-tile-name" translate="no">${esc(c.renamed ? c.name : tvmPlain(c.name))}</span></button></li>`).join('')}</ol>` : ''}
    ${favs.length && favsOpen ? `<ol class="tvm-favs" ondragover="tvmDragOver(event)" ondrop="tvmDrop(event, '*')">${favs.map((c, i) => `
      <li class="tvm-fav" draggable="${can}" data-id="${esc(c.id)}" ondragstart="tvmDragStart(event, '*', ${tvmArg(c.id)})" ondragend="tvmDragEnd()">
        <span class="tvm-grip" aria-hidden="true">${TVM_ICON.grip}</span>
        <span class="tvm-num num">${esc(c.number)}</span>${tvmLogo(c)}
        <span class="tvm-c-name" translate="no">${esc(c.name)}</span>
        <span class="tvm-row-acts">
          <button type="button" class="tvm-ib" ${usable} ${i ? '' : 'disabled'} aria-label="${esc(t('home.tvm.moveUp', 'Move up'))}" title="${esc(t('home.tvm.moveUp', 'Move up'))}" onclick="tvmMoveFav(${tvmArg(c.id)}, -1)">${TVM_ICON.moveUp}</button>
          <button type="button" class="tvm-ib" ${usable} ${i < favs.length - 1 ? '' : 'disabled'} aria-label="${esc(t('home.tvm.moveDown', 'Move down'))}" title="${esc(t('home.tvm.moveDown', 'Move down'))}" onclick="tvmMoveFav(${tvmArg(c.id)}, 1)">${TVM_ICON.moveDown}</button>
          <button type="button" class="tvm-ib star starred" ${usable} aria-pressed="true" aria-label="${esc(t('home.tvm.unstar', 'Take off Home’s row'))}" title="${esc(t('home.tvm.unstar', 'Take off Home’s row'))}"
            onclick="tvmEdit({ action: 'star', id: ${tvmArg(c.id)}, on: false })">${TVM_ICON.starOn}</button></span></li>`).join('')}</ol>` : ''}
  </section>`;

  const secHtml = lu.sections.map((s, si) => {
    const list = bySection[s.id] || [];
    const collapsed = tvmSectionCollapsed(s, list.length);
    const naming = ed && ed.kind === 'section' && ed.id === s.id;
    const fromEdit = ed && ed.kind === 'from' && ed.id === s.id;
    const rows = collapsed ? '' : list.map((c, i) => {
      const renaming = ed && ed.kind === 'name' && ed.id === c.id;
      const state = c.missing ? t('home.tv.missing', 'Not in the playlist any more') : c.pending ? t('home.tvm.pending', 'Being read') :
        c.unplayable ? t('home.tvm.unplayable', 'Can’t be played here') : '';
      return `<li class="tvm-lc${c.fav ? ' fav' : ''}${c.missing || c.unplayable ? ' bad' : ''}" data-id="${esc(c.id)}" data-sel="${esc(c.id)}"
          ${s.kind === 'pick' && can ? `draggable="true" ondragstart="tvmDragStart(event, ${tvmArg(s.id)}, ${tvmArg(c.id)})" ondragend="tvmDragEnd()"` : ''}>
        <span class="tvm-num num">${esc(c.number)}</span>
        <input type="checkbox" class="tvm-cb" aria-label="${esc(t('home.tvm.selectCh', 'Select {name}', { name: c.name }))}">${tvmLogo(c)}
        <span class="tvm-lc-main" ondblclick="tvmStartEdit('name', ${tvmArg(c.id)})">${renaming
          ? `<input class="tvm-input" id="tvm-rename" value="${esc(c.name)}" maxlength="60" aria-label="${esc(t('home.tvm.renameLabel', 'Name on the TV'))}"
              onkeydown="if(event.key==='Enter')tvmRename(${tvmArg(c.id)}, this.value)" onblur="tvmRename(${tvmArg(c.id)}, this.value)">`
          : tvmNameHtml(c.name, { asWritten: c.renamed })}
          ${c.renamed && !renaming ? `<span class="tvm-c-meta" translate="no">${esc(t('home.tvm.was', 'Listed as {name}', { name: c.provName }))}</span>` : state ? `<span class="tvm-c-meta">${esc(state)}</span>` : ''}</span>
        <span class="tvm-row-acts">
          <button type="button" class="tvm-ib" ${usable} aria-label="${esc(t('home.tvm.rename', 'Rename'))}" title="${esc(t('home.tvm.rename', 'Rename'))}"
            onclick="tvmStartEdit('name', ${tvmArg(c.id)})">${TVM_ICON.pen}</button>
          ${s.kind === 'pick' ? `<button type="button" class="tvm-ib" ${usable} ${i ? '' : 'disabled'} aria-label="${esc(t('home.tvm.moveUp', 'Move up'))}" title="${esc(t('home.tvm.moveUp', 'Move up'))}" onclick="tvmMovePick(${tvmArg(s.id)}, ${tvmArg(c.id)}, -1)">${TVM_ICON.moveUp}</button>
            <button type="button" class="tvm-ib" ${usable} ${i < list.length - 1 ? '' : 'disabled'} aria-label="${esc(t('home.tvm.moveDown', 'Move down'))}" title="${esc(t('home.tvm.moveDown', 'Move down'))}" onclick="tvmMovePick(${tvmArg(s.id)}, ${tvmArg(c.id)}, 1)">${TVM_ICON.moveDown}</button>` : ''}
          <button type="button" class="tvm-ib" ${usable} aria-label="${esc(t('home.tvm.takeOut', 'Take out of the lineup'))}" title="${esc(t('home.tvm.takeOut', 'Take out of the lineup'))}"
            onclick="tvmEdit({ action: 'remove', ids: [${tvmArg(c.id)}] }, false, () => t('home.tvm.said.outOne', 'Took {name} out of the lineup.', { name: ${tvmArg(c.renamed ? c.name : tvmPlain(c.name))} }))">${TVM_ICON.cross}</button>
        </span>
        <button type="button" class="tvm-ib star${c.fav ? ' starred' : ''}" ${usable} ${!c.missing ? '' : 'disabled'} aria-pressed="${!!c.fav}"
          aria-label="${esc(c.fav ? t('home.tvm.unstar', 'Take off Home’s row') : t('home.tvm.star', 'Put on Home’s row'))}" title="${esc(c.fav ? t('home.tvm.unstar', 'Take off Home’s row') : t('home.tvm.star', 'Put on Home’s row'))}"
          onclick="tvmEdit({ action: 'star', id: ${tvmArg(c.id)}, on: ${!c.fav} }, true)">${c.fav ? TVM_ICON.starOn : TVM_ICON.star}</button>
      </li>`;
    }).join('');
    return `<section class="tvm-sec${s.state !== 'ready' ? ' wait' : ''}" id="tvm-sec-${esc(s.id)}" data-sid="${esc(s.id)}"
        ${s.kind === 'pick' ? `ondragover="tvmDragOver(event)" ondrop="tvmDrop(event, ${tvmArg(s.id)})"` : ''}>
      <div class="tvm-sec-head">
        <div class="tvm-spine">${fromEdit
          ? `<input class="tvm-input tvm-from num" id="tvm-from" type="number" min="1" max="9999" value="${esc(s.from || s.start)}" aria-label="${esc(t('home.tvm.startAt', 'Numbers start at'))}"
              onkeydown="if(event.key==='Enter')tvmSetFrom(${tvmArg(s.id)}, this.value)" onblur="tvmSetFrom(${tvmArg(s.id)}, this.value)">`
          : `<button type="button" class="tvm-range num${s.from ? ' set' : ''}" ${usable} title="${esc(t('home.tvm.startAtTip', 'Choose the number this section starts at'))}"
              onclick="tvmStartEdit('from', ${tvmArg(s.id)})">${tvmRange(s)}</button>`}</div>
        <div class="tvm-sec-main">
          ${naming
            ? `<input class="tvm-input" id="tvm-secname" value="${esc(tvmSectionTitle(s))}" maxlength="60" aria-label="${esc(t('home.tvm.sectionName', 'Section name'))}"
                onkeydown="if(event.key==='Enter')tvmNameSection(${tvmArg(s.id)}, this.value)" onblur="tvmNameSection(${tvmArg(s.id)}, this.value)">`
            : `<h3><button type="button" class="tvm-h-btn" ${usable} title="${esc(t('home.tvm.renameSection', 'Rename the section'))}" onclick="tvmStartEdit('section', ${tvmArg(s.id)})"
                translate="no">${s.kind === 'group' && !s.name ? tvmNameHtml(s.group) : esc(tvmSectionTitle(s))}</button></h3>`}
          <div class="tvm-sub">${esc(tvmSectionNote(s))}${s.clash ? ' ' + esc(t('home.tvm.clash', '(after {n}, as the section before runs on)', { n: s.from })) : ''}</div>
        </div>
        <div class="tvm-sec-acts">
          ${s.count ? `<input type="checkbox" class="tvm-cb" data-selall="${esc(s.id)}" onchange="tvmSelAllBox(this)" aria-label="${esc(t('home.tvm.selectSection', 'Select the section’s channels'))}" title="${esc(t('home.tvm.selectSection', 'Select the section’s channels'))}">` : ''}
          <button type="button" class="tvm-count num" ${s.count ? '' : 'disabled'} aria-expanded="${!collapsed}"
            onclick="tvm.collapsed[${tvmArg(s.id)}] = ${!collapsed}; renderTvmLineup()">${esc(collapsed ? t('home.tvm.showN', 'Show {n} channels', { n: s.count.toLocaleString() }) : t('home.tv.channels', '{n} channels', { n: s.count.toLocaleString() }))}
            <span aria-hidden="true">${collapsed ? TVM_ICON.down : TVM_ICON.up}</span></button>
          <button type="button" class="tvm-ib" ${usable} ${si ? '' : 'disabled'} aria-label="${esc(t('home.tvm.secUp', 'Move the section up'))}" title="${esc(t('home.tvm.secUp', 'Move the section up'))}"
            onclick="tvmEdit({ action: 'move-section', section: ${tvmArg(s.id)}, to: ${si - 1} })">${TVM_ICON.moveUp}</button>
          <button type="button" class="tvm-ib" ${usable} ${si < lu.sections.length - 1 ? '' : 'disabled'} aria-label="${esc(t('home.tvm.secDown', 'Move the section down'))}" title="${esc(t('home.tvm.secDown', 'Move the section down'))}"
            onclick="tvmEdit({ action: 'move-section', section: ${tvmArg(s.id)}, to: ${si + 1} })">${TVM_ICON.moveDown}</button>
          <button type="button" class="tvm-ib" ${usable} aria-label="${esc(t('home.tvm.removeSection', 'Remove the section'))}"
            title="${esc(t('home.tvm.removeSection', 'Remove the section'))}" onclick="tvmRemoveSections([${tvmArg(s.id)}])">${TVM_ICON.cross}</button>
        </div>
      </div>
      ${rows ? `<ol class="tvm-lcs">${rows}</ol>` : ''}
    </section>`;
  }).join('');

  box.innerHTML = favHtml + (secHtml || `<div class="tvm-empty tvm-start"><p>${esc(t('home.tvm.lineupEmpty', 'The lineup is empty. Add a whole group, or pick channels from the middle.'))}</p></div>`) +
    (lu.cut ? `<div class="tvm-note">${esc(t('home.tvm.cut', 'The lineup stops at {n} channels: the sections after that are not on the TV.', { n: lu.max.toLocaleString() }))}</div>` : '');
  box.scrollTop = top;
  tvmSyncSel();
  const inp = q('tvm-rename') || q('tvm-secname') || q('tvm-from');
  if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
}

// The lineup pane's own tools: open or close every section, and empty it.
function renderTvmLineupTools() {
  const box = q('tvm-lineup-tools');
  if (!box) return;
  const lu = tvm.lineup;
  if (!lu || !lu.sections.length) { box.innerHTML = ''; return; }
  const counts = {};
  lu.channels.forEach(c => { counts[c.sid] = (counts[c.sid] || 0) + 1; });
  const anyOpen = lu.sections.some(s => s.count && !tvmSectionCollapsed(s, counts[s.id] || 0));
  const armed = tvm.armed === 'clear';
  box.innerHTML = `<button type="button" class="tvm-textbtn" onclick="tvmCollapseAll(${anyOpen})">${esc(anyOpen ? t('home.tvm.collapseAll', 'Fold every section') : t('home.tvm.expandAll', 'Open every section'))}</button>
    <button type="button" class="tvm-textbtn${armed ? ' warn' : ''}" ${tvmWritable() ? '' : 'disabled'} onclick="tvmClearLineup()">${esc(armed
      ? t('home.tvm.clearSure', 'Press again to take out all {n}', { n: lu.channels.length.toLocaleString() }) : t('home.tvm.clear', 'Empty the lineup'))}</button>`;
}

function tvmCollapseAll(on) {
  (tvm.lineup ? tvm.lineup.sections : []).forEach(s => { tvm.collapsed[s.id] = on; });
  renderTvmLineup();
}

function tvmClearLineup() {
  if (tvm.armed !== 'clear') {
    tvm.armed = 'clear';
    renderTvmLineupTools();
    setTimeout(() => { if (tvm.armed === 'clear') { tvm.armed = null; renderTvmLineupTools(); } }, 4000);
    return;
  }
  tvm.armed = null;
  tvmSelClear();
  tvmEdit({ action: 'remove-section', sections: tvm.lineup.sections.map(s => s.id) }, false, () => t('home.tvm.said.cleared', 'The lineup is empty.'));
}

function tvmRemoveSections(ids) {
  const secs = tvm.lineup.sections.filter(s => ids.includes(s.id));
  if (!secs.length) return;
  tvmEdit({ action: 'remove-section', sections: ids }, false,
    () => secs.length === 1 ? t('home.tvm.said.removedSection', 'Removed {name}.', { name: tvmSectionTitle(secs[0]) })
      : t('home.tvm.said.removedSections', 'Removed {n} sections.', { n: secs.length }));
}

function tvmUnstarAll() {
  const n = tvm.lineup.favourites.length;
  tvmEdit({ action: 'favourites', ids: [] }, true, () => t('home.tvm.said.unstarred', 'Took {n} off Home’s row.', { n }));
}

// A row tile's picture: the logo, or the name's first letters as Home shows them.
function tvmTileLogo(c) {
  const mono = esc((c.renamed ? c.name : tvmPlain(c.name)).split(/\s+/).filter(w => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map(w => w.charAt(0)).join('').toUpperCase());
  return `<span class="tvm-tile-logo" data-mono="${mono}">${c.logo ? `<img src="${esc(api(c.logo))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}

// A channel of the lineup brought into view, its section opened.
function tvmShowChannel(id) {
  const c = tvm.lineup && tvm.lineup.channels.find(x => x.id === id);
  if (!c) return;
  tvm.collapsed[c.sid] = false;
  renderTvmLineup();
  tvm.pane = 'lineup';
  renderTvmPanes();
  requestAnimationFrame(() => {
    const row = document.querySelector(`#tvm-lineup .tvm-lc[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  });
}

function tvmLogo(c) {
  return c.logo ? `<img class="tvm-logo" src="${esc(api(c.logo))}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'tvm-logo none' }))">`
    : '<span class="tvm-logo none"></span>';
}

function tvmStartEdit(kind, id) {
  if (!tvmWritable()) return;
  tvm.editing = { kind, id };
  if (kind !== 'name') tvm.collapsed[id] = tvm.collapsed[id] || false;
  renderTvmLineup();
}

function tvmDone() { tvm.editing = null; }

function tvmRename(id, value) {
  if (!tvm.editing || tvm.editing.id !== id) return;
  tvmDone();
  const c = tvm.lineup.channels.find(x => x.id === id);
  // Back to the provider's name when cleared, or set to it.
  const name = !c || value.trim() === c.provName ? '' : value.trim();
  if (c && (name === (c.renamed ? c.name : ''))) return renderTvmLineup();
  tvmEdit({ action: 'rename', id, name });
}

function tvmNameSection(id, value) {
  if (!tvm.editing || tvm.editing.id !== id) return;
  tvmDone();
  const s = tvm.lineup.sections.find(x => x.id === id);
  // Left as shown (or set to the provider's own name): no name of its own.
  const fallback = s && s.kind === 'group' ? [tvmGroupLabel(s.group), s.group] : [t('home.tv.myChannels', 'My channels')];
  const name = fallback.includes(value.trim()) ? '' : value.trim();
  if (s && name === s.name) return renderTvmLineup();
  tvmEdit({ action: 'section', section: id, name });
}

function tvmSetFrom(id, value) {
  if (!tvm.editing || tvm.editing.id !== id) return;
  tvmDone();
  const s = tvm.lineup.sections.find(x => x.id === id);
  const n = value === '' ? 0 : +value;
  if (s && (n === s.from || (!s.from && n === s.start))) return renderTvmLineup();
  tvmEdit({ action: 'section', section: id, from: n });
}

function tvmMoveFav(id, by) {
  const ids = tvm.lineup.favourites.slice();
  const i = ids.indexOf(id);
  if (i + by < 0 || i + by >= ids.length) return;
  ids.splice(i, 1);
  ids.splice(i + by, 0, id);
  tvmEdit({ action: 'favourites', ids }, true);
}

function tvmMovePick(sid, id, by) {
  const ids = tvm.lineup.channels.filter(c => c.sid === sid).map(c => c.id);
  const i = ids.indexOf(id);
  if (i + by < 0 || i + by >= ids.length) return;
  ids.splice(i, 1);
  ids.splice(i + by, 0, id);
  tvmEdit({ action: 'order', section: sid, ids }, true);
}

// Dragging within the row's favourites, or within one section of picked channels.
function tvmDragStart(e, where, id) {
  tvm.drag = { where, id };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* old engines */ }
  e.currentTarget.classList.add('dragging');
}
function tvmDragEnd() {
  tvm.drag = null;
  document.querySelectorAll('.tvm .dragging, .tvm .drop-before').forEach(el => el.classList.remove('dragging', 'drop-before'));
}
function tvmDragOver(e) {
  if (!tvm.drag) return;
  e.preventDefault();
  document.querySelectorAll('.tvm .drop-before').forEach(el => el.classList.remove('drop-before'));
  const li = e.target.closest('[data-id]');
  if (li && e.currentTarget.contains(li)) li.classList.add('drop-before');
}
function tvmDrop(e, where) {
  e.preventDefault();
  const d = tvm.drag;
  tvmDragEnd();
  if (!d || d.where !== where) return;
  const li = e.target.closest('[data-id]');
  const before = li ? li.dataset.id : null;
  const ids = where === '*' ? tvm.lineup.favourites.slice() : tvm.lineup.channels.filter(c => c.sid === where).map(c => c.id);
  ids.splice(ids.indexOf(d.id), 1);
  ids.splice(before && before !== d.id ? ids.indexOf(before) : ids.length, 0, d.id);
  tvmEdit(where === '*' ? { action: 'favourites', ids } : { action: 'order', section: where, ids }, true);
}

function tvmScrollTo(sid) {
  tvm.pane = 'lineup';
  renderTvmPanes();
  requestAnimationFrame(() => {
    const el = q('tvm-sec-' + sid);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });
}

// ---- the frame

function renderTvmHead() {
  const box = q('tvm-summary');
  if (!box) return;
  const lu = tvm.lineup;
  const p = tvm.playlists.find(x => x.id === tvm.pl);
  const parts = [];
  if (p && p.channels !== null) parts.push(t('home.tvm.subCount', '{name} lists {n} channels in {g} groups', { name: p.label, n: p.channels.toLocaleString(), g: (p.groups || 0).toLocaleString() }));
  if (lu) parts.push(t('home.tvm.lineupCount', '{n} in the lineup, {f} on Home’s row', { n: lu.channels.length.toLocaleString(), f: lu.favourites.length }));
  box.textContent = parts.join('. ') + (parts.length ? '.' : '');
  const undo = q('tvm-undo');
  if (undo) undo.disabled = !(lu && lu.undo) || !tvmWritable();
  const sel = q('tvm-pl');
  if (sel) {
    sel.hidden = tvm.playlists.length < 2;
    sel.innerHTML = tvm.playlists.map(x => `<option value="${esc(x.id)}"${x.id === tvm.pl ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  }
  const counts = { groups: tvm.groups ? tvm.groups.list.filter(g => !g.hidden).length : 0, channels: tvm.view ? tvm.view.total : 0, lineup: lu ? lu.channels.length : 0 };
  document.querySelectorAll('#tvm-tabs button').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.pane === tvm.pane));
    const n = b.querySelector('.num');
    if (n) n.textContent = counts[b.dataset.pane] ? counts[b.dataset.pane].toLocaleString() : '';
  });
}

function renderTvmPanes() {
  const root = q('tvm');
  if (root) root.dataset.pane = tvm.pane;
  renderTvmHead();
}

function tvmPane(p) { tvm.pane = p; renderTvmPanes(); }

async function tvmPickPlaylist(id) {
  tvm.pl = id;
  tvm.view = null;
  tvmSelClear();
  await tvmLoadGroups();
  renderTvm();
}

function renderTvm() {
  if (!tvm.open) return;
  renderTvmPanes();
  renderTvmGroups();
  renderTvmChannels();
  renderTvmLineup();
  renderTvmDock();
  renderTvmToast();
}

const TVM_ICON = {
  cross: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  up: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  moveUp: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  moveDown: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  down: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  pen: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12 3 13z" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 2.2l1.75 3.6 3.95.55-2.86 2.78.68 3.93L8 11.2l-3.52 1.86.68-3.93L2.3 6.35l3.95-.55z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  starOn: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 2.2l1.75 3.6 3.95.55-2.86 2.78.68 3.93L8 11.2l-3.52 1.86.68-3.93L2.3 6.35l3.95-.55z" fill="currentColor"/></svg>',
  grip: '<svg viewBox="0 0 16 16" width="12" height="16"><circle cx="5" cy="4" r="1.1" fill="currentColor"/><circle cx="11" cy="4" r="1.1" fill="currentColor"/><circle cx="5" cy="8" r="1.1" fill="currentColor"/><circle cx="11" cy="8" r="1.1" fill="currentColor"/><circle cx="5" cy="12" r="1.1" fill="currentColor"/><circle cx="11" cy="12" r="1.1" fill="currentColor"/></svg>'
};

// Opened again after a reload: the address keeps ?tv=channels while it is open.
if (new URLSearchParams(location.search).get('tv') === 'channels') {
  setTimeout(() => { if (typeof showTab === 'function') showTab('home'); tvmOpen(); }, 0);
}
