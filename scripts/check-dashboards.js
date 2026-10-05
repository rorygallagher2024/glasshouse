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
  page.on('console', m => { if (m.type() === 'error') problems.push(label + ': console: ' + m.text()); });
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

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.port;
  const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  const problems = [];
  const web = webTabs(), tv = tvTabs();
  await visitAll(browser, web.map(t => ({ url: base + '/?tab=' + t, label: 'web ' + t }))
    .concat(tv.map(t => ({ url: base + '/assets/dashboard.html?tab=' + t, label: 'TV ' + t }))), problems);
  await browser.close();
  for (const p of problems) console.log(p);
  console.log((web.length + tv.length) + ' tabs opened (' + web.length + ' web, ' + tv.length + ' TV app), ' +
              problems.length + ' script error' + (problems.length === 1 ? '' : 's'));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
