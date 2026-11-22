// Reusable Home Assistant entity picker across Screensavers and Glasshouse Home.

let haPickerEntities = null;
let haPickerById = new Map();
let haPickerConfigured = false;
let haPickerError = '';
let haPickerLoading = false;
let haPickerWaiters = [];
const haPickerResetListeners = [];
const haPickerConfigs = Object.create(null);

const HA_DOMAIN_ORDER = [
  'sensor', 'weather', 'climate', 'binary_sensor', 'calendar',
  'light', 'switch', 'media_player', 'person', 'device_tracker',
  'number', 'input_number', 'input_text', 'input_select', 'input_boolean',
  'counter', 'timer', 'cover', 'lock', 'fan', 'vacuum', 'sun'
];
const HA_PICKER_PAGE = 120;

let haPickerState = {
  key: '',
  query: '',
  domain: 'all',
  withUnit: false,
  limit: HA_PICKER_PAGE,
  kbIndex: -1,
  matches: [],
  domainCounts: Object.create(null),
  anyUnit: false
};

function onHaEntitiesReset(fn) {
  if (typeof fn === 'function') haPickerResetListeners.push(fn);
}

function haEntityLookup(entityId) {
  return (entityId && haPickerById.get(entityId)) || null;
}

function haEntitiesState() {
  return {
    loaded: haPickerEntities !== null,
    configured: haPickerConfigured,
    entities: haPickerEntities || [],
    error: haPickerError
  };
}

function resetHaEntitiesCache() {
  haPickerEntities = null;
  haPickerById = new Map();
  haPickerConfigured = false;
  haPickerError = '';
  haPickerCloseAll();
  haPickerResetListeners.forEach(fn => { try { fn(); } catch (e) {} });
}

function enrichHaEntity(raw) {
  const id = String(raw && raw.id || '');
  const dot = id.indexOf('.');
  const domain = dot > 0 ? id.slice(0, dot) : 'other';
  const objectId = dot > 0 ? id.slice(dot + 1) : id;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const unit = typeof raw.unit === 'string' ? raw.unit : '';
  return {
    id,
    name,
    unit,
    domain,
    objectId,
    nameLower: name.toLowerCase(),
    objLower: objectId.toLowerCase(),
    hay: (id + ' ' + name + ' ' + unit).toLowerCase()
  };
}

async function ensureHaEntities(onLoaded) {
  if (haPickerEntities !== null || haPickerError) {
    if (typeof onLoaded === 'function') onLoaded(haEntitiesState());
    return;
  }
  if (typeof onLoaded === 'function') haPickerWaiters.push(onLoaded);
  if (haPickerLoading) return;
  haPickerLoading = true;
  try {
    const r = await fetch(api('/api/ha/entities'));
    const d = await r.json();
    haPickerConfigured = !!(d && d.configured);
    if (d && d.ok && d.configured && Array.isArray(d.entities)) {
      haPickerEntities = d.entities.map(enrichHaEntity);
      haPickerById = new Map(haPickerEntities.map(ent => [ent.id, ent]));
    } else if (d && d.error) {
      haPickerError = d.error;
    } else if (d && !d.configured) {
      haPickerEntities = [];
      haPickerById = new Map();
    }
  } catch (e) {
    haPickerError = e.message || t('common.unknownError', 'unknown error');
  } finally {
    haPickerLoading = false;
  }
  const cbs = haPickerWaiters.splice(0, haPickerWaiters.length);
  const st = haEntitiesState();
  cbs.forEach(fn => { try { fn(st); } catch (e) {} });
}

