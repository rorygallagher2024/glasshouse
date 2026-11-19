// The Metrics tab's Storage view: each partition the TV can write to, a map
// of what fills it that you can zoom into, and the apps that take the most,
// from the server's scan (lib/storagescan.js). It only shows; nothing here
// deletes anything.

let storLast = null;
let storVol = null;
let storPath = [];
let storInFlight = false;
let storRetry = null;
let storAppsAll = false;

function storOpen() {
  return !document.hidden && typeof activeTab !== 'undefined' && activeTab === 'metrics' &&
    typeof metricsSubView !== 'undefined' && metricsSubView === 'storage';
}

function storageViewChanged() {
  if (storOpen() && !storLast) loadStorage(false);
}

async function loadStorage(rescan) {
  if (storInFlight) return;
  storInFlight = true;
  clearTimeout(storRetry);
  const btn = q('stor-rescan');
  if (btn) btn.disabled = true;
  if (rescan || !storLast) q('stor-note').textContent = t('metrics.stor.scanning', 'Looking through the TV’s storage…');
  try {
    const r = await fetch(api('/api/storage'), { method: rescan ? 'POST' : 'GET', cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    storLast = d;
    if (!storVol || !d.volumes.some(v => v.dev === storVol)) storVol = (d.volumes.find(v => v.tree) || d.volumes[0] || {}).dev || null;
    renderStorage();
    // An older scan came back while a new one runs: show the new one when done.
    if (d.scanning && storOpen()) storRetry = setTimeout(() => loadStorage(false), 3000);
  } catch (e) {
    q('stor-note').textContent = t('metrics.stor.failed', 'Could not look through the storage: {error}', { error: e.message });
  } finally {
    storInFlight = false;
    if (btn) btn.disabled = false;
  }
}

q('stor-rescan').addEventListener('click', () => loadStorage(true));

// ---- Names ------------------------------------------------------------------

function storSize(kb) {
  if (kb == null) return '—';
  if (kb < 1024) return t('metrics.stor.kb', '{n} KB', { n: Math.round(kb) });
  const mb = kb / 1024;
  if (mb < 1000) return t('metrics.stor.mb', '{n} MB', { n: mb < 10 ? mb.toFixed(1) : Math.round(mb) });
  return t('metrics.stor.gb', '{n} GB', { n: (mb / 1024).toFixed(mb < 10240 ? 2 : 1) });
}

function storVolName(v) {
  if (v.kind === 'apps') return t('metrics.stor.vol.apps', 'App storage');
  if (v.kind === 'data') return t('metrics.stor.vol.data', 'System data');
  if (v.kind === 'db') return t('metrics.stor.vol.db', 'Settings database');
  if (v.kind === 'usb') return t('metrics.stor.vol.usb', 'USB drive');
  return v.mount;
}

// Plain names for the folders that matter, by where they sit in the partition.
const STOR_NAMES = {
  apps: {
    'preload': () => t('metrics.stor.n.preload', 'LG preinstalled'),
    'preload/storedemo': () => t('metrics.stor.n.storedemo', 'Store demo videos'),
    'preload/igallery': () => t('metrics.stor.n.igallery', 'Gallery art'),
    'system': () => t('metrics.stor.n.builtin', 'Built in'),
    'system/apps/usr/palm/applications': () => t('metrics.stor.n.builtinApps', 'Built-in apps'),
    'system/qcards': () => t('metrics.stor.n.qcards', 'Home screen cards'),
    'cryptofs': () => t('metrics.stor.n.installed', 'Apps you installed'),
    'cryptofs/apps/usr/palm': () => t('metrics.stor.n.filesArt', 'App files and artwork'),
    'cryptofs/apps/usr/palm/applications': () => t('metrics.stor.n.bundles', 'App files'),
    'cryptofs/apps/usr/palm/data/images': () => t('metrics.stor.n.artwork', 'App artwork'),
    'cryptofs/data': () => t('metrics.stor.n.appData', 'App data'),
    'developer': () => t('metrics.stor.n.developer', 'Developer mode apps'),
    'internal': () => t('metrics.stor.g.sys', 'System'),
    'developer/apps/usr/palm/applications': () => t('metrics.stor.n.developer', 'Developer mode apps')
  },
  data: {
    'var/lib/wam': () => t('metrics.stor.n.wam', 'Web app cache'),
    'var/lib/tvweb': () => t('metrics.stor.n.glasshouse', 'Glasshouse'),
    'var/lib/airplay': () => t('metrics.stor.n.airplay', 'AirPlay'),
    'var/spool/faultmanager': () => t('metrics.stor.n.crash', 'Crash reports'),
    'var/palm/jail': () => t('metrics.stor.n.jail', 'App sandboxes'),
    'checkpoint': () => t('metrics.stor.n.checkpoint', 'Saved app state'),
    'channel_logo': () => t('metrics.stor.n.logos', 'Channel logos'),
    'webbrowser': () => t('metrics.stor.n.browser', 'Web browser'),
    'pbs': () => t('metrics.stor.n.guide', 'TV guide')
  },
  db: {
    'vardb/main': () => t('metrics.stor.n.settingsDb', 'Settings and app database')
  }
};

function storApp(id) {
  return storLast && storLast.apps.find(a => a.id === id);
}

function storNodeName(node, rel, kind) {
  if (!node.n) {
    return node.f ? t('metrics.stor.smaller', '{n} smaller items', { n: node.f }) : t('metrics.stor.files', 'Files');
  }
  const app = node.a && storApp(node.a);
  if (app) return app.title;
  // A merged chain (pbs/epg_segment/CDP) takes the deepest name known along it,
  // else its first folder, where it sits.
  const names = STOR_NAMES[kind] || {};
  const segs = node.n.split('/');
  const base = rel.slice(0, rel.length - node.n.length);
  for (let k = segs.length; k > 0; k--) {
    const named = names[base + segs.slice(0, k).join('/')];
    if (named) return named();
  }
  return segs[0];
}

function storGroupName(g) {
  if (g === 'app') return t('metrics.stor.g.app', 'Your apps');
  if (g === 'lg') return t('metrics.stor.g.lg', 'LG built in');
  return t('metrics.stor.g.sys', 'System');
}

// ---- Totals -------------------------------------------------------------------

function storGroups(tree) {
  const out = { app: 0, lg: 0, sys: 0 };
  (function walk(n) {
    if (n.c && n.c.length) n.c.forEach(walk);
    else out[n.g] = (out[n.g] || 0) + n.s;
  })(tree);
  return out;
}

// ---- Rendering ----------------------------------------------------------------------

function renderStorage() {
  const d = storLast;
  if (!d) return;
  const ago = Math.max(0, Math.round((d.now - d.at) / 60000));
  q('stor-note').textContent = d.scanning
    ? t('metrics.stor.scanning', 'Looking through the TV’s storage…')
    : ago < 1 ? t('metrics.stor.justNow', 'Looked through just now.')
      : t('metrics.stor.ago', 'Looked through {n} min ago.', { n: ago });
  renderStorVolumes();
  renderStorMap();
  renderStorApps();
}

function storBar(parts, total) {
  return '<div class="stor-bar" aria-hidden="true">' + parts.map(p =>
    '<i class="stor-seg ' + p.c + '" style="width:' + Math.max(0, p.kb / total * 100).toFixed(2) + '%"></i>').join('') + '</div>';
}

function renderStorVolumes() {
  const box = q('stor-vols');
  box.innerHTML = storLast.volumes.map(v => {
    const g = v.tree ? storGroups(v.tree) : { app: 0, lg: 0, sys: 0 };
    const scanned = g.app + g.lg + g.sys;
    // What the scan cannot see (the filesystem's own bookkeeping) counts as system.
    const sys = g.sys + Math.max(0, v.usedKb - scanned);
    const parts = [{ c: 'app', kb: g.app }, { c: 'lg', kb: g.lg }, { c: 'sys', kb: sys }];
    const on = v.dev === storVol;
    return '<button type="button" class="stor-vol' + (on ? ' on' : '') + '" data-dev="' + esc(v.dev) + '" aria-pressed="' + on + '"' + (v.tree ? '' : ' disabled') + '>' +
      '<span class="stor-vol-name">' + esc(storVolName(v)) + '</span>' +
      '<span class="stor-vol-big">' + esc(storSize(v.usedKb)) + '<small>' + esc(t('metrics.stor.ofTotal', 'of {total}', { total: storSize(v.totalKb) })) + '</small></span>' +
      storBar(parts, v.totalKb) +
      '<span class="stor-vol-sub">' + esc(v.partial
        ? t('metrics.stor.tooBig', 'Too much on it to look through')
        : t('metrics.stor.free', '{n} free', { n: storSize(v.freeKb) })) + '</span>' +
      '</button>';
  }).join('');
  box.querySelectorAll('.stor-vol').forEach(b => b.addEventListener('click', () => {
    storVol = b.getAttribute('data-dev');
    storPath = [];
    renderStorVolumes();
    renderStorMap();
  }));
}

function storCurrent() {
  const v = storLast && storLast.volumes.find(x => x.dev === storVol);
  if (!v || !v.tree) return null;
  let node = v.tree;
  const trail = [{ node, rel: '' }];
  for (const name of storPath) {
    const next = (node.c || []).find(c => c.n === name);
    if (!next) break;
    node = next;
    const rel = trail[trail.length - 1].rel;
    trail.push({ node, rel: rel ? rel + '/' + name : name });
  }
  storPath = trail.slice(1).map(x => x.node.n);
  return { v, node, trail };
}

/*
 * Squarified treemap (Bruls, Huizing and van Wijk): rows of tiles kept as
 * close to square as the sizes allow, so names fit and areas compare.
 */
function storSquarify(items, x, y, w, h) {
  const total = items.reduce((s, i) => s + i.s, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = w * h / total;
  const areas = items.map(i => i.s * scale);
  const out = [];
  let row = [];
  let start = 0;
  const worst = (r, side) => {
    const s = r.reduce((a, b) => a + b, 0);
    const mx = Math.max(...r), mn = Math.min(...r);
    return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
  };
  const place = () => {
    const s = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const rw = s / h;
      let yy = y;
      row.forEach((a, k) => { const hh = a / rw; out.push({ item: items[start + k], x, y: yy, w: rw, h: hh }); yy += hh; });
      x += rw; w -= rw;
    } else {
      const rh = s / w;
      let xx = x;
      row.forEach((a, k) => { const ww = a / rh; out.push({ item: items[start + k], x: xx, y, w: ww, h: rh }); xx += ww; });
      y += rh; h -= rh;
    }
    start += row.length;
    row = [];
  };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const cand = row.concat([areas[i]]);
    if (!row.length || worst(cand, side) <= worst(row, side)) { row = cand; i++; } else place();
  }
  if (row.length) place();
  return out;
}

function renderStorMap() {
  const map = q('stor-map');
  const crumbs = q('stor-crumbs');
  const cur = storCurrent();
  if (!cur) { map.innerHTML = ''; crumbs.innerHTML = ''; return; }
  const { v, node, trail } = cur;

  crumbs.innerHTML = trail.map((s, k) => {
    const label = k === 0 ? storVolName(v) : storNodeName(s.node, s.rel, v.kind);
    return k === trail.length - 1
      ? '<span class="stor-crumb now" aria-current="location">' + esc(label) + '</span>'
      : '<button type="button" class="stor-crumb" data-depth="' + k + '">' + esc(label) + '</button><span class="stor-crumb-sep" aria-hidden="true">›</span>';
  }).join('');
  crumbs.querySelectorAll('button[data-depth]').forEach(b => b.addEventListener('click', () => {
    storPath = storPath.slice(0, +b.getAttribute('data-depth'));
    renderStorMap();
  }));

  const kids = (node.c && node.c.length ? node.c : [node]).filter(c => c.s > 0);
  const W = map.clientWidth, H = map.clientHeight;
  storMapW = W;
  const rel = trail[trail.length - 1].rel;
  const GAP = 2;
  const tiles = storSquarify(kids, 0, 0, W, H);
  map.innerHTML = tiles.map((r, k) => {
    const n = r.item;
    const childRel = n === node ? rel : (rel ? rel + '/' + n.n : n.n);
    const name = storNodeName(n, childRel, v.kind);
    const w = Math.max(0, r.w - GAP), h = Math.max(0, r.h - GAP);
    const zoom = n !== node && n.n && n.c && n.c.length;
    const big = w >= 90 && h >= 46, mid = w >= 50 && h >= 24;
    const icon = n.a && w >= 110 && h >= 76
      ? '<img class="stor-tile-ico" src="' + api('/api/apps/icon?id=' + encodeURIComponent(n.a)) + '" alt="" loading="lazy">' : '';
    const label = big ? icon + '<span class="stor-tile-name">' + esc(name) + '</span><span class="stor-tile-size">' + esc(storSize(n.s)) + '</span>'
      : mid ? '<span class="stor-tile-name">' + esc(name) + '</span>' : '';
    const tag = zoom ? 'button type="button"' : 'div tabindex="0"';
    const close = zoom ? 'button' : 'div';
    // In shares of the map, less the gap, so a tile can never run past its edge
    // whatever the map's width when it was measured.
    const pc = (a, b) => (a / b * 100).toFixed(3) + '%';
    // A tile too small for a name has no padding either, which would otherwise
    // hold a button wider than its share and push it past the map's edge.
    const thin = !mid ? ' thin' : '';
    return '<' + tag + ' class="stor-tile ' + n.g + (n.n ? '' : ' rest') + (zoom ? ' zoom' : '') + thin + '" data-k="' + k + '"' +
      ' style="left:' + pc(r.x, W) + ';top:' + pc(r.y, H) + ';width:calc(' + pc(r.w, W) + ' - ' + GAP + 'px);height:calc(' + pc(r.h, H) + ' - ' + GAP + 'px)"' +
      ' aria-label="' + esc(name + ', ' + storSize(n.s)) + '">' + label + '</' + close + '>';
  }).join('') + '<div class="perf-tip stor-tip" id="stor-tip" hidden></div>';

  const tip = q('stor-tip');
  const show = (el, ev) => {
    const r = tiles[+el.getAttribute('data-k')];
    if (!r) return;
    const n = r.item;
    const childRel = n === node ? rel : (rel ? rel + '/' + n.n : n.n);
    const share = v.usedKb ? n.s / v.usedKb * 100 : 0;
    const app = n.a && storApp(n.a);
    let note = '';
    if (n.g === 'lg') note = t('metrics.stor.lgNote', 'LG puts this on every TV. It cannot be removed.');
    else if (app && app.removable && !app.own) note = t('metrics.stor.appNote', 'You can uninstall it from Apps.');
    tip.innerHTML = '<div class="perf-tip-t">' + esc(storNodeName(n, childRel, v.kind)) + '</div>' +
      '<div><span class="perf-sw ' + (n.g === 'app' ? 'sa' : n.g === 'lg' ? 'sb' : 'sn') + '"></span>' + esc(storGroupName(n.g)) + '<b>' + esc(storSize(n.s)) + '</b></div>' +
      '<div>' + esc(t('metrics.stor.share', 'Of what is used here')) + '<b>' + (share < 1 ? share.toFixed(1) : Math.round(share)) + '%</b></div>' +
      (n.n ? '<div class="stor-tip-path">' + esc(v.mount + '/' + childRel) + '</div>' : '') +
      (note ? '<div class="stor-tip-note">' + esc(note) + '</div>' : '');
    tip.hidden = false;
    const mw = map.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    let x, y;
    if (ev && ev.clientX != null) {
      const box = map.getBoundingClientRect();
      x = ev.clientX - box.left + 14; y = ev.clientY - box.top + 14;
    } else { x = r.x + 8; y = r.y + 8; }
    if (x + tw > mw - 4) x = Math.max(4, x - tw - 28);
    if (y + th > map.clientHeight - 4) y = Math.max(4, y - th - 28);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  map.querySelectorAll('.stor-tile').forEach(el => {
    el.addEventListener('mousemove', ev => show(el, ev));
    el.addEventListener('focus', () => show(el, null));
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
    el.addEventListener('blur', () => { tip.hidden = true; });
    if (el.classList.contains('zoom')) {
      el.addEventListener('click', () => {
        storPath.push(tiles[+el.getAttribute('data-k')].item.n);
        renderStorMap();
        const first = map.querySelector('.stor-tile');
        if (first && document.activeElement && document.activeElement !== document.body) first.focus();
      });
    }
  });

  const g = storGroups(node);
  q('stor-legend').innerHTML = [['app', 'sa'], ['lg', 'sb'], ['sys', 'sn']].filter(x => g[x[0]] > 0).map(x =>
    '<span class="perf-leg"><span class="perf-sw ' + x[1] + '"></span>' + esc(storGroupName(x[0])) + ' <b>' + esc(storSize(g[x[0]])) + '</b></span>').join('');
}

function storPartName(p) {
  const path = p.path;
  if (/\/var\/lib\/tvweb$/.test(path)) return t('metrics.stor.p.data', 'Data');
  if (/\/applications\/[^/]+$/.test(path)) return t('metrics.stor.p.app', 'App');
  if (/\/data\/images\/[^/]+$/.test(path)) return t('metrics.stor.p.artwork', 'Artwork');
  if (/\/jail\/[^/]+$/.test(path)) return t('metrics.stor.p.sandbox', 'Sandbox');
  if (/\/checkpoint\/[^/]+$/.test(path)) return t('metrics.stor.p.state', 'Saved state');
  if (/\/qcards\/[^/]+$/.test(path)) return t('metrics.stor.p.card', 'Home card');
  if (/\/packages\/[^/]+$/.test(path)) return t('metrics.stor.p.package', 'Package');
  return t('metrics.stor.p.other', 'Other');
}

function renderStorApps() {
  const box = q('stor-apps');
  const apps = (storLast.apps || []).filter(a => a.kb >= 64);
  const max = apps.length ? apps[0].kb : 1;
  const shown = storAppsAll ? apps : apps.slice(0, 10);
  box.innerHTML = shown.map(a => {
    const parts = {};
    a.parts.forEach(p => { const k = storPartName(p); parts[k] = (parts[k] || 0) + p.kb; });
    const detail = Object.keys(parts).sort((x, y) => parts[y] - parts[x]).map(k => k + ' ' + storSize(parts[k])).join(' · ');
    const g = a.removable ? 'app' : 'lg';
    const tag = a.own ? t('metrics.stor.tag.glasshouse', 'This dashboard')
      : a.removable ? t('metrics.stor.tag.installed', 'Installed') : t('metrics.stor.tag.builtin', 'Built in');
    const src = a.own ? '/assets/favicon.svg' : api('/api/apps/icon?id=' + encodeURIComponent(a.id));
    return '<li class="stor-app"><img class="stor-app-ico' + (a.own ? ' own' : '') + '" src="' + src + '" alt="" loading="lazy">' +
      '<div class="stor-app-main"><div class="stor-app-top"><span class="stor-app-name">' + esc(a.title) + '</span>' +
      '<span class="stor-app-tag ' + g + '">' + esc(tag) + '</span><span class="stor-app-size num">' + esc(storSize(a.kb)) + '</span></div>' +
      '<div class="stor-app-bar"><i class="stor-seg ' + g + '" style="width:' + Math.max(0.5, a.kb / max * 100).toFixed(2) + '%"></i></div>' +
      '<div class="stor-app-sub">' + esc(detail) + '</div></div></li>';
  }).join('');
  const more = q('stor-apps-more');
  more.hidden = apps.length <= 10;
  more.textContent = storAppsAll ? t('metrics.stor.fewer', 'Show fewer') : t('metrics.stor.all', 'Show all {n}', { n: apps.length });
}

q('stor-apps-more').addEventListener('click', () => { storAppsAll = !storAppsAll; renderStorApps(); });

// Laid out again whenever the map's own size changes: a scrollbar appearing,
// the sidebar folding, or the window resizing.
let storResize = null;
let storMapW = 0;
const storRelayout = () => {
  const w = q('stor-map').clientWidth;
  if (!storLast || !storOpen() || !w || w === storMapW) return;
  clearTimeout(storResize);
  storResize = setTimeout(renderStorMap, 120);
};
if (typeof ResizeObserver === 'function') new ResizeObserver(storRelayout).observe(q('stor-map'));
else window.addEventListener('resize', storRelayout);
