// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var say = require('./say');
var msg = say.msg;
var list = say.list;
var fs = require('fs');
var readTrimmed = require('./util').readTrimmed;
var execFile = require('child_process').execFile;

var ADBLOCK_HOSTS_FILE = '/var/lib/tvweb/adblock_hosts';
// The repository's old name, kept: TVs' hosts files already carry this line,
// and it is how the blocker finds its own entries.
var ADBLOCK_MARKER = '# LG Ad & Telemetry Blackhole (lg-webos-dashboard)';
var ADBLOCK_LEGACY_MARKER = '# LG Ad & Telemetry Blackhole (lg-webos-mqtt)';
var ADBLOCK_FLAG_FILE = '/var/lib/tvweb/adblock_enabled';

var ADBLOCK_ADS = [
  'ad.lgsmartad.com',
  'ibis.lgappstv.com',
  'ibs.lgappstv.com',
  'lgsmartad.com',
  'rdx.lgtvcommon.com',
  'aic.lgtvcommon.com',
  'smartad.lge.com',
  'smartclip.com',
  'smartclip-services.com',
  'yumenetworks.com',
  // Alphonso is LG Ad Solutions' screen recognition (ACR) service. The TV asks
  // prov-lg for its setup and eulacheck for consent before anything else.
  'alphonso.tv',
  'prov-lg.alphonso.tv',
  'prov.alphonso.tv',
  'eulacheck.alphonso.tv',
  'bl-server.alphonso.tv',
  'clockskew.alphonso.tv',
  'acrdb.alphonso.tv',
  'ads.alphonso.tv',
  'api.alphonso.tv',
  'tvads.alphonso.tv',
  'sync.alphonso.tv',
  'tr.alphonso.tv',
  'tn.alphonso.tv',
  'insights.alphonso.tv',
  'bwlkup.alphonso.tv',
  // Seen on port 4433 from a factory-reset TV, while its setup still showed
  // the agreements unanswered (docs/ACR.md). Numbered siblings are not known.
  'eu-acr86.alphonso.tv'
];

/*
 * The firmware builds these names with a prefix (gb.info.lgsmartad.com,
 * aic.cdpbeacon.lgtvcommon.com), and a hosts file only matches whole names. A
 * TV uses its own country code and LG's regional ones, so those are listed
 * rather than every country, which would cost the B8 ~4ms a lookup (74KB
 * table). The bare lgtvsdp.com family also serves the Content Store, which is
 * why only its rdx2 ad subdomain is here.
 */
var ADBLOCK_REGIONAL = [
  'info.lgsmartad.com',
  'rdx2.lgtvsdp.com',
  'ibs.lgappstv.com',
  'ibsstat.lgappstv.com',
  'cdpbeacon.lgtvcommon.com',
  'cdpsvc.lgtvcommon.com',
  'wau.lgtvcommon.com'
];
var ADBLOCK_REGION_PREFIXES = ['aic', 'eic', 'kic', 'eu'];
// Until the TV has reported its country, the countries LG is seen using.
var ADBLOCK_FALLBACK_COUNTRIES = ['us', 'gb', 'au', 'br', 'ca', 'de', 'fr'];
var COUNTRY_FILE = '/var/lib/tvweb/country';

function adBlockAds() {
  var country = (readTrimmed(COUNTRY_FILE) || '').toLowerCase();
  var prefixes = ADBLOCK_REGION_PREFIXES.concat(/^[a-z]{2}$/.test(country) ? [country] : ADBLOCK_FALLBACK_COUNTRIES);
  var list = ADBLOCK_ADS.slice();
  ADBLOCK_REGIONAL.forEach(function (name) {
    [name].concat(prefixes.map(function (p) { return p + '.' + name; }))
      .forEach(function (h) { if (list.indexOf(h) === -1) list.push(h); });
  });
  return list;
}

var ADBLOCK_PLATFORM = [
  'lgtvsdp.com',
  'us.lgtvsdp.com',
  'gb.lgtvsdp.com',
  'eu.lgtvsdp.com',
  'ngfts.lge.com',
  'aic-ngfts.lge.com',
  // From Huttunen's blocklist (docs/IMPLEMENTATION.md), not a capture of ours.
  // lgtviot.com is the ThinQ cloud, so the ThinQ app loses the TV on this tier.
  'cdplauncher.lgtvcommon.com',
  'lgchhomeapp.lgtvcommon.com',
  'lgtviot.com',
  'ueiwsp.com'
];

var ADBLOCK_SDP = [
  'nextlgsdp.com',
  'us.nextlgsdp.com',
  'gb.nextlgsdp.com',
  'eu.nextlgsdp.com'
];
var SDP_POLL_INTERVAL_MS = 3000;
var SDP_SLOW_POLL_INTERVAL_MS = 30000;
var SDP_SOURCE_WAIT_MS = 120000;
var sdpGraceActive = true;
var sdpAnySourceAccepted = false;
var sdpPollTimer = null;
var sdpCapTimer = null;


/*
 * The Homebrew Channel blackholes LG's update servers when its own flag file is
 * there, in a table it bind-mounts at boot - and it does that before running the
 * hooks that mount this one over the top (its startup.sh blocks at line 62 and
 * runs run-parts at 136). Switching this blocker on would otherwise switch its
 * update blocking off, silently, so its hosts go into this table too.
 */
var HBC_BLOCK_UPDATES_FLAG = '/var/luna/preferences/webosbrew_block_updates';
var HBC_UPDATE_HOSTS = ['snu.lge.com', 'su-dev.lge.com', 'su.lge.com', 'su-ssl.lge.com'];

/*
 * The owner's own list, uploaded from the dashboard. Only its names are kept,
 * apart from the lists above, and the table is built from both each time it
 * is written, so an update that adds or drops names in this version's lists
 * takes effect at the next start without the list being sent again. "add"
 * blocks the names with the tier's, "replace" blocks them instead of the
 * tier's; either way only while the blocker is on.
 */
var ADBLOCK_CUSTOM_FILE = '/var/lib/tvweb/adblock_custom.json';
var CUSTOM_MAX_NAMES = 10000;
var CUSTOM_SINK_ADDRS = { '0.0.0.0': 1, '127.0.0.1': 1, '::': 1, '::1': 1 };
var CUSTOM_NOT_NAMES = { 'localhost': 1, 'localhost.localdomain': 1, 'local': 1, 'broadcasthost': 1,
                         'ip6-localhost': 1, 'ip6-loopback': 1, 'ip6-localnet': 1, 'ip6-mcastprefix': 1,
                         'ip6-allnodes': 1, 'ip6-allrouters': 1, 'ip6-allhosts': 1, '0.0.0.0': 1 };
var customCache;   // undefined until read; null when there is no list

var CONSENT_LABELS = {
  acrAllowed:              [msg('srv.consent.acrAllowed', 'Screen content recognition'), msg('srv.consent.acrAllowed.detail', 'Lets LG identify what is on your screen to profile your viewing')],
  acrGdprAllowed:          [msg('srv.consent.acrGdprAllowed', 'Screen recognition (GDPR consent)'), msg('srv.consent.acrGdprAllowed.detail', 'The EU consent record for screen content recognition')],
  acrAdAllowed:            [msg('srv.consent.acrAdAllowed', 'Ads based on what you watch'), msg('srv.consent.acrAdAllowed.detail', 'Uses recognised screen content to target advertising')],
  customAdAllowed:         [msg('srv.consent.customAdAllowed', 'Personalised advertising'), msg('srv.consent.customAdAllowed.detail', 'Tailors the ads shown on your TV to you')],
  customadsAllowed:        [msg('srv.consent.customadsAllowed', 'Personalised advertising (secondary flag)'), msg('srv.consent.customadsAllowed.detail', 'A second personalised-advertising consent record')],
  cookiesAllowed:          [msg('srv.consent.cookiesAllowed', 'Advertising cookies'), msg('srv.consent.cookiesAllowed.detail', 'Stores cookies used for ad tracking')],
  thirdPartySharingAllowed:[msg('srv.consent.thirdPartySharingAllowed', 'Sharing your data with other companies'), msg('srv.consent.thirdPartySharingAllowed.detail', 'Passes your usage data to third parties')],
  additionalDataAllowed:   [msg('srv.consent.additionalDataAllowed', 'Additional usage data'), msg('srv.consent.additionalDataAllowed.detail', 'Extra analytics beyond what the TV needs to work')],
  remoteDiagAllowed:       [msg('srv.consent.remoteDiagAllowed', 'Remote diagnostics upload'), msg('srv.consent.remoteDiagAllowed.detail', 'Lets LG collect and upload diagnostic reports from your TV')],
  voiceAllowed:            [msg('srv.consent.voiceAllowed', 'Voice recordings'), msg('srv.consent.voiceAllowed.detail', 'Allows voice data to be collected and processed')],
  voice2Allowed:           [msg('srv.consent.voice2Allowed', 'Voice recordings (secondary flag)'), msg('srv.consent.voice2Allowed.detail', 'A second voice-data consent record')]
};

