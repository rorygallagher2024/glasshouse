#!/usr/bin/env node
/*
 * Opens every tab of both dashboards in a headless browser, against the real
 * server and a fake TV, and fails on any script error.
 *
 * Unit tests run the server's code, not the pages': a function the page calls
 * that is gone, or an element it reaches for that has moved, shows only when
 * that tab opens in a browser. The server runs as in the start-up test
 * (test/mocks/boot-server.js), with LG's luna-send answered by
 * test/mocks/fake-luna-send.js, as a B8 answers.
 *
 * Needs Playwright and its Chromium, which CI installs for this job alone:
 *
 *   npm install --no-save playwright && npx playwright install chromium
 *   node scripts/check-dashboards.js
 *
 * BROWSER_CHANNEL=chrome uses an installed Chrome instead, with playwright-core
 * alone, as CI does: its runners have Chrome, which saves the download.
 */
'use strict';
const child = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('playwright-core').chromium; }

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'server', 'assets');

// The tabs as each page declares them, so a new tab is opened without editing this.
function webTabs() {
  const src = fs.readFileSync(path.join(ASSETS, 'ui', 'tabs.js'), 'utf8');
  const block = src.slice(src.indexOf('const TABS = {'), src.indexOf('};', src.indexOf('const TABS = {')));
  return [...block.matchAll(/^\s*(\w+):\s*'/gm)].map(m => m[1]);
}
function tvTabs() {
  const src = fs.readFileSync(path.join(ASSETS, 'dashboard.html'), 'utf8');
  const block = src.slice(src.indexOf('var TABS = ['), src.indexOf('];', src.indexOf('var TABS = [')));
  return [...block.matchAll(/\{\s*key:\s*'(\w+)'/g)].map(m => m[1]);
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function answers(port) {
  return new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, res => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false));
  });
}

async function startServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-dashboards-'));
  const files = require(path.join(ROOT, 'test', 'mocks', 'mock-env')).createMockEnv().files;
  for (const f of Object.keys(files)) {
    if (files[f] === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), files[f]);
  }
  for (const d of ['var/run', 'var/luna/preferences', 'var/lib/tvweb']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'var/luna/preferences/paneltype_oled'), '');
  const port = await freePort();
  const cfg = path.join(root, 'var/lib/tvweb/config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port, host: '127.0.0.1' }));
  const fake = path.join(ROOT, 'test', 'mocks', 'fake-luna-send.js');
  fs.chmodSync(fake, 0o755);
  // Each app the fake TV lists gets its folder, with an appinfo.json and an
  // icon, so the dashboards' icons load as on a TV instead of answering 404.
  const listed = JSON.parse(child.execFileSync(process.execPath,
    [fake, '-n', '1', 'luna://com.webos.applicationManager/listApps', '{}'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { FAKE_LUNA_CHAOS: '' }) }));
  for (const app of listed.apps || []) {
    if (!app.folderPath) continue;
    const dir = path.join(root, app.folderPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'appinfo.json'), JSON.stringify({ id: app.id, title: app.title, icon: 'icon.png' }));
    fs.copyFileSync(path.join(ASSETS, 'dashboard-app/assets/icon80.png'), path.join(dir, 'icon.png'));
  }
  let out = '';
  const srv = child.spawn(process.execPath, [path.join(ROOT, 'test', 'mocks', 'boot-server.js'), '--config', cfg], {
    env: Object.assign({}, process.env, { FAKE_ROOT: root, TVWEB_LUNA_SEND: fake })
  });
  srv.stdout.on('data', d => { out += d; });
  srv.stderr.on('data', d => { out += d; });
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 60; i++) {
    if (await answers(port)) return { port, output: () => out };
    if (srv.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('the server did not start:\n' + out.slice(-3000));
}

/*
 * Done once the tab's requests have all answered and none has started for
 * QUIET_MS - a tab's script runs when its data arrives, which is where it
 * breaks - or after MAX_MS, so a slow tab cannot hold the run up.
 */
const QUIET_MS = 500, MAX_MS = 4000;

async function visit(browser, url, label, problems) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => problems.push(label + ': ' + e.message));
  // A failed request is reported with its address, which Chrome's console
  // line leaves out. Chrome, unlike the bundled browser, asks for a favicon
  // the server does not have. A 404 for an app's icon is the server saying the
  // app has none, which the page hides; the fake TV's installed apps have no
  // icon files, and the Apps tab asks for them only when its list arrives in
  // time.
  page.on('console', m => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(label + ': console: ' + m.text());
  });
  page.on('response', r => {
    const expected = /\/favicon\.ico$/.test(r.url()) || (r.status() === 404 && /\/api\/apps\/icon\?/.test(r.url()));
    if (r.status() >= 400 && !expected) problems.push(label + ': ' + r.status() + ' for ' + r.url());
  });
  let open = 0, last = Date.now();
  page.on('request', () => { open++; last = Date.now(); });
  const done = () => { open = Math.max(0, open - 1); last = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.goto(url, { waitUntil: 'load' });
  const until = Date.now() + MAX_MS;
  while (Date.now() < until && (open > 0 || Date.now() - last < QUIET_MS)) await page.waitForTimeout(100);
  await page.close();
}

