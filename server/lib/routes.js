// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var fs = require('fs');
var path = require('path');
var os = require('os');
var net = require('net');
var url = require('url');
var zlib = require('zlib');
var crypto = require('crypto');
var http = require('http');
var say = require('./say');
var localAddress4 = require('./util').localAddress4;
var localAddress6 = require('./util').localAddress6;
var listenDualStack = require('./util').listenDualStack;
var hostPort = require('./util').hostPort;
var sendIconFile = require('./iconserver').sendIconFile;
var writeJsonAtomic = require('./util').writeJsonAtomic;
var unlinkQuiet = require('./util').unlinkQuiet;
var existsQuiet = require('./util').existsQuiet;
var msg = say.msg;
var ha = require('./ha');
var fetchLib = require('./fetch');
var devtools = require('./devtools');
var names = require('./names');

var HA_CATEGORIES = ha.HA_CATEGORIES;
var HA_ENTITIES = ha.HA_ENTITIES;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

/**
 * @param {string|undefined} reqUrl
 * @returns {{ pathname: string, query: Object.<string, any> }}
 */
function parseUrl(reqUrl) {
  if (typeof URL === 'function') {
    try {
      var p = new URL(reqUrl || '/', 'http://127.0.0.1');
      /** @type {Object.<string, any>} */
      var q = {};
      p.searchParams.forEach(function (v, k) { q[k] = v; });
      return { pathname: p.pathname, query: q };
    } catch (e) {}
  }
  return url.parse(reqUrl || '/', true);
}

var config = {};
var configFilePath = '';
/** @type {typeof import('./controls')} */
var controlsModule = null;
/** @type {typeof import('./telemetry')} */
var telemetryModule = null;
/** @type {typeof import('./oled')} */
var oledModule = null;
/** @type {typeof import('./privacy')} */
var privacyModule = null;
/** @type {typeof import('./lgsettings')} */
var lgSettingsModule = null;
/** @type {typeof import('./audio')} */
var audioModule = null;
/** @type {typeof import('./game')} */
var gameModule = null;
/** @type {typeof import('./apps')} */
var appsModule = null;
/** @type {typeof import('./services')} */
var servicesModule = null;
/** @type {typeof import('./preload')} */
var preloadModule = null;
/** @type {typeof import('./quickaccess')} */
var quickAccessModule = null;
/** @type {typeof import('./remotekeys')} */
var remoteKeysModule = null;
/** @type {typeof import('./homescreen')} */
var homeScreenModule = null;
/** @type {typeof import('./home')} */
var homeModule = null;
/** @type {typeof import('./clock')} */
var clockModule = null;
/** @type {typeof import('./home-picture')} */
var homePictureModule = null;
/** @type {typeof import('./screensavers')} */
var screensaversModule = null;
/** @type {typeof import('./updater')} */
var updaterModule = null;
/** @type {typeof import('./logs')} */
var logsModule = null;
var tvAppFn = null;
var restartSelfFn = null;
/** @type {typeof import('./repo')} */
var repoModule = null;
/** @type {typeof import('./installer')} */
var installerModule = null;
/** @type {typeof import('./prometheus')} */
var prometheusModule = null;
/** @type {typeof import('./syslog')} */
var syslogModule = null;
/** @type {typeof import('./ntp')} */
var ntpModule = null;
/** @type {typeof import('./history')} */
var historyModule = null;
/** @type {typeof import('./sshkeys')} */
var sshKeysModule = null;
/** @type {typeof import('./screentime')} */
var screentimeModule = null;
/** @type {typeof import('./backup')} */
var backupModule = null;
var fromHbcFn = null;
var tileHidingOffMsg = '';
var assetPathFn = null;
var assetDirsList = [];
var lunaFn = null;
var getMqttStatusFn = null;
var piccapStatusFn = function (cb) { cb(null); };
var huesyncStatusFn = function (cb) { cb(null); };
var appsChangedFn = function () {};
var versionStr = '';
// With the commit of a git build: what a person reads, and what tells one
// build's assets from another's in an ETag.
var displayVersionStr = '';

// ---------------------------------------------------------------- first-run setup
/*
 * Setup screens on the TV: opening the dashboard to the network and connecting
 * Home Assistant. An installer that leaves SETUP_PENDING shows them at first
 * launch; the Settings tab offers the same afterwards. Everything here is
 * reachable only from the TV (fromTV), and through its own endpoint rather
 * than the control actions, which MQTT and the
 * network can reach: whoever holds the remote is the owner, a phone on the
 * network is not.
 */
var SETUP_PENDING = '/var/lib/tvweb/.setup-pending';
/*
 * Home Assistant is set up on a phone, not typed with a remote. With the
 * dashboard closed the phone cannot reach it, so a second, short-lived
 * listener opens beside it serving only that one form, behind a one-time code
 * carried in the QR code. It closes when the form is sent, after ten minutes,
 * or when the TV leaves the screen - whichever is first.
 */
var HANDOFF = { server: null, code: null, timer: null };
var HANDOFF_MS = 10 * 60 * 1000;

var UI_HTML = null;
var UI_HTML_GZ = null;
var UI_MISSING = 'ui.html';   // the file named by the missing-assets page
var ASSET_CACHE = {};

// What tvweb.js passes to init(). Called as given: a module left unwired fails
// at the call, where it shows, rather than answering with empty data.
function assetPath(rel) { return assetPathFn(rel); }
function fromHomebrewChannel() { return fromHbcFn(); }
function tvApp(action, cb) { return tvAppFn(action, cb); }
function restartSelf() { return restartSelfFn(); }

/*
 * The restart paths below write the config and answer before restarting, so
 * an install at work has to be refused before the write; restartSelf in
 * tvweb.js refuses too, for the callers that do not come through here. A
 * preview waiting for confirmation is not at work.
 */
/*
 * Restarts after the answer has gone out. An install can start in the moment
 * between the check above and the restart, which would then be refused and the
 * saved settings never applied, so the restart waits for it instead.
 */
function restartSoon(ms, what) {
  var told = false;
  setTimeout(function again() {
    if (installerModule && installerModule.isWorking()) {
      if (!told) console.log(what + ': restart waits for the install to finish');
      told = true;
      return setTimeout(again, 2000);
    }
    if (!restartSelf()) console.error(what + ': could not restart - restart manually to apply');
  }, ms);
}

function installBusyRefusal(res) {
  if (!installerModule || !installerModule.isWorking()) return false;
  send(res, 409, JSON.stringify({
    ok: false,
    error: msg('srv.install.busy.restart', 'an install is in progress; restart when it has finished')
  }));
  return true;
}
function doControl(action, value, cb) { return controlsModule.doControl(action, value, cb); }
function luna(uri, payload, cb) { return lunaFn(uri, payload, cb); }
function getMqttStatus() { return getMqttStatusFn(); }

function setupPending() {
  if (config && config.emulateSetup) return true;
  return existsQuiet(SETUP_PENDING);
}

/*
 * Settings the dashboard is allowed to write. Security-sensitive settings in
 * config.json (port, host, allowControl, allowPower, token) stay file-only:
 * those decide who may reach this server at all, and a UI that can widen its
 * own exposure defeats the point of setting them. The one exception is host,
 * from the TV itself during setup - see setNetworkAccess. Experimental feature
 * toggles (allowTileHiding, allowExperimentalScreensavers), allowNetworkDebugger and
 * prometheus.enabled are writable from the Server tab, and iconServer from the
 * MQTT tab: its port answers nothing but the icons the dashboard serves.
 */
