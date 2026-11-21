// ---------------------------------------------------------------- Internet TV

/*
 * The owner's IPTV playlists (lib/iptv) and the channels added from them. The
 * server never sends a playlist's link, user name or password back: an edit
 * shows them blank, and leaving one blank keeps what is stored.
 */
let homeTv = null;          // /api/iptv/playlists
let homeTvForm = null;      // { kind, id } while the add or edit form is open
let homeTvArmed = null;     // playlist id waiting for Remove's second press
let homeTvPoll = null;
const HOME_TV_BYTES_PER_MB = 1024 * 1024;

let homeGuideKey = null;   // the remote's Guide key as lib/remotekeys has it, with the choices
let homeTvPause = null;    // /api/iptv/timeshift: whether live TV may pause, and the USB stick for it
async function homeTvLoad() {
  try { homeTv = await homeGet('/api/iptv/playlists'); } catch (e) { homeTv = null; }
  try { homeTvPause = await homeGet('/api/iptv/timeshift'); } catch (e) { homeTvPause = null; }
  try {
    const rk = await homeGet('/api/remotekeys');
    const key = rk.supported && (rk.keys || []).find(k => k.key === 'guide');
    homeGuideKey = key ? { key, offered: (rk.choices || []).some(c => c.id === 'action:homeGuide'), patch: !!key.homeGuide } : null;
  } catch (e) { homeGuideKey = null; }
  // While a playlist is being read, the section follows it.
  clearTimeout(homeTvPoll);
  if (homeTv && homeTv.playlists.some(p => p.refreshing || p.queued)) {
    homeTvPoll = setTimeout(async () => { if (activeTab !== 'home') return; await homeTvLoad(); renderHomeTv(); }, 3000);
  }
}

const homeTvDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const homeTvTime = ms => {
  const d = new Date(ms);
  return Date.now() - ms < 20 * 3600000 ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : homeTvDate(ms);
};

// Why a read failed, in words; never the provider's own.
function homeTvError(e) {
  if (!e) return '';
  const status = e.status ? ' (' + e.status + ')' : '';
  return {
    login: t('home.tv.err.login', 'The provider refused the login. Check it, then Refresh.'),
    network: t('home.tv.err.network', 'The TV couldn’t reach the provider.'),
    aborted: t('home.tv.err.aborted', 'The TV stopped the download before it began. It tries again later.'),
    timeout: t('home.tv.err.timeout', 'The provider took too long to answer.'),
    http: t('home.tv.err.http', 'The provider answered with an error{status}.', { status }),
    busy: t('home.tv.err.busy', 'The provider asked the TV to wait{status}.', { status }),
    format: t('home.tv.err.format', 'That isn’t a playlist the TV can read.'),
    empty: t('home.tv.err.empty', 'The playlist has no live channels.'),
    truncated: t('home.tv.err.truncated', 'The download stopped part way.'),
    disk: t('home.tv.err.disk', 'The TV ran out of space to keep it.'),
    memory: t('home.tv.err.memory', 'The playlist is too big for the TV’s memory.'),
    'limit-download': t('home.tv.err.big', 'The playlist is larger than 300 MB.'),
    'limit-entries': t('home.tv.err.many', 'The playlist has more than 500,000 entries.'),
    'no-client': t('home.tv.err.client', 'The TV has no curl or wget to download with.')
  }[e.code] || t('home.tv.err.other', 'Reading it failed ({code}).', { code: e.code });
}

