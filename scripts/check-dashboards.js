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
 *
 * CPU_SLOWDOWN=4 runs every page on a CPU slowed four times, as Chrome's
 * devtools can, to find a check that waits on time rather than on the page:
 * CI's runners, shared and slower, fail those now and then.
 *
 * A check that finds a problem runs once more on its own before the run fails.
 * One that passes the second time is reported as flaky, by name, and does not
 * fail the run; one that fails twice does.
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


/*
 * Waits for what should happen, up to a few seconds, rather than a fixed time:
 * replies arrive in real time, after a faked clock has moved on, and a slow CI
 * runner can take longer than a wait that is enough on a laptop.
 */
async function waitUntil(page, ready, ms = 4000) {
  const until = Date.now() + ms;
  while (!(await ready()) && Date.now() < until) await page.waitForTimeout(20);
  return ready();
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
    env: Object.assign({}, process.env, { FAKE_ROOT: root, TVWEB_LUNA_SEND: fake, FAKE_LAUNCH_GAP_MS: '0' })
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
 * Done once each address the tab has asked for has answered once and no new
 * one has started for QUIET_MS - a tab's script runs when its data arrives,
 * which is where it breaks - or after MAX_MS, so a slow tab cannot hold the
 * run up. An address asked for again is the tab polling, which never stops:
 * counted, nearly every tab ran to MAX_MS.
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
  const asked = new Set(), first = new Set();
  page.on('request', r => {
    if (asked.has(r.url())) return;
    asked.add(r.url());
    first.add(r);
    open++;
    last = Date.now();
  });
  const done = r => {
    if (!first.delete(r)) return;
    open = Math.max(0, open - 1);
    last = Date.now();
  };
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
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      const once = (b, base, found) => visit(b, j.url, j.label, found);
      Object.defineProperty(once, 'name', { value: j.label });
      await runVisit(once, browser, null, problems);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

async function visitHomePicture(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home picture: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
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
    const firstNow = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/now');
    await page.goto(base + '/assets/home.html');
    await firstNow;
    await page.waitForTimeout(50);
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

// The weather badge: Home Assistant's last push or Open-Meteo's, brought by the heartbeat.
// The input bar over a Home screen: the input last watched is under it, not
// on screen, so OK on it switches to it rather than closing the bar.
// Stepping with the arrows switches a second after the last step, or, with
// Switch only on OK, not until OK (#1532).
async function visitInputBarSwitchOnOk(browser, base, problems) {
  for (const onOk of [false, true]) {
    const name = 'Input bar, ' + (onOk ? 'switch only on OK' : 'switch after a step') + ': ';
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => problems.push(name + e.message));
    await page.clock.install();
    await page.addInitScript(() => {
      window.launches = [];
      window.PalmServiceBridge = function () {};
      window.PalmServiceBridge.prototype.call = function (uri, body) { window.launches.push(JSON.parse(body).id); };
      window.close = function () { window.closed = true; };
    });
    await page.route('http://localhost:8080/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
      if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: 'input', port: 2, devices: ['hdmi2'], behindHome: false } });
      if (url.pathname === '/api/home/catalogue') return route.fulfill({ json: { ok: true, layout: onOk ? { inputBarSwitchOnOk: true } : {}, order: { dev: ['hdmi1', 'hdmi2'] },
        devices: [{ id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1 }, { id: 'hdmi2', name: 'Mac', input: 'hdmi2', port: 2 }] } });
      return route.fulfill({ json: {} });
    });
    try {
      await page.goto(base + '/assets/inputbar-app/index.html');
      await page.waitForSelector('.tile.focus');
      await page.clock.runFor(500);
      await page.keyboard.press('ArrowLeft');
      await page.clock.runFor(1500);
      const afterStep = await page.evaluate(() => window.launches.slice());
      if (!onOk && afterStep.indexOf('com.webos.app.hdmi1') === -1) problems.push(name + 'did not switch a second after the step');
      if (onOk && afterStep.length) problems.push(name + 'switched without OK: ' + afterStep.join(', '));
      if (onOk) {
        await page.keyboard.press('Enter');
        await page.clock.runFor(100);
        const afterOk = await page.evaluate(() => window.launches.slice());
        if (afterOk.indexOf('com.webos.app.hdmi1') === -1) problems.push(name + 'OK did not switch');
      }
    } finally {
      await page.close();
    }
  }
}

async function visitInputBarBehindHome(browser, base, problems) {
  for (const behindHome of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const name = 'Input bar ' + (behindHome ? 'over Home' : 'over HDMI 2') + ': ';
    page.on('pageerror', e => problems.push(name + e.message));
    await page.addInitScript(() => {
      window.launches = [];
      window.PalmServiceBridge = function () {};
      window.PalmServiceBridge.prototype.call = function (uri, body) { window.launches.push(JSON.parse(body).id); };
      window.close = function () { window.closed = true; };
    });
    await page.route('http://localhost:8080/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
      if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: 'input', port: 2, devices: ['hdmi2'], behindHome } });
      if (url.pathname === '/api/home/catalogue') return route.fulfill({ json: { ok: true, layout: behindHome ? {} : { inputBarTransparent: true }, order: { dev: ['TV', 'hdmi1', 'hdmi2'] },
        devices: [{ id: 'TV', name: 'Live TV', tuner: true }, { id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1 }, { id: 'hdmi2', name: 'Mac', input: 'hdmi2', port: 2 }] } });
      return route.fulfill({ json: {} });
    });
    try {
      await page.goto(base + '/assets/inputbar-app/index.html');
      await page.waitForSelector('.tile.focus');
      if (await page.locator('.tile').count() !== 3 || await page.locator('.tile').first().locator('.nm').textContent() !== 'Live TV') problems.push(name + 'Live TV was not shown');
      if (await page.locator('.tile').first().locator('.path').count() !== 0) problems.push(name + 'Live TV showed an HDMI path');
      const visual = await page.evaluate(() => {
        const unfocused = document.querySelector('.tile:not(.focus)');
        return { transparent: document.body.classList.contains('transparent'), opacity: unfocused ? getComputedStyle(unfocused).opacity : '' };
      });
      if (behindHome && (visual.transparent || visual.opacity !== '1')) problems.push(name + 'default tiles were not opaque (' + JSON.stringify(visual) + ')');
      if (!behindHome && (!visual.transparent || visual.opacity !== '0.75')) problems.push(name + 'transparent tiles were not enabled (' + JSON.stringify(visual) + ')');
      const focused = await page.textContent('.tile.focus .nm');
      if (focused !== 'Mac') problems.push(name + 'the bar opened on ' + focused + ', not the input last watched');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const launches = await page.evaluate(() => window.launches);
      if (behindHome && launches.indexOf('com.webos.app.hdmi2') === -1) problems.push(name + 'OK on HDMI 2 did not switch to it');
      if (!behindHome && launches.length) problems.push(name + 'OK on the input on screen launched ' + launches.join(', '));
      if (!behindHome) {
        await page.goto(base + '/assets/inputbar-app/index.html');
        await page.waitForSelector('.tile.focus');
        const mid = await page.evaluate(() => {
          const tiles = Array.from(document.querySelectorAll('#tiles .tile'));
          const hits = tiles.map(t => {
            const r = t.getBoundingClientRect();
            const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return !!(el && t.contains(el));
          });
          const mr = tiles[1].getBoundingClientRect();
          return { allHit: hits.every(Boolean), x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) };
        });
        if (!mid.allHit) problems.push(name + 'pointer hit blocked on input tiles');
        await page.mouse.move(mid.x, mid.y);
        await page.waitForFunction(() => document.querySelectorAll('#tiles .tile')[1].classList.contains('focus'));
        await page.mouse.click(mid.x, mid.y);
        await page.waitForTimeout(300);
        const clickLaunches = await page.evaluate(() => window.launches);
        if (clickLaunches.indexOf('com.webos.app.hdmi1') === -1) problems.push(name + 'clicking hovered HDMI 1 did not launch it');

        await page.evaluate(() => { window.launches = []; });
        await page.goto(base + '/assets/inputbar-app/index.html');
        await page.waitForSelector('.tile.focus');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const tvLaunches = await page.evaluate(() => window.launches);
        if (tvLaunches.indexOf('com.webos.app.livetv') === -1) problems.push(name + 'OK on Live TV did not launch livetv');
      }
    } finally {
      await page.close();
    }
  }
  // Six or more inputs stack into two rows and step vertically with Up and Down.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Input bar (two rows): ' + e.message));
  await page.addInitScript(() => {
    window.launches = [];
    window.PalmServiceBridge = function () {};
    window.PalmServiceBridge.prototype.call = function (uri, body) {
      window.launches.push({ uri, body: JSON.parse(body) });
      if (this.onservicecallback) this.onservicecallback(JSON.stringify({ returnValue: true }));
    };
    window.close = function () { window.closed = true; };
  });
  await page.route('http://localhost:8080/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
    if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: 'input', port: 1, devices: ['hdmi1'], behindHome: false } });
    if (url.pathname === '/api/home/catalogue') {
      return route.fulfill({
        json: {
          ok: true,
          layout: {},
          order: { dev: ['TV', 'hdmi1', 'hdmi2', 'dms:sonos', 'airplay', 'allinputs'] },
          devices: [
            { id: 'TV', name: 'Live TV', tuner: true },
            { id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1 },
            { id: 'hdmi2', name: 'Mac', input: 'hdmi2', port: 2 },
            { id: 'dms:sonos', name: 'Sonos', kind: 'dms', appId: 'com.webos.app.mediadiscovery', deviceId: 'SONOS_1', port: 0 },
            { id: 'airplay', name: 'AirPlay', kind: 'airplay', appId: 'airplay', port: 0 },
            { id: 'allinputs', name: 'All Inputs', kind: 'allinputs', appId: 'com.webos.app.homeconnect', port: 0 }
          ]
        }
      });
    }
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(base + '/assets/inputbar-app/index.html');
    await page.waitForSelector('.tile.focus');
    const rowState = await page.evaluate(() => ({
      tworow: document.body.classList.contains('tworow'),
      breaks: document.querySelectorAll('#tiles br').length,
      dmsSub: document.querySelectorAll('.tile')[3].querySelector('.path').textContent
    }));
    if (!rowState.tworow || rowState.breaks !== 1) problems.push('Input bar: 6 inputs did not switch to two-row layout (' + JSON.stringify(rowState) + ')');
    if (rowState.dmsSub !== 'Media server') problems.push('Input bar: media server subtitle was ' + rowState.dmsSub);
    // Focus starts on HDMI 1 (index 1); Down jumps to AirPlay (index 4), Right moves to All Inputs (index 5).
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.textContent('.tile.focus .nm');
    if (afterDown !== 'AirPlay') problems.push('Input bar: ArrowDown moved to ' + afterDown + ' instead of AirPlay');
    await page.keyboard.press('ArrowUp');
    const afterUp = await page.textContent('.tile.focus .nm');
    if (afterUp !== 'HDMI 1') problems.push('Input bar: ArrowUp moved to ' + afterUp + ' instead of HDMI 1');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const launches = await page.evaluate(() => window.launches);
    if (!launches.some(l => l.uri === 'luna://airplay.service/showAirplayPage')) problems.push('Input bar: OK on AirPlay did not call showAirplayPage');
  } finally {
    await page.close();
  }
}

async function visitHomeBarPrewarm(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Glasshouse Bar: ' + e.message));
  let port = 1, iconHits = 0, catHits = 0;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.addInitScript(() => {
    window.PalmSystem = { launchParams: '{"preload":"full"}' };
    window.PalmServiceBridge = function () {};
    window.PalmServiceBridge.prototype.call = function (uri, body) {
      if (this.onservicecallback) this.onservicecallback(JSON.stringify({ returnValue: true }));
    };
    window.close = function () { window.closed = true; };
  });
  await page.route('http://localhost:8080/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
    if (url.pathname === '/api/home/icon') {
      iconHits++;
      return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    }
    if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: 'input', port, behindHome: false } });
    if (url.pathname === '/api/home/catalogue') {
      catHits++;
      return route.fulfill({
        json: {
          ok: true,
          layout: {},
          order: { app: ['app1'], dev: ['hdmi1', 'hdmi2'] },
          apps: [{ id: 'app1', title: 'Test App', icon: '/api/home/icon?id=app1' }],
          devices: [
            { id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1 },
            { id: 'hdmi2', name: 'HDMI 2', input: 'hdmi2', port: 2 }
          ]
        }
      });
    }
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(base + '/assets/homebar-app/index.html');
    await page.waitForSelector('#row .ico');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length === 3);
    const pre = await page.evaluate(() => {
      window.__icoNode = document.querySelector('#row .ico');
      return { on: document.body.classList.contains('on'), tiles: document.querySelectorAll('#row .tile').length };
    });
    if (pre.on) problems.push('Glasshouse Bar: showed window during preload');
    if (pre.tiles !== 3 || iconHits < 1 || catHits < 1) problems.push('Glasshouse Bar: did not prewarm row and icons while hidden');
    port = 2;
    const beforeCat = catHits;
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('webOSRelaunch')));
    await page.waitForSelector('body.on');
    await page.waitForFunction(n => window.performance.getEntriesByType('resource').filter(r => r.name.indexOf('/api/home/catalogue') !== -1).length > n, beforeCat);
    const post = await page.evaluate(() => ({
      sameNode: document.querySelector('#row .ico') === window.__icoNode,
      nowNames: Array.from(document.querySelectorAll('#row .tile.now .nm')).map(el => el.textContent),
      closed: !!window.closed
    }));
    if (!post.sameNode) problems.push('Glasshouse Bar: redrew icon DOM node when opened with changed active input');
    if (post.nowNames.length !== 1 || post.nowNames[0] !== 'HDMI 2') problems.push('Glasshouse Bar: active input dot was ' + JSON.stringify(post.nowNames));
    if (post.closed) problems.push('Glasshouse Bar: closed on first open');

    // A preload relaunch while open is ignored; distinct keyfilter press ids
    // toggle immediately (even within 200 ms) while duplicates of the same press do not.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: { preload: 'full' } })));
    const afterPreload = await page.evaluate(() => ({ cls: document.body.className, closed: !!window.__closed }));
    if (afterPreload.cls !== 'on' || afterPreload.closed) problems.push('Glasshouse Bar: preload relaunch toggled bar: ' + JSON.stringify(afterPreload));

    await page.evaluate(() => document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: { glasshouse: 'bar', press: 10 } })));
    const afterClose = await page.evaluate(() => document.body.className);
    if (afterClose !== '') problems.push('Glasshouse Bar: rapid press 10 did not start close: ' + JSON.stringify(afterClose));

    await page.evaluate(() => document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: { glasshouse: 'bar', press: 10 } })));
    const afterDup = await page.evaluate(() => document.body.className);
    if (afterDup !== '') problems.push('Glasshouse Bar: duplicate press 10 cancelled close: ' + JSON.stringify(afterDup));

    await page.evaluate(() => document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: { glasshouse: 'bar', press: 11 } })));
    await page.waitForTimeout(200);
    const afterReopen = await page.evaluate(() => ({ cls: document.body.className, closed: !!window.__closed }));
    if (afterReopen.cls !== 'on' || afterReopen.closed) problems.push('Glasshouse Bar: rapid press 11 did not cancel fade-out: ' + JSON.stringify(afterReopen));
  } finally {
    await page.close();
  }
}

// AirPlay is an app and an input under one id: hidden as an app, it stays out
// of the Bar, and where only the input has it, it is drawn as an input with its
// icon (#1500, #1502). Screen Share opens with its launch parameters.
// A row longer than the screen moves a tile a notch of the wheel, and steps
// along while the pointer rests at its far end, as Glasshouse Home's does
// (#1500, #1531).
async function visitHomeBarScroll(browser, base, problems) {
  const fail = what => problems.push('Glasshouse Bar scrolling: ' + what);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => fail(e.message));
  await page.addInitScript(() => {
    window.PalmSystem = { launchParams: '{}' };
    window.PalmServiceBridge = function () {};
    window.PalmServiceBridge.prototype.call = function () {
      if (this.onservicecallback) this.onservicecallback(JSON.stringify({ returnValue: true }));
    };
    window.close = function () {};
  });
  const apps = Array.from({ length: 16 }, (_, i) => ({ id: 'app' + i, title: 'App ' + i }));
  let layout = {};
  await page.route('http://localhost:8080/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
    if (url.pathname === '/api/home/now') return route.fulfill({ json: {} });
    if (url.pathname === '/api/home/catalogue') return route.fulfill({ json: { ok: true, layout, order: { app: apps.map(a => a.id), dev: [] }, apps, devices: [] } });
    return route.fulfill({ json: {} });
  });
  const shift = () => page.evaluate(() => {
    const m = /translateX\((-?[\d.]+)px\)/.exec(document.getElementById('row').style.transform || '');
    return m ? -parseFloat(m[1]) : 0;
  });
  try {
    await page.goto(base + '/assets/homebar-app/index.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length === 16 && document.body.className.indexOf('on') !== -1);
    await page.mouse.move(960, 900);
    const moved = what => page.waitForFunction(w => (document.getElementById('row').style.transform || '') !== w,
      what, { timeout: 2000 }).then(() => true, () => false);
    let before = await page.evaluate(() => document.getElementById('row').style.transform || '');
    await page.mouse.wheel(0, 120);
    await moved(before);
    const afterWheel = await shift();
    if (!(afterWheel > 0)) fail('a notch of the wheel did not move the row (shift ' + afterWheel + ')');
    before = await page.evaluate(() => document.getElementById('row').style.transform || '');
    await page.mouse.wheel(0, -120);
    await moved(before);
    if (await shift() !== 0) fail('a notch back did not return the row (shift ' + await shift() + ')');
    const bar = await page.evaluate(() => { const r = document.getElementById('bar').getBoundingClientRect(); return { y: r.top + r.height / 2 }; });
    await page.mouse.move(1900, bar.y);
    await page.waitForTimeout(700);
    const atEdge = await shift();
    if (!(atEdge > afterWheel)) fail('resting at the far end did not step the row along (shift ' + atEdge + ')');
    await page.mouse.move(960, bar.y);
    const stopped = await shift();
    await page.waitForTimeout(500);
    if (await shift() !== stopped) fail('the row kept moving after the pointer left the end');
    // Smooth scrolling switched off on the Home tab: the row jumps rather than glides.
    if (await page.evaluate(() => document.getElementById('row').style.transition) === 'none') fail('the row does not glide with Smooth scrolling on');
    layout = { smoothScroll: false };
    await page.goto(base + '/assets/homebar-app/index.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length === 16 && document.body.className.indexOf('on') !== -1);
    if (await page.evaluate(() => document.getElementById('row').style.transition) !== 'none') fail('the row still glides with Smooth scrolling off');
  } finally {
    await page.close();
  }
}

// The Bar's icons are images decoded in the frame that draws them, and it
// keeps them beside its cached row, so opened with nothing loaded (the icon
// server not answering) it still draws every one at once.
async function visitHomeBarIconsReady(browser, base, problems) {
  const fail = what => problems.push('Glasshouse Bar icons: ' + what);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let iconsUp = true;
  await context.addInitScript(() => {
    window.PalmSystem = { launchParams: '{}' };
    window.PalmServiceBridge = function () {};
    window.PalmServiceBridge.prototype.call = function () {
      if (this.onservicecallback) this.onservicecallback(JSON.stringify({ returnValue: true }));
    };
    window.close = function () {};
  });
  await context.route('http://localhost:8080/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
    if (url.pathname === '/api/home/icon') {
      return iconsUp ? route.fulfill({ status: 200, contentType: 'image/png', body: png, headers: { 'Access-Control-Allow-Origin': '*' } })
        : route.fulfill({ status: 503, body: '' });
    }
    if (url.pathname === '/api/home/now') return route.fulfill({ json: {} });
    if (url.pathname === '/api/home/catalogue') return route.fulfill({ json: { ok: true, layout: {}, order: { app: ['a1', 'a2'], dev: [] },
      apps: [{ id: 'a1', title: 'One', icon: '/api/home/icon?id=a1' }, { id: 'a2', title: 'Two', icon: '/api/home/icon?id=a2' }], devices: [] } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  page.on('pageerror', e => fail(e.message));
  try {
    await page.goto(base + '/assets/homebar-app/index.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .ico').length === 2);
    const kind = await page.evaluate(() => { const i = document.querySelector('#row .ico'); return i ? i.tagName + ' ' + i.getAttribute('decoding') : 'none'; });
    if (kind !== 'IMG sync') fail('the icons are ' + kind + ', not images decoded in the frame that draws them');
    const kept = await page.waitForFunction(() => {
      try { return Object.keys(JSON.parse(localStorage.getItem('glasshouse.homebar.icons') || '{}')).length === 2; } catch (e) { return false; }
    }, null, { timeout: 5000 }).then(() => true, () => false);
    if (!kept) fail('the icons were not kept beside the row');
    // Opened again with the icon server down: every icon from what was kept.
    iconsUp = false;
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#row img.ico').length === 2);
    const drawn = await page.waitForFunction(() => Array.from(document.querySelectorAll('#row img.ico')).every(i => i.complete && i.naturalWidth > 0),
      null, { timeout: 3000 }).then(() => true, () => false);
    if (!drawn) fail('opened with the icon server down, the kept icons were not drawn');
    const fromKept = await page.evaluate(() => Array.from(document.querySelectorAll('#row img.ico')).every(i => i.src.indexOf('data:image/') === 0));
    if (!fromKept) fail('the icons did not come from what was kept');
  } finally {
    await context.close();
  }
}

async function visitHomeBarTiles(browser, base, problems) {
  const fail = what => problems.push('Glasshouse Bar tiles: ' + what);
  const devices = [
    { id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1 },
    { id: 'airplay', name: 'AirPlay', input: 'airplay', kind: 'airplay', appId: 'airplay' },
    { id: 'screenshare', name: 'Screen Share', input: 'screenshare', kind: 'screenshare', appId: 'com.webos.app.homeconnect', params: { actionType: 'mobileGuide' } }
  ];
  const load = async (catalogue) => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fail(e.message));
    await page.addInitScript(() => {
      window.PalmSystem = { launchParams: '{}' };
      window.__calls = [];
      window.PalmServiceBridge = function () {};
      window.PalmServiceBridge.prototype.call = function (uri, body) {
        window.__calls.push({ uri, body: JSON.parse(body) });
        if (this.onservicecallback) this.onservicecallback(JSON.stringify({ returnValue: true }));
      };
      window.close = function () {};
    });
    await page.route('http://localhost:8080/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
      if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: 'input', port: 1 } });
      if (url.pathname === '/api/home/catalogue') return route.fulfill({ json: catalogue });
      return route.fulfill({ json: {} });
    });
    await page.goto(base + '/assets/homebar-app/index.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length > 0 && document.querySelector('#row .tile.input svg'));
    return page;
  };
  const tiles = page => page.evaluate(() => Array.from(document.querySelectorAll('#row .tile')).map(el => ({
    name: el.querySelector('.nm').textContent, input: el.classList.contains('input'), svg: !!el.querySelector('svg') })));

  let page = await load({ ok: true, layout: { hidden: { app: ['airplay'] } },
    order: { app: ['app1', 'airplay'], dev: devices.map(d => d.id) },
    apps: [{ id: 'app1', title: 'Test App' }, { id: 'airplay', title: 'AirPlay', icon: '/api/home/icon?id=airplay' }], devices });
  try {
    const t = await tiles(page);
    if (t.some(x => x.name === 'AirPlay')) fail('AirPlay hidden as an app still shows: ' + JSON.stringify(t));
    const i = t.findIndex(x => x.name === 'Screen Share');
    if (i === -1) return fail('no Screen Share tile: ' + JSON.stringify(t));
    await page.evaluate(n => {
      const el = document.querySelectorAll('#row .tile')[n];
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.click();
    }, i);
    await page.waitForFunction(() => window.__calls.some(c => /launch$/.test(c.uri)));
    const launch = await page.evaluate(() => window.__calls.filter(c => /launch$/.test(c.uri)).pop().body);
    if (launch.id !== 'com.webos.app.homeconnect' || !launch.params || launch.params.actionType !== 'mobileGuide') fail('Screen Share launched ' + JSON.stringify(launch));
  } finally {
    await page.close();
  }

  page = await load({ ok: true, layout: {}, order: { app: ['app1'], dev: devices.map(d => d.id) },
    apps: [{ id: 'app1', title: 'Test App' }], devices });
  try {
    const air = (await tiles(page)).filter(x => x.name === 'AirPlay');
    if (air.length !== 1 || !air[0].input || !air[0].svg) fail('AirPlay as an input only: ' + JSON.stringify(air));
    const clk = await page.evaluate(() => {
      var cs = getComputedStyle(document.getElementById('clock'));
      return { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize };
    });
    if (clk.fontFamily.indexOf('Manrope') === -1 || clk.fontWeight !== '400' || clk.fontSize !== '40px') {
      fail('unexpected clock style: ' + JSON.stringify(clk));
    }
  } finally {
    await page.close();
  }
}

async function visitHomeBarHaTile(browser, base, problems) {
  const fail = what => problems.push('Glasshouse Bar HA tile: ' + what);
  const setup = async (haBar) => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fail(e.message));
    await page.addInitScript(() => {
      window.PalmSystem = { launchParams: '{}' };
      window.__calls = [];
      window.PalmServiceBridge = function () {};
      window.PalmServiceBridge.prototype.call = function (uri, body) {
        window.__calls.push({ uri, body: JSON.parse(body) });
        if (this.onservicecallback) this.onservicecallback(JSON.stringify({ returnValue: true }));
      };
      window.close = function () {};
    });
    await page.route('http://localhost:8080/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
      if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: 'input', port: 1 } });
      if (url.pathname === '/api/home/catalogue') {
        return route.fulfill({ json: { ok: true, haBar, layout: { hidden: { app: [] } },
          order: { app: ['app1'], dev: ['hdmi1'] }, apps: [{ id: 'app1', title: 'Test App' }],
          devices: [{ id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1 }] } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(base + '/assets/homebar-app/index.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length > 0);
    return page;
  };

  let page = await setup(false);
  try {
    if (await page.locator('#row .tile.habar').count()) fail('HA tile shown while disabled');
  } finally { await page.close(); }

  page = await setup(true);
  try {
    const count = await page.locator('#row .tile.habar').count();
    if (count !== 1) return fail('expected 1 HA tile, got ' + count);
    const afterGap = await page.evaluate(() => {
      const ha = document.querySelector('#row .tile.habar');
      return !!(ha && ha.previousElementSibling && ha.previousElementSibling.classList.contains('gap'));
    });
    if (!afterGap) fail('expected separator gap before HA tile');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__calls.some(c => /launch$/.test(c.uri)));
    const launch = await page.evaluate(() => window.__calls.filter(c => /launch$/.test(c.uri)).pop().body);
    if (launch.id !== 'com.tvweb.habar' || !launch.params || launch.params.glasshouse !== 'habar') {
      fail('unexpected launch payload: ' + JSON.stringify(launch));
    }
  } finally { await page.close(); }
}

/*
 * Glasshouse Bar on a remote key beside Glasshouse Home (#1499): no LG's Home
 * tile, which would open Glasshouse Home there, and a press over Glasshouse
 * Home closes the page unseen; over anything else it opens.
 */
async function visitHomeBarBesideHome(browser, base, problems) {
  const fail = what => problems.push('Glasshouse Bar beside Home: ' + what);
  const catalogue = { ok: true, enabled: true, supported: { ok: true }, layout: {},
    order: { app: ['lg-home', 'app1'], dev: [] }, apps: [{ id: 'app1', title: 'Test App' }], devices: [] };
  const load = async (front, kept) => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fail(e.message));
    await page.addInitScript(([front, kept]) => {
      window.PalmSystem = { launchParams: '{}' };
      window.__closed = false;
      if (kept !== null) window.localStorage.setItem('glasshouse.homebar.home', kept);
      window.PalmServiceBridge = function () {};
      window.PalmServiceBridge.prototype.call = function () {
        const me = this;
        setTimeout(() => { if (me.onservicecallback) me.onservicecallback(JSON.stringify({ returnValue: true })); }, 5);
      };
      window.close = function () { window.__closed = true; };
    }, [front, kept]);
    await page.route('http://localhost:8080/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/devicons.js') return route.continue({ url: base + '/assets/devicons.js' });
      if (url.pathname === '/api/home/now') return route.fulfill({ json: { kind: null, homeInFront: front === 'home' } });
      if (url.pathname === '/api/home/catalogue') return route.fulfill({ json: catalogue });
      return route.fulfill({ json: {} });
    });
    await page.goto(base + '/assets/homebar-app/index.html');
    return page;
  };

  let page = await load('youtube', null);
  try {
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length > 0);
    const names = await page.evaluate(() => Array.from(document.querySelectorAll('#row .tile .nm')).map(el => el.textContent));
    if (names.indexOf('LG Home') !== -1 || names.indexOf('Test App') === -1) fail('the tiles beside Glasshouse Home: ' + JSON.stringify(names));
    const kept = await page.evaluate(() => window.localStorage.getItem('glasshouse.homebar.home'));
    if (kept !== '1') fail('Glasshouse Home\'s app not kept for the next press: ' + JSON.stringify(kept));
  } finally {
    await page.close();
  }

  page = await load('home', '1');
  try {
    await page.waitForFunction(() => window.__closed, null, { timeout: 3000 }).catch(() => {});
    const seen = await page.evaluate(() => ({ closed: window.__closed, on: document.body.className === 'on' }));
    if (!seen.closed || seen.on) fail('a press over Glasshouse Home: ' + JSON.stringify(seen));
  } finally {
    await page.close();
  }

  page = await load('netflix', '1');
  try {
    await page.waitForFunction(() => document.body.className === 'on', null, { timeout: 3000 }).catch(() => {});
    const seen = await page.evaluate(() => ({ closed: window.__closed, on: document.body.className === 'on' }));
    if (seen.closed || !seen.on) fail('a press over another app: ' + JSON.stringify(seen));
  } finally {
    await page.close();
  }
}