function readConfigFile() {
  try {
    if (configFilePath && fs.existsSync(configFilePath)) {
      return JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
  } catch (e) {
    console.warn('config: could not re-read ' + configFilePath + ': ' + e.message);
  }
  return {};
}

function trimmedString(v) { return typeof v === 'string' ? v.trim() : ''; }

/*
 * A topic segment ends up in every topic this bridge publishes. MQTT wildcards
 * and a trailing slash would produce topics Home Assistant silently never
 * matches, which looks like a broken bridge rather than a bad prefix.
 */
function badTopic(v) {
  return !v || /[#+\s]/.test(v) || v.charAt(0) === '/' || v.charAt(v.length - 1) === '/';
}

function validateSettings(j) {
  var m = (j && j.mqtt) || {};
  var d = (j && j.device) || {};
  var out = { mqtt: {}, device: {} }, e = [];

  out.mqtt.enabled = !!m.enabled;
  out.mqtt.host = trimmedString(m.host);
  if (out.mqtt.enabled && !out.mqtt.host) e.push('a broker address is required to enable MQTT');

  if (m.port === null || m.port === undefined || m.port === '') {
    out.mqtt.port = null;
  } else {
    var port = parseInt(m.port, 10);
    if (!(port >= 1 && port <= 65535)) e.push('port must be between 1 and 65535');
    else out.mqtt.port = port;
  }

  out.mqtt.tls = !!m.tls;
  out.mqtt.tlsRejectUnauthorized = m.tlsRejectUnauthorized !== false;
  out.mqtt.username = trimmedString(m.username);

  /*
   * The password is never sent to the browser, so an absent field means
   * "unchanged" rather than "clear it". Clearing needs an explicit "".
   */
  if (typeof m.password === 'string') out.mqtt.password = m.password;

  out.mqtt.topicPrefix = trimmedString(m.topicPrefix) || 'lgtv';
  if (badTopic(out.mqtt.topicPrefix)) e.push('topic prefix cannot contain +, # or spaces, or start or end with /');
  out.mqtt.discoveryPrefix = trimmedString(m.discoveryPrefix) || 'homeassistant';
  if (badTopic(out.mqtt.discoveryPrefix)) e.push('discovery prefix cannot contain +, # or spaces, or start or end with /');

  var iv = parseInt(m.telemetryIntervalMs, 10);
  if (!(iv >= 1000 && iv <= 600000)) e.push('telemetry interval must be between 1000 and 600000 ms');
  else out.mqtt.telemetryIntervalMs = iv;

  out.mqtt.entities = {};
  var me = (m && m.entities) || {};
  for (var c = 0; c < HA_CATEGORIES.length; c++) {
    var cat = HA_CATEGORIES[c].id;
    out.mqtt.entities[cat] = typeof me[cat] === 'boolean' ? me[cat] : true;
  }
  out.mqtt.entities.disabled = Array.isArray(me.disabled) ? me.disabled.filter(function (id) {
    return typeof id === 'string' && /^[a-z0-9_.]{1,64}$/.test(id);
  }) : [];

  /*
   * The device id keys every discovery topic and every entity id in Home
   * Assistant. Changing it orphans the old entities rather than renaming them.
   */
  out.device.id = trimmedString(d.id);
  if (!/^[a-z0-9_]{1,64}$/.test(out.device.id)) e.push('device id must be 1-64 characters of a-z, 0-9 or _');
  out.device.name = trimmedString(d.name);

  // Saved with the MQTT form, whose Launch App select lists the icons' addresses.
  if (j && typeof j.iconServer === 'boolean') out.iconServer = j.iconServer;

  return { errors: e, value: out };
}

function writeSettings(patch, cb) {
  var file = readConfigFile();
  for (var section in patch) {
    if (patch[section] !== null && typeof patch[section] === 'object' && !Array.isArray(patch[section])) {
      file[section] = file[section] || {};
      for (var k in patch[section]) file[section][k] = patch[section][k];
    } else {
      file[section] = patch[section];
    }
  }
  try {
    if (!configFilePath) return cb(new Error('no config file path configured'));
    writeJsonAtomic(configFilePath, file, parseInt('600', 8));
  } catch (err) {
    return cb(err);
  }
  cb(null);
}

/*
 * host is file-only everywhere else so a page cannot widen its own exposure.
 * This is the one writer, and only the TV can reach it.
 */
function setNetworkAccess(open, cb) {
  var file = readConfigFile();
  // Unset, host defaults to dual-stack '::'.
  if (open) delete file.host;
  else file.host = '127.0.0.1';
  try {
    if (!configFilePath) return cb(new Error('no config file path configured'));
    writeJsonAtomic(configFilePath, file, parseInt('600', 8));
  } catch (err) { return cb(err); }
  cb(null);
}

// Whether the dashboard answers on the network, or only on the TV itself.
function networkOpen() {
  return !/^(127\.|::1$|localhost$)/.test(String(config.host));
}

/*
 * The address a phone on the same network can reach this server at. The TV app
 * only ever sees localhost, so it cannot work this out for itself, and a QR
 * code of "localhost" would be useless to the person holding the phone.
 */
function lanOrigin() {
  // Bound to loopback, the server answers nothing on the network, so any LAN
  // address handed to a phone would be a dead link.
  if (!networkOpen()) return null;
  var ip4 = localAddress4();
  return ip4 ? 'http://' + hostPort(ip4, config.port) : null;
}

function prometheusEnabled() {
  return !!(config.prometheus && config.prometheus.enabled === true);
}

// Whether the clocks draw 12-hour time, as the TV's own setting has it (lib/clock).
function clockHour12() {
  return !!(clockModule && clockModule.hour12());
}

function handoffPort() { return (config.port || 8080) + 1; }

function stopHandoff() {
  if (HANDOFF.timer) clearTimeout(HANDOFF.timer);
  if (HANDOFF.server) { try { HANDOFF.server.close(); } catch (e) {} }
  HANDOFF.server = HANDOFF.code = HANDOFF.timer = null;
}

function handoffUrl() {
  var ip4 = localAddress4();
  return ip4 && HANDOFF.code ? 'http://' + hostPort(ip4, handoffPort()) + '/?c=' + HANDOFF.code : null;
}

/*
 * A TV set up from a phone has had no chance to pick a device id or topic
 * prefix, and the defaults are the same on every TV: a second TV would take
 * over the first one's entities in Home Assistant. So one that has neither
 * saved gets its own, from its model and the end of its network address, which
 * also tells two TVs of the same model apart.
 */
function ownIdentity() {
  var file = readConfigFile();
  var fm = file.mqtt || {};
  // One already set up keeps what it has, defaults included: its entities in
  // Home Assistant are named from it.
  if ((file.device && file.device.id) || fm.topicPrefix || fm.host) return null;
  var model = String((config.device && config.device.model) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!model || model === 'webostv') model = 'tv';
  var mac = '', ifaces = {};
  try { ifaces = os.networkInterfaces() || {}; } catch (e) {}
  var ip4 = localAddress4();
  for (var name in ifaces) {
    (ifaces[name] || []).forEach(function (a) { if (a.address === ip4 && a.mac) mac = a.mac; });
  }
  var tail = mac.replace(/[^0-9a-f]/gi, '').slice(-4).toLowerCase();
  var key = (model + (tail ? '_' + tail : '')).slice(0, 40);
  return { id: 'lg_' + key, prefix: 'lgtv_' + key };
}

var simulatedSetupState = {};

function resetSimulatedSetup() {
  simulatedSetupState = { network: null, alwaysReady: null, homeAssistant: null };
}

function isSetupEmulated(query, body) {
  if (config && config.emulateSetup) return true;
  if (query && (query.demo === '1' || query.demo === 'true')) return true;
  if (body && (body.demo === true || body.demo === '1')) return true;
  return false;
}

function setupState(isDemo) {
  var m = config.mqtt || {};
  var mqttStat = getMqttStatus();
  var open = networkOpen();
  if (isDemo && simulatedSetupState.network !== null && simulatedSetupState.network !== undefined) {
    open = simulatedSetupState.network;
  }
  var ip4 = localAddress4(), ip6 = localAddress6();
  var name = telemetryModule ? telemetryModule.localName(ip4, ip6) : null;
  // The TV app shows the address and the name each with the port, as a
  // browser on a phone would open them.
  var st = {
    ok: true,
    needed: setupPending(),
    writable: config.allowControl,
    network: open,
    token: !!config.token,
    address: ip4 ? hostPort(ip4, config.port) : (isDemo ? hostPort('192.168.1.131', config.port || 8080) : null),
    address6: ip6 ? hostPort(ip6, config.port) : null,
    hostname: name ? hostPort(name, config.port) : null,
    homeAssistant: (isDemo && simulatedSetupState.homeAssistant) ? simulatedSetupState.homeAssistant : { configured: !!(m.enabled && m.host), state: mqttStat.state },
    handoff: HANDOFF.server ? handoffUrl() : (isDemo ? 'http://' + hostPort(ip4 || '192.168.1.131', config.port || 8080) + '/?c=demo' : null)
  };
  if (isDemo) {
    st.demo = true;
    if (simulatedSetupState.alwaysReady !== null && simulatedSetupState.alwaysReady !== undefined) {
      st.alwaysReady = simulatedSetupState.alwaysReady;
    }
  }
  return st;
}

function startHandoff(cb) {
  if (HANDOFF.server) return cb(null, handoffUrl());
  if (!localAddress4()) return cb(new Error('this TV has no network address'));
  var code = crypto.randomBytes(8).toString('hex');
  var srv = http.createServer(function (req, res) {
    var u = parseUrl(req.url);
    if (!HANDOFF.code || u.query.c !== HANDOFF.code) {
      return send(res, 403, 'This link has expired. Start again on the TV.', 'text/plain; charset=utf-8');
    }
    if (u.pathname === '/' && req.method === 'GET') {
      var page = assetPath('setup-phone.html');
      if (!page) return send(res, 404, 'setup page missing', 'text/plain');
      return fs.readFile(page, function (err, buf) {
        if (err) return send(res, 500, 'could not read the setup page', 'text/plain');
        send(res, 200, buf, 'text/html; charset=utf-8');
      });
    }
    if (u.pathname === '/mqtt' && req.method === 'POST') {
      if (String(req.headers['content-type'] || '').indexOf('application/json') !== 0) {
        return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
      }
      var body = '';
      req.on('data', function (d) { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', function () {
        var p = null;
        try { p = JSON.parse(body); } catch (e) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
        }
        // The phone supplies the broker; everything else keeps its current value.
        var cur = config.mqtt || {}, dev = config.device || {};
        var own = ownIdentity();
        var v = validateSettings({
          mqtt: {
            enabled: true, host: p.host, port: p.port, tls: !!p.tls,
            tlsRejectUnauthorized: cur.tlsRejectUnauthorized !== false,
            username: p.username, password: typeof p.password === 'string' ? p.password : '',
            topicPrefix: own ? own.prefix : cur.topicPrefix, discoveryPrefix: cur.discoveryPrefix,
            telemetryIntervalMs: cur.telemetryIntervalMs || 10000, entities: cur.entities
          },
          device: own ? { id: own.id, name: dev.name } : { id: dev.id, name: dev.name }
        });
        if (v.errors.length) {
          return send(res, 400, JSON.stringify({ ok: false, error: v.errors.join('; ') }));
        }
        if (installBusyRefusal(res)) return;
        writeSettings(v.value, function (err) {
          if (err) return send(res, 500, JSON.stringify({ ok: false, error: msg('srv.saveSettingsFailed', 'could not save the settings') }));
          console.log('setup: Home Assistant broker set from a phone, restarting to connect');
          send(res, 200, JSON.stringify({ ok: true }));
          stopHandoff();   // the code is spent
          restartSoon(300, 'setup');
        });
      });
      return;
    }
    send(res, 404, 'not found', 'text/plain');
  });
  // IPv4-only if the dashboard is; dual-stack otherwise, even when the
  // dashboard is loopback-only, since the phone connects over the LAN.
  var host = config.host === '0.0.0.0' ? '0.0.0.0' : '::';
  listenDualStack(srv, handoffPort(), host, function (err) {
    if (err) {
      console.error('setup: could not open the phone link: ' + err.message);
      return cb(err);
    }
    srv.on('error', function (e) {
      console.error('setup: phone link failed: ' + e.message);
      stopHandoff();
    });
    HANDOFF.server = srv;
    HANDOFF.code = code;
    HANDOFF.timer = setTimeout(stopHandoff, HANDOFF_MS);
    cb(null, handoffUrl());
  });
}

/*
 * Shown in place of the dashboard when its asset is missing. Deliberately
 * plain and self-contained: it names what is absent and where it was looked
 * for, because the fix is a redeploy and the reader needs to know that rather
 * than be shown numbers. The API and the MQTT bridge are unaffected, so it
 * says that too before anyone assumes the whole server is down.
 */
function missingAssetsPage() {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Glasshouse &middot; dashboard assets missing</title>',
    '<style>',
    'body{background:#000;color:rgba(255,255,255,.8);margin:0;padding:8vw 6vw;',
    '  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'h1{font-size:19px;font-weight:500;color:#fff;margin:0 0 18px}',
    'p{margin:0 0 14px;max-width:62ch}',
    'code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:3px;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}',
    'ul{margin:0 0 14px;padding-left:20px}',
    '.dim{color:rgba(255,255,255,.5);font-size:13px}',
    '</style></head><body>',
    '<h1>Dashboard assets are missing</h1>',
    '<p><code>' + UI_MISSING + '</code> was not found. The server is running normally &mdash;',
    'the JSON API and the Home Assistant MQTT bridge are unaffected &mdash; but it',
    'has no dashboard to serve.</p>',
    '<p>Looked in:</p><ul>',
    assetDirsList.map(function (d) {
      return '<li><code>' + d.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></li>';
    }).join(''),
    '</ul>',
    '<p>Deploying again restores it: <code>./server/deploy.sh &lt;tv-ip&gt;</code>.</p>',
    '<p class="dim">tvweb ' + displayVersionStr + '</p>',
    '</body></html>'
  ].join('\n');
}

/*
 * ui.html names its stylesheet and scripts under assets/ui/, and they are put
 * back inline here, so the browser still gets one page in one gzipped response
 * that is never cached apart from it. The scripts become a single <script> in
 * the order listed, so they behave as one script: a function declared in any
 * of them can be called from the others. Returns the page, or null with
 * UI_MISSING set to the part that could not be read.
 */
function inlineUI(html) {
  var missing = null;
  function part(rel) {
    var f = assetPath(rel);
    if (f) {
      try { return fs.readFileSync(f, 'utf8'); } catch (e) {}
    }
    if (!missing) missing = rel;
    return '';
  }
  html = html.replace(/<link rel="stylesheet" href="\/assets\/(ui\/[\w-]+\.css)">\n/g, function (m, rel) {
    return '<style>\n' + part(rel) + '</style>\n';
  });
  html = html.replace(/(?:<script src="\/assets\/ui\/[\w-]+\.js"><\/script>\n)+/g, function (run) {
    var scripts = run.match(/ui\/[\w-]+\.js/g);
    return '<script>\n' + scripts.map(part).join('') + '</script>\n';
  });
  if (missing) { UI_MISSING = missing; return null; }
  return html;
}

// Called only where something will serve it: not with the web dashboard off,
// nor for a one-shot run such as --update.
function loadUI() {
  var f = assetPath('ui.html');
  if (!f) {
    console.error('assets: ui.html not found in ' + assetDirsList.join(', ') +
                  ' - the dashboard will report it is missing');
    return;
  }
  try {
    var page = inlineUI(fs.readFileSync(f, 'utf8'));
    if (!page) {
      console.error('assets: ' + UI_MISSING + ' not found in ' + assetDirsList.join(', ') +
                    ' - the dashboard will report it is missing');
      return;
    }
    UI_HTML = page;
    /*
     * On this thread rather than zlib's worker pool. Node 0.12's process
     * spawning can deadlock (see lunaCached), and startup launches luna-send
     * repeatedly while an async compression would still be running: the one
     * startup seen to stall, on a B8 straight after an update, stopped with
     * this compression unfinished.
     */
    try {
      UI_HTML_GZ = zlib.gzipSync(UI_HTML);
      console.log('assets: serving ui.html from ' + f + ' (' + Math.round(UI_HTML_GZ.length / 1024) + ' KB compressed)');
    } catch (ze) {
      console.log('assets: serving ui.html from ' + f);
    }
  } catch (e) {
    console.error('assets: could not read ui.html: ' + e.message);
  }
}

// ---------------------------------------------------------------- server
// The TV's own software updates sit beside Glasshouse's in both dashboards,
// with whether the web app debugger is closed to the network.
function updateSummary() {
  var s = updaterModule.updateSummary();
  s.tvUpdatesBlocked = privacyModule.tvUpdatesBlocked();
  s.devtools = devtools.status();
  s.allowNetworkDebugger = !!(config && config.allowNetworkDebugger);
  s.allowTileHiding = !!(appsModule && appsModule.tileHidingAllowed && appsModule.tileHidingAllowed());
  s.allowExperimentalScreensavers = !!(screensaversModule && screensaversModule.allowedAnyway && screensaversModule.allowedAnyway());
  // Where the Server tab offers the switch: custom screen savers are experimental there.
  s.isWebos10 = !!(screensaversModule && screensaversModule.experimental && screensaversModule.experimental());
  s.homeLayout = homeScreenModule ? homeScreenModule.experimental() : null;
  s.prometheusEnabled = prometheusEnabled();
  s.clockHour12 = clockHour12();
  s.watchHistory = historyModule ? historyModule.status() : null;
  s.backupDaily = backupModule ? backupModule.dailyStatus() : null;
  s.ntp = ntpModule ? ntpModule.getStatus() : null;
  // What is saved, on or off, so the switch can show a server kept while off.
  var ntpConf = (config && config.ntp) || {};
  s.ntpSettings = {
    server: typeof ntpConf.server === 'string' ? ntpConf.server.trim() : '',
    port: ntpConf.port || 123,
    enabled: !!(ntpConf.server && String(ntpConf.server).trim()) && ntpConf.enabled !== false
  };
  s.syslog = syslogModule && syslogModule.getStatus ? syslogModule.getStatus() : null;
  var mem = null;
  try {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      mem = process.memoryUsage();
    }
  } catch (e) {}
  s.daemon = {
    uptime: (typeof process !== 'undefined' && process.uptime) ? Math.floor(process.uptime()) : null,
    pid: (typeof process !== 'undefined' && process.pid) ? process.pid : null,
    port: (config && config.port) || 8080,
    rss: (mem && typeof mem.rss === 'number') ? mem.rss : null,
    heapUsed: (mem && typeof mem.heapUsed === 'number') ? mem.heapUsed : null,
    heapTotal: (mem && typeof mem.heapTotal === 'number') ? mem.heapTotal : null
  };
  return s;
}

