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
async function visitHomePreviewOptions(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home preview options: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: ['one'], hintSeen: true, searchHintSeen: true,
    livePreview: true, previewAlways: false, previewInTile: false, picture: false };
  let version = 1, now = { kind: 'input', port: 1 }, covered = false;
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
    if (url.pathname.endsWith('/signal')) return reply({ ok: true, signal: true });
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
    const pv = document.getElementById('preview'), tile = pv.parentNode.closest && pv.parentNode.closest('.tile');
    return tile ? tile.querySelector('.nm').textContent : pv.parentNode.id;
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
  const reply = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/home/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/home/now') return reply(route, { kind: 'input', port: 1, title: 'Player' });
    if (pathname === '/api/home/catalogue') {
      const body = { ok: true, layout, layoutVersion: String(version), apps: [],
        devices: [{ id: 'player', name: 'Player', port: 1, address: '1.0.0.0' }], channels: [],
        sources: { channels: 0 }, order: { app: ['lg-home'], dev: ['player'], ch: [] } };
      const snapshot = JSON.parse(JSON.stringify(body));
      releaseCatalogue = () => reply(route, snapshot);
      return;
    }
    return reply(route, { ok: true, build: 'one', layoutVersion: String(version) });
  });
  async function check(shown) {
    const actual = await page.evaluate(() => ({
      source: document.getElementById('srcTitle').textContent.trim(),
      last: !!document.querySelector('.tile.dev.last'),
      count: !!document.querySelector('[data-key="app"] h2 span'),
      cec: document.querySelector('.tile.dev .st span').textContent.trim(),
      clock: document.getElementById('clock').getBoundingClientRect().left
    }));
    if (actual.source !== (shown ? 'Player' : '') || actual.last !== shown || actual.count !== shown ||
        actual.cec !== (shown ? 'CEC 1.0.0.0' : '')) {
      problems.push('Home visibility: details did not follow the loaded switches: ' + JSON.stringify(actual));
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

// Glasshouse Home's fading and its Inputs row without the inputs that have
// nothing plugged in, each where the layout asks for it.
async function visitHomeFadeAndInputs(browser, base, problems) {
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push('Home fade: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true, colours: null, fade: false, hideUnused: true };
  let version = 1;
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
      : { ok: true, build: 'one', layoutVersion: String(version) };
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
    holdCatalogue = new Promise(r => { releaseRows = r; });
    await visible(false);
    await page.waitForTimeout(1000);
    if (await faded()) problems.push('Home fade: a slow refresh kept the view dark');
    releaseRows();
    holdCatalogue = null;
    await page.waitForTimeout(200);

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
    const row = page.locator('details.home-row[data-kind="dev"]');
    await row.locator('summary').click();
    await row.locator('.home-tile').first().waitFor();
    if (await row.locator('button#home-hide-unused.pill').count() !== 1) problems.push('Home inputs editor: the Inputs row has no On and Off switch for inputs with nothing connected');
    const toggles = await row.locator('.home-tile').getByText(/^(Shown|Hidden)$/).count();
    if (toggles !== 2) problems.push('Home inputs editor: inputs did not each offer show or hide beside the switch (' + toggles + ')');
    await row.locator('#home-hide-unused').click();
    const until = Date.now() + 5000;
    while (Date.now() < until && !/Left out/.test(await row.textContent())) await page.waitForTimeout(100);
    if (!saves.some(p => p.hideUnused === true)) problems.push('Home inputs editor: the switch did not save hideUnused');
    const out = await row.locator('.home-tile').filter({ hasText: 'HDMI 2' }).getByText('Left out').count();
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
    hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true
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

async function visitHomeOrder(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => problems.push('Home order: ' + e.message));
  const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] },
    sort: { app: 'custom', dev: 'custom', ch: 'custom' }, hidden: { app: [], dev: [], ch: [] }, channels: [], hintSeen: true, searchHintSeen: true };
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
    if (await appRows.first().locator('[translate="no"]').textContent() !== 'One') problems.push('Home editor: refused move remained visible');
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
  let kept = [], chosen = null, launcherUpload = true;
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
    } else if (pathname === '/api/home') {
      body = { ok: true, supported: { ok: true }, installed: true, enabled: true, active: true, writable: true, layout,
        launchers: status(), launcherUpload, wallpapers: { choices: ['black'], choice: 'black', slots: {} } };
    } else {
      body = { ok: true, layout, apps: [], devices: [], channels: [], order: { app: [], dev: [], ch: [] }, sources: { channels: 0 } };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const keptRow = title => page.locator('#home-launchers .prot-row', { hasText: title });
  const stateNames = re => page.waitForFunction(r => new RegExp(r).test(document.getElementById('home-state').textContent), re.source);
  const marked = async id => /\bon\b/.test(await page.locator('#' + id).getAttribute('class'));
  try {
    await page.goto(base + '/?tab=home');
    await page.waitForFunction(() => typeof homeStatus !== 'undefined' && homeStatus && document.getElementById('home-mode-minimal').textContent === 'Glasshouse Minimal');
    const names = await page.locator('#home-mode-btns button').allTextContents();
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
    { name: 'Glasshouse Home on', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true) }, glasshouse: true },
    // webOS 5 and 6, where each switch restarts the app manager: their note shows there only.
    { name: 'webOS 6', st: { available: true, enabled: true, lgHomeAvailable: true, lgHome: lgHome(true),
      supported: { ok: true, experimental: true, restartsApps: true } }, glasshouse: true }
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
      if (await page.locator('#disc-system-tiles').isVisible() === c.glasshouse) fail('system apps ' + (c.glasshouse ? 'shown with Glasshouse Home on' : 'missing'));
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
    if (names[0] !== 'BBC News' || names[2] !== 'Guide') fail('row names ' + JSON.stringify(names));
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
    await key(461);
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

    await key(13);
    await page.waitForSelector('#player.list');
    if (!/list/.test(await page.locator('#player').getAttribute('class'))) fail('OK in the player did not open the channel list');
    const releasedBefore = await page.evaluate(() => window.released);
    await key(40);
    await key(13);
    await page.waitForFunction(() => window.played.includes('http://s.test/x2.m3u8'));
    if (streams[streams.length - 1] !== 'x2') fail('choosing a channel in the list did not play it');
    if (await page.evaluate(() => window.released) <= releasedBefore) fail('the last stream was not released before the next');
    const asked = trace.lastIndexOf('request x2'), playedNext = trace.lastIndexOf('play http://s.test/x2.m3u8');
    const releasedAt = trace.slice(0, asked).lastIndexOf('release'), lastOld = trace.slice(0, asked).lastIndexOf('play http://s.test/x1.m3u8');
    if (!(releasedAt > lastOld && asked > releasedAt && playedNext > asked)) fail('the channel change did not release, then ask, then play: ' + trace.slice(-6).join(', '));
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
    await key(461);
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
    else if (!/UK News/.test(await page.locator('#adItems').textContent())) fail('the add panel did not list the playlist\'s groups');
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
    await key(461);
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
    if (await page.locator('.row[data-key="iptv"] .tile .nm').first().textContent() !== 'Guide') fail('a lineup without favourites has no Guide tile');
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
  let writable = true, supported = true, refuse = false;
  const writes = [];
  try {
    await page.route('**/api/stats*', async route => {
      const response = await route.fetch();
      const stats = await response.json();
      stats.huesyncStreaming = { streaming: true, writable, diagnostics, settings: supported ? settings : {} };
      await route.fulfill({ json: stats });
    });
    await page.route('**/api/control', async route => {
      const command = route.request().postDataJSON();
      writes.push(command);
      if (command.action === 'huesyncSetting' && !refuse) settings[command.value.key] = command.value.value;
      await route.fulfill({ json: { ok: !refuse, settings } });
    });
    await page.goto(base + '/?tab=advanced');
    await page.waitForSelector('#huesync-settings:not([hidden])');
    if (await page.locator('#huesync-current_ec option').first().textContent() !== settings.ec_list[0].name) fail('area name was not rendered as text');
    if (await page.locator('#huesync-settings img').count()) fail('area markup was interpreted');
    const changes = [
      ['brightness', 60], ['intensity', 3], ['sync_mode', '0'], ['current_ec', 'area-b'],
      ['background_lightning_video', false], ['background_lightning_games', true], ['auto_start', true], ['auto_start_notification', false]
    ];
    for (const [key, value] of changes) {
      const element = page.locator('#huesync-' + key);
      if (typeof value === 'boolean') await element.setChecked(value);
      else if (key === 'brightness') { await element.fill(String(value)); await element.dispatchEvent('change'); }
      else await element.selectOption(String(value));
      await page.waitForFunction(() => !huesyncSettingsBusy);
      const command = writes[writes.length - 1];
      if (!command || command.action !== 'huesyncSetting' || command.value.key !== key || command.value.value !== value) fail('wrong command for ' + key);
    }
    refuse = true;
    await page.locator('#huesync-brightness').fill('10');
    await page.locator('#huesync-brightness').dispatchEvent('change');
    await page.waitForFunction(() => !huesyncSettingsBusy);
    if (await page.locator('#huesync-brightness').inputValue() !== '60') fail('a refused write left an optimistic value visible');
    settings._stale = ['brightness'];
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#huesync-brightness').disabled);
    if (!(await page.locator('#row-huesync-brightness').isVisible())) fail('a temporary failure removed the supported control');
    delete settings._stale;
    diagnostics.busy = true;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#btn_huesync').disabled && document.querySelector('#huesync-auto_start').disabled);
    diagnostics.busy = false;
    diagnostics.bridge.Authorized = false;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#huesync-readiness').textContent.includes('authorization'));
    diagnostics.bridge.Authorized = true;
    writable = false;
    await page.evaluate(() => tick());
    await page.waitForFunction(() => document.querySelector('#huesync-brightness').disabled);
    supported = false;
    await page.evaluate(() => tick());
    await page.waitForSelector('#huesync-settings[hidden]', { state: 'attached' });
  } finally { await page.close(); }
}

function groups(web, tv) {
  return [
    { job: 'tabs', tabs: web.map(t => ({ path: '/?tab=' + t, label: 'web ' + t })), visits: [visitHomeAnimations, visitHuesyncSettings] },
    { job: 'tabs', tabs: tv.map(t => ({ path: '/assets/dashboard.html?tab=' + t, label: 'TV ' + t })),
      visits: [visitTvDashboard, visitTvAudio, visitTvPictureWrites, visitPictureUnavailable, visitTvNonOled] },
    { job: 'home', tabs: [], visits: [visitHomePicture, visitHomePreview, visitHomePreviewOptions, visitHomeOrder, visitHomeAvailability, visitHomeSearch, visitHomeWeather, visitHomeWeatherSetting] },
    { job: 'home', tabs: [], visits: [visitHomeArrangement, visitHomeVisibility, visitHomeColours, visitHomeInputsEditor, visitHomeEditor,
      visitHomeRecentsHidden, visitHomeUploads, visitHomeLauncher, visitHomeReadiness, visitAudioOverride, visitHomeRecents, visitHomeGuide,
      visitHomeFadeAndInputs] },
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