async function visitHaBar(browser, base, problems) {
  const fail = what => problems.push('Home Assistant bar: ' + what);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => fail(e.message));
  await page.addInitScript(() => {
    window.__closed = false;
    window.close = function () { window.__closed = true; };
  });
  let pct = 50;
  let showHints = true;
  const acts = [];
  await page.route('**/api/ha/bar/**', route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (pathname.endsWith('/state')) {
      return route.fulfill({
        json: {
          ok: true,
          configured: true,
          hour12: false,
          showHints: showHints,
          tiles: [
            { id: 'light.desk', domain: 'light', label: 'Desk Lamp', state: 'on', active: true, adjustable: true, pct: pct, valueText: pct + '%', subText: '' },
            { id: 'climate.living', domain: 'climate', label: 'Thermostat', state: 'heat', active: true, adjustable: true, pct: null, valueText: '22°C · heat', subText: 'Now 20.1°C' },
            { id: 'scene.movie', domain: 'scene', label: 'Movie Time', state: 'scening', active: false, adjustable: false, pct: null, valueText: 'Activate', subText: '' }
          ]
        }
      });
    }
    if (pathname.endsWith('/act')) {
      const body = JSON.parse(req.postData() || '{}');
      acts.push(body);
      if (body.id === 'light.desk' && body.action === 'step') {
        pct = Math.max(0, Math.min(100, pct + (body.value > 0 ? 10 : -10)));
        return route.fulfill({ json: { ok: true, tile: { id: 'light.desk', domain: 'light', label: 'Desk Lamp', state: 'on', active: true, adjustable: true, pct: pct, valueText: pct + '%', subText: '' } } });
      }
      if (body.id === 'scene.movie') {
        return route.fulfill({ json: { ok: true, tile: { id: 'scene.movie', domain: 'scene', label: 'Movie Time', state: 'scening', active: false, adjustable: false, pct: null, valueText: 'Activate', subText: '' } } });
      }
      return route.fulfill({ json: { ok: true, tile: { id: body.id, domain: 'climate', label: 'Thermostat', state: 'heat', active: true, adjustable: true, pct: null, valueText: '21.5°C · heat', subText: 'Now 20.1°C' } } });
    }
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(base + '/assets/habar.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length === 3 && document.body.className === 'on');
    const hintOn = await page.textContent('#hint');
    if (hintOn.indexOf('OK toggle') === -1) fail('expected hint text when showHints=true, got ' + hintOn);
    const focusStyle = await page.evaluate(() => {
      const el = document.querySelector('.tile.focus.active.dom-light');
      const cs = el ? getComputedStyle(el) : null;
      return cs ? { bg: cs.backgroundColor, color: cs.color } : null;
    });
    if (!focusStyle || focusStyle.bg !== 'rgb(255, 255, 255)' || focusStyle.color !== 'rgb(17, 17, 17)') {
      fail('focused active light tile contrast mismatch: ' + JSON.stringify(focusStyle));
    }
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.tile.focus .val').textContent === '60%');
    await page.keyboard.press('ArrowRight');
    const climSub = await page.textContent('.tile.focus .sub');
    if (climSub !== 'Now 20.1°C') fail('climate subText mismatch: ' + climSub);
    await page.click('.tile.focus .step-btn[data-step="-1"]');
    await page.waitForFunction(() => document.querySelector('.tile.focus .val').textContent.indexOf('21.5') === 0);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.tile.focus .val').textContent === 'Activated');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__closed === true);
    if (acts.length !== 3) fail('expected 3 act calls, got ' + acts.length);

    showHints = false;
    await page.evaluate(() => { window.__closed = false; });
    await page.goto(base + '/assets/habar.html');
    await page.waitForFunction(() => document.querySelectorAll('#row .tile').length === 3 && document.body.className === 'on');
    const hintOff = await page.textContent('#hint');
    const clockOff = await page.textContent('#clock');
    if (hintOff !== '') fail('expected empty #hint when showHints=false, got ' + JSON.stringify(hintOff));
    if (!clockOff) fail('expected #clock to remain visible when showHints=false');
  } finally {
    await page.close();
  }
}

async function visitHomeHaRow(browser, base, problems) {
  const fail = what => problems.push('Home HA row: ' + what);
  const runCase = async (haRow, haBarAvailable, showHints = true) => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fail(e.message));
    const layout = { rows: ['app', 'ha'], order: { app: [], ha: [] }, hidden: { app: [], ha: [] },
      hiddenRows: [], channels: [], hintSeen: true, searchHintSeen: true, haRow };
    let pct = 40, swOn = false;
    const acts = [];
    await page.route('**/api/home/**', route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/home/catalogue') {
        return route.fulfill({ json: { ok: true, layout, layoutVersion: 1, haBarAvailable, haBarCount: 3,
          apps: [{ id: 'netflix', title: 'Netflix' }], devices: [], channels: [],
          sources: { channels: 0 }, order: { app: ['netflix'], ha: [] } } });
      }
      return route.fulfill({ json: { ok: true, layout, layoutVersion: 1 } });
    });
    await page.route('**/api/ha/bar/**', route => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/state')) {
        return route.fulfill({ json: { ok: true, configured: true, showHints, tiles: [
          { id: 'switch.kettle', domain: 'switch', label: 'Kettle', state: swOn ? 'on' : 'off', active: swOn, adjustable: false, pct: null, valueText: swOn ? 'On' : 'Off', subText: '' },
          { id: 'light.desk', domain: 'light', label: 'Desk', state: 'on', active: true, adjustable: true, pct, valueText: pct + '%', subText: '' },
          { id: 'scene.movie', domain: 'scene', label: 'Movie Time', state: 'scening', active: false, adjustable: false, pct: null, valueText: 'Activate', subText: '' }
        ] } });
      }
      if (p.endsWith('/act')) {
        const body = JSON.parse(route.request().postData() || '{}');
        acts.push(body);
        if (body.id === 'switch.kettle') {
          swOn = !swOn;
          return route.fulfill({ json: { ok: true, tile: { id: 'switch.kettle', domain: 'switch', label: 'Kettle', state: swOn ? 'on' : 'off', active: swOn, adjustable: false, pct: null, valueText: swOn ? 'On' : 'Off', subText: '' } } });
        }
        if (body.id === 'light.desk' && body.action === 'step') {
          pct = Math.max(0, Math.min(100, pct + (body.value > 0 ? 10 : -10)));
          return route.fulfill({ json: { ok: true, tile: { id: 'light.desk', domain: 'light', label: 'Desk', state: 'on', active: true, adjustable: true, pct, valueText: pct + '%', subText: '' } } });
        }
        return route.fulfill({ json: { ok: true, tile: { id: 'scene.movie', domain: 'scene', label: 'Movie Time', state: 'scening', active: false, adjustable: false, pct: null, valueText: 'Activate', subText: '' } } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(base + '/assets/home.html');
    await page.waitForFunction(() => document.querySelectorAll('.row[data-key="app"] .tile').length === 1);
    return { page, acts };
  };

  let ctx = await runCase(false, true);
  try {
    const visibleOff = await ctx.page.evaluate(() => getComputedStyle(document.querySelector('.row[data-key="ha"]')).display);
    if (visibleOff !== 'none') fail('HA row should stay hidden when haRow=false (display=' + visibleOff + ')');
  } finally { await ctx.page.close(); }

  ctx = await runCase(true, true);
  try {
    const { page, acts } = ctx;
    await page.waitForFunction(() => document.querySelectorAll('.row[data-key="ha"] .tile.ha').length === 3);
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.row.active') && document.querySelector('.row.active').getAttribute('data-key') === 'ha');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.tile.ha.focus .ha-val').textContent === 'On');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageUp');
    await page.waitForFunction(() => document.querySelector('.tile.ha.focus .ha-val').textContent === '50%');
    await page.click('.tile.ha.focus .ha-step[data-step="1"]');
    await page.waitForFunction(() => document.querySelector('.tile.ha.focus .ha-val').textContent === '60%');
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('.tile.ha.focus .ha-val').textContent === '50%');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.tile.ha.focus .ha-val').textContent === 'Activated');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.row.active') && document.querySelector('.row.active').getAttribute('data-key') === 'app');
    if (acts.length !== 5) fail('expected 5 HA row actions, got ' + JSON.stringify(acts));
  } finally { await ctx.page.close(); }

  ctx = await runCase(true, true, false);
  try {
    await ctx.page.waitForFunction(() => document.querySelectorAll('.row[data-key="ha"] .tile.ha').length === 3);
    const haHead = await ctx.page.textContent('.row[data-key="ha"] h2');
    if (haHead.indexOf('Ch +/-') !== -1) fail('expected no Ch +/- hint when showHints=false, got ' + haHead);
  } finally { await ctx.page.close(); }
}

async function visitHomeWeather(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home weather: ' + e.message));
  const fail = what => problems.push('Home weather: ' + what);
  const layout = { rows: ['app'], order: { app: [] }, hidden: { app: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  let weather = null, version = 1;
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: version,
      apps: [{ id: 'app', title: 'App' }], devices: [], channels: [], sources: { channels: 0 }, order: { app: ['app', 'lg-home'] } });
    if (url.pathname.endsWith('/weather')) return reply(weather ? Object.assign({ ok: true }, weather) : { ok: false });
    if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
    return reply({ ok: true, build: 'weather', layoutVersion: version, weather });
  });
  const beat = async () => {
    const replied = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/beat');
    await page.clock.fastForward(5000);
    await replied;
    await page.evaluate(() => 0);
  };
  const shown = () => page.evaluate(() => {
    const w = document.getElementById('weather');
    return w.className === 'none' ? null : { svg: !!w.querySelector('#wxIcon svg'), temp: document.getElementById('wxTemp').textContent,
      city: document.getElementById('wxCity').textContent, cond: document.getElementById('wxCond').textContent };
  });
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    if (await shown()) fail('shown before anything was pushed');
    weather = { condition: 'rainy', temp: 9.6, city: 'Glasgow' };
    await beat();
    const w = await shown();
    if (!w || !w.svg || w.temp !== '10°' || w.city !== 'Glasgow' || w.cond !== 'Rainy') fail('a push was shown as ' + JSON.stringify(w));
    weather = { condition: 'volcanic', temp: -2.4, city: null };
    await beat();
    const odd = await shown();
    if (!odd || !odd.svg || odd.temp !== '-2°' || odd.cond !== '') fail('a condition Home Assistant does not name was shown as ' + JSON.stringify(odd));
    weather = null;
    await beat();
    if (await shown()) fail('still shown once the heartbeat brought none');
    // Open-Meteo's weather carries its credit, in the corner, gone with the weather.
    const credit = () => page.evaluate(() => {
      const c = document.getElementById('wxCredit');
      return c.textContent && getComputedStyle(c).display !== 'none' ? c.textContent : '';
    });
    if (await credit()) fail('Home Assistant\'s weather credited to Open-Meteo');
    weather = { condition: 'cloudy', temp: 9.7, city: 'Glasgow', source: 'internet' };
    await beat();
    const net = await shown();
    if (!net || net.temp !== '10°' || net.cond !== 'Cloudy') fail('Open-Meteo\'s weather was shown as ' + JSON.stringify(net));
    if (await credit() !== 'Weather data by Open-Meteo.com') fail('Open-Meteo\'s weather shown without its credit');
    weather = null;
    await beat();
    if (await credit()) fail('the credit stayed once the weather went');
  } catch (e) {
    fail(e.message);
  }
  await page.close();
}

// The Home tab's Weather setting: the source, and a place found by name for
// Open-Meteo. The search is answered here, so the check never reaches Open-Meteo.
// The remote's battery after the date: a percentage, or a step remote's word,
// orange once low, and gone when the heartbeat brings none.
async function visitHomeRemoteBattery(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home remote battery: ' + e.message));
  const fail = what => problems.push('Home remote battery: ' + what);
  const layout = { rows: ['app'], order: { app: [] }, hidden: { app: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  let battery = null;
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1,
      apps: [{ id: 'app', title: 'App' }], devices: [], channels: [], sources: { channels: 0 }, order: { app: ['app', 'lg-home'] } });
    if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
    return reply({ ok: true, build: 'battery', layoutVersion: 1, remoteBattery: battery });
  });
  const beat = async () => {
    const replied = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/beat');
    await page.clock.fastForward(5000);
    await replied;
    await page.evaluate(() => 0);
  };
  const shown = () => page.evaluate(() => {
    const b = document.getElementById('rbat');
    if (getComputedStyle(b).display === 'none') return null;
    return { text: document.getElementById('rbatPct').textContent, low: b.classList.contains('low'),
      colour: getComputedStyle(b).color, label: b.getAttribute('aria-label') };
  });
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    if (await shown()) fail('shown before the heartbeat brought it');
    battery = { level: 87, step: null, low: false };
    await beat();
    const pct = await shown();
    if (!pct || pct.text !== '87%' || pct.low || pct.label !== 'Remote battery: 87%') fail('87% was shown as ' + JSON.stringify(pct));
    battery = { level: null, step: 'mid', low: false };
    await beat();
    const mid = await shown();
    if (!mid || mid.text !== 'Medium' || mid.low) fail('a MID step was shown as ' + JSON.stringify(mid));
    battery = { level: null, step: 'low', low: true };
    await beat();
    const low = await shown();
    if (!low || low.text !== 'Low' || !low.low || low.colour !== 'rgb(255, 138, 76)') fail('a LOW step was shown as ' + JSON.stringify(low));
    battery = { level: 15, step: null, low: true };
    await beat();
    const lowPct = await shown();
    if (!lowPct || lowPct.text !== '15%' || !lowPct.low) fail('15% was shown as ' + JSON.stringify(lowPct));
    battery = null;
    await beat();
    if (await shown()) fail('still shown once the heartbeat brought none');
  } catch (e) {
    fail(e.message);
  } finally { await page.close(); }
}

// The setting is offered only where the badge could ever show.
async function visitHomeRemoteBatterySetting(browser, base, problems) {
  const fail = what => problems.push('Home remote battery setting: ' + what);
  for (const available of [true, false]) {
    const page = await browser.newPage();
    page.on('pageerror', e => problems.push('Home remote battery setting: ' + e.message));
    const layout = { rows: ['app'], order: { app: [] }, sort: { app: 'custom' }, hidden: { app: [] }, channels: [],
      hintSeen: true, searchHintSeen: true, remoteBattery: 'low' };
    const saves = [];
    await page.route('**/api/home**', async route => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === '/api/home') body = { ok: true, supported: { ok: true }, installed: true, enabled: true, active: true,
        writable: true, layout, history: true, remoteBatteryAvailable: available };
      else if (url.pathname.endsWith('/catalogue')) body = { ok: true, apps: [], channels: [], devices: [], layout, order: { app: ['lg-home'] } };
      else if (url.pathname.endsWith('/layout')) {
        const patch = route.request().postDataJSON();
        saves.push(patch);
        if (patch.remoteBattery) layout.remoteBattery = patch.remoteBattery;
        body = { ok: true, layout: JSON.parse(JSON.stringify(layout)) };
      } else body = { ok: true };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    try {
      await page.goto(base + '/?tab=home');
      await page.locator('#home-subnav button[data-home-view="behavior"]').click();
      // Weather's row, beside it, shows once the tab has drawn.
      await page.waitForFunction(() => { const s = document.getElementById('home-weather-sel'); return s && s.offsetParent; });
      const sel = page.locator('#home-remote-battery-sel');
      if (!available) {
        if (await sel.isVisible()) fail('offered with no battery to show');
      } else {
        if (!await sel.isVisible()) fail('not offered with a remote whose battery is read');
        else {
          if (await sel.inputValue() !== 'low') fail('read ' + await sel.inputValue() + ' for When low');
          const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
          await sel.selectOption('always');
          await saved;
          if (JSON.stringify(saves) !== '[{"remoteBattery":"always"}]') fail('choosing Always saved ' + JSON.stringify(saves));
        }
      }
    } catch (e) {
      fail(e.message);
    } finally { await page.close(); }
  }
}

async function visitHomeWeatherSetting(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home weather setting: ' + e.message));
  const fail = what => problems.push('Home weather setting: ' + what);
  const layout = { rows: ['app'], order: { app: [] }, sort: { app: 'custom' }, hidden: { app: [] }, channels: [],
    hintSeen: true, searchHintSeen: true, weather: 'ha', weatherPlace: null };
  const saves = [], searches = [];
  const glasgow = { name: 'Glasgow', admin: 'Scotland', country: 'United Kingdom', countryCode: 'GB', lat: 55.8652, lon: -4.2576 };
  await page.route('**/api/home**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/home') body = { ok: true, supported: { ok: true }, installed: true, enabled: true, active: true, writable: true, layout, history: true };
    else if (url.pathname.endsWith('/catalogue')) body = { ok: true, apps: [], channels: [], devices: [], layout, order: { app: ['lg-home'] } };
    else if (url.pathname.endsWith('/weather/places')) {
      searches.push(url.searchParams.get('q'));
      body = { ok: true, places: url.searchParams.get('q') === 'Glasgow' ? [glasgow] : [] };
    } else if (url.pathname.endsWith('/layout')) {
      const patch = route.request().postDataJSON();
      saves.push(patch);
      if (patch.weather) layout.weather = patch.weather;
      if (patch.weatherPlace !== undefined) layout.weatherPlace = patch.weatherPlace;
      body = { ok: true, layout: JSON.parse(JSON.stringify(layout)) };
    } else body = { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(base + '/?tab=home');
    await page.locator('#home-subnav button[data-home-view="behavior"]').click();
    const sel = page.locator('#home-weather-sel');
    await page.waitForFunction(() => { const s = document.getElementById('home-weather-sel'); return s && !s.disabled && s.offsetParent; });
    if (await sel.inputValue() !== 'ha') fail('the source read ' + await sel.inputValue() + ' for Home Assistant');
    if (await page.locator('#home-weather-place').isVisible()) fail('the place search shown for Home Assistant');
    let saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await sel.selectOption('internet');
    await saved;
    await page.locator('#home-weather-place').waitFor();
    if (!/Search for your town/.test(await page.locator('#home-weather-chosen').textContent())) fail('no prompt to choose a place');
    await page.locator('#home-weather-q').fill('Nowhere');
    await page.locator('#home-weather-go').click();
    await page.locator('#home-weather-results').getByText('No places found').waitFor();
    await page.locator('#home-weather-q').fill('Glasgow');
    await page.locator('#home-weather-q').press('Enter');
    const pick = page.locator('#home-weather-results button');
    await pick.first().waitFor();
    if (await pick.first().textContent() !== 'Glasgow, Scotland, United Kingdom') fail('a place read ' + await pick.first().textContent());
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await pick.first().click();
    await saved;
    const last = saves[saves.length - 1];
    if (last.weather !== 'internet' || !last.weatherPlace || last.weatherPlace.lat !== glasgow.lat) fail('choosing a place saved ' + JSON.stringify(last));
    await page.waitForFunction(() => /Glasgow, Scotland/.test(document.getElementById('home-weather-chosen').textContent));
    if (JSON.stringify(searches) !== '["Nowhere","Glasgow"]') fail('searched for ' + JSON.stringify(searches));
    if (!/GeoNames/.test(await page.locator('#home-weather-place').textContent())) fail('no credit for the place search');
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await sel.selectOption('off');
    await saved;
    await page.waitForFunction(() => document.getElementById('home-weather-place').hidden);
  } catch (e) {
    fail(e.message);
  } finally { await page.close(); }
}

// The TV's tile, Keep the preview on and Preview in the tile.
// webOS 4 (a C8, 4.4.3, #1208): its browser has no broadcast-preview type, and
// its channels report no signal, so a playing channel must not be blanked.
async function visitHomePreviewWebos4(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home preview on webOS 4: ' + e.message));
  const layout = { rows: ['dev'], order: { dev: [] }, hidden: { dev: [] }, channels: [], hintSeen: true, searchHintSeen: true,
    livePreview: true, previewAlways: false, previewInTile: false, picture: false };
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.load = function () {};
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1,
      supported: { ok: true, webos: '4.4.3', standalone: true },
      apps: [], channels: [], sources: { channels: 1 },
      devices: [{ id: 'tv', name: 'TV', input: 'tv', tuner: true, port: 0, channel: { id: 'two', number: '2', name: 'Two' } }],
      order: { dev: ['tv'] } });
    if (url.pathname.endsWith('/now')) return reply({ kind: 'input', port: 1 });
    if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
    // As the C8 answers: no videooutput service, so never a signal.
    if (url.pathname.endsWith('/picture')) return reply({ ok: true, input: 'dtv', signal: null, range: 'sdr', mode: null, light: null, oled: true });
    return reply({ ok: true, build: 'preview', layoutVersion: 1 });
  });
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    if (!await page.locator('.tile.dev.tuner .dhead .dico svg').count()) {
      problems.push('Home preview on webOS 4: the TV tuner tile has no icon');
    }
    await page.clock.fastForward(400);
    await page.waitForTimeout(100);
    const type = await page.evaluate(() => {
      const s = document.querySelector('#pvVideo source');
      return s ? s.getAttribute('type') + ' ' + s.getAttribute('src') : null;
    });
    if (type !== 'service/webos-broadcast tv://two') problems.push('Home preview on webOS 4: the channel did not play as service/webos-broadcast, ' + type);
    if (type) await page.locator('#pvVideo').dispatchEvent('playing');
    // Past every try for a signal (0.5 s, then 15 at 0.4 s).
    for (let i = 0; i < 8; i++) { await page.clock.fastForward(1000); await page.waitForTimeout(30); }
    const cls = await page.evaluate(() => document.getElementById('preview').className);
    if (!/\bon\b/.test(cls) || /blank/.test(cls)) problems.push('Home preview on webOS 4: a playing channel with no signal was blanked (' + cls + ')');
  } finally {
    await page.close();
  }
}

// Preview size (#1210): Medium and Large keep the small preview's top and right
// edges in both views, and the rows start below the picture.
async function visitHomePreviewSize(browser, base, problems) {
  const boxes = {};
  for (const view of ['standard', 'alternative']) {
    for (const size of ['small', 'medium', 'large']) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      page.on('pageerror', e => problems.push('Home preview size: ' + e.message));
      const layout = { rows: ['dev'], order: { dev: [] }, hidden: { dev: [] }, channels: [], hintSeen: true, searchHintSeen: true,
        livePreview: true, previewAlways: false, previewInTile: false, previewSize: size, view, picture: false };
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      });
      await page.route('**/api/home/**', route => {
        const url = new URL(route.request().url());
        const reply = body => route.fulfill({ json: body });
        if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1,
          supported: { ok: true, webos: '9.2.0' }, apps: [], channels: [], sources: { channels: 1 },
          devices: [{ id: 'tv', name: 'TV', input: 'tv', tuner: true, port: 0, channel: { id: 'two', number: '2', name: 'Two' } }],
          order: { dev: ['tv'] } });
        if (url.pathname.endsWith('/now')) return reply({ kind: 'input', port: 1 });
        if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
        if (url.pathname.endsWith('/picture')) return reply({ ok: true, input: 'dtv', signal: 'ok', range: 'sdr', mode: null, light: null, oled: true });
        return reply({ ok: true, build: 'preview', layoutVersion: 1 });
      });
      try {
        await page.clock.install();
        await page.goto(base + '/assets/home.html');
        await page.waitForSelector('.tile');
        await page.clock.fastForward(400);
        await page.waitForTimeout(100);
        boxes[view + ' ' + size] = await page.evaluate(() => {
          const pv = document.getElementById('preview').getBoundingClientRect();
          return { on: /\bon\b/.test(document.getElementById('preview').className), top: pv.top, right: pv.right, bottom: pv.bottom,
                   width: pv.width, height: pv.height, rows: document.getElementById('rows').getBoundingClientRect().top };
        });
      } finally {
        await page.close();
      }
    }
    const small = boxes[view + ' small'];
    [['small', 356, 200], ['medium', 512, 288], ['large', 640, 360]].forEach(([size, w, h]) => {
      const b = boxes[view + ' ' + size];
      const name = 'Home preview size, ' + view + ' ' + size + ': ';
      if (!b.on) return problems.push(name + 'the preview did not show');
      if (b.width !== w || b.height !== h) problems.push(name + 'the preview is ' + b.width + 'x' + b.height + ', not ' + w + 'x' + h);
      if (Math.abs(b.top - small.top) > 1 || Math.abs(b.right - small.right) > 1) problems.push(name + 'the preview moved from the small one\'s top right corner');
      if (b.rows < b.bottom + 30) problems.push(name + 'the rows start at ' + b.rows + ', under the preview, which ends at ' + b.bottom);
    });
  }
}

// A Medium or Large preview has what it shows named under it on the left, in
// place of Last watched, and the picture details on the right, rather than
// beside it, where the strip had no room for them all.
async function visitHomePreviewSizeDetails(browser, base, problems) {
  for (const view of ['standard', 'alternative']) {
    for (const size of ['medium', 'large']) {
      const name = 'Home preview details, ' + view + ' ' + size + ': ';
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      page.on('pageerror', e => problems.push(name + e.message));
      const layout = { rows: ['dev'], order: { dev: [] }, hidden: { dev: [] }, channels: [], hintSeen: true, searchHintSeen: true,
        livePreview: true, previewAlways: false, previewInTile: false, previewSize: size, view, picture: true };
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      });
      await page.route('**/api/home/**', route => {
        const url = new URL(route.request().url());
        const reply = body => route.fulfill({ json: body });
        if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1,
          supported: { ok: true, webos: '9.2.0' }, apps: [], channels: [], sources: { channels: 0 },
          devices: [{ id: 'player', name: 'A long player name for the strip', input: 'hdmi1', port: 1 }],
          order: { dev: ['player'] } });
        if (url.pathname.endsWith('/now')) return reply({ kind: 'input', port: 1, title: 'A long player name for the strip', devices: ['player'] });
        if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
        if (url.pathname.endsWith('/signal')) return reply({ ok: true, signal: true });
        if (url.pathname.endsWith('/picture')) return reply({ ok: true, signal: { width: 3840, height: 2160, hz: 60, hdr: 'hdr10' },
          mode: { display: 'Filmmaker Mode' }, light: 80, oled: true });
        return reply({ ok: true, build: 'details', layoutVersion: 1 });
      });
      try {
        await page.clock.install();
        await page.goto(base + '/assets/home.html');
        await page.waitForSelector('.tile');
        await page.clock.fastForward(400);
        await page.waitForTimeout(100);
        if (await page.locator('#pvVideo source').count()) await page.locator('#pvVideo').dispatchEvent('playing');
        for (let i = 0; i < 6; i++) { await page.clock.fastForward(1000); await page.waitForTimeout(30); }
        const box = await page.evaluate(() => {
          const r = id => document.getElementById(id).getBoundingClientRect();
          const pv = document.getElementById('preview');
          return { cls: pv.className, pv: r('preview'), info: r('pvInfo'), name: r('pvName'), rows: r('rows').top,
            title: document.getElementById('pvNameTitle').textContent,
            sourceShown: getComputedStyle(document.getElementById('source')).visibility !== 'hidden',
            infoShown: getComputedStyle(document.getElementById('pvInfo')).display !== 'none' };
        });
        if (!/\binfo\b/.test(box.cls) || !box.infoShown) { problems.push(name + 'the picture details did not show (' + box.cls + ')'); continue; }
        if (box.info.top < box.pv.bottom) problems.push(name + 'the details are not under the preview');
        if (box.info.left < box.pv.left - 1 || box.info.right > box.pv.right + 1) problems.push(name + 'the details reach past the preview');
        if (box.title !== 'A long player name for the strip') problems.push(name + 'the preview is not named under it, ' + JSON.stringify(box.title));
        if (Math.abs(box.name.left - box.pv.left) > 1 || box.name.top < box.pv.bottom) problems.push(name + 'the name is not under the preview on the left');
        if (box.name.right > box.info.left) problems.push(name + 'the name runs into the details');
        if (box.sourceShown) problems.push(name + 'Last watched is still shown beside the preview');
        if (box.rows < Math.max(box.info.bottom, box.name.bottom) + 20) problems.push(name + 'the rows start at ' + box.rows + ', under the name and details');
      } finally {
        await page.close();
      }
    }
  }
}

