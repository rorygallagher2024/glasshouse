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

async function visitHomePicture(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home picture: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true };
  const hdmi4 = { ok: true, range: 'hdr', mode: { display: 'HDR Filmmaker' }, light: 100, oled: true,
    signal: { width: 3840, height: 2160, hz: 24, chroma: 'YCbCr 4:4:4', bits: 10, hdr: 'hdr10' } };
  const netflix = { ok: true, range: 'dolbyHdr', mode: { display: 'Dolby Vision Cinema Bright' }, light: 100, oled: true,
    signal: { width: 3840, height: 2160, hz: 23.98, hdr: 'dolby_vision', played: true } };
  const asleep = { ok: true, range: null, mode: null, light: null, oled: true, signal: null };
  let source = { kind: 'input', port: 4, title: 'HDMI 4' };
  let releaseCatalogue = null, latePicture = null, holdPicture = false, pictureReads = 0;
  const reply = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalogue')) {
      const body = { ok: true, layout, apps: [], devices: [], channels: [], sources: { channels: 0 },
        order: { app: ['lg-home'], dev: [], ch: [] } };
      if (!releaseCatalogue) {
        const snapshot = JSON.parse(JSON.stringify(body));
        releaseCatalogue = () => reply(route, snapshot);
        return;
      }
      return reply(route, body);
    }
    if (url.pathname.endsWith('/now')) return reply(route, source);
    if (url.pathname.endsWith('/picture')) {
      pictureReads++;
      const body = url.searchParams.get('kind') === 'app' ? netflix : url.searchParams.get('port') === '2' ? asleep : hdmi4;
      if (holdPicture) {
        holdPicture = false;
        latePicture = () => reply(route, body);
        return;
      }
      return reply(route, body);
    }
    return reply(route, { ok: true, build: 'one' });
  });
  async function returned() {
    const catalogue = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    const now = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/now');
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await Promise.all([catalogue, now]);
    await page.waitForTimeout(100);
  }
  async function delayPicture() {
    latePicture = null;
    holdPicture = true;
    await page.clock.fastForward(15000);
    const until = Date.now() + 4000;
    while (!latePicture && Date.now() < until) await page.waitForTimeout(20);
    if (!latePicture) throw new Error('Home picture: no refresh to delay');
  }
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForFunction(() => document.getElementById('srcTitle').textContent === 'HDMI 4');
    if (pictureReads) problems.push('Home picture: fetched a plate before the layout was known');
    await releaseCatalogue();
    await page.waitForSelector('.tile');
    await page.waitForTimeout(100);
    if (await page.locator('#plate').isVisible()) problems.push('Home picture: a layout without picture details showed a plate');
    layout.picture = true;
    await returned();
    await page.waitForFunction(() => document.getElementById('plMode').textContent === 'HDR Filmmaker');
    if (await page.locator('#plStrip > div').count() !== 1) problems.push('Home picture: the strip held more than the OLED light');
    source = { kind: 'input', port: 2, title: 'HDMI 2' };
    await returned();
    await page.waitForFunction(() => document.getElementById('plSig').textContent === 'No picture coming in');
    const level = await page.evaluate(() => {
      const top = id => document.getElementById(id).getBoundingClientRect().top;
      return { shown: document.getElementById('plMode').textContent + document.getElementById('plStrip').textContent,
        off: Math.abs(top('plSig') - top('srcKind')) };
    });
    if (level.shown) problems.push('Home picture: no signal still showed a mode or OLED light');
    if (level.off > 1) problems.push('Home picture: no signal left its line off the source\'s first line');
    source = { kind: 'input', port: 4, title: 'HDMI 4' };
    await returned();
    await page.waitForFunction(() => document.getElementById('plMode').textContent === 'HDR Filmmaker');
    await delayPicture();
    source = { kind: 'app', appId: 'netflix', title: 'Netflix' };
    await returned();
    await page.waitForFunction(() => document.getElementById('plMode').textContent === 'Dolby Vision Cinema Bright');
    await latePicture();
    await page.waitForTimeout(100);
    if (await page.locator('#plMode').textContent() !== 'Dolby Vision Cinema Bright') problems.push('Home picture: a late HDMI reply replaced the app picture');
    await delayPicture();
    layout.picture = false;
    await returned();
    if (await page.locator('#plate').isVisible()) problems.push('Home picture: returning with details off kept the plate');
    await latePicture();
    await page.waitForTimeout(100);
    if (await page.locator('#plate').isVisible()) problems.push('Home picture: a late reply restored a disabled plate');
  } finally { await page.close(); }
}