function send(res, code, body, type) {
  if (!type || type.indexOf('application/json') === 0) {
    body = say.translateBody(body, res && res.glasshouseLang);
  }
  /*
   * No Access-Control-Allow-Origin. The telemetry includes what is currently
   * playing, the model, panel hours and usage, and a wildcard here let any
   * site the user happened to visit read all of it from their browser. The
   * dashboard is same-origin, so it needs no CORS grant.
   */
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

// Compares a presented token with the configured one in time that depends
// only on the configured token's length. node 0.12 has no
// crypto.timingSafeEqual. charCodeAt past the end is NaN, which | and ^ read
// as 0; the length check catches the difference.
function tokenMatches(given) {
  var want = config.token;
  if (typeof given !== 'string') return false;
  var diff = given.length ^ want.length;
  for (var i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function authed(q, req) {
  if (!config.token) return true;
  // RFC 7235 makes the scheme case-insensitive. Any other Authorization
  // header is ignored, so it neither allows nor refuses a valid ?k=.
  var bearer = /^Bearer\s+(\S+)$/i.exec((req && req.headers && req.headers.authorization) || '');
  if (bearer && tokenMatches(bearer[1])) return true;
  if (q && tokenMatches(q.k)) return true;
  // The on-TV dashboard app fetches from localhost and has no way to carry a
  // token (there is no login prompt on a TV remote).  A process on the TV
  // already has root, so the token adds nothing for local requests.
  return !!(req && fromTV(req));
}

// A request made on the TV itself - the on-TV app, or anything else running
// there, which has root already. Nothing on the network can present as this.
function fromTV(req) {
  var ra = (req && req.connection && req.connection.remoteAddress) ||
           (req && req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

/*
 * CSRF guard shared by every POST that changes something. No CORS grant is
 * sent, so another site cannot read the reply - but a POST with a "simple"
 * content type (text/plain, form-urlencoded, multipart/form-data) is still
 * *delivered* without a preflight, and the TV has acted on it by the time the
 * response is discarded. Requiring a type outside that list forces a
 * preflight, which this server never approves, and rejecting cross-site
 * Origins closes the gap for anything that does slip through. `exact` demands
 * the type with no parameters. Sends the refusal and returns false.
 */
function postGuard(req, res, wantType, exact) {
  var ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (exact ? ctype !== wantType : ctype.indexOf(wantType) !== 0) {
    send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be ' + wantType }));
    return false;
  }
  var origin = req.headers.origin;
  if (origin) {
    var hostHdr = String(req.headers.host || '');
    var oHost = String(origin).replace(/^https?:\/\//, '');
    if (oHost !== hostHdr) {
      send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
      return false;
    }
  }
  return true;
}

function readJsonBody(req, res, cb) {
  if (!postGuard(req, res, 'application/json', false)) return;
  var body = '';
  req.on('data', function (d) {
    body += d;
    if (body.length > 8192) req.destroy();
  });
  req.on('end', function () {
    var j = {};
    try { j = JSON.parse(body); } catch (e) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
    }
    if (!j || typeof j !== 'object') {
      return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
    }
    cb(j);
  });
}

/*
 * Installing a package is the most powerful thing the dashboard does, so the
 * Host header is checked before anything else. A page reached through a
 * rebinding name (attacker.example resolving to the TV's address) passes the
 * Origin == Host check and looks like a request from the TV itself; only a
 * name the owner listed in apps.hosts, an IP literal or localhost is served.
 */
function hostName(req) {
  var h = String((req.headers && req.headers.host) || '').toLowerCase();
  var m = /^\[([^\]]*)\](:\d*)?$/.exec(h);
  if (m) return m[1];
  var i = h.lastIndexOf(':');
  if (i !== -1 && h.indexOf(':') === i) h = h.slice(0, i);
  return h.replace(/\.$/, '');
}

function hostAllowed(req) {
  var h = hostName(req);
  if (!h) return false;
  if (net.isIP(h) || h === 'localhost') return true;
  var list = config.apps && config.apps.hosts;
  if (Object.prototype.toString.call(list) !== '[object Array]') return false;
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] === 'string' && list[i].toLowerCase().replace(/\.$/, '') === h) return true;
  }
  return false;
}

// Catalogs that can be added from the dashboard, beside the Homebrew Channel's.
var MAX_REPOS = 10;

function isInstallRoute(pathname) {
  return pathname === '/api/apps/catalog' || pathname.indexOf('/api/apps/install/') === 0;
}

function installError(res, text, status) {
  send(res, status || 400, JSON.stringify({ ok: false, error: text }));
}

function installReply(res) {
  return function (err, snap) {
    if (err) return installError(res, String(err));
    send(res, 200, JSON.stringify({ ok: true, install: snap }));
  };
}

/*
 * URL and upload installs take a package from anywhere, so they are off unless
 * the owner opted in: apps.sideload in config.json (file-only), a token (the
 * owner has taken on access control), or a request from the TV itself. The
 * answer says which, so the page can explain how to turn it on.
 */
function sideloadVia(req) {
  if (config.apps && config.apps.sideload === true) return 'config';
  if (config.token) return 'token';
  if (fromTV(req)) return 'tv';
  return null;
}

function sideloadRefused(res) {
  installError(res, msg('srv.install.sideloadOff',
    'installing from a URL or a file is off; set "apps": {"sideload": true} in config.json, set a token, or use the TV\'s web browser'), 403);
}

// Refused before the body is read, so the connection is closed rather than
// left to carry up to 512 MB that nobody wants.
function refuseUpload(req, res, text, status) {
  installError(res, text, status);
  if (typeof res.on === 'function') res.on('finish', function () { req.destroy(); });
}

function handleUpload(req, res) {
  if (!postGuard(req, res, 'application/octet-stream', true)) return;
  var cl = req.headers['content-length'];
  if (req.headers['transfer-encoding'] || cl === undefined) {
    return refuseUpload(req, res, msg('srv.install.upload.length', 'the upload must state its size in advance'), 411);
  }
  if (!/^\d{1,15}$/.test(String(cl)) || parseInt(cl, 10) <= 0) {
    return refuseUpload(req, res, msg('srv.install.upload.empty', 'the upload is empty or its size is not valid'), 400);
  }
  var len = parseInt(cl, 10);
  // Reserving space can outlast the connection; keep the abort before its reply.
  var endedEarly = false;
  req.on('aborted', function () { endedEarly = true; });
  req.on('close', function () { if (!req.complete) endedEarly = true; });
  installerModule.prepareUpload(len, function (err, file, status) {
    if (endedEarly) {
      if (file) installerModule.releaseUpload(file);
      return;
    }
    if (err) return refuseUpload(req, res, err, status || 400);
    var ws = fs.createWriteStream(file, { flags: 'wx', mode: parseInt('600', 8) });
    var got = 0, done = false;
    var sizeText = msg('srv.install.upload.size', 'the upload does not match its stated size');
    function discard() {
      if (done) return false;
      done = true;
      // A stream destroyed before its file has opened creates the file
      // afterwards, so it is removed again once the stream has closed.
      ws.once('close', function () { fs.unlink(file, function () {}); });
      // Node 0.12's destroy() leaves a pending open's descriptor alive.
      ws.once('open', function () { ws.close(); });
      try { ws.destroy(); } catch (e) {}
      installerModule.releaseUpload(file);
      return true;
    }
    function failWith(text, code) {
      if (discard()) refuseUpload(req, res, text, code);
    }
    req.on('data', function (chunk) {
      if (done) return;
      installerModule.touchUpload();
      got += chunk.length;
      if (got > len) return failWith(sizeText, 400);
      if (!ws.write(chunk) && typeof req.pause === 'function') {
        req.pause();
        ws.once('drain', function () { if (!done) req.resume(); });
      }
    });
    req.on('end', function () {
      if (done) return;
      if (got !== len) return failWith(sizeText, 400);
      ws.end();
    });
    ws.on('finish', function () {
      if (done) return;
      done = true;
      installerModule.start({ source: 'file', path: file }, function (e2, snap) {
        if (e2) installerModule.releaseUpload(file);
        installReply(res)(e2, snap);
      });
    });
    ws.on('error', function () {
      failWith(msg('srv.install.upload.failed', 'the upload could not be saved'), 500);
    });
    // A dropped connection ends the stream without 'end'.
    req.on('aborted', discard);
    req.on('close', function () { if (got !== len) discard(); });
  });
}

function handleInstallRoute(req, res, u, pathname) {
  if (!config.allowControl) return installError(res, msg('srv.controlsOff', 'controls disabled in config'), 403);

  if (pathname === '/api/apps/catalog' && req.method === 'GET') {
    return repoModule.getCatalog(!!(u.query && u.query.force), function (r) {
      send(res, 200, JSON.stringify(r));
    });
  }
  if (pathname === '/api/apps/install/status' && req.method === 'GET') {
    var st = installerModule.status();
    st.ok = true;
    st.writable = !!config.allowControl;
    var via = sideloadVia(req);
    st.sideload = via !== null;
    st.sideloadVia = via;
    return send(res, 200, JSON.stringify(st));
  }
  if (req.method !== 'POST') return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));

  if (pathname === '/api/apps/install/fetch') {
    return readJsonBody(req, res, function (body) {
      if (typeof body.id !== 'string' || !body.id) return installError(res, msg('srv.install.idRequired', 'an app id is required'));
      var from = typeof body.repo === 'string' && body.repo ? body.repo : null;
      repoModule.findPackage(body.id, from, function (err, pkg) {
        if (err) return installError(res, err.message);
        installerModule.start({ source: 'catalog', pkg: pkg, auto: body.auto === true }, installReply(res));
      });
    });
  }
  if (pathname === '/api/apps/install/url') {
    if (!sideloadVia(req)) return sideloadRefused(res);
    return readJsonBody(req, res, function (body) {
      var err = fetchLib.validateUrl(body.url);
      if (err) return installError(res, err);
      var sha = body.sha256;
      if (sha !== undefined && sha !== null && sha !== '' && !/^[0-9a-f]{64}$/i.test(String(sha))) {
        return installError(res, msg('srv.install.badHash', 'the sha256 hash must be 64 hexadecimal digits'));
      }
      installerModule.start({ source: 'url', url: body.url, sha256: sha || null }, installReply(res));
    });
  }
  if (pathname === '/api/apps/install/upload') {
    if (!sideloadVia(req)) return sideloadRefused(res);
    return handleUpload(req, res);
  }
  if (pathname === '/api/apps/install/confirm') {
    return readJsonBody(req, res, function (body) {
      installerModule.confirm({
        jobId: body.jobId, elevate: body.elevate === true, confirmRoot: body.confirmRoot,
        replaceStore: body.replaceStore === true
      }, installReply(res));
    });
  }
  if (pathname === '/api/apps/install/cancel') {
    return readJsonBody(req, res, function (body) {
      installerModule.cancel(body.jobId, function (err) {
        if (err) return installError(res, String(err));
        send(res, 200, JSON.stringify({ ok: true }));
      });
    });
  }
  if (pathname === '/api/apps/install/repos') {
    // A catalog is trusted to offer packages, as a URL install is, so adding
    // or removing one needs what a URL install needs.
    if (!sideloadVia(req)) return sideloadRefused(res);
    return readJsonBody(req, res, function (body) {
      var list = repoModule.repoUrls().slice(1);
      function save(next) {
        config.apps = config.apps || {};
        config.apps.repos = next;
        writeSettings({ apps: { repos: next } }, function (err) {
          if (err) return installError(res, err.message);
          repoModule.forget();
          send(res, 200, JSON.stringify({ ok: true, repos: next }));
        });
      }
      if (body.action === 'remove') {
        var at = list.indexOf(body.url);
        if (at < 0) return installError(res, msg('srv.repo.notAdded', 'that catalog is not one added here'));
        list.splice(at, 1);
        console.log('apps: catalog removed: ' + body.url);
        return save(list);
      }
      if (body.action !== 'add') return installError(res, msg('srv.repo.badAction', 'action must be add or remove'));
      if (list.length >= MAX_REPOS) {
        return installError(res, msg('srv.repo.tooMany', 'at most {n} catalogs can be added', { n: MAX_REPOS }));
      }
      repoModule.checkCatalog(body.url, function (err, found) {
        if (err) return installError(res, err.message);
        if (found === repoModule.DEFAULT_REPO || list.indexOf(found) >= 0) {
          return installError(res, msg('srv.repo.already', 'that catalog is already listed'));
        }
        list.push(found);
        console.warn('security: catalog added from dashboard: ' + found);
        save(list);
      });
    });
  }
  if (pathname === '/api/apps/install/sideload') {
    return readJsonBody(req, res, function (body) {
      var enable = body.enabled === true;
      config.apps = config.apps || {};
      config.apps.sideload = enable;
      writeSettings({ apps: { sideload: enable } }, function (err) {
        if (err) return installError(res, err.message);
        if (enable) {
          console.warn('security: apps.sideload enabled from dashboard; arbitrary IPK installations allowed');
        } else {
          console.log('apps: apps.sideload disabled');
        }
        send(res, 200, JSON.stringify({ ok: true, sideload: enable, sideloadVia: sideloadVia(req) }));
      });
    });
  }
  return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
}

