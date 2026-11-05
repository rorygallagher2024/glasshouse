#!/usr/bin/env node
/*
 * scripts/fake-iptv.js - a fake IPTV provider for driving Internet TV hard
 * (dev only, not deployed)
 *
 *   node scripts/fake-iptv.js [--port 8090] [--channels 3000] [--guide-channels 400] [--no-video]
 *
 * --channels 100000 makes a 100k-entry playlist; --guide-channels 16000 a
 * guide of about 200 MB unzipped, for the size drills.
 *
 * Serves, on every address of this computer:
 *   /playlist.m3u            an M3U with the quirks real ones have: a BOM,
 *                            CRLF, names with commas, #EXTGRP, #EXTVLCOPT
 *                            headers, #KODIPROP DRM, films and series mixed
 *                            in, duplicates differing only in a token, and a
 *                            url-tvg header. ?mode=401|403|429|500|slow|
 *                            truncate|html|gzip misbehaves on purpose.
 *   /player_api.php          Xtream: user "demo" / "demo", and the canary
 *                            account canary-user-7Q2 / canary-pass-9Z4. A
 *                            wrong password is auth 0 with HTTP 200; three in
 *                            a minute block the address for a minute.
 *                            max_connections 1, active_cons counted from
 *                            segment fetches in the last 12 s.
 *   /live/u/p/<id>.m3u8      302 to a token that expires in 90 s.
 *   /xmltv.php, /guide.xml.gz  an XMLTV guide, gzipped, for every channel.
 *   /hls/<n>/index.m3u8      three live test-pattern channels from ffmpeg
 *                            (a clock, a tone): 1 with CORS, 2 without, 3 with.
 *   /admin/rotate            rotates every M3U token (a token-rotation drill).
 *   /admin/state             counts: logins, active connections, requests.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
let port = 8090, channels = 3000, video = true, guideChannels = 400, moreGroups = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = +args[++i];
  else if (args[i] === '--channels') channels = +args[++i];
  else if (args[i] === '--no-video') video = false;
  else if (args[i] === '--guide-channels') guideChannels = +args[++i];
  else if (args[i] === '--groups') moreGroups = +args[++i];
}

const ACCOUNTS = { demo: 'demo', 'canary-user-7Q2': 'canary-pass-9Z4' };
const GROUPS = ['UK | Sport', 'UK | News', 'UK | Entertainment', 'Kids', 'Documentaries', 'Music, Radio & More', 'US | Sport'];
// --groups adds country groups, as a subscription of hundreds of them lists them.
const COUNTRIES = ['DE', 'FR', 'ES', 'IT', 'NL', 'PT', 'PL', 'TR', 'AR', 'IN', 'PK', 'CA', 'AU', 'IE', 'SE', 'NO', 'DK', 'GR', 'RO', 'BR'];
const KINDS = ['Sport', 'News', 'Entertainment', 'Movies', 'Kids', 'Music'];
const ALL_GROUPS = GROUPS.concat([].concat(...COUNTRIES.map(c => KINDS.map(k => `${c} | ${k}`))).slice(0, Math.max(0, moreGroups)));
const NAMES = {
  'UK | Sport': ['Harbour Sport 1', 'Harbour Sport 2', 'Harbour Sport News', 'Northlight Arena', 'Velo Channel', 'Racing Live', 'Fight Night'],
  'UK | News': ['Harbour News', 'World Today', 'Parliament Live', 'Market Watch'],
  'UK | Entertainment': ['Channel One HD', 'Channel Two HD', 'Escape, Laugh & Cry', 'Retro Gold'],
  Kids: ['Cartoon Bay', 'Little Learners'],
  Documentaries: ['Deep Planet', 'History Lab', 'Wild Coast'],
  'Music, Radio & More': ['Hits 24', 'Classic FM Live'],
  'US | Sport': ['Eastern Sports 1', 'Gridiron Live']
};
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-iptv-'));
let rotation = 1;
const state = { logins: 0, failedLogins: {}, blocked: {}, segments: [], requests: 0, playlistRequests: 0 };

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}
const HOST = lanAddress();
const BASE = `http://${HOST}:${port}`;

// ---------------------------------------------------------------- channels

// The channel list both the M3U and Xtream answer from.
function channelList() {
  const out = [];
  let n = 1;
  for (const g of GROUPS) for (const name of NAMES[g]) out.push({ id: n, num: n++, name, group: g, epg: name.toLowerCase().replace(/[^a-z0-9]+/g, '.') + '.uk' });
  // Filler, to reach the size asked for.
  while (out.length < channels) {
    const g = ALL_GROUPS[out.length % ALL_GROUPS.length];
    out.push({ id: n, num: n, name: `${g.split('|').pop().trim()} ${n}`, group: g, epg: `filler${n}.fake` });
    n++;
  }
  return out;
}
const LIST = channelList();

function streamFor(id) { return 1 + (id % 3); }

// ---------------------------------------------------------------- m3u

function m3u(token) {
  const lines = ['﻿#EXTM3U url-tvg="' + BASE + '/guide.xml.gz" x-tvg-url="' + BASE + '/guide.xml.gz"'];
  for (const c of LIST) {
    lines.push(`#EXTINF:-1 tvg-id="${c.epg}" tvg-name="${c.name}" tvg-logo="${BASE}/logo/${c.id}.png" group-title="${c.group}" tvg-chno="${c.num}",${c.name}`);
    lines.push(`${BASE}/hls/${streamFor(c.id)}/index.m3u8?ch=${c.id}&token=${token}`);
  }
  // Quirks.
  lines.push('#EXTINF:-1 tvg-id="needs.ua" group-title="UK | Sport",Harbour Sport 1 (Needs Headers)');
  lines.push('#EXTVLCOPT:http-user-agent=SomePlayer/1.0');
  lines.push(`${BASE}/hls/1/index.m3u8?ua=1`);
  lines.push('#EXTINF:-1 tvg-id="drm.one" group-title="UK | Sport",Locked Sport');
  lines.push('#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha');
  lines.push('#KODIPROP:inputstream.adaptive.license_key=https://licence.example/wv');
  lines.push(`${BASE}/dash/locked.mpd`);
  lines.push('#EXTINF:-1 group-title="Films",A Film (2024)');
  lines.push(`${BASE}/movie/demo/demo/1001.mp4`);
  lines.push('#EXTINF:-1 tvg-id="series.one",Some Series S01E01');
  lines.push(`${BASE}/series/demo/demo/2001.mkv`);
  lines.push('#EXTINF:-1 tvg-id="grp.one",Group From EXTGRP');
  lines.push('#EXTGRP:Documentaries');
  lines.push(`${BASE}/hls/2/index.m3u8?grp=1`);
  // Duplicates: identical metadata, different URLs; and two differing only in a token.
  lines.push('#EXTINF:-1 tvg-id="dup.uk" group-title="UK | News",Harbour News Backup');
  lines.push(`${BASE}/hls/1/index.m3u8?dup=a`);
  lines.push('#EXTINF:-1 tvg-id="dup.uk" group-title="UK | News",Harbour News Backup');
  lines.push(`${BASE}/hls/2/index.m3u8?dup=b`);
  lines.push('#EXTINF:-1 tvg-id="tok.uk" group-title="UK | News",Token Twin');
  lines.push(`${BASE}/hls/3/index.m3u8?token=A${rotation}`);
  lines.push('#EXTINF:-1 tvg-id="tok.uk" group-title="UK | News",Token Twin');
  lines.push(`${BASE}/hls/3/index.m3u8?token=B${rotation}`);
  lines.push('#EXTINF:-1 tvg-id="pipe.ua" group-title="US | Sport",Pipe Headers|ignored');
  lines.push(`${BASE}/hls/1/index.m3u8|User-Agent=Foo&Referer=http://x`);
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- guide

const SHOWS = ['Live: Leeds v Fulham', 'World Today', 'The Final Word', 'Darts Live', 'Tour Highlights', 'Morning Briefing',
  'Deep Planet: Oceans', 'Retro Gold Hour', 'Market Close', 'Late Kick-Off', 'Classic Rounds', 'Cartoon Marathon'];

function xmltv() {
  const now = Date.now();
  const start0 = Math.floor((now - 2 * 3600000) / 1800000) * 1800000;
  const fmt = t => {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
  };
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="fake-iptv">\n'];
  for (const c of LIST) parts.push(`<channel id="${c.epg}"><display-name lang="en">${c.name.replace(/&/g, '&amp;')}</display-name></channel>\n`);
  for (const c of LIST.slice(0, guideChannels)) {
    let t = start0;
    let i = c.id;
    while (t < now + 50 * 3600000) {
      const len = (1 + (i % 3)) * 1800000;
      const title = SHOWS[i % SHOWS.length].replace(/&/g, '&amp;');
      parts.push(`<programme start="${fmt(t)}" stop="${fmt(t + len)}" channel="${c.epg}"><title lang="en">${title}</title><desc lang="en">About ${title} on ${c.name.replace(/&/g, '&amp;')} &#8211; part ${i}.</desc></programme>\n`);
      t += len;
      i++;
    }
  }
  parts.push('</tv>\n');
  return parts.join('');
}
let guideGz = null, guideAt = 0;
function guide() {
  if (!guideGz || Date.now() - guideAt > 30 * 60000) { guideGz = zlib.gzipSync(xmltv()); guideAt = Date.now(); }
  return guideGz;
}

// ---------------------------------------------------------------- xtream

function account(user, pass) {
  const now = Math.floor(Date.now() / 1000);
  const ok = ACCOUNTS[user] && ACCOUNTS[user] === pass;
  if (!ok) return { user_info: { auth: 0 } };
  return {
    user_info: { username: user, password: pass, auth: 1, status: 'Active', exp_date: String(now + 120 * 86400), is_trial: '0',
      active_cons: String(activeCons()), max_connections: '1', allowed_output_formats: ['m3u8', 'ts', 'rtmp'] },
    server_info: { url: HOST, port: String(port), server_protocol: 'http', timezone: 'Europe/London', timestamp_now: now }
  };
}

/*
 * Connections as a panel counts them: one per client address that fetched a
 * segment in the last 12 s, so a TV changing channel replaces its own
 * connection rather than needing a second. Overlap is reported apart:
 * sessions (a stream's token, or its channel for an M3U) fetching segments
 * in the last 4 s, two segments' length, which a correct teardown keeps at 1.
 */
