// The readouts, the app launcher and tick(), the 2s telemetry poll that fills them.

/* Level is carried by fill and opacity, never by hue - so "hi" is a state
   class that brightens the row rather than turning it red. */
const ROWS = [
  { k: 'cpu',   label: t('metrics.processor', 'Processor'), warn: 85 },
  { k: 'mem',   label: t('metrics.memory', 'Memory'),       warn: 90 },
  { k: 'swap',  label: t('metrics.swap', 'Swap'),           warn: 70 },
  /* Throughput has no threshold to cross - warn: 101 was the tell. A level
     hue on it would be a lie, and the fixed blue it used to carry read as
     level anyway, sitting in a column where every other bar meant exactly
     that. Its domain shows on the unit instead. */
  { k: 'net',   label: t('metrics.network', 'Network'),    warn: 101, flat: true }
];
const FLAT = Object.fromEntries(ROWS.map(r => [r.k, !!r.flat]));

/*
 * The hero stays white through the whole normal operating band, and only takes
 * colour when something is actually wrong. Colouring an ordinary reading just
 * trains you to ignore it.
 *
 * Observed on this panel: ~37C idle, ~61C sustained during Dolby Vision
 * playback. 75C therefore leaves real headroom above anything seen in normal
 * use, so amber means "worth a look" rather than "business as usual".
 */
var TEMP_WARN = 75, TEMP_CRIT = 85;
function thermal(deg) {
  if (deg >= TEMP_CRIT) return 'var(--red)';
  if (deg >= TEMP_WARN) return 'var(--cand)';
  return 'var(--w100)';
}
function headroom(pct, warn) {
  if (pct >= warn) return 'var(--red)';
  if (pct >= warn * 0.8) return 'var(--cand)';
  return 'var(--green)';
}

q('readouts').innerHTML = ROWS.map(r =>
  `<div class="r" id="row-${r.k}">
     <div><div class="lbl">${r.label}</div><div class="sub" id="sub-${r.k}"></div></div>
     <div class="track"><b id="bar-${r.k}" style="width:0%"></b></div>
     <div class="v num" id="val-${r.k}">—</div>
   </div>`).join('');

let hist = [], lastOk = 0, muted = false, installedApps = [], lastAppId = '';

const POPULAR_APPS = [
  'youtube.leanback.v4', 'netflix', 'amazon', 'com.apple.appletv',
  'spotify-beehive', 'bbc.iplayer.3.0', 'com.fvp.itv', 'com.fvp.ch4',
  'demand5', 'bbc.sounds.1.0', 'org.webosbrew.hbchannel',
  'com.webos.app.browser', 'com.webos.app.igallery', 'lgchannels.uk'
];

function cleanAppTitle(title, id) {
  if (id === 'demand5' || title === '5') return 'My5';
  if (id === 'spotify-beehive') return 'Spotify';
  if (id === 'amazon') return 'Prime Video';
  if (id === 'org.webosbrew.hbchannel') return 'Homebrew';
  if (id === 'com.webos.app.browser') return t('app.browser', 'Browser');
  if (id === 'com.webos.app.igallery') return t('app.gallery', 'Gallery');
  if (id === 'com.webos.app.btspeakerapp') return 'BT Audio';
  if (id === 'com.webos.app.amazon-echo') return 'Alexa';
  if (id === 'com.webos.app.google-home') return 'Google';
  if (id === 'com.webos.app.photovideo') return t('app.photos', 'Photos');
  if (id === 'com.webos.app.connectionwizard') return t('app.connector', 'Connector');
  if (id === 'com.webos.app.notificationcenter') return t('app.alerts', 'Alerts');
  if (id === 'com.open.hidden.menu') return t('app.serviceMenu', 'Service Menu');
  if (id === 'com.webos.app.remoteservice') return 'LG Remote';
  if (id === 'com.webos.app.accessibility') return t('app.accessibility', 'Accessibility');
  if (id === 'com.theadelab.amclient-lg') return 'Amazon Music';
  return title;
}