var CONSENT_LOCKED = {
  generalTermsAllowed: msg('srv.consent.locked.generalTerms', 'Acceptance of the terms themselves.'),
  networkAllowed:      msg('srv.consent.locked.network', 'Acceptance of network use.'),
  firstUseAllowed:     msg('srv.consent.locked.firstUse', 'Part of first-boot setup.'),
  allAllowed:          msg('srv.consent.locked.all', 'The Select-All. Read-only because whether writing it cascades to the other flags is untested.')
};

/*
 * Not listed at all. chpAllowed lets LG Channels change the channel list, which
 * is not tracking, and the TV accepts it again at every start-up with a notice
 * on screen (#359), so a switch for it could not stay off.
 */
var CONSENT_HIDDEN = { chpAllowed: true };

var CONSENT_GROUPS = [
  ['advertising', msg('srv.consent.group.advertising', 'Advertising')],
  ['watching',    msg('srv.consent.group.watching', 'What the TV watches and hears')],
  ['analytics',   msg('srv.consent.group.analytics', 'Analytics and sharing')],
  ['services',    msg('srv.consent.group.services', 'LG services')],
  ['unknown',     msg('srv.consent.group.unknown', 'No published description'),
   msg('srv.consent.group.unknown.note', 'The TV records these, but LG publishes nothing about them.')],
  ['platform',    msg('srv.consent.group.platform', 'Set on the TV itself'),
   msg('srv.consent.group.platform.note', 'Acceptance records rather than collection choices. Changed in the TV\'s own menus, under Settings \u203a General \u203a About This TV \u203a User Agreements.')]
];

var CONSENT_GROUP_OF = {
  customAdAllowed: 'advertising',
  customadsAllowed: 'advertising',
  cookiesAllowed: 'advertising',
  acrAdAllowed: 'advertising',

  acrAllowed: 'watching',
  acrGdprAllowed: 'watching',
  voiceAllowed: 'watching',
  voice2Allowed: 'watching',

  additionalDataAllowed: 'analytics',
  remoteDiagAllowed: 'analytics',
  thirdPartySharingAllowed: 'analytics',

  acrOnAllowed: 'watching',
  marketingOnAllowed: 'advertising',
  shoppingOnAllowed: 'advertising',

  networkAllowed: 'platform',
  generalTermsAllowed: 'platform',
  firstUseAllowed: 'platform',
  allAllowed: 'platform'
};

/*
 * Flags LG leaves unnamed, known by the agreement their mapping requires. By
 * agreement rather than by key, since which numbered slot LG uses for what can
 * differ by region: on UK firmware additional1Allowed maps to the Data
 * Partners Agreement, and acr2 reads it, logging it as "DPA". takeOnAllowed
 * maps to S_TAK, the Who.Where.What? agreement run with TheTake, and livepick
 * reads it. marketingOnAllowed maps to S_MKT and is read by sdx, which sends
 * the accepted terms to LG.
 */
var CONSENT_BY_DOCUMENT = {
  S_DPA: [msg('srv.consent.dpa', 'Sharing viewing data with data partners'),
          msg('srv.consent.dpa.detail', 'Lets LG and Alphonso, its screen recognition partner, pass viewing and device information to other companies for ad measurement and analytics'), 'analytics'],
  S_TAK: ['Who.Where.What?',
          msg('srv.consent.tak.detail', 'LG\'s content discovery, run with TheTake: identifies people, places and products in what is on screen, using viewing information that can include captured images of it'), 'watching'],
  S_MKT: [msg('srv.consent.mkt', 'Marketing messages'),
          msg('srv.consent.mkt.detail', 'Lets LG show marketing pop-ups and notifications on the TV: special offers and news about its content and services'), 'advertising']
};

// Named from what reads them, where no agreement of their own names them.
// adoverlay-service, which places ads over live TV, reads shoppingOnAllowed
// with customadsAllowed and acrOnAllowed. A C9 (webOS 4.10.2) has no such
// service, and there acr2 reads acrOnAllowed (#629).
var CONSENT_READ_BY = {
  shoppingOnAllowed: msg('srv.consent.shoppingOn.detail', 'Read by the service that places ads and offers over live TV, alongside personalised advertising')
};

function consentByDocument(key) {
  if (CONSENT_LOCKED[key]) return null;
  var docs = loadConsentGroups()[key] || [];
  for (var i = 0; i < docs.length; i++) if (CONSENT_BY_DOCUMENT[docs[i]]) return CONSENT_BY_DOCUMENT[docs[i]];
  return null;
}

var CONSENT_NAMES = {
  networkAllowed:      msg('srv.consent.name.networkAllowed', 'Network use'),
  marketingOnAllowed:  msg('srv.consent.name.marketingOnAllowed', 'Marketing'),
  shoppingOnAllowed:   msg('srv.consent.name.shoppingOnAllowed', 'Shopping on live TV'),
  generalTermsAllowed: msg('srv.consent.name.generalTermsAllowed', 'Terms of Use and Privacy Policy'),
  acrOnAllowed:        msg('srv.consent.name.acrOnAllowed', 'Screen recognition (master consent)'),
  allAllowed:          msg('srv.consent.name.allAllowed', 'Select All')
};

var PRIVACY_DAEMONS = {
  acr2:       [msg('srv.daemon.acr2', 'Content recognition service'), msg('srv.daemon.acr2.detail', 'Identifies what is on screen'), 'bus'],
  admanager:  [msg('srv.daemon.admanager', 'Advertising service'), msg('srv.daemon.admanager.detail', 'Fetches and displays ads on the TV'), 'bus'],
  uploadd:    [msg('srv.daemon.uploadd', 'Diagnostics uploader'), msg('srv.daemon.uploadd.detail', 'Sends diagnostic data to LG'), 'upstart'],
  rdxd:       [msg('srv.daemon.rdxd', 'Diagnostics collector'), msg('srv.daemon.rdxd.detail', 'Gathers crash and diagnostic reports'), 'upstart']
};

/** @type {typeof import('./services')} */
var servicesModule = null;

/*
 * The bus starts some of LG's services on demand: their service file says
 * Type=dynamic, and ls-hubd runs the program the first time anything calls
 * one. com.webos.service.acr (acr2) and com.webos.service.admanager are such
 * on a CX (webOS 5.6.2) and a C5 (webOS 10.3.1), so a status query would start
 * either one again after it was stopped. Such a service is asked only while it
 * runs. Read once: the files are on the read-only rootfs.
 */
var BUS_DIR = '/usr/share/dbus-1/system-services';
var onDemand = null;

function onDemandPrograms() {
  if (onDemand) return onDemand;
  onDemand = {};
  var files = [];
  try { files = fs.readdirSync(BUS_DIR); } catch (e) {}
  files.forEach(function (f) {
    if (!/\.service$/.test(f)) return;
    var text = readTrimmed(BUS_DIR + '/' + f) || '';
    if (!/^Type\s*=\s*dynamic\s*$/m.test(text)) return;
    var exec = /^Exec\s*=\s*(\S+)/m.exec(text), names = /^Name\s*=\s*(.+)$/m.exec(text);
    if (!exec || !names) return;
    names[1].split(';').forEach(function (n) {
      n = n.trim();
      if (n) onDemand[n] = exec[1];
    });
  });
  return onDemand;
}

// Whether a call to service would start it: started on demand, and its
// program not among psText's (ps -eo args).
// The commands running, as the first word of each ps -eo args line: a process
// that only names a program in its arguments (a grep, a shell) is not it.
function psCommands(psText) {
  var cmds = {};
  String(psText || '').split('\n').forEach(function (line) {
    var cmd = line.trim().split(/\s+/)[0];
    if (cmd) cmds[cmd] = true;
  });
  return cmds;
}