// A few tabs at a time: each is its own page, so they cannot affect each other.
async function visitAll(browser, jobs, problems) {
  let next = 0;
  async function worker() { while (next < jobs.length) { const j = jobs[next++]; await visit(browser, j.url, j.label, problems); } }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// Each row's Order, on the Home tab and the TV app's Home section.
async function visitHomeOrder(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home order: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  const saves = [];
  await page.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    // The server sends a Last opened row in that order: here, YouTube was opened last.
    const order = { app: layout.sort.app === 'recent' ? ['two', 'one', 'lg-home'] : ['one', 'two', 'lg-home'], dev: [], ch: [] };
    const catalogue = { ok: true, apps: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], devices: [], channels: [],
      sources: { channels: 0 }, order, layout };
    let body = { ok: true };
    if (pathname === '/api/home') body = Object.assign({ ok: true, supported: { ok: true }, enabled: true, active: true,
      writable: true, layout, history: true }, new URL(route.request().url()).searchParams.get('with') ? { catalogue, channels: [] } : {});
    else if (pathname === '/api/home/catalogue') body = catalogue;
    else if (pathname === '/api/home/layout') {
      const patch = route.request().postDataJSON();
      saves.push(patch);
      if (patch.sort) Object.assign(layout.sort, patch.sort);
      body = { ok: true, layout: JSON.parse(JSON.stringify(layout)) };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    layout.sort.app = 'recent';
    await page.goto(base + '/?tab=home');
    await page.locator('details.home-row[data-kind="app"] summary').click();
    await page.waitForSelector('#home-sort-app:not(:disabled)');
    if (!await page.locator('details.home-row[data-kind="app"] .home-tile button[aria-label="Later"]').first().isDisabled()) {
      problems.push('Home order: tiles in a Last opened row can be moved on the Home tab');
    }
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await page.locator('#home-sort-app').selectOption('custom');
    await saved;
    if (saves[saves.length - 1].sort.app !== 'custom') problems.push('Home order: the Home tab did not save Your order');

    await page.goto(base + '/assets/dashboard.html?tab=home');
    await page.waitForFunction(() => document.body.innerText.indexOf('Your order') !== -1);
    // One for Apps and one for Channels: the fixture has no inputs, and an empty row has no section.
    const orders = await page.evaluate(() => (document.body.innerText.match(/Your order|Last opened/g) || []).length);
    if (orders !== 2) problems.push('Home order: the TV app\'s Home section has no Order for each row');
  } finally { await page.close(); }
}