async function visitHomePreviewOptions(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home preview options: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: ['one'], hintSeen: true, searchHintSeen: true,
    livePreview: true, previewAlways: false, previewInTile: false, picture: false };
  let version = 1, now = { kind: 'input', port: 1 }, covered = false, signalOn = true;
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.load = function () {};
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: version,
      apps: [{ id: 'app', title: 'App' }],
      devices: [{ id: 'tv', name: 'TV', input: 'tv', tuner: true, port: 0, channel: { id: 'two', number: '2', name: 'Two' } },
        { id: 'player', name: 'Player', port: 1 }],
      channels: [{ id: 'one', name: 'One', number: '1' }], sources: { channels: 2 },
      order: { app: ['app', 'lg-home'], dev: ['tv', 'player'], ch: ['one'] } });
    if (url.pathname.endsWith('/now')) return reply(now);
    if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
    if (url.pathname.endsWith('/signal')) return reply({ ok: true, signal: signalOn });
    if (url.pathname.endsWith('/picture')) return reply({ ok: true, signal: { width: 1920, height: 1080, hz: 25, hdr: 'sdr' } });
    return reply({ ok: true, build: 'preview', layoutVersion: version, covered, saver: covered });
  });
  async function changeLayout(change) {
    Object.assign(layout, change);
    version++;
    const updated = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await page.clock.fastForward(5000);
    await updated;
    await page.waitForTimeout(100);
  }
  const source = () => page.evaluate(() => {
    const s = document.querySelector('#pvVideo source');
    return s ? s.getAttribute('type') + ' ' + s.getAttribute('src') : null;
  });
  const shownIn = () => page.evaluate(() => {
    const pv = document.getElementById('preview');
    if (pv.parentNode.closest && pv.parentNode.closest('.tile')) return 'reparented:' + pv.parentNode.closest('.tile').querySelector('.nm').textContent;
    if (!pv.classList.contains('intile')) return pv.parentNode.id;
    const tile = document.querySelector('#rows .tile.live');
    if (!tile) return 'unmarked:' + pv.parentNode.id;
    const a = tile.getBoundingClientRect(), b = pv.getBoundingClientRect();
    const aligned = ['left', 'top', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 2);
    return aligned ? tile.querySelector('.nm').textContent : 'misaligned:' + tile.querySelector('.nm').textContent;
  });
  async function rest() {
    await page.clock.fastForward(400);
    await page.waitForTimeout(100);
    if (await page.locator('#pvVideo source').count()) await page.locator('#pvVideo').dispatchEvent('playing');
    await page.waitForTimeout(50);
  }
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    // Apps first: nothing to preview there unless kept on.
    await rest();
    if (await source()) problems.push('Home preview options: an app tile had a preview');
    await page.keyboard.press('ArrowDown');
    await rest();
    if (await source() !== 'service/webos-broadcast-preview tv://two') problems.push('Home preview options: the TV tile did not preview its last channel, ' + await source());
    if (await shownIn() !== 'now') problems.push('Home preview options: the preview was not beside the clock');
    // The screen saver over the view stops the preview, and its end brings it back (#1209).
    const before = await source();
    if (!before) problems.push('Home preview options: nothing previewed before the screen saver');
    // The next heartbeat's reply, not a time: on a slow runner it can arrive
    // after a fixed fast-forward, and the preview then starts after the check.
    const heartbeat = async () => {
      const replied = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/beat');
      await page.clock.fastForward(5000);
      await replied;
      await page.evaluate(() => 0);
    };
    covered = true;
    await heartbeat();
    await rest();
    if (await source()) problems.push('Home preview options: the preview kept playing under the screen saver');
    covered = false;
    await heartbeat();
    await rest();
    if (await source() !== before) problems.push('Home preview options: the preview did not come back after the screen saver, ' + await source());
    await changeLayout({ previewInTile: true });
    if (await shownIn() !== 'TV') problems.push('Home preview options: Preview in the tile left it at ' + await shownIn());
    if (await page.locator('#now.previewing').count()) problems.push('Home preview options: the top strip still named the preview in the tile');
    // A rebuilt row keeps the preview in its tile.
    await changeLayout({ hintSeen: false });
    await changeLayout({ hintSeen: true });
    if (await shownIn() !== 'TV') problems.push('Home preview options: a rebuilt row lost the preview, ' + await shownIn());
    await page.keyboard.press('ArrowRight');
    await rest();
    if (await source() !== 'service/webos-external ext://hdmi:1' || await shownIn() !== 'Player') problems.push('Home preview options: the input tile did not take the preview');
    // Picture details arriving, and no picture, set the preview's state: it
    // stays over its tile (#1436), and with no picture is hidden there.
    await changeLayout({ picture: true });
    await rest();
    if (await shownIn() !== 'Player') problems.push('Home preview options: picture details moved the preview off its tile, ' + await shownIn());
    await page.keyboard.press('ArrowLeft');
    await rest();
    signalOn = false;
    await page.keyboard.press('ArrowRight');
    await rest();
    for (let i = 0; i < 20; i++) { await page.clock.fastForward(500); await page.waitForTimeout(20); }
    const blank = await page.evaluate(() => {
      const pv = document.getElementById('preview');
      return { blank: pv.classList.contains('blank'), intile: pv.classList.contains('intile'), shown: getComputedStyle(pv).display !== 'none' };
    });
    if (!blank.blank) problems.push('Home preview options: an input with no signal did not go blank');
    else if (!blank.intile || blank.shown) problems.push('Home preview options: with no picture the preview left its tile, ' + JSON.stringify(blank));
    signalOn = true;
    await changeLayout({ picture: false });
    await page.keyboard.press('ArrowUp');
    await rest();
    if (await source()) problems.push('Home preview options: the preview stayed with Keep the preview on off');
    await changeLayout({ previewAlways: true });
    await rest();
    if (await source() !== 'service/webos-external ext://hdmi:1' || await shownIn() !== 'Player') problems.push('Home preview options: Keep the preview on did not show the input last watched');
    now = { kind: 'app' };
    await changeLayout({ previewInTile: false });
    if (await shownIn() !== 'now') problems.push('Home preview options: switching Preview in the tile off left it in a tile');
  } catch (e) {
    problems.push('Home preview options: ' + e.message);
  }
  await page.close();
}

// Each animated background draws, the pictures step aside, and Off puts them back.
async function visitHomeAnimations(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home animations: ' + e.message));
  const layout = { rows: ['app'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] },
    channels: [], hintSeen: true, searchHintSeen: true, wallAnim: 'off', animTheme: 'auto',
    animThemes: [{ id: 'auto' }, { id: 'sunset', sky: '#3a0f3d', light: '#ff8a4c' }] };
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1,
      apps: [{ id: 'app', title: 'App' }], devices: [], channels: [], sources: {}, order: { app: ['app', 'lg-home'], dev: [], ch: [] },
      wallpapers: { available: true, slots: { morning: true, afternoon: true, evening: true, night: true }, revision: '1' } });
    if (url.pathname.endsWith('/now')) return reply({ kind: null });
    if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: {} });
    return reply({ ok: true, build: 'anim', layoutVersion: 1 });
  });
  // Something drawn on the canvas, over the background the page sets behind it.
  const drawn = () => page.evaluate(() => {
    const c = document.getElementById('anim'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 8) lit++;
    return lit;
  });
  const open = async style => {
    layout.wallAnim = style;
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
  };
  try {
    for (const style of ['waves', 'particles', 'aquarium', 'aurora', 'glow', 'stars', 'ripples']) {
      layout.animTheme = style === 'glow' ? 'sunset' : 'auto';
      await open(style);
      // Ripples start with a still surface; a drop falls within a few seconds.
      await page.waitForTimeout(style === 'ripples' ? 3500 : 800);
      if (await page.locator('#anim.on').count() !== 1) { problems.push('Home animations: ' + style + ' did not show'); continue; }
      if (!await drawn()) problems.push('Home animations: ' + style + ' drew nothing');
      const pictures = await page.evaluate(() => Array.prototype.some.call(document.querySelectorAll('#wall .layer'), l => +l.style.opacity > 0));
      if (pictures) problems.push('Home animations: the wallpaper showed under ' + style);
    }
    await open('off');
    await page.waitForTimeout(800);
    if (await page.locator('#anim.on').count()) problems.push('Home animations: Off left the canvas showing');
    if (await page.evaluate(() => document.getElementById('anim').width)) problems.push('Home animations: with none chosen, the canvas held pixels');
  } catch (e) {
    problems.push('Home animations: ' + e.message);
  }
  await page.close();
}

async function visitHomePreview(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home preview: ' + e.message));
  const layout = { rows: ['dev', 'ch', 'app'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: ['one'], hintSeen: true, searchHintSeen: true,
    livePreview: true, picture: false };
  let version = 1, holdPicture = false, latePicture = null, holdGuide = false, lateGuide = null, lateOpen = null;
  await page.addInitScript(() => {
    // Desktop Chrome has no webOS media service. Deliver its playing event
    // separately so the page still owns the dwell and metadata lifecycle.
    window.previewPlays = 0;
    HTMLMediaElement.prototype.load = function () {};
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.play = function () { window.previewPlays++; return Promise.resolve(); };
  });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: version,
      apps: [], devices: [{ id: 'player', name: 'Player', port: 1 }],
      channels: [{ id: 'one', name: 'One', number: '1' }], sources: { channels: 1 },
      order: { app: ['lg-home'], dev: ['player'], ch: ['one'] } });
    if (url.pathname.endsWith('/now')) return reply({ kind: null });
    if (url.pathname.endsWith('/guide')) {
      if (holdGuide) { holdGuide = false; lateGuide = () => reply({ ok: true, guide: {} }); return; }
      return reply({ ok: true, guide: {} });
    }
    if (url.pathname.endsWith('/open')) { lateOpen = ok => reply({ ok }); return; }
    if (url.pathname.endsWith('/signal')) return reply({ ok: true, signal: true });
    if (url.pathname.endsWith('/picture')) {
      const body = { ok: true, mode: { display: 'Cinema' }, light: 95, oled: true,
        signal: { width: 1920, height: 1080, hz: 25, hdr: 'sdr' } };
      if (holdPicture) { holdPicture = false; latePicture = () => reply(body); return; }
      return reply(body);
    }
    return reply({ ok: true, build: 'preview', layoutVersion: version });
  });
  async function changeLayout(change) {
    Object.assign(layout, change);
    version++;
    const updated = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await page.clock.fastForward(5000);
    await updated;
    await page.waitForTimeout(100);
  }
  async function startPreview() {
    await page.clock.fastForward(400);
    await page.waitForSelector('#pvVideo source', { state: 'attached' });
    await page.locator('#pvVideo').dispatchEvent('playing');
    await page.clock.fastForward(1000);
    await page.waitForTimeout(100);
  }
  const waitFor = ready => waitUntil(page, ready);
  async function checkDetails(on, label) {
    // Shown details are waited for; hidden ones are checked as they are, so
    // details that appear late are not missed.
    const shown = on ? await waitFor(() => page.locator('#pvInfo').isVisible()) : await page.locator('#pvInfo').isVisible();
    if (shown !== on) problems.push('Home preview: ' + label);
    if (on && !await waitFor(async () => await page.locator('#pvMode').textContent() === 'Cinema')) problems.push('Home preview: missing picture mode');
  }
  try {
    await page.clock.install();
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    for (const kind of ['input', 'channel']) {
      if (kind === 'channel') await page.keyboard.press('ArrowDown');
      await startPreview();
      const plays = await page.evaluate(() => window.previewPlays);
      await checkDetails(false, kind + ' started with details disabled');
      await changeLayout({ picture: true });
      await checkDetails(true, kind + ' did not show details when enabled');
      await changeLayout({ picture: false });
      await checkDetails(false, kind + ' kept details after disabling');
      if (await page.evaluate(() => window.previewPlays) !== plays) problems.push('Home preview: changing details restarted ' + kind);
    }
    await changeLayout({ livePreview: false });
    if (await page.locator('#pvVideo source').count()) problems.push('Home preview: switching off kept its media source');
    await page.keyboard.press('ArrowUp');
    await changeLayout({ livePreview: true, picture: true });
    holdPicture = true;
    await startPreview();
    if (!await waitFor(() => !!latePicture)) throw new Error('no preview picture reply to delay');
    await changeLayout({ picture: false });
    await latePicture();
    await page.waitForTimeout(100);
    await checkDetails(false, 'a delayed reply restored disabled details');
    await changeLayout({ picture: true });
    await checkDetails(true, 'a delayed picture was unavailable after enabling details');
    await changeLayout({ livePreview: false });
    if (await page.locator('#preview').isVisible() || await page.locator('#pvVideo source').count()) {
      problems.push('Home preview: switching off kept its picture or media source');
    }
    holdGuide = true;
    await changeLayout({ livePreview: true });
    await startPreview();
    await page.keyboard.press('Enter');
    if (!await waitFor(() => !!(lateOpen && lateGuide))) throw new Error('no launch or guide reply to delay');
    await lateGuide();
    await page.waitForTimeout(100);
    await page.clock.fastForward(400);
    if (await page.locator('#pvVideo source').count()) problems.push('Home preview: a delayed guide reopened a source after OK');
    await lateOpen(false);
    await page.waitForTimeout(100);
    await page.clock.fastForward(400);
    if (!await page.locator('#pvVideo source').count()) problems.push('Home preview: a refused launch prevented retrying its preview');
    lateOpen = null;
    await page.keyboard.press('Enter');
    if (!await waitFor(() => !!lateOpen)) throw new Error('no second launch to complete');
    await lateOpen(true);
    await changeLayout({ showCec: false });
    await page.clock.fastForward(400);
    if (await page.locator('#pvVideo source').count()) problems.push('Home preview: a catalogue refresh reopened an accepted launch');
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await page.waitForTimeout(100);
    await page.clock.fastForward(400);
    if (!await page.locator('#pvVideo source').count()) problems.push('Home preview: returning to Home kept its preview suppressed');
  } finally { await page.close(); }
}

async function visitHomeVisibility(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home visibility: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true,
    showLastOn: false, showAppCount: false, showCec: false };
  let version = 1, releaseCatalogue = null;
  const zlib = require('zlib');
  const crc32 = buf => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 4, 'ascii');
    data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const iconPng = (r, g, b, transBg) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(24 * (1 + 24 * 4));
    for (let y = 0; y < 24; y++) {
      const row = y * 97;
      for (let x = 0; x < 24; x++) {
        const inside = !transBg || (x >= 8 && x < 16 && y >= 8 && y < 16);
        const o = row + 1 + x * 4;
        raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = inside ? 255 : 0;
      }
    }
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  const darkTransPng = iconPng(0, 0, 0, true), brightPng = iconPng(255, 255, 255, false);
  const reply = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/api/home/icon') {
      const body = url.searchParams.get('id') === 'airplay' ? darkTransPng : brightPng;
      return route.fulfill({ contentType: 'image/png', body });
    }
    if (pathname === '/api/home/now') return reply(route, { kind: 'input', port: 1, title: 'Player' });
    if (pathname === '/api/home/catalogue') {
      const body = { ok: true, layout, layoutVersion: String(version),
        apps: [{ id: 'airplay', title: 'AirPlay', icon: '/api/home/icon?id=airplay' },
          { id: 'opaque', title: 'Opaque', icon: '/api/home/icon?id=opaque' }],
        devices: [{ id: 'player', name: 'Player', port: 1, address: '1.0.0.0' }], channels: [],
        sources: { channels: 0 }, order: { app: ['airplay', 'opaque', 'lg-home'], dev: ['player'], ch: [] } };
      const snapshot = JSON.parse(JSON.stringify(body));
      releaseCatalogue = () => reply(route, snapshot);
      return;
    }
    return reply(route, { ok: true, build: 'one', layoutVersion: String(version) });
  });
  async function check(shown) {
    const actual = await page.evaluate(() => {
      const tile = document.querySelector('.tile.dev');
      const pathEl = tile.querySelector('.path');
      const st = tile.querySelector('.st');
      const scale = document.getElementById('stage').getBoundingClientRect().width / 1920 || 1;
      const tr = tile.getBoundingClientRect(), pr = pathEl.getBoundingClientRect(), sr = st.getBoundingClientRect();
      return {
        source: document.getElementById('srcTitle').textContent.trim(),
        last: !!document.querySelector('.tile.dev.last'),
        count: !!document.querySelector('[data-key="app"] h2 span'),
        cec: tile.querySelector('.st span').textContent.trim(),
        gap: Math.round((sr.top - pr.bottom) / scale * 10) / 10,
        bottomPad: Math.round((tr.bottom - sr.bottom) / scale * 10) / 10,
        clock: document.getElementById('clock').getBoundingClientRect().left
      };
    });
    if (actual.source !== (shown ? 'Player' : '') || actual.last !== shown || actual.count !== shown ||
        actual.cec !== (shown ? 'CEC 1.0.0.0' : '')) {
      problems.push('Home visibility: details did not follow the loaded switches: ' + JSON.stringify(actual));
    }
    if (!(actual.gap >= 10) || !(actual.bottomPad >= 16)) {
      problems.push('Home visibility: input tile path and status are cramped: ' + JSON.stringify(actual));
    }
    return actual.clock;
  }
  async function release() {
    for (let n = 0; !releaseCatalogue && n < 100; n++) await page.waitForTimeout(20);
    if (!releaseCatalogue) throw new Error('Home visibility: no catalogue request');
    const received = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await releaseCatalogue();
    releaseCatalogue = null;
    await received;
    await page.waitForTimeout(50);
  }
  try {
    await page.clock.install();
    const firstNow = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/now');
    await page.goto(base + '/assets/home.html');
    await firstNow;
    await page.waitForTimeout(50);
    if ((await page.locator('#srcTitle').textContent()).trim()) problems.push('Home visibility: last watched appeared before the layout loaded');
    if (await page.evaluate(() => getComputedStyle(document.getElementById('when')).visibility) !== 'hidden') {
      problems.push('Home visibility: the clock appeared before the layout loaded');
    }
    await release();
    await page.waitForSelector('.tile');
    const clock = await check(false);
    // Layouts saved before these switches existed retain all three details.
    delete layout.showLastOn; delete layout.showAppCount; delete layout.showCec;
    version++;
    await page.clock.fastForward(5000);
    await release();
    if (await check(true) !== clock) problems.push('Home visibility: the clock moved when last watched appeared');
    layout.showLastOn = layout.showAppCount = layout.showCec = false;
    version++;
    await page.clock.fastForward(5000);
    await release();
    if (await check(false) !== clock) problems.push('Home visibility: the clock moved when last watched was hidden');
    // The clock switched off keeps its space; the rows along the bottom sit lower.
    const place = () => page.evaluate(() => ({
      when: getComputedStyle(document.getElementById('when')).visibility,
      rowTop: document.querySelector('.row').getBoundingClientRect().top,
      rowsBottom: document.getElementById('rows').getBoundingClientRect().bottom,
      // The row in focus: along the bottom, the rows after it wait below the screen.
      lastBottom: document.querySelector('.row.active').getBoundingClientRect().bottom
    }));
    const centred = await place();
    layout.showClock = false;
    layout.rowsBottom = true;
    version++;
    await page.clock.fastForward(5000);
    await release();
    const bottom = await place();
    if (bottom.when !== 'hidden') problems.push('Home visibility: the clock stayed with it switched off');
    // Only a row's own margin is left below the row in focus.
    const gap = p => p.rowsBottom - p.lastBottom;
    if (!(bottom.rowTop > centred.rowTop) || !(gap(bottom) < gap(centred) / 3)) {
      problems.push('Home visibility: the rows are not along the bottom: ' + JSON.stringify({ centred, bottom }));
    }
    // Alternative View: the clock on the right, and the row titles hidden.
    layout.showClock = true;
    layout.view = 'alternative';
    version++;
    await page.clock.fastForward(5000);
    await release();
    const alt = await page.evaluate(() => ({
      when: document.getElementById('when').getBoundingClientRect().left,
      source: document.getElementById('source').getBoundingClientRect().left,
      titles: [].slice.call(document.querySelectorAll('.row > h2')).filter(h => h.offsetHeight).length
    }));
    if (!(alt.when > alt.source) || alt.titles) problems.push('Home visibility: Alternative View did not apply: ' + JSON.stringify(alt));
    await page.waitForSelector('.tile.app img.dark-ico');
    const iconBg = await page.evaluate(() => [].slice.call(document.querySelectorAll('.tile.app img')).map(i => ({
      src: i.getAttribute('src'), dark: i.classList.contains('dark-ico'), bg: getComputedStyle(i).backgroundColor
    })));
    const ap = iconBg.find(i => i.src.includes('id=airplay')), op = iconBg.find(i => i.src.includes('id=opaque'));
    if (!ap || !ap.dark || ap.bg !== 'rgb(236, 231, 223)' || !op || op.dark) {
      problems.push('Home visibility: dark transparent icon check failed: ' + JSON.stringify(iconBg));
    }
    layout.showAppLabels = false;
    version++;
    await page.clock.fastForward(5000);
    await release();
    const labelBox = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const nm = document.querySelector('.tile.app .nm');
      return { cls: stage.classList.contains('no-app-labels'), h: nm ? nm.offsetHeight : -1 };
    });
    if (!labelBox.cls || labelBox.h !== 0) problems.push('Home visibility: App labels off left app titles visible: ' + JSON.stringify(labelBox));
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
  const settle = async (sel, from) => {
    const deadline = Date.now() + 4000;
    let last = await x(sel), stable = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(50);
      const cur = await x(sel);
      if (cur === last && (from === undefined || cur !== from)) {
        if (++stable >= 3) return cur;
      } else {
        last = cur;
        stable = 0;
      }
    }
    return last;
  };
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
    const stopped = await settle(apps0);
    await page.waitForTimeout(300);
    if (await x(apps0) !== stopped) problems.push('Home scrolling: the glide went on after the pointer left the end');
    await page.mouse.wheel(0, 100);
    const notched = await settle(apps0, stopped);
    if (Math.round(notched - stopped) !== 176) problems.push('Home scrolling: a wheel notch did not move the row one tile');
    // Wheel steps move tiles under a still pointer: a click then opens the
    // tile now under it, and moving down a row leaves this row where it is.
    await page.mouse.wheel(0, 300);
    const wheeled = await settle(apps0, notched);
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
    await page.waitForFunction(from => { const xs = window.xs, n = xs.length; return n > from + 10 && xs[n - 1] === xs[n - 6]; }, at, { timeout: 5000 });
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

// A return comes as a relaunch and the page shown again, in either order: one
// catalogue and one /now, and a catalogue with the rev the view has leaves
// the rows as they are.
async function visitHomeReturnOnce(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home return: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  const asked = { catalogue: 0, now: 0 };
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/catalogue')) {
      asked.catalogue++;
      return reply({ ok: true, rev: 'r1', layoutVersion: '1', layout, apps: [{ id: 'app0', title: 'App 0' }], devices: [], channels: [],
        sources: { channels: 0 }, order: { app: ['app0'], dev: [], ch: [] } });
    }
    if (url.pathname.endsWith('/now')) { asked.now++; return reply({ kind: null }); }
    return reply({ ok: true, build: 'one' });
  });
  try {
    const homeResponse = endpoint => page.waitForResponse(response => new URL(response.url()).pathname === '/api/home/' + endpoint);
    const startNow = homeResponse('now');
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    await startNow;
    await page.evaluate(() => {
      window.__hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
      window.__tile = document.querySelector('.tile');
    });
    for (const order of [['shown', 'relaunch'], ['relaunch', 'shown']]) {
      await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
      const before = Object.assign({}, asked);
      const replies = Promise.all([homeResponse('catalogue'), homeResponse('now')]);
      await page.evaluate(steps => {
        for (const step of steps) {
          if (step === 'relaunch') document.dispatchEvent(new Event('webOSRelaunch'));
          else { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); }
        }
      }, order);
      await replies;
      // Leave time for a duplicate request queued behind the first reply.
      await page.waitForTimeout(300);
      const what = order.join(' then ');
      if (asked.catalogue - before.catalogue !== 1) problems.push('Home return: ' + what + ' asked for the catalogue ' + (asked.catalogue - before.catalogue) + ' times');
      if (asked.now - before.now !== 1) problems.push('Home return: ' + what + ' asked what is on ' + (asked.now - before.now) + ' times');
      if (!(await page.evaluate(() => document.querySelector('.tile') === window.__tile))) problems.push('Home return: ' + what + ' rebuilt the rows for the same catalogue');
    }
  } finally { await page.close(); }
}

// Glasshouse Home's fading and its Inputs row without the inputs that have
// nothing plugged in, each where the layout asks for it.
async function visitHomeFadeAndInputs(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home fade: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true, colours: null, fade: false, hideUnused: true };
  let version = 1;
  let sleeps = 0;
  let screenOff = false;
  let openFails = false;
  let holdCatalogue = null;
  const opened = [];
  const catalogue = () => ({ ok: true, layout, layoutVersion: String(version),
    apps: [{ id: 'netflix', title: 'Netflix', icon: null }, { id: 'com.webos.app.voice', title: 'Search', icon: null, overlay: true }],
    devices: [{ id: 'hdmi1', name: 'Xbox', input: 'hdmi1', port: 1, via: null, address: null },
      { id: 'hdmi2', name: 'HDMI 2', input: 'hdmi2', port: 2, via: null, address: null, unused: true }],
    channels: [], sources: { channels: 0 },
    order: { app: ['netflix', 'com.webos.app.voice', 'lg-home'], dev: ['hdmi1', 'hdmi2'], ch: [] } });
  await page.route('**/api/home/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/home/catalogue' && holdCatalogue) await holdCatalogue;
    if (pathname === '/api/home/open') {
      opened.push({ id: JSON.parse(route.request().postData() || '{}').id, at: Date.now() });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(openFails ? { ok: false, error: 'no' } : { ok: true }) });
    }
    const body = pathname === '/api/home/catalogue' ? catalogue()
      : pathname === '/api/home/now' ? { kind: 'none' }
      : { ok: true, build: 'one', layoutVersion: String(version), sleeps, screenOff };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const faded = () => page.evaluate(() => / ?faded/.test(document.documentElement.className));
  const devTiles = () => page.locator('.tile.dev').count();
  async function returned() {
    const reply = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await reply;
    await page.waitForTimeout(150);
  }
  async function visible(hidden) {
    await page.evaluate(h => {
      Object.defineProperty(document, 'hidden', { value: h, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await page.waitForTimeout(150);
  }
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile.dev');
    if (await devTiles() !== 1) problems.push('Home inputs: an input with nothing plugged in showed with hideUnused on');
    layout.hideUnused = false;
    version++;
    await returned();
    if (await devTiles() !== 2) problems.push('Home inputs: an input with nothing plugged in was left out with hideUnused off');
    // Hidden one by one, an input with something plugged in is left out too.
    layout.hidden.dev = ['hdmi1'];
    version++;
    await returned();
    if (await devTiles() !== 1 || await page.locator('.tile.dev.unused').count() !== 1) problems.push('Home inputs: a hidden input showed, or the unplugged one went with it');
    layout.hidden.dev = [];
    version++;
    await returned();
    if (await faded()) problems.push('Home fade: the view was dark without fading chosen');

    layout.fade = true;
    version++;
    await returned();
    // Netflix, the first tile: dark at once, opened only once the fade is over.
    await page.keyboard.press('Enter');
    const pressedAt = Date.now();
    await waitUntil(page, faded);
    if (!await faded()) problems.push('Home fade: opening a tile did not fade out');
    if (opened.length) problems.push('Home fade: the tile opened before the fade was over');
    await waitUntil(page, () => opened.length > 0);
    if (opened.length !== 1 || opened[0].id !== 'netflix') problems.push('Home fade: the tile did not open after the fade');
    else if (opened[0].at - pressedAt < 300) problems.push('Home fade: the tile opened ' + (opened[0].at - pressedAt) + ' ms after OK, before the fade');
    // Off screen and back: dark, then in.
    await visible(true);
    if (!await faded()) problems.push('Home fade: off screen, the view was not left dark');
    await visible(false);
    await waitUntil(page, async () => !await faded());
    if (await faded()) problems.push('Home fade: back on screen, the view did not fade in');

    // Search opens over Home: no fade, and opened at once.
    await page.keyboard.press('ArrowRight');
    opened.length = 0;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    if (await faded()) problems.push('Home fade: an overlay of LG\'s faded the view out');
    // Not faded is what "at once" means; the open itself is given time, as
    // 120 ms was too short with the other groups sharing CI's cores (#1161).
    for (let waited = 120; !opened.length && waited < 1500; waited += 50) await page.waitForTimeout(50);
    if (!opened.length || opened[0].id !== 'com.webos.app.voice') problems.push('Home fade: an overlay was not opened');

    // A failed open brings the view back.
    await page.keyboard.press('ArrowLeft');
    openFails = true;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    if (await faded()) problems.push('Home fade: a failed open left the view dark');
    openFails = false;

    // Back on screen: dark while the rows and what was last on are refreshed, then in.
    await visible(true);
    await waitUntil(page, faded, 2000);
    let releaseRows;
    holdCatalogue = new Promise(r => { releaseRows = r; });
    await visible(false);
    await page.waitForTimeout(250);
    if (!await faded()) problems.push('Home fade: coming back faded in before the rows were refreshed');
    releaseRows();
    holdCatalogue = null;
    await page.waitForTimeout(150);
    const cls = await page.evaluate(() => document.documentElement.className);
    if (/faded/.test(cls)) problems.push('Home fade: the refreshed rows did not fade in');
    else if (!/\bin\b/.test(cls)) problems.push('Home fade: coming back did not use the fade in (' + cls + ')');
    // A refresh that does not come: in all the same, before long.
    await visible(true);
    await waitUntil(page, faded, 2000);
    holdCatalogue = new Promise(r => { releaseRows = r; });
    await visible(false);
    await page.waitForTimeout(1000);
    if (await faded()) problems.push('Home fade: a slow refresh kept the view dark');
    releaseRows();
    holdCatalogue = null;
    await page.waitForTimeout(200);

    // Screen off (TV into standby): stays as it was, and waking shows it without a fade.
    sleeps++;
    screenOff = true;
    await visible(true);
    await page.waitForTimeout(1200);
    if (await faded()) problems.push('Home fade: screen going off darkened the view');
    screenOff = false;
    await visible(false);
    if (await faded()) problems.push('Home fade: waking from standby left the view dark');

    // Arranging: the input with nothing plugged in shows, greyed out, and is not hidden on its own.
    layout.hideUnused = true;
    version++;
    await returned();
    await page.waitForTimeout(400);
    await page.keyboard.down('Enter');
    await page.waitForTimeout(900);
    await page.keyboard.up('Enter');
    await page.waitForTimeout(150);
    if (await page.locator('.tile.dev.unused').count() !== 1) problems.push('Home inputs: arranging did not show the input with nothing plugged in');
    // Picked up, then Back: an input is hidden one by one, beside the switch.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: 461, bubbles: true }));
    });
    await page.waitForTimeout(150);
    if (await page.locator('.tile.dev.hidden').count() !== 1) problems.push('Home inputs: Back did not hide an input while arranging');

    // From cold with fading chosen: dark before the catalogue, in once it comes.
    let release;
    holdCatalogue = new Promise(r => { release = r; });
    await page.reload();
    await page.waitForTimeout(150);
    if (!await faded()) problems.push('Home fade: from cold with fading on, the view did not start dark');
    release();
    holdCatalogue = null;
    await page.waitForSelector('.tile');
    await page.waitForTimeout(600);
    if (await faded()) problems.push('Home fade: from cold, the view did not fade in after the catalogue');
  } finally { await page.close(); }
}