function wouldStart(service, psText) {
  var prog = onDemandPrograms()[service];
  if (!prog) return false;
  var cmds = psCommands(psText);
  return !(cmds[prog] || cmds[prog.split('/').pop()]);
}

var psArgs = function (cb) {
  execFile('/bin/ps', ['-eo', 'args'], { timeout: 4000 }, function (err, stdout) {
    cb(String(stdout || ''));
  });
};

// cb(answer), or cb(null) without asking where asking would start the service.
function askIfRunning(idle, uri, cb) {
  if (idle) return cb(null);
  luna(uri, {}, cb);
}

// The TV's own Limit ad tracking setting: true or false, or null where it has none.
function readLmt(cb) {
  luna('com.webos.settingsservice/getSystemSettings', { category: 'general', keys: ['lmt'] }, function (r) {
    var v = r && r.settings && r.settings.lmt;
    cb(v === undefined || v === null ? null : String(v).toLowerCase() === 'on');
  });
}

var luna = null;
var lunaCached = null;
var config = {};
var cachedAdBlockActive = null;
var lastAdBlockCheck = 0;
var cachedPrivacy = null;
/** @type {typeof import('./lgsettings')} */
var lgSettingsModule = null;
var lastPrivacyCheck = 0;
var consentGroups = null;
var consentMapFound = false;

function clearCache() {
  cachedPrivacy = null;
  cachedAdBlockActive = null;
}

