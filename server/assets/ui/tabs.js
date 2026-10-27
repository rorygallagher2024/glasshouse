// The tabs: a sidebar on a wide screen, a drawer on a narrow one.

/*
 * Tabs. The privacy and MQTT panels load on demand - privacy costs several Luna
 * calls, and two of those start the service they ask - so neither is fetched
 * until its tab is actually shown.
 */
const TABS = {
  control:     'tab-control',
  metrics:     'tab-metrics',
  apps:        'appspane',
  home:        'homepane',
  oledcare:    'oledpane',
  game:        'gamepane',
  audio:       'audiopane',
  servicemenu: 'svcpane',
  screensaver: 'sspane',
  privacy:     'privpane',
  advanced:    'advpane',
  mqtt:        'mqttpane',
  server:      'serverpane',
  tools:       'toolspane'
};
// Each tab's page on the docs site, for Help.
const DOCS = 'https://rorygallagher2024.github.io/glasshouse/';
const TAB_DOCS = {
  control: 'dashboard/control/', metrics: 'dashboard/metrics/', apps: 'dashboard/apps/', home: 'dashboard/home/',
  oledcare: 'dashboard/oled-care/', game: 'dashboard/game/', audio: 'dashboard/audio/', servicemenu: 'dashboard/service-menu/',
  screensaver: 'dashboard/screen-savers/', privacy: 'dashboard/privacy/', advanced: 'dashboard/advanced/',
  mqtt: 'HOME-ASSISTANT/', server: 'dashboard/server/', tools: 'dashboard/tools/'
};
let activeTab = null;

/*
 * The Android app puts the menu button in its own top bar, beside its back
 * button, and the page's menu bar hides. The app names itself in the user
 * agent and passes a bridge with navState; an older app has the bridge without
 * navState, and keeps the page's own bar.
 */
const appBridge = /Glasshouse-Android\//.test(navigator.userAgent) && window.GlasshouseApp &&
  typeof window.GlasshouseApp.navState === 'function' ? window.GlasshouseApp : null;
if (appBridge) document.documentElement.classList.add('in-app');

// Tells the app whether the tabs are a drawer here, the tab's name, and whether the drawer is open.
function reportNav() {
  if (!appBridge) return;
  const cur = q('nav-current');
  const nav = q('sidenav');
  appBridge.navState(navIsDrawer(), cur ? cur.textContent : '', !!nav && nav.classList.contains('open'));
}
// null until the first telemetry says either way.
let isOledSet = null;

function showTab(name) {
  clearErr();
  // The tab was System for a while, and links and remembered tabs still say so.
  if (name === 'system') name = 'metrics';
  if (!TABS[name]) name = 'control';
  /*
   * The panel is about the OLED panel, so an LCD set has no tab for it - but a
   * deep link or a remembered choice can still ask for it.
   *
   * Only turned away once the set has actually said it has no panel. The tab
   * button starts hidden and is revealed by the first telemetry, which lands
   * after a deep link is handled, so reading the button here would bounce
   * /?tab=oledcare off an OLED set every time.
   */
  if (name === 'oledcare' && isOledSet === false) name = 'control';
  if (name === 'home' && homeAvailable === false) name = 'control';
  activeTab = name;
  for (const [key, id] of Object.entries(TABS)) {
    const el = q(id);
    if (el) el.hidden = key !== name;
  }
  document.querySelectorAll('#tabs button').forEach(b => {
    const isSel = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(isSel));
    b.tabIndex = isSel ? 0 : -1;
  });
  showNavCurrent();
  const help = q('nav-help');
  if (help) help.href = DOCS + (TAB_DOCS[name] || 'dashboard/');
  closeNav();
  try { localStorage.setItem('tab', name); } catch (e) { /* private window */ }
  relayout(false);   // the panel just became measurable
  cfgPollStatus(name === 'mqtt');
  if (name === 'metrics') loadHdmiOnce();
  watchPolling(name === 'metrics');
  if (name === 'apps') { loadApps(); loadCatalog(false); pollInstall(); loadRestoredApps(); }
  if (name === 'server') checkOnOpen();
  if (name === 'server') loadTvApp();
  if (name === 'server') loadSsh();
  if (name === 'oledcare') loadOledCare();
  if (name === 'home') loadHome();
  if (name === 'audio') loadAudio();
  audioPolling(name === 'audio');
  gamePolling(name === 'game');
  if (name === 'advanced') { loadAdvSettings(); loadUpdate(); loadScreenTime(); }
  if (name === 'servicemenu') loadServiceMenu();
  if (name === 'screensaver') loadScreensavers();
  if (name === 'privacy') loadPrivacy();
  if (name === 'mqtt') loadSettings();
  // Opened at the newest line, wherever it was left scrolled.
  if (name === 'tools') { toolsAutoScroll = true; loadLogs(); scheduleToolsPoll(); loadLogForwarding(); }
  else if (typeof scheduleToolsPoll === 'function') { scheduleToolsPoll(); }
}