// The Home tab's Inputs row: a switch for inputs with nothing plugged in,
// beside show or hide for each input.
async function visitHomeInputsEditor(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home inputs editor: ' + e.message));
  const layout = { rows: ['dev', 'app', 'ch'], order: { app: [], dev: [], ch: [] }, sort: { app: 'custom', dev: 'custom', ch: 'custom' },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true, hideUnused: false };
  const saves = [];
  await page.route('**/api/inputs', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, writable: true }) }));
  await page.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body;
    if (pathname === '/api/home') body = { ok: true, supported: { ok: true }, installed: true, enabled: true, active: true, writable: true, layout, history: true };
    else if (pathname.endsWith('/catalogue')) body = { ok: true, apps: [], channels: [], layout,
      devices: [{ id: 'hdmi1', name: 'Xbox', input: 'hdmi1', port: 1 }, { id: 'hdmi2', name: 'HDMI 2', input: 'hdmi2', port: 2, unused: true }],
      order: { app: ['lg-home'], dev: ['hdmi1', 'hdmi2'], ch: [] } };
    else if (pathname.endsWith('/layout')) {
      const patch = route.request().postDataJSON();
      saves.push(patch);
      if (typeof patch.hideUnused === 'boolean') layout.hideUnused = patch.hideUnused;
      body = { ok: true, layout: JSON.parse(JSON.stringify(layout)) };
    } else body = { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(base + '/?tab=home');
    await page.locator('.home-row[data-kind="dev"]').waitFor();
    if (await page.locator('details.home-row[data-kind="dev"]').count()) {
      problems.push('Home inputs editor: per-input list remained expandable on the Home tab');
    }
    await page.goto(base + '/?tab=inputs');
    const list = page.locator('#inputs-list');
    await list.locator('.home-tile').first().waitFor();
    if (await list.locator('button#home-hide-unused.pill').count() !== 1) problems.push('Home inputs editor: the Inputs tab has no On and Off switch for inputs with nothing connected');
    const toggles = await list.locator('.home-tile').getByText(/^(Shown|Hidden)$/).count();
    if (toggles !== 2) problems.push('Home inputs editor: inputs did not each offer show or hide beside the switch (' + toggles + ')');
    await list.locator('#home-hide-unused').click();
    const until = Date.now() + 5000;
    while (Date.now() < until && !/Left out/.test(await list.textContent())) await page.waitForTimeout(100);
    if (!saves.some(p => p.hideUnused === true)) problems.push('Home inputs editor: the switch did not save hideUnused');
    const out = await list.locator('.home-tile').filter({ hasText: 'HDMI 2' }).getByText('Left out').count();
    if (out !== 1) problems.push('Home inputs editor: the input with nothing connected was not marked Left out');
  } finally { await page.close(); }
}

async function visitHomeColours(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home colours: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true, colours: null };
  let version = 1;
  await page.route('**/api/home/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === '/api/home/catalogue'
      ? { ok: true, layout, layoutVersion: String(version), apps: [{ id: 'netflix', title: 'Netflix' }], devices: [], channels: [],
          sources: { channels: 0 }, order: { app: ['netflix', 'lg-home'], dev: [], ch: [] } }
      : { ok: true, build: 'one', layoutVersion: String(version) };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ') + ')';
  const rgba = (hex, a) => 'rgba(' + hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ') + ', ' + a + ')';
  const shadeRgb = (hex, f, a) => 'rgba(' + hex.slice(1).match(/../g).map(v => Math.round(parseInt(v, 16) * f)).join(', ') + ', ' + a + ')';
  async function check(text, accent, focusBg, idleBg) {
    const actual = await page.evaluate(() => {
      const tiles = document.querySelectorAll('.row .tile');
      return {
        text: getComputedStyle(document.getElementById('clock')).color,
        focus: getComputedStyle(document.querySelector('.tile.focus')).outlineColor,
        focusBg: getComputedStyle(document.querySelector('.tile.focus')).backgroundColor,
        idleBg: tiles[1] ? getComputedStyle(tiles[1]).backgroundColor : null
      };
    });
    if (actual.text !== rgb(text)) problems.push('Home colours: text ' + text + ' rendered as ' + actual.text);
    if (actual.focus !== rgb(accent)) problems.push('Home colours: accent ' + accent + ' rendered as ' + actual.focus);
    if (focusBg && actual.focusBg !== focusBg) problems.push('Home colours: tile focus bg expected ' + focusBg + ', got ' + actual.focusBg);
    if (idleBg && actual.idleBg !== idleBg) problems.push('Home colours: tile idle bg expected ' + idleBg + ', got ' + actual.idleBg);
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
    // Custom tile highlight fill applies in standard view, Alternative View, and resets to the view default.
    layout.tileHighlight = '#1c4f82';
    version++;
    await page.clock.fastForward(5000);
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.tile.focus')).backgroundColor === expected, rgba('#1c4f82', 0.86));
    await check('#ece7df', '#ece7df', rgba('#1c4f82', 0.86));
    layout.view = 'alternative';
    layout.colours = { text: '#d4e6f4', accent: '#5fc4ee' };
    version++;
    await page.clock.fastForward(5000);
    await page.waitForSelector('#stage.alternative .tile:not(.focus)');
    await check('#d4e6f4', '#5fc4ee', rgba('#1c4f82', 0.86), shadeRgb('#1c4f82', 0.6, 0.45));
    layout.tileHighlight = null;
    version++;
    await page.clock.fastForward(5000);
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.tile.focus')).backgroundColor === expected, 'rgba(20, 19, 16, 0.86)');
    await check('#d4e6f4', '#5fc4ee', 'rgba(20, 19, 16, 0.86)', 'rgba(12, 11, 10, 0.45)');
  } finally { await page.close(); }
}

async function visitHomeArrangement(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home arranging: ' + e.message));
  const layout = {
    rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, folder: [], channels: [], hintSeen: true, searchHintSeen: true
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
        layout.folder = [];
      } else {
        if (patch.order) Object.assign(layout.order, patch.order);
        if (patch.rows) layout.rows = patch.rows;
        if (patch.hidden) layout.hidden = patch.hidden;
        if (patch.folder) layout.folder = patch.folder;
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
    // Up from the top row reaches the bottom bar without losing the focused app, and Down returns.
    await page.keyboard.press('ArrowUp');
    if (!await page.locator('#btnHide.focus').count()) {
      problems.push('Home arranging: Up from top row did not focus the bottom bar');
    }
    await page.keyboard.press('ArrowDown');
    if (await page.locator('#banner .btn.focus').count()) {
      problems.push('Home arranging: Down did not return from the top-row bar jump');
    }
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    if (!await page.locator('#btnFolder.focus').count()) {
      problems.push('Home arranging: Right did not focus Into or out of More apps');
    }
    await page.keyboard.press('Enter');
    if (!await page.locator('#bannerState', { hasText: '(in More apps)' }).count()) {
      problems.push('Home arranging: Into or out of More apps from top row did not folder the app');
    }
    // Green toggles More apps even while a tile is picked up, dropping the held state.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 404, bubbles: true })));
    if (await page.locator('.tile.held').count() || !await page.locator('#bannerState', { hasText: 'YouTube (in More apps)' }).count()) {
      problems.push('Home arranging: Green key did not folder the held app cleanly');
    }
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
    // Waited for, not timed: on a slow runner the reload comes later than 100 ms.
    const reloaded = navigations ? Promise.resolve(true)
      : page.waitForEvent('framenavigated', { predicate: f => f === page.mainFrame(), timeout: 15000 }).then(() => true, () => false);
    await page.clock.fastForward(5000);
    if (!await reloaded) problems.push('Home arranging: an update seen while arranging was never reloaded');
  } finally { await page.close(); }
}



// Each row's Order, on Glasshouse Home's own view, the Home tab and the TV app's Home section.
/*
 * The Home tab's Recent apps: every app listed with its switch, and hiding one
 * saves the list with it while its tile stays on the Apps row.
 */
async function visitHomeRecentsHidden(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => problems.push('Home Recents: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' }, hidden: { app: [], dev: [], ch: [] }, folder: [], channels: [],
    hintSeen: true, searchHintSeen: true, excludedRecents: [] };
  const saves = [];
  await page.route('**/api/home**', route => {
    const url = new URL(route.request().url());
    const catalogue = { ok: true, apps: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], devices: [], channels: [],
      sources: { channels: 0 }, order: { app: ['one', 'two', 'lg-home'], dev: [], ch: [] }, layout };
    let body = { ok: true };
    if (url.pathname === '/api/home') body = Object.assign({ ok: true, available: true, supported: { ok: true }, enabled: true, active: true,
      writable: true, layout, history: true }, url.searchParams.get('with') ? { catalogue, channels: [] } : {});
    else if (url.pathname === '/api/home/catalogue') body = catalogue;
    else if (url.pathname === '/api/home/layout') {
      const patch = route.request().postDataJSON();
      saves.push(patch);
      if (patch.excludedRecents) layout.excludedRecents = patch.excludedRecents;
      body = { ok: true, layout: JSON.parse(JSON.stringify(layout)) };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(base + '/?tab=home');
    await page.waitForFunction(() => document.querySelectorAll('#home-recents .prot-row').length === 2);
    await page.evaluate(() => { document.querySelector('#home-recents details').open = true; });
    await page.locator('#home-recents .prot-row').first().locator('button').click();
    await page.waitForFunction(() => /1/.test((document.querySelector('#home-recents .home-row-move') || {}).textContent || ''));
    if (JSON.stringify(saves) !== JSON.stringify([{ excludedRecents: ['one'] }])) problems.push('Home Recents: hiding One saved ' + JSON.stringify(saves));
    if (layout.hidden.app.length) problems.push('Home Recents: hiding from Recents hid the tile too');
  } catch (e) {
    problems.push('Home Recents: ' + e.message);
  } finally { await page.close(); }
}

// #1212: with the pointer switched off, the cursor is hidden, moving it
// focuses nothing, and a click opens the tile in focus, once.
async function visitHomePointerOff(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home pointer off: ' + e.message));
  const layout = { rows: ['app'], order: { app: [] }, hidden: { app: [] }, channels: [], hintSeen: true, searchHintSeen: true,
    showPointer: false };
  const apps = [0, 1, 2, 3].map(i => ({ id: 'app' + i, title: 'App ' + i }));
  const opened = [];
  await page.addInitScript(() => {
    window.__cursor = [];
    window.PalmSystem = { setCursor: function (c) { window.__cursor.push(c); }, launchParams: '{}' };
  });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1, apps, channels: [], devices: [],
      order: { app: apps.map(a => a.id) } });
    if (url.pathname.endsWith('/open')) { opened.push(route.request().postDataJSON().id); return reply({ ok: true }); }
    if (url.pathname.endsWith('/now')) return reply({});
    return reply({ ok: true, build: 'pointer', layoutVersion: 1 });
  });
  const focused = () => page.evaluate(() => { const t = document.querySelector('#rows .tile.focus'); return t ? +t.getAttribute('data-c') : -1; });
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('#rows .tile.focus');
    const cursor = await page.evaluate(() => window.__cursor.slice());
    if (cursor[cursor.length - 1] !== 'blank') problems.push('Home pointer off: the cursor was not hidden (' + cursor.join(', ') + ')');
    const last = await page.locator('#rows .tile[data-c="3"]').boundingBox();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.waitForTimeout(300);
    if (await focused() !== 0) problems.push('Home pointer off: moving the pointer moved the focus to tile ' + await focused());
    await page.mouse.click(last.x + last.width / 2, last.y + last.height / 2);
    await page.waitForTimeout(500);
    if (opened.join() !== 'app0') problems.push('Home pointer off: a click opened ' + (opened.join() || 'nothing') + ', not the tile in focus (app0)');
  } finally {
    await page.close();
  }
}

// #1213: Up and Down go to the tile above or below on screen, not to the
// tile last focused in that row: app tiles over wider input tiles.
async function visitHomeUpDown(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home up and down: ' + e.message));
  const layout = { rows: ['app', 'dev'], order: { app: [], dev: [] }, hidden: { app: [], dev: [] }, channels: [],
    hintSeen: true, searchHintSeen: true };
  const apps = [];
  for (let i = 0; i < 8; i++) apps.push({ id: 'app' + i, title: 'App ' + i });
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1, apps, channels: [],
      devices: [1, 2, 3, 4].map(p => ({ id: 'hdmi' + p, name: 'HDMI ' + p, input: 'hdmi' + p, port: p })),
      order: { app: apps.map(a => a.id), dev: ['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4'] } });
    if (url.pathname.endsWith('/now')) return reply({});
    return reply({ ok: true, build: 'updown', layoutVersion: 1 });
  });
  const focused = () => page.evaluate(() => {
    const t = document.querySelector('#rows .tile.focus');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { row: t.closest('.row').getAttribute('data-key'), c: +t.getAttribute('data-c'), left: r.left, right: r.right };
  });
  const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
  const press = async key => { await page.keyboard.press(key); await page.waitForTimeout(700); };
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('#rows .tile.focus');
    // Remembered in the input row: its first tile.
    await press('ArrowDown');
    await press('ArrowUp');
    for (let i = 0; i < 5; i++) await press('ArrowRight');
    const above = await focused();
    await press('ArrowDown');
    const below = await focused();
    if (!above || !below || below.row !== 'dev') problems.push('Home up and down: Down did not reach the input row');
    else if (!overlaps(above, below)) problems.push('Home up and down: Down went to input ' + below.c + ', not the one under app ' + above.c);
    await press('ArrowUp');
    const back = await focused();
    if (!back || back.row !== 'app' || !overlaps(back, below)) problems.push('Home up and down: Up did not go to the app above the input');
  } finally {
    await page.close();
  }
}

// The More apps grid holds fewer cards than icons a line; the keys follow the lines it shows.
async function visitHomeFolderKeys(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home More apps keys: ' + e.message));
  const apps = [];
  for (let i = 0; i < 8; i++) apps.push({ id: 'app' + i, title: 'App ' + i });
  const layout = { rows: ['app'], order: { app: [] }, hidden: { app: [] }, channels: [], appCards: true,
    folder: apps.map(a => a.id), hintSeen: true, searchHintSeen: true };
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layout, layoutVersion: 1, apps, channels: [], devices: [],
      order: { app: apps.map(a => a.id) } });
    if (url.pathname.endsWith('/now')) return reply({});
    return reply({ ok: true, build: 'folderkeys', layoutVersion: 1 });
  });
  const focused = () => page.evaluate(() => {
    const t = document.querySelector('#folderGrid .tile.focus');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { f: +t.getAttribute('data-f'), top: r.top, left: r.left, right: r.right };
  });
  const press = async key => { await page.keyboard.press(key); await page.waitForTimeout(400); };
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('#rows .tile.focus');
    await press('Enter');
    await page.waitForSelector('#folderGrid .tile.focus');
    await press('ArrowRight');
    const above = await focused();
    await press('ArrowDown');
    const below = await focused();
    if (!above || !below || below.top <= above.top) problems.push('Home More apps keys: Down did not reach the next line of cards');
    else if (Math.min(above.right, below.right) - Math.max(above.left, below.left) <= 0) {
      problems.push('Home More apps keys: Down went to app ' + below.f + ', not the one under app ' + above.f);
    }
    await press('ArrowUp');
    const back = await focused();
    if (!back || !above || back.f !== above.f) problems.push('Home More apps keys: Up did not return to app ' + (above && above.f));
    for (let i = 0; i < 9; i++) await press('ArrowRight');
    const end = await focused(), first = await page.evaluate(() => document.querySelector('#folderGrid .tile').getBoundingClientRect().top);
    if (!end || end.top !== first) problems.push('Home More apps keys: Right went past the end of the first line');
  } finally {
    await page.close();
  }
}

async function visitHomeOrder(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home order: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  const saves = [];
  let pauseSave = false, pauseCatalogue = false, saveHeld, catalogueHeld;
  const saveReady = new Promise(resolve => { saveHeld = resolve; });
  const catalogueReady = new Promise(resolve => { catalogueHeld = resolve; });
  let wallChoice = 'shuffle';
  const wallSaves = [];
  await page.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    // The server sends a Last opened row in that order: here, YouTube was opened last.
    const order = { app: layout.sort.app === 'recent' ? ['two', 'one', 'lg-home'] : ['one', 'two', 'lg-home'], dev: [], ch: [] };
    const catalogue = { ok: true, apps: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], devices: [], channels: [],
      sources: { channels: 0 }, order, layout };
    const wallpapers = { choice: wallChoice, choices: ['black', 'landscape', 'abstract', 'own', 'shuffle', 'video'], pictures: [], videoUrls: [] };
    let body = { ok: true };
    if (pathname === '/api/home') body = Object.assign({ ok: true, supported: { ok: true }, enabled: true, active: true,
      writable: true, layout, wallpapers, history: true }, new URL(route.request().url()).searchParams.get('with') ? { catalogue, channels: [] } : {});
    else if (pathname === '/api/home/catalogue') body = catalogue;
    else if (pathname === '/api/home/wallpapers') {
      const patch = route.request().postDataJSON();
      wallSaves.push(patch);
      if (patch && patch.choose === 'video') body = { ok: false, error: 'Add at least one video URL first.' };
      else {
        if (patch && patch.choose) wallChoice = patch.choose;
        body = { ok: true, wallpapers: Object.assign({}, wallpapers, { choice: wallChoice }) };
      }
    }
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
    await waitUntil(page, async () => saves.length && saves[0].sort && saves[0].sort.app === 'recent' && await appTiles() === 'Two,One,LG Home');
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
    await page.locator('details.home-row[data-kind="app"] summary').click();
    await page.waitForSelector('#home-sort-app:not(:disabled)');
    if (!await page.locator('details.home-row[data-kind="app"] .home-tile button[aria-label="Later"]').first().isDisabled()) {
      problems.push('Home order: tiles in a Last opened row can be moved on the Home tab');
    }
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await page.locator('#home-sort-app').selectOption('custom');
    await saved;
    if (saves[saves.length - 1].sort.app !== 'custom') problems.push('Home order: the Home tab did not save Your order');

    layout.folder = ['two'];
    layout.hiddenRows = ['ch'];
    await page.goto(base + '/assets/dashboard.html?tab=home');
    for (const name of ['Apps', 'Inputs', 'Channels']) {
      const entry = page.locator('#rows .row').filter({ hasText: new RegExp('^' + name) }).first();
      await entry.click();
      if (name === 'Apps') {
        const peek = await page.locator('#hintPeek span').allTextContents();
        if (peek.join(',') !== 'One,LG Home,More apps' || !(await entry.innerText()).includes('2 of 3 shown')) {
          problems.push('Home order: the TV app preview counted folder apps as individual row tiles');
        }
      }
      if (name === 'Channels' && !(await entry.innerText()).includes('Hidden')) problems.push('Home order: the TV app did not mark a hidden row');
      await page.keyboard.press('Enter');
      const order = page.locator('#rows .row.sel').filter({ hasText: /^Order/ });
      await order.waitFor();
      if (name === 'Apps' && !(await page.locator('#rows .row').filter({ hasText: /^Two/ }).innerText()).includes('In More apps')) {
        problems.push('Home order: a folder app was labelled Shown in the TV app');
      }
      saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
      await page.keyboard.press('Enter');
      await saved;
      await order.filter({ hasText: 'Last opened' }).waitFor();
      const kind = { Apps: 'app', Inputs: 'dev', Channels: 'ch' }[name];
      if (saves[saves.length - 1].sort[kind] !== 'recent') problems.push('Home order: the TV app did not save Order for ' + name);
      await page.keyboard.press('ArrowLeft');
      await page.locator('#rows .row.sel').filter({ hasText: new RegExp('^' + name) }).waitFor();
    }
    // Pictures on "Your own, shuffled" with no video URLs must wrap to Landscape rather than requesting "video" (#1711).
    const picRow = page.locator('#rows .row').filter({ hasText: /^Pictures/ }).first();
    await picRow.click();
    if (!(await picRow.innerText()).includes('Your own, shuffled')) {
      problems.push('Home order: Pictures row did not start on Your own, shuffled');
    }
    saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/wallpapers');
    await page.keyboard.press('Enter');
    await saved;
    if (!wallSaves.length || wallSaves[wallSaves.length - 1].choose !== 'landscape') {
      problems.push('Home order: Pictures cycling from Your own, shuffled did not skip video without URLs: ' + JSON.stringify(wallSaves));
    }
    await picRow.filter({ hasText: 'Landscape' }).waitFor();
  } finally { await page.close(); }
}

// Saves are acknowledged before another edit can replace a whole list.
async function visitHomeEditor(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home editor: ' + e.message));
  let layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: ['a'], appNames: {}, hintSeen: true, searchHintSeen: true };
  const baseApps = [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }];
  const channels = ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), number: id }));
  const saves = [];
  let release = null, refuse = false, pendingRestore = false, portChanged = false;
  await page.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body;
    if (pathname === '/api/home') body = { ok: true, supported: { ok: !portChanged }, installed: true,
      enabled: !pendingRestore, restorePending: pendingRestore, active: true, writable: true, layout, history: true };
    else if (pathname.endsWith('/catalogue')) body = { ok: true,
      apps: baseApps.map(a => layout.appNames[a.id] ? { id: a.id, title: layout.appNames[a.id], defaultTitle: a.title, renamed: true } : a),
      devices: [],
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
        if (patch.appNames) Object.entries(patch.appNames).forEach(([k, v]) => { if (v) layout.appNames[k] = v; else delete layout.appNames[k]; });
        if (typeof patch.showAppLabels === 'boolean') layout.showAppLabels = patch.showAppLabels;
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
    await waitUntil(page, () => add('c').isDisabled());
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
    if (await appRows.first().locator('[translate="no"]').inputValue() !== 'One') problems.push('Home editor: refused move remained visible');
    refuse = false;
    const appName = appRows.first().locator('.home-app-name');
    const renameSave = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await appName.fill('Custom One');
    await appName.press('Enter');
    await renameSave;
    if (JSON.stringify(saves[saves.length - 1]) !== JSON.stringify({ appNames: { one: 'Custom One' } })) {
      problems.push('Home editor: renaming an app did not save appNames: ' + JSON.stringify(saves[saves.length - 1]));
    }
    await page.locator('#home-subnav button[data-home-view="behavior"]').click();
    const labelSave = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/layout');
    await page.locator('#home-show-app-labels').click();
    await labelSave;
    if (JSON.stringify(saves[saves.length - 1]) !== JSON.stringify({ showAppLabels: false })) {
      problems.push('Home editor: toggling App labels did not save showAppLabels');
    }
    pendingRestore = true;
    await page.reload();
    await page.waitForSelector('#home-switch:not(:disabled)');
    // The button is there, and enabled, before the status that names it arrives.
    try { await page.waitForFunction(() => /Retry/.test(document.getElementById('home-switch').textContent)); }
    catch (e) { problems.push('Home editor: failed restoration has no retry action'); }
    pendingRestore = false; portChanged = true;
    await page.reload();
    await page.waitForTimeout(200);
    if (await page.locator('#home-switch').isDisabled()) problems.push('Home editor: changing the port blocked switching Home off');
  } finally { await page.close(); }
}

// The wallpaper picker: a time of day chosen and uploaded to, the upload shown
// pending in another tab, an image dropped on another time of day, then one
// removed and all of them.
async function visitHomeUploads(browser, base, problems) {
  const context = await browser.newContext();
  const page = await context.newPage(), observer = await context.newPage();
  for (const p of [page, observer]) p.on('pageerror', e => problems.push('Home uploads: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  let uploading = false, hold = true, release, image, revision = 0, choice = 'black';
  const has = {};
  const wallpapers = () => ({ available: choice === 'own' && Object.keys(has).some(k => has[k]), uploading, choice,
    choices: ['black', 'landscape', 'abstract', 'own'],
    slots: { morning: !!has.morning, afternoon: !!has.afternoon, evening: !!has.evening, night: !!has.night }, revision: String(revision) });
  await context.route('**/api/home**', async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    let body;
    if (pathname === '/api/home/wallpaper') return route.fulfill({ contentType: 'image/jpeg', body: image });
    if (pathname.endsWith('/upload')) {
      image = route.request().postDataBuffer();
      if (!image || image.readUInt16BE(0) !== 0xffd8 || route.request().headers()['content-type'] !== 'image/jpeg') {
        problems.push('Home uploads: PNG was not prepared as a JPEG');
      }
      uploading = true;
      if (hold) await new Promise(resolve => { release = resolve; });
      uploading = false; has[url.searchParams.get('slot')] = true; revision++;
      body = { ok: true, wallpapers: wallpapers() };
    } else if (pathname === '/api/home/wallpapers') {
      const req = route.request().postDataJSON();
      if (req.removeUploads) Object.keys(has).forEach(k => { has[k] = false; });
      else if (req.remove) has[req.remove] = false;
      else if (req.choose) choice = req.choose;
      revision++;
      body = { ok: true, wallpapers: wallpapers() };
    } else if (pathname === '/api/home') {
      body = { ok: true, supported: { ok: true }, installed: true, enabled: true, writable: true, layout, wallpapers: wallpapers() };
    } else {
      body = { ok: true, layout, apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 } };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const card = (p, slot) => p.locator(`.wall-card[data-slot="${slot}"]`);
  const ready = p => p.waitForSelector('.wall-card[data-slot="morning"] .wall-screen:not(:disabled)');
  try {
    await page.goto(base + '/?tab=home');
    await page.waitForFunction(() => typeof homeStatus !== 'undefined' && homeStatus && homeCat);
    await page.locator('#home-subnav button[data-home-view="appearance"]').click();
    // With None chosen, the pictures' settings are not shown; Pictures shows
    // the sets, without Black, which None is.
    await page.waitForSelector('#home-bg-kind button');
    if (await page.locator('#home-bg-pictures').isVisible()) problems.push('Home uploads: the pictures showed with None chosen');
    await page.locator('#home-bg-kind button', { hasText: 'Pictures' }).click();
    await page.waitForSelector('#home-wall-choice button');
    if (await page.locator('#home-wall-choice button', { hasText: 'Black' }).count()) problems.push('Home uploads: Black was offered among the pictures');
    if (!await card(page, 'morning').locator('.wall-screen').isDisabled()) problems.push('Home uploads: a time of day took uploads with a picture set chosen');
    await page.locator('#home-wall-choice button', { hasText: 'Your own' }).click();
    await ready(page);
    // Choosing Morning opens the file chooser for it.
    const chooser = page.waitForEvent('filechooser');
    await card(page, 'morning').locator('.wall-screen').click();
    const sent = page.waitForRequest(r => r.url().includes('/wallpapers/upload?slot=morning'));
    await (await chooser).setFiles(path.join(ASSETS, 'dashboard-app/assets/icon130.png'));
    await sent;
    await observer.goto(base + '/?tab=home');
    await observer.locator('#home-subnav button[data-home-view="appearance"]').click();
    await card(observer, 'morning').locator('.wall-sending').waitFor();
    if (!await card(observer, 'evening').locator('.wall-screen').isDisabled()) problems.push('Home uploads: another tab did not show the pending upload');
    release();
    await ready(observer);
    await ready(page);
    await page.waitForFunction(() => document.querySelector('.wall-card[data-slot="morning"].has .wall-screen').style.backgroundImage.includes('/api/home/wallpaper'));
    // An image dropped on Evening is Evening's.
    hold = false;
    const dropped = page.waitForRequest(r => r.url().includes('/wallpapers/upload?slot=evening'));
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 36;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'evening.png', { type: 'image/png' }));
      document.querySelector('.wall-card[data-slot="evening"] .wall-screen').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await dropped;
    await page.waitForSelector('.wall-card[data-slot="evening"].has');
    // Remove takes one time of day's picture alone.
    await card(page, 'morning').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForSelector('.wall-card[data-slot="morning"]:not(.has)');
    if (!await card(page, 'evening').evaluate(el => el.classList.contains('has'))) problems.push('Home uploads: removing Morning took Evening\'s picture too');
    await page.locator('#home-wall-clear').click();
    await page.waitForFunction(() => !document.querySelector('.wall-card.has'));
  } finally { await context.close(); }
}

/*
 * Your own pictures, shuffled. On the Home tab: choosing it shows the
 * collection rather than the times of day, three images chosen at once are
 * uploaded one after another, the interval is saved, and Remove takes one
 * picture and Remove all the rest. On the view: a picture shows, and as the
 * minutes pass each of the others comes in turn before any comes again.
 */
async function visitHomeShuffle(browser, base, problems) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => problems.push('Home shuffle: ' + e.message));
  const layout = { rows: ['app'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] },
    channels: [], hintSeen: true, searchHintSeen: true, wallAnim: 'off', wallShuffleMinutes: 10, shuffleMinutes: [1, 5, 10, 15, 30, 60] };
  let choice = 'own', pictures = [], made = 0, image = null;
  const saved = [];
  const wallpapers = () => ({ available: choice === 'shuffle' ? pictures.length > 0 : false, uploading: false, choice,
    choices: ['black', 'landscape', 'abstract', 'own', 'shuffle'], pictures: pictures.slice(), maxPictures: 50,
    slots: { morning: false, afternoon: false, evening: false, night: false }, revision: choice + pictures.length });
  await context.route('**/api/home**', async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    let body;
    if (pathname === '/api/home/wallpaper') return route.fulfill({ contentType: 'image/jpeg', body: image || Buffer.alloc(0) });
    if (pathname.endsWith('/upload')) {
      if (url.searchParams.get('slot') !== 'shuffle') problems.push('Home shuffle: a picture went to a time of day');
      image = route.request().postDataBuffer();
      pictures.push('pic' + String(++made).padStart(6, '0'));
      choice = 'shuffle';
      body = { ok: true, wallpapers: wallpapers() };
    } else if (pathname === '/api/home/wallpapers') {
      const req = route.request().postDataJSON();
      if (req.removePictures) pictures = [];
      else if (req.removePicture) pictures = pictures.filter(id => id !== req.removePicture);
      else if (req.choose) choice = req.choose;
      body = { ok: true, wallpapers: wallpapers() };
    } else if (pathname === '/api/home/layout') {
      const req = route.request().postDataJSON();
      saved.push(req);
      Object.assign(layout, req);
      body = { ok: true, layout, layoutVersion: 1 };
    } else if (pathname === '/api/home') {
      body = { ok: true, supported: { ok: true }, installed: true, enabled: true, writable: true, layout, wallpapers: wallpapers() };
    } else if (pathname.endsWith('/catalogue')) {
      body = { ok: true, layout, layoutVersion: 1, apps: [{ id: 'app', title: 'App' }], devices: [], channels: [], sources: {},
        order: { app: ['app'], dev: [], ch: [] }, wallpapers: wallpapers() };
    } else if (pathname.endsWith('/now')) {
      body = { kind: null };
    } else {
      // The heartbeat carries the wallpapers too, as the server's does.
      body = { ok: true, layout, build: 'shuffle', layoutVersion: 1, wallpapers: wallpapers(), apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 } };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(base + '/?tab=home');
    await page.waitForFunction(() => typeof homeStatus !== 'undefined' && homeStatus && homeCat);
    await page.locator('#home-subnav button[data-home-view="appearance"]').click();
    await page.locator('#home-wall-choice button', { hasText: 'Your own, shuffled' }).click();
    await page.waitForSelector('#home-shuffle-add:not(:disabled)');
    if (await page.locator('#home-walls').isVisible()) problems.push('Home shuffle: the times of day showed with the collection chosen');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#home-shuffle-add').click();
    const icon = path.join(ASSETS, 'dashboard-app/assets/icon130.png');
    await (await chooser).setFiles([icon, icon, icon]);
    await page.waitForFunction(() => document.querySelectorAll('#home-shuffle [data-picture]').length === 3, null, { timeout: 15000 });
    if (made !== 3) problems.push('Home shuffle: three images chosen made ' + made + ' uploads');
    await page.selectOption('#home-shuffle-minutes', '5');
    await page.waitForFunction(() => homeLayout && homeLayout.wallShuffleMinutes === 5);
    if (!saved.some(r => r.wallShuffleMinutes === 5)) problems.push('Home shuffle: the interval was not saved as a number');
    await page.locator('#home-shuffle [data-picture="pic000001"]').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#home-shuffle [data-picture="pic000001"]'));
    if (pictures.length !== 2) problems.push('Home shuffle: Remove took more than one picture');
    await page.locator('#home-wall-clear').click();
    await page.waitForFunction(() => !document.querySelector('#home-shuffle [data-picture]'));
    // On the view, with four pictures and a minute each.
    pictures = ['pica', 'picb', 'picc', 'picd'].map(id => id + '00000');
    layout.wallShuffleMinutes = 1;
    const view = await context.newPage({ viewport: { width: 1920, height: 1080 } });
    view.on('pageerror', e => problems.push('Home shuffle view: ' + e.message));
    await view.clock.install();
    await view.goto(base + '/assets/home.html');
    // The page's own timers run only as the clock is moved on.
    for (let i = 0; i < 40 && !await view.locator('.tile').count(); i++) {
      await view.clock.runFor(500);
      await view.waitForTimeout(50);
    }
    const shown = () => view.evaluate(() => {
      const front = Array.prototype.filter.call(document.querySelectorAll('#wall .layer'), l => +l.style.opacity > 0)[0];
      const m = front && /id=([0-9a-z]+)/.exec(front.style.backgroundImage);
      return m ? m[1] : null;
    });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      if (i) await view.clock.runFor(76000);
      // The next picture shows once it has loaded, which takes real time on a slow machine.
      const before = seen[seen.length - 1] || null;
      let id = null;
      for (let k = 0; k < 100 && (!(id = await shown()) || id === before); k++) {
        await view.clock.runFor(200);
        await view.waitForTimeout(50);
      }
      seen.push(id);
    }
    if (new Set(seen).size !== 4 || seen.some(id => pictures.indexOf(id) === -1)) {
      problems.push('Home shuffle: four minutes did not show each of four pictures once: ' + seen.join(', '));
    }
  } catch (e) {
    problems.push('Home shuffle: ' + e.message);
  } finally { await context.close(); }
}