function getSettingsPayload() {
  var mc = config.mqtt || {};
  var mqttStat = getMqttStatus();
  return {
    ok: true,
    writable: config.allowControl,
    configFile: configFilePath,
    iconServer: config.iconServer === true,
    mqtt: {
      enabled: !!mc.enabled,
      host: mc.host || '',
      port: mc.port === undefined ? null : mc.port,
      tls: !!mc.tls,
      tlsRejectUnauthorized: mc.tlsRejectUnauthorized !== false,
      username: mc.username || '',
      // The password is deliberately not returned; only whether one is set.
      passwordSet: !!mc.password,
      topicPrefix: mc.topicPrefix || 'lgtv',
      discoveryPrefix: mc.discoveryPrefix || 'homeassistant',
      telemetryIntervalMs: mc.telemetryIntervalMs || 10000,
      entities: {
        controls: !mc.entities || mc.entities.controls !== false,
        oled: !mc.entities || mc.entities.oled !== false,
        video: !mc.entities || mc.entities.video !== false,
        system: !mc.entities || mc.entities.system !== false,
        diagnostics: !mc.entities || mc.entities.diagnostics !== false,
        disabled: (mc.entities && Array.isArray(mc.entities.disabled)) ? mc.entities.disabled : []
      },
      categories: HA_CATEGORIES,
      entityCatalogue: HA_ENTITIES
    },
    device: {
      id: (config.device && config.device.id) || '',
      name: (config.device && config.device.name) || ''
    },
    /* Ages rather than timestamps: the TV's clock is often minutes off the
       browser's, and a negative "last publish" reads as a fault. */
    status: {
      state: mqttStat.state,
      broker: mqttStat.broker,
      tls: mqttStat.tls,
      detail: mqttStat.detail,
      forMs: Date.now() - (mqttStat.since || Date.now()),
      lastPublishMs: mqttStat.lastPublish ? Date.now() - mqttStat.lastPublish : null,
      latencyMs: mqttStat.latencyMs || null
    }
  };
}