// The Magic Remote's pointer on a row of 30 apps: hover only focuses, resting
// at the screen's side glides the row, a click opens the tile under the
// pointer, the wheel scrolls, the keys go on from what is in view, and
// closing Recent apps while its cards glide leaves the rows scrolling.
async function visitHomeScrolling(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home scrolling: ' + e.message));
  const apps = Array.from({ length: 30 }, (_, i) => ({ id: 'app' + i, title: 'App ' + i }));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true };
  const opened = [];
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/catalogue')) {
      return reply({ ok: true, layout, apps, devices: [{ id: 'hdmi1:box', name: 'Box', port: 1 }], channels: [],
        sources: { channels: 0 }, order: { app: apps.map(a => a.id), dev: ['hdmi1:box'], ch: [] } });
    }
    if (url.pathname.endsWith('/now')) return reply({ kind: null });
    if (url.pathname.endsWith('/open')) { opened.push(JSON.parse(route.request().postData() || '{}')); return reply({ ok: true }); }
    if (url.pathname.endsWith('/recents')) return reply({ ok: true, apps: apps.slice(0, 12).map(a => ({ id: a.id, title: a.title })) });
    return reply({ ok: true, build: 'one' });
  });
  const x = sel => page.evaluate(sel => {
    const m = /translateX\((-?[\d.]+)px\)/.exec(document.querySelector(sel).style.transform || '');
    return m ? -parseFloat(m[1]) : 0;
  }, sel);
  const apps0 = '.row[data-key="app"] .track';
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.row[data-key="app"] .tile');
    const rowY = await page.evaluate(() => { const r = document.querySelector('.row[data-key="app"] .wrap').getBoundingClientRect(); return r.top + r.height / 2; });
    await page.mouse.move(900, rowY);
    await page.waitForTimeout(300);
    if (await x(apps0) !== 0) problems.push('Home scrolling: hovering a tile moved its row');
    await page.mouse.move(1880, rowY, { steps: 3 });
    await page.waitForTimeout(600);
    const glided = await x(apps0);
    if (glided < 200) problems.push('Home scrolling: resting at the screen\'s side did not glide the row (' + glided + ' px)');
    // Held still over a tile near the end while the row glides under it, a
    // click, with no move before it, opens the tile under the pointer.
    const still = [1760, rowY];
    await page.mouse.move(still[0], still[1]);
    await page.waitForTimeout(500);
    const under = await page.evaluate(([px, py]) => { let t = document.elementFromPoint(px, py); while (t && !/\btile\b/.test(t.className)) t = t.parentNode; return t && t.querySelector('.nm').textContent; }, still);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    const last = opened[opened.length - 1];
    if (!last || 'App ' + last.id.slice(3) !== under) problems.push('Home scrolling: a click opened ' + (last && last.id) + ', not the tile under the pointer, ' + under);
    await page.mouse.move(900, rowY);
    await page.waitForTimeout(700);
    const stopped = await x(apps0);
    await page.waitForTimeout(300);
    if (await x(apps0) !== stopped) problems.push('Home scrolling: the glide went on after the pointer left the end');
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(500);
    if (Math.round(await x(apps0) - stopped) !== 176) problems.push('Home scrolling: a wheel notch did not move the row one tile');
    // Wheel steps move tiles under a still pointer: a click then opens the
    // tile now under it, and moving down a row leaves this row where it is.
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(600);
    const wheeled = await x(apps0);
    const underWheel = await page.evaluate(([px, py]) => { let t = document.elementFromPoint(px, py); while (t && !/\btile\b/.test(t.className)) t = t.parentNode; return t && t.querySelector('.nm').textContent; }, [900, rowY]);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    const afterWheel = opened[opened.length - 1];
    if (!afterWheel || 'App ' + afterWheel.id.slice(3) !== underWheel) problems.push('Home scrolling: after the wheel a click opened ' + (afterWheel && afterWheel.id) + ', not ' + underWheel);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    if (Math.abs(await x(apps0) - wheeled) > 1) problems.push('Home scrolling: moving down a row pulled the wheeled row back');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    const before = await x(apps0);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    if (Math.abs(await x(apps0) - before) > 1) problems.push('Home scrolling: moving down a row pulled the scrolled row above back');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    if (Math.abs(await x(apps0) - before) > 200) problems.push('Home scrolling: the keys pulled a scrolled row back');
    if (!(await page.evaluate(() => { const f = document.querySelector('.row .tile.focus'), w = f.parentNode.parentNode.getBoundingClientRect(), r = f.getBoundingClientRect(); return r.right > w.left && r.left < w.right; })))
      problems.push('Home scrolling: the keys focused a tile out of view');
    // Recent apps: glide its cards, close it, and the rows still glide.
    await page.keyboard.press('Backspace');
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 461, bubbles: true })));
    await page.waitForSelector('#recents .tile.rc');
    await page.waitForTimeout(400);
    const cards = await page.evaluate(() => { const r = document.querySelector('#recents .wrap').getBoundingClientRect(); return { y: r.top + r.height / 2, x: r.right - 60 }; });
    // Over a card in the panel's end zone, the cards glide; a click there
    // opens that app and the panel closes while the cards are still moving.
    await page.mouse.move(cards.x, cards.y, { steps: 3 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500);
    const rowsAt = await x(apps0);
    await page.mouse.move(1870, rowY, { steps: 3 });
    await page.waitForTimeout(500);
    if (await x(apps0) <= rowsAt) problems.push('Home scrolling: after Recent apps closed mid-glide, the rows no longer glide');
  } finally { await page.close(); }
}