/*
 * A custom launcher in Glasshouse Home's place. On the Home tab: its button
 * opens the section, a web address with Glasshouse Home on is chosen at once,
 * the Apps and Inputs rows stay to arrange while it is in use without
 * Glasshouse Home's other settings, Use Glasshouse Home swaps back and Use
 * swaps again without a second press, an upload is offered only where
 * installing from a file is, and Remove takes it away. Then, against the real
 * server, an uploaded page is served with window.Glasshouse ready before its
 * own script runs.
 */
async function visitHomeLauncher(browser, base, problems) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => problems.push('Home launcher: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
  let kept = [], chosen = null, launcherUpload = true, enabled = true, barOffered = false, barEnabled = false;
  const sent = [];
  const minimal = { id: 'minimal', kind: 'builtin', title: 'Glasshouse Minimal', source: 'builtin' };
  const status = () => ({ chosen, launchers: [minimal].concat(kept).map(l => Object.assign({}, l, { chosen: l.id === chosen })) });
  await context.route('**/api/home**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body;
    if (pathname === '/api/home/launcher') {
      const req = route.request().postDataJSON();
      sent.push(JSON.stringify(req));
      if (req.address) kept = [{ id: 'own', kind: 'web', title: 'ha.local:8123', address: req.address, source: 'own' }];
      else if (req.remove) { kept = kept.filter(l => l.id !== req.remove); if (chosen === req.remove) chosen = null; }
      else if ('choose' in req) chosen = req.choose || null;
      body = { ok: true, launchers: status() };
    } else if (pathname === '/api/home/enable') {
      sent.push('enable');
      barEnabled = false;
      enabled = true;
      body = { ok: true };
    } else if (pathname === '/api/home/disable') {
      sent.push('disable');
      enabled = false;
      body = { ok: true };
    } else if (pathname === '/api/home/bar') {
      const req = route.request().postDataJSON();
      sent.push('bar:' + Boolean(req.on));
      barEnabled = Boolean(req.on);
      if (barEnabled) enabled = false;
      body = { ok: true };
    } else if (pathname === '/api/home') {
      body = { ok: true, supported: { ok: true }, installed: true, enabled, active: enabled, writable: true, layout,
        bar: barOffered ? { offered: true, enabled: barEnabled, standing: 'supported' } : { offered: false, enabled: false },
        launchers: status(), launcherUpload, wallpapers: { choices: ['black'], choice: 'black', slots: {} } };
    } else {
      body = { ok: true, layout, apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 } };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const keptRow = title => page.locator('#home-launchers .prot-row', { hasText: title });
  const stateNames = re => page.waitForFunction(r => new RegExp(r).test(document.getElementById('home-state-desc').textContent), re.source);
  const marked = async id => /\bon\b/.test(await page.locator('#' + id).getAttribute('class'));
  try {
    await page.goto(base + '/?tab=home');
    await page.waitForFunction(() => {
      const name = document.querySelector('#home-mode-minimal .hm-name');
      return typeof homeStatus !== 'undefined' && homeStatus && name && name.textContent === 'Glasshouse Minimal';
    });
    // Those shown: Glasshouse Bar is offered only where the input bar is.
    const names = await page.locator('#home-mode-btns button:not([hidden]) .hm-name').allTextContents();
    if (names.join() !== 'LG Home,Glasshouse Home,Glasshouse Minimal,Custom') problems.push('Home launcher: the choices read ' + names.join());
    if (await page.locator('#home-launcher').isVisible()) problems.push('Home launcher: Custom\'s settings showed with Glasshouse Home chosen');
    // Custom with none set up opens its settings, and chooses nothing.
    await page.locator('#home-mode-launcher').click();
    await page.locator('#home-launcher').waitFor();
    if (sent.length) problems.push('Home launcher: Custom with none set up sent ' + sent.join());
    await page.locator('#home-launcher-url').fill('http://ha.local:8123/tv');
    await page.locator('#home-launcher-save').click();
    try { await stateNames(/ha\.local:8123/); } catch (e) { problems.push('Home launcher: the state did not name the launcher'); }
    if (sent.join() !== '{"address":"http://ha.local:8123/tv"},{"choose":"own"}') problems.push('Home launcher: a web address with Glasshouse Home on sent ' + sent.join());
    // The apps and inputs it shows stay arranged here; Glasshouse Home's own settings go.
    if (!await page.locator('#home-rows .home-row[data-kind="app"]').isVisible()) problems.push('Home launcher: the Apps row was not offered with a launcher chosen');
    if (await page.locator('#home-rows .home-row[data-kind="ch"]').isVisible()) problems.push('Home launcher: the Channels row showed with a launcher chosen');
    if (await page.locator('#home-tv').isVisible() || await page.locator('#home-looks').isVisible()) problems.push('Home launcher: Glasshouse Home\'s own settings showed with a launcher chosen');
    if (!await marked('home-mode-launcher')) problems.push('Home launcher: Custom was not marked as chosen');
    if (await page.locator('#home-launchers .prot-row', { hasText: 'Minimal' }).count()) problems.push('Home launcher: Minimal was listed among the owner\'s own');
    // Glasshouse Minimal, a choice beside the others; Custom's settings go with Custom.
    sent.length = 0;
    await page.locator('#home-mode-minimal').click();
    await stateNames(/Glasshouse Minimal/);
    if (sent.join() !== '{"choose":"minimal"}') problems.push('Home launcher: Glasshouse Minimal sent ' + sent.join());
    if (!await marked('home-mode-minimal') || await marked('home-mode-launcher')) problems.push('Home launcher: Glasshouse Minimal\'s button was not the one marked as chosen');
    if (await page.locator('#home-launcher').isVisible()) problems.push('Home launcher: Custom\'s settings showed with Glasshouse Minimal chosen');
    if (!await page.locator('#home-rows .home-row[data-kind="app"]').isVisible()) problems.push('Home launcher: the Apps row was not offered with Glasshouse Minimal chosen');
    sent.length = 0;
    await page.locator('#home-switch').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-switch').className));
    if (sent.join() !== '{"choose":false}') problems.push('Home launcher: Glasshouse Home sent ' + sent.join());
    if (await page.locator('#home-launcher').isVisible()) problems.push('Home launcher: Custom\'s settings showed with Glasshouse Home chosen, one set up');
    // Custom with one set up chooses it, as the others are chosen.
    sent.length = 0;
    await page.locator('#home-mode-launcher').click();
    await stateNames(/ha\.local:8123/);
    if (sent.join() !== '{"choose":"own"}') problems.push('Home launcher: Custom with one set up sent ' + sent.join());
    await page.locator('#home-launcher').waitFor();
    // All five launcher choices act on a single click, including from LG Home and Glasshouse Bar.
    barOffered = true;
    await page.evaluate(() => loadHome());
    await page.locator('#home-mode-bar').waitFor({ state: 'visible' });
    sent.length = 0;
    await page.locator('#home-mode-lg').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-mode-lg').className));
    if (sent.join() !== 'disable') problems.push('Home launcher: single-click LG Home sent ' + sent.join());
    sent.length = 0;
    await page.locator('#home-switch').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-switch').className));
    if (sent.join() !== '{"choose":false},enable') problems.push('Home launcher: single-click Glasshouse Home from LG Home sent ' + sent.join());
    sent.length = 0;
    await page.locator('#home-mode-bar').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-mode-bar').className));
    if (sent.join() !== 'bar:true') problems.push('Home launcher: single-click Glasshouse Bar sent ' + sent.join());
    sent.length = 0;
    await page.locator('#home-mode-minimal').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-mode-minimal').className));
    if (sent.join() !== '{"choose":"minimal"},enable') problems.push('Home launcher: single-click Glasshouse Minimal from Bar sent ' + sent.join());
    sent.length = 0;
    await page.locator('#home-mode-lg').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-mode-lg').className));
    if (sent.join() !== 'disable') problems.push('Home launcher: single-click LG Home from Minimal sent ' + sent.join());
    sent.length = 0;
    await page.locator('#home-mode-launcher').click();
    await page.waitForFunction(() => /\bon\b/.test(document.getElementById('home-mode-launcher').className));
    if (sent.join() !== '{"choose":"own"},enable') problems.push('Home launcher: single-click Custom from LG Home sent ' + sent.join());
    launcherUpload = false;
    await page.evaluate(() => loadHome());
    await page.locator('#home-launcher-upload-off').waitFor();
    if (!await page.locator('#home-launcher-pick').isDisabled()) problems.push('Home launcher: an upload was offered where installing from a file is off');
    await keptRow('ha.local').getByRole('button', { name: 'Remove' }).click();
    await page.waitForFunction(() => !document.querySelectorAll('#home-launchers .prot-row').length);
  } finally { await context.close(); }

  const tv = await browser.newContext();
  const view = await tv.newPage();
  view.on('pageerror', e => problems.push('Home launcher page: ' + e.message));
  try {
    await view.goto(base + '/');
    const html = '<!doctype html><html><head><title>wait</title></head><body><script>' +
      'Glasshouse.catalogue(function (e, c) { document.title = e ? "error " + e.message : "apps " + c.apps.length; });' +
      '</script></body></html>';
    const up = await view.evaluate(async h => (await fetch('/api/home/launcher/upload?name=check.html', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: h })).json(), html);
    if (!up.ok) problems.push('Home launcher: the upload was refused: ' + up.error);
    await view.evaluate(async () => fetch('/api/home/launcher', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choose: 'own' }) }));
    await view.goto(base + '/home/launcher/');
    await view.waitForFunction(() => document.title !== 'wait', null, { timeout: 15000 });
    const title = await view.title();
    if (!/^apps [1-9]/.test(title)) problems.push('Home launcher: the uploaded page read ' + title);
    await view.evaluate(async () => fetch('/api/home/launcher', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: 'own' }) }));
  } catch (e) { problems.push('Home launcher page: ' + e.message); }
  finally { await tv.close(); }
}

/*
 * The Home tab: left out where neither Glasshouse Home nor LG's Home's options
 * are offered; with LG's Home's options alone (a B8) it shows only those, Open
 * Home at power-on among them, usable without Glasshouse Home; and
 * with Glasshouse Home on, LG's Home's layout and hidden system apps are
 * left out (lgHomeOptions in lib/routes.js offers no tile hiding then).
 * The banner's picture shows only where the layout offers it (webOS 10).
 */
async function visitHomeAvailability(browser, base, problems) {
  const lgHome = (enabled, banner) => ({ writable: true, glasshouseHome: enabled,
    homeScreen: { parts: [{ id: 'banner', title: 'Banner', desc: 'The banner.', shown: true }], inputs: null, experimental: null, banner: banner || null },
    tileHidingAvailable: !enabled, tileHidingEnabled: false, systemTiles: [], hiddenCount: 0 });
  const cases = [
    { name: 'unavailable', st: { available: false, enabled: false }, glasshouse: false },
    { name: 'LG\'s Home only', st: { available: true, enabled: false, lgHomeAvailable: true, lgHome: lgHome(false), homeAutoLaunch: false }, glasshouse: false },
    { name: 'webOS 10\'s banner', st: { available: true, enabled: false, lgHomeAvailable: true, homeAutoLaunch: false,
      lgHome: lgHome(false, { choice: 'black', own: false, width: 3492, height: 1685 }) }, glasshouse: false, banner: true },
    { name: 'LG Home on supported TV', st: { available: true, enabled: false, lgHomeAvailable: true, lgHome: lgHome(false), homeAutoLaunch: false }, glasshouse: true },
    { name: 'Glasshouse Home on', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true) }, glasshouse: true },
    // Keep restartsApps coverage alongside webOS 6 standalone (keeps preview options) and webOS 4 (hides them).
    { name: 'restartsApps', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true),
      supported: { ok: true, experimental: true, restartsApps: true } }, glasshouse: true },
    { name: 'webOS 6', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true),
      supported: { ok: true, webos: '6.5.3', experimental: true, standalone: true },
      layout: { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true, livePreview: true } }, glasshouse: true, previewOptions: true },
    { name: 'webOS 4', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true),
      supported: { ok: true, webos: '4.4.3', experimental: true, standalone: true, previewOptions: false },
      layout: { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true, livePreview: true } }, glasshouse: true, previewOptions: false }
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
      const restarts = !!(st.supported && st.supported.restartsApps);
      if (c.glasshouse && await page.locator('#home-restart-note').isVisible() !== restarts) {
        fail('the note that a switch closes apps ' + (restarts ? 'missing' : 'shown on a TV it does not apply to'));
      }
      if (c.glasshouse && await page.locator('#home-exp').isVisible() !== !!st.enabled) {
        fail('the experimental note ' + (st.enabled ? 'missing' : 'shown with LG Home selected'));
      }
      if (c.glasshouse && !st.enabled && await page.locator('#home-state-desc').isVisible()) {
        fail('the state description showed with LG Home selected');
      }
      if (c.glasshouse && st.enabled && (c.previewOptions !== undefined || st.homeAutoLaunch !== undefined)) {
        await page.locator('#home-subnav button[data-home-view="behavior"]').click();
      }
      if (c.previewOptions !== undefined) {
        for (const id of ['#home-preview-sound-row', '#home-preview-always-row', '#home-preview-tile-row']) {
          if (await page.locator(id).isVisible() !== c.previewOptions) fail(id + ' ' + (c.previewOptions ? 'missing' : 'shown'));
        }
      }
      if (await page.locator('#disc-system-tiles').isVisible() === !!st.enabled) fail('system apps ' + (st.enabled ? 'shown with Glasshouse Home on' : 'missing'));
      if (st.homeAutoLaunch !== undefined && (!await page.locator('#home-autolaunch').isVisible() || await page.locator('#home-autolaunch').isDisabled()))
        fail('Open Home at power-on missing or unusable');
      if (!c.glasshouse && await page.locator('#home-picture-row').isVisible()) fail('Glasshouse Home\'s options shown without it');
      if (await page.locator('#disc-homescreen').isVisible() === st.enabled) fail('LG\'s Home layout ' + (st.enabled ? 'shown with Glasshouse Home on' : 'missing'));
      if (!st.enabled) {
        await page.locator('#disc-homescreen summary').click();
        if (await page.locator('#apps-home-banner').isVisible() !== !!c.banner) fail('banner picture ' + (c.banner ? 'missing' : 'shown where it cannot be changed'));
      }
      if (c.banner) {
        const pressed = await page.locator('#apps-home-banner-choice button[aria-pressed="true"]').allTextContents();
        if (pressed.join() !== 'Black') fail('banner picture chosen: ' + pressed.join());
        if (await page.locator('#btn-home-banner-own').textContent() !== 'Your own…') fail('Your own does not ask for an upload before one is made');
        if (await page.locator('#btn-home-banner-replace').count()) fail('Upload another offered with nothing uploaded');
      }
    } finally { await page.close(); }
  }
}

async function visitAudioOverride(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Web audio: ' + e.message));
  try {
    const state = await page.request.get(base + '/api/audio?with=settings').then(r => r.json());
    state.live.hdmi = { channels: 6, channelAllocation: 11, sampleRate: null };
    state.override = Object.assign({}, state.override, { available: true, verified: true, installed: true,
      enabled: false, running: true, canDisable: true, offered: true });
    const writes = [];
    let failed = false, holdRead = false, readHeld, releaseRead;
    await page.route('**/api/audio*', route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        writes.push(body);
        state.override.enabled = state.override.running = state.override.canDisable = body.enabled;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: state }) });
      }
      if (failed) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Audio service unavailable' }) });
      if (holdRead) {
        holdRead = false;
        const snapshot = JSON.stringify(state);
        releaseRead = () => route.fulfill({ contentType: 'application/json', body: snapshot });
        readHeld();
        return;
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) });
    });
    // A TV with no forwarding helper has no forwarding section.
    const offered = state.override;
    state.override = { ...offered, offered: false };
    await page.goto(base + '/?tab=audio');
    await page.waitForFunction(() => audioState);
    if (!await page.locator('#audio-forwarding').evaluate(el => el.hidden)) problems.push('Web audio: a TV with no forwarding helper shows the override');
    state.override = offered;
    await page.goto(base + '/?tab=audio');
    await page.waitForFunction(() => audioState && audioState.override.running);
    if (!await page.locator('#audio-settings [data-lgs]').count()) problems.push('Audio tab: LG sound settings missing');
    if (!/HDMI channel information[\s\S]*6 channels/.test(await page.locator('#audio-path').textContent()))
      problems.push('Web audio: source channel metadata missing');
    // The readings, refresh button and override are folded below the settings.
    await page.locator('#audio-more > summary').click();
    await page.locator('#audio-override').click();
    await page.waitForFunction(() => !audioChanging);
    if (JSON.stringify(writes) !== '[{"enabled":false}]')
      problems.push('Audio override: a running helper without its startup marker did not offer immediate disable');
    await page.waitForFunction(() => !document.querySelector('#audio-refresh').disabled);
    const pendingRead = new Promise(resolve => { readHeld = resolve; });
    holdRead = true;
    const pendingLoad = page.evaluate(() => loadAudio(true));
    await pendingRead;
    await page.locator('#audio-override').click();
    if (writes.length !== 1) problems.push('Web audio: enabled without a second press');
    await page.locator('#audio-override').click();
    await page.waitForFunction(() => audioState.override.enabled && !audioChanging);
    await releaseRead();
    await pendingLoad;
    await page.waitForFunction(() => !document.querySelector('#audio-refresh').disabled);
    if (await page.locator('#audio-override').getAttribute('aria-pressed') !== 'true')
      problems.push('Web audio: a late read replaced a completed override change');
    failed = true;
    await page.locator('#audio-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#audio-error').hidden);
    if (!await page.locator('#audio-override').isDisabled() || await page.locator('#audio-readings').isVisible() ||
        await page.locator('#audio-settings :enabled').count()) problems.push('Web audio: a failed read left stale controls usable');
    failed = false;
    await page.locator('#audio-refresh').click();
    await page.waitForFunction(() => document.querySelector('#audio-error').hidden);
    if (!await page.locator('#audio-readings').isVisible() || await page.locator('#audio-override').isDisabled())
      problems.push('Web audio: controls did not recover after a failed read');
  } catch (e) { problems.push('Web audio: ' + e.message); }
  await page.close();
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
          channels: [], hintSeen: true, searchHintSeen: true } }) });
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

// The key that ends the screen saver reaches Home before its heartbeat hears
// the screen saver has gone: it only wakes the screen. Back then opened Recents.
async function visitHomeSaverWake(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home saver wake: ' + e.message));
  let saver = true, beats = 0;
  const reply = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/home/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/home/catalogue') return reply(route, {
      ok: true, apps: [], devices: [], channels: [], sources: {}, order: { app: ['lg-home'], dev: [], ch: [] },
      layout: { rows: ['app', 'dev', 'ch'], hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true }
    });
    if (pathname === '/api/home/beat') { beats++; return reply(route, { ok: true, covered: saver, saver, build: 'one' }); }
    if (pathname === '/api/home/recents') return reply(route, { ok: true, apps: [] });
    return reply(route, { ok: true, kind: null, build: 'one' });
  });
  const back = () => page.evaluate(() => {
    for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: 461 }));
  });
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('#rows .tile');
    await page.waitForFunction(() => document.documentElement.classList.contains('resting'));
    saver = false;
    const heard = beats;
    await back();
    await waitUntil(page, () => beats > heard, 300);
    if (beats === heard) problems.push('Home saver wake: the waking key did not ask at once whether the screen saver had gone');
    await page.waitForFunction(() => !document.documentElement.classList.contains('resting'));
    if (await page.locator('#stage.recents').count()) problems.push('Home saver wake: Back ending the screen saver opened Recents');
    await back();
    try { await page.waitForSelector('#stage.recents', { timeout: 5000 }); }
    catch (e) { problems.push('Home saver wake: Back after the screen saver did not open Recents'); }
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
      layout: { rows: ['app', 'dev', 'ch'], hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true }
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

// Search requests and launches through the real view, including delayed replies.
async function visitHomeSearch(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home search: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], hidden: { app: [], dev: [], ch: [] }, channels: [],
    hintSeen: true, searchHintSeen: true, search: true };
  let pending, releaseOpen, searches = 0, launches = 0, sleeps = 0;
  await page.route('**/api/home/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/home/search') { searches++; pending = route; return; }
    if (pathname === '/api/home/search/open') { launches++; releaseOpen = () => route.fulfill({ json: { ok: true } }); return; }
    const body = pathname === '/api/home/catalogue'
      ? { ok: true, layout, apps: [], devices: [], channels: [], sources: { channels: 0 },
          order: { app: ['lg-home'], dev: [], ch: [] } }
      : { ok: true, build: 'one', sleeps };
    await route.fulfill({ json: body });
  });
  const result = title => ({ ok: true, elsewhere: 0,
    results: [{ id: title, title, kind: 'film', apps: [{ id: 'amazon', title: 'Prime Video' }] }] });
  const enterSearch = async () => {
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#stage.typing');
  };
  const query = async text => {
    pending = null;
    const sent = page.waitForRequest(r => new URL(r.url()).pathname === '/api/home/search');
    await page.locator('#query').fill(text);
    await sent;
    const deadline = Date.now() + 3000;
    while (!pending && Date.now() < deadline) await page.waitForTimeout(10);
    if (!pending) throw new Error('Home search: the request did not reach its handler');
  };
  const answer = async body => {
    const received = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/search');
    await pending.fulfill({ json: body });
    await received;
  };
  const back = () => page.evaluate(() => {
    for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: 461, bubbles: true }));
  });
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.tile');
    await enterSearch();
    await query('dune');
    await answer(result('Dune'));
    await page.waitForSelector('.hit');
    pending = null;
    await page.locator('#query').fill('alien');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    if (launches) throw new Error('Home search: a previous title opened during the typing delay');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Looking for'));
    if (!pending) throw new Error('Home search: the changed query was not sent');
    if (await page.locator('.hit').count()) problems.push('Home search: previous titles remain selectable during a newer query');
    await answer(result('Alien'));
    await page.waitForSelector('.hit.on');
    if (await page.locator('.hit.on .ttl').textContent() !== 'Alien') problems.push('Home search: Enter did not focus the awaited results');
    await page.keyboard.press('ArrowUp');
    await query('retry');
    await answer({ ok: false });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('did not answer'));
    pending = null;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    if (searches !== 4 || !pending) throw new Error('Home search: Enter did not retry the failed query');
    await answer(result('Retry'));
    await page.waitForSelector('.hit.on');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    if (launches !== 1) problems.push('Home search: repeated OK sent duplicate launches during detail lookup');
    await releaseOpen();
    await page.waitForTimeout(100);
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await page.waitForSelector('#stage.finding');
    if (await page.locator('#query').inputValue() !== 'retry') problems.push('Home search: return from a launched app lost the query');
    sleeps++;
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await page.waitForSelector('#stage:not(.finding)');
    await enterSearch();
    await query('late');
    await back();
    await answer(result('Late'));
    if (await page.locator('.hit').count()) problems.push('Home search: a late response repopulated a closed panel');
    layout.search = false;
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await page.waitForSelector('#stage.no-search');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    if (await page.locator('#stage.finding').count()) problems.push('Home search: the disabled rail opened the panel');
  } finally { await page.close(); }
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
  const posts = [];
  state.live.hdmi = { channels: 6, channelAllocation: 11, sampleRate: null };
  let failed = false;
  await page.route('**/api/audio*', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posts.push(body);
      state.override.enabled = state.override.running = body.enabled;
      state.override.canDisable = body.enabled;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: state }) });
    }
    return route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(failed ? { ok: false, error: 'Audio service unavailable' } : state) });
  });
  const selected = () => page.locator('#rows .row.sel .lbl').textContent();
  const forwarding = () => page.locator('#rows .row').filter({ has: page.locator('.bdg') });
  const forwardingSays = word => page.waitForFunction(w => document.querySelector('.bdg').parentNode.parentNode.textContent.indexOf(w) !== -1, word);
  async function open() {
    await page.goto(base + '/assets/dashboard.html?tab=audio');
    await page.waitForSelector(failed ? '#rows .row:has-text("Audio readings unavailable")' : state.override.offered ? '#rows .bdg' : '#rows .row');
  }
  try {
    await open();
    if (await selected() !== 'Sound output') problems.push('TV audio: did not open on the Sound settings');
    if (!await page.locator('#rows .row').filter({ hasText: 'HDMI channel information' }).filter({ hasText: '6 channels' }).count())
      problems.push('TV audio: source channel metadata missing');
    if (await forwarding().count() || await page.locator('#rows .row').filter({ hasText: 'DTS forwarding' }).count())
      problems.push('TV audio: a TV with no forwarding helper shows the override');
    // Installed but not verified: shown, and refused.
    state.override = { ...state.override, offered: true };
    await open();
    await forwarding().click();
    await page.keyboard.press('Enter');
    if (posts.length) problems.push('TV audio: unsupported helper offered an override');
    if (!/Experimental/.test(await forwarding().textContent())) problems.push('TV audio: missing experimental label');
    state.override = { ...state.override, available: true, verified: true, enabled: false, running: false, canDisable: false };
    await open();
    await forwarding().click();
    await page.keyboard.press('Enter');
    if (posts.length) problems.push('TV audio: enabled without a second OK');
    await page.keyboard.press('Enter');
    await forwardingSays('On');
    await page.keyboard.press('Enter');
    await forwardingSays('Off');
    if (JSON.stringify(posts) !== '[{"enabled":true},{"enabled":false}]') problems.push('TV audio: wrong enable/disable actions');
    state.override.running = state.override.canDisable = true;
    await open();
    await forwarding().click(); await page.keyboard.press('Enter');
    await forwardingSays('Off');
    if (posts.length !== 3 || posts[2].enabled !== false) problems.push('TV audio: running helper without marker could not be stopped');
    state.writable = false;
    await open();
    if (await forwarding().evaluate(el => el.classList.contains('doable'))) problems.push('TV audio: read-only override was actionable');
    failed = true;
    await open();
    if (await forwarding().count()) problems.push('TV audio: a failed read left the override on screen');
    failed = false;
    await page.keyboard.press('Enter');
    await page.waitForSelector('#rows .bdg');
    await page.goto(base + '/assets/dashboard.html?tab=options');
    await page.waitForSelector('#rows .row');
    if (await page.locator('#rows .row').filter({ hasText: /Audio capabilities|Sound output/ }).count()) problems.push('TV audio: sound still listed under System');
  } finally { await page.close(); }
}
// A TV that offers no picture settings has no Picture tab in either dashboard.
async function visitPictureUnavailable(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Picture unavailable: ' + e.message));
  await page.route('**/api/picture', route => route.fulfill({ json: { ok: true, available: false, writable: true, rows: [] } }));
  try {
    await page.goto(base + '/?tab=picture');
    await page.waitForFunction(() => typeof activeTab === 'string' && activeTab !== 'picture', null, { timeout: 5000 })
      .catch(() => problems.push('Picture unavailable: the web dashboard stayed on the tab'));
    if (await page.locator('#tab-btn-picture').isVisible()) problems.push('Picture unavailable: the web dashboard shows the tab');
    await page.goto(base + '/assets/dashboard.html');
    await page.waitForTimeout(800);
    const tabs = await page.evaluate(() => TABS.map(x => x.key));
    if (tabs.indexOf('picture') !== -1) problems.push('Picture unavailable: the TV app shows the tab');
  } finally { await page.close(); }
}