function haDomainLabel(domain) {
  switch (domain) {
    case 'all': return t('ha.domain.all', 'All');
    case 'sensor': return t('ha.domain.sensor', 'Sensors');
    case 'weather': return t('ha.domain.weather', 'Weather');
    case 'climate': return t('ha.domain.climate', 'Climate');
    case 'binary_sensor': return t('ha.domain.binarySensor', 'Binary sensors');
    case 'calendar': return t('ha.domain.calendar', 'Calendars');
    case 'light': return t('ha.domain.light', 'Lights');
    case 'switch': return t('ha.domain.switch', 'Switches');
    case 'media_player': return t('ha.domain.mediaPlayer', 'Media');
    case 'person': return t('ha.domain.person', 'People');
    case 'device_tracker': return t('ha.domain.deviceTracker', 'Trackers');
    case 'number': return t('ha.domain.number', 'Numbers');
    case 'input_number': return t('ha.domain.inputNumber', 'Input numbers');
    case 'input_text': return t('ha.domain.inputText', 'Input text');
    case 'input_select': return t('ha.domain.inputSelect', 'Input select');
    case 'input_boolean': return t('ha.domain.inputBoolean', 'Input booleans');
    case 'counter': return t('ha.domain.counter', 'Counters');
    case 'timer': return t('ha.domain.timer', 'Timers');
    case 'cover': return t('ha.domain.cover', 'Covers');
    case 'lock': return t('ha.domain.lock', 'Locks');
    case 'fan': return t('ha.domain.fan', 'Fans');
    case 'vacuum': return t('ha.domain.vacuum', 'Vacuums');
    case 'sun': return t('ha.domain.sun', 'Sun');
    default: {
      const words = domain.replace(/_/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

function haDomainTone(domain) {
  if (domain === 'sensor' || domain === 'number' || domain === 'input_number' || domain === 'counter') return 'measure';
  if (domain === 'weather' || domain === 'climate' || domain === 'sun') return 'climate';
  if (domain === 'binary_sensor' || domain === 'switch' || domain === 'light' || domain === 'input_boolean' || domain === 'lock' || domain === 'cover' || domain === 'fan') return 'state';
  return 'info';
}

function haPickerRegister(key, cfg) {
  haPickerConfigs[key] = cfg;
}

function haPickerCloseAll() {
  document.querySelectorAll('.ha-picker').forEach(el => {
    el.hidden = true;
    const inp = el._triggerInput;
    if (inp) inp.setAttribute('aria-expanded', 'false');
  });
  haPickerState.key = '';
  haPickerState.kbIndex = -1;
}

function haMatchScore(item, qLower, firstTok) {
  if (item.id === qLower || item.nameLower === qLower) return 0;
  if (item.nameLower.indexOf(qLower) === 0 || item.objLower.indexOf(qLower) === 0) return 1;
  if (firstTok && (
    item.nameLower.indexOf(' ' + firstTok) !== -1 ||
    item.nameLower.indexOf(firstTok) === 0 ||
    item.objLower.indexOf('_' + firstTok) !== -1 ||
    item.objLower.indexOf(firstTok) === 0
  )) return 2;
  if (item.id.indexOf(qLower) === 0) return 3;
  return 4;
}

function haHighlightText(text, tokens) {
  const s = String(text || '');
  if (!tokens.length || !s) return esc(s);
  const lower = s.toLowerCase();
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    let pos = 0;
    while ((pos = lower.indexOf(tok, pos)) !== -1) {
      ranges.push([pos, pos + tok.length]);
      pos += tok.length;
    }
  }
  if (!ranges.length) return esc(s);
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (let i = 0; i < ranges.length; i++) {
    const cur = ranges[i];
    if (!merged.length || cur[0] > merged[merged.length - 1][1]) {
      merged.push([cur[0], cur[1]]);
    } else if (cur[1] > merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = cur[1];
    }
  }
  let out = '';
  let last = 0;
  for (let i = 0; i < merged.length; i++) {
    const r = merged[i];
    if (r[0] > last) out += esc(s.slice(last, r[0]));
    out += '<mark class="ha-pk-hl">' + esc(s.slice(r[0], r[1])) + '</mark>';
    last = r[1];
  }
  if (last < s.length) out += esc(s.slice(last));
  return out;
}

function haComputeMatches() {
  const list = haPickerEntities || [];
  const raw = String(haPickerState.query || '').trim().toLowerCase();
  const tokens = raw ? raw.split(/\s+/).filter(Boolean) : [];
  const firstTok = tokens[0] || '';
  const needUnit = haPickerState.withUnit;
  const counts = Object.create(null);
  const filtered = [];
  let anyUnit = false;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (needUnit && !item.unit) continue;
    if (tokens.length) {
      let ok = true;
      for (let j = 0; j < tokens.length; j++) {
        if (item.hay.indexOf(tokens[j]) === -1) { ok = false; break; }
      }
      if (!ok) continue;
    }
    if (item.unit) anyUnit = true;
    counts[item.domain] = (counts[item.domain] || 0) + 1;
    if (haPickerState.domain !== 'all' && item.domain !== haPickerState.domain) continue;
    filtered.push({
      item,
      score: raw ? haMatchScore(item, raw, firstTok) : (item.name ? 0 : 1)
    });
  }

  filtered.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const na = a.item.nameLower || a.item.objLower;
    const nb = b.item.nameLower || b.item.objLower;
    if (na < nb) return -1;
    if (na > nb) return 1;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });

  haPickerState.matches = filtered.map(x => x.item);
  haPickerState.domainCounts = counts;
  haPickerState.anyUnit = anyUnit;
  return tokens;
}

