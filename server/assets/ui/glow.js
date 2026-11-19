/*
 * The screen's glow (a proof of concept): the top of the dashboard takes a
 * soft light from the colours on the TV's screen, left and right, as a room
 * does from the TV. Off unless switched on with ?glow=1 (?glow=0 switches it
 * off again); kept per browser. Read every few seconds from /api/screen-colour,
 * only while the page shows and the screen is on, and given up for the visit
 * where the TV gives no capture.
 */
const GLOW_KEY = 'glasshouse.glow';
const GLOW_MS = 3000;
let glowOn = false;
let glowTimer = null;
let glowFails = 0;

(function glowSetup() {
  try {
    const p = new URLSearchParams(location.search).get('glow');
    if (p === '1') localStorage.setItem(GLOW_KEY, '1');
    if (p === '0') localStorage.removeItem(GLOW_KEY);
    glowOn = localStorage.getItem(GLOW_KEY) === '1';
  } catch (e) { glowOn = false; }
  if (!glowOn || !window.CSS || !CSS.registerProperty) return;
  // Registered as colours, so a change of colour fades rather than jumps.
  ['--glow-l', '--glow-r'].forEach(name => {
    try { CSS.registerProperty({ name, syntax: '<color>', inherits: true, initialValue: 'transparent' }); } catch (e) {}
  });
  document.documentElement.classList.add('glow');
  const el = document.createElement('div');
  el.id = 'screen-glow';
  el.setAttribute('aria-hidden', 'true');
  document.body.prepend(el);
  document.addEventListener('visibilitychange', glowSchedule);
  glowSchedule();
})();

function glowSchedule() {
  clearTimeout(glowTimer);
  if (!glowOn || document.hidden || glowFails >= 3) return;
  glowTimer = setTimeout(glowTick, glowTimer === null ? 0 : GLOW_MS);
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
  const on = st && st.classList.contains('on');
  const root = document.documentElement;
  if (!on) {
    root.style.setProperty('--glow-l', 'transparent');
    root.style.setProperty('--glow-r', 'transparent');
    return glowSchedule();
  }
  try {
    const d = await (await fetch(api('/api/screen-colour'), { cache: 'no-store' })).json();
    if (!d || !d.ok) glowFails++;
    else {
      glowFails = 0;
      // Brighter on a bright picture, and nothing from a dark one.
      const a = Math.min(0.9, 0.35 + d.light);
      root.style.setProperty('--glow-l', glowRgb(d.left, a));
      root.style.setProperty('--glow-r', glowRgb(d.right, a));
    }
  } catch (e) { glowFails++; }
  glowSchedule();
}