async function visitTvPictureWrites(browser, base, problems) {
  for (const outcome of ['accepted', 'refused', 'disconnected']) {
    const page = await browser.newPage();
    const writes = [];
    let releaseFirst, firstSeen, secondSeen;
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstSeen = resolve; });
    const secondStarted = new Promise(resolve => { secondSeen = resolve; });
    page.on('pageerror', e => problems.push('TV picture: ' + e.message));
    await page.route('**/api/picture', route => route.fulfill({ json: { ok: true, writable: true, rows: [
      { id: 'backlight', title: 'Panel brightness', section: 'picture', group: 'brightness', type: 'number', value: 95, min: 0, max: 100 },
      { id: 'contrast', title: 'Contrast', section: 'picture', group: 'brightness', type: 'number', value: 85, min: 0, max: 100 }
    ] } }));
    await page.route('**/api/control', async route => {
      writes.push(route.request().postDataJSON().value);
      if (writes.length === 2) secondSeen();
      if (writes.length === 1) {
        firstSeen();
        await held;
        if (outcome === 'disconnected') return route.abort();
        if (outcome === 'refused') return route.fulfill({ json: { ok: false, error: 'Setting locked' } });
      }
      await route.fulfill({ json: { ok: true } });
    });
    try {
      await page.goto(base + '/assets/dashboard.html?tab=picture');
      await page.waitForSelector('#rows .row.sel:has-text("Panel brightness")');
      for (const key of ['Enter', 'ArrowLeft', 'Enter', 'ArrowDown', 'Enter', 'ArrowLeft', 'Enter']) {
        await page.keyboard.press(key);
      }
      await started;
      const second = page.waitForRequest(request => request.url().endsWith('/api/control') &&
        request.postDataJSON().value.id === 'contrast', { timeout: 2000 });
      releaseFirst();
      await second;
      await secondStarted;
      if (JSON.stringify(writes) !== JSON.stringify([{ id: 'backlight', value: 94 }, { id: 'contrast', value: 84 }])) {
        problems.push('TV picture: incorrect slider writes after ' + outcome + ' response: ' + JSON.stringify(writes));
      }
    } catch (e) {
      problems.push('TV picture: pending slider lost after ' + outcome + ' response: ' + e.message);
    } finally {
      releaseFirst();
      await page.close();
    }
  }
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

/*
 * Internet TV on Glasshouse Home, its API answered here: the row with names
 * tidied, a stream previewed after its dwell with the lease taken, the
 * preview grown into the player without opening the stream again, the
 * channel list and a channel change releasing the last stream before the
 * next, Back to Home, the guide, and the add panel while arranging. Desktop
 * Chrome cannot play the webOS streams, so the media element is stubbed.
 */
async function visitHomeInternetTv(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const fail = m => problems.push('Home Internet TV: ' + m);
  page.on('pageerror', e => fail(e.message));
  // What happened, in order: the page's releases and plays, and the stream requests answered here.
  const trace = [];
  await page.exposeFunction('traceTv', e => trace.push(e));
  await page.addInitScript(() => {
    window.played = [];
    window.released = 0;
    HTMLMediaElement.prototype.load = function () { if (!this.getAttribute('src')) { window.released++; window.traceTv('release'); } };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.play = function () { window.played.push(this.getAttribute('src')); window.traceTv('play ' + this.getAttribute('src')); return Promise.resolve(); };
    // Chrome fails the made-up stream URLs, and Home would rightly retry once;
    // the stalls and retries are not what this checks.
    Object.defineProperty(HTMLMediaElement.prototype, 'onerror', { set: function () {}, get: function () { return null; } });
  });
  const tv = [
    { id: 'p1:x1', pl: 'p1', key: 'x1', name: 'VIP: BBC NEWS \u1d34\u1d30', group: 'UK| NEWS \u1d34\u1d30', number: '1' },
    { id: 'p1:x2', pl: 'p1', key: 'x2', name: 'VIP: BBC WORLD NEWS \u1d34\u1d30', group: 'UK| NEWS \u1d34\u1d30', number: '2' }
  ];
  const now = Date.now(), half = 30 * 60000, at = Math.floor(now / half) * half;
  const leases = [], streams = [], outputs = {};
  let refuseOutput = false, holdOutput = false, finishOutput = null;
  let favourites = true, previewInTile = false;
  await page.route('**/api/home/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/catalogue')) return reply({ ok: true, layoutVersion: 1,
      layout: { rows: ['iptv', 'app'], order: { app: [], dev: [], ch: [], iptv: [] }, sort: {}, hidden: { app: [], dev: [], ch: [], iptv: [] },
        channels: [], hintSeen: true, searchHintSeen: true, livePreview: true, previewInTile, picture: true },
      apps: [], devices: [], channels: [], iptv: favourites ? tv : [], iptvStatus: { count: favourites ? 2 : 0, lineup: 2, lineupRevision: 1, label: 'Home IPTV' },
      sources: { channels: 0, iptv: true }, order: { app: ['lg-home'], dev: [], ch: [], iptv: favourites ? ['p1:x1', 'p1:x2'] : [] } });
    if (url.pathname.endsWith('/now')) return reply({ kind: null });
    return reply({ ok: true, build: 'tv', layoutVersion: 1 });
  });
  await page.route('**/api/iptv/**', route => {
    const url = new URL(route.request().url());
    const reply = body => route.fulfill({ json: body });
    const req = route.request();
    if (url.pathname.endsWith('/lineup')) return reply({ ok: true, revision: 1, channels: tv,
      sections: [{ id: 'news', kind: 'pick', name: 'News' }], favourites: favourites ? tv.map(c => c.id) : [] });
    if (url.pathname.endsWith('/guide')) return reply({ ok: true, guide: { 'p1:x1': [{ start: at, end: at + half * 2, title: 'The World This Weekend' }] } });
    if (url.pathname.endsWith('/stream')) {
      const key = url.searchParams.get('key'), ts = outputs[key] === 'ts';
      streams.push(key); trace.push('request ' + key);
      return reply({ ok: true, url: 'http://s.test/' + key + (ts ? '.ts' : '.m3u8'), format: ts ? 'ts' : 'hls', switchable: true });
    }
    if (url.pathname.endsWith('/output')) {
      const body = req.postDataJSON();
      if (refuseOutput) return reply({ ok: false, error: 'save' });
      outputs[body.key] = body.output;
      if (holdOutput) { finishOutput = () => reply({ ok: true }); return; }
      return reply({ ok: true });
    }
    if (url.pathname.endsWith('/lease')) { leases.push(JSON.parse(req.postData() || '{}')); return reply({ ok: true }); }
    if (url.pathname.endsWith('/schedule')) {
      // Filed by the UTC day each programme starts, as the worker writes them.
      const d = new Date(at), day = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
      if (url.searchParams.get('key') !== 'x1' || url.searchParams.get('day') !== day) return route.fulfill({ status: 404, json: { ok: false } });
      return reply([[at, at + half * 2, 'The World This Weekend', 'Reaction']]);
    }
    if (url.pathname.endsWith('/playlists')) return reply({ ok: true, playlists: [{ id: 'p1', label: 'Home IPTV', ready: true, channels: 2 }] });
    if (url.pathname.endsWith('/groups')) return reply({ ok: true, groups: [{ name: 'UK| NEWS', count: 2 }], total: 1, channels: 2 });
    return reply({ ok: true });
  });
  const keys = codes => page.evaluate(list => {
    for (const code of list) for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { keyCode: code, bubbles: true }));
  }, codes);
  const key = code => keys([code]);
  // Back closes the band if it is up, then the player: the band shows itself on each channel change.
  const leavePlayer = async () => {
    if (/band/.test(await page.locator('#player').getAttribute('class'))) await key(461);
    await key(461);
  };
  const playing = () => page.locator('#pvVideo').dispatchEvent('playing');
  const fillsTile = () => page.evaluate(() => {
    const tile = document.querySelector('.row.active .tile.focus'), pv = document.getElementById('preview');
    if (!tile || !pv) return false;
    const a = tile.getBoundingClientRect(), b = pv.getBoundingClientRect();
    return ['left', 'top', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 2);
  });
  try {
    await page.goto(base + '/assets/home.html');
    await page.waitForSelector('.row[data-key="iptv"] .tile');
    const names = await page.locator('.row[data-key="iptv"] .tile .nm').allTextContents();
    if (names[0] !== 'BBC News' || names[2] !== 'IPTV Guide') fail('row names ' + JSON.stringify(names));
    await page.waitForFunction(() => window.played.includes('http://s.test/x1.m3u8'));
    if (streams[0] !== 'x1' || !(await page.evaluate(() => window.played)).includes('http://s.test/x1.m3u8')) fail('the focused channel was not previewed');
    if (!await waitUntil(page, () => leases.some(l => l.on === true && l.full === false))) fail('no lease while previewing');
    await playing();
    await key(13);
    await page.waitForSelector('#preview.full');
    if (!/full/.test(await page.locator('#preview').getAttribute('class'))) fail('OK did not grow the preview to the player');
    if (streams.length !== 1) fail('the preview grown to the player opened the stream again');
    if (!await waitUntil(page, () => leases.some(l => l.full === true))) fail('the player did not say it is full screen');
    await page.waitForFunction(() => document.getElementById('bdFmt').textContent.includes('Yellow: play as MPEG-TS'));
    await key(405);
    await page.waitForFunction(() => /x1\.ts/.test(document.getElementById('pvVideo').getAttribute('src')));
    await playing();
    if (!(await page.locator('#bdFmt').textContent()).includes('Yellow: play as HLS')) fail('Yellow did not switch the adopted preview to MPEG-TS');

    refuseOutput = true;
    const beforeRefused = streams.length;
    await key(405);
    await page.waitForFunction(() => document.getElementById('pmsg').textContent.includes('That didn’t save'));
    if (streams.length !== beforeRefused) fail('a refused format save silently reopened the old stream');
    await key(13);
    await page.waitForFunction(() => /x1\.ts/.test(document.getElementById('pvVideo').getAttribute('src')));
    await playing();
    refuseOutput = false;

    holdOutput = true;
    const pendingOutput = page.waitForRequest(r => new URL(r.url()).pathname === '/api/iptv/output');
    await key(405);
    await pendingOutput;
    await leavePlayer();
    await page.waitForFunction(() => !!document.getElementById('pvVideo').getAttribute('src'));
    await playing();
    await key(13);
    const beforeLate = streams.length;
    const lateOutput = page.waitForResponse(r => new URL(r.url()).pathname === '/api/iptv/output');
    await finishOutput();
    await lateOutput;
    // A reply from the previous player must not reopen the newly adopted stream.
    await page.waitForTimeout(100);
    if (streams.length !== beforeLate) fail('a late format save reopened a player that had been left');
    holdOutput = false;

    // OK shows and hides the band, whichever it was.
    const bandUp = async () => /band/.test(await page.locator('#player').getAttribute('class'));
    const wasUp = await bandUp();
    await key(13);
    await page.waitForSelector(wasUp ? '#player:not(.band)' : '#player.band');
    if (/list/.test(await page.locator('#player').getAttribute('class'))) fail('OK in the player opened the channel list, not the band');
    await key(13);
    await page.waitForSelector(wasUp ? '#player.band' : '#player:not(.band)');
    if (await bandUp()) await key(13);
    await page.waitForSelector('#player:not(.band)');
    await key(37);
    await page.waitForSelector('#player.list');
    if (/band/.test(await page.locator('#player').getAttribute('class'))) fail('the band came up with the channel list');
    await key(39);
    await page.waitForSelector('#player:not(.list)');
    await key(37);
    await page.waitForSelector('#player.list');
    const releasedBefore = await page.evaluate(() => window.released);
    await key(40);
    await key(13);
    await page.waitForFunction(() => window.played.includes('http://s.test/x2.m3u8'));
    if (streams[streams.length - 1] !== 'x2') fail('choosing a channel in the list did not play it');
    if (await page.evaluate(() => window.released) <= releasedBefore) fail('the last stream was not released before the next');
    const asked = trace.lastIndexOf('request x2'), playedNext = trace.lastIndexOf('play http://s.test/x2.m3u8');
    const releasedAt = trace.slice(0, asked).lastIndexOf('release'), lastOld = trace.slice(0, asked).lastIndexOf('play http://s.test/x1.m3u8');
    if (!(releasedAt > lastOld && asked > releasedAt && playedNext > asked)) fail('the channel change did not release, then ask, then play: ' + trace.slice(-6).join(', '));
    await page.waitForSelector('#player.band');
    await key(461);
    await page.waitForSelector('#player:not(.band)');
    if (!/playing/.test(await page.locator('#stage').getAttribute('class'))) fail('Back with the band up left the player');
    await key(461);
    await page.waitForTimeout(300);
    if (/playing/.test(await page.locator('#stage').getAttribute('class'))) fail('Back did not close the player');
    // OK before the preview's dwell is over: one stream, full screen, and the preview's timer gone with it.
    await key(37);
    await page.waitForFunction(() => document.getElementById('pvVideo').getAttribute('src') === 'http://s.test/x1.m3u8');
    const before = streams.length;
    // One event turn keeps OK before the dwell even when the runner is busy.
    await keys([39, 13]);
    await page.waitForFunction(() => document.getElementById('pvVideo').getAttribute('src') === 'http://s.test/x2.m3u8');
    // No second request may arrive from the preview timer after the player opens.
    await page.waitForTimeout(1500);
    if (streams.length !== before + 1) fail('OK during the preview\'s dwell opened ' + (streams.length - before) + ' streams');
    if (!/full/.test(await page.locator('#preview').getAttribute('class'))) fail('a late preview timer took the player\'s picture back');
    await leavePlayer();
    await page.waitForTimeout(300);
    await key(457);
    await page.waitForSelector('#guide .gc b');
    if (await page.locator('#guide .gc b').first().textContent() !== 'The World This Weekend') fail('the guide did not show the schedule');
    const guideRow = () => page.locator('#gBody .gr.focus').getAttribute('data-g');
    await key(34);
    await waitUntil(page, async () => await guideRow() === '1');
    if (await guideRow() !== '1') fail('Channel down did not turn the guide a page, to its last channel');
    await key(33);
    await waitUntil(page, async () => await guideRow() === '0');
    if (await guideRow() !== '0') fail('Channel up did not turn the guide back a page');
    // A channel picked in the guide: Back goes back to the guide, on it.
    await key(40);
    await waitUntil(page, async () => await guideRow() === '1');
    const picked = streams.length;
    await key(13);
    await waitUntil(page, () => streams.length > picked);
    if (streams[streams.length - 1] !== 'x2') fail('OK in the guide did not play the channel');
    await leavePlayer();
    try { await page.waitForSelector('#stage.guiding #gBody .gr.focus', { timeout: 3000 }); }
    catch (e) { fail('Back from a channel picked in the guide did not go back to the guide'); }
    if (await guideRow() !== '1') fail('Back to the guide was not on the channel picked there');
    await key(461);
    await page.waitForTimeout(200);
    if (/guiding/.test(await page.locator('#stage').getAttribute('class'))) fail('Back did not close the guide');
    await key(37); await key(37); await key(37);
    const down = () => page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true })));
    await down();
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 13, bubbles: true })));
    for (let i = 0; i < 4; i++) await key(39);
    await key(13);
    await waitUntil(page, async () => /adding/.test(await page.locator('#stage').getAttribute('class')));
    if (!/adding/.test(await page.locator('#stage').getAttribute('class'))) fail('the Add channels tile did not open the panel');
    // The panel opens before its list of the playlist's groups is read.
    else if (!await waitUntil(page, async () => /UK News/.test(await page.locator('#adItems').textContent()))) fail('the add panel did not list the playlist\'s groups');
    previewInTile = true;
    await page.goto(base + '/assets/home.html');
    await page.waitForFunction(() => !!document.getElementById('pvVideo').getAttribute('src'));
    await playing();
    if (!await fillsTile()) fail('Preview in the tile left the IPTV preview beside the clock');
    const beforeTile = streams.length;
    await key(13);
    await page.waitForTimeout(400);
    const full = await page.locator('#preview').boundingBox();
    if (!full || full.width < 1900 || full.height < 1060) fail('the tile preview did not fill the screen');
    if (streams.length !== beforeTile) fail('opening the tile preview reopened its stream');
    await leavePlayer();
    await waitUntil(page, fillsTile);
    if (!await fillsTile()) fail('Back did not return the stream to its tile');
    if (streams.length !== beforeTile) fail('returning to the tile reopened its stream');
    await key(457);
    await page.waitForSelector('#stage.guiding .gr');
    await page.waitForTimeout(900);
    await playing();
    if (await page.locator('#srcTitle').evaluate(el => el.clientWidth) < 500) fail('the guide reserved space for hidden picture details');
    if (await page.locator('.tile #preview').count() || !await page.locator('#now #preview').isVisible()) fail('the guide left its preview in a hidden tile');
    favourites = false;
    const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/iptv/lineup');
    await page.goto(base + '/assets/home.html');
    await loaded;
    await page.waitForSelector('.row[data-key="iptv"] .tile');
    if (await page.locator('.row[data-key="iptv"] .tile .nm').first().textContent() !== 'IPTV Guide') fail('a lineup without favourites has no IPTV Guide tile');
    await key(13);
    await page.waitForSelector('#stage.guiding .gr');
    await key(13);
    await page.waitForSelector('#stage.playing');
    if (!(await page.locator('#bdNow').textContent()).includes('The World This Weekend')) fail('an unstarred channel has no now-and-next band');
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await page.waitForTimeout(300);
    if (/playing/.test(await page.locator('#stage').getAttribute('class'))) fail('pressing Home did not close the player');
  } finally {
    await page.close();
  }
}

/*
 * The channel manager, on the browser dashboard and in the TV app, against a
 * made-up provider and lineup: a group added whole, a star, a selection added
 * and taken out in one edit each, the page closed with Escape, one pane at a
 * time on a phone, and the TV app's lists from the
 * remote. Each edit is the POST the server would get.
 */
async function visitIptvChannels(browser, base, problems) {
  const fail = m => problems.push('Internet TV channels: ' + m);
  const posts = [];
  const channels = [
    { id: 'p1:x1', pl: 'p1', key: 'x1', sid: 's00000001', number: '101', name: 'Harbour News', group: 'UK | News' },
    { id: 'p1:x2', pl: 'p1', key: 'x2', sid: 's00000001', number: '102', name: 'World Today', group: 'UK | News' }
  ];
  const lineup = () => ({ ok: true, revision: posts.length, max: 2000, maxFavourites: 60, cut: false,
    sections: [{ id: 's00000001', kind: 'group', pl: 'p1', group: 'UK | News', name: '', from: 101, start: 101, end: 102, count: 2, state: 'ready', except: 0, playlist: 'Harbour TV' }],
    channels: channels.map(c => Object.assign({}, c, { fav: posts.some(p => p.action === 'star' && p.id === c.id) })),
    favourites: posts.filter(p => p.action === 'star').map(p => p.id) });
  const route = async page => page.route('**/api/iptv/**', r => {
    const url = new URL(r.request().url());
    const reply = body => r.fulfill({ json: body });
    if (r.request().method() === 'POST') {
      const body = JSON.parse(r.request().postData() || '{}');
      posts.push(body);
      return reply({ ok: true, section: body.action === 'add-group' ? 's00000002' : null });
    }
    if (url.pathname.endsWith('/playlists')) return reply({ ok: true, writable: true, playlists: [{ id: 'p1', label: 'Harbour TV', ready: true, channels: 20000, groups: 3 }] });
    if (url.pathname.endsWith('/groups')) return reply({ ok: true, total: 3, channels: 20000,
      groups: [{ name: 'UK | News', count: 2, section: 's00000001', inLineup: 2 }, { name: 'UK | Sport', count: 2 }, { name: 'DE | Sport', count: 9, hidden: true }] });
    if (url.pathname.endsWith('/lineup')) return reply(lineup());
    if (url.pathname.endsWith('/browse')) return reply({ ok: true, total: 2, page: 0, channels: [
      { key: 'x7', name: 'Harbour Sport 1', group: 'UK | Sport', pl: 'p1' }, { key: 'x8', name: 'Harbour Sport 2', group: 'UK | Sport', pl: 'p1' }] });
    return reply({ ok: true });
  });
  let page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => fail(e.message));
  try {
    await route(page);
    await page.goto(base + '/?tab=home&tv=channels');
    await page.waitForSelector('#tvm:not([hidden]) .tvm-g');
    if (await page.locator('.tvm-g').count() !== 2) fail('the hidden group was listed');
    // Shown as "Sport" under a "UK" heading: found by the provider's own name.
    await page.click('.tvm-g[data-sel="UK | Sport"] .tvm-g-open');
    if (await page.locator('.tvm-g-pre:has-text("UK")').count() !== 1) fail('the groups were not put under their country');
    await page.waitForSelector('.tvm-c');
    if (await page.locator('.tvm-c').count() !== 2) fail('the group\'s channels were not listed');
    await page.click('button:has-text("Add the whole group")');
    await waitUntil(page, () => posts.some(p => p.action === 'add-group' && p.group === 'UK | Sport' && p.pl === 'p1'));
    if (!posts.some(p => p.action === 'add-group' && p.group === 'UK | Sport' && p.pl === 'p1')) fail('Add the whole group did not add it: ' + JSON.stringify(posts));
    // A section folded away is opened; with none, page.click would wait out its 30 s.
    const folded = page.locator('.tvm-sec button[aria-expanded="false"]');
    if (await folded.count()) await folded.first().click();
    await page.waitForSelector('.tvm-lc .star');
    await page.locator('.tvm-lc .star').first().click();
    await waitUntil(page, () => posts.some(p => p.action === 'star' && p.id === 'p1:x1'));
    if (!posts.some(p => p.action === 'star' && p.id === 'p1:x1')) fail('the star did not star the channel');
    // A run selected with Shift, and the bar adding all of it in one edit.
    await page.click('.tvm-c >> nth=0');
    await page.click('.tvm-c >> nth=1', { modifiers: ['Shift'] });
    await page.waitForSelector('#tvm-dock:not([hidden])');
    await page.click('#tvm-dock button:has-text("Add 2 to the lineup")');
    await waitUntil(page, () => posts.some(p => p.action === 'add' && p.channels && p.channels.length === 2));
    if (!posts.some(p => p.action === 'add' && p.channels && p.channels.length === 2)) fail('the bar did not add the selected channels in one edit: ' + JSON.stringify(posts.slice(-1)));
    // A lineup channel selected, Delete takes it out; Escape clears a selection before it closes the page.
    await page.click('.tvm-lc .tvm-c-name >> nth=1');
    await page.keyboard.press('Delete');
    await waitUntil(page, () => posts.some(p => p.action === 'remove' && p.ids && p.ids[0] === 'p1:x2'));
    if (!posts.some(p => p.action === 'remove' && p.ids && p.ids[0] === 'p1:x2')) fail('Delete did not take the selected channel out');
    await page.click('.tvm-lc .tvm-c-name >> nth=0');
    await page.keyboard.press('Escape');
    if (await page.locator('#tvm').isHidden()) fail('Escape closed the page rather than clearing the selection');
    await page.keyboard.press('Escape');
    await waitUntil(page, () => page.locator('#tvm').isHidden());
    if (!(await page.locator('#tvm').isHidden())) fail('Escape did not close the page');
    if (/tv=channels/.test(page.url())) fail('the address still opens the page');
    await page.route('**/api/iptv/playlists', r => r.fulfill({ json: { ok: true, writable: true,
      playlists: [{ id: 'p1', label: 'Harbour TV', ready: true, channels: 2 }, { id: 'p2', label: 'Second TV', ready: true, channels: 1 }] } }));
    let hold = false, release;
    let received;
    const held = new Promise(resolve => { received = resolve; });
    await page.route('**/api/iptv/groups?pl=*', async r => {
      const first = new URL(r.request().url()).searchParams.get('pl') === 'p1';
      if (first && hold) {
        received();
        await new Promise(resolve => { release = resolve; });
      }
      await r.fulfill({ json: { ok: true, total: 1, channels: 1, groups: [{ name: first ? 'UK | News' : 'FR | News', count: 1 }] } });
    });
    await page.goto(base + '/?tab=home&tv=channels');
    await page.waitForSelector('.tvm-g[data-sel="UK | News"]');
    await page.selectOption('#tvm-pl', 'p2');
    await page.waitForSelector('.tvm-g[data-sel="FR | News"]');
    hold = true;
    await page.selectOption('#tvm-pl', 'p1');
    await held;
    await page.selectOption('#tvm-pl', 'p2');
    await page.waitForSelector('.tvm-g[data-sel="FR | News"]');
    const late = page.waitForResponse(r => new URL(r.url()).pathname === '/api/iptv/groups' && new URL(r.url()).searchParams.get('pl') === 'p1');
    release();
    await late;
    await page.waitForTimeout(100);
    if (await page.locator('.tvm-g[data-sel="UK | News"]').count()) fail('a late reply replaced the chosen provider’s groups');
  } finally { await page.close(); }
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => fail(e.message));
  try {
    await route(page);
    await page.goto(base + '/?tab=home&tv=channels');
    await page.waitForSelector('#tvm-tabs button');
    const shown = await page.locator('.tvm-pane').evaluateAll(els => els.filter(e => getComputedStyle(e).display !== 'none').length);
    if (shown !== 1) fail(shown + ' panes shown at once on a phone');
    await page.click('#tvm-tabs button[data-pane="lineup"]');
    if (!(await page.locator('.tvm-pane[data-pane="lineup"]').isVisible())) fail('the Lineup tab did not show the lineup');
  } finally { await page.close(); }
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => fail('TV app: ' + e.message));
  try {
    await route(page);
    await page.route('**/api/home?*', r => r.fulfill({ json: {
      ok: true, supported: { ok: true }, enabled: true, writable: true,
      layout: { rows: ['iptv'], order: { iptv: [] }, sort: { iptv: 'recent' }, hidden: {}, channels: [] },
      catalogue: { apps: [], devices: [], channels: [], sources: { iptv: true },
        order: { iptv: ['p1:x2', 'p1:x1'] }, iptv: channels }
    } }));
    await page.goto(base + '/assets/dashboard.html?tab=home');
    await page.locator('#rows .row').filter({ hasText: /^Internet TV/ }).first().click();
    const peek = await page.locator('#hintPeek span').allTextContents();
    if (peek.join(',') !== 'World Today,Harbour News') fail('TV app: the row preview did not follow Last opened order: ' + peek.join(','));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => rows.some(r => r.act === 'tvSection'));
    await page.evaluate(() => { sel = rows.findIndex(r => r.key === 'tvGroups'); render(); });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => rows.some(r => r.act === 'tvGroupOpen' && r.key === 'UK | Sport'));
    if (await page.evaluate(() => rows.some(r => r.key === 'DE | Sport'))) fail('TV app: the hidden group was listed');
    await page.evaluate(() => { sel = rows.findIndex(r => r.key === 'UK | Sport'); render(); });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => rows.some(r => r.act === 'tvToggle'));
    await page.evaluate(() => { sel = rows.findIndex(r => r.act === 'tvToggle'); render(); });
    await page.keyboard.press('Enter');
    await waitUntil(page, () => posts.some(p => p.action === 'add' && p.channels && p.channels[0].key === 'x7'));
    if (!posts.some(p => p.action === 'add' && p.channels && p.channels[0].key === 'x7')) fail('TV app: OK on a channel did not add it');
    await page.keyboard.press('ArrowLeft');
    await waitUntil(page, async () => await page.evaluate(() => sub) === 'tvGroups');
    if (await page.evaluate(() => sub) !== 'tvGroups') fail('TV app: Back from a group did not return to the groups');
  } catch (e) {
    fail('TV app: ' + e.message.split('\n')[0] + ' (tab ' + await page.evaluate(() => T().key + ', list ' + sub).catch(() => '?') + ')');
  } finally { await page.close(); }
}

/*
 * The Inputs and Remote tabs: the inputs with their switches, the Input key's
 * choice of LG's list or the input bar and the No Signal switch on Inputs; the remote's keys on
 * Remote, which is left out where a TV has none to set.
 */