function haOrderedDomains(counts) {
  const present = Object.keys(counts);
  if (haPickerState.domain !== 'all' && !counts[haPickerState.domain]) {
    present.push(haPickerState.domain);
  }
  const set = new Set(present);
  const out = [];
  HA_DOMAIN_ORDER.forEach(d => {
    if (set.has(d)) { out.push(d); set.delete(d); }
  });
  Array.from(set).sort().forEach(d => out.push(d));
  return out;
}

function haEnsurePickerShell(listEl, key) {
  if (listEl.dataset.pkShell === key) return;
  listEl.dataset.pkShell = key;
  listEl.innerHTML = `<div class="ha-pk-head">
      <div class="ha-pk-search-row">
        <input type="search" class="ha-pk-search" autocomplete="off" spellcheck="false"
          placeholder="${esc(t('ha.picker.searchPlaceholder', 'Search by name, entity ID, or unit\u2026'))}"
          aria-label="${esc(t('ha.picker.searchLabel', 'Filter entities'))}">
        <button type="button" class="ha-pk-reset" hidden>${esc(t('ha.picker.reset', 'Reset'))}</button>
      </div>
      <div class="ha-pk-chips" role="tablist" aria-label="${esc(t('ha.picker.filterType', 'Filter by type'))}"></div>
      <div class="ha-pk-meta"></div>
    </div>
    <div class="ha-pk-body" role="listbox"></div>`;

  const searchInp = listEl.querySelector('.ha-pk-search');
  searchInp.addEventListener('input', () => {
    if (haPickerState.key !== key) return;
    haPickerState.query = searchInp.value;
    haPickerState.limit = HA_PICKER_PAGE;
    haPickerState.kbIndex = -1;
    haRenderPickerContents(key);
  });
  searchInp.addEventListener('keydown', ev => {
    haPickerKeydown(ev, key);
  });

  const resetBtn = listEl.querySelector('.ha-pk-reset');
  resetBtn.addEventListener('mousedown', ev => { ev.preventDefault(); });
  resetBtn.addEventListener('click', () => {
    if (haPickerState.key !== key) return;
    haPickerResetFilters(key);
  });

  const body = listEl.querySelector('.ha-pk-body');
  body.addEventListener('scroll', () => {
    if (haPickerState.key !== key) return;
    if (haPickerState.limit >= haPickerState.matches.length) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 90) {
      haPickerState.limit += HA_PICKER_PAGE;
      haRenderPickerBody(key);
    }
  });

  const chips = listEl.querySelector('.ha-pk-chips');
  if (chips) {
    chips.addEventListener('wheel', ev => {
      if (chips.scrollWidth <= chips.clientWidth || !ev.deltaY || ev.deltaX) return;
      ev.preventDefault();
      chips.scrollLeft += ev.deltaY;
    }, { passive: false });
  }
}