function storeHost() {
  try {
    var j = JSON.parse(readTrimmed('/var/palm/data/com.webos.appInstallService/serverInfo') || '{}');
    var m = /^[a-z]+:\/\/([^\/:?#]+)/i.exec(String(j.serverUrl || ''));
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}

function isSdpGracePeriodActive() {
  return sdpGraceActive;
}

function adBlockPlatform() {
  var list = ADBLOCK_PLATFORM.slice();
  var host = storeHost();
  if (host && list.indexOf(host) === -1) list.push(host);
  // The TV sets its clock from nextlgsdp.com's X-Server-Time header, not NTP
  // (systemTimeSource "sdp" on a C2), so after a power cut it is left
  // reachable until the time is valid: see scheduleSdpBlock.
  if (!isSdpGracePeriodActive()) list = list.concat(ADBLOCK_SDP);
  return list;
}

// This version's own names for a tier, without the owner's list.
function ownBlockList(mode) {
  if (mode === 'off') return [];
  return mode === 'full' ? adBlockAds().concat(adBlockPlatform()) : adBlockAds();
}

function isSdpName(name) {
  return /(^|\.)nextlgsdp\.com$/.test(name);
}

// What the table blocks for a tier, the owner's list included.
function adBlockList(mode) {
  var own = ownBlockList(mode);
  var c = customHosts();
  if (mode === 'off' || !c || !c.enabled) return own;
  // The TV's clock comes from nextlgsdp.com: see scheduleSdpBlock.
  var names = isSdpGracePeriodActive() ? c.names.filter(function (n) { return !isSdpName(n); }) : c.names;
  if (c.mode === 'replace') return names.slice();
  var seen = {};
  own.forEach(function (n) { seen[n] = 1; });
  return own.concat(names.filter(function (n) { return !seen[n]; }));
}

/*
 * The names in a hosts file or a plain list of names. A line that points a
 * name at an address other than a blackhole one is a redirect, not a block,
 * and is counted rather than taken. A name needs a dot, and a line with no
 * address holds one name, as a plain list does: an ordinary text file read
 * word by word gave "the" and "on" as names to block.
 */
function parseCustomHosts(text) {
  var names = [];
  var seen = {};
  var skipped = 0;
  String(text || '').split(/\r?\n/).forEach(function (raw) {
    var line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    var parts = line.split(/\s+/);
    if (/^[0-9.]+$/.test(parts[0]) || parts[0].indexOf(':') !== -1) {
      if (!CUSTOM_SINK_ADDRS[parts[0]]) { skipped++; return; }
      parts = parts.slice(1);
    } else if (parts.length > 1) {
      skipped++;
      return;
    }
    parts.forEach(function (n) {
      n = n.toLowerCase().replace(/\.$/, '');
      if (CUSTOM_NOT_NAMES[n] || seen[n]) return;
      if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$/.test(n) || n.length > 253 ||
          /\.\d+$/.test(n)) {
        skipped++;
        return;
      }
      seen[n] = 1;
      names.push(n);
    });
  });
  return { names: names, skipped: skipped };
}

function customHosts() {
  if (customCache !== undefined) return customCache;
  customCache = null;
  try {
    var j = JSON.parse(fs.readFileSync(ADBLOCK_CUSTOM_FILE, 'utf8'));
    if (j && Array.isArray(j.names) && j.names.length && (j.mode === 'add' || j.mode === 'replace')) {
      // Switched off, the list stays on the TV and nothing in it is blocked.
      customCache = { mode: j.mode, names: j.names, updated: j.updated || null, enabled: j.enabled !== false,
                      file: typeof j.file === 'string' ? j.file : null };
    }
  } catch (e) {}
  return customCache;
}

// How the owner's list stands against this version's list for the tier in use.
function customSummary() {
  var c = customHosts();
  if (!c) return null;
  var mode = flagMode();
  var own = ownBlockList(mode === 'off' ? 'ads' : mode);
  var inList = {};
  c.names.forEach(function (n) { inList[n] = 1; });
  var shared = own.filter(function (n) { return inList[n]; }).length;
  return {
    mode: c.mode,
    enabled: c.enabled,
    file: c.file,
    count: c.names.length,
    updated: c.updated,
    shared: shared,
    ownCount: own.length,
    blocked: mode === 'off' ? 0 : adBlockList(mode).length
  };
}

/*
 * opts: { mode: 'add' | 'replace', text, file } to upload a list, which also
 * switches it on; { mode } alone to change how the kept one is used;
 * { enabled } alone to switch it on or off, keeping it; { clear: true } to
 * remove it. The table is rewritten at once if the blocker is on.
 */
function setCustomHosts(opts, cb) {
  opts = opts || {};
  var fail = function (error) {
    console.log('adblock: hosts list refused: ' + error);
    cb({ ok: false, error: error });
  };
  if (opts.clear) {
    try {
      if (fs.existsSync(ADBLOCK_CUSTOM_FILE)) fs.unlinkSync(ADBLOCK_CUSTOM_FILE);
    } catch (e) {
      return fail(msg('srv.adblock.custom.saveFailed', 'could not save your hosts list: {error}', { error: e.message }));
    }
    customCache = undefined;
    console.log('adblock: hosts list removed');
    return applyCustom(cb, { skipped: 0 });
  }
  var kept = customHosts();
  if (typeof opts.enabled === 'boolean' && opts.mode === undefined && opts.text === undefined) {
    if (!kept) return fail(msg('srv.adblock.custom.none', 'no hosts list has been uploaded'));
    opts.mode = kept.mode;
  }
  if (opts.mode !== 'add' && opts.mode !== 'replace') {
    return fail(msg('srv.adblock.custom.badMode', 'mode must be add or replace'));
  }
  var names;
  var skipped = 0;
  if (typeof opts.text === 'string') {
    var parsed = parseCustomHosts(opts.text);
    names = parsed.names;
    skipped = parsed.skipped;
    if (!names.length) return fail(msg('srv.adblock.custom.empty', 'No host names found in the file. A hosts file has lines such as 0.0.0.0 ads.example.com, and a plain list has one name on each line.'));
    if (names.length > CUSTOM_MAX_NAMES) {
      return fail(msg('srv.adblock.custom.tooMany', 'the file has {n} names; the most the TV takes is {max}',
                      { n: names.length, max: CUSTOM_MAX_NAMES }));
    }
  } else {
    var c = customHosts();
    if (!c) return fail(msg('srv.adblock.custom.none', 'no hosts list has been uploaded'));
    names = c.names;
  }
  var uploaded = typeof opts.text === 'string';
  var enabled = uploaded ? true : (typeof opts.enabled === 'boolean' ? opts.enabled : kept.enabled);
  try {
    fs.writeFileSync(ADBLOCK_CUSTOM_FILE, JSON.stringify({
      mode: opts.mode, names: names, enabled: enabled,
      // The name it had on the computer, only to show which list this is.
      file: uploaded ? String(opts.file || '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || null : kept.file,
      updated: uploaded ? new Date().toISOString() : kept.updated
    }), 'utf8');
  } catch (e) {
    return fail(msg('srv.adblock.custom.saveFailed', 'could not save your hosts list: {error}', { error: e.message }));
  }
  customCache = undefined;
  console.log('adblock: hosts list ' + (uploaded ? 'saved, ' + names.length + ' names, ' + skipped + ' left out' : 'kept') +
              ', ' + (opts.mode === 'add' ? 'with' : 'instead of') + ' the built-in list, ' + (enabled ? 'on' : 'off'));
  applyCustom(cb, { skipped: skipped });
}

function applyCustom(cb, extra) {
  var reply = function (err) {
    clearCache();
    cb({ ok: !err, error: err || undefined, custom: customSummary(), skipped: extra.skipped });
  };
  if (flagMode() === 'off' || !isTableMounted()) return reply(null);
  applyHostsTable(reply);
}

// Whether the clock wait applies: the Everything tier, or the owner's list naming the time servers.
function waitsForSdp(mode) {
  if (mode === 'full') return true;
  var c = customHosts();
  return mode !== 'off' && !!c && c.enabled && c.names.some(isSdpName);
}

// Whether this server's table is over /etc/hosts, for ads, updates or both.
function isTableMounted() {
  var now = Date.now();
  if (cachedAdBlockActive !== null && (now - lastAdBlockCheck < 30000)) {
    return cachedAdBlockActive;
  }
  try {
    var hosts = fs.readFileSync('/etc/hosts', 'utf8');
    cachedAdBlockActive = hosts.indexOf(ADBLOCK_MARKER) !== -1 || hosts.indexOf(ADBLOCK_LEGACY_MARKER) !== -1;
    lastAdBlockCheck = now;
    return cachedAdBlockActive;
  } catch (e) {
    return false;
  }
}

function flagMode() {
  var flag = readTrimmed(ADBLOCK_FLAG_FILE);
  return !flag ? 'off' : flag === 'ads' ? 'ads' : 'full';
}

function adBlockMode() {
  return isTableMounted() ? flagMode() : 'off';
}

function isAdBlockActive() {
  return adBlockMode() !== 'off';
}

/*
 * Whether the table in use blocks a name, from the names it holds rather than
 * the tier: the SDP clock wait and the owner's list both change what a tier
 * blocks. 'level' where the tier's own list has it, 'list' where only the
 * owner's list does, null where it is reachable.
 */
function blockedBy(name) {
  var mode = adBlockMode();
  name = String(name || '').toLowerCase();
  if (mode === 'off' || !name || adBlockList(mode).indexOf(name) === -1) return null;
  var c = customHosts();
  var replaced = c && c.enabled && c.mode === 'replace';
  return !replaced && ownBlockList(mode).indexOf(name) !== -1 ? 'level' : 'list';
}

function tvUpdatesBlocked() {
  return fs.existsSync(HBC_BLOCK_UPDATES_FLAG);
}

// Both families for every name. A sinkhole with no AAAA record leaves the
// resolver to ask DNS for one, and the connection goes through on IPv6.
function sinkhole(lines, host) {
  lines.push('0.0.0.0\t' + host);
  lines.push('::\t' + host);
}

/*
 * Lines other tools put in /etc/hosts, such as AmazOff's redirect of Amazon's
 * player to a local nginx. Rewriting the table, or mounting it, would
 * otherwise drop them. A line is this table's own if it is a comment, a
 * localhost line, a sinkhole (0.0.0.0 or ::) or names a host the table decides
 * on: the Homebrew Channel points the update servers at 127.0.0.1 and ::1
 * (a C4 on webOS 10.3.1), and those must not outlive update blocking being
 * switched off. 50-tvweb.sh carries the rest over at boot the same way.
 */
function foreignHostsLines(text) {
  var managed = adBlockAds().concat(ADBLOCK_PLATFORM, ADBLOCK_SDP, HBC_UPDATE_HOSTS);
  var kept = [];
  var lines = String(text || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    if (/^(0\.0\.0\.0|::)\s/.test(line) || /localhost|ip6-/.test(line)) continue;
    var names = line.split(/\s+/).slice(1);
    if (names.some(function (n) { return managed.indexOf(n.toLowerCase()) !== -1; })) continue;
    if (kept.indexOf(line) === -1) kept.push(line);
  }
  return kept;
}

function currentForeignHostsLines() {
  try {
    return foreignHostsLines(fs.readFileSync('/etc/hosts', 'utf8'));
  } catch (e) {
    return [];
  }
}

function adBlockHostsTable(mode, foreign) {
  var list = adBlockList(mode);
  var lines = [
    '127.0.0.1\tlocalhost.localdomain\tlocalhost',
    '::1\tlocalhost ip6-localhost ip6-loopback',
    'fe00::0\tip6-localnet',
    'ff00::0\tip6-mcastprefix',
    'ff02::1\tip6-allnodes',
    'ff02::2\tip6-allrouters',
    '',
    ADBLOCK_MARKER
  ];
  for (var i = 0; i < list.length; i++) sinkhole(lines, list[i]);
  if (tvUpdatesBlocked()) {
    lines.push('', '# TV software updates, blocked by the flag the Homebrew Channel also uses');
    for (var u = 0; u < HBC_UPDATE_HOSTS.length; u++) sinkhole(lines, HBC_UPDATE_HOSTS[u]);
  }
  if (foreign && foreign.length) {
    lines.push('', '# Kept from /etc/hosts, where other tools put them');
    lines.push.apply(lines, foreign);
  }
  lines.push('');
  return lines.join('\n');
}

// In place, not renamed over: app jails bind-mount this file as their hosts.
function writeHostsTable(mode) {
  fs.writeFileSync(ADBLOCK_HOSTS_FILE, adBlockHostsTable(mode, currentForeignHostsLines()), 'utf8');
}

function clearSdpTimer() {
  if (sdpPollTimer) {
    clearInterval(sdpPollTimer);
    sdpPollTimer = null;
  }
  if (sdpCapTimer) {
    clearTimeout(sdpCapTimer);
    sdpCapTimer = null;
  }
  sdpAnySourceAccepted = false;
}

function finalizeSdpBlock(logMsg) {
  clearSdpTimer();
  if (!sdpGraceActive) return;
  sdpGraceActive = false;
  if (logMsg) console.log(logMsg);
  if (waitsForSdp(flagMode()) && isTableMounted()) {
    try {
      writeHostsTable(flagMode());
      clearCache();
    } catch (e) {}
  }
}

function isTimeValid(r) {
  if (!r || r.returnValue === false) return false;
  var v = (r.timeValid !== undefined) ? r.timeValid : r.timevalid;
  if (v !== undefined) return v === true || v === 'true';
  // Older webOS versions (such as webOS 4 on the B8) omit timeValid: verify
  // the UTC timestamp has advanced past epoch into a modern year.
  var utc = Number(r.utc);
  return !isNaN(utc) && utc > 1577836800;
}

function isSdpSource(r) {
  if (!r) return false;
  var s = (r.systemTimeSource || r.source || r.timeSource || '');
  return typeof s === 'string' && s.toLowerCase() === 'sdp';
}

function checkSdpClockSync(isFirstCheck) {
  if (!luna) {
    finalizeSdpBlock('adblock: no luna wrapper; closing SDP grace period');
    return;
  }
  luna('com.webos.service.systemservice/time/getSystemTime', {}, function (r) {
    if (!sdpGraceActive) return;

    var valid = isTimeValid(r);
    var isSdp = isSdpSource(r);

    // On a restart / warm boot, the clock is already valid: skip the grace window.
    if (isFirstCheck && valid) {
      finalizeSdpBlock('adblock: system time already valid; skipping SDP grace period');
      return;
    }

    // On cold boot, block once timeValid with source sdp is reported.
    if (valid && isSdp) {
      finalizeSdpBlock('adblock: SDP clock sync complete (timeValid with source sdp); nextlgsdp.com blocked');
      return;
    }
    if (valid && sdpAnySourceAccepted) {
      finalizeSdpBlock('adblock: system time valid from another source; nextlgsdp.com blocked');
      return;
    }

    // If initial check was invalid (cold boot), start polling and cap timer.
    if (isFirstCheck && !sdpPollTimer) {
      startSdpPolling();
    }
  });
}

function pollSdpClockSync(intervalMs) {
  if (sdpPollTimer) clearInterval(sdpPollTimer);
  sdpPollTimer = setInterval(function () {
    checkSdpClockSync(false);
  }, intervalMs);
  if (sdpPollTimer && sdpPollTimer.unref) sdpPollTimer.unref();
}

function acceptAnyTimeSource() {
  sdpCapTimer = null;
  if (!sdpGraceActive) return;
  sdpAnySourceAccepted = true;
  console.log('adblock: no SDP clock sync after 120s; nextlgsdp.com stays reachable until the time is valid');
  pollSdpClockSync(SDP_SLOW_POLL_INTERVAL_MS);
}

function startSdpPolling() {
  if (sdpPollTimer || sdpCapTimer) return;
  sdpCapTimer = setTimeout(acceptAnyTimeSource, SDP_SOURCE_WAIT_MS);
  if (sdpCapTimer && sdpCapTimer.unref) sdpCapTimer.unref();
  pollSdpClockSync(SDP_POLL_INTERVAL_MS);
}

/*
 * Leaves nextlgsdp.com unblocked until getSystemTime reports timeValid with
 * source sdp, and skips the window when the time is already valid, as after
 * a restart. Blocking it before the clock is set would leave the TV with the
 * wrong time until the next boot, and every HTTPS connection failing with it,
 * so after two minutes a valid time from any source, such as one set by hand,
 * closes the window instead, and nothing short of that does.
 */
function scheduleSdpBlock() {
  if (!sdpGraceActive) return;
  if (sdpPollTimer || sdpCapTimer) return;
  checkSdpClockSync(true);
}

/*
 * One table carries both the ad block and the update block, so it stays
 * mounted while either is on. The Homebrew Channel mounts its own update block
 * at boot, under this one; with updates unblocked and nothing of ours to
 * mount, that layer is lifted too, or it would block until the next reboot.
 */
function applyHostsTable(cb) {
  var mode = flagMode();
  var mounted = isTableMounted();
  var done = function () { clearCache(); cb(null); };
  if (mode !== 'off' || tvUpdatesBlocked()) {
    try {
      writeHostsTable(mode);
    } catch (e) {
      return cb('could not write the hosts table: ' + e.message);
    }
    if (waitsForSdp(mode)) scheduleSdpBlock();
    else clearSdpTimer();
    if (mounted) return done();
    return execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 },
      function (err) { clearCache(); cb(err ? 'could not mount the hosts table' : null); });
  }
  clearSdpTimer();
  // Other tools' lines went into the table while it was up, and the
  // /etc/hosts underneath can be on the read-only rootfs (a C4 on webOS
  // 10.3.1), where they cannot go back. Then the table goes back up, blocking
  // nothing, until the next reboot.
  var foreign = mounted ? currentForeignHostsLines() : [];
  var settle = function () {
    var below = currentForeignHostsLines();
    var lost = foreign.filter(function (line) { return below.indexOf(line) === -1; });
    if (!lost.length) return done();
    execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 },
      function (err) { clearCache(); cb(err ? 'could not mount the hosts table' : null); });
  };
  var liftHbc = function () {
    var hosts = readTrimmed('/etc/hosts') || '';
    if (hosts.indexOf('webosbrew startup script') === -1) return settle();
    execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function () { settle(); });
  };
  if (!mounted) return liftHbc();
  if (foreign.length) {
    try {
      writeHostsTable('off');
    } catch (e) {
      return cb('could not write the hosts table: ' + e.message);
    }
  }
  execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function () { clearCache(); liftHbc(); });
}

