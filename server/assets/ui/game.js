// The Game tab.

/* ---- game tab --------------------------------------------------------
   LG's Game Optimizer: its settings from /api/game, and the live frame rate
   from /api/game/fps, polled once a second only while the tab is open. The
   server holds the input binding only while it is being asked. */
let gameTimer = null;

// An input by the name it was given, or its port when it has none.
function inputName(port) {
  const name = lastInputNames[port];
  const bare = port.toUpperCase().replace(/(\d)$/, ' $1');
  return name && name.replace(/\s/g, '').toLowerCase() !== port ? name + ' (' + bare + ')' : bare;
}

async function loadGame() {
  let d;
  try { d = await (await fetch(api('/api/game'), { cache: 'no-store' })).json(); } catch (e) { return; }
  if (q('tab-btn-game')) q('tab-btn-game').hidden = !d.available;
  if (!d.available) return;
  // LG reports "none" while the TV is not on an input it games on.
  const where = d.input && d.input !== 'none' ? inputName(d.input.toLowerCase()) : '';
  q('gm-scope').textContent = (where ? t('game.scope', 'LG keeps these for each input and genre. Showing {input}.', { input: where }) : '') +
    (d.pictureMode && d.pictureMode !== 'game' ? ' ' + t('game.notGameMode', 'They apply while the picture mode is Game Optimizer.') : '');
  q('game-rows').innerHTML = d.rows.map(r =>
    '<div class="oled-row"><div><div class="oled-name">' + esc(r.title) + '</div>' +
    '<div class="oled-desc">' + esc(r.desc) + '</div></div><div class="oled-ctl">' + lgsControl(r) + '</div></div>').join('');
}

async function pollFps() {
  let d;
  try { d = await (await fetch(api('/api/game/fps'), { cache: 'no-store' })).json(); } catch (e) { return; }
  const f = (d && d.fps) || {};
  const vrr = f.vrrType && f.vrrType !== 'off';
  // Without VRR the TV's reading is the signal's fixed rate, not the game's.
  const hz = !vrr && f.frameRate > 0 ? [null, Math.round(f.frameRate)] : null;
  if (vrr && f.frameRate > 0) {
    q('gm-lbl').textContent = t('game.frameRate', 'Frame rate');
    q('gm-fps').textContent = Math.round(f.frameRate);
    q('gm-unit').textContent = 'fps';
    q('gm-note').textContent = '';
  } else if (hz) {
    q('gm-lbl').textContent = t('game.refreshRate', 'Refresh rate');
    q('gm-fps').textContent = hz[1];
    q('gm-unit').textContent = 'Hz';
    q('gm-note').textContent = t('game.noVrr', 'The frame rate shows here while a game uses VRR.');
  } else {
    q('gm-lbl').textContent = t('game.frameRate', 'Frame rate');
    q('gm-fps').textContent = '\u2014';
    q('gm-unit').textContent = '';
    q('gm-note').textContent = t('game.nothing', 'Nothing is playing on an HDMI input.');
  }
  q('gm-fps').parentElement.classList.toggle('empty', !(vrr && f.frameRate > 0) && !hz);
  q('gm-vrr').textContent = vrr ? f.vrrType.toUpperCase() : t('common.off', 'Off');
  q('gm-input').textContent = f.port ? inputName(f.port.toLowerCase()) : '\u2014';
}

function gamePolling(on) {
  clearInterval(gameTimer);
  gameTimer = null;
  if (!on) return;
  loadGame();
  pollFps();
  gameTimer = setInterval(pollFps, 1000);
}