function haPickerResetFilters(key) {
  haPickerState.query = '';
  haPickerState.domain = 'all';
  haPickerState.withUnit = false;
  haPickerState.limit = HA_PICKER_PAGE;
  haPickerState.kbIndex = -1;
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  const searchInp = listEl && listEl.querySelector('.ha-pk-search');
  if (searchInp) searchInp.value = '';
  haRenderPickerContents(key);
}

function haPickerSetDomain(key, domain) {
  if (haPickerState.key !== key) return;
  haPickerState.domain = domain;
  haPickerState.limit = HA_PICKER_PAGE;
  haPickerState.kbIndex = -1;
  haRenderPickerContents(key);
}

function haPickerToggleUnit(key) {
  if (haPickerState.key !== key) return;
  haPickerState.withUnit = !haPickerState.withUnit;
  haPickerState.limit = HA_PICKER_PAGE;
  haPickerState.kbIndex = -1;
  haRenderPickerContents(key);
}

function haPickerMore(key) {
  if (haPickerState.key !== key) return;
  haPickerState.limit += HA_PICKER_PAGE;
  haRenderPickerBody(key);
}

function haPickerSelect(key, entityId) {
  const cfg = haPickerConfigs[key];
  haPickerCloseAll();
  if (cfg && typeof cfg.onPick === 'function') cfg.onPick(entityId);
}

function haRenderPickerBody(key, tokens) {
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  const body = listEl && listEl.querySelector('.ha-pk-body');
  if (!body) return;

  if (!tokens) {
    const raw = String(haPickerState.query || '').trim().toLowerCase();
    tokens = raw ? raw.split(/\s+/).filter(Boolean) : [];
  }

  const matches = haPickerState.matches;
  const shown = matches.slice(0, haPickerState.limit);
  if (!shown.length) {
    body.innerHTML = `<div class="ss-ha-empty">${esc(t('ss.noEntitiesMatch', 'No matching entities'))}</div>`;
    return;
  }

  const curId = cfg.getCurrentId ? cfg.getCurrentId() : '';
  const usedRaw = cfg.getUsedIds ? cfg.getUsedIds() : null;
  const usedSet = usedRaw instanceof Set ? usedRaw : Array.isArray(usedRaw) ? new Set(usedRaw) : null;
  const selLabel = t('ha.picker.selected', 'Selected');
  const addedLabel = t('ha.picker.added', 'Added');
  const kj = jsq(key);

  let html = shown.map((item, idx) => {
    const isCur = !!(curId && curId === item.id);
    const isUsed = !isCur && !!(usedSet && usedSet.has(item.id));
    const isAct = idx === haPickerState.kbIndex;
    const titleHtml = haHighlightText(item.name || item.objectId, tokens);
    const idHtml = haHighlightText(item.id, tokens);
    return `<div class="ha-pk-opt${isCur ? ' is-current' : ''}${isUsed ? ' is-used' : ''}${isAct ? ' act' : ''}"
        role="option" aria-selected="${isCur || isAct ? 'true' : 'false'}" data-idx="${idx}" data-entity="${esc(item.id)}"
        onmousedown="event.preventDefault(); haPickerSelect('${kj}', '${jsq(item.id)}')">
      <div class="ha-pk-row1">
        <span class="ha-pk-name" translate="no">${titleHtml}</span>
        <span class="ha-pk-badges">
          ${item.unit ? `<span class="ha-pk-unit" translate="no">${esc(item.unit)}</span>` : ''}
          ${isCur ? `<span class="ha-pk-tag cur">${esc(selLabel)}</span>` : isUsed ? `<span class="ha-pk-tag used">${esc(addedLabel)}</span>` : ''}
        </span>
      </div>
      <div class="ha-pk-row2">
        <span class="ha-pk-dom" data-tone="${esc(haDomainTone(item.domain))}" translate="no">${esc(item.domain)}</span>
        <span class="ha-pk-id" translate="no">${idHtml}</span>
      </div>
    </div>`;
  }).join('');

  if (matches.length > shown.length) {
    const rem = matches.length - shown.length;
    html += `<button type="button" class="ha-pk-more" onmousedown="event.preventDefault(); haPickerMore('${kj}')">${esc(t('ha.picker.showMore', 'Show more ({n} remaining)', { n: rem }))}</button>`;
  }
  body.innerHTML = html;
}