function renderApps(currentAppId) {
  const container = q('apps');
  if (!container || !installedApps.length) return;

  // Opening the Apps panel is already the "show me the apps" step, so the
  // whole list renders. Popular ones and whatever is running sort first.
  const sorted = installedApps.slice().sort((a, b) => {
    const aPop = POPULAR_APPS.indexOf(a.id);
    const bPop = POPULAR_APPS.indexOf(b.id);
    if (aPop !== -1 && bPop !== -1) return aPop - bPop;
    if (aPop !== -1) return -1;
    if (bPop !== -1) return 1;
    return a.title.localeCompare(b.title);
  });

  container.innerHTML = sorted.map(a => {
    const clean = cleanAppTitle(a.title, a.id);
    const btnId = 'app_' + a.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const isCur = currentAppId && (a.id === currentAppId || a.id === ('com.webos.app.' + currentAppId));
    return `<button id="${btnId}" class="${isCur ? 'on' : ''}" title="${esc(a.title)}" onclick="sendCommand('launchApp','${jsq(a.id)}')">${esc(clean)}</button>`;
  }).join('');
}

const SLOTS = 56;
/*
 * A section whose every cell has been hidden - Storage on a set with no wear
 * counters and no app storage figure - would otherwise render as a heading
 * over empty space, which reads as a failure rather than an absence.
 */
function pruneEmptySections() {
  document.querySelectorAll('.grp-sec').forEach(function (sec) {
    const cells = Array.from(sec.querySelectorAll('.cols > *, .readouts .r, .hw-specs > *'));
    if (cells.length === 0) return;
    if (cells.every(function (c) { return c.hidden; })) {
      sec.hidden = true;
      sec.dataset.pruned = '1';
    } else if (sec.dataset.pruned) {
      sec.hidden = false;
      delete sec.dataset.pruned;
    }
  });
}

function trace(vals) {
  // Empty means there is nothing to draw, not "leave the last drawing up".
  if (!vals.length) { q('trace').innerHTML = ''; return; }
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const recent = vals.slice(-SLOTS);
  // Always lay out SLOTS columns, right-aligned, padding the left with empty
  // ones. Otherwise two samples become two full-width bars - a grey slab
  // rather than a trace.
  const pad = SLOTS - recent.length;
  let out = '';
  for (let i = 0; i < pad; i++) out += '<i class="void"></i>';
  recent.forEach((v, i) => {
    const cls = i === recent.length - 1 ? 'now' : (i > recent.length - 14 ? 'warm' : '');
    out += `<i class="${cls}" style="height:${8 + (v - lo) / span * 92}%"></i>`;
  });
  q('trace').innerHTML = out;
}

function row(k, val, pct, sub, warn) {
  q('val-' + k).innerHTML = val;
  const bar = q('bar-' + k);
  bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  bar.style.background = FLAT[k] ? 'var(--w60)' : headroom(pct, warn);
  q('sub-' + k).textContent = sub || '';
  q('row-' + k).classList.toggle('hi', pct >= warn);
}

// For the Game tab, which names inputs as the TV does.
let lastInputNames = {};

/* The HDMI cards come from /api/hdmi, which asks the TV's input service, so
   they are not refreshed on every tick. They are when what is on screen
   changes: an input chosen, the TV switched on, a source starting to send.
   Loaded once only, they kept "Device seen, no signal" from a page opened
   while the TV was in standby. */
let lastHdmiKey = null;
// The outputs with a button of their own, by every id the TV gives them.
const SOUND_BUTTON = {
  tv_speaker: 'tv_speaker', internal: 'tv_speaker', external_arc: 'external_arc',
  optical: 'optical', external_optical: 'optical', headphone: 'headphone', bt_soundbar: 'bt_soundbar'
};

// The TV's other outputs, in a list after the buttons; the one in use is shown
// selected there.
function renderMoreOutputs(outputs, current) {
  const sel = q('so_more');
  if (!sel) return;
  const sig = outputs.map(o => o.id + '=' + o.name).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(new Option(t('sound.more', 'More…'), ''),
      ...outputs.map(o => new Option(o.name, o.id)));
  }
  sel.hidden = !outputs.length;
  const inList = outputs.some(o => o.id === current);
  sel.value = inList ? current : '';
  sel.classList.toggle('on', inList);
}

function hdmiKey(d) {
  // The colour format is in the key too: a source switching RGB to YCbCr, or
  // SDR to HDR, keeps the same resolution and refresh.
  const diag = d.hdmi_diag || {}, pe = d.picture_engine || {};
  return [d.app_id || '', (d.powerState && d.powerState.raw) || '', d.signal || '', !!d.screenSaver,
          diag.chroma || '', diag.hdcp || '', d.colorimetry || pe.colorimetry || '', pe.hdr_mode || ''].join('|');
}