/*
 * A row's place frame by frame, read in a frame callback: a flick to the
 * screen's side gathers speed over several frames, the row brakes into its
 * end, and moving the pointer away lets it slow to a stop.
 */
async function visitHomeMotion(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home motion: ' + e.message));
  const apps = Array.from({ length: 30 }, (_, i) => ({ id: 'app' + i, title: 'App ' + i }));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true };
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/catalogue')) {
      return reply({ ok: true, layout, apps, devices: [], channels: [],
        sources: { channels: 0 }, order: { app: apps.map(a => a.id), dev: [], ch: [] } });
    }
    if (url.pathname.endsWith('/now')) return reply({ kind: null });
    return reply({ ok: true, build: 'one' });
  });
  const mark = () => page.evaluate(() => window.xs.length);
  const steps = from => page.evaluate(from => {
    const d = [];
    for (let i = from + 1; i < window.xs.length; i++) if (window.xs[i] !== window.xs[i - 1]) d.push(window.xs[i] - window.xs[i - 1]);
    return d;
  }, from);
  const show = d => d.map(v => v.toFixed(1)).join(', ');
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.row[data-key="app"] .tile');
    const rowY = await page.evaluate(() => { const r = document.querySelector('.row[data-key="app"] .wrap').getBoundingClientRect(); return r.top + r.height / 2; });
    await page.mouse.move(900, rowY);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.xs = [];
      const track = document.querySelector('.row[data-key="app"] .track');
      (function read() {
        const m = /translateX\((-?[\d.]+)px\)/.exec(track.style.transform || '');
        window.xs.push(m ? -parseFloat(m[1]) : 0);
        requestAnimationFrame(read);
      })();
    });
    let at = await mark();
    await page.mouse.move(1880, rowY);
    await page.waitForTimeout(400);
    let d = await steps(at);
    if (d.length < 3) problems.push('Home motion: a flick to the screen\'s side did not glide the row');
    else if (d[0] > 10 || d[1] > 14) problems.push('Home motion: a glide started at full speed (' + show(d.slice(0, 3)) + ' px a frame)');
    await page.waitForFunction(() => { const xs = window.xs, n = xs.length; return n > 12 && xs[n - 1] > 1000 && xs[n - 1] === xs[n - 12]; }, null, { timeout: 10000 });
    d = await steps(at);
    const end = await page.evaluate(() => { const w = document.querySelector('.row[data-key="app"] .wrap'); return w.querySelector('.track').scrollWidth - (w.clientWidth - 44); });
    const rest = await page.evaluate(() => window.xs[window.xs.length - 1]);
    if (Math.abs(rest - end) > 1) problems.push('Home motion: the glide stopped at ' + rest + ' px, not at the row\'s end, ' + end);
    if (Math.max.apply(null, d) < 18) problems.push('Home motion: the glide never reached its speed (' + Math.max.apply(null, d).toFixed(1) + ' px a frame)');
    if (Math.max.apply(null, d.slice(-3)) > 12) problems.push('Home motion: the row ran into its end (' + show(d.slice(-3)) + ' px a frame)');
    await page.mouse.move(20, rowY);
    await page.waitForTimeout(700);
    at = await mark();
    await page.mouse.move(900, rowY);
    await page.waitForTimeout(800);
    d = await steps(at);
    if (d.length < 6 || Math.abs(d[d.length - 1]) > 3) problems.push('Home motion: the glide stopped dead when the pointer left the end (' + show(d) + ')');
  } finally { await page.close(); }
}