function setAdBlock(mode, cb) {
  try {
    if (mode === 'off') {
      if (fs.existsSync(ADBLOCK_FLAG_FILE)) fs.unlinkSync(ADBLOCK_FLAG_FILE);
      clearSdpTimer();
    } else {
      fs.writeFileSync(ADBLOCK_FLAG_FILE, mode, 'utf8');
      if (!waitsForSdp(mode)) clearSdpTimer();
    }
  } catch (e) {
    if (cb) cb({ ok: false, error: msg('srv.adblock.saveFailed', 'could not save the ad block setting: {error}', { error: e.message }) });
    return;
  }
  applyHostsTable(function (err) {
    if (cb) cb({ ok: !err, error: err || undefined, enabled: isAdBlockActive(), mode: adBlockMode() });
  });
}

function setTvUpdatesBlocked(on, cb) {
  try {
    if (on) fs.writeFileSync(HBC_BLOCK_UPDATES_FLAG, '', 'utf8');
    else if (fs.existsSync(HBC_BLOCK_UPDATES_FLAG)) fs.unlinkSync(HBC_BLOCK_UPDATES_FLAG);
  } catch (e) {
    if (cb) cb({ ok: false, error: msg('srv.tvUpdates.saveFailed', 'could not save the update setting: {error}', { error: e.message }) });
    return;
  }
  applyHostsTable(function (err) {
    if (cb) cb({ ok: !err, error: err || undefined, tvUpdatesBlocked: tvUpdatesBlocked() });
  });
}

function checkBootAdBlock(cliMode) {
  if (cliMode) return;
  try {
    // Rebuilt from the list in this version, so an update that adds names
    // takes effect without the mode being switched off and on.
    var mode = flagMode();
    var need = mode !== 'off' || tvUpdatesBlocked();
    if (need) writeHostsTable(mode);
    if (need && !isTableMounted()) {
      execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
        clearCache();
        if (!err) console.log('adblock: restored /etc/hosts bind-mount from previous boot');
      });
    }
    if (waitsForSdp(mode)) scheduleSdpBlock();
  } catch (e) {}
}

function loadConsentGroups() {
  if (consentGroups) return consentGroups;
  consentGroups = {};
  try {
    var j = JSON.parse(readTrimmed('/var/palm/license/eulaInfoNetwork.json') || '{}');
    var list = (j.eulaMappingList && j.eulaMappingList.eulaInfo) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.settingKey) continue;
      consentGroups[e.settingKey] = (e.mandatory || e.generalSelectAll || []).slice().sort();
      consentMapFound = true;
    }
  } catch (err) {}
  return consentGroups;
}

function readConsentDocs(cb) {
  if (!luna) return cb(null);
  luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaInfoNetwork'] }, function (r) {
    var eln = r && r.settings && r.settings.eulaInfoNetwork;
    cb(eln && Array.isArray(eln.eulaList) ? eln : null);
  });
}

function acceptedSet(eln) {
  var out = {};
  for (var i = 0; i < eln.eulaList.length; i++) {
    if (eln.eulaList[i].accepted) out[eln.eulaList[i].id] = true;
  }
  return out;
}

function docsSatisfied(need, accepted) {
  for (var i = 0; i < need.length; i++) if (!accepted[need[i]]) return false;
  return need.length > 0;
}

function planConsent(key, on, flags, eln) {
  var groups = loadConsentGroups();
  var accepted = acceptedSet(eln);
  var need = groups[key] || [];
  var i, k;

  if (on) {
    for (i = 0; i < need.length; i++) accepted[need[i]] = true;
  } else {
    var protectedDocs = {};
    for (k in groups) {
      if (!groups.hasOwnProperty(k)) continue;
      if (!CONSENT_LOCKED[k] || !flags[k]) continue;
      for (i = 0; i < groups[k].length; i++) protectedDocs[groups[k][i]] = true;
    }
    for (i = 0; i < need.length; i++) {
      if (!protectedDocs[need[i]]) delete accepted[need[i]];
    }
  }

  var nextFlags = {}, changed = [];
  for (k in flags) if (flags.hasOwnProperty(k)) nextFlags[k] = flags[k];
  for (k in groups) {
    if (!groups.hasOwnProperty(k) || !nextFlags.hasOwnProperty(k)) continue;
    if (CONSENT_LOCKED[k]) continue;
    if (nextFlags[k] && !docsSatisfied(groups[k], accepted)) {
      nextFlags[k] = false;
      changed.push(k);
    }
  }
  if (nextFlags[key] !== on) { nextFlags[key] = on; if (changed.indexOf(key) === -1) changed.push(key); }

  var nextDocs = JSON.parse(JSON.stringify(eln));
  for (i = 0; i < nextDocs.eulaList.length; i++) {
    nextDocs.eulaList[i].accepted = !!accepted[nextDocs.eulaList[i].id];
  }
  return { flags: nextFlags, docs: nextDocs, changed: changed };
}