function tileHidingAvailable() {
  return !!(appsModule && appsModule.tileHidingAllowed && appsModule.tileHidingAllowed()) && !fromHomebrewChannel();
}

function lgHomeLayoutAvailable() { return !!(homeScreenModule && homeScreenModule.supported()); }

/*
 * LG's Home's options on the Home tab: its layout (lib/homescreen.js) and the
 * system apps hidden from it (lib/apps.js), in the fields the Apps tab used.
 */
function lgHomeOptions(glasshouseHome, cb) {
  var lg = { writable: !!config.allowControl, glasshouseHome: !!glasshouseHome, homeScreen: null,
    tileHidingAvailable: tileHidingAvailable(), tileHidingHeld: false, tileHidingOverridden: false,
    systemTiles: [], tileHidingEnabled: false, hiddenCount: 0 };
  function withLayout() {
    if (!lgHomeLayoutAvailable()) return cb(lg);
    homeScreenModule.getHomeScreen(function (hs) {
      lg.homeScreen = hs;
      cb(lg);
    });
  }
  // Glasshouse Home hides apps itself, and takes over what tile hiding hid.
  if (glasshouseHome) lg.tileHidingAvailable = false;
  if (!lg.tileHidingAvailable) return withLayout();
  appsModule.getApps(function (d) {
    lg.systemTiles = d.systemTiles || [];
    lg.hiddenCount = d.hiddenCount || 0;
    lg.tileHidingEnabled = !!d.tileHidingEnabled;
    lg.tileHidingNudge = d.tileHidingNudge;
    withLayout();
  });
}

/*
 * Glasshouse Home (lib/home.js). Its view runs on the TV and changes nothing
 * but the layout and what is open, so it needs no allowControl; anything from
 * the network does.
 */
function handleHomeRoute(req, res, u, pathname) {
  function reply(r) { send(res, r && r.ok === false ? 400 : 200, JSON.stringify(r)); }
  if (req.method === 'GET') {
    // ?with=catalogue,channels adds what the TV app's Home section lists, and
    // lghome LG's Home's own options, in one answer.
    if (pathname === '/api/home') {
      var wants = String((u.query && u.query['with']) || '').split(',');
      return homeModule.status(function (st) {
        st.writable = !!config.allowControl || fromTV(req);
        // What the Home pane draws its colour previews' clock as.
        st.clockHour12 = clockHour12();
        // The Home tab also holds LG's Home's layout and hidden system apps, so
        // it is there wherever either is, Glasshouse Home or not (a B8).
        st.lgHomeAvailable = lgHomeLayoutAvailable() || tileHidingAvailable();
        // Open Home at power-on is on the Home tab too, wherever LG has it.
        if (st.lgHomeAvailable || st.homeAutoLaunch !== undefined) st.available = true;
        withLgHome(function () {
          if (wants.indexOf('catalogue') === -1) return reply(st);
          homeModule.catalogue(function (c) {
            st.catalogue = c;
            if (wants.indexOf('channels') === -1) return reply(st);
            homeModule.channelList(function (list) {
              st.channels = list;
              reply(st);
            });
          });
        });
        function withLgHome(next) {
          if (wants.indexOf('lghome') === -1 || !st.lgHomeAvailable) return next();
          lgHomeOptions(st.enabled, function (lg) {
            st.lgHome = lg;
            next();
          });
        }
      });
    }
    if (pathname === '/api/home/catalogue') {
      return homeModule.catalogue(function (c) {
        homeModule.status(function (st) {
          c.ok = true;
          c.layout = st.layout;
          c.enabled = st.enabled;
          c.wallpapers = st.wallpapers;
          c.layoutVersion = homeModule.layoutVersion();
          reply(c);
        });
      });
    }
    if (pathname === '/api/home/channels') {
      return homeModule.channelList(function (list) { reply({ ok: true, channels: list, tuner: !!list }); });
    }
    if (pathname === '/api/home/guide') return homeModule.guide(function (g) { reply({ ok: true, guide: g }); });
    if (pathname === '/api/home/now') return homeModule.now(reply);
    if (pathname === '/api/home/picture') {
      return homePictureModule.picture(String(u.query && u.query.kind || ''), Number(u.query && u.query.port), reply,
        String(u.query && u.query.app || ''));
    }
    if (pathname === '/api/home/wallpaper') {
      var wallpaper = homeModule.wallpaperPath(String(u.query && u.query.slot || ''));
      if (!wallpaper) return send(res, 404, JSON.stringify({ ok: false, error: 'no wallpaper uploaded' }));
      return sendIconFile(req, res, wallpaper, function (status, error) {
        send(res, status, JSON.stringify({ ok: false, error: error }));
      }, 'image/jpeg');
    }
    if (pathname === '/api/home/recents') return homeModule.recentApps.list(reply);
    if (pathname === '/api/home/recents/image') {
      var snapshot = homeModule.recentApps.imagePath(u.query && u.query.id);
      if (!snapshot) return send(res, 404, JSON.stringify({ ok: false, error: 'no picture' }));
      return sendIconFile(req, res, snapshot, function (status, error) {
        send(res, status, JSON.stringify({ ok: false, error: error }));
      }, /\.png$/i.test(snapshot) ? 'image/png' : 'image/jpeg', 'private, no-store');
    }
    if (pathname === '/api/home/icon') {
      return homeModule.iconPath(u.query && u.query.id, function (iconPath) {
        if (!iconPath) return send(res, 404, JSON.stringify({ ok: false, error: 'icon not found' }));
        sendIconFile(req, res, iconPath, function (status, error) {
          send(res, status, JSON.stringify({ ok: false, error: error }));
        });
      });
    }
  }
  if (req.method === 'POST') {
    if (!config.allowControl && !fromTV(req)) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    if (pathname === '/api/home/wallpapers/upload') {
      if (!postGuard(req, res, 'image/jpeg', true)) return;
      return homeModule.uploadWallpaper(String(u.query && u.query.slot || ''), req, function (r) {
        if (!r.ok) return refuseUpload(req, res, r.error, r.status || 400);
        reply(r);
      });
    }
    if (pathname === '/api/home/beat') {
      if (!postGuard(req, res, 'application/json', false)) return;
      req.resume();
      // The hour cycle the view's clock draws, which follows the TV's setting.
      var beatBody = homeModule.beat();
      beatBody.clockHour12 = clockHour12();
      return reply(beatBody);
    }
    return readJsonBody(req, res, function (body) {
      if (pathname === '/api/home/layout') return homeModule.setLayout(body, reply);
      if (pathname === '/api/home/start-layout') return homeModule.setHideLgHomeAtStart(body, reply);
      if (pathname === '/api/home/wallpapers') return homeModule.setWallpapers(body, reply);
      if (pathname === '/api/home/enable') return homeModule.enable(reply);
      if (pathname === '/api/home/disable') return homeModule.disable(reply);
      if (pathname === '/api/home/open') return homeModule.open(body, reply);
      if (pathname === '/api/home/search') return homeModule.search.find(body && body.query, reply);
      if (pathname === '/api/home/search/open') return homeModule.search.open(body, reply);
      if (pathname === '/api/home/recents') {
        var recentApps = homeModule.recentApps, recentId = body && typeof body.id === 'string' ? body.id : '';
        if (body && body.action === 'open') return recentApps.open(recentId, reply);
        if (body && body.action === 'close') return recentApps.close(recentId, reply);
        if (body && body.action === 'closeAll') return recentApps.closeAll(reply);
        return reply({ ok: false, error: 'action must be open, close or closeAll' });
      }
      send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    });
  }
  send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
}