/*
 * A channel's programme moves on through the minute's refresh with its tile
 * left in place: the rows are not rebuilt for the progress bar.
 */
async function visitHomeGuide(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home guide: ' + e.message));
  const start = Date.parse('2026-10-20T20:00:00Z');
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: ['ch1'], hintSeen: true };
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/catalogue')) {
      return reply({ ok: true, layout, apps: [{ id: 'app0', title: 'App 0' }], devices: [],
        channels: [{ id: 'ch1', number: '1', name: 'One' }], sources: { channels: 1 },
        order: { app: ['app0'], dev: [], ch: ['ch1'] } });
    }
    if (url.pathname.endsWith('/guide')) {
      return reply({ ok: true, guide: { ch1: [{ title: 'News', start, end: start + 3600000 },
        { title: 'Film', start: start + 3600000, end: start + 7200000 }] } });
    }
    if (url.pathname.endsWith('/now')) return reply({ kind: null });
    return reply({ ok: true, build: 'one' });
  });
  try {
    await page.clock.install({ time: start + 600000 });
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.ch .bar i');
    const first = await page.evaluate(() => { window.bar = document.querySelector('.ch .bar i'); return window.bar.style.width; });
    if (first !== '16.7%') problems.push('Home guide: ten minutes into an hour showed as ' + first);
    await page.clock.fastForward(60000);
    await page.waitForFunction(w => document.querySelector('.ch .bar i').style.width !== w, first, { timeout: 5000 });
    if (!(await page.evaluate(() => document.querySelector('.ch .bar i') === window.bar)))
      problems.push('Home guide: the minute\'s refresh rebuilt the rows to move a programme\'s progress on');
  } finally { await page.close(); }
}

async function visitHomeColours(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home colours: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, colours: null };
  let version = 1;
  await page.route('**/api/home/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === '/api/home/catalogue'
      ? { ok: true, layout, layoutVersion: String(version), apps: [], devices: [], channels: [],
          sources: { channels: 0 }, order: { app: ['lg-home'], dev: [], ch: [] } }
      : { ok: true, build: 'one', layoutVersion: String(version) };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ') + ')';
  async function check(text, accent) {
    const actual = await page.evaluate(() => ({
      text: getComputedStyle(document.getElementById('clock')).color,
      focus: getComputedStyle(document.querySelector('.tile.focus')).outlineColor
    }));
    if (actual.text !== rgb(text)) problems.push('Home colours: text ' + text + ' rendered as ' + actual.text);
    if (actual.focus !== rgb(accent)) problems.push('Home colours: accent ' + accent + ' rendered as ' + actual.focus);
  }
  try {
    await page.clock.install();
    // Chosen colours can coincide with any original colour in the stylesheet.
    for (const accent of ['#ece7df', '#a39d93', '#6b665e', '#e9ad55', '#231d12', '#30de61']) {
      layout.colours = { text: '#d4e6f4', accent };
      await page.goto(base + '/assets/home.html');
      await page.waitForSelector('.tile.focus');
      await check('#d4e6f4', accent);
    }
    // Changes made elsewhere, including reset, arrive through the heartbeat.
    for (const colours of [{ text: '#f4dcdc', accent: '#30de61' }, null]) {
      layout.colours = colours;
      version++;
      await page.clock.fastForward(5000);
      const text = colours ? colours.text : '#ece7df';
      await page.waitForFunction(expected => getComputedStyle(document.getElementById('clock')).color === expected, rgb(text));
      await check(text, colours ? colours.accent : text);
    }
  } finally { await page.close(); }
}