// One sentence a playlist: how many channels, when read, the account.
function homeTvSentence(p) {
  const parts = [];
  if (p.refreshing) parts.push(p.progress ? t('home.tv.reading', 'Reading: {n} channels so far', { n: p.progress.toLocaleString() }) : t('home.tv.readingStart', 'Reading the playlist'));
  else if (p.queued && !p.ready) parts.push(t('home.tv.queued', 'Waiting to be read'));
  if (p.channels !== null) parts.push(t('home.tv.liveChannels', '{n} live channels', { n: p.channels.toLocaleString() }));
  if (p.refreshedAt && !p.refreshing) parts.push(t('home.tv.readAt', 'read {when}', { when: homeTvTime(p.refreshedAt) }));
  if (p.guideAt) parts.push(t('home.tv.guideAt', 'guide updated {when}', { when: homeTvTime(p.guideAt) }));
  const a = p.account;
  if (a && a.expires) parts.push(t('home.tv.ends', 'account ends {date}', { date: homeTvDate(a.expires) }));
  if (a && a.maxConnections) parts.push(a.maxConnections === 1 ? t('home.tv.oneStream', '1 stream at a time') : t('home.tv.streams', '{n} streams at a time', { n: a.maxConnections }));
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderHomeTv() {
  const box = q('home-tv');
  if (!box) return;
  if (!homeTv) { box.innerHTML = ''; return; }
  const usable = homeWritable();
  const rows = homeTv.playlists.map(p => {
    const err = p.loginRefused ? homeTvError({ code: 'login' }) : p.error ? homeTvError(p.error) + (p.ready ? ' ' + t('home.tv.keptOld', 'The list from before is still in use.') : '') : '';
    const kind = p.kind === 'xtream' ? t('home.tv.xtream', 'Xtream login') : p.kind === 'enigma2' ? t('home.tv.enigma2', 'Satellite tuner') : t('home.tv.m3u', 'M3U link');
    const armed = homeTvArmed === p.id;
    return `<div class="prot-row">
      <div class="prot-main"><div class="prot-title"><span translate="no">${esc(p.label)}</span> <span class="pill idle">${esc(kind)}</span></div>
        <div class="prot-desc">${esc(homeTvSentence(p) || p.host)}</div>
        ${err ? `<div class="prot-desc row-err">${esc(err)}</div>` : ''}
        ${p.headers || p.drm ? `<div class="prot-desc">${esc(t('home.tv.unplayableNote', '{n} channels need a player that sends its own headers, or are protected (DRM), and can’t be added.', { n: (p.headers + p.drm).toLocaleString() }))}</div>` : ''}</div>
      <div class="prot-status">
        <button type="button" class="pill idle" ${usable && !p.refreshing ? '' : 'disabled'} onclick="homeTvAction('refresh', '${jsq(p.id)}')">${esc(p.refreshing ? t('home.tv.refreshing', 'Reading…') : t('home.tv.refresh', 'Refresh'))}</button>
        <button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeTvOpenForm('${p.kind}', '${jsq(p.id)}')">${esc(t('home.tv.edit', 'Edit'))}</button>
        <button type="button" class="pill ${armed ? 'warn' : 'idle'}" ${usable ? '' : 'disabled'} onclick="homeTvRemove('${jsq(p.id)}')">${esc(armed ? t('home.tv.removeSure', 'Remove it and its channels') : t('home.tv.remove', 'Remove'))}</button>
      </div></div>`;
  }).join('');
  const waiting = homeTv.waiting === 'disk' ? t('home.tv.waitDisk', 'Waiting for space on the TV: refreshes need {mb} MB free.', { mb: homeTv.disk ? Math.round(homeTv.disk.need / 1048576) : 100 })
    : homeTv.waiting === 'playing' ? t('home.tv.waitPlaying', 'Refreshes wait while Internet TV plays.')
    : homeTv.waiting === 'memory' ? homeTvWaitMemory() : '';
  const extras = homeGuideKeyHtml() + (homeTv.playlists.some(p => p.ready) ? homeTvManageHtml() + homeTvPauseHtml() : '');
  box.innerHTML = `<div class="prot-table">${rows || `<div class="sub">${esc(t('home.tv.none', 'No playlists yet.'))}</div>`}</div>
    ${waiting ? `<div class="pv-note">${esc(waiting)}</div>` : ''}
    ${homeTvForm ? homeTvFormHtml() : `<div class="wall-foot-btns" style="margin-top:12px">
      <button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeTvOpenForm('xtream')">${esc(t('home.tv.addXtream', 'Add an Xtream login'))}</button>
      <button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeTvOpenForm('m3u')">${esc(t('home.tv.addM3u', 'Add an M3U link'))}</button>
      <button type="button" class="pill idle" ${usable ? '' : 'disabled'} onclick="homeTvOpenForm('enigma2')">${esc(t('home.tv.addEnigma2', 'Add a satellite tuner'))}</button></div>`}
    ${extras ? `<div class="prot-table">${extras}</div>` : ''}`;
}

/*
 * Pausing live Internet TV (lib/iptv-timeshift): the channel played full
 * screen is recorded to a USB stick while it plays, MPEG-TS channels only.
 */
function homeTvPauseHtml() {
  const p = homeTvPause;
  if (!p) return '';
  const stick = p.stick
    ? t('home.tv.pauseStick', 'USB stick found, {gb} GB free.', { gb: (p.stick.free / 1073741824).toFixed(1) })
    : t('home.tv.pauseNoStick', 'No USB stick with room found: plug one in, formatted FAT32 or exFAT, with at least 512 MB free.');
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('home.tv.pauseTitle', 'Pause live Internet TV'))}</div>
      <div class="prot-desc">${esc(t('home.tv.pauseDesc', 'Pause on the remote pauses a channel played full screen. Left and right go back and forward 30 seconds, and Back goes to live again. While a channel plays, the TV records it to a USB stick, up to about half an hour, and deletes it when the channel stops. MPEG-TS channels only.'))}</div>
      <div class="prot-desc">${esc(stick)}</div></div>
    <div class="prot-status"><button type="button" class="pill pill-toggle ${p.on ? 'good' : 'idle'}" ${homeWritable() ? '' : 'disabled'} onclick="homeTvSetPause(${p.on ? 'false' : 'true'})">${esc(p.on ? t('common.on', 'On') : t('common.off', 'Off'))}</button></div>
  </div>`;
}

async function homeTvSetPause(on) {
  try { await homePost('/api/iptv/timeshift', { on }); } catch (e) { showErr(e.message); }
  await homeTvLoad();
  renderHomeTv();
}

function homeTvWaitMemory() {
  const m = homeTv.memory;
  if (!m || !m.available || !m.needed) return t('home.tv.waitMemory', 'Waiting for the TV to have memory to spare.');
  return t('home.tv.waitMemoryOf', 'Waiting for memory on the TV: {available} MB available of the {needed} MB this needs.', {
    available: Math.round(m.available / HOME_TV_BYTES_PER_MB), needed: Math.round(m.needed / HOME_TV_BYTES_PER_MB) });
}

// The way into the channel manager (assets/ui/tvchannels.js), with what the lineup holds.
function homeTvManageHtml() {
  const n = homeTv.lineup || 0, f = homeTv.selected || 0;
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(t('home.tvm.entryTitle', 'Channels'))}</div>
      <div class="prot-desc">${esc(n ? t('home.tvm.entryCount', '{n} in the lineup, {f} of them starred for Home’s row.', { n: n.toLocaleString(), f })
        : t('home.tvm.entryNone', 'None yet. Add whole groups or single channels, number them, and star the ones for Home’s row.'))}</div></div>
    <div class="prot-status"><button type="button" class="pill idle" onclick="tvmOpen()">${esc(t('home.tvm.entryOpen', 'Manage channels'))}</button></div>
  </div>`;
}