function handleRequest(req, res) {
  var u = parseUrl(req.url);
  var pathname = u.pathname;
  /** @type {any} */ (res).glasshouseLang = say.langOf(req);

  if (pathname === '/' || pathname === '/index.html') {
    if (UI_HTML) {
      var enc = req.headers['accept-encoding'] || '';
      if (UI_HTML_GZ && enc.indexOf('gzip') !== -1) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': UI_HTML_GZ.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        return res.end(UI_HTML_GZ);
      }
      return send(res, 200, UI_HTML, 'text/html; charset=utf-8');
    }
    // 503, not 200: the dashboard is genuinely unavailable, and a monitor
    // polling this should see that rather than a page that says so in prose.
    return send(res, 503, missingAssetsPage(), 'text/html; charset=utf-8');
  }

  if (pathname.indexOf('/assets/') === 0) {
    var file = assetPath(pathname.slice('/assets/'.length));
    if (!file) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    var ext = path.extname(file).toLowerCase();
    var mime = MIME[ext] || 'application/octet-stream';
    // The strings and their translations change with each release as the pages
    // do, so a day-old copy beside a new page would show text the page no
    // longer has, or miss text it now does.
    var fresh = ext === '.html' || ext === '.json' || /(^|\/)i18n\.js$/.test(file);
    var cacheHdr = fresh ? 'no-cache' : 'public, max-age=86400';
    var respondWithBuf = function (buf) {
      var etag = '"' + (displayVersionStr || '1') + '-' + buf.length.toString(16) + '"';
      if (req.headers && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheHdr });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Cache-Control': cacheHdr,
        'ETag': etag
      });
      res.end(buf);
    };
    if (ASSET_CACHE[file]) {
      return respondWithBuf(ASSET_CACHE[file]);
    }
    return fs.readFile(file, function (e, buf) {
      if (e) return send(res, 500, JSON.stringify({ ok: false, error: 'read failed' }));
      ASSET_CACHE[file] = buf;
      respondWithBuf(buf);
    });
  }

  if (isInstallRoute(pathname) && !hostAllowed(req)) {
    return send(res, 403, JSON.stringify({
      ok: false,
      error: msg('srv.install.hostRefused', 'this address is not allowed to install apps; add the name to apps.hosts in config.json, or use the TV\'s IP address')
    }));
  }

  if (pathname.indexOf('/api/') === 0 && !authed(u.query, req)) {
    return send(res, 401, JSON.stringify({ ok: false, error: 'bad or missing token' }));
  }

  if (pathname === '/api/caps') {
    // Glasshouse Home's page waiting for the server (lib/home.js watchStart).
    if (u.query && u.query.from === 'home' && fromTV(req) && homeModule) homeModule.pageAlive();
    var caps = {
      ok: true, allowControl: config.allowControl, allowPower: config.allowPower,
      // Bare: the Homebrew Channel app's launch page compares it with its own.
      origin: lanOrigin(), version: versionStr,
      fromHomebrewChannel: fromHomebrewChannel(), setupNeeded: setupPending(),
      // The hour cycle the dashboard's own clock draws.
      clockHour12: clockHour12()
    };
    // The token goes into the TV's QR codes, so a phone that scans one can use
    // what it opens. Only to the TV itself: whoever sees the screen holds the
    // remote, and the remote needs no token.
    if (config.token && fromTV(req)) caps.key = config.token;
    return send(res, 200, JSON.stringify(caps));
  }

  if (pathname === '/api/audio' && audioModule) {
    if (req.method === 'GET') {
      return audioModule.status(function (r) {
        r.writable = !!config.allowControl;
        if (u.query.with !== 'settings') return send(res, 200, JSON.stringify(r));
        // The Audio tabs show LG's sound settings beside the readings.
        lgSettingsModule.collect(['sound', 'hdmi'], function (ls) {
          r.lgSettings = ls.rows;
          r.inputs = telemetryModule.inputNameMap;
          send(res, 200, JSON.stringify(r));
        });
      });
    }
    return send(res, 405, JSON.stringify({ ok: false, error: 'method not allowed' }));
  }

  if (pathname === '/api/screensaver') {
    return send(res, 200, JSON.stringify(screensaversModule.screensaverList()));
  }

  if (pathname === '/api/hdmi') {
    return telemetryModule.hdmiInputs(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/servicemenu') {
    return oledModule.serviceMenuState(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/logs') {
    if (!logsModule) return send(res, 503, JSON.stringify({ ok: false, error: 'logs module unavailable' }));
    var sourcesParam = u.query.sources ? String(u.query.sources).split(',') : null;
    var limitParam = u.query.limit ? parseInt(u.query.limit, 10) : 100;
    var filterParam = u.query.filter ? String(u.query.filter) : '';
    var redactParam = u.query.redact === '1' || u.query.redact === 'true';
    return logsModule.getLogs({
      sources: sourcesParam,
      limit: limitParam,
      filter: filterParam,
      since: u.query.since ? String(u.query.since) : '',
      redact: redactParam
    }, function (err, result) {
      if (err) return send(res, 500, JSON.stringify({ ok: false, error: err.message }));
      send(res, 200, JSON.stringify(result));
    });
  }

  // First-run setup and the TV's own settings. The TV only: see fromTV.
  if (pathname === '/api/setup') {
    var isDemo = isSetupEmulated(u.query);
    if (!fromTV(req) && !isDemo) return send(res, 403, JSON.stringify({ ok: false, error: 'only from the TV itself' }));
    if (req.method === 'GET') {
      /*
       * Setup offers Always-on only on a TV that has it (a C2 on webOS 9.2
       * does, a B8 on 4.4 does not). A B8 still answers for the alwaysOn value,
       * so whether the TV has the feature is telemetry's alwaysOnSupported.
       */
      var checkAR = (telemetryModule && typeof telemetryModule.alwaysOnSupported === 'function')
        ? telemetryModule.alwaysOnSupported
        : function (cb) { cb(false); };
      return checkAR(function (has) {
        var st = setupState(isDemo);
        if (!has && !isDemo) return send(res, 200, JSON.stringify(st));
        if (isDemo) {
          if (st.alwaysReady === undefined) st.alwaysReady = false;
          return send(res, 200, JSON.stringify(st));
        }
        luna('com.webos.service.settings/getSystemSettings',
             { category: 'general', keys: ['alwaysOn'] }, function (r) {
          var ar = r && r.returnValue !== false && r.settings && r.settings.alwaysOn;
          if (ar !== undefined && ar !== null) st.alwaysReady = ar === 'on' || ar === true;
          send(res, 200, JSON.stringify(st));
        });
      });
    }
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'GET or POST' }));
    if (String(req.headers['content-type'] || '').toLowerCase().indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
    }
    var stBody = '';
    req.on('data', function (d) { stBody += d; if (stBody.length > 1024) req.destroy(); });
    req.on('end', function () {
      var a = null;
      try { a = JSON.parse(stBody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      var actionDemo = isDemo || isSetupEmulated(u.query, a);
      if (actionDemo) {
        if (a.action === 'network') {
          simulatedSetupState.network = !!a.open;
          return send(res, 200, JSON.stringify({ ok: true, restarting: false, demo: true }));
        }
        if (a.action === 'alwaysReady') {
          simulatedSetupState.alwaysReady = !!a.on;
          return send(res, 200, JSON.stringify({ ok: true, demo: true }));
        }
        if (a.action === 'handoff') {
          var dummyUrl = (lanOrigin() || 'http://' + hostPort(localAddress4() || '192.168.1.131', config.port || 8080)) + '/?c=demo';
          return send(res, 200, JSON.stringify({ ok: true, url: dummyUrl, demo: true }));
        }
        if (a.action === 'handoffStop') {
          return send(res, 200, JSON.stringify({ ok: true, demo: true }));
        }
        if (a.action === 'done') {
          return send(res, 200, JSON.stringify({ ok: true, demo: true }));
        }
        return send(res, 400, JSON.stringify({ ok: false, error: 'unknown action' }));
      }
      if (!config.allowControl && a.action !== 'done') {
        return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
      }
      if (a.action === 'network') {
        if (installBusyRefusal(res)) return;
        var open = !!a.open;
        if (open === networkOpen()) return send(res, 200, JSON.stringify({ ok: true, restarting: false }));
        return setNetworkAccess(open, function (err) {
          if (err) return send(res, 500, JSON.stringify({ ok: false, error: msg('srv.saveSettingFailed.plain', 'could not save the setting') }));
          console.log('setup: dashboard ' + (open ? 'opened to the network' : 'closed to this TV') + ', restarting');
          /*
           * Answer before restarting: the restart kills this process, and the
           * browser needs the result to know the save itself succeeded.
           */
          send(res, 200, JSON.stringify({ ok: true, restarting: true }));
          restartSoon(250, 'setup');
        });
      }
      if (a.action === 'alwaysReady') {
        return doControl('alwaysReady', !!a.on, function (r) {
          send(res, r && r.ok ? 200 : 500, JSON.stringify(r && r.ok ? { ok: true } : { ok: false, error: msg('srv.tvRefused', 'the TV would not change it') }));
        });
      }
      if (a.action === 'handoff') {
        return startHandoff(function (err, link) {
          if (err) return send(res, 500, JSON.stringify({ ok: false, error: err.message }));
          send(res, 200, JSON.stringify({ ok: true, url: link }));
        });
      }
      if (a.action === 'handoffStop') {
        stopHandoff();
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (a.action === 'done') {
        unlinkQuiet(SETUP_PENDING);
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      send(res, 400, JSON.stringify({ ok: false, error: 'unknown action' }));
    });
    return;
  }

  if (pathname === '/api/tvapp') {
    return tvApp('status', function (r) {
      if (r && r.ok) r.writable = config.allowControl;
      send(res, 200, JSON.stringify(r));
    });
  }

  if (pathname === '/api/oledcare') {
    return telemetryModule.collectStats(function (st) {
      var oledData = (st && st.oled) || {};
      send(res, 200, JSON.stringify({
        ok: true,
        isOled: !!(st && st.oled),
        available: !!(st && st.oled),
        // Whether this TV has the service the service menu goes through.
        serviceControls: oledModule.oledProtControllable(),
        writable: config.allowControl,
        // null where the TV says nothing; oled.js has the precedence.
        gsr: (oledData.gsr_enabled === undefined) ? null : oledData.gsr_enabled,
        tpc: (oledData.tpc_enabled === undefined) ? null : oledData.tpc_enabled,
        gsrStressCount: (oledData.gsr_stress_count === undefined) ? null : oledData.gsr_stress_count,
        screenShift: oledData.screen_shift || null,
        logoDimming: oledData.logo_dimming || null,
        // The panel's own wear figures, which belong beside the switches
        // that decide how hard it is worked.
        panelHours: (oledData.panel_hours === undefined) ? null : oledData.panel_hours,
        hoursUntilComp: (oledData.hours_until_comp === undefined) ? null : oledData.hours_until_comp,
        compInterval: (oledData.comp_interval_hours === undefined) ? 4 : oledData.comp_interval_hours,
        hoursUntilRefresher: (oledData.hours_until_refresher === undefined) ? null : oledData.hours_until_refresher,
        refresherInterval: (oledData.refresher_interval_hours === undefined) ? 2000 : oledData.refresher_interval_hours,
        compStatus: oledData.comp_status || null,
        refresherStatus: oledData.refresher_status || null,
        compCycles: (oledData.comp_cycles === undefined) ? null : oledData.comp_cycles,
        refresherCycles: (oledData.refresher_cycles === undefined) ? null : oledData.refresher_cycles,
        failureAlerts: (oledData.failure_alerts === undefined) ? null : oledData.failure_alerts
      }));
    });
  }

  // Watch time, by UTC hour, for the last days (35 unless asked, at most 400).
  if (pathname === '/api/history' && historyModule) {
    var historyDays = parseInt(u.query.days, 10);
    if (!(historyDays >= 1 && historyDays <= 400)) historyDays = 35;
    var historyNow = Date.now();
    var historyReply = historyModule.query(historyNow - historyDays * 86400000, historyNow);
    historyReply.ok = true;
    return send(res, 200, JSON.stringify(historyReply));
  }

  /*
   * The keys that may log in as root over SSH: GET lists them, POST adds one,
   * removes one or deletes the file. A key is a way in that outlasts this
   * server, so changing them needs a token, which every /api/ request has
   * then been checked for. A request from the TV itself is not enough: a page
   * in its browser reached through a rebinding name, or any app on the TV,
   * comes from 127.0.0.1 too, and a key added that way is root.
   */
  if (pathname === '/api/ssh' && sshKeysModule) {
    var sshNeedsToken = !config.token;
    if (req.method !== 'POST') {
      return sshKeysModule.status(function (r) {
        r.writable = !!config.allowControl && !sshNeedsToken;
        r.needsToken = !!config.allowControl && sshNeedsToken;
        // A key's comment is often its owner's address: only for whoever could change the keys.
        if (sshNeedsToken) {
          (r.keys || []).forEach(function (k) { delete k.comment; delete k.options; });
        }
        send(res, 200, JSON.stringify(r));
      });
    }
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    if (sshNeedsToken) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.ssh.needsToken', 'Changing SSH keys needs a token in config.json.') }));
    }
    return readJsonBody(req, res, function (body) {
      var sshReply = function (r) {
        if (r.ok) r.writable = true;
        send(res, r.ok ? 200 : 400, JSON.stringify(r));
      };
      if (body.action === 'add') return sshKeysModule.add(body.key, sshReply);
      if (body.action === 'remove') return sshKeysModule.remove(String(body.fingerprint || ''), sshReply);
      if (body.action === 'deleteFile') return sshKeysModule.deleteFile(sshReply);
      send(res, 400, JSON.stringify({ ok: false, error: 'unknown action' }));
    });
  }
  // Screen-time limits: GET for the Advanced tab, POST to change any of the settings.
  if (pathname === '/api/screentime' && screentimeModule) {
    if (req.method !== 'POST') {
      var stReply = screentimeModule.status(Date.now());
      stReply.ok = true;
      stReply.writable = !!config.allowControl;
      return send(res, 200, JSON.stringify(stReply));
    }
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    return readJsonBody(req, res, function (body) {
      var st = screentimeModule.validate(body);
      if (st.error) return send(res, 400, JSON.stringify({ ok: false, error: st.error }));
      writeSettings({ screenTime: st.value }, function (err) {
        if (err) return send(res, 500, JSON.stringify({ ok: false, error: 'could not save setting: ' + err.message }));
        screentimeModule.apply(st.value);
        var stSaved = screentimeModule.status(Date.now());
        stSaved.ok = true;
        stSaved.writable = true;
        send(res, 200, JSON.stringify(stSaved));
      });
    });
  }

  if (pathname === '/api/cpu') {
    return telemetryModule.collectCpuProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/processes') {
    var allProcesses = u.query.all === '1' || u.query.all === 'true';
    return telemetryModule.collectProcesses(allProcesses, function (r) { send(res, 200, JSON.stringify(r)); });
  }

  // LG's Game Optimizer settings, for the game input and genre in use, and
  // the picture mode, since LG applies them only in its Game Optimizer mode.
  if (pathname === '/api/game') {
    return lgSettingsModule.collect('game', function (g) {
      if (!g.rows.length) return send(res, 200, JSON.stringify({ ok: true, available: false }));
      lunaFn('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['pictureMode'] }, function (p) {
        send(res, 200, JSON.stringify({
          ok: true, available: true, rows: g.rows,
          input: g.dimensions.other ? g.dimensions.other.gameInput : null,
          pictureMode: (p && p.settings && p.settings.pictureMode) || null
        }));
      });
    });
  }

  // Rows of lgsettings.js for the dashboards: ?section=sound,devices.
  if (pathname === '/api/lgsettings') {
    var secs = String(u.query.section || '').split(',').filter(Boolean);
    return lgSettingsModule.collect(secs, function (r) {
      // The names the TV gives its inputs, for the HDMI table.
      r.inputs = telemetryModule.inputNameMap;
      send(res, 200, JSON.stringify(r));
    });
  }

  // Polled once a second while the Game tab is open; see game.js. The input's
  // pipeline keeps running, and reporting, behind an app, so a reading counts
  // only while that input is the app on screen.
  if (pathname === '/api/game/fps') {
    var fps = gameModule.frameRate();
    return lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
      var inputKey = (telemetryModule && telemetryModule.inputKey) || names.shortAppId;
      var onScreen = !!(fps.port && fg && fg.appId && names.hdmiKeyForPortId(fps.port) === inputKey(fg.appId));
      send(res, 200, JSON.stringify({ ok: true, fps: onScreen ? fps : { frameRate: 0, vrrType: 'off', port: null } }));
    });
  }

  /*
   * The owner's own hosts list for the ad blocker: { mode, text } uploads one,
   * { mode } changes how it is used, { clear: true } removes it. Larger than
   * /api/control takes, so a route of its own, held to the same rules.
   */
  if (pathname === '/api/adblock/custom' && req.method === 'POST') {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    if (!postGuard(req, res, 'application/json', false)) return;
    var cbody = '';
    var ctoo = false;
    req.on('data', function (d) {
      cbody += d;
      if (cbody.length > 1048576) { ctoo = true; req.destroy(); }
    });
    req.on('end', function () {
      if (ctoo) return;
      var cj = null;
      try { cj = JSON.parse(cbody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      if (!cj || typeof cj !== 'object') {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      privacyModule.setCustomHosts(cj, function (r) { send(res, r.ok ? 200 : 400, JSON.stringify(r)); });
    });
    return;
  }

  if (pathname === '/api/privacy') {
    return privacyModule.collectPrivacy(function (pv) { send(res, 200, JSON.stringify(pv)); });
  }

  if (isInstallRoute(pathname)) return handleInstallRoute(req, res, u, pathname);

  if (pathname === '/api/apps' && req.method === 'GET') {
    return appsModule.getApps(function (d) {
      d.tileHidingAvailable = tileHidingAvailable();
      if (!d.tileHidingAvailable) { d.systemTiles = []; d.tileHidingEnabled = false; d.hiddenCount = 0; }
      d.tileHidingHeld = false;
      d.tileHidingOverridden = false;
      servicesModule.getServices(function (sRes) {
        if (sRes && sRes.services) d.services = sRes.services;
        if (!preloadModule) return send(res, 200, JSON.stringify(d));
        preloadModule.getPreload(function (pRes) {
          d.preload = (pRes && pRes.apps) || [];
          if (!quickAccessModule) return send(res, 200, JSON.stringify(d));
          quickAccessModule.getQuickAccess(function (qa) {
            d.quickAccess = qa && qa.supported ? qa : null;
            if (!remoteKeysModule) return send(res, 200, JSON.stringify(d));
            remoteKeysModule.getRemoteKeys(function (rk) {
              d.remoteKeys = rk && rk.supported ? rk : null;
              send(res, 200, JSON.stringify(d));
            });
          });
        });
      });
    });
  }

  if (pathname === '/api/apps/icon' && (req.method === 'GET' || req.method === 'HEAD')) {
    var iconAppId = u.query && u.query.id;
    return appsModule.getIconPath(iconAppId, function (iconPath) {
      if (!iconPath) return send(res, 404, JSON.stringify({ ok: false, error: 'icon not found' }));
      sendIconFile(req, res, iconPath, function (status, error) {
        send(res, status, JSON.stringify({ ok: false, error: error }));
      });
    });
  }

  if (pathname === '/api/apps/add-page' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.addSavedPage(body && body.address, body && body.title, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/remove-page' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.removeSavedPage(body && body.launchPointId, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  // /api/apps/rename is the name it had in 0.55.0, when only the title changed.
  if ((pathname === '/api/apps/edit-page' || pathname === '/api/apps/rename') && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.editSavedPage(body && body.launchPointId, body && body.title, body && body.address, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/uninstall' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.uninstallApp(body.id, function (r) {
        if (r && r.ok) appsChangedFn();
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if ((pathname === '/api/apps/hide' || pathname === '/api/apps/unhide') && fromHomebrewChannel()) {
    return send(res, 400, JSON.stringify({ ok: false, error: tileHidingOffMsg }));
  }
  if (pathname === '/api/apps/hide' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.hideTile(body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/unhide' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.unhideTile(body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/unhide-all' && req.method === 'POST') {
    return readJsonBody(req, res, function () {
      appsModule.unhideAllTiles(function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/tile-hiding' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      if (body && body.enabled && homeModule && homeModule.enabled()) {
        return send(res, 400, JSON.stringify({ ok: false, error: msg('srv.apps.tilesGlasshouseHome', 'Glasshouse Home hides apps itself: arrange them there') }));
      }
      appsModule.setTileHidingEnabled(body && body.enabled, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/services' && req.method === 'GET') {
    return servicesModule.getServices(function (d) { send(res, 200, JSON.stringify(d)); });
  }

  if (pathname === '/api/services/toggle' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      servicesModule.toggleService(body && body.id, !!(body && body.disabled), function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/homescreen' && req.method === 'POST') {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    return readJsonBody(req, res, function (body) {
      if (!homeScreenModule) return send(res, 503, JSON.stringify({ ok: false, error: 'home screen module unavailable' }));
      function done(r) { send(res, r && r.ok ? 200 : 400, JSON.stringify(r)); }
      body = body || {};
      if (typeof body.allow === 'boolean') {
        var allowHome = body.allow;
        return writeSettings({ allowHomeLayout: allowHome }, function (err) {
          if (err) return done({ ok: false, error: 'could not save setting: ' + err.message });
          config.allowHomeLayout = allowHome;
          homeScreenModule.allowChanged(allowHome, done);
        });
      }
      if (body.restore === true) return homeScreenModule.restore(done);
      if (typeof body.part === 'string') return homeScreenModule.setPart(body.part, !!body.shown, done);
      if (typeof body.input === 'string') return homeScreenModule.setInput(body.input, !!body.onHome, done);
      done({ ok: false, error: 'part, input or restore expected' });
    });
  }

  if (pathname.indexOf('/api/home/') === 0 || pathname === '/api/home') {
    if (homeModule) return handleHomeRoute(req, res, u, pathname);
  }

  if (pathname === '/api/quickaccess' && req.method === 'POST') {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    return readJsonBody(req, res, function (body) {
      if (!quickAccessModule) return send(res, 503, JSON.stringify({ ok: false, error: 'quick access module unavailable' }));
      quickAccessModule.setQuickAccess(body && body.key, body && body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/remotekeys' && req.method === 'POST') {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    return readJsonBody(req, res, function (body) {
      if (!remoteKeysModule) return send(res, 503, JSON.stringify({ ok: false, error: 'remote keys module unavailable' }));
      remoteKeysModule.setRemoteKey(body && body.key, body && body.action, body && body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/preload/toggle' && req.method === 'POST') {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    return readJsonBody(req, res, function (body) {
      if (!preloadModule) return send(res, 503, JSON.stringify({ ok: false, error: 'preload module unavailable' }));
      preloadModule.setPreloadOff(body && body.id, !!(body && body.off), function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  // While switched off the endpoint does not exist: it falls through to the 404.
  if (pathname === '/api/prometheus/metrics' && prometheusEnabled()) {
    return telemetryModule.collectStats(function (s) {
      var forwarded = syslogModule ? syslogModule.getCounters() : null;
      var clock = ntpModule ? ntpModule.getStatus() : null;
      var watched = historyModule && historyModule.status().running ? historyModule.totals() : null;
      send(res, 200, prometheusModule.render(s, versionStr, forwarded, clock, watched), 'text/plain; version=0.0.4; charset=utf-8');
    });
  }

  if (pathname === '/api/stats') {
    return telemetryModule.collectStats(function (s) {
      // PicCap's capture and Hue Sync's streaming, where installed, for the
      // Advanced tab.
      piccapStatusFn(function (pc) {
        huesyncStatusFn(function (hs) {
          if (!pc && !hs && !clockModule && u.query.with !== 'settings') return send(res, 200, JSON.stringify(s));
          // Copied, since s is telemetry's cache.
          var copy = {};
          for (var k in s) copy[k] = s[k];
          if (clockModule) copy.clockHour12 = clockHour12();
          if (pc) copy.piccapCapture = pc;
          if (hs) copy.huesyncStreaming = hs;
          if (u.query.with !== 'settings') return send(res, 200, JSON.stringify(copy));
          // The TV dashboard's System page, which reads one endpoint, also
          // lists the sound and SIMPLINK settings.
          lgSettingsModule.collect(['sound', 'hdmi', 'devices'], function (ls) {
            copy.lgSettings = ls.rows;
            send(res, 200, JSON.stringify(copy));
          });
        });
      });
    });
  }

  /* Reports what is known, and never checks on its own: the dashboard polls
     this, and a poll that reached GitHub would be a request per viewer. */
  if (pathname === '/api/update') {
    return send(res, 200, JSON.stringify(updateSummary()));
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!authed(u.query, req)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    return send(res, 200, JSON.stringify(getSettingsPayload()));
  }

  // The apps a restored backup listed that this TV still lacks, for the Apps tab.
  if (pathname === '/api/backup/apps' && req.method === 'GET' && backupModule) {
    return backupModule.pendingApps(function (apps) { send(res, 200, JSON.stringify({ ok: true, apps: apps })); });
  }
  if (pathname === '/api/backup/apps/clear' && req.method === 'POST' && backupModule) {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    backupModule.clearPendingApps();
    return send(res, 200, JSON.stringify({ ok: true, apps: [] }));
  }

  // A daily backup kept on the TV, by name, saved by the browser as a file.
  if (pathname === '/api/backup/saved' && req.method === 'GET' && backupModule) {
    var savedBackup = backupModule.readSaved(String(u.query.name || ''));
    if (savedBackup === null) return send(res, 404, JSON.stringify({ ok: false, error: 'no such backup' }));
    return send(res, 200, savedBackup);
  }

  // A backup of the TV's settings, saved by the browser as a file.
  if (pathname === '/api/backup' && req.method === 'GET' && backupModule) {
    return backupModule.create(function (b) { send(res, 200, JSON.stringify(b)); });
  }

  /*
   * Restoring one changes LG's settings, so it is held to what saving the
   * dashboard's settings is: controls on, JSON, and from this origin.
   */
  if (pathname === '/api/backup' && req.method === 'POST' && backupModule) {
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    if (String(req.headers['content-type'] || '').toLowerCase().indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
    }
    var borigin = req.headers.origin;
    if (borigin && String(borigin).replace(/^https?:\/\//, '') !== String(req.headers.host || '')) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
    }
    var bbody = '';
    req.on('data', function (d) {
      bbody += d;
      if (bbody.length > 65536) req.destroy();
    });
    req.on('end', function () {
      var b = null;
      try { b = JSON.parse(bbody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      if (installBusyRefusal(res)) return;
      backupModule.restore(b, function (r) {
        send(res, r.ok ? 200 : 400, JSON.stringify(r));
        if (r.restart) restartSoon(250, 'backup');
      });
    });
    return;
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!authed(u.query, req)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    var sctype = String(req.headers['content-type'] || '').toLowerCase();
    if (sctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
    }
    var sorigin = req.headers.origin;
    if (sorigin && String(sorigin).replace(/^https?:\/\//, '') !== String(req.headers.host || '')) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
    }
    var sbody = '';
    req.on('data', function (d) {
      sbody += d;
      if (sbody.length > 8192) req.destroy();
    });
    req.on('end', function () {
      var j = null;
      try { j = JSON.parse(sbody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      var v = validateSettings(j);
      if (v.errors.length) {
        return send(res, 400, JSON.stringify({ ok: false, error: v.errors.join('; ') }));
      }
      if (installBusyRefusal(res)) return;
      writeSettings(v.value, function (err) {
        if (err) {
          return send(res, 500, JSON.stringify({ ok: false, error: 'could not write ' + configFilePath + ': ' + err.message }));
        }
        console.log('config: saved to ' + configFilePath + ', restarting to apply');
        send(res, 200, JSON.stringify({ ok: true, restarting: true }));
        restartSoon(250, 'settings');
      });
    });
    return;
  }

  if (pathname === '/api/control' && req.method === 'POST') {
    var ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({
        ok: false, error: 'Content-Type must be application/json'
      }));
    }
    var origin = req.headers.origin;
    if (origin) {
      var hostHdr = String(req.headers.host || '');
      var oHost = String(origin).replace(/^https?:\/\//, '');
      if (oHost !== hostHdr) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
      }
    }
    var body = '';
    req.on('data', function (d) {
      body += d;
      if (body.length > 4096) req.destroy();   // do not buffer junk
    });
    req.on('end', function () {
      var j = null;
      try { j = JSON.parse(body); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      if (!j || typeof j !== 'object') {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      doControl(j.action, j.value, function (r) { send(res, 200, JSON.stringify(r)); });
    });
    return;
  }

  send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
}

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.configFile) configFilePath = opts.configFile;
  if (opts.controls) controlsModule = opts.controls;
  if (opts.telemetry) telemetryModule = opts.telemetry;
  if (opts.oled) oledModule = opts.oled;
  if (opts.privacy) privacyModule = opts.privacy;
  if (opts.lgSettings) lgSettingsModule = opts.lgSettings;
  if (opts.audio) audioModule = opts.audio;
  if (opts.game) gameModule = opts.game;
  if (opts.apps) appsModule = opts.apps;
  if (opts.services) servicesModule = opts.services;
  if (opts.preload) preloadModule = opts.preload;
  if (opts.quickAccess) quickAccessModule = opts.quickAccess;
  if (opts.remoteKeys) remoteKeysModule = opts.remoteKeys;
  if (opts.homeScreen) homeScreenModule = opts.homeScreen;
  if (opts.home) homeModule = opts.home;
  if (opts.clock) clockModule = opts.clock;
  if (opts.homePicture) homePictureModule = opts.homePicture;
  if (opts.screensavers) screensaversModule = opts.screensavers;
  if (opts.updater) updaterModule = opts.updater;
  if (opts.logs) logsModule = opts.logs;
  if (opts.tvApp) tvAppFn = opts.tvApp;
  if (opts.restartSelf) restartSelfFn = opts.restartSelf;
  if (opts.piccapStatus) piccapStatusFn = opts.piccapStatus;
  if (opts.huesyncStatus) huesyncStatusFn = opts.huesyncStatus;
  if (opts.repo) repoModule = opts.repo;
  if (opts.installer) installerModule = opts.installer;
  if (opts.prometheus) prometheusModule = opts.prometheus;
  if (opts.syslog) syslogModule = opts.syslog;
  if (opts.ntp) ntpModule = opts.ntp;
  if (opts.history) historyModule = opts.history;
  if (opts.sshKeys) sshKeysModule = opts.sshKeys;
  if (opts.screentime) screentimeModule = opts.screentime;
  if (opts.backup) backupModule = opts.backup;
  if (opts.fromHomebrewChannel) fromHbcFn = opts.fromHomebrewChannel;
  if (opts.tileHidingOff) tileHidingOffMsg = opts.tileHidingOff;
  if (opts.assetPath) assetPathFn = opts.assetPath;
  if (opts.assetDirs) assetDirsList = opts.assetDirs;
  if (opts.luna) lunaFn = opts.luna;
  if (opts.getMqttStatus) getMqttStatusFn = opts.getMqttStatus;
  if (opts.appsChanged) appsChangedFn = opts.appsChanged;
  if (opts.version) versionStr = displayVersionStr = opts.version;
  if (opts.displayVersion) displayVersionStr = opts.displayVersion;

  return {
    handleRequest: handleRequest,
    send: send,
    readJsonBody: readJsonBody,
    authed: authed,
    fromTV: fromTV,
    validateSettings: validateSettings,
    writeSettings: writeSettings,
    readConfigFile: readConfigFile,
    localAddress4: localAddress4,
    networkOpen: networkOpen,
    lanOrigin: lanOrigin,
    setupPending: setupPending,
    setupState: setupState,
    startHandoff: startHandoff,
    stopHandoff: stopHandoff,
    setNetworkAccess: setNetworkAccess,
    loadUI: loadUI
  };
}

module.exports = {
  init: init,
  handleRequest: handleRequest,
  send: send,
  readJsonBody: readJsonBody,
  authed: authed,
  fromTV: fromTV,
  validateSettings: validateSettings,
  writeSettings: writeSettings,
  readConfigFile: readConfigFile,
  setNetworkAccess: setNetworkAccess,
  localAddress4: localAddress4,
  networkOpen: networkOpen,
  lanOrigin: lanOrigin,
  setupPending: setupPending,
  setupState: setupState,
  resetSimulatedSetup: resetSimulatedSetup,
  isSetupEmulated: isSetupEmulated,
  startHandoff: startHandoff,
  stopHandoff: stopHandoff,
  loadUI: loadUI,
  inlineUI: inlineUI,
  updateSummary: updateSummary,
  missingAssetsPage: missingAssetsPage,
  parseUrl: parseUrl,
  MIME: MIME
};