function consentSettable(key) {
  if (CONSENT_LOCKED[key] || CONSENT_HIDDEN[key]) return false;
  if (CONSENT_LABELS[key]) return true;
  return !!loadConsentGroups()[key];
}

function consentPeers(key, groups) {
  var mine = groups[key], names = [];
  if (!mine || !mine.length) return names;
  for (var other in groups) {
    if (!groups.hasOwnProperty(other) || other === key) continue;
    if (!CONSENT_LABELS[other]) continue;
    if (groups[other].join(',') === mine.join(',')) names.push(msg('srv.consent.quoted', '"{name}"', { name: CONSENT_LABELS[other][0] }));
  }
  return names;
}

function consentGroup(key) {
  return CONSENT_GROUP_OF[key] || 'unknown';
}

function describeUnlabelled(key, on, groups) {
  var row = { key: key, enabled: on, settable: consentSettable(key), group: consentGroup(key) };
  if (CONSENT_NAMES[key]) row.label = CONSENT_NAMES[key];
  var docs = groups[key];
  if (docs) row.documents = docs;
  if (CONSENT_READ_BY[key]) { row.detail = CONSENT_READ_BY[key]; row.described = true; return row; }
  if (CONSENT_LOCKED[key]) {
    row.detail = CONSENT_LOCKED[key];
    return row;
  }
  if (!docs) {
    row.detail = consentMapFound
      ? msg('srv.consent.noAgreement', 'Tied to no agreement on this firmware.')
      : msg('srv.consent.noMapping', 'This TV publishes no agreement mapping, so there is nothing to go on.');
    return row;
  }
  var peers = consentPeers(key, groups);
  row.detail = peers.length
    ? msg('srv.consent.sameAgreement', 'Accepted under the same agreement as {names}.', { names: list(peers) })
    : msg('srv.consent.unnamedAgreement', 'Filed under an agreement the TV does not name.');
  return row;
}

function annotateConsent(consent, eln) {
  if (!consent || !eln) return;
  var titles = {}, i;
  for (i = 0; i < eln.eulaList.length; i++) {
    if (eln.eulaList[i].title) titles[eln.eulaList[i].id] = eln.eulaList[i].title;
  }
  var groups = loadConsentGroups();
  var rows = (consent.known || []).concat(consent.other || []);
  var flags = {}, byKey = {};
  for (i = 0; i < rows.length; i++) { flags[rows[i].key] = rows[i].enabled; byKey[rows[i].key] = rows[i]; }

  for (i = 0; i < rows.length; i++) {
    var row = rows[i], need = groups[row.key];
    if (!need) continue;
    var names = [];
    for (var j = 0; j < need.length; j++) if (titles[need[j]]) names.push(titles[need[j]]);
    if (names.length) {
      row.agreements = names;
      if (!CONSENT_LABELS[row.key] && !row.described) {
        // The agreement titles come from the TV, in its own language.
        row.detail = msg('srv.consent.acceptedUnder', 'Accepted under {agreements}.', { agreements: list(names) });
      }
    }
    if (!row.settable || !row.enabled) continue;
    var plan = planConsent(row.key, false, flags, eln);
    var also = [];
    for (var c = 0; c < plan.changed.length; c++) {
      var k = plan.changed[c];
      if (k === row.key || !byKey[k]) continue;
      also.push(byKey[k].label || k);
    }
    if (also.length) row.sharesWith = also;
  }
}

