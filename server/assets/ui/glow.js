/*
 * Screen glow: the top of the dashboard takes a soft light from the colours
 * on the TV's screen, left and right, as a room does from the TV. Off until
 * switched on, under Preferences or with the footer's button, kept per
 * browser, and offered only where the Server tab allows it and the TV has a
 * capture service. Read from /api/screen-colour every few seconds, only while
 * the page shows and the screen is on, and not while the source says a game
 * is playing (ALLM), so a game's frames are left alone, nor while PicCap or
 * Hue Sync is capturing the screen itself. LG's Game picture mode alone does
 * not stop it: a computer is often shown in it for its low latency. Given up
 * for the visit after three failed reads.
 */
const GLOW_KEY = 'glasshouse.glow';
const GLOW_MS = 3000;
let glowWanted = false;   // this browser's choice
let glowAllowedHere = false;   // the Server tab's
let glowTimer = null;
let glowFails = 0;
let glowGame = false;
let glowReady = false;

try {
  // ?glow=1 and ?glow=0 still switch it, for a link or a kiosk.
  const p = new URLSearchParams(location.search).get('glow');
  if (p === '1') localStorage.setItem(GLOW_KEY, '1');
  if (p === '0') localStorage.removeItem(GLOW_KEY);
  glowWanted = localStorage.getItem(GLOW_KEY) === '1';
} catch (e) { glowWanted = false; }

function glowSetup() {
  if (glowReady) return true;
  if (!window.CSS || !CSS.registerProperty) return false;
  // Registered as colours, so a change of colour fades rather than jumps.
  ['--glow-l', '--glow-r'].forEach(name => {
    try { CSS.registerProperty({ name, syntax: '<color>', inherits: true, initialValue: 'transparent' }); } catch (e) {}
  });
  const el = document.createElement('div');
  el.id = 'screen-glow';
  el.setAttribute('aria-hidden', 'true');
  document.body.prepend(el);
  document.addEventListener('visibilitychange', glowSchedule);
  glowReady = true;
  return true;
}

function glowActive() { return glowWanted && glowAllowedHere && glowFails < 3; }

function glowRender() {
  const btn = q('glow-toggle');
  if (btn) {
    btn.hidden = !glowAllowedHere || !(window.CSS && CSS.registerProperty);
    btn.setAttribute('aria-pressed', glowWanted ? 'true' : 'false');
    const label = glowWanted ? t('glow.toggleOff', 'Screen glow: on (click to switch off)') : t('glow.toggleOn', 'Screen glow: off (click to light the page from the TV’s screen)');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  // Preferences' Off and On, the same choice as the footer's button.
  const pref = q('nav-pref-glow');
  if (pref) pref.hidden = !glowAllowedHere || !(window.CSS && CSS.registerProperty);
  document.querySelectorAll('[data-glow-set]').forEach(b => {
    const on = (b.dataset.glowSet === 'on') === glowWanted;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (glowActive() && glowSetup()) document.documentElement.classList.add('glow');
  else glowFade();
}

// From the Server tab's summary (update.js renderUpdate).
function glowAllowed(on) {
  glowAllowedHere = !!on;
  glowRender();
  glowSchedule();
}

document.querySelectorAll('[data-glow-set]').forEach(b => b.addEventListener('click', () => {
  if ((b.dataset.glowSet === 'on') !== glowWanted) toggleGlow();
}));

function toggleGlow() {
  glowWanted = !glowWanted;
  glowFails = 0;
  try {
    if (glowWanted) localStorage.setItem(GLOW_KEY, '1'); else localStorage.removeItem(GLOW_KEY);
  } catch (e) {}
  glowRender();
  glowSchedule(true);
}

// From each reading of the stats (readouts.js tick): whether the source says a game is playing.
function glowNoteStats(d) {
  glowGame = !!(d.signal_format && d.signal_format.game_mode);
}

function glowFade() {
  const root = document.documentElement;
  root.style.setProperty('--glow-l', 'transparent');
  root.style.setProperty('--glow-r', 'transparent');
}

function glowSchedule(now) {
  clearTimeout(glowTimer);
  glowTimer = null;
  if (!glowActive() || document.hidden) return;
  glowTimer = setTimeout(glowTick, now ? 0 : GLOW_MS);
}

/*
 * A side's colour as a glow: its hue, at least half saturated, at a fixed
 * brightness, so a dim picture still gives a colour rather than near black.
 * Grey stays grey. How strong it shows is the picture's brightness, as alpha.
 */
function glowRgb(c, a) {
  if (!c) return 'transparent';
  const max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]);
  if (!max) return 'transparent';
  const sat = (max - min) / max;
  const s = sat < 0.08 ? sat : Math.max(sat, 0.5), v = 0.9;
  // Each channel's place between the brightest and the dimmest, at the new saturation and brightness.
  const ch = x => Math.round(255 * v * (1 - s * (max - x) / ((max - min) || 1)));
  const rgb = sat < 0.08 ? [255 * v, 255 * v, 255 * v].map(Math.round) : c.map(ch);
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

async function glowTick() {
  const st = q('state');
  if (!st || !st.classList.contains('on') || glowGame) {
    glowFade();
    return glowSchedule();
  }
  try {
    const d = await (await fetch(api('/api/screen-colour'), { cache: 'no-store' })).json();
    // Switched off on the Server tab, or the TV has no capture service: the switches go.
    if (d && (d.off || d.unsupported)) { glowAllowed(false); return; }
    // PicCap or Hue Sync is capturing: no glow until it stops, and no failure.
    if (d && d.busy) glowFade();
    else if (!d || !d.ok) glowFails++;
    else {
      glowFails = 0;
      // Stronger on a bright picture, and nothing from a dark one.
      const a = Math.min(0.9, 0.35 + d.light);
      const root = document.documentElement;
      root.style.setProperty('--glow-l', glowRgb(d.left, a));
      root.style.setProperty('--glow-r', glowRgb(d.right, a));
    }
  } catch (e) { glowFails++; }
  if (!glowActive()) glowFade();
  glowSchedule();
}