// Saves are acknowledged before another edit can replace a whole list.
async function visitHomeEditor(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home editor: ' + e.message));
  let layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: ['a'], hintSeen: true, searchHintSeen: true };
  const channels = ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), number: id }));
  const saves = [];
  let release = null, refuse = false, pendingRestore = false, portChanged = false;
  await page.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body;
    if (pathname === '/api/home') body = { ok: true, supported: { ok: !portChanged }, installed: true,
      enabled: !pendingRestore, restorePending: pendingRestore, active: true, writable: true, layout, history: true };
    else if (pathname.endsWith('/catalogue')) body = { ok: true, apps: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], devices: [],
      channels: channels.filter(c => layout.channels.includes(c.id)),
      order: { app: layout.order.app.length ? layout.order.app : ['one', 'two', 'lg-home'], dev: [], ch: layout.channels }, layout };
    else if (pathname.endsWith('/channels')) body = { ok: true, channels };
    else if (pathname.endsWith('/layout')) {
      const patch = route.request().postDataJSON();
      saves.push(patch);
      if (refuse) body = { ok: false, error: 'save refused' };
      else {
        if (patch.channels) layout.channels = patch.channels;
        if (patch.order) Object.assign(layout.order, patch.order);
        body = { ok: true, layout: JSON.parse(JSON.stringify(layout)) };
        if (saves.length === 1) await new Promise(resolve => { release = resolve; });
      }
    } else body = { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(base + '/?tab=home');
    const appRows = page.locator('details.home-row[data-kind="app"] .home-tile');
    const ready = () => page.waitForFunction(() => {
      const button = document.querySelector('details.home-row[data-kind="app"] .home-tile button[aria-label="Later"]');
      return button && !button.disabled;
    });
    await ready();
    await page.locator('details.home-row[data-kind="app"] summary').click();
    await page.locator('details.home-row[data-kind="ch"] summary').click();
    await page.getByRole('button', { name: 'Show channels', exact: true }).click();
    const add = id => page.locator('#home-ch-list .prot-row').filter({ hasText: id + ' ' + id.toUpperCase() }).getByRole('button', { name: 'Add', exact: true });
    await add('b').click();
    await page.waitForTimeout(100);
    if (!await add('c').isDisabled()) problems.push('Home editor: controls remain enabled during a pending save');
    await add('c').click({ force: true });
    await page.waitForTimeout(100);
    if (saves.length !== 1) problems.push('Home editor: a pending save allowed a second stale channel list');
    release();
    await ready();
    if (await add('c').count()) { await add('c').click(); await ready(); }
    if (JSON.stringify(layout.channels) !== JSON.stringify(['a', 'b', 'c'])) problems.push('Home editor: an acknowledged channel was lost');
    refuse = true;
    const refused = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await appRows.first().getByRole('button', { name: 'Later', exact: true }).click();
    await refused; await ready();
    if (await appRows.first().locator('[translate="no"]').textContent() !== 'One') problems.push('Home editor: refused move remained visible');
    pendingRestore = true;
    await page.reload();
    await page.waitForSelector('#home-switch:not(:disabled)');
    if (!await page.locator('#home-switch').textContent().then(t => /Retry/.test(t))) problems.push('Home editor: failed restoration has no retry action');
    pendingRestore = false; portChanged = true;
    await page.reload();
    await page.waitForTimeout(200);
    if (await page.locator('#home-switch').isDisabled()) problems.push('Home editor: changing the port blocked switching Home off');
  } finally { await page.close(); }
}

async function visitHomeUploads(browser, base, problems) {
  const context = await browser.newContext();
  const page = await context.newPage(), observer = await context.newPage();
  for (const p of [page, observer]) p.on('pageerror', e => problems.push('Home uploads: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  let uploading = false, uploaded = false, release, image;
  const wallpapers = () => ({ available: uploaded, uploading,
    slots: { morning: uploaded }, revision: uploaded ? '1' : '0' });
  await context.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body;
    if (pathname === '/api/home/wallpaper') return route.fulfill({ contentType: 'image/jpeg', body: image });
    if (pathname.endsWith('/upload')) {
      image = route.request().postDataBuffer();
      if (!image || image.readUInt16BE(0) !== 0xffd8 || route.request().headers()['content-type'] !== 'image/jpeg') {
        problems.push('Home uploads: PNG was not prepared as a JPEG');
      }
      uploading = true;
      await new Promise(resolve => { release = resolve; });
      uploading = false; uploaded = true;
      body = { ok: true, wallpapers: wallpapers() };
    } else if (pathname === '/api/home/wallpapers') {
      if (route.request().postDataJSON().removeUploads) uploaded = false;
      body = { ok: true, wallpapers: wallpapers() };
    } else if (pathname === '/api/home') {
      body = { ok: true, supported: { ok: true }, installed: true, enabled: true, writable: true, layout, wallpapers: wallpapers() };
    } else {
      body = { ok: true, layout, apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 } };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(base + '/?tab=home');
    await page.waitForFunction(() => typeof homeStatus !== 'undefined' && homeStatus && homeCat);
    await page.waitForSelector('#home-wall-slot:not(:disabled)');
    await page.locator('#home-wall-file').setInputFiles(path.join(ASSETS, 'dashboard-app/assets/icon130.png'));
    const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith('/wallpapers/upload'));
    await page.locator('#home-wall-upload').click(); await sent;
    await observer.goto(base + '/?tab=home');
    await observer.getByRole('button', { name: 'Uploading…', exact: true }).waitFor();
    if (!await observer.locator('#home-wall-slot').isDisabled()) problems.push('Home uploads: another tab did not show the pending upload');
    release();
    await observer.waitForSelector('#home-wall-slot:not(:disabled)');
    await page.waitForSelector('#home-wall-slot:not(:disabled)');
    await page.waitForFunction(() => {
      const image = document.querySelector('#home-walls img');
      return image && image.complete && image.naturalWidth;
    });
    await page.locator('#home-wall-clear').click();
    await page.waitForFunction(() => !document.querySelector('#home-walls img'));
  } finally { await context.close(); }
}