function prune() {
  const cut = Date.now() - 12000;
  state.segments = state.segments.filter(s => s.at > cut);
}
function activeCons(except) {
  prune();
  return new Set(state.segments.filter(s => s.client !== except).map(s => s.client)).size;
}
function concurrentSessions() {
  const cut = Date.now() - 4000;
  return new Set(state.segments.filter(s => s.at > cut).map(s => s.session)).size;
}

const tokens = {};
function issueToken(id) {
  const t = crypto.randomBytes(8).toString('hex');
  tokens[t] = { id, until: Date.now() + 90000 };
  return t;
}

function shortEpg(id, limit) {
  const c = LIST.find(x => x.id === id);
  if (!c) return { epg_listings: [] };
  const now = Date.now(), out = [];
  let t = Math.floor((now - 3600000) / 1800000) * 1800000, i = id;
  while (out.length < limit) {
    const len = (1 + (i % 3)) * 1800000;
    if (t + len > now) {
      out.push({ id: String(i), title: Buffer.from(SHOWS[i % SHOWS.length]).toString('base64'),
        description: Buffer.from('Short EPG for ' + c.name).toString('base64'), lang: 'en',
        start: new Date(t).toISOString().replace('T', ' ').slice(0, 19), end: new Date(t + len).toISOString().replace('T', ' ').slice(0, 19),
        start_timestamp: String(Math.floor(t / 1000)), stop_timestamp: String(Math.floor((t + len) / 1000)) });
    }
    t += len;
    i++;
  }
  return { epg_listings: out };
}

