/*
 * Motion: the phone aimed like a Magic Remote while the pad is held. Only the
 * Android app offers it: browsers give a page the gyroscope over https alone,
 * and the dashboard is served over http. The app reads the sensor between
 * motionStart() and motionStop(); motionRead() answers "yaw,pitch", the
 * radians the phone has turned left and tilted up since the last read.
 *
 * Loaded before controls.js, whose remote modes read motionApp; the pad
 * sends through its queuePointerMove and sendPointer.
 */
const motionApp = (() => {
  try {
    const app = window.GlasshouseApp;
    return app && typeof app.motionRead === 'function' && app.motionAvailable() ? app : null;
  } catch (e) { return null; }
})();
// TV pixels a radian: more the faster the phone turns, so a flick crosses the
// screen, and less below MOTION_STILL rad/s (a hand's tremor), so it holds still.
const MOTION_GAIN = 1100, MOTION_STILL = 0.08;
const motionGain = speed => MOTION_GAIN * (1 + Math.min(1.5, speed / 2)) * Math.min(1, speed / MOTION_STILL);
(function initMotionPad() {
  const pad = q('motion-pad');
  if (!pad || !motionApp) return;
  let held = null;
  const read = () => {
    const parts = String(motionApp.motionRead()).split(',');
    return { yaw: Number(parts[0]) || 0, pitch: Number(parts[1]) || 0 };
  };
  const step = now => {
    if (!held) return;
    const turn = read();
    const dt = Math.max(1, now - held.t) / 1000;
    held.t = now;
    const angle = Math.hypot(turn.yaw, turn.pitch);
    const gain = motionGain(angle / dt);
    held.turned += angle;
    held.carryX -= turn.yaw * gain;
    held.carryY -= turn.pitch * gain;
    const dx = held.carryX < 0 ? Math.ceil(held.carryX) : Math.floor(held.carryX);
    const dy = held.carryY < 0 ? Math.ceil(held.carryY) : Math.floor(held.carryY);
    if (dx || dy) {
      held.carryX -= dx;
      held.carryY -= dy;
      queuePointerMove(dx, dy);
    }
    held.frame = requestAnimationFrame(step);
  };
  const stop = cancelled => {
    if (!held) return;
    cancelAnimationFrame(held.frame);
    try { motionApp.motionStop(); } catch (e) {}
    // A tap: brief, and the phone barely turned (0.03 rad is under 2 degrees).
    const tap = !cancelled && held.turned < 0.03 && Date.now() - held.at < 300;
    held = null;
    pad.classList.remove('dragging');
    if (tap) sendPointer({ click: true });
  };
  pad.addEventListener('pointerdown', e => {
    if (e.button !== 0 || held) return;
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch (err) {}
    try { motionApp.motionStart(); } catch (err) { return; }
    read();
    held = { id: e.pointerId, carryX: 0, carryY: 0, turned: 0, at: Date.now(), t: performance.now(), frame: 0 };
    held.frame = requestAnimationFrame(step);
    pad.classList.add('dragging');
  });
  const end = cancelled => e => { if (held && e.pointerId === held.id) stop(cancelled); };
  pad.addEventListener('pointerup', end(false));
  pad.addEventListener('pointercancel', end(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(true); });
  window.addEventListener('pagehide', () => stop(true));
})();