async function visitHomeArrangement(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home arranging: ' + e.message));
  const layout = {
    rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true
  };
  const defaultOrder = ['netflix', 'youtube', 'lg-home'];
  const saves = [];
  let catalogueReads = 0, staleReply = null, build = 'first';
  await page.route('**/api/home/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = { ok: true, build };
    if (pathname === '/api/home/catalogue') {
      body = {
        ok: true, apps: [{ id: 'netflix', title: 'Netflix' }, { id: 'youtube', title: 'YouTube' }],
        devices: [], channels: [], sources: { channels: 0 }, layout,
        order: { app: layout.order.app.length ? layout.order.app : defaultOrder, dev: [], ch: [] }
      };
      // Keep the response as sent, even if a later save changes the fixture.
      const reply = { contentType: 'application/json', body: JSON.stringify(body) };
      if (++catalogueReads === 2) { staleReply = () => route.fulfill(reply); return; }
      return route.fulfill(reply);
    }
    if (pathname === '/api/home/layout') {
      const patch = route.request().postDataJSON();
      saves.push(patch);
      if (patch.reset) {
        layout.rows = ['app', 'dev', 'ch'];
        layout.order = { app: [], dev: [], ch: [] };
        layout.hidden = { app: [], dev: [], ch: [] };
      } else {
        if (patch.order) Object.assign(layout.order, patch.order);
        if (patch.rows) layout.rows = patch.rows;
        if (patch.hidden) layout.hidden = patch.hidden;
      }
      body = { ok: true, layout };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  async function arrange() {
    await page.keyboard.down('Enter');
    await page.clock.fastForward(900);
    await page.keyboard.up('Enter');
  }
  async function back() {
    await page.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: 461, bubbles: true }));
    });
  }
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    const pending = page.waitForRequest(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await page.clock.fastForward(5 * 60000);
    await pending;
    await arrange();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    const received = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await staleReply();
    await received;
    await page.waitForTimeout(50);
    await page.keyboard.press('Enter');
    let saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await back();
    await saved;
    if (JSON.stringify(saves[0].order.app) !== JSON.stringify(['youtube', 'netflix', 'lg-home'])) {
      problems.push('Home arranging: a late catalogue reply lost the moved tile order');
    }
    await page.waitForTimeout(50);
    await arrange();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    const resetCatalogue = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
    await saved;
    await resetCatalogue;
    await page.waitForTimeout(50);
    // An update noticed while arranging must still reload after arranging ends.
    build = 'second';
    const beat = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/beat');
    await page.clock.fastForward(5000);
    await beat;
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await back();
    await saved;
    if (Object.keys(saves[saves.length - 1].order).length) {
      problems.push('Home arranging: finishing after Reset pinned the Apps order again');
    }
    await page.clock.fastForward(5000);
    await page.waitForTimeout(100);
    if (!navigations) problems.push('Home arranging: an update seen while arranging was never reloaded');
  } finally { await page.close(); }
}