async function tick() {
  try {
    const r = await fetch(api('/api/stats'), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 401 ? t('common.unauthorised', 'Unauthorised \u2014 token missing or wrong') : 'HTTP ' + r.status);
    const d = await r.json();
    q('panels').classList.remove('stale');
    if (!errTimer) {
      q('offline').hidden = true;
      if (q('offline-msg')) q('offline-msg').style.display = '';
      if (q('err')) q('err').style.display = 'none';
    }
    const firstData = !lastOk;
    lastOk = Date.now();

    const hk = hdmiKey(d);
    if (lastHdmiKey !== null && hk !== lastHdmiKey && hdmiLoaded) loadHdmi();
    lastHdmiKey = hk;

    const model = (d.device && d.device.model) || '';
    q('model').textContent = model;
    const isOled = !(d.capabilities && d.capabilities.oled === false) &&
                    (d.capabilities ? d.capabilities.oled === true : (/oled/i.test(model) || !!(d.oled && d.oled.panel_hours !== undefined)));
    const brand = isOled ? t('header.brand.oled', 'LG OLED TV') : t('header.brand', 'LG TV');
    if (q('brand')) q('brand').textContent = brand;
    const want = model ? 'Glasshouse · ' + model : 'Glasshouse';
    if (document.title !== want) document.title = want;
    // Panel state first: without it, a blanked screen still reads as though
    // something were being displayed.
    const ps = d.powerState || {};
    const o = d.oled || {};
    pwStandby = ps.raw === 'Active Standby';
    if (q('poff')) q('poff').textContent = pwStandby ? t('ctl.powerOn', 'Power on') : t('ctl.powerOff', 'Power off');
    const isComp = (o.comp_status === 'Running');
    const stEl = q('state');
    stEl.classList.toggle('comp', isComp);
    stEl.classList.toggle('off', !isComp && ps.screenOn === false);
    if (isComp) {
      stEl.querySelector('span').textContent = t('state.activeStandby', 'Active Standby');
      q('source').textContent = t('state.compRunning', 'Completing Panel Maintenance (Short Cycle)');
    } else {
      stEl.querySelector('span').textContent = ps.label || '—';
      q('source').textContent = d.display_title || d.app_name || d.app || '—';
    }
    q('source').parentElement.classList.toggle('dim', ps.screenOn === false && !isComp);
    const pic = d.picture || {};

    // Summarise the collapsed groups so their current values are readable
    // without opening them. Must sit after `pic` is declared - referencing a
    // const before its declaration throws, and tick() swallows that silently
    // for the first six seconds, so the whole render just stops updating.
    if (q('ds-cur')) {
      // sleep timer + front lights
      const stLeased = getLease('sleepTimer', d.sleepTimer || 'off');
      const st = stLeased !== undefined ? stLeased : (d.sleepTimer || 'off');
      ['off','10','30','60','90','120'].forEach(v => {
        const b = q('sl_' + v);
        if (b) b.classList.toggle('on', st === v);
      });
      const lights = d.lights || {};
      // Each setting shows only where the TV has it; Display only when it has any.
      const qbVal = getLease('quickBoot', d.quickBoot);
      advPill('quickboot', 'btn_quickboot', qbVal !== undefined ? qbVal : d.quickBoot);
      lastArOff = d.alwaysReadyOff;
      const arLeased = getLease('alwaysReady', d.alwaysReady);
      const arVal = arLeased !== undefined ? arLeased : d.alwaysReady;
      advPill('ar', 'btn_ar', arVal);
      const arsVal = getLease('alwaysReadyScreen', d.alwaysReadyScreen);
      advPill('ars', 'btn_ars', arsVal !== undefined ? arsVal : d.alwaysReadyScreen);
      arOffRow(arVal ? d.alwaysReadyOff : undefined);
      powerTimerRows(d.powerTimers);
      const wolVal = getLease('wakeOnLan', d.wakeOnLan);
      advPill('wol', 'btn_wol', wolVal !== undefined ? wolVal : d.wakeOnLan);
      const logoVal = getLease('lgLogo', d.lgLogo);
      advPill('lglogo', 'btn_lglogo', logoVal !== undefined ? logoVal : d.lgLogo);
      const sbVal = getLease('standbyLight', lights.standby);
      advPill('standby', 'lt_standby', sbVal !== undefined ? sbVal : lights.standby);
      const ltLogoVal = getLease('logoLight', lights.logo);
      advPill('logolight', 'lt_logo', lights.hasLogo ? (ltLogoVal !== undefined ? ltLogoVal : lights.logo) : undefined);
      if (q('adv-display')) q('adv-display').hidden = d.lgLogo === undefined;
      const pc = d.piccapCapture;
      const pcVal = getLease('piccap', pc ? pc.running : undefined);
      advPill('piccap', 'btn_piccap', pc ? (pcVal !== undefined ? pcVal : pc.running) : undefined);
      if (q('adv-piccap')) q('adv-piccap').hidden = !pc;
      const devVal = getLease('deviceDetection', d.deviceDetection);
      advPill('devdetect', 'btn_devdetect', devVal !== undefined ? devVal : d.deviceDetection);
      if (q('adv-devices')) q('adv-devices').hidden = d.deviceDetection === undefined && !advLgsDevices;
      if (q('tl-cur')) {
        q('tl-cur').textContent = st === 'off' ? t('common.off', 'Off') : t('ctl.sleep.minutes', '{n} min', { n: st });
      }

      q('ds-cur').textContent = pic.mode || '';
      if (q('snd-cur')) q('snd-cur').textContent = d.audio_output || '';
    }

    const rem = d.remote;
    if (rem && rem.battery !== null && rem.battery !== undefined) {
      q('remoteblock').hidden = false;
      q('remote-pct').textContent = rem.battery;
      const gFill = q('remote-gauge-fill');
      gFill.style.width = Math.max(5, Math.min(100, rem.battery)) + '%';
      gFill.style.background = rem.battery <= 15 ? 'var(--red)' : rem.battery <= 30 ? 'var(--cand)' : 'var(--green)';
      q('remote-model-sub').textContent = rem.model ? rem.model.replace(/^LGE\s*/i, '') : 'MR22';
      q('remoteblock').title = [rem.model || t('metrics.remote.name', 'Magic Remote'),
        rem.firmware ? t('metrics.remote.firmware', 'Firmware: {version}', { version: rem.firmware }) : '',
        rem.mac ? t('metrics.remote.bluetooth', 'Bluetooth: {address}', { address: rem.mac }) : ''].filter(Boolean).join(' · ');
    } else {
      q('remoteblock').hidden = true;
    }

    /* The badge names the format the source is sending, and the picture
       settings' family only where the TV reports no format: in standby, or
       with nothing from its video output service. The format is cached for 4 s
       and the family for 10 s, so across a change they can disagree for a
       poll; following the format whenever there is one keeps the badge from
       flipping between the two. Low latency is the family's ALLM suffix
       either way. */
    const fmt = d.signal_format;
    let dr = pic.dynamicRange || '', drClass = '';
    if (fmt && fmt.type) {
      dr = fmt.type_display || fmt.type;
      if (/ALLM$/.test(pic.dynamicRange_raw || '')) dr = t('metrics.stream.lowLatency', '{format} \u00b7 Low latency', { format: dr });
      drClass = /^dolby_vision/.test(fmt.type) ? 'dv' : fmt.type === 'sdr' ? 'sdr' : 'hdr';
    } else if (dr) {
      drClass = /dolby/i.test(dr) ? 'dv' : /hdr/i.test(dr) ? 'hdr' : 'sdr';
    }
    const drBadge = dr ? `<span class="stream-tag ${drClass}">${esc(dr)}</span>` : '';
    const modeBadge = pic.mode ? `<span class="stream-mode">${esc(pic.mode)}</span>` : '';
    const resStr = d.signal ? esc(d.signal) : '';
    lastInputNames = d.inputs || {};

    const primList = [resStr, drBadge, modeBadge].filter(Boolean);
    q('stream-primary').innerHTML = primList.length ? primList.join('  ') : '&mdash;';

    renderHdmiDiag(d.hdmi_diag, d.colorimetry || (d.picture_engine && d.picture_engine.colorimetry) || '');

    // temp is null in two different situations: the sensor is warming up
    // (~80s after boot, file exists but reads 0), or the platform has no
    // thermal sensor at all (webOS 3.x - no /proc/lg/pm/temperature, empty
    // /sys/class/thermal, no hwmon). capabilities.thermal separates them.
    // Never push null into hist: Math.min/max coerce it to 0, which is where
    // the old "MIN 0 MAX 0" came from on sensorless sets.
    const noThermal = !!(d.capabilities && d.capabilities.thermal === false);
    if (q('tempblock')) q('tempblock').hidden = noThermal;
    const hasTemp = !(d.temp === null || d.temp === undefined);
    q('temp').textContent = hasTemp ? d.temp : '\u2014';
    q('degsym').hidden = !hasTemp;
    q('tempbig').classList.toggle('none', !hasTemp);
    if (hasTemp) {
      document.documentElement.style.setProperty('--hot', thermal(d.temp));
      // Seed from the server's ring buffer on first paint so the trace says
      // something immediately, then track locally at the UI's own cadence.
      if (!hist.length && Array.isArray(d.temps) && d.temps.length) hist = d.temps.slice(-240);
      else { hist.push(d.temp); if (hist.length > 240) hist.shift(); }
    }
    trace(hist);
    q('trange').textContent = noThermal ? t('metrics.temp.noSensor', 'NO THERMAL SENSOR')
      : hist.length ? t('metrics.temp.range', 'MIN {min}   MAX {max}', { min: Math.min(...hist), max: Math.max(...hist) })
      : t('metrics.temp.warmingUp', 'WARMING UP');
    q('mhz').textContent = d.mhz ? d.mhz + ' MHZ' : '';

    /* The core figures are positional, so the c0/c1 prefixes were four
       redundant labels competing for a 132px column - at three digits each the
       last core was being ellipsised away exactly when the TV was busy. */
    /* Only the cores that are online, so the count moves as the TV parks and
       wakes them - say how many are down rather than leaving that unexplained. */
    const live = d.cores || [];
    const parked = Math.max(0, (d.coresTotal || live.length) - live.length);
    const cores = live.map(v => v + '%').join('  ·  ') +
      (parked ? '  ·  ' + t('metrics.cpu.parked', '{n} parked', { n: parked }) : '');
    row('cpu', d.load + '<small>%</small>', d.load, cores, 85);

    const mu = d.mem.total ? 100 * (d.mem.total - d.mem.avail) / d.mem.total : 0;
    row('mem', mu.toFixed(0) + '<small>%</small>', mu,
        mb(d.mem.total - d.mem.avail) + ' / ' + mb(d.mem.total) + ' MB', 90);

    const su = d.swap.total ? 100 * (d.swap.total - d.swap.free) / d.swap.total : 0;
    row('swap', su.toFixed(0) + '<small>%</small>', su,
        mb(d.swap.total - d.swap.free) + ' / ' + mb(d.swap.total) + ' MB' +
        (d.swap.backing ? ' ' + d.swap.backing : ''), 70);

    // Wired sets report no wlan0; hide rather than showing a blank signal.
    q('row-net').hidden = !(d.wifi || d.net);
    const rx = d.net ? (d.net.rx / 1024) : 0, tx = d.net ? (d.net.tx / 1024) : 0;
    /* Totals are per-interface and come from whichever link the rate was
       measured on, so a Wi-Fi set reads its own counters, not a dormant eth0. */
    const nt = d.netTotal;
    const netParts = [];
    if (d.ssid) netParts.push(esc(d.ssid));
    if (d.wifi && d.wifi.level) netParts.push(d.wifi.level + ' dBm');
    if (tx > 0) netParts.push(t('metrics.net.up', '{rate} kB/s up', { rate: tx.toFixed(0) }));
    if (nt) netParts.push('↓ ' + bytes(nt.rx) + ' ↑ ' + bytes(nt.tx));
    row('net', rx.toFixed(0) + '<small>kB/s</small>', Math.min(100, rx / 20),
        netParts.join('  ·  ') || t('metrics.net.connected', 'Connected'), 101);

    // Hardware & System Specifications
    let hasHw = false;
    const osVer = (d.system && d.system.webos) || (d.hardware && d.hardware.webos);
    if (osVer) {
      q('spec-os-item').hidden = false;
      q('spec-os').textContent = osVer;
      hasHw = true;
    } else {
      q('spec-os-item').hidden = true;
    }
    const fwVer = (d.system && d.system.firmware) || (d.device && d.device.firmware);
    if (fwVer) {
      q('spec-fw-item').hidden = false;
      q('spec-fw').textContent = fwVer;
      hasHw = true;
    } else {
      q('spec-fw-item').hidden = true;
    }
    if (d.hardware && d.hardware.soc_arch) {
      q('spec-arch-item').hidden = false;
      q('spec-arch').textContent = d.hardware.soc_arch;
      hasHw = true;
    } else {
      q('spec-arch-item').hidden = true;
    }
    if (d.panel_silicon && d.panel_silicon.cell) {
      q('spec-silicon-item').hidden = false;
      q('spec-silicon').textContent = d.panel_silicon.cell;
      hasHw = true;
    } else {
      q('spec-silicon-item').hidden = true;
    }
    if (d.panel_silicon && d.panel_silicon.tcon_firmware) {
      q('spec-tcon-item').hidden = false;
      q('spec-tcon').textContent = d.panel_silicon.tcon_firmware;
      hasHw = true;
    } else {
      q('spec-tcon-item').hidden = true;
    }
    // The remote has its own section now, so System info stands on its own.
    if (q('disc-hwinfo')) q('disc-hwinfo').hidden = !hasHw;

    /* The ambient sensor is a reading rather than panel wear, so it stays on
       the System tab while the panel figures live with the protections. */
    const lux = d.lightSensor;
    if (q('luxblock')) q('luxblock').hidden = !lux;
    if (lux && q('lux')) q('lux').textContent = Math.round(lux.lux);

    const st_ = d.appStorage;
    q('appstore-cell').hidden = !st_;
    if (st_) {
      q('appstore').textContent = (st_.freeMb / 1024).toFixed(1);
      q('appstore-sub').textContent = t('metrics.storage.used', '{pct}% of {total} GB used', { pct: st_.pct, total: (st_.totalMb / 1024).toFixed(1) });
    }
    /* Flash wear is independent of panel type, but the counters do not exist
       on webOS 3.x - drop the cells rather than print "unknown" twice. */
    const wear_ = !(d.capabilities && d.capabilities.emmcWear === false) && !(d.emmc && d.emmc.wear === 'unknown');
    q('flashwear-cell').hidden = !wear_;
    q('flashhealth-cell').hidden = !wear_;
    if (wear_) {
      q('flashval').textContent = (d.emmc && d.emmc.wear) || '—';
      /* emmc.health is the wear band inverted - the same register, arithmetic
         the other way up - so showing both said one thing twice. pre_eol_info
         is a separate register and the only one that can warn on its own. */
      q('flasheol').textContent = (d.emmc && d.emmc.eol) || '—';
    }
    pruneEmptySections();

    const mLeased = getLease('mute', d.muted);
    muted = mLeased !== undefined ? mLeased : !!d.muted;
    if (!volDragging) {
      const vLeased = getLease('volume', d.volume);
      const v = vLeased !== undefined ? vLeased : (typeof d.volume === 'number' ? d.volume : 0);
      // The server says how the volume can be changed: set, stepped (a
      // receiver on HDMI ARC/eARC takes only up and down), or not at all.
      const ctl = d.volume_control || (d.volume === null ? 'none' : 'level');
      const level = ctl === 'level';
      const settling = Date.now() < volSettleUntil;
      /* On HDMI ARC the slider sets the TV's own level, which a receiver that
         keeps its own may ignore while still following the remote's keys
         (a C1 with an AV receiver on eARC, #437), so - and + show beside it. */
      const arc = /arc/.test((d.sound && d.sound.output_raw) || '');
      const steps = ctl === 'steps' || (level && arc);
      if (q('vol-row')) q('vol-row').classList.toggle('both', level && steps);
      if (q('vol-steps')) {
        q('vol-steps').hidden = !steps;
        q('vol-steps').querySelectorAll('button').forEach(b => { b.disabled = settling; });
      }
      if (q('vol-wrap')) {
        q('vol-wrap').hidden = ctl === 'steps';
        q('vol-wrap').classList.toggle('off', ctl === 'none' || settling);
        q('vol-wrap').title = ctl === 'none' ? t('ctl.volumeExternal', 'The volume is set on the sound device') : '';
      }
      if (q('vol-slider')) {
        q('vol-slider').value = v;
        q('vol-slider').disabled = !level || settling;
      }
      // Mute is refused wherever the volume is ("Current Scenario doesn't
      // support mute"), and passed on where up and down are.
      if (q('mute')) q('mute').disabled = ctl === 'none' || settling;
      if (q('vol-fill')) q('vol-fill').style.width = (level ? v : 0) + '%';
      q('vol').textContent = muted ? t('ctl.muted', 'MUTED') : level ? v : '—';
      if (q('vol-wrap')) q('vol-wrap').classList.toggle('muted', muted);
    }
    q('mute').classList.toggle('on', muted);

    if (d.inputs && !q('inputs').dataset.built) {
      q('inputs').innerHTML = Object.keys(d.inputs).map(k =>
        `<button id="in_${esc(k)}" onclick="sendCommand('input','${jsq(k)}')">${esc(d.inputs[k])}</button>`).join('') +
        `<button id="in_livetv" onclick="sendCommand('input','livetv')">${esc(t('ctl.liveTv', 'Live TV'))}</button>`;
      q('inputs').dataset.built = '1';
    }

    const inLeased = getLease('input', d.app);
    const activeApp = inLeased !== undefined ? inLeased : d.app;
    if (activeApp) {
      lastAppId = activeApp;
      const inBtns = q('inputs') ? q('inputs').querySelectorAll('button') : [];
      let foundInBtn = false;
      for (let b of inBtns) {
        const isCur = b.id === 'in_' + activeApp;
        b.classList.toggle('on', isCur);
        if (isCur) {
          if (q('currapp-lbl')) q('currapp-lbl').textContent = b.textContent.toUpperCase();
          foundInBtn = true;
        }
      }
      if (!foundInBtn && q('currapp-lbl')) {
        q('currapp-lbl').textContent = (d.app_name || d.display_title || activeApp).toUpperCase();
      }
    } else {
      if (q('currapp-lbl')) q('currapp-lbl').textContent = isComp ? t('ctl.app.maintenance', 'MAINTENANCE')
        : (ps.label ? ps.label.toUpperCase() : t('ctl.app.standby', 'STANDBY'));
      const inBtns = q('inputs') ? q('inputs').querySelectorAll('button') : [];
      for (let b of inBtns) {
        b.classList.toggle('on', false);
      }
    }

    if (d.apps && d.apps.length) {
      if (!installedApps.length) {
        installedApps = d.apps;
        renderApps(activeApp);
      } else {
        const appBtns = q('apps') ? q('apps').querySelectorAll('button') : [];
        for (let b of appBtns) {
          b.classList.toggle('on', !!(activeApp && (b.id === 'app_' + activeApp.replace(/[^a-zA-Z0-9_-]/g, '_') || b.id === 'app_com_webos_app_' + activeApp)));
        }
      }
    }

    /* The screen saver is drawn by whatever app registered for it, and an
       input registers nothing - so it cannot run over HDMI or Live TV. Say why
       rather than leaving a button that does nothing when pressed. */
    // The tab is about the panel, so an LCD set has no use for it.
    isOledSet = !!d.oled;
    if (q('tab-btn-servicemenu')) q('tab-btn-servicemenu').hidden = false;
    if (q('tab-btn-oledcare')) q('tab-btn-oledcare').hidden = !isOledSet;
    // If it was showing when the set turned out not to be an OLED, leave it.
    if (!isOledSet && activeTab === 'oledcare') showTab('control');

    const ssOnInput = /^hdmi[1-4]$/.test(d.app || '') || d.app === 'livetv';
    refuseScreensaver(q('btn_ss'), ssOnInput ? SS_ONLY_IN_APPS : '');
    /* Same control on the Screensaver tab, where it says which way it will go:
       there is one command and the TV decides, so the label follows the TV. */
    if (q('ss-toggle')) {
      const ssOn = !!d.screenSaver;
      // Rewriting the label replaces the text node under the pointer, which
      // costs the tooltip the same way rewriting the title does.
      setIfChanged(q('ss-toggle'), 'textContent',
                   ssOn ? t('ss.dismiss', 'Dismiss screen saver') : t('ss.start', 'Start screen saver'));
      q('ss-toggle').classList.toggle('on', ssOn);
      // Dismissing works from anywhere; only starting one needs an app.
      refuseScreensaver(q('ss-toggle'),
        !ssWritable ? t('common.controlsOff', 'Controls are disabled in config.json.')
        : ssSwitching ? SS_SWITCHING
        : (ssOnInput && !ssOn) ? SS_ONLY_IN_APPS : '');
    }

    if (d.picture) {
      const pmLeased = getLease('pictureMode', d.picture.mode_raw);
      const curPm = pmLeased !== undefined ? pmLeased : d.picture.mode_raw;
      if (q('picmode-lbl') && !pmLeased) q('picmode-lbl').textContent = (d.picture.mode || d.picture.mode_raw || '').toUpperCase();
      /* Rebuild only when the set actually changes - it changes when the source
         does, and rewriting the buttons on every tick would kill the :active
         state mid-press. */
      const modes = d.picture.modes || [];
      const sig = modes.map(m => m.value).join(',');
      const box = q('picmodes');
      if (box && box.dataset.sig !== sig) {
        box.dataset.sig = sig;
        box.innerHTML = modes.map(m =>
          `<button id="pm_${esc(m.value)}" onclick="sendCommand('pictureMode','${jsq(m.value)}')">${esc(m.label)}</button>`
        ).join('');
      }
      if (box) {
        for (let b of box.querySelectorAll('button')) {
          const isCur = b.id.replace('pm_', '') === curPm;
          b.classList.toggle('on', isCur);
          if (isCur && pmLeased && q('picmode-lbl')) q('picmode-lbl').textContent = b.textContent.toUpperCase();
        }
      }

      if (!blDragging && typeof d.picture.backlight === 'number') {
        const blLeased = getLease('backlight', d.picture.backlight);
        showBacklight(blLeased !== undefined ? blLeased : d.picture.backlight);
      }
      if (q('bl-name')) q('bl-name').textContent = isOledSet === false
        ? t('ctl.backlight', 'Backlight') : t('ctl.oledLight', 'OLED light');

      const esLeased = getLease('energySaving', d.picture.energySaving);
      const es = esLeased !== undefined ? esLeased : (d.picture.energySaving || '');
      if (q('energy-lbl')) q('energy-lbl').textContent = (ENERGY_STEPS[es] || es || '—').toUpperCase();
      const esBox = q('energysteps');
      if (esBox) {
        for (let b of esBox.querySelectorAll('button')) {
          b.classList.toggle('on', b.id.replace('es_', '') === es);
        }
      }
    }

    if (d.sound) {
      // The TV reports optical as external_optical (B8, C2) and its speakers as
      // internal on some firmware; the buttons carry the other id.
      const soRaw = { external_optical: 'optical', internal: 'tv_speaker' }[d.sound.output_raw] || d.sound.output_raw || '';
      const soLeased = getLease('soundOutput', soRaw);
      const curSo = soLeased !== undefined ? soLeased : soRaw;
      if (q('soundout-lbl') && !soLeased) q('soundout-lbl').textContent = (d.sound.output || d.sound.output_raw || '').toUpperCase();
      // Bluetooth only with an audio device connected: without one the TV
      // opens its own pairing prompt and falls back to the speakers.
      const noBt = d.sound.bt_audio === false;
      // Once the TV has said which outputs it offers, a button shows only if
      // it is one of them, and the rest go in More.
      const offered = Array.isArray(d.sound.outputs) ? d.sound.outputs : null;
      const onButtons = offered ? new Set(offered.map(o => SOUND_BUTTON[o.id]).filter(Boolean)) : null;
      const soBtns = q('soundouts') ? q('soundouts').querySelectorAll('button') : [];
      for (let b of soBtns) {
        const id = b.id.replace('so_', '');
        const isCur = id === curSo;
        b.hidden = !isCur && ((onButtons && !onButtons.has(id)) || (id === 'bt_soundbar' && noBt));
        b.classList.toggle('on', isCur);
        if (isCur && soLeased && q('soundout-lbl')) q('soundout-lbl').textContent = b.textContent.toUpperCase();
      }
      renderMoreOutputs(offered ? offered.filter(o => !SOUND_BUTTON[o.id]) : [], curSo);
    }

    const up = d.uptime, dd = Math.floor(up / 86400), hh = Math.floor(up % 86400 / 3600), mm = Math.floor(up % 3600 / 60);
    const upFor = dd ? t('footer.uptime.days', '{d}d {h}h {m}m', { d: dd, h: hh, m: mm })
      : t('footer.uptime.hours', '{h}h {m}m', { h: hh, m: mm });
    q('uptime').textContent = t('footer.uptime', 'Up {time}   ·   load {load}', { time: upFor, load: (d.loadavg || []).join(' ') });
    q('clock').textContent = new Date().toLocaleTimeString();
    setVersion(d.tvwebVersion);
    // Several groups stay hidden until the first payload says the TV has them,
    // so the columns are only worth filling once that has happened.
    if (firstData) relayout(true);
  } catch (e) {
    if (updRestarting) return;
    q('panels').classList.add('stale');
    if (Date.now() - lastOk <= 6000) return;
    if (e.offline) {
      if (q('offline-msg')) q('offline-msg').style.display = '';
      if (q('err')) q('err').style.display = 'none';
      q('offline').hidden = false;
    } else {
      showErr(e.message || t('common.unreachable', 'Can’t reach the TV'));
    }
  }
}

// The steps the picture service accepts, in the TV's own order.
const ENERGY_STEPS = {
  auto: t('energy.auto', 'Auto'), off: t('common.off', 'Off'), min: t('energy.min', 'Minimum'),
  med: t('energy.med', 'Medium'), max: t('energy.max', 'Maximum'), screen_off: t('ctl.screenOff', 'Screen off')
};