/*
 * The Home tab: left out where neither Glasshouse Home nor LG's Home's options
 * are offered; with LG's Home's options alone (a B8) it shows only those, Open
 * Home at power-on among them, usable without Glasshouse Home; and
 * with Glasshouse Home on, LG's Home's layout is left out and hidden system
 * apps stay.
 */
async function visitHomeAvailability(browser, base, problems) {
  const lgHome = enabled => ({ writable: true, glasshouseHome: enabled,
    homeScreen: { parts: [{ id: 'banner', title: 'Banner', desc: 'The banner.', shown: true }], inputs: null, experimental: null },
    tileHidingAvailable: true, tileHidingEnabled: false, systemTiles: [], hiddenCount: 0 });
  const cases = [
    { name: 'unavailable', st: { available: false, enabled: false }, glasshouse: false },
    { name: 'LG\'s Home only', st: { available: true, enabled: false, lgHomeAvailable: true, lgHome: lgHome(false), homeAutoLaunch: false }, glasshouse: false },
    { name: 'Glasshouse Home on', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true) }, glasshouse: true }
  ];
  for (const c of cases) {
    const st = c.st;
    const page = await browser.newPage();
    page.on('pageerror', e => problems.push('Home availability: ' + e.message));
    await page.route('**/api/home**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(Object.assign({
      ok: true, supported: { ok: c.glasshouse }, installed: true, restorePending: false, writable: true,
      layout: { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true },
      apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 }, wallpapers: { slots: {} }
    }, st)) }));
    const fail = what => problems.push('Home availability (' + c.name + '): ' + what);
    try {
      await page.goto(base + '/?tab=home');
      await page.waitForFunction(() => homeAvailable !== null);
      await page.waitForTimeout(100);
      const hidden = await page.locator('#tab-btn-home').isHidden();
      if (hidden === st.available) fail('tab ' + (hidden ? 'hidden' : 'shown'));
      if (!st.available) {
        if (await page.evaluate(() => activeTab) !== 'control') fail('an unavailable Home tab stayed open');
        continue;
      }
      if (await page.locator('#home-hero').isVisible() !== c.glasshouse) fail('Glasshouse Home\'s switch ' + (c.glasshouse ? 'missing' : 'shown'));
      if (!await page.locator('#disc-system-tiles').isVisible()) fail('system apps missing');
      if (st.homeAutoLaunch !== undefined && (!await page.locator('#home-autolaunch').isVisible() || await page.locator('#home-autolaunch').isDisabled()))
        fail('Open Home at power-on missing or unusable');
      if (!c.glasshouse && await page.locator('#home-picture-row').isVisible()) fail('Glasshouse Home\'s options shown without it');
      if (await page.locator('#disc-homescreen').isVisible() === st.enabled) fail('LG\'s Home layout ' + (st.enabled ? 'shown with Glasshouse Home on' : 'missing'));
    } finally { await page.close(); }
  }
}