function homeTvFormHtml() {
  const f = homeTvForm, editing = !!f.id;
  const p = editing ? homeTv.playlists.find(x => x.id === f.id) : null;
  if (f.takeOver === undefined) f.takeOver = !!(p && p.takeOver);
  if (f.noLogin === undefined) f.noLogin = false;
  if (f.streamLogin === undefined) f.streamLogin = !!(p && p.streamLogin);
  const keep = editing ? t('home.tv.keepBlank', 'Leave blank to keep the one saved') : '';
  const field = (id, label, type, ph, value) => `<label class="home-tv-field"><span>${esc(label)}</span>
    <input id="${id}" type="${type}" autocomplete="off" spellcheck="false" placeholder="${esc(ph || '')}"${value ? ` value="${esc(value)}"` : ''}></label>`;
  return `<div class="home-tv-form">
    <div class="prot-title">${esc(editing ? t('home.tv.editTitle', 'Edit {name}', { name: p ? p.label : '' }) : f.kind === 'xtream' ? t('home.tv.addXtream', 'Add an Xtream login') : f.kind === 'enigma2' ? t('home.tv.addEnigma2', 'Add a satellite tuner') : t('home.tv.addM3u', 'Add an M3U link'))}</div>
    ${field('home-tv-label', t('home.tv.label', 'Name on the row'), 'text', p ? p.label : t('home.tv.labelPh', 'Home IPTV'))}
    ${f.kind === 'enigma2'
      ? field('home-tv-server', t('home.tv.tunerAddress', 'Tuner address'), 'text', keep || '192.168.1.10') +
        field('home-tv-user', t('home.tv.tunerUser', 'User name (if the tuner asks for one)'), 'text', keep) +
        field('home-tv-pass', t('home.tv.pass', 'Password'), 'password', keep) +
        // Shown as saved (a port is no secret), so emptying the field clears it.
        field('home-tv-streamport', t('home.tv.streamPort', 'Stream port (optional)'), 'number',
          t('home.tv.streamPortPh', 'Empty: the tuner’s own, usually 8001'), p && p.streamPort ? String(p.streamPort) : '') +
        `<div class="sub">${esc(t('home.tv.streamPortNote', 'Only needed when the channel is to come from a different port than the tuner’s own address, such as a transcoding profile on 8002.'))}</div>` +
        `<div class="prot-table">${homeTvSwitchHtml('takeOver', t('home.tv.takeOverTitle', 'When every tuner is busy, switch a tuner to the requested channel'),
          t('home.tv.takeOverDesc', 'Moves the tuner showing live TV. A tuner that is recording or streaming for someone else is never touched.'))}` +
        homeTvSwitchHtml('streamLogin', t('home.tv.streamLoginTitle', 'The tuner asks for a login to play a channel'),
          t('home.tv.streamLoginDesc', 'Sends the same login when a channel plays, through the TV, for a tuner that asks for one on its stream port. Needs a user name above.')) +
        (editing ? homeTvSwitchHtml('noLogin', t('home.tv.noLogin', 'The tuner needs no login any more'), t('home.tv.noLoginDesc', 'Remove the saved login.')) : '') +
        `</div><div class="sub">${esc(t('home.tv.tunerNote', 'Reads the bouquets, channels, logos and a week of guide from the tuner’s web interface (OpenWebif). The picture streams straight from the tuner.'))}</div>`
      : f.kind === 'xtream'
      ? field('home-tv-server', t('home.tv.server', 'Server'), 'url', keep || 'http://example.host:8080') +
        field('home-tv-user', t('home.tv.user', 'User name'), 'text', keep) +
        field('home-tv-pass', t('home.tv.pass', 'Password'), 'password', keep)
      : field('home-tv-url', t('home.tv.url', 'Playlist link'), 'url', keep || 'http://example.host/get.php?…')}
    ${f.kind === 'enigma2' ? '' : field('home-tv-guide', t('home.tv.guideLink', 'Guide link (optional)'), 'url', p && p.hasGuideLink ? keep : f.kind === 'xtream' ? t('home.tv.guidePhX', 'Not needed: the guide comes from the login') : t('home.tv.guidePh', 'XMLTV link, if the playlist has none'))}
    <div class="sub">${esc(t('home.tv.private', 'Kept on the TV only, readable by Glasshouse alone. It is never sent to Home Assistant, the logs or this page.'))}</div>
    <div class="wall-foot-btns" style="margin-top:12px">
      <button type="button" class="pill idle" onclick="homeTvSave()">${esc(editing ? t('home.tv.saveEdit', 'Save and read it again') : t('home.tv.saveAdd', 'Add and read it'))}</button>
      <button type="button" class="pill idle" onclick="homeTvForm = null; renderHomeTv()">${esc(t('common.cancel', 'Cancel'))}</button></div>
  </div>`;
}