function readConsentFlags() {
  var raw = readTrimmed('/var/luna/preferences/eula');
  if (!raw) return null;
  var groups = loadConsentGroups();
  var out = { known: [], other: [] };
  var re = /"([a-zA-Z0-9_]+Allowed)"\s*:\s*(true|false)/g, m;
  while ((m = re.exec(raw)) !== null) {
    var key = m[1], on = m[2] === 'true';
    if (CONSENT_HIDDEN[key]) continue;
    var byDoc = CONSENT_LABELS[key] ? null : consentByDocument(key);
    if (CONSENT_LABELS[key]) {
      out.known.push({ key: key, label: CONSENT_LABELS[key][0], detail: CONSENT_LABELS[key][1],
                       enabled: on, settable: consentSettable(key),
                       group: consentGroup(key) });
    } else if (byDoc) {
      out.known.push({ key: key, label: byDoc[0], detail: byDoc[1], described: true,
                       enabled: on, settable: consentSettable(key), group: byDoc[2] });
    } else if (on || groups[key] || CONSENT_NAMES[key] || CONSENT_LOCKED[key]) {
      out.other.push(describeUnlabelled(key, on, groups));
    }
    // Otherwise left out: a flag that is off, that no agreement refers to and
    // that nothing on the TV reads (additional2 to 5 on the test TVs) says
    // nothing and can do nothing. It appears if it is ever on, or once a
    // firmware maps it to an agreement.
  }
  // The file's order is not stable: writing a flag moves it within the file,
  // so a list in that order reshuffles as flags are switched. Named flags go
  // in the order they are described above, the rest by key.
  var order = Object.keys(CONSENT_LABELS);
  function rank(f) { var i = order.indexOf(f.key); return i < 0 ? order.length : i; }
  out.known.sort(function (a, b) {
    return rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  out.other.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  return out;
}

/*
 * Whether a daemon can be switched off, and whether it is, come from the
 * background services switch (lib/services), which masks the unit or stops
 * the job and keeps it stopped. initctl list answers nothing on a CX
 * (webOS 5.6.2) and webOS 9, so it could not say.
 */
function runningDaemons(cb) {
  psArgs(function (txt) {
    var list = [];
    var cmds = psCommands(txt);
    for (var name in PRIVACY_DAEMONS) {
      if (!PRIVACY_DAEMONS.hasOwnProperty(name)) continue;
      var d = PRIVACY_DAEMONS[name];
      var onDemand = d[2] === 'bus';
      list.push({
        name: name,
        label: d[0],
        detail: d[1],
        running: !!(cmds['/usr/sbin/' + name] || cmds[name]),
        onDemand: onDemand,
        stoppable: !onDemand && !!servicesModule && servicesModule.available(name),
        heldDown: !!servicesModule && servicesModule.isDisabled(name)
      });
    }
    cb(list, txt);
  });
}

/*
 * The microphone switch on the TV itself, read where the model has one: a C5
 * (webOS 10.3.1) reports "on with switch" and reads the switch as a GPIO
 * level, "high" on and "low" off; a CX (webOS 5.6.2) has neither the setting
 * nor the service. null when there is nothing to show.
 */
function readMicSwitch(cb, ps) {
  var lunaFn = lunaCached || function (uri, params, ttl, done) { luna(uri, params, done); };
  lunaFn('com.webos.service.config/getConfigs', { configNames: ['tv.model.supportFarFieldVoice'] }, 3600000,
         function (c) {
    var support = String((c && c.configs && c.configs['tv.model.supportFarFieldVoice']) || '');
    if (!/^on with switch$/.test(support)) return cb(null);
    if (wouldStart('com.webos.service.voiceinput.sound', ps)) return cb(null);
    luna('com.webos.service.voiceinput.sound/getMicSwitchStatus', {}, function (r) {
      var st = r && r.returnValue !== false && r.micSwitchStatus;
      if (st !== 'high' && st !== 'low') return cb(null);
      cb({
        label: msg('srv.privacy.mic', 'Microphone switch'),
        detail: msg('srv.privacy.mic.detail', 'The switch on the TV itself. With it off, the TV’s hands-free voice stops listening.'),
        on: st === 'high'
      });
    });
  });
}

/*
 * ACR as two separate checks: whether it is allowed (Live Plus, and the
 * consent flags this firmware's acr2 reads) and whether acr2 runs. They
 * differ: on a CX (webOS 5.6.2) with Live Plus off, acr2 was not running
 * 15 hours after boot, yet one status query started it and it ran, idle,
 * until stopped. livePlus is null where the TV has no such setting.
 */
function acrSwitch(acr, consent, daemons, cb) {
  acr.running = (daemons || []).some(function (d) { return d.name === 'acr2' && d.running; });
  var flags = consent ? (consent.known || []).concat(consent.other || []) : [];
  acrConsentKeys(function (keys) {
    acr.consents = flags.filter(function (f) { return keys.indexOf(f.key) !== -1; })
      .map(function (f) { return { key: f.key, label: f.label || f.key, on: !!f.enabled }; });
    luna('com.webos.settingsservice/getSystemSettings', { category: 'option', keys: ['livePlus'] }, function (r) {
      var v = r && r.settings && r.settings.livePlus;
      acr.livePlus = v === undefined || v === null ? null : String(v).toLowerCase() === 'on';
      acr.consentOn = acr.livePlus === true || acr.consents.some(function (c) { return c.on; });
      cb();
    });
  });
}

function collectPrivacy(cb) {
  var now = Date.now();
  if (cachedPrivacy && (now - lastPrivacyCheck < 20000)) return cb(cachedPrivacy);

  var out = { ok: true, consent: readConsentFlags(), consentWritable: config.allowControl,
              consentGroups: CONSENT_GROUPS };

  runningDaemons(function (daemons, ps) {
    out.daemons = daemons;
    var acrIdle = wouldStart('com.webos.service.acr', ps);
    var adIdle = wouldStart('com.webos.service.admanager', ps);
    var lunaFn = lunaCached || luna;
    lunaFn('com.webos.settingsservice/getSystemSettings', { keys: ['eulaInfoNetwork'] }, 60000,
           function (elnRes) {
      var eln = elnRes && elnRes.settings && elnRes.settings.eulaInfoNetwork;
      if (eln && Array.isArray(eln.eulaList)) annotateConsent(out.consent, eln);
      askIfRunning(acrIdle, 'com.webos.service.acr/getACRSolutionStatus', function (acr) {
        out.acr = {
          label: msg('srv.privacy.acr', 'Screen content recognition'),
          detail: msg('srv.privacy.acr.detail', 'LG’s ACR captures what is on screen, from apps and HDMI alike, to work out what you watch and target ads at you.'),
          active: !!(acr && acr.ACRSolutionStatus)
        };
        if (acrIdle) out.acr.stopped = true;
        askIfRunning(acrIdle, 'com.webos.service.acr/getVideoCaptureStatus', function (cap) {
          out.acr.capturing = !!(cap && cap.status && cap.status !== 'stopped');
          out.acr.captureState = acrIdle ? 'stopped' : (cap && cap.status) ? cap.status : 'unknown';
          askIfRunning(adIdle, 'com.webos.service.admanager/getAdid', function (ad) {
            var adOk = !!(ad && ad.returnValue !== false && ad.IFA !== undefined);
            var id = (adOk && ad.IFA) ? String(ad.IFA) : null;
            out.advertisingId = {
              available: adOk,
              label: msg('srv.privacy.adid', 'Advertising identifier'),
              detail: msg('srv.privacy.adid.detail', 'A unique ID your TV hands to advertisers so they can target ads at you. Resetting it breaks the link to your past activity.'),
              present: !!id,
              limitTracking: !!(ad && String(ad.LMT).toLowerCase() === 'on'),
              lmtKnown: adOk,
              limitTrackingLabel: msg('srv.privacy.lmt', 'Limit ad tracking'),
              limitTrackingDetail: msg('srv.privacy.lmt.detail', 'When on, apps are asked not to use this ID to profile you.')
            };
            out.adblock = {
              enabled: isAdBlockActive(),
              mode: adBlockMode(),
              count: ownBlockList('full').length,
              adCount: adBlockAds().length,
              platform: adBlockPlatform(),
              custom: customSummary()
            };
            // With the ad service stopped, Limit ad tracking is read from the
            // TV's setting, which the service reads when it starts.
            var lmt = adIdle ? readLmt : function (done) { done(undefined); };
            lmt(function (setting) {
              if (adIdle) {
                out.advertisingId.stopped = true;
                if (setting !== null) {
                  out.advertisingId.limitTracking = setting;
                  out.advertisingId.lmtKnown = true;
                }
              }
              acrSwitch(out.acr, out.consent, daemons, function () {
                readMicSwitch(function (mic) {
                  if (mic) out.microphone = mic;
                  lgSettingsModule.collect('promotions', function (ls) {
                    out.lgSettings = ls.rows;
                    out.simple = simpleSummary(out);
                    cachedPrivacy = out;
                    lastPrivacyCheck = Date.now();
                    cb(out);
                  });
                }, ps);
              });
            });
          });
        });
      });
    });
  });
}

/*
 * The short view both dashboards lead with: three things people mean by LG
 * tracking, what is still on under each, and how to switch each off. Voice is
 * left alone, since it runs features people use, and so is anything the TV
 * will not let this server change.
 */
var SIMPLE_KEEP = { voiceAllowed: 1, voice2Allowed: 1 };

function simpleSummary(p) {
  var flags = ((p.consent && p.consent.known) || []).concat((p.consent && p.consent.other) || []);
  var writable = p.consentWritable !== false;
  var onIn = function (group) {
    /** @type {any[]} */
    var out = [];
    for (var i = 0; i < flags.length; i++) {
      var f = flags[i];
      if (f.group !== group || !f.enabled || !f.settable || !writable || SIMPLE_KEEP[f.key]) continue;
      out.push({ label: f.label || f.key, action: 'consent', value: { key: f.key, enabled: false } });
    }
    return out;
  };
  var ad = p.advertisingId || {};
  var mode = (p.adblock && p.adblock.mode) || 'off';

  var watching = onIn('watching');
  if (p.acr && (p.acr.active || p.acr.livePlus === true) && writable) {
    watching.push({ label: p.acr.active ? msg('srv.privacy.item.acr', 'Content recognition is running')
                                        : msg('srv.privacy.item.livePlus', 'Live Plus is on'), action: 'acr', value: false });
  }
  var ads = onIn('advertising');
  if ((ad.available || ad.lmtKnown) && !ad.limitTracking && writable) {
    ads.push({ label: msg('srv.privacy.item.lmt', 'Limit ad tracking is off'), action: 'limitAdTracking', value: true });
  }
  if (mode === 'off') {
    ads.push({ label: msg('srv.privacy.item.adblock', 'LG’s ad and tracking servers can be reached'), action: 'setAdBlock', value: 'ads' });
  }
  var reports = onIn('analytics');
  (p.daemons || []).forEach(function (x) {
    // Only what is running: one that is merely allowed to start is not on.
    if (!x.onDemand && x.stoppable && x.running) reports.push({ label: msg('srv.privacy.item.running', '{name} is running', { name: x.label }), service: x.name });
  });

  // LG's own ads and tips on screen, from lgsettings.js. Switching them off
  // stops nothing the TV does.
  var onScreen = [];
  (p.lgSettings || []).forEach(function (r) {
    if (r.section === 'promotions' && r.on && writable) onScreen.push({ label: r.title, action: 'lgSetting', value: { id: r.id, on: false } });
  });

  var areas = [
    { id: 'watching', name: msg('srv.privacy.area.watching', 'Screen recognition'), detail: msg('srv.privacy.area.watching.detail', 'LG identifying what you watch, to target ads at you.'), items: watching },
    { id: 'ads', name: msg('srv.privacy.area.ads', 'Ad tracking'), detail: msg('srv.privacy.area.ads.detail', 'Advertisers tracking the TV across apps, to target ads at you.'), items: ads },
    { id: 'reports', name: msg('srv.privacy.area.reports', 'Usage reports'), detail: msg('srv.privacy.area.reports.detail', 'Usage and diagnostic reports sent to LG, and data passed to other companies.'), items: reports },
    { id: 'onScreen', name: msg('srv.privacy.area.onScreen', 'LG ads on screen'), detail: msg('srv.privacy.area.onScreen.detail', 'Adverts, sponsored tiles and tips that LG shows on the TV.'), items: onScreen }
  ];
  var total = 0;
  areas.forEach(function (a) { total += a.items.length; });
  var kept = flags.filter(function (f) {
    return f.enabled && (SIMPLE_KEEP[f.key] || f.group === 'services');
  }).map(function (f) { return f.label || f.key; });
  return { total: total, areas: areas, kept: kept };
}

// then() unless the ad service is stopped, which calling it would undo.
function unlessAdServiceStopped(cb, then) {
  psArgs(function (ps) {
    if (wouldStart('com.webos.service.admanager', ps)) {
      return cb({ ok: false, error: msg('srv.privacy.adStopped', 'LG’s advertising service is not running, and this would start it.') });
    }
    then(ps);
  });
}

function resetAdId(cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  unlessAdServiceStopped(cb, function () {
  luna('com.webos.service.admanager/getAdid', {}, function (before) {
    var was = (before && before.IFA) ? String(before.IFA) : null;
    luna('com.webos.service.admanager/resetIFA', {}, function (r) {
      luna('com.webos.service.admanager/getAdid', {}, function (after) {
        var now = (after && after.IFA) ? String(after.IFA) : null;
        clearCache();
        cb({
          ok: !!(r && r.returnValue !== false),
          changed: !!(was && now && was !== now)
        });
      });
    });
  });
  });
}

/*
 * Limit ad tracking is the TV's own setting, "lmt" in the general category,
 * which the ad service reports as LMT: on a C2 (webOS 9.2) writing one changed
 * the other within a second. Confirmed from the ad service, since that is the
 * value apps are given.
 */
function setLimitTracking(on, cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  // Not written where the TV has no such setting: what its settings service
  // does with a key it never had is untried.
  readLmt(function (was) {
    if (was === null) return cb({ ok: false, error: msg('srv.privacy.lmt.none', 'This TV has no Limit ad tracking setting.') });
    luna('com.webos.settingsservice/setSystemSettings',
         { category: 'general', settings: { lmt: on ? 'on' : 'off' } }, function (r) {
      if (!r || r.returnValue !== true) return cb({ ok: false, error: msg('srv.tvRefused', 'the TV would not change it') });
      var answer = function (now) {
        clearCache();
        cb(now === !!on ? { ok: true, limitTracking: now }
                        : { ok: false, error: msg('srv.notTaken', 'the setting did not take') });
      };
      psArgs(function (ps) {
        // With the ad service stopped, the setting is what it reads when it starts.
        if (wouldStart('com.webos.service.admanager', ps)) return readLmt(answer);
        luna('com.webos.service.admanager/getAdid', {}, function (ad) {
          answer(!!(ad && String(ad.LMT).toLowerCase() === 'on'));
        });
      });
    });
  });
}

function clearAdCookies(cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  unlessAdServiceStopped(cb, function () {
    luna('com.webos.service.admanager/inactivateCookies', {}, function (r) {
      clearCache();
      cb({ ok: !!(r && r.returnValue !== false) });
    });
  });
}

/*
 * The consent flags the ACR client reads, found by name in its binary. They
 * differ by firmware: acr2 on a C9 (webOS 4.10.2) names acrOnAllowed and not
 * acrAllowed (#629). acrAllowed alone where the binary cannot be read or
 * names neither, as before. Read once: the binary is on the read-only rootfs.
 */
var ACR_BINARY = '/usr/sbin/acr2';
var ACR_CONSENT_KEYS = ['acrAllowed', 'acrOnAllowed'];
var acrConsentFound = null;

function acrConsentKeys(cb) {
  if (acrConsentFound) return cb(acrConsentFound);
  fs.readFile(ACR_BINARY, function (err, buf) {
    var text = !err && buf ? buf.toString('binary') : '';
    var found = ACR_CONSENT_KEYS.filter(function (k) { return text.indexOf(k) !== -1; });
    acrConsentFound = found.length ? found : ['acrAllowed'];
    cb(acrConsentFound);
  });
}

function setConsent(ckey, cOn, cb) {
  if (!ckey) return cb({ ok: false, error: 'no consent flag named' });
  if (!consentSettable(ckey)) return cb({ ok: false, error: ckey + ' is not changeable from here' });
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });

  luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaStatus'] }, function (r) {
    var cur = r && r.settings && r.settings.eulaStatus;
    if (!cur || typeof cur !== 'object') return cb({ ok: false, error: msg('srv.consent.readFailed', 'could not read the consent flags') });
    if (!cur.hasOwnProperty(ckey)) return cb({ ok: false, error: 'no such consent flag: ' + ckey });

    readConsentDocs(function (eln) {
      if (!eln) return cb({ ok: false, error: msg('srv.consent.docsFailed', 'could not read the agreement documents') });
      var plan = planConsent(ckey, cOn, cur, eln);
      if (!plan.changed.length) {
        clearCache();
        return cb({ ok: true, key: ckey, enabled: cOn, changed: false });
      }
      luna('com.webos.settingsservice/setSystemSettings',
           { settings: { eulaInfoNetwork: plan.docs, eulaStatus: plan.flags } }, function (w) {
        clearCache();
        if (!(w && w.returnValue)) {
          console.log('consent: ' + ckey + ' -> ' + cOn + ' (refused)');
          return cb({ ok: false, error: (w && w.errorText) || 'the TV refused the change' });
        }
        luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaStatus'] }, function (v) {
          var now = v && v.settings && v.settings.eulaStatus;
          var applied = !!(now && now[ckey] === cOn);
          console.log('consent: ' + ckey + ' ' + cur[ckey] + ' -> ' + cOn +
                      (plan.changed.length > 1 ? ' (with ' + (plan.changed.length - 1) + ' sharing the agreement)' : '') +
                      (applied ? '' : ' (accepted but not applied)'));
          cb(applied
            ? { ok: true, key: ckey, enabled: cOn, changed: true, alsoChanged: plan.changed.length - 1 }
            : { ok: false, error: msg('srv.notApplied', 'the TV accepted the change without applying it') });
        });
      });
    });
  });
}