// ---------------------------------------------------------------- video

function startVideo() {
  if (!video) return;
  for (const n of [1, 2, 3]) {
    const out = path.join(work, 'hls', String(n));
    fs.mkdirSync(out, { recursive: true });
    const colours = { 1: '0x1d3557', 2: '0x6a040f', 3: '0x2d6a4f' };
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=25`,
      '-f', 'lavfi', '-i', `sine=frequency=${300 + n * 110}:sample_rate=48000`,
      // testsrc counts the seconds itself; the band's colour tells the channels apart.
      '-filter_complex', `[0:v]drawbox=x=0:y=0:w=iw:h=90:color=${colours[n]}@1:t=fill,drawbox=x=0:y=ih-90:w=iw:h=90:color=${colours[n]}@1:t=fill[v]`,
      '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '50', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+omit_endlist', '-hls_segment_filename', path.join(out, 'seg-%05d.ts'), path.join(out, 'index.m3u8')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
    ff.on('exit', code => console.error(`ffmpeg ${n} exited ${code}`));
    process.on('exit', () => ff.kill('SIGKILL'));
  }
}

// ---------------------------------------------------------------- logos

/*
 * The jumble real playlists have, drawn with rsvg-convert where it is
 * installed: white type on transparent, black type on transparent, a
 * full-colour square, coloured spaced type, and a photo-like full box.
 */
const logoCache = {};
function logoFile(id) {
  if (logoCache[id] !== undefined) return logoCache[id];
  const c = LIST.find(x => x.id === id) || { name: 'Channel ' + id };
  const words = c.name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const short = words.map(w => /^\d+$/.test(w) ? w : w[0]).join('').slice(0, 4).toUpperCase();
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const styles = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="0" y="92" font-family="Helvetica" font-weight="bold" font-size="84" fill="#ffffff">${esc(words.slice(0, 2).join(' ').toUpperCase())}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="0" y="92" font-family="Georgia" font-size="90" fill="#111111">${esc(words[0].toLowerCase())}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="24" fill="#1d4ed8"/><text x="100" y="128" text-anchor="middle" font-family="Helvetica" font-weight="bold" font-size="88" fill="#fbbf24">${esc(short)}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120"><text x="0" y="92" font-family="Helvetica" font-size="88" letter-spacing="28" fill="#dc2626">${esc(words[0].toUpperCase().slice(0, 5))}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#84cc16"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="240" cy="60" r="34" fill="#fde68a"/><text x="20" y="160" font-family="Helvetica" font-weight="bold" font-size="40" fill="#ffffff">${esc(words.slice(0, 2).join(' '))}</text></svg>`
  ];
  const svg = path.join(work, `logo-${id}.svg`), png = path.join(work, `logo-${id}.png`);
  try {
    fs.writeFileSync(svg, styles[id % 6 === 5 ? 0 : id % 5]);
    require('child_process').execFileSync('rsvg-convert', ['-o', png, svg]);
    logoCache[id] = png;
  } catch (e) { logoCache[id] = null; }
  return logoCache[id];
}