// Each row's Order, on Glasshouse Home's own view, the Home tab and the TV app's Home section.
async function visitHomeOrder(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home order: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true };
  const saves = [];
  let pauseSave = false, pauseCatalogue = false, saveHeld, catalogueHeld;
  const saveReady = new Promise(resolve => { saveHeld = resolve; });
  const catalogueReady = new Promise(resolve => { catalogueHeld = resolve; });
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
    const reply = { contentType: 'application/json', body: JSON.stringify(body) };
    if (pathname === '/api/home/layout' && pauseSave) {
      pauseSave = false;
      await new Promise(resolve => saveHeld(resolve));
    }
    if (pathname === '/api/home/catalogue' && pauseCatalogue) {
      pauseCatalogue = false;
      await new Promise(resolve => catalogueHeld(resolve));
    }
    await route.fulfill(reply);
  });
  const appTiles = () => page.evaluate(() => [...document.querySelectorAll('.row[data-key="app"] .tile .nm')].map(n => n.textContent).join(','));
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    await page.keyboard.down('Enter');
    await page.waitForTimeout(900);
    await page.keyboard.up('Enter');
    await page.keyboard.press('ArrowLeft');
    pauseSave = pauseCatalogue = true;
    let saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await page.keyboard.press('Enter');
    const releaseSave = await saveReady;
    const tryMoving = async () => {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
    };
    await tryMoving();
    if (await appTiles() !== 'One,Two,LG Home') problems.push('Home order: an edit can be lost while Order is saving');
    releaseSave();
    const releaseCatalogue = await catalogueReady;
    await tryMoving();
    if (await appTiles() !== 'One,Two,LG Home') problems.push('Home order: an edit can be lost while the saved order is loading');
    releaseCatalogue();
    await saved;
    await page.waitForTimeout(200);
    if (!saves.length || !saves[0].sort || saves[0].sort.app !== 'recent') problems.push('Home order: the Apps row\'s Order did not save Last opened');
    if (await appTiles() !== 'Two,One,LG Home') problems.push('Home order: arranging did not show the row in last opened order');
    // Picking a tile up keeps the order shown, now the row's own.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await page.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: 461, bubbles: true }));
    });
    await saved;
    const last = saves[saves.length - 1];
    if (last.sort.app !== 'custom' || JSON.stringify(last.order.app) !== JSON.stringify(['one', 'two', 'lg-home'])) {
      problems.push('Home order: moving a tile in a Last opened row did not keep the order shown as the row\'s own');
    }

    await page.waitForTimeout(200);
    await page.keyboard.down('Enter');
    await page.waitForTimeout(900);
    await page.keyboard.up('Enter');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await page.locator('.row[data-key="app"] .sort').click();
    await saved;
    if (JSON.stringify(saves[saves.length - 1].order.app) !== JSON.stringify(['two', 'one', 'lg-home'])) {
      problems.push('Home order: switching Order discarded the row\'s unsaved moves');
    }
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowRight');
    if (await page.locator('.tile.focus .nm').allTextContents() + '' !== 'Two') {
      problems.push('Home order: clicking Order while holding a tile did not release it');
    }

    layout.sort.app = 'recent';
    await page.goto(base + '/?tab=home');
    await page.waitForSelector('#home-sort-app:not(:disabled)');
    if (!await page.locator('details.home-row[data-kind="app"] .home-tile button[aria-label="Later"]').first().isDisabled()) {
      problems.push('Home order: tiles in a Last opened row can be moved on the Home tab');
    }
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
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
    hidden: { app: [], dev: [], ch: [] }, channels: ['a'], hintSeen: true };
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
    await page.locator('details.home-row[data-kind="ch"] summary').click();
    await page.getByRole('button', { name: 'Show the TV’s channels', exact: true }).click();
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
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true };
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
      body = { ok: true, supported: { ok: true }, installed: true, enabled: false, writable: true, layout, wallpapers: wallpapers() };
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

// Where Glasshouse Home is not offered its tab is left out; where it is on, the Apps tab says what LG's settings reach.
async function visitHomeAvailability(browser, base, problems) {
  for (const st of [{ available: false, enabled: false }, { available: true, enabled: true }]) {
    const page = await browser.newPage();
    page.on('pageerror', e => problems.push('Home availability: ' + e.message));
    await page.route('**/api/home**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(Object.assign({
      ok: true, supported: { ok: st.available }, installed: true, restorePending: false, writable: true,
      layout: { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true },
      apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 }, wallpapers: { slots: {} }
    }, st)) }));
    try {
      await page.goto(base + '/?tab=home');
      await page.waitForFunction(() => homeAvailable !== null);
      await page.waitForTimeout(100);
      const hidden = await page.locator('#tab-btn-home').isHidden();
      if (hidden === st.available) problems.push('Home availability: tab ' + (hidden ? 'hidden' : 'shown') + ' with available ' + st.available);
      if (!st.available && await page.evaluate(() => activeTab) !== 'control') problems.push('Home availability: an unavailable Home tab stayed open');
      const notes = await page.locator('[data-glasshouse-home-note]:not([hidden])').count();
      if (notes !== (st.enabled ? 2 : 0)) problems.push('Home availability: ' + notes + ' Apps tab notes with Glasshouse Home ' + (st.enabled ? 'on' : 'off'));
    } finally { await page.close(); }
  }
}