// An On/Off switch in the form, like the ones elsewhere on the dashboard. It keeps its state in the form and
// changes in place, so what has been typed in the fields stays.
function homeTvSwitchHtml(name, title, desc) {
  const on = !!homeTvForm[name];
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(title)}</div><div class="prot-desc">${esc(desc)}</div></div>
    <div class="prot-status"><button type="button" class="pill pill-toggle ${on ? 'good' : 'idle'}" onclick="homeTvSwitch('${name}', this)">${esc(on ? t('common.on', 'On') : t('common.off', 'Off'))}</button></div>
  </div>`;
}

function homeTvSwitch(name, btn) {
  homeTvForm[name] = !homeTvForm[name];
  btn.className = 'pill pill-toggle ' + (homeTvForm[name] ? 'good' : 'idle');
  btn.textContent = homeTvForm[name] ? t('common.on', 'On') : t('common.off', 'Off');
}

function homeTvOpenForm(kind, id) {
  homeTvForm = { kind, id: id || null };
  renderHomeTv();
  const first = q(id ? 'home-tv-label' : kind === 'xtream' || kind === 'enigma2' ? 'home-tv-server' : 'home-tv-url');
  if (first) first.focus();
}

async function homeTvSave() {
  const f = homeTvForm;
  const val = id => (q(id) ? q(id).value.trim() : '');
  const body = { action: f.id ? 'edit' : 'add', id: f.id || undefined, kind: f.kind, label: val('home-tv-label') };
  if (f.kind === 'xtream' || f.kind === 'enigma2') { body.server = val('home-tv-server'); body.user = val('home-tv-user'); body.pass = val('home-tv-pass'); }
  else body.url = val('home-tv-url');
  if (f.kind === 'enigma2') {
    body.takeOver = !!f.takeOver; if (f.streamLogin) body.streamLogin = true; if (f.noLogin) body.noLogin = true;
    const streamPort = val('home-tv-streamport');
    if (streamPort || f.id) body.streamPort = streamPort;
  }
  else {
    const guide = val('home-tv-guide');
    if (guide || !f.id) body.guide = guide;
  }
  try {
    await homePost('/api/iptv/playlists', body);
    homeTvForm = null;
  } catch (e) {
    const why = { url: t('home.tv.bad.url', 'The playlist link must start with http:// or https://.'),
      server: f.kind === 'enigma2' ? t('home.tv.bad.tuner', 'Enter the tuner’s address, like 192.168.1.10.') : t('home.tv.bad.server', 'The server must start with http:// or https://.'),
      login: t('home.tv.bad.login', 'A user name and password are both needed.'),
      guide: t('home.tv.bad.guide', 'The guide link must start with http:// or https://.'),
      streamPort: t('home.tv.bad.streamPort', 'The stream port must be a number from 1 to 65535.'),
      'too-many': t('home.tv.bad.many', 'Eight playlists is the most the TV keeps.') }[e.message];
    return showErr(why || e.message);
  }
  await homeTvLoad();
  renderHomeTv();
}

async function homeTvAction(action, id) {
  try { await homePost('/api/iptv/playlists', { action, id }); } catch (e) { showErr(e.message); }
  await homeTvLoad();
  renderHomeTv();
}

function homeTvRemove(id) {
  if (homeTvArmed !== id) {
    homeTvArmed = id;
    renderHomeTv();
    setTimeout(() => { if (homeTvArmed === id) { homeTvArmed = null; renderHomeTv(); } }, 4000);
    return;
  }
  homeTvArmed = null;
  homeTvAction('remove', id).then(() => loadHome());
}

// The row as it stands, less one channel (lib/iptv setOrder removes it).
function homeTvRemoveFromRow(id) {
  homeSaveLayout({ order: { iptv: (homeCat.order.iptv || []).filter(x => x !== id) } });
}

/*
 * What the remote's Guide button opens. webOS gives it to LG's own guide of
 * the aerial and satellite channels before any page sees it, so Glasshouse
 * Home's guide is a choice made in the remote's key filter (lib/remotekeys),
 * the same one the Remote tab sets for every key.
 */
function homeGuideKeyHtml() {
  const g = homeGuideKey;
  if (!g || (!g.offered && g.key.id !== 'action:homeGuide')) return '';
  const now = g.key.action === 'lg' ? 'lg' : g.key.id === 'action:homeGuide' ? 'home' : 'other';
  const opt = (v, label) => `<option value="${v}"${now === v ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="prot-row">
    <div class="prot-main"><div class="prot-title"><label for="home-guide-key">${esc(t('home.tv.guideKey', 'The remote’s Guide button'))}</label></div>
      <div class="prot-desc">${esc(now === 'other'
        ? t('home.tv.guideKeyOther', 'Set on the Remote tab to open {name}.', { name: g.key.opens || t('apps.remoteKeys.doesNothing', 'Does nothing') })
        : t('home.tv.guideKeyDesc', 'LG’s guide lists the aerial and satellite channels; Glasshouse Home’s lists the Internet TV channels added here. Info on the Internet TV row opens Glasshouse Home’s guide either way.'))}</div>
      ${g.patch ? `<div class="prot-desc">${esc(t('apps.remoteKeys.guideNative', 'On this TV the Guide key needs a change to LG’s key handler. Setting it restarts the TV’s screen once, and again each time the TV starts.'))}</div>` : ''}</div>
    <div class="prot-status"><select id="home-guide-key" class="pill-sel" ${homeWritable() ? '' : 'disabled'} onchange="homeSetGuideKey(this.value)">
      ${opt('lg', t('home.tv.guideKeyLg', 'LG’s TV guide'))}${opt('home', t('home.tv.guideKeyHome', 'Glasshouse Home’s guide'))}${now === 'other' ? opt('other', g.key.opens || t('home.tv.guideKeyOtherShort', 'Something else')) : ''}
    </select></div></div>`;
}

async function homeSetGuideKey(value) {
  if (value === 'other') return;
  try {
    await homePost('/api/remotekeys', value === 'home' ? { key: 'guide', action: 'open', id: 'action:homeGuide' } : { key: 'guide', action: 'lg' });
  } catch (e) { showErr(e.message); }
  await homeTvLoad();
  renderHomeTv();
}