async function visitTvDashboard(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('TV dashboard: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) {
      problems.push('TV dashboard: console: ' + m.text());
    }
  });

  try {
    await page.goto(base + '/assets/dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#rows .row');
    await page.waitForTimeout(100);

    // Two-column layout geometry check
    const layout = await page.evaluate(() => {
      const main = document.getElementById('main').getBoundingClientRect();
      const list = document.getElementById('list').getBoundingClientRect();
      const hint = document.getElementById('hint').getBoundingClientRect();
      const sel = document.querySelector('.row.sel');
      return {
        main: { w: main.width, h: main.height },
        list: { left: list.left, right: list.right, w: list.width, h: list.height },
        hint: { left: hint.left, right: hint.right, w: hint.width, h: hint.height },
        hasSel: !!sel,
        selLabel: sel ? (sel.querySelector('.lbl') ? sel.querySelector('.lbl').textContent.trim() : '') : ''
      };
    });

    if (layout.main.w <= 0 || layout.main.h <= 0) {
      problems.push('TV dashboard: #main has 0 dimensions (' + layout.main.w + 'x' + layout.main.h + ')');
    }
    if (layout.list.w <= 0 || layout.list.h <= 0) {
      problems.push('TV dashboard: #list column has 0 dimensions (' + layout.list.w + 'x' + layout.list.h + ')');
    }
    if (layout.hint.w <= 0 || layout.hint.h <= 0) {
      problems.push('TV dashboard: #hint column has 0 dimensions (' + layout.hint.w + 'x' + layout.hint.h + ')');
    }
    if (layout.hint.left < layout.list.right - 1) {
      problems.push('TV dashboard: #hint is not to the right of #list (hint left: ' + layout.hint.left + ', list right: ' + layout.list.right + ')');
    }
    if (!layout.hasSel) {
      problems.push('TV dashboard: no row is selected initially');
    }

    // Remote D-pad navigation: ArrowDown / ArrowUp moves selection and updates hint
    const initialTitle = await page.evaluate(() => document.getElementById('hintTitle').textContent.trim());
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(50);
    const secondTitle = await page.evaluate(() => document.getElementById('hintTitle').textContent.trim());
    if (!secondTitle || secondTitle === initialTitle) {
      problems.push('TV dashboard: ArrowDown did not update selected row hint title');
    }

    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(50);
    const restoredTitle = await page.evaluate(() => document.getElementById('hintTitle').textContent.trim());
    if (restoredTitle !== initialTitle) {
      problems.push('TV dashboard: ArrowUp did not restore initial row selection');
    }

    // PageDown / ChannelDown jumps multiple rows
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(50);
    const pagedTitle = await page.evaluate(() => document.getElementById('hintTitle').textContent.trim());
    if (pagedTitle === initialTitle || pagedTitle === secondTitle) {
      problems.push('TV dashboard: PageDown did not jump selection forward');
    }

    // Repeated ArrowDown triggers translateY scroll and illuminates moreUp
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(20);
    }
    const scrollState = await page.evaluate(() => {
      const rows = document.getElementById('rows');
      const tr = rows.style.transform || rows.style.webkitTransform || '';
      const moreUp = document.getElementById('moreUp').classList.contains('on');
      return { transform: tr, moreUp };
    });
    if (!/translateY\(-/.test(scrollState.transform)) {
      problems.push('TV dashboard: scrolling down list did not apply negative translateY: ' + scrollState.transform);
    }
    if (!scrollState.moreUp) {
      problems.push('TV dashboard: scrolling down list did not illuminate moreUp arrow');
    }

    // Remote navigation: ArrowRight / ArrowLeft switches tabs
    const initialTab = await page.evaluate(() => {
      const on = document.querySelector('.tab.on');
      return on ? on.textContent.trim() : '';
    });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    const nextTab = await page.evaluate(() => {
      const on = document.querySelector('.tab.on');
      return on ? on.textContent.trim() : '';
    });
    if (!nextTab || nextTab === initialTab) {
      problems.push('TV dashboard: ArrowRight did not switch tabs (stayed on ' + initialTab + ')');
    }

    // Verify two columns still intact after tab switch
    const newTabListHeight = await page.evaluate(() => document.getElementById('list').getBoundingClientRect().height);
    if (newTabListHeight <= 0) {
      problems.push('TV dashboard: #list collapsed to 0 height after switching tabs to ' + nextTab);
    }

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(100);
    const backTab = await page.evaluate(() => {
      const on = document.querySelector('.tab.on');
      return on ? on.textContent.trim() : '';
    });
    if (backTab !== initialTab) {
      problems.push('TV dashboard: ArrowLeft did not return to ' + initialTab + ' (on ' + backTab + ')');
    }
  } finally {
    await page.close();
  }
}

