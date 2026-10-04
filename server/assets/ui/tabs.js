// The tab bar.

/*
 * Tabs. The privacy and MQTT panels load on demand - privacy costs several Luna
 * calls, and two of those start the service they ask - so neither is fetched
 * until its tab is actually shown.
 */
const TABS = {
  control:     'tab-control',
  metrics:     'tab-metrics',
  apps:        'appspane',
  oledcare:    'oledpane',
  game:        'gamepane',
  servicemenu: 'svcpane',
  screensaver: 'sspane',
  privacy:     'privpane',
  mqtt:        'mqttpane',
  server:      'serverpane',
  advanced:    'advpane'
};
let activeTab = null;
let ssHeld = false;   // see checkScreensaverTab
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
  if (name === 'screensaver' && ssHeld) name = 'control';
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
  const selected = document.querySelector('#tabs button[aria-selected="true"]');
  if (selected && selected.scrollIntoView) selected.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  try { localStorage.setItem('tab', name); } catch (e) { /* private window */ }
  relayout(false);   // the panel just became measurable
  cfgPollStatus(name === 'mqtt');
  if (name === 'metrics') loadHdmiOnce();
  if (name === 'apps') { loadApps(); loadCatalog(false); pollInstall(); }
  if (name === 'server') checkOnOpen();
  if (name === 'server') loadTvApp();
  if (name === 'oledcare') loadOledCare();
  gamePolling(name === 'game');
  if (name === 'advanced') loadAdvSettings();
  if (name === 'servicemenu') loadServiceMenu();
  if (name === 'screensaver') loadScreensavers();
  if (name === 'privacy') loadPrivacy();
  if (name === 'mqtt') loadSettings();
}

document.querySelectorAll('#tabs button').forEach(b =>
  b.addEventListener('click', () => showTab(b.dataset.tab)));
const tabsNav = q('tabs');
if (tabsNav) {
  tabsNav.addEventListener('keydown', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) === -1) return;
    const tabs = Array.from(tabsNav.querySelectorAll('button:not([hidden])'));
    const idx = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    let nextIdx = idx;
    if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabs.length - 1;
    e.preventDefault();
    tabs[nextIdx].focus();
    showTab(tabs[nextIdx].dataset.tab);
  });
}
// Reveals the Game tab on TVs with LG's Game Optimizer.
loadGame();

/* Where custom screen savers are held back (#366) the tab has nothing to offer
   once LG's is in use. Shown until the server says so, as every other TV has it. */
(async function checkScreensaverTab() {
  let d;
  try { d = await (await fetch(api('/api/screensaver'), { cache: 'no-store' })).json(); } catch (e) { return; }
  ssHeld = !!(d && d.available === false);
  q('tab-btn-screensaver').hidden = ssHeld;
  if (ssHeld && activeTab === 'screensaver') showTab('control');
})();

/*
 * Each arrow shows only while the strip has more that way. Tabs appear after
 * the first telemetry - OLED Care and the service menu - and the row reflows
 * on resize, so this is called from both as well as on scroll.
 */
function updateTabArrows() {
  const strip = q('tabs'), prev = q('tabs-prev'), next = q('tabs-next');
  if (!strip || !prev || !next) return;
  const max = strip.scrollWidth - strip.clientWidth;
  prev.hidden = strip.scrollLeft <= 1;
  next.hidden = strip.scrollLeft >= max - 1;
}

function scrollTabs(dir) {
  const strip = q('tabs');
  strip.scrollBy({ left: dir * Math.max(140, strip.clientWidth * 0.6), behavior: 'smooth' });
}

q('tabs').addEventListener('scroll', updateTabArrows);
window.addEventListener('resize', updateTabArrows);
updateTabArrows();