document.querySelectorAll('#tabs button').forEach(b =>
  b.addEventListener('click', () => showTab(b.dataset.tab)));
const tabsNav = q('tabs');
if (tabsNav) {
  tabsNav.addEventListener('keydown', e => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) === -1) return;
    const tabs = Array.from(tabsNav.querySelectorAll('button:not([hidden])'));
    const idx = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    let nextIdx = idx;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabs.length - 1;
    e.preventDefault();
    tabs[nextIdx].focus();
    // Only moves focus while the drawer is open: choosing closes it.
    if (!navIsDrawer()) showTab(tabs[nextIdx].dataset.tab);
  });
}
// Reveals the Game tab on TVs with LG's Game Optimizer, and Home where Glasshouse Home is offered.
loadGame();
loadHomeAvailable();

// The menu bar names the tab on show, in the page's language: the strings are
// put in at DOMContentLoaded, after the first showTab.
function showNavCurrent() {
  const sel = document.querySelector('#tabs button[aria-selected="true"] span');
  const cur = q('nav-current');
  if (sel && cur) cur.textContent = sel.textContent;
  reportNav();
}
document.addEventListener('DOMContentLoaded', showNavCurrent);

function navIsDrawer() {
  // In the app the bar is always hidden, so the bar's own rules are asked directly.
  if (appBridge) {
    return matchMedia('(max-width:1023px)').matches || document.documentElement.classList.contains('nav-hidden');
  }
  const bar = document.querySelector('.nav-bar');
  return !!bar && getComputedStyle(bar).display !== 'none';
}

function openNav() {
  const nav = q('sidenav');
  if (!nav || !navIsDrawer()) return;
  nav.classList.add('open');
  q('nav-backdrop').hidden = false;
  q('nav-toggle').setAttribute('aria-expanded', 'true');
  document.body.classList.add('nav-open');
  const sel = nav.querySelector('button[aria-selected="true"]') || nav.querySelector('.tabs button:not([hidden])');
  if (sel) sel.focus();
  reportNav();
}

function closeNav() {
  const nav = q('sidenav');
  if (!nav || !nav.classList.contains('open')) return;
  nav.classList.remove('open');
  q('nav-backdrop').hidden = true;
  q('nav-toggle').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('nav-open');
  q('nav-toggle').focus();
  reportNav();
}

// Whether a wide screen lists the tabs down the left, kept per browser.
function setSidebar(mode) {
  const hide = mode === 'hide';
  closeNav();
  document.documentElement.classList.toggle('nav-hidden', hide);
  try { localStorage.setItem('sidebar', hide ? 'hide' : 'show'); } catch (e) { /* private window */ }
  document.querySelectorAll('[data-sidebar-set]').forEach(b => {
    const on = b.dataset.sidebarSet === (hide ? 'hide' : 'show');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  reportNav();
}
document.querySelectorAll('[data-sidebar-set]').forEach(b =>
  b.addEventListener('click', () => setSidebar(b.dataset.sidebarSet)));
(function initSidebar() {
  let stored = null;
  try { stored = localStorage.getItem('sidebar'); } catch (e) { /* private window */ }
  setSidebar(stored === 'hide' ? 'hide' : 'show');
})();

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
// Widened past the drawer while it was open: the sidebar is simply there.
window.addEventListener('resize', () => { if (!navIsDrawer()) closeNav(); reportNav(); });