async function visitTvAudio(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('TV audio: ' + e.message));
  const state = await page.request.get(base + '/api/audio?with=settings').then(r => r.json());
  let failed = false;
  await page.route('**/api/audio*', route => route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json',
    body: JSON.stringify(failed ? { ok: false, error: 'Audio service unavailable' } : state) }));
  const selected = () => page.locator('#rows .row.sel .lbl').textContent();
  const readings = () => page.locator('#rows .row').filter({ hasText: 'Return channel' });
  async function open() {
    await page.goto(base + '/assets/dashboard.html?tab=audio');
    await page.waitForSelector(failed ? '#rows .row:has-text("Audio readings unavailable")' : '#rows .row:has-text("Return channel")');
  }
  try {
    await open();
    if (await selected() !== 'Sound output') problems.push('TV audio: did not open on the Sound settings');
    failed = true;
    await open();
    if (await readings().count()) problems.push('TV audio: a failed read left stale readings on screen');
    failed = false;
    await page.keyboard.press('Enter');
    await page.waitForSelector('#rows .row:has-text("Return channel")');
    await page.goto(base + '/assets/dashboard.html?tab=options');
    await page.waitForSelector('#rows .row');
    if (await page.locator('#rows .row').filter({ hasText: /Audio capabilities|Sound output/ }).count()) problems.push('TV audio: sound still listed under System');
  } finally { await page.close(); }
}
async function visitTvNonOled(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('TV non-OLED: ' + e.message));
  await page.route('**/api/oledcare', route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, isOled: false, available: false }) });
  });
  try {
    await page.goto(base + '/assets/dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#rows .row');
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab')].map(t => t.textContent.trim().toLowerCase()));
    if (tabs.indexOf('oled care') !== -1) {
      problems.push('TV non-OLED: OLED Care tab was not omitted on an LCD TV');
    }
  } finally {
    await page.close();
  }
}

async function visitAudio(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Web audio: ' + e.message));
  try {
    const state = await page.request.get(base + '/api/audio?with=settings').then(r => r.json());
    let failed = false;
    await page.route('**/api/audio*', route => {
      if (failed) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Audio service unavailable' }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) });
    });
    await page.goto(base + '/?tab=audio');
    await page.waitForFunction(() => audioState !== null);
    if (!await page.locator('#audio-settings [data-lgs]').count()) problems.push('Audio tab: LG sound settings missing');
    failed = true;
    // The readings and their Refresh are folded below the settings.
    await page.locator('#audio-more > summary').click();
    await page.locator('#audio-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#audio-error').hidden);
    if (await page.locator('#audio-readings').isVisible() || await page.locator('#audio-settings :enabled').count())
      problems.push('Web audio: a failed read left stale controls usable');
    failed = false;
    await page.locator('#audio-refresh').click();
    await page.waitForFunction(() => document.querySelector('#audio-error').hidden);
    if (!await page.locator('#audio-readings').isVisible()) problems.push('Web audio: readings did not recover after a failed read');
  } finally { await page.close(); }
}

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.port;
  const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  const problems = [];
  const web = webTabs(), tv = tvTabs();
  await visitAll(browser, web.map(t => ({ url: base + '/?tab=' + t, label: 'web ' + t }))
    .concat(tv.map(t => ({ url: base + '/assets/dashboard.html?tab=' + t, label: 'TV ' + t }))), problems);
  await visitTvDashboard(browser, base, problems);
  await visitTvAudio(browser, base, problems);
  await visitTvNonOled(browser, base, problems);
  await visitHomeEditor(browser, base, problems);
  await visitHomeOrder(browser, base, problems);
  await visitHomeUploads(browser, base, problems);
  await visitHomeAvailability(browser, base, problems);
  await visitAudio(browser, base, problems);
  await browser.close();
  for (const p of problems) console.log(p);
  console.log((web.length + tv.length) + ' tabs opened (' + web.length + ' web, ' + tv.length + ' TV app), ' +
              'TV navigation, audio and LCD profile, and the Home tab\'s editing, order, uploads and availability checked, ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's'));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