// ---------------------------------------------------------------- server

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAQ0lEQVR42u3PMQ0AAAgDIN8/9K3hQAI6m1sBCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIfLsBa+QAIW9Wl+IAAAAASUVORK5CYII=', 'base64');

const server = http.createServer((req, res) => {
  state.requests++;
  const u = new URL(req.url, BASE);
  const p = u.pathname, q = u.searchParams;
  const who = req.socket.remoteAddress;
  if (p === '/admin/rotate') { rotation++; return send(res, 200, { rotation }); }
  if (p === '/admin/state') return send(res, 200, { rotation, logins: state.logins, active: activeCons(), concurrentSessions: concurrentSessions(), requests: state.requests, playlistRequests: state.playlistRequests, blocked: state.blocked });
  if (p === '/playlist.m3u' || p === '/get.php') {
    state.playlistRequests++;
    const mode = q.get('mode');
    if (mode === '401' || mode === '403' || mode === '500') return send(res, +mode, 'no', 'text/plain');
    if (mode === '429') return send(res, 429, 'slow down', 'text/plain', { 'Retry-After': '7200' });
    if (mode === 'html') return send(res, 200, '<html><body>Not a playlist</body></html>', 'text/html');
    const body = m3u(q.get('token') || 'T' + rotation);
    if (mode === 'gzip') return send(res, 200, zlib.gzipSync(body), 'audio/x-mpegurl');
    if (mode === 'truncate') {
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl', 'Content-Length': String(Buffer.byteLength(body)) });
      res.write(body.slice(0, Math.floor(body.length / 3)));
      return setTimeout(() => res.destroy(), 300);
    }
    if (mode === 'slow') {
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= body.length) { clearInterval(timer); return res.end(); }
        res.write(body.slice(i, i + 200)); i += 200;
      }, 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    return send(res, 200, body, 'audio/x-mpegurl');
  }
  if (p === '/player_api.php') {
    if (state.blocked[who] && state.blocked[who] > Date.now()) return send(res, 403, 'blocked', 'text/plain');
    const user = q.get('username'), pass = q.get('password'), action = q.get('action');
    const a = account(user, pass);
    if (!a.user_info.auth) {
      const f = (state.failedLogins[who] || []).filter(t => t > Date.now() - 60000);
      f.push(Date.now());
      state.failedLogins[who] = f;
      if (f.length >= 3) state.blocked[who] = Date.now() + 60000;
      return send(res, 200, a);
    }
    if (!action) { state.logins++; return send(res, 200, a); }
    if (action === 'get_live_categories') {
      return send(res, 200, ALL_GROUPS.map((g, i) => ({ category_id: String(i + 1), category_name: g, parent_id: 0 })));
    }
    if (action === 'get_live_streams') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
      LIST.forEach((c, i) => {
        res.write((i ? ',' : '') + JSON.stringify({ num: c.num, name: c.name, stream_type: 'live', stream_id: c.id,
          stream_icon: `${BASE}/logo/${c.id}.png`, epg_channel_id: c.epg, added: '1700000000', category_id: String(ALL_GROUPS.indexOf(c.group) + 1),
          custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0 }));
      });
      return res.end(']');
    }
    if (action === 'get_short_epg') return send(res, 200, shortEpg(+q.get('stream_id'), +(q.get('limit') || 4)));
    if (action === 'get_vod_streams' || action === 'get_series') return send(res, 500, 'catalogue requested', 'text/plain');
    return send(res, 200, []);
  }
  if (p === '/xmltv.php' || p === '/guide.xml.gz') return send(res, 200, guide(), 'application/xml');
  let m = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.(m3u8|ts)$/.exec(p);
  if (m) {
    if (ACCOUNTS[decodeURIComponent(m[1])] !== decodeURIComponent(m[2])) return send(res, 401, 'no', 'text/plain');
    if (activeCons(who) >= 1) return send(res, 403, 'max connections', 'text/plain');
    const id = +m[3];
    return send(res, 302, '', 'text/plain', { Location: `${BASE}/hls/${streamFor(id)}/index.m3u8?ch=${id}&token=${issueToken(id)}` });
  }
  m = /^\/hls\/(\d)\/(index\.m3u8|seg-\d+\.ts)$/.exec(p);
  if (m) {
    const n = +m[1];
    const cors = n !== 2 ? { 'Access-Control-Allow-Origin': '*' } : {};
    const tok = q.get('token');
    if (tok && tokens[tok] && tokens[tok].until < Date.now()) return send(res, 403, 'token expired', 'text/plain', cors);
    const f = path.join(work, 'hls', String(n), m[2]);
    if (!fs.existsSync(f)) return send(res, 404, 'not yet', 'text/plain', cors);
    if (m[2] === 'index.m3u8') {
      // The M3U's links come straight here: the same one-connection limit as /live.
      if (!tokens[tok] && activeCons(who) >= 1) return send(res, 403, 'max connections', 'text/plain', cors);
      // Segment URIs keep the query, so a token follows each one.
      const text = fs.readFileSync(f, 'utf8').replace(/^(seg-\d+\.ts)$/mg, `$1${u.search}`);
      return send(res, 200, text, 'application/vnd.apple.mpegurl', cors);
    }
    // An M3U's token is the playlist's, shared by every channel: its channel is the session.
    state.segments.push({ client: who, session: tokens[tok] ? tok : 'm3u-' + (q.get('ch') || n) + '-' + (q.get('dup') || ''), at: Date.now() });
    return send(res, 200, fs.readFileSync(f), 'video/mp2t', cors);
  }
  m = /^\/logo\/(\d+)\.png$/.exec(p);
  if (m) {
    const id = +m[1];
    // One in six is a dead link, as real playlists' are.
    if (id % 6 === 5) return send(res, 404, 'gone', 'text/plain');
    const f = logoFile(id);
    return send(res, 200, f ? fs.readFileSync(f) : PNG, 'image/png');
  }
  send(res, 404, 'not found', 'text/plain');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`fake IPTV provider on ${BASE}`);
  console.log(`  M3U:    ${BASE}/playlist.m3u   (${LIST.length} channels)`);
  console.log(`  Xtream: server ${BASE}  user demo  password demo`);
  console.log(`  Guide:  ${BASE}/guide.xml.gz`);
  startVideo();
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