function init(opts) {
  opts = opts || {};
  if (opts.lgSettings) lgSettingsModule = opts.lgSettings;
  if (opts.services) servicesModule = opts.services;
  if (opts.luna) luna = opts.luna;
  if (opts.lunaCached) lunaCached = opts.lunaCached;
  if (opts.config) config = opts.config;
  if (luna) learnCountry();
}

// Saved so the boot-time table is right before the settings service answers.
function learnCountry() {
  luna('com.webos.settingsservice/getSystemSettings',
       { category: 'option', keys: ['smartServiceCountryCode2'] }, function (r) {
    var cc = String((r && r.settings && r.settings.smartServiceCountryCode2) || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc) || cc === (readTrimmed(COUNTRY_FILE) || '').toLowerCase()) return;
    try {
      fs.writeFileSync(COUNTRY_FILE, cc, 'utf8');
      if (isTableMounted()) writeHostsTable(flagMode());
    } catch (e) {}
  });
}

module.exports = {
  init: init,
  isAdBlockActive: isAdBlockActive,
  adBlockMode: adBlockMode,
  blockedBy: blockedBy,
  adBlockPlatform: adBlockPlatform,
  adBlockList: adBlockList,
  ownBlockList: ownBlockList,
  parseCustomHosts: parseCustomHosts,
  setCustomHosts: setCustomHosts,
  customSummary: customSummary,
  setAdBlock: setAdBlock,
  tvUpdatesBlocked: tvUpdatesBlocked,
  setTvUpdatesBlocked: setTvUpdatesBlocked,
  checkBootAdBlock: checkBootAdBlock,
  resetAdId: resetAdId,
  setLimitTracking: setLimitTracking,
  clearAdCookies: clearAdCookies,
  collectPrivacy: collectPrivacy,
  readMicSwitch: readMicSwitch,
  wouldStart: wouldStart,
  _setBusDir: function (dir) { BUS_DIR = dir; onDemand = null; },
  _setPs: function (fn) { psArgs = fn; },
  simpleSummary: simpleSummary,
  setConsent: setConsent,
  acrConsentKeys: acrConsentKeys,
  _setAcrBinary: function (file) { ACR_BINARY = file; acrConsentFound = null; },
  readConsentFlags: readConsentFlags,
  clearCache: clearCache,
  ADBLOCK_ADS: ADBLOCK_ADS,
  ADBLOCK_PLATFORM: ADBLOCK_PLATFORM,
  adBlockHostsTable: adBlockHostsTable,
  foreignHostsLines: foreignHostsLines,
  CONSENT_LABELS: CONSENT_LABELS,
  CONSENT_LOCKED: CONSENT_LOCKED,
  CONSENT_GROUPS: CONSENT_GROUPS,
  isSdpGracePeriodActive: isSdpGracePeriodActive,
  _checkSdpClockSync: checkSdpClockSync,
  _setSdpGraceActive: function (b) { sdpGraceActive = b; },
  _clearSdpTimer: clearSdpTimer,
  _acceptAnyTimeSource: acceptAnyTimeSource,
  _finalizeSdpBlock: finalizeSdpBlock
};