async function visitInputsAndRemote(browser, base, problems) {
  const page = await browser.newPage();
  const fail = message => problems.push('Inputs and Remote: ' + message);
  page.on('pageerror', error => fail(error.message));
  const noSignal = { ok: true, available: true, on: false, mode: 'lg', applied: false, restartPending: false };
  const layout = { hidden: { dev: [] }, hideUnused: false, deviceNames: {} };
  const devices = [{ id: 'TV', name: 'Live TV', tuner: true }, { id: 'HDMI_1', name: 'Console', port: 1 }, { id: 'HDMI_2', name: 'HDMI 2', port: 2, unused: true }];
  const keys = [{ key: 'input', title: 'Input', action: 'lg' }, { key: 'netflix', title: 'Netflix', action: 'open', id: 'com.tvweb.inputbar', opens: 'Input bar' }];
  let hasKeys = true;
  let hasQuickAccess = false;
  let appReads = 0;
  const writes = [];
  try {
    await page.route('**/api/remote/available', route => route.fulfill({ json: { ok: true, available: hasKeys || hasQuickAccess } }));
    await page.route('**/api/inputs', route => route.fulfill({ json: { ok: true, writable: true, noSignal, inputBar: { standing: 'tried', allowed: true, experimental: false } } }));
    await page.route('**/api/home/catalogue', route => route.fulfill({ json: { ok: true, layout, order: { dev: ['TV', 'HDMI_1', 'HDMI_2'] },
      devices: devices.map(d => layout.deviceNames[d.id] ? Object.assign({}, d, { name: layout.deviceNames[d.id], defaultName: d.name }) : d) } }));
    await page.route('**/api/home/layout', async route => {
      const patch = route.request().postDataJSON();
      writes.push(patch);
      if (patch.hidden) layout.hidden = patch.hidden;
      if (typeof patch.hideUnused === 'boolean') layout.hideUnused = patch.hideUnused;
      if (typeof patch.inputBarTransparent === 'boolean') layout.inputBarTransparent = patch.inputBarTransparent;
      if (patch.deviceNames) Object.assign(layout.deviceNames, patch.deviceNames);
      await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/apps', async route => {
      appReads++;
      // The page may close with this still on its way.
      try {
        const apps = await (await route.fetch()).json();
        apps.writable = true;
        apps.quickAccess = hasQuickAccess ? { keys: [], choices: [] } : null;
        apps.remoteKeys = hasKeys ? { ok: true, supported: true, keys, choices: [] } : null;
        await route.fulfill({ json: apps });
      } catch (e) { /* closed */ }
    });
    await page.route('**/api/remotekeys', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const set = route.request().postDataJSON();
      writes.push(set);
      keys[0] = set.action === 'lg' ? { key: 'input', title: 'Input', action: 'lg' }
        : { key: 'input', title: 'Input', action: 'open', id: set.id, opens: 'Input bar' };
      await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/control', async route => {
      const command = route.request().postDataJSON();
      writes.push(command);
      if (command.action === 'plainNoSignal') {
        noSignal.mode = command.value === 'icon' ? 'icon' : (command.value === 'plain' || command.value === true ? 'plain' : 'lg');
        noSignal.on = noSignal.mode !== 'lg';
      }
      await route.fulfill({ json: Object.assign({ ok: true }, noSignal) });
    });
    await page.goto(base + '/?tab=control');
    await page.locator('#tab-btn-remote').waitFor({ state: 'visible' });
    if (appReads) fail('opening Control fetched the Apps catalogue');
    await page.goto(base + '/?tab=inputs');
    await page.locator('#inputs-list .home-tile').first().waitFor();
    if (await page.locator('#inputs-list .home-tile').count() !== 3) fail('the inputs are not listed');
    if (await page.locator('#inputs-list .home-tile .inp-ico svg').count() !== 3) fail('input cards have no device icons');
    if (await page.locator('#inputs-list .home-tile').first().locator('.inp-status').count() !== 0) fail('Live TV card showed a connection status');
    if (!await page.locator('#inputs-sort').isVisible() || !await page.locator('#home-hide-unused').isVisible()) fail('the input list options are missing');
    await page.locator('#inputs-list [data-dev="HDMI_2"]').click();
    await page.locator('#inputs-list [data-dev="HDMI_2"].idle').waitFor();
    if (JSON.stringify(writes[0]) !== JSON.stringify({ hidden: { dev: ['HDMI_2'] } })) fail('hiding an input did not save it');
    // Editing an HDMI input's name directly on its card.
    const nameIn = page.locator('#inputs-list [data-dev-name="HDMI_1"]');
    await nameIn.fill('Living Room');
    await nameIn.press('Enter');
    await page.waitForFunction(() => {
      const inp = document.querySelector('#inputs-list [data-dev-name="HDMI_1"]');
      const port = inp && inp.parentElement && inp.parentElement.querySelector('.inp-port');
      return inp && inp.value === 'Living Room' && inp.getAttribute('data-cur') === 'Living Room' && port && port.textContent === 'HDMI 1';
    });
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ deviceNames: { HDMI_1: 'Living Room' } })) fail('renaming an input did not save deviceNames');
    // The Input key: LG's list or the bar, chosen here.
    await page.locator('#inputs-bar-lg.on').waitFor();
    await page.locator('#inputs-bar-ours').click();
    await page.locator('#inputs-bar-ours.on').waitFor();
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ key: 'input', action: 'open', id: 'com.tvweb.inputbar' })) fail('choosing the input bar did not set the Input key');
    await page.locator('#inputs-bar-lg').click();
    await page.locator('#inputs-bar-lg.on').waitFor();
    if (writes[writes.length - 1].action !== 'lg') fail('choosing LG\'s list did not put the Input key back');
    await page.locator('#inputs-bar-transparent').click();
    await page.locator('#inputs-bar-transparent.good').waitFor();
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ inputBarTransparent: true })) fail('the Transparent tiles switch did not save inputBarTransparent');
    await page.locator('#inputs-nosignal-lg.on').waitFor();
    await page.locator('#inputs-nosignal-plain').click();
    await page.locator('#inputs-nosignal-plain.on').waitFor();
    if (writes[writes.length - 1].action !== 'plainNoSignal' || writes[writes.length - 1].value !== 'plain') fail('the No Signal card did not send plain');
    await page.locator('#inputs-nosignal-icon').click();
    await page.locator('#inputs-nosignal-icon.on').waitFor();
    if (writes[writes.length - 1].action !== 'plainNoSignal' || writes[writes.length - 1].value !== 'icon') fail('the No Signal icon card did not send icon');
    await page.locator('#tab-btn-remote').click();
    if (await page.evaluate(() => activeTab) !== 'remote') fail('the Remote tab button did not open Remote');
    if (!await page.locator('#remotepane #disc-remotekeys').isVisible()) fail('Remote keys are not on the Remote tab');
    if (await page.locator('#appspane #disc-remotekeys, #sspane [id*="nosignal"]').count()) fail('remote keys or No Signal remain on their old tabs');
    hasKeys = false;
    hasQuickAccess = true;
    const readsBefore = appReads;
    await page.goto(base + '/?tab=control');
    await page.locator('#tab-btn-remote').waitFor({ state: 'visible' });
    if (appReads !== readsBefore) fail('Quick Access visibility fetched the Apps catalogue');
    hasQuickAccess = false;
    // A TV with no keys to set: no Remote tab, no input bar on Inputs, and no Your inputs while LG Home is active.
    hasKeys = false;
    await page.goto(base + '/?tab=inputs');
    await page.locator('#inputs-nosignal-icon.on').waitFor();
    await page.locator('#tab-btn-remote').waitFor({ state: 'hidden' });
    if (await page.locator('#inputs-grp-bar').isVisible()) fail('the input bar is offered with no keys to open it');
    if (await page.locator('#inputs-grp-list').isVisible()) fail('Your inputs is shown with neither the input bar nor a Glasshouse launcher active');
  } catch (e) {
    fail(e.message);
  } finally {
    await page.close();
  }
}

/*
 * Brightness key settings: a section of its own on the Remote tab, there only
 * while a key is set to Brightness up or down. Brightness step and Level bar
 * style are its rows, the style offering LG's bar, a horizontal one, a vertical
 * one or no
 * bar, and left out where the bar cannot be shown (webOS 11).
 */
async function visitBrightnessKeySettings(browser, base, problems) {
  const page = await browser.newPage();
  const fail = message => problems.push('Brightness key settings: ' + message);
  page.on('pageerror', error => fail(error.message));
  const state = { brightnessKey: false, bar: true, style: 'lg', step: 10 };
  const writes = [];
  const keysNow = () => [
    { key: 'red', title: 'Red', action: state.brightnessKey ? 'open' : 'lg', id: state.brightnessKey ? 'action:brightnessUp' : '', opens: state.brightnessKey ? 'Brightness up' : '' },
    { key: 'green', title: 'Green', action: 'lg' }
  ];
  const choicesNow = () => [
    { id: 'action:brightnessUp', title: 'Brightness up', kind: 'action' }
  ];
  const remoteKeysPayload = () => ({
    ok: true, supported: true, keys: keysNow(), choices: choicesNow(),
    brightnessStep: state.step, brightnessBar: state.bar, brightnessBarStyle: state.style
  });
  try {
    await page.route('**/api/remote/available', route => route.fulfill({ json: { ok: true, available: true } }));
    await page.route('**/api/apps', async route => {
      // The page may close with this still on its way.
      try {
        const apps = await (await route.fetch()).json();
        apps.writable = true;
        apps.quickAccess = null;
        apps.remoteKeys = remoteKeysPayload();
        await route.fulfill({ json: apps });
      } catch (e) { /* closed */ }
    });
    await page.route('**/api/remotekeys', async route => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: remoteKeysPayload() });
      const set = route.request().postDataJSON();
      writes.push(set);
      if (set.key === 'red') state.brightnessKey = set.action === 'open' && set.id === 'action:brightnessUp';
      if (set.brightnessBarStyle !== undefined) state.style = set.brightnessBarStyle;
      if (set.brightnessStep !== undefined) state.step = set.brightnessStep;
      await route.fulfill({ json: { ok: true } });
    });
    const open = async () => {
      await page.goto(base + '/?tab=remote');
      await page.locator('#apps-rk-list .rk-key').first().waitFor();
    };
    const heading = page.locator('#apps-rk-list .rk-grp', { hasText: 'Brightness key settings' });
    const stepSel = page.locator('#apps-rk-step');
    const styleSel = page.locator('#apps-rk-bar-style');

    // No key set to Brightness: no section, and none of its rows.
    await open();
    if (await heading.count() || await stepSel.count() || await styleSel.count()) fail('the section shows with no key set to Brightness');

    // Setting a key updates the tile and reveals the section without a reload.
    await page.locator('#apps-rk-list .rk-key[data-key="red"]').click();
    await page.locator('#apps-rk-list .rk-pick [data-value="action:brightnessUp"]').click();
    await heading.waitFor();
    if (!await page.locator('#apps-rk-list .rk-key[data-key="red"] .rk-does', { hasText: 'Brightness up' }).isVisible()) {
      fail('setting a key did not refresh its tile without a reload');
    }

    // A deferred redraw while another key's picker is open flushes when the picker closes.
    await page.locator('#apps-rk-list .rk-key[data-key="green"]').click();
    await page.locator('#apps-rk-list .rk-pick .rk-opt').first().focus();
    await page.evaluate(() => {
      const g = appsData.remoteKeys.keys.find(k => k.key === 'green');
      g.action = 'nothing';
      renderRemoteKeys(appsData);
    });
    await page.locator('#apps-rk-list .rk-pick .rk-close').click();
    if (!await page.locator('#apps-rk-list .rk-key[data-key="green"] .rk-does', { hasText: 'Does nothing' }).isVisible()) {
      fail('closing the picker did not flush a deferred tile redraw');
    }

    // A key set to it: on desktop width, step and style sit side by side under the heading.
    await open();
    await heading.waitFor();
    if (!await stepSel.isVisible() || !await styleSel.isVisible()) fail('the step or the style row is missing from the section');
    const [hy, sy, by] = await Promise.all([heading.boundingBox(), stepSel.boundingBox(), styleSel.boundingBox()]);
    if (!(hy.y < sy.y && Math.abs(sy.y - by.y) < 10 && sy.x < by.x)) fail('step and style are not side by side under the heading on desktop');
    if (await page.locator('#apps-rk-list .rk-key').last().boundingBox().then(b => b.y) > hy.y) fail('the section is above the keys');
    const options = await styleSel.locator('option').evaluateAll(o => o.map(x => x.value));
    if (JSON.stringify(options) !== JSON.stringify(['lg', 'horizontal', 'vertical', 'none'])) fail('the style offers ' + options + ', not lg, horizontal, vertical and none');
    if (await styleSel.inputValue() !== 'lg') fail('the style does not start on the LG-style bar');

    // Each choice is saved and comes back as chosen.
    await styleSel.selectOption('none');
    await page.waitForFunction(() => document.querySelector('#apps-rk-bar-style') && document.querySelector('#apps-rk-bar-style').value === 'none');
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ brightnessBarStyle: 'none' })) fail('choosing No bar did not save it');
    await styleSel.selectOption('horizontal');
    await page.waitForFunction(() => document.querySelector('#apps-rk-bar-style').value === 'horizontal');
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ brightnessBarStyle: 'horizontal' })) fail('choosing the horizontal bar did not save it');
    await styleSel.selectOption('vertical');
    await page.waitForFunction(() => document.querySelector('#apps-rk-bar-style').value === 'vertical');
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ brightnessBarStyle: 'vertical' })) fail('choosing the vertical bar did not save it');
    await stepSel.selectOption('15');
    await page.waitForFunction(() => document.querySelector('#apps-rk-step').value === '15');
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ brightnessStep: 15 })) fail('choosing a step did not save it');

    // Where the bar cannot be shown, the step is left in the section alone.
    state.bar = false;
    await open();
    await heading.waitFor();
    if (!await stepSel.isVisible()) fail('the step is missing where the bar cannot be shown');
    if (await styleSel.count()) fail('the style is offered where the bar cannot be shown');

    // At phone width the rows stack and stay inside the page.
    state.bar = true;
    await page.setViewportSize({ width: 390, height: 800 });
    await open();
    await heading.waitFor();
    if (!await styleSel.isVisible()) fail('the style row is not visible at phone width');
    const [syMob, byMob] = await Promise.all([stepSel.boundingBox(), styleSel.boundingBox()]);
    if (!(syMob.y < byMob.y)) fail('step and style did not stack vertically at phone width');
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail('the section makes the page scroll sideways at phone width');
    await page.setViewportSize({ width: 1280, height: 800 });

    // The key put back as LG has it: the section goes.
    state.brightnessKey = false;
    await open();
    if (await heading.count() || await stepSel.count() || await styleSel.count()) fail('the section stays with no key set to Brightness');
  } catch (e) {
    fail(e.message);
  } finally {
    await page.close();
  }
}

async function visitRemoteFolding(browser, base, problems) {
  const page = await browser.newPage();
  const fail = message => problems.push('Remote folding: ' + message);
  page.on('pageerror', error => fail(error.message));
  const state = { mode: 'auto', known: true };
  const writes = [];
  const mr25 = { id: 'MR25GA', title: 'Magic Remote MR25GA', image: 'generic.png', numberKeys: false };
  const payload = () => {
    // Dead on the remote in use whenever it is known, folding (auto) or not (all); only
    // the toggle's own state (folding) decides whether the page hides it or sets it apart.
    const markedOff = state.known;
    const folding = state.known && state.mode === 'auto';
    return {
      ok: true,
      supported: true,
      keys: [
        { key: 'netflix', title: 'Netflix', action: 'lg' },
        { key: 'red', title: 'Red', action: 'lg', offRemote: markedOff }
      ],
      choices: [],
      brightnessStep: 10,
      brightnessBar: false,
      brightnessBarStyle: 'lg',
      remotes: state.known ? {
        mode: state.mode,
        canFold: true,
        folding: folding,
        why: '',
        selected: state.mode === 'auto' ? [mr25] : [],
        unknown: 0,
        detected: [{ name: 'LGE MR25GA', id: 'MR25GA', title: 'Magic Remote MR25GA', image: 'generic.png', current: true }]
      } : {
        mode: state.mode,
        canFold: false,
        folding: false,
        why: state.mode === 'auto' ? 'unknown' : '',
        selected: [],
        unknown: state.mode === 'auto' ? 1 : 0,
        detected: [{ name: 'LGE MR22GN', id: null, title: 'LGE MR22GN', image: 'generic.png', current: true }]
      }
    };
  };
  try {
    await page.route('**/api/remote/available', route => route.fulfill({ json: { ok: true, available: true } }));
    await page.route('**/api/apps', async route => {
      try {
        const apps = await (await route.fetch()).json();
        apps.writable = true;
        apps.quickAccess = { ok: true, supported: true, keys: [{ key: 1, title: 'Netflix', id: 'netflix' }] };
        apps.remoteKeys = payload();
        await route.fulfill({ json: apps });
      } catch (e) { /* closed */ }
    });
    await page.route('**/api/remotekeys', async route => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: payload() });
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body && body.remotes && body.remotes.mode) state.mode = body.remotes.mode;
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto(base + '/?tab=remote');
    const filter = page.locator('#apps-remote-filter');
    const toggle = page.locator('#btn_remote_only');
    await filter.waitFor();
    if (!await toggle.evaluate(el => el.classList.contains('good')) || (await toggle.textContent()).trim() !== 'On') {
      fail('toggle did not render as active On pill');
    }
    if (!/Detected: Magic Remote MR25GA/.test(await page.locator('#apps-remote-detected').textContent())) {
      fail('detected remote name was not shown under the switch');
    }
    const otherGroup = page.locator('#apps-rk-list .rk-more summary', { hasText: 'Buttons on other remotes (1)' });
    const redKey = page.locator('#apps-rk-list .rk-key[data-key="red"]');
    // Dead on the remote in use while folding: left off the page entirely, not shown folded.
    if (await otherGroup.count()) fail('Buttons on other remotes was shown while folding');
    if (await redKey.count()) fail('a key dead on the remote in use was shown while folding');
    await toggle.click();
    await page.waitForFunction(() => document.getElementById('btn_remote_only').classList.contains('idle'));
    if (JSON.stringify(writes[writes.length - 1]) !== JSON.stringify({ remotes: { mode: 'all' } })) {
      fail('clicking toggle did not save mode all');
    }
    if (!await filter.isVisible()) fail('folding switch disappeared when turned off');
    if (!/Magic Remote MR25GA/.test(await page.locator('#apps-remote-detected').textContent())) {
      fail('detected remote name disappeared when folding was turned off');
    }
    await otherGroup.waitFor();
    await otherGroup.click();
    if (!await redKey.isVisible()) fail('Red key did not show under Buttons on other remotes with folding off');

    state.mode = 'auto';
    state.known = false;
    await page.goto(base + '/?tab=remote');
    await page.locator('#apps-rk-list .rk-key[data-key="netflix"]').waitFor();
    if (await filter.isVisible()) fail('folding switch was shown for an unlisted remote');
    if (await otherGroup.count()) fail('Buttons on other remotes was shown for an unlisted remote');
    if (!await page.locator('#apps-rk-list .rk-key[data-key="red"]').isVisible()) fail('Red key was not shown for an unlisted remote');
  } catch (e) {
    fail(e.message);
  } finally {
    await page.close();
  }
}

/*
 * Home Assistant: Ambient's entity slots on the Screensaver tab: a slot given
 * its first entity shows its Label row at once, though the field picked from
 * still has focus (#1446), and a field tabbed to before a save keeps its focus
 * and what was typed in it.
 */
async function visitSaverEntitySlots(browser, base, problems) {
  const page = await browser.newPage();
  const fail = message => problems.push('Saver entity slots: ' + message);
  page.on('pageerror', error => fail(error.message));
  const slots = { sensor_1: { entity: '', label: '' }, sensor_2: { entity: 'sensor.office', label: '' } };
  let delay = 0;
  try {
    await page.route('**/api/screensaver', async route => {
      try {
        const d = await (await route.fetch()).json();
        d.writable = true;
        d.haConfigured = true;
        d.held = false;
        d.current = 'ambient';
        d.modes.forEach(m => { m.active = m.id === 'ambient'; });
        const ambient = d.modes.filter(m => m.id === 'ambient')[0];
        ambient.available = true;
        ambient.entities = Object.keys(slots).map(id => ({ id, label: id === 'sensor_1' ? 'Sensor 1' : 'Sensor 2',
          entity: slots[id].entity, customLabel: slots[id].label, def: '' }));
        await route.fulfill({ json: d });
      } catch (e) { /* closed */ }
    });
    await page.route('**/api/ha/entities', route => route.fulfill({ json: { ok: true, configured: true,
      entities: [
        { id: 'sensor.living_room', name: 'Living room', unit: '°C' },
        { id: 'sensor.office', name: 'Office', unit: '°C' },
        { id: 'weather.home', name: 'Forecast Home', unit: '' }
      ] } }));
    await page.route('**/api/control', async route => {
      const command = route.request().postDataJSON();
      if (command.action === 'screensaverEntities') {
        for (const [id, v] of Object.entries(command.value.entities)) {
          if (v.entity !== undefined) slots[id].entity = v.entity;
          if (v.label !== undefined) slots[id].label = v.label;
        }
      }
      if (delay) await new Promise(r => setTimeout(r, delay));
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(base + '/?tab=screensaver');
    // The slots are in the screen saver's dialog, opened from the tab.
    await page.locator('#ss-ha-open').click();
    await page.locator('#ha-modal:not([hidden])').waitFor();
    const first = page.locator('#ss-ent-sensor_1');
    await first.waitFor();
    // Typed and confirmed with Enter: the field keeps focus through the save.
    await first.fill('sensor.living_room');
    await first.press('Enter');
    await first.dispatchEvent('change');
    try { await page.locator('#ss-lbl-sensor_1').waitFor({ timeout: 3000 }); }
    catch (e) { fail('the Label row did not appear for a slot given its first entity'); }
    // A label confirmed with Tab, with typing begun in the next field before the save answers.
    delay = 300;
    const label = page.locator('#ss-lbl-sensor_1');
    await label.fill('Lounge');
    await label.press('Tab');
    await page.keyboard.type('xyz');
    await page.waitForTimeout(900);
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    if (!focused || !focused.startsWith('ss-')) fail('focus left the fields after a save: ' + focused);
    const typed = await page.evaluate(id => document.getElementById(id) && document.getElementById(id).value, focused);
    if (slots.sensor_1.label !== 'Lounge') fail('the label was not saved');
    if (focused && focused.indexOf('ss-ent-') === 0 && !/xyz$/.test(typed || '')) fail('what was typed in the next field was lost: ' + typed);

    // Open the reusable entity picker, filter by type, and ensure Escape closes only the picker.
    await page.locator('button[onclick*="ssHaToggle"][onclick*="sensor_1"]').click();
    const list1 = page.locator('#ss-ha-list-sensor_1:not([hidden])');
    await list1.waitFor({ timeout: 3000 });
    await list1.locator('.ha-pk-chip', { hasText: 'Weather' }).click();
    const weatherOpt = list1.locator('.ha-pk-opt[data-entity="weather.home"]');
    await weatherOpt.waitFor({ timeout: 3000 });
    if (await list1.locator('.ha-pk-opt[data-entity="sensor.living_room"]').count() !== 0) {
      fail('domain filter chip did not filter out sensor entities');
    }
    await list1.locator('.ha-pk-search').press('Escape');
    if (!(await page.locator('#ss-ha-list-sensor_1').isHidden())) fail('Escape did not close the open entity picker');
    if (await page.locator('#ha-modal').isHidden()) fail('Escape closed the parent modal instead of only the entity picker');
  } catch (e) {
    fail(e.message);
  } finally {
    await page.close();
  }
}

/*
 * Groups side by side, each against its own server and fake TV, as the Home
 * checks change the layout and uploads they read back. Within a group the
 * checks run in their order here, and the slowest group sets the run's
 * length, so they are kept about even (20 to 25 s on a laptop). CI runs each
 * job, its groups together, on a machine of its own: CHECK_JOB names one;
 * without it every group runs.
 */
async function visitHuesyncSettings(browser, base, problems) {
  const page = await browser.newPage();
  const fail = message => problems.push('Hue Sync: ' + message);
  page.on('pageerror', error => fail(error.message));
  const settings = { brightness: 50, intensity: 2, sync_mode: '1', current_ec: 'area-a',
    ec_list: [{ id: 'area-a', name: '<img src=x onerror=alert(1)>' }, { id: 'area-b', name: 'TV' }],
    background_lightning_video: true, background_lightning_games: false, auto_start: false, auto_start_notification: true };
  const diagnostics = { ready: { ready: true, supported: true }, bridge: { Connected: true, Authorized: true }, busy: false };
  let writable = true, supported = true, refuse = false, streaming = true, piccapRunning = false, piccapPresent = true, huesyncPresent = true;
  const writes = [];
  try {
    await page.route('**/api/stats*', async route => {
      const response = await route.fetch();
      const stats = await response.json();
      delete stats.piccapCapture;
      delete stats.huesyncStreaming;
      if (piccapPresent) stats.piccapCapture = { running: piccapRunning, writable };
      if (huesyncPresent) stats.huesyncStreaming = { streaming, writable, diagnostics, settings: supported ? settings : {} };
      await route.fulfill({ json: stats });
    });
    await page.route('**/api/control', async route => {
      const command = route.request().postDataJSON();
      writes.push(command);
      if (command.action === 'huesyncSetting' && !refuse) settings[command.value.key] = command.value.value;
      if (command.action === 'piccap' && !refuse) piccapRunning = command.value === 'on';
      if (command.action === 'huesync' && !refuse) streaming = command.value === 'on';
      await route.fulfill({ json: { ok: !refuse, settings } });
    });
    await page.goto(base + '/?tab=advanced');
    if (await page.locator('#advpane #row-piccap, #advpane #row-huesync').count()) fail('ambient controls remain in System');
    // With the TV's own settings in the sidebar, after OLED Care.
    const followsOled = await page.locator('#tabs [data-tab="ambient"]').evaluate(el => el.previousElementSibling.dataset.tab === 'oledcare');
    if (!followsOled) fail('Ambient Light does not follow OLED Care');
    await page.locator('#tabs [data-tab="ambient"]').click();
    await page.waitForSelector('#huesync-settings:not([hidden])');
    for (const key of ['background_lightning_video', 'background_lightning_games', 'auto_start', 'auto_start_notification']) {
      const toggle = page.locator('#huesync-' + key);
      if (!(await toggle.evaluate(el => el.tagName === 'BUTTON' && el.classList.contains('pill')))) fail(key + ' is not a standard pill toggle');
      if (await toggle.getAttribute('aria-pressed') !== String(settings[key]) ||
          await toggle.textContent() !== (settings[key] ? 'On' : 'Off')) fail(key + ' does not show its current state');
    }
    const categories = await page.locator('#ambient-huesync, #ambient-piccap').evaluateAll(els => els.filter(el => !el.hidden).map(el => el.querySelector('.pv-sec').textContent));
    if (JSON.stringify(categories) !== JSON.stringify(['Hue Sync', 'PicCap'])) fail('integration categories are missing or in the wrong order');
    if (await page.locator('#row-huesync .prot-title').textContent() !== 'Hue Sync Enabled' || await page.locator('#row-piccap .prot-title').textContent() !== 'PicCap Enabled') fail('enabled labels differ');
    if (!(await page.locator('#row-piccap .prot-desc').textContent()).includes('Hyperion or HyperHDR')) fail('PicCap description omits a supported server');
    if (await page.locator('#huesync-settings').evaluate(el => el.closest('.panel').id) !== 'ambientpane') fail('settings are on the wrong page');
    await page.locator('#btn_piccap').click();
    await page.waitForFunction(() => document.getElementById('btn_piccap').dataset.on === '1');
    if (!piccapRunning || !streaming || writes.some(command => command.action === 'huesync')) fail('turning on PicCap changed Hue Sync');
    await page.locator('#btn_huesync').click();
    await page.waitForFunction(() => document.getElementById('btn_huesync').dataset.on === '');
    if (!piccapRunning || writes.filter(command => command.action === 'piccap').length !== 1) fail('turning off Hue Sync changed PicCap');
    await page.evaluate(() => showTab('control'));
    await page.waitForSelector('#control-ambient:not([hidden])');
    const underPlayback = await page.evaluate(() => document.getElementById('control-ambient').getBoundingClientRect().top >= document.querySelector('.playback-btns').getBoundingClientRect().bottom);
    if (!underPlayback) fail('remote toggles are not below Playback');
    const shortcuts = await page.locator('#control-ambient button').evaluateAll(els => els.map(el => el.querySelector('[data-t]').textContent));
    if (JSON.stringify(shortcuts) !== JSON.stringify(['Hue Sync', 'PicCap'])) fail('remote shortcut order or short labels are wrong');
    if (await page.locator('#ctl_piccap').getAttribute('aria-pressed') !== 'true' || await page.locator('#ctl_huesync').getAttribute('aria-pressed') !== 'false') fail('remote toggle states differ from Ambient Light');
    await page.locator('#ctl_huesync').click();
    await page.waitForFunction(() => document.getElementById('ctl_huesync').getAttribute('aria-pressed') === 'true' && document.getElementById('btn_huesync').dataset.on === '1');
    await page.locator('#ctl_piccap').click();
    await page.waitForFunction(() => document.getElementById('ctl_piccap').getAttribute('aria-pressed') === 'false' && document.getElementById('btn_piccap').dataset.on === '');
    if (!streaming || piccapRunning) fail('remote quick toggles are not independent');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.getElementById('control-playback').getBoundingClientRect().width > 300);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail('remote labels overflow on a phone');
    await page.evaluate(() => showTab('ambient'));
    if (await page.locator('#huesync-current_ec option').first().textContent() !== settings.ec_list[0].name) fail('area name was not rendered as text');
    if (await page.locator('#huesync-settings img').count()) fail('area markup was interpreted');
    if (await page.locator('#huesync-readiness').count()) fail('readiness paragraph is still shown');
    if (await page.locator('#huesync-more').count()) fail('More settings submenu remains');
    if (!(await page.locator('#huesync-auto_start').isVisible())) fail('startup switches are not directly accessible');
    for (const [width, colorScheme] of [[390, 'light'], [1280, 'dark']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail('ambient page overflows at width ' + width);
    }
    const changes = [
      ['brightness', 60], ['intensity', 3], ['sync_mode', '0'], ['current_ec', 'area-b'],
      ['background_lightning_video', false], ['background_lightning_games', true], ['auto_start', true], ['auto_start_notification', false]
    ];
    for (const [key, value] of changes) {
      await page.evaluate(() => tick());
      const reply = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== '/api/control') return false;
        const command = response.request().postDataJSON();
        return command.action === 'huesyncSetting' && command.value.key === key;
      });
      const element = page.locator('#huesync-' + key);
      if (typeof value === 'boolean') await element.click();
      else if (key === 'brightness') { await element.fill(String(value)); await element.blur(); }
      else await element.selectOption(String(value));
      const command = (await reply).request().postDataJSON();
      await page.waitForFunction(() => !huesyncSettingsBusy);
      if (!command || command.action !== 'huesyncSetting' || command.value.key !== key || command.value.value !== value) fail('wrong command for ' + key);
      if (typeof value === 'boolean') {
        await page.waitForFunction(({ key, value }) => document.getElementById('huesync-' + key).getAttribute('aria-pressed') === String(value), { key, value });
        if (!(await element.evaluate((el, value) => el.classList.contains(value ? 'good' : 'idle'), value)) ||
            await element.textContent() !== (value ? 'On' : 'Off')) fail(key + ' pill did not update after confirmation');
      }
    }
    refuse = true;
    await page.locator('#huesync-auto_start').click();
    await page.waitForFunction(() => !huesyncSettingsBusy);
    if (await page.locator('#huesync-auto_start').getAttribute('aria-pressed') !== 'true' ||
        !(await page.locator('#huesync-auto_start').evaluate(el => el.classList.contains('good')))) fail('a refused boolean write changed its pill state');
    await page.locator('#huesync-brightness').fill('10');
    await page.locator('#huesync-brightness').blur();
    await page.waitForFunction(() => !huesyncSettingsBusy);
    if (await page.locator('#huesync-brightness').inputValue() !== '60') fail('a refused write left an optimistic value visible');
    settings._stale = ['brightness', 'auto_start'];
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#huesync-brightness').disabled && document.querySelector('#huesync-auto_start').disabled);
    if (!(await page.locator('#row-huesync-brightness').isVisible())) fail('a temporary failure removed the supported control');
    delete settings._stale;
    diagnostics.busy = true;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#btn_huesync').disabled && document.querySelector('#ctl_huesync').disabled && document.querySelector('#huesync-auto_start').disabled);
    diagnostics.busy = false;
    diagnostics.bridge.Authorized = false;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#huesync-intensity').disabled);
    if (await page.locator('#huesync-readiness').count()) fail('authorization produced a persistent status paragraph');
    diagnostics.bridge.Authorized = true;
    writable = false;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#huesync-brightness').disabled && document.querySelector('#btn_piccap').disabled && document.querySelector('#ctl_piccap').disabled && document.querySelector('#ctl_huesync').disabled);
    for (const key of ['background_lightning_video', 'background_lightning_games', 'auto_start', 'auto_start_notification']) delete settings[key];
    await page.evaluate(() => tick());
    await page.waitForSelector('#row-huesync-auto_start[hidden]', { state: 'attached' });
    if (!(await page.locator('#huesync-brightness').isVisible())) fail('primary controls disappeared with unsupported secondary settings');
    supported = false;
    await page.evaluate(() => tick());
    await page.waitForSelector('#huesync-settings[hidden]', { state: 'attached' });
    huesyncPresent = false;
    await page.evaluate(() => tick());
    await page.waitForSelector('#row-huesync[hidden]', { state: 'attached' });
    if (!(await page.locator('#ambient-piccap').isVisible()) || !(await page.locator('#ambient-huesync').isHidden())) fail('missing Hue Sync left an empty category or hid PicCap');
    if (!(await page.locator('#ctl_huesync').evaluate(el => el.hidden))) fail('missing Hue Sync left its shortcut');
    piccapPresent = false;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.getElementById('tab-btn-ambient').hidden && activeTab === 'control');
    if (!(await page.locator('#ambientpane').isHidden())) fail('unavailable Ambient Light panel remained open');
    if (!(await page.locator('#control-ambient').evaluate(el => el.hidden))) fail('empty remote toggle group remains visible');
    await page.evaluate(() => showTab('ambient'));
    if (await page.evaluate(() => activeTab) === 'ambient') fail('an unavailable Ambient Light tab can still be opened');
    huesyncPresent = true;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => !document.getElementById('tab-btn-ambient').hidden);
    await page.evaluate(() => showTab('ambient'));
    await page.waitForSelector('#row-huesync:not([hidden])');
    if (await page.locator('#ambient-empty').isVisible()) fail('empty message remains with Hue Sync alone');
    if (!(await page.locator('#ambient-piccap').isHidden()) || !(await page.locator('#ambient-huesync').isVisible())) fail('missing PicCap left an empty category or hid Hue Sync');
    if (!(await page.locator('#ctl_piccap').evaluate(el => el.hidden))) fail('missing PicCap left its shortcut');
    huesyncPresent = false;
    await page.goto(base + '/?tab=ambient');
    await page.waitForFunction(() => ambientAvailable === false && activeTab === 'control');
    if (!(await page.locator('#tab-btn-ambient').isHidden()) || !(await page.locator('#control-ambient').isHidden())) fail('a deep link offered Ambient Light with neither integration installed');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
}