async function visitHomeReadiness(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home readiness: ' + e.message));
  let failed = true, release = null, beats = 0, escapes = 0;
  await page.route('**/api/home/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/beat')) beats++;
    if (pathname.endsWith('/open')) escapes++;
    if (pathname.endsWith('/catalogue')) {
      if (failed) return route.fulfill({ status: 503, body: '{}' });
      await new Promise(resolve => { release = resolve; });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, apps: [], devices: [], channels: [],
        order: { app: ['lg-home'], dev: [], ch: [] }, sources: { channels: 0 },
        layout: { rows: ['app', 'dev', 'ch'], hidden: { app: [], dev: [], ch: [] }, order: { app: [], dev: [], ch: [] },
          channels: [], hintSeen: true } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, build: 'one', kind: null }) });
  });
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    if (!escapes) problems.push('Home readiness: failed first catalogue did not ask for LG Home');
    if (beats) problems.push('Home readiness: unusable view sent a healthy heartbeat');
    failed = false;
    await page.reload();
    await page.waitForTimeout(100);
    await page.clock.fastForward(6500);
    if (beats) problems.push('Home readiness: heartbeat preceded initial rendering');
    release();
    await page.waitForSelector('.tile');
    await page.waitForTimeout(100);
    if (beats !== 1) problems.push('Home readiness: delayed first render did not immediately send a heartbeat');
  } finally { await page.close(); }
}

async function visitHomeRecents(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home recents: ' + e.message));
  let apps = [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }];
  let posts = 0, fail = false, hold = false, release = null;
  const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/home/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/home/catalogue') return reply(route, {
      ok: true, apps: [], devices: [], channels: [], sources: {}, order: { app: ['lg-home'], dev: [], ch: [] },
      layout: { rows: ['app', 'dev', 'ch'], hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true }
    });
    if (pathname === '/api/home/recents') {
      if (route.request().method() === 'POST') {
        posts++;
        if (fail) return reply(route, { ok: false }, 400);
        const body = route.request().postDataJSON();
        apps = apps.filter(a => a.id !== body.id);
      } else if (hold) await new Promise(resolve => { release = resolve; });
      return reply(route, { ok: true, apps });
    }
    return reply(route, { ok: true, kind: null, build: 'one' });
  });
  async function back() {
    await page.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: 461 }));
    });
  }
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('#rows .tile');
    await back();
    await page.waitForSelector('#stage.recents');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.waitForTimeout(150);
    if (posts) problems.push('Home recents: held OK acted before release');
    await page.keyboard.up('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#recentsTrack .rc').length === 1);
    if (posts !== 1) problems.push('Home recents: held OK closed more than one card');
    fail = true;
    await page.keyboard.press('Enter');
    await page.waitForSelector('#toast.show');
    const visibleError = await page.evaluate(() => {
      const toast = document.getElementById('toast'), r = toast.getBoundingClientRect();
      return toast.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    if (!visibleError) problems.push('Home recents: the panel covered its close error');
    await back();
    for (const cancel of ['back', 'relaunch']) {
      hold = true; release = null;
      await back();
      const deadline = Date.now() + 3000;
      while (!release && Date.now() < deadline) await page.waitForTimeout(20);
      if (!release) throw new Error('Home recents: no panel request to delay');
      if (cancel === 'back') await back();
      else await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
      const answered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/recents');
      hold = false; release();
      await answered;
      await page.waitForTimeout(100);
      if (await page.locator('#stage').evaluate(el => el.classList.contains('recents'))) {
        problems.push('Home recents: a late reply reopened the panel after ' + cancel);
      }
    }
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
  await visitHomeArrangement(browser, base, problems);
  await visitHomePicture(browser, base, problems);
  await visitHomeColours(browser, base, problems);
  await visitHomeEditor(browser, base, problems);
  await visitHomeOrder(browser, base, problems);
  await visitHomeUploads(browser, base, problems);
  await visitHomeReadiness(browser, base, problems);
  await visitHomeAvailability(browser, base, problems);
  await visitHomeRecents(browser, base, problems);
  await visitHomeScrolling(browser, base, problems);
  await visitHomeMotion(browser, base, problems);
  await visitHomeGuide(browser, base, problems);
  await browser.close();
  for (const p of problems) console.log(p);
  console.log((web.length + tv.length) + ' tabs opened (' + web.length + ' web, ' + tv.length + ' TV app), ' +
              'Home arranging, picture, colours, update, editing, order, uploads, readiness, availability, recents, scrolling, motion and guide checked, ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's'));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