function haRenderPickerContents(key) {
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  if (!listEl) return;

  if (haPickerEntities === null && haPickerError) {
    listEl.dataset.pkShell = '';
    listEl.innerHTML = `<div class="ss-ha-empty">${esc(haPickerError)}</div>`;
    listEl.hidden = false;
    return;
  }
  if (haPickerEntities === null) {
    listEl.dataset.pkShell = '';
    listEl.innerHTML = `<div class="ss-ha-empty">${esc(t('ss.loadingEntities', 'Loading entities...'))}</div>`;
    listEl.hidden = false;
    ensureHaEntities(() => {
      if (haPickerState.key === key && !listEl.hidden) haRenderPickerContents(key);
    });
    return;
  }

  haEnsurePickerShell(listEl, key);
  const searchInp = listEl.querySelector('.ha-pk-search');
  if (searchInp && document.activeElement !== searchInp && searchInp.value !== haPickerState.query) {
    searchInp.value = haPickerState.query;
  }

  const tokens = haComputeMatches();
  const counts = haPickerState.domainCounts;
  const totalMatching = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const domains = haOrderedDomains(counts);
  const kj = jsq(key);

  const resetBtn = listEl.querySelector('.ha-pk-reset');
  if (resetBtn) {
    resetBtn.hidden = !(haPickerState.query || haPickerState.domain !== 'all' || haPickerState.withUnit);
  }

  const chipsEl = listEl.querySelector('.ha-pk-chips');
  if (chipsEl) {
    let chipsHtml = `<button type="button" class="ha-pk-chip${haPickerState.domain === 'all' ? ' on' : ''}"
        role="tab" aria-selected="${haPickerState.domain === 'all'}"
        onmousedown="event.preventDefault(); haPickerSetDomain('${kj}', 'all')">
      <span>${esc(haDomainLabel('all'))}</span><span class="ha-pk-chip-n">${totalMatching}</span>
    </button>`;
    if (haPickerState.anyUnit || haPickerState.withUnit) {
      chipsHtml += `<button type="button" class="ha-pk-chip ha-pk-chip-unit${haPickerState.withUnit ? ' on' : ''}"
          aria-pressed="${haPickerState.withUnit}"
          onmousedown="event.preventDefault(); haPickerToggleUnit('${kj}')">
        <span>${esc(t('ha.picker.withUnit', 'With unit'))}</span>
      </button>`;
    }
    domains.forEach(dom => {
      const cnt = counts[dom] || 0;
      const active = haPickerState.domain === dom;
      chipsHtml += `<button type="button" class="ha-pk-chip${active ? ' on' : ''}"
          role="tab" aria-selected="${active}"
          onmousedown="event.preventDefault(); haPickerSetDomain('${kj}', '${jsq(dom)}')">
        <span>${esc(haDomainLabel(dom))}</span><span class="ha-pk-chip-n">${cnt}</span>
      </button>`;
    });
    chipsEl.innerHTML = chipsHtml;
  }

  const metaEl = listEl.querySelector('.ha-pk-meta');
  if (metaEl) {
    const n = haPickerState.matches.length;
    const shown = Math.min(n, haPickerState.limit);
    const total = haPickerEntities.length;
    metaEl.textContent = (n === total && shown === total)
      ? (n === 1 ? t('ha.picker.countOne', '1 entity') : t('ha.picker.countAll', '{n} entities', { n }))
      : t('ha.picker.showingOf', 'Showing {shown} of {n} matching ({total} total)', { shown, n, total });
  }

  listEl.hidden = false;
  haRenderPickerBody(key, tokens);
}