async function visitTvHuesync(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const fail = message => problems.push('TV Hue Sync: ' + message);
  page.on('pageerror', error => fail(error.message));
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/huesync-settings.json'), 'utf8')).settings;
  settings.ec_list[0].name = '<img src=x onerror=alert(1)>';
  const diagnostics = { busy: false, bridge: { Connected: true, Authorized: true } };
  const writes = [];
  let writable = true, present = true, refuse = false, streaming = true, piccapRunning = true, piccapPresent = true;
  async function choose(key) {
    await page.evaluate(key => {
      sel = rows.findIndex(row => row.key === key);
      if (sel < 0) throw new Error('missing Hue Sync row ' + key);
      render();
    }, key);
  }
  async function press(key) {
    await choose(key);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !busy);
  }
  try {
    await page.route('**/api/stats*', async route => {
      const response = await route.fetch();
      const stats = await response.json();
      delete stats.huesyncStreaming;
      delete stats.piccapCapture;
      if (piccapPresent) stats.piccapCapture = { running: piccapRunning, writable };
      if (present) stats.huesyncStreaming = { streaming, writable, diagnostics, settings };
      await route.fulfill({ json: stats });
    });
    await page.route('**/api/control', async route => {
      const command = route.request().postDataJSON();
      writes.push(command);
      if (!refuse) {
        if (command.action === 'huesyncSetting') settings[command.value.key] = command.value.value;
        if (command.action === 'huesync') streaming = command.value;
        if (command.action === 'piccap') piccapRunning = command.value;
      }
      await route.fulfill({ json: { ok: !refuse, error: refuse ? 'Synthetic failure' : undefined, settings } });
    });
    await page.goto(base + '/assets/dashboard.html?tab=ambient');
    await page.waitForFunction(() => rows.some(row => row.act === 'huesyncAdjust'));
    const categories = await page.evaluate(() => rows.filter(row => row.head).map(row => row.label));
    if (JSON.stringify(categories) !== JSON.stringify(['Hue Sync', 'PicCap'])) fail('integration categories are missing or in the wrong order');
    const labels = await page.evaluate(() => rows.filter(row => row.key === 'streaming' || row.key === 'piccap').map(row => row.label));
    if (JSON.stringify(labels) !== JSON.stringify(['Hue Sync Enabled', 'PicCap Enabled'])) fail('enabled labels are inconsistent');
    if (!(await page.evaluate(() => rows.find(row => row.key === 'piccap').hint)).includes('Hyperion or HyperHDR')) fail('PicCap hint omits a supported server');
    if (await page.locator('#rows img').count()) fail('area name was interpreted as markup');
    if (await page.evaluate(() => T().key) !== 'ambient') fail('ambient controls are not a top-level menu');
    for (const value of [false, true]) {
      await press('piccap');
      await page.waitForFunction(value => rows.some(row => row.key === 'piccap' && row.next === !value), value);
      if (writes[writes.length - 1].action !== 'piccap' || writes[writes.length - 1].value !== value || !streaming) fail('PicCap command changed Hue Sync');
    }
    await press('streaming');
    if (writes[writes.length - 1].action !== 'huesync' || writes[writes.length - 1].value !== false) fail('streaming command is wrong');
    await choose('brightness');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !adjusting && !adjustInFlight);
    const brightness = writes.filter(command => command.action === 'huesyncSetting' && command.value.key === 'brightness');
    if (!brightness.length || brightness[brightness.length - 1].value.value !== 61) fail('remote brightness adjustment sent the wrong final value');
    for (const [key, value] of [['intensity', 3], ['sync_mode', '1'], ['current_ec', 'area-example-b']]) {
      await press(key);
      const command = writes[writes.length - 1];
      if (command.action !== 'huesyncSetting' || command.value.key !== key || command.value.value !== value) fail('wrong native command for ' + key);
    }
    if (await page.evaluate(() => rows.some(row => row.key === 'huesyncMore') || sub !== null)) fail('More settings submenu remains');
    for (const [key, value] of [['background_lightning_video', false], ['background_lightning_games', true], ['auto_start', false], ['auto_start_notification', true]]) {
      await press(key);
      const command = writes[writes.length - 1];
      if (command.action !== 'huesyncSetting' || command.value.key !== key || command.value.value !== value) fail('wrong secondary command for ' + key);
    }
    refuse = true;
    await press('intensity');
    await page.waitForFunction(() => rows.some(row => row.key === 'intensity' && row.value === 'Extreme'));
    if (!(await page.locator('#flash').textContent()).includes('Synthetic failure')) fail('failed command had no short error');
    writable = false;
    await page.evaluate(() => fetchTab(true));
    await page.waitForFunction(() => rows.some(row => row.key === 'streaming' && !row.act) && rows.some(row => row.key === 'piccap' && !row.act));
    const count = writes.length;
    await press('streaming');
    await press('piccap');
    if (writes.length !== count) fail('read-only row sent a command');
    writable = true; diagnostics.busy = true;
    await page.evaluate(() => fetchTab(true));
    await page.waitForFunction(() => rows.some(row => row.key === 'brightness' && !row.act));
    await press('brightness');
    if (writes.length !== count) fail('busy row sent a command');
    present = false;
    await page.evaluate(() => fetchTab(true));
    await page.waitForFunction(() => rows.length === 2 && rows[0].head && rows[0].label === 'PicCap' && rows[1].key === 'piccap');
    piccapPresent = false;
    await page.evaluate(() => fetchTab(true));
    await page.waitForFunction(() => !TABS.some(section => section.key === 'ambient') && T().key !== 'ambient');
    if (await page.locator('#tabs [data-label="Ambient Light"]').count()) fail('the unavailable TV tab remained in navigation');
    await page.reload();
    await page.waitForFunction(() => !TABS.some(section => section.key === 'ambient') && T().key !== 'ambient');
    const emptyText = await page.locator('#rows').textContent();
    if (emptyText.includes('Hue Sync Enabled') || emptyText.includes('PicCap Enabled')) fail('an empty Ambient Light deep link left controls visible');
    present = true; streaming = false;
    await page.reload();
    await page.waitForFunction(() => rows.some(row => row.head && row.label === 'Hue Sync') && !rows.some(row => row.key === 'piccap'));
    if (await page.evaluate(() => T().key) !== 'ambient') fail('a stopped Hue Sync integration did not retain its TV tab');
    if (await page.evaluate(() => rows.some(row => row.head && row.label === 'PicCap'))) fail('missing PicCap left an empty category');
    present = false; piccapPresent = true; piccapRunning = false;
    await page.reload();
    await page.waitForFunction(() => rows.length === 2 && rows[1].key === 'piccap' && rows[1].next === true);
    if (await page.evaluate(() => T().key) !== 'ambient') fail('a stopped PicCap integration did not retain its TV tab');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
}

async function visitAdblockCards(browser, base, problems) {
  const page = await browser.newPage();
  const fail = message => problems.push('adblock cards: ' + message);
  page.on('pageerror', error => fail(error.message));
  let mode = 'ads';
  const writes = [];
  let acceptDialog = false;
  page.on('dialog', d => acceptDialog ? d.accept() : d.dismiss());
  try {
    await page.route('**/api/privacy', async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.adblock = { enabled: mode !== 'off', mode, custom: null };
      await route.fulfill({ json: data });
    });
    await page.route('**/api/control', async route => {
      const cmd = route.request().postDataJSON();
      if (cmd.action === 'setAdBlock') { writes.push(cmd.value); mode = cmd.value; }
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(base + '/?tab=privacy');
    await page.locator('#pv-adv > summary').click();
    await page.waitForSelector('#ab-cards #ab-ads.hm-card.on');
    if (await page.locator('#ab-cards button.hm-card').count() !== 3) fail('expected 3 tier cards');
    if (await page.locator('#ab-ads .ab-lrow').count() !== 3) fail('expected 3 ledger rows per card');
    await page.locator('#ab-off').click();
    await page.waitForFunction(() => document.getElementById('ab-off').classList.contains('on'));
    acceptDialog = true;
    await page.locator('#ab-full').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('ab-full');
      return el.classList.contains('on') && el.classList.contains('ab-warn');
    });
    await page.locator('#ab-ads').click();
    await page.waitForFunction(() => !document.getElementById('adblock-reconnect').hidden);
    if (JSON.stringify(writes) !== JSON.stringify(['off', 'full', 'ads'])) fail('unexpected tier writes: ' + JSON.stringify(writes));
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
}

/*
 * The remote's Motion mode, offered by the Android app's bridge alone: not
 * in a browser, nor where the phone has no gyroscope. Holding the pad reads
 * the turning each frame and moves the cursor against it (turned left, it
 * goes left), letting go stops reading, and a tap clicks.
 */
async function visitRemoteMotion(browser, base, problems) {
  const fail = what => problems.push('Remote motion: ' + what);
  const open = async bridge => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => fail(e.message));
    await page.addInitScript(bridge => {
      if (!bridge) return;
      window.__motion = { reads: [], started: 0, stopped: 0 };
      window.GlasshouseApp = {
        remoteState() {},
        motionAvailable: () => bridge.available,
        motionStart() { window.__motion.started++; },
        motionStop() { window.__motion.stopped++; },
        motionRead: () => window.__motion.reads.shift() || '0,0'
      };
    }, bridge);
    await page.goto(base + '/?view=remote');
    await page.waitForFunction(() => !document.getElementById('tab-control').hidden);
    // The pointer as a TV with LG's network input has it.
    await page.evaluate(() => applyPointerSettings({ enabled: true, transport: 'http' }));
    await page.waitForFunction(() => !document.getElementById('rp-mode-touch').hidden);
    return page;
  };
  const offered = page => page.evaluate(() => !document.getElementById('rp-mode-motion').hidden);
  for (const [label, bridge] of [['in a browser', null], ['without a gyroscope', { available: false }]]) {
    const page = await open(bridge);
    try {
      if (await offered(page)) fail('offered ' + label);
    } finally { await page.close(); }
  }
  const page = await open({ available: true });
  try {
    if (!await offered(page)) { fail('not offered in the app'); return; }
    await page.locator('#remote-modes [data-mode="motion"]').click();
    if (!await page.locator('#motion-pad').isVisible() || await page.locator('#pointer-pad').isVisible()) fail('Motion does not show its own pad');
    const held = await page.evaluate(async () => {
      const sent = [], moves = [];
      window.sendPointer = body => sent.push(body);
      window.queuePointerMove = (dx, dy) => moves.push([dx, dy]);
      const el = document.getElementById('motion-pad');
      const fire = type => el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
      const frames = n => new Promise(r => { const step = () => (--n ? requestAnimationFrame(step) : r()); requestAnimationFrame(step); });
      fire('pointerdown'); fire('pointerup');
      const clicks = sent.filter(b => b.click).length;
      // 0.05 rad left a frame, for ten frames: about 3 rad/s, a flick.
      window.__motion.reads = Array(10).fill('0.05,0');
      fire('pointerdown');
      await frames(14);
      fire('pointerup');
      const reads = window.__motion.reads.length;
      return { clicks, reads, dx: moves.reduce((n, m) => n + m[0], 0), dy: moves.reduce((n, m) => n + m[1], 0),
        clicked: sent.filter(b => b.click).length - clicks, started: window.__motion.started, stopped: window.__motion.stopped };
    });
    if (held.clicks !== 1) fail('a tap on the pad sent ' + held.clicks + ' clicks');
    if (held.reads) fail(held.reads + ' readings were left unread while held');
    if (held.dx > -300 || held.dy !== 0) fail('half a radian to the left moved the cursor ' + held.dx + ',' + held.dy);
    if (held.clicked) fail('turning while held clicked');
    if (held.started !== 2 || held.stopped !== 2) fail('the sensor started ' + held.started + ' and stopped ' + held.stopped + ' times for two holds');
  } finally { await page.close(); }
}

/*
 * The remote on its own (?view=remote, #1586): on a phone and in a wide
 * window, only playback, volume, the D-pad, the pointer where its
 * switch is on (Server, Advanced), the keyboard and the way back, in one column,
 * the D-pad and keyboard open, and the full dashboard's remembered tab left
 * alone; in the header's modal (embed=1), no masthead and no way back. The
 * header's Remote opens the modal over any tab with the page faded, Esc and
 * Back close it and empty its frame, and ?open= opens the keyboard.
 */
async function visitRemoteView(browser, base, problems) {
  const fail = what => problems.push('Remote view: ' + what);
  const shown = page => page.evaluate(() => {
    const vis = el => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
    return {
      cls: document.documentElement.classList.contains('remote-view'),
      // As they appear, top to bottom: the remote orders them with CSS.
      sets: Array.from(document.querySelector('#tab-control .col-controls').children).filter(vis)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map(el => el.id || el.className),
      vol: [document.getElementById('vol').textContent, document.getElementById('rp-vol').textContent],
      nav: vis(document.getElementById('sidenav')) || vis(document.querySelector('.nav-bar')),
      header: vis(document.querySelector('header')), button: vis(document.getElementById('hdr-remote')),
      cols: document.querySelectorAll('#tab-control .lcols').length,
      pointer: !document.getElementById('disc-pointer').hidden,
      tab: localStorage.getItem('tab'), shownPanels: Array.from(document.querySelectorAll('#panels > section')).filter(s => !s.hidden).map(s => s.id)
    };
  });
  for (const [label, path, viewport] of [['390', '/?view=remote', { width: 390, height: 844 }], ['1400', '/?view=remote', { width: 1400, height: 900 }],
                                         ['embed', '/?view=remote&embed=1', { width: 440, height: 880 }]]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => fail(label + ': ' + e.message));
    try {
      await page.addInitScript(() => { try { if (!localStorage.getItem('tab')) localStorage.setItem('tab', 'apps'); } catch (e) {} });
      await page.goto(base + path);
      await page.waitForFunction(() => !document.getElementById('tab-control').hidden);
      await page.waitForTimeout(300);
      const s = await shown(page);
      const embed = label === 'embed';
      const want = ['remote-pad', 'remote-modes'].concat(embed ? [] : ['remote-full']);
      if (!s.cls) fail(label + ': no remote-view class');
      if (JSON.stringify(s.sets) !== JSON.stringify(want)) fail(label + ': shows ' + JSON.stringify(s.sets) + ', not ' + JSON.stringify(want));
      if (s.nav) fail(label + ': the tabs are shown');
      if (s.header === embed) fail(label + ': masthead shown ' + s.header);
      if (s.button) fail(label + ': the header\'s Remote shows in the remote');
      if (s.cols) fail(label + ': in columns');
      if (s.vol[0] !== s.vol[1]) fail(label + ': the pad\'s volume says ' + s.vol[1] + ', the Control tab\'s ' + s.vol[0]);
      if (label === '390') {
        // Input: the sources in place of the buttons; Keyboard: the keyboard box; back to the buttons.
        await page.locator('#rp-input').click();
        const inputs = await shown(page);
        if (JSON.stringify(inputs.sets.slice(0, 2)) !== JSON.stringify(['remote-pad', 'control-source'])) fail('Input shows ' + JSON.stringify(inputs.sets));
        if (await page.locator('.rp-body').isVisible()) fail('Input left the buttons showing');
        await page.locator('#remote-modes [data-mode="keys"]').click();
        const keys = await shown(page);
        if (keys.sets.indexOf('disc-keyboard') === -1 || keys.sets.indexOf('control-source') !== -1) fail('Keyboard shows ' + JSON.stringify(keys.sets));
        await page.locator('#remote-modes [data-mode="buttons"]').click();
        if (!(await page.locator('.rp-ring').isVisible())) fail('Buttons left the D-pad hidden');
        if (await page.evaluate(() => localStorage.getItem('remoteMode')) !== 'buttons') fail('the mode is not kept');
        // In standby: Power on, everything else put aside, a line saying why; back on, as it was.
        const asleep = async on => page.evaluate(on => {
          const st = document.getElementById('state');
          st.classList.toggle('standby', on);
          st.classList.toggle('on', !on);
          return new Promise(r => setTimeout(() => r({
            label: document.getElementById('rp-screen-label').textContent,
            screen: document.getElementById('rp-screen').disabled,
            others: Array.from(document.querySelectorAll('#remote-pad button')).filter(b => b.id !== 'rp-screen' && !b.disabled).length,
            note: getComputedStyle(document.querySelector('.rp-asleep')).display !== 'none'
          }), 50));
        }, on);
        const off = await asleep(true);
        if (off.label !== 'Power on' || off.screen || off.others || !off.note) fail('in standby: ' + JSON.stringify(off));
        const back = await asleep(false);
        if (back.label !== 'Screen off' || back.others === 0 || back.note) fail('out of standby: ' + JSON.stringify(back));
        // The touchpad with fingers: a tap clicks, a drag moves further than a mouse would, two fingers scroll.
        const pad = await page.evaluate(() => {
          const sent = [], moves = [];
          window.sendPointer = body => sent.push(body);
          window.queuePointerMove = (dx, dy) => moves.push([dx, dy]);
          const el = document.getElementById('pointer-pad');
          const fire = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1,
            clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
          fire('pointerdown', 1, 100, 100); fire('pointerup', 1, 100, 100);
          const clicks = sent.filter(b => b.click).length;
          fire('pointerdown', 1, 100, 100);
          for (let i = 1; i <= 10; i++) fire('pointermove', 1, 100 + i * 10, 100);
          fire('pointerup', 1, 200, 100);
          const moved = moves.reduce((n, m) => n + m[0], 0);
          sent.length = 0;
          fire('pointerdown', 1, 100, 200); fire('pointerdown', 2, 160, 200);
          for (let i = 1; i <= 6; i++) { fire('pointermove', 1, 100, 200 - i * 10); fire('pointermove', 2, 160, 200 - i * 10); }
          fire('pointerup', 1, 100, 140); fire('pointerup', 2, 160, 140);
          const scrolled = sent.filter(b => b.scroll).reduce((n, b) => n + b.scroll.dy, 0);
          return { clicks, moved, scrolled, clicked: sent.filter(b => b.click).length };
        });
        if (pad.clicks !== 1) fail('a tap on the touchpad sent ' + pad.clicks + ' clicks');
        if (pad.moved <= 150) fail('a 100 px finger drag moved the cursor only ' + pad.moved + ' px');
        if (pad.scrolled < 2 || pad.clicked) fail('two fingers up 60 px scrolled ' + pad.scrolled + ' and clicked ' + pad.clicked);
      }
      if (s.tab !== 'apps') fail(label + ': the remembered tab became ' + s.tab);
      if (JSON.stringify(s.shownPanels) !== JSON.stringify(['tab-control'])) fail(label + ': panels shown ' + JSON.stringify(s.shownPanels));
    } finally {
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => fail('dashboard: ' + e.message));
  try {
    // The Android app's bridge, told while the remote shows.
    await page.addInitScript(() => { window.__app = []; window.GlasshouseApp = { remoteState: v => window.__app.push(v) }; });
    await page.goto(base + '/?tab=metrics');
    await page.waitForFunction(() => !document.getElementById('tab-metrics').hidden);
    if (await page.locator('#remote-full').isVisible()) fail('the remote\'s way back shows on the full dashboard');
    const modalState = () => page.evaluate(() => {
      const m = document.getElementById('remote-modal'), f = document.getElementById('remote-frame');
      let src = '';
      try { src = f ? f.contentWindow.location.href : 'none'; } catch (e) { src = 'unreadable'; }
      return { hidden: m.hidden, shown: m.classList.contains('shown'), src };
    });
    for (const how of ['Escape', 'back']) {
      await page.locator('#hdr-remote').click();
      await page.waitForFunction(() => document.getElementById('remote-modal').classList.contains('shown'));
      await page.waitForFunction(() => /view=remote/.test(document.getElementById('remote-frame').contentWindow.location.href));
      const open = await modalState();
      if (!/\?view=remote&embed=1$/.test(open.src)) fail('the modal\'s frame opens ' + JSON.stringify(open.src));
      await page.waitForFunction(() => {
        const f = document.getElementById('remote-frame'), d = f && f.contentDocument;
        return d && f.classList.contains('loaded') && d.documentElement.classList.contains('remote-embed') && !d.getElementById('tab-control').hidden;
      }, null, { timeout: 8000 }).catch(() => fail('the remote did not load in the modal'));
      if (how === 'Escape') {
        await page.evaluate(() => document.getElementById('hdr-remote').focus());
        await page.keyboard.press('Escape');
      } else {
        // The phone's or the browser's Back: one step through the history.
        await page.evaluate(() => history.back());
      }
      await page.waitForFunction(() => document.getElementById('remote-modal').hidden, null, { timeout: 3000 }).catch(() => {});
      const shut = await modalState();
      if (!shut.hidden || shut.src !== 'none') fail(how + ' left the modal ' + JSON.stringify(shut));
      if (!(await page.evaluate(() => !document.getElementById('tab-metrics').hidden))) fail(how + ' left the Metrics tab');
    }
    const told = await page.evaluate(() => window.__app.join(','));
    if (told !== 'true,false,true,false') fail('the app was told ' + JSON.stringify(told));
    await page.goto(base + '/?open=keyboard');
    await page.waitForFunction(() => !document.getElementById('tab-control').hidden);
    if (!(await page.evaluate(() => document.getElementById('disc-keyboard').open))) fail('?open=keyboard left the keyboard shut');
  } finally {
    await page.close();
  }
}

function groups(web, tv) {
  return [
    { job: 'tabs', tabs: web.map(t => ({ path: '/?tab=' + t, label: 'web ' + t })), visits: [visitHomeAnimations, visitHuesyncSettings, visitInputsAndRemote, visitBrightnessKeySettings, visitRemoteFolding, visitAdblockCards, visitSaverEntitySlots, visitRemoteView, visitRemoteMotion] },
    { job: 'tabs', tabs: tv.map(t => ({ path: '/assets/dashboard.html?tab=' + t, label: 'TV ' + t })),
      visits: [visitTvDashboard, visitTvAudio, visitTvPictureWrites, visitPictureUnavailable, visitTvNonOled, visitTvHuesync] },
    { job: 'home', tabs: [], visits: [visitHomePicture, visitHomePreview, visitHomePreviewOptions, visitHomePreviewWebos4, visitHomePreviewSize, visitHomePreviewSizeDetails, visitInputBarBehindHome, visitInputBarSwitchOnOk, visitHomeBarPrewarm, visitHomeBarIconsReady, visitHomeBarTiles, visitHomeBarHaTile, visitHomeBarBesideHome, visitHomeBarScroll, visitHaBar, visitHomeHaRow, visitHomeUpDown, visitHomeFolderKeys, visitHomePointerOff, visitHomeOrder, visitHomeAvailability, visitHomeSearch, visitHomeWeather, visitHomeWeatherSetting, visitHomeRemoteBattery, visitHomeRemoteBatterySetting] },
    { job: 'home', tabs: [], visits: [visitHomeArrangement, visitHomeVisibility, visitHomeColours, visitHomeInputsEditor, visitHomeEditor,
      visitHomeRecentsHidden, visitHomeSaverWake, visitHomeUploads, visitHomeShuffle, visitHomeLauncher, visitHomeReadiness, visitAudioOverride, visitHomeRecents, visitHomeGuide,
      visitHomeFadeAndInputs, visitHomeReturnOnce] },
    { job: 'home', tabs: [], visits: [visitHomeInternetTv, visitIptvChannels] },
    /*
     * Scrolling and motion read the row's place frame by frame, and missed
     * frames with the other groups sharing CI's four cores: 3 of 15 runs
     * failed on them after the groups went side by side (#1126). On CI they
     * have a machine to themselves; run with the rest, they wait for them.
     */
    { job: 'motion', tabs: [], visits: [visitHomeScrolling, visitHomeMotion], alone: true }
  ].filter(g => !process.env.CHECK_JOB || g.job === process.env.CHECK_JOB);
}

async function runGroup(browser, group, problems, after) {
  const server = await startServer();
  if (after) await after;
  const base = 'http://127.0.0.1:' + server.port;
  await visitAll(browser, group.tabs.map(t => ({ url: base + t.path, label: t.label })), problems);
  for (const visitOne of group.visits) await runVisit(visitOne, browser, base, problems);
}

// Each page on a slowed CPU, where CPU_SLOWDOWN asks for one.
function slowCpu(browser, rate) {
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    try { await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate }); } catch (e) {}
    return page;
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on('page', async p => {
      try { await (await context.newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate }); } catch (e) {}
    });
    return context;
  };
}

const flaky = [];
// A check run once more where it found a problem: see the top of this file.
/*
 * The longest one check may take. A step with no limit of its own, such as
 * page.evaluate or page.close on a page that stopped answering, once held the
 * home job until it was cancelled 15 minutes in, with nothing in the log to say
 * where. Each check's time is printed as it ends, so a stall shows by name.
 */
const VISIT_LIMIT_MS = 60000;

function withinLimit(promise, name) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('did not finish within ' + VISIT_LIMIT_MS / 1000 + ' s')), VISIT_LIMIT_MS);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function runVisit(visitOne, browser, base, problems) {
  let first = null;
  for (;;) {
    const found = [];
    const startedAt = Date.now();
    try { await withinLimit(visitOne(browser, base, found), visitOne.name); }
    catch (e) { found.push(visitOne.name + ': ' + String(e.message).split('\n')[0]); }
    console.log('  ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s  ' + visitOne.name + (found.length ? ' (problem)' : ''));
    if (!found.length) {
      if (first) flaky.push(visitOne.name + ' passed on a second try; the first found: ' + first.join('; '));
      return;
    }
    if (first) { problems.push(...found); return; }
    first = found;
  }
}

(async () => {
  const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  if (Number(process.env.CPU_SLOWDOWN) > 1) slowCpu(browser, Number(process.env.CPU_SLOWDOWN));
  const problems = [];
  const web = webTabs(), tv = tvTabs();
  const all = groups(web, tv);
  const together = Promise.all(all.filter(g => !g.alone).map(g => runGroup(browser, g, problems)));
  await Promise.all([together].concat(all.filter(g => g.alone).map(g => runGroup(browser, g, problems, together))));
  await browser.close();
  for (const f of flaky) console.log('flaky: ' + f);
  for (const p of problems) console.log(p);
  const opened = all.reduce((n, g) => n + g.tabs.length, 0);
  const checks = all.reduce((n, g) => n + g.visits.length, 0);
  console.log((process.env.CHECK_JOB ? process.env.CHECK_JOB + ': ' : '') + opened + ' tabs opened and ' + checks +
              ' checks run, ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's'));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