function haPickerOpen(key, query, focusSearch) {
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  if (!cfg || !listEl) return;
  const switching = haPickerState.key !== key;
  if (switching) haPickerCloseAll();

  const inp = cfg.inputId ? document.getElementById(cfg.inputId) : null;
  listEl._triggerInput = inp || null;
  if (inp) inp.setAttribute('aria-expanded', 'true');

  haPickerState.key = key;
  haPickerState.query = query !== undefined ? String(query) : '';
  if (switching) {
    haPickerState.domain = 'all';
    haPickerState.withUnit = false;
  }
  haPickerState.limit = HA_PICKER_PAGE;
  haPickerState.kbIndex = -1;
  haRenderPickerContents(key);

  if (focusSearch) {
    const searchInp = listEl.querySelector('.ha-pk-search');
    if (searchInp) searchInp.focus({ preventScroll: true });
  }
}

function haPickerToggle(key) {
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  if (!listEl) return;
  if (haPickerState.key === key && !listEl.hidden) {
    haPickerCloseAll();
    return;
  }
  haPickerOpen(key, '', true);
}

function haPickerFilter(key, text) {
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  if (!listEl) return;
  const trimmed = String(text || '').trim();
  if (!trimmed.length) {
    if (haPickerState.key === key) haPickerCloseAll();
    return;
  }
  haPickerOpen(key, text, false);
}

function haPickerMoveHighlight(listEl, nextIdx) {
  const body = listEl.querySelector('.ha-pk-body');
  if (!body) return;
  const opts = body.querySelectorAll('.ha-pk-opt');
  if (!opts.length) return;
  const clamped = Math.max(0, Math.min(opts.length - 1, nextIdx));
  haPickerState.kbIndex = clamped;
  opts.forEach((el, idx) => {
    const act = idx === clamped;
    el.classList.toggle('act', act);
    if (act) el.scrollIntoView({ block: 'nearest' });
  });
}

function haPickerKeydown(ev, key) {
  const cfg = haPickerConfigs[key];
  const listEl = cfg && document.getElementById(cfg.listId);
  if (!listEl || listEl.hidden || haPickerState.key !== key) {
    if (ev.key === 'ArrowDown' && listEl) {
      ev.preventDefault();
      haPickerOpen(key, ev.target && typeof ev.target.value === 'string' ? ev.target.value : '', false);
      return true;
    }
    return false;
  }

  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    const inp = cfg.inputId ? document.getElementById(cfg.inputId) : null;
    haPickerCloseAll();
    if (inp) inp.focus({ preventScroll: true });
    return true;
  }
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    const next = haPickerState.kbIndex < 0 ? 0 : haPickerState.kbIndex + 1;
    haPickerMoveHighlight(listEl, next);
    return true;
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    const prev = haPickerState.kbIndex <= 0 ? 0 : haPickerState.kbIndex - 1;
    haPickerMoveHighlight(listEl, prev);
    return true;
  }
  if (ev.key === 'Enter' && haPickerState.kbIndex >= 0) {
    const chosen = haPickerState.matches[haPickerState.kbIndex];
    if (chosen) {
      ev.preventDefault();
      haPickerSelect(key, chosen.id);
      return true;
    }
  }
  return false;
}

document.addEventListener('click', ev => {
  if (!haPickerState.key || !ev.target || !ev.target.closest) return;
  if (!ev.target.closest('.ss-ent-wrap, .ss-li-add-btn')) haPickerCloseAll();
});
