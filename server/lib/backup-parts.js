/*
 * lib/backup-parts.js - the settings a backup carries beyond lgsettings.js's
 * rows and config.json: LG's settings that have a control of their own,
 * privacy, and what Glasshouse keeps for the TV's apps, keys and screen saver.
 *
 * Each is read as its switch on the dashboard shows it and restored through
 * the same control, so a restore does only what the switch would, and only
 * where this TV has it. NOT_CARRIED names every other control with the reason
 * it is left out; test-backup-scope.js fails on a control in neither, so a new
 * setting cannot go unnoticed.
 *
 * Strict ES5: runs on node 0.12.
 */

/** @type {function(string, Object, function(any): void): void} */
var luna = null;
/** @type {function(string, any, function(any): void): void} */
var control = null;
/** @type {any} */
var config = null;
/** @type {typeof import('./privacy')} */
var privacy = null;
/** @type {typeof import('./services')} */
var services = null;
/** @type {typeof import('./remotekeys')} */
var remoteKeys = null;
/** @type {typeof import('./quickaccess')} */
var quickAccess = null;
/** @type {typeof import('./screensavers')} */
var screensavers = null;
/** @type {typeof import('./apps')} */
var apps = null;
/** @type {typeof import('./home')} */
var home = null;
/** @type {function(function(boolean): void): void} */
var alwaysOnSupported = function (cb) { cb(false); };

var BROWSER_APP = 'com.webos.app.browser';

function isBool(v) { return typeof v === 'boolean'; }
function isOn(v) { return v === true || v === 'on' || v === 'ON' || v === 'true'; }
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// One of LG's system settings, or undefined where this TV has none.
function lgValue(category, key, cb) {
  luna('com.webos.service.settings/getSystemSettings', { category: category, keys: [key] }, function (r) {
    var v = r && r.returnValue !== false && r.settings ? r.settings[key] : undefined;
    cb(v === undefined || v === null || v === '' ? undefined : v);
  });
}

// An LG switch with a control of its own.
function lgSwitch(id, category, key, action, onTest) {
  return {
    id: id,
    action: action,
    valid: isBool,
    read: function (cb) {
      lgValue(category, key, function (v) { cb(v === undefined ? undefined : (onTest || isOn)(v)); });
    },
    write: function (v, cb) { control(action, v, cb); }
  };
}

// As alwaysOnSupported decides: a B8 keeps an alwaysOn value without the feature.
function whereAlwaysOn(part) {
  var read = part.read;
  part.read = function (cb) {
    alwaysOnSupported(function (yes) { if (!yes) return cb(undefined); read(cb); });
  };
  return part;
}

function hourValid(v) { return typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= 23; }

/*
 * Each part: id, the control it restores through (action, where it has one),
 * valid(value), read(cb(value or undefined where this TV has none)),
 * write(value, cb({ ok, error })), and refuse(value, current), a reason a
 * value is not restored even though the TV offers it.
 */
var PARTS = [
  lgSwitch('lgLogo', 'other', 'lgLogoDisplay', 'lgLogo'),
  lgSwitch('quickBoot', 'option', 'quickStartMode', 'quickBoot'),
  lgSwitch('wakeOnLan', 'network', 'wolwowlOnOff', 'wakeOnLan'),
  lgSwitch('deviceDetection', 'other', 'ueiEnable', 'deviceDetection'),
  lgSwitch('standbyLight', 'option', 'standByLight', 'standbyLight'),
  whereAlwaysOn(lgSwitch('alwaysOn', 'general', 'alwaysOn', 'alwaysReady')),
  whereAlwaysOn({
    id: 'alwaysOnOffStart',
    action: 'alwaysReadyOffStart',
    valid: hourValid,
    read: function (cb) {
      lgValue('general', 'alwaysOnDisableStartHour', function (v) {
        var h = v === undefined ? NaN : parseInt(String(v), 10);
        cb(hourValid(h) ? h : undefined);
      });
    },
    write: function (v, cb) { control('alwaysReadyOffStart', String(v), cb); }
  }),
  // 'allEnabled' (with the wallpaper) or 'alwaysReady' (dark): only the first is offered.
  lgSwitch('alwaysReadyScreen', 'general', 'lifeOnScreenMode', 'alwaysReadyScreen', function (v) { return v !== 'off'; }),
  {
    id: 'homeAutoLaunch',
    action: 'homeAutoLaunch',
    valid: isBool,
    // While Glasshouse Home holds it off, the owner's choice is what the switch shows.
    read: function (cb) {
      lgValue('general', 'homeAutoLaunch', function (v) {
        if (v === undefined) return cb(undefined);
        cb(!!(home && home.autoLaunchHeld()) || isOn(v));
      });
    },
    write: function (v, cb) { control('homeAutoLaunch', v, cb); }
  },
  {
    id: 'clockHour12',
    action: 'clockHour12',
    valid: isBool,
    read: function (cb) {
      luna('com.webos.service.systemservice/getPreferences', { keys: ['timeFormat'] }, function (r) {
        var v = r && r.timeFormat;
        cb(v === 'HH12' ? true : v === 'HH24' ? false : undefined);
      });
    },
    write: function (v, cb) { control('clockHour12', v, cb); }
  },
  {
    id: 'limitAdTracking',
    action: 'limitAdTracking',
    valid: isBool,
    read: function (cb) {
      luna('com.webos.settingsservice/getSystemSettings', { category: 'general', keys: ['lmt'] }, function (r) {
        var v = r && r.settings && r.settings.lmt;
        cb(v === undefined || v === null ? undefined : String(v).toLowerCase() === 'on');
      });
    },
    write: function (v, cb) { control('limitAdTracking', v, cb); }
  },
  {
    /*
     * Live content recognition is LG's agreements as well as a setting, and
     * switching it on agrees to them: a file only switches it off.
     */
    id: 'acr',
    action: 'acr',
    valid: isBool,
    read: function (cb) {
      privacy.collectPrivacy(function (p) {
        cb(p && p.acr && typeof p.acr.consentOn === 'boolean' ? p.acr.consentOn : undefined);
      });
    },
    refuse: function (v, current) { return v && !current ? 'consent' : null; },
    write: function (v, cb) { control('acr', v, cb); }
  },
  {
    id: 'adBlock',
    action: 'setAdBlock',
    valid: function (v) { return v === 'off' || v === 'ads' || v === 'full'; },
    read: function (cb) { cb(privacy.adBlockMode()); },
    write: function (v, cb) { control('setAdBlock', v, cb); }
  },
  {
    // The owner's own list of hosts to block, or null for none.
    id: 'adBlockList',
    valid: function (v) {
      return v === null || (isObject(v) && (v.mode === 'add' || v.mode === 'replace') && Array.isArray(v.names) &&
        v.names.length > 0 && v.names.every(function (n) { return typeof n === 'string' && n.length <= 253; }) &&
        isBool(v.enabled));
    },
    read: function (cb) {
      var c = privacy.customHosts();
      cb(c ? { mode: c.mode, names: c.names, enabled: c.enabled } : null);
    },
    write: function (v, cb) {
      if (!v) return privacy.setCustomHosts({ clear: true }, cb);
      privacy.setCustomHosts({ mode: v.mode, text: v.names.join('\n') }, function (r) {
        if (!r || !r.ok || v.enabled) return cb(r);
        privacy.setCustomHosts({ enabled: false }, cb);
      });
    }
  },
  {
    // { id: switched off } for the background services this TV lists.
    id: 'services',
    action: 'service',
    valid: function (v) {
      return isObject(v) && Object.keys(v).every(function (k) { return isBool(v[k]); });
    },
    read: function (cb) {
      services.getServices(function (r) {
        if (!r || !r.supported) return cb(undefined);
        var out = {};
        (r.services || []).forEach(function (s) { out[s.id] = !!s.disabled; });
        cb(out);
      });
    },
    // Only those both TVs list: one this TV lacks is left out, one the file lacks left as it is.
    merge: function (v, current) {
      var out = {};
      Object.keys(current).forEach(function (k) { out[k] = v.hasOwnProperty(k) ? v[k] : current[k]; });
      return out;
    },
    write: function (v, cb, current) {
      var ids = Object.keys(v).filter(function (k) { return v[k] !== current[k]; });
      var failed = [];
      (function next(i) {
        if (i >= ids.length) return cb({ ok: !failed.length, error: failed.length ? failed.join(', ') : undefined });
        services.toggleService(ids[i], v[ids[i]], function (r) {
          if (!r || !r.ok) failed.push(ids[i]);
          next(i + 1);
        });
      })(0);
    }
  },
  {
    // Network device scans: off holds LG's lookup service down, as its switch in Devices does.
    id: 'deviceScans',
    action: 'deviceScans',
    valid: isBool,
    read: function (cb) {
      cb(services.available('iconnectivity') ? !services.isDisabled('iconnectivity') : undefined);
    },
    write: function (v, cb) { control('deviceScans', v, cb); }
  },
  {
    // Each web page saved to the Home screen, as { title, address }. A restore adds those missing.
    id: 'savedPages',
    valid: function (v) {
      return Array.isArray(v) && v.length <= 100 && v.every(function (p) {
        return isObject(p) && typeof p.title === 'string' && p.title.length <= 60 &&
          typeof p.address === 'string' && /^https?:\/\//i.test(p.address) && p.address.length <= 2048;
      });
    },
    read: function (cb) {
      luna('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
        if (!r || !Array.isArray(r.launchPoints)) return cb(undefined);
        cb(r.launchPoints.filter(function (p) {
          return p && p.id === BROWSER_APP && p.lptype === 'bookmark' && p.params && typeof p.params.target === 'string';
        }).map(function (p) { return { title: String(p.title || ''), address: p.params.target }; }));
      });
    },
    merge: function (v, current) {
      var have = current.map(function (p) { return p.address; });
      return current.concat(v.filter(function (p) { return have.indexOf(p.address) === -1; }));
    },
    write: function (v, cb, current) {
      var add = v.slice(current.length);
      var failed = [];
      (function next(i) {
        if (i >= add.length) return cb({ ok: !failed.length, error: failed.length ? failed.join(', ') : undefined });
        apps.addSavedPage(add[i].address, add[i].title, function (r) {
          if (!r || !r.ok) failed.push(add[i].address);
          next(i + 1);
        });
      })(0);
    }
  },
  {
    // { key: what it opens, '' for nothing, null for as LG has it }, for the keys this TV offers.
    id: 'remoteKeys',
    action: 'remoteKey',
    valid: function (v) {
      return isObject(v) && Object.keys(v).every(function (k) {
        return v[k] === null || (typeof v[k] === 'string' && v[k].length <= 200);
      });
    },
    read: function (cb) {
      remoteKeys.getRemoteKeys(function (r) {
        if (!r || !r.supported) return cb(undefined);
        var out = {};
        (r.keys || []).forEach(function (k) { out[k.key] = k.action === 'lg' ? null : k.action === 'nothing' ? '' : k.id; });
        cb(out);
      });
    },
    merge: function (v, current) {
      var out = {};
      Object.keys(current).forEach(function (k) { out[k] = v.hasOwnProperty(k) ? v[k] : current[k]; });
      return out;
    },
    // A key set to an app this TV lacks is refused by setRemoteKey, and named.
    write: function (v, cb, current) {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== current[k]; });
      var failed = [];
      (function next(i) {
        if (i >= keys.length) return cb({ ok: !failed.length, error: failed.length ? failed.join(', ') : undefined });
        var to = v[keys[i]];
        remoteKeys.setRemoteKey(keys[i], to === null ? 'lg' : to === '' ? 'nothing' : 'open', to || '', function (r) {
          if (!r || !r.ok) failed.push(keys[i]);
          next(i + 1);
        });
      })(0);
    }
  },
  {
    // { '1'..'9': what the key opens, '' for nothing }.
    id: 'quickAccess',
    action: 'quickAccess',
    valid: function (v) {
      return isObject(v) && Object.keys(v).every(function (k) {
        return /^[1-9]$/.test(k) && typeof v[k] === 'string' && v[k].length <= 200;
      });
    },
    read: function (cb) {
      quickAccess.getQuickAccess(function (r) {
        if (!r || !r.supported) return cb(undefined);
        var out = {};
        (r.keys || []).forEach(function (k) { out[String(k.key)] = k.id || ''; });
        cb(out);
      });
    },
    merge: function (v, current) {
      var out = {};
      Object.keys(current).forEach(function (k) { out[k] = v.hasOwnProperty(k) ? v[k] : current[k]; });
      return out;
    },
    write: function (v, cb, current) {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== current[k]; });
      var failed = [];
      (function next(i) {
        if (i >= keys.length) return cb({ ok: !failed.length, error: failed.length ? failed.join(', ') : undefined });
        quickAccess.setQuickAccess(Number(keys[i]), v[keys[i]], function (r) {
          if (!r || !r.ok) failed.push(keys[i]);
          next(i + 1);
        });
      })(0);
    }
  },
  {
    // { mode, level }: a screen saver this TV has, or LG's own.
    id: 'screensaver',
    action: 'screensaverMode',
    valid: function (v) {
      return isObject(v) && typeof v.mode === 'string' && v.mode.length <= 100 && (v.level === 'dim' || v.level === 'bright');
    },
    read: function (cb) { cb({ mode: screensavers.screensaverMode(), level: screensavers.screensaverLevel() }); },
    refuse: function (v) {
      var hit = screensavers.screensaverList().filter(function (s) { return s.id === v.mode; })[0];
      return !hit ? 'absent' : !hit.available ? 'inactive' : null;
    },
    write: function (v, cb) { control('screensaverMode', v, cb); }
  },
  {
    // Minutes of screen saver before the TV switches off, 0 for never.
    id: 'screensaverPowerOff',
    action: 'screensaverPowerOff',
    valid: function (v) { return typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= 1440; },
    read: function (cb) { cb(config && typeof config.screensaverPowerOffMinutes === 'number' ? config.screensaverPowerOffMinutes : 0); },
    write: function (v, cb) { control('screensaverPowerOff', v || '', cb); }
  }
];

/*
 * The controls a backup leaves out, by the reason given in the Server tab's
 * docs: 'action' does something now rather than keep a setting; 'panel' is
 * tuned to one panel or risky on another; 'access', 'experimental' and
 * 'tvName' are left out as config.json's are; 'choose' is to be decided on
 * each TV; 'carried' is in a backup another way.
 */
var NOT_CARRIED = {
  volume: 'action', volumeStep: 'action', mute: 'action', screenOff: 'action', screenOn: 'action',
  input: 'action', sendText: 'action', launch_app: 'action', launchApp: 'action', launch_url: 'action',
  launchUrl: 'action', close_app: 'action', closeApp: 'action', playback: 'action', media: 'action',
  resetAdId: 'action', clearAdCookies: 'action', privacyAllOff: 'action', sleepTimer: 'action',
  piccap: 'action', huesync: 'action', serviceMenuOpen: 'action', tvAppInstall: 'action', tvAppRemove: 'action',
  rcu: 'action', keyboardText: 'action', keyboardKey: 'action', screensaver: 'action', toast: 'action',
  powerOn: 'action', powerOff: 'action', reboot: 'action', refresherSchedule: 'action', refresherCancel: 'action',
  updateCheck: 'action', update: 'action', updateRollback: 'action', clearHistory: 'action',
  // Picture settings are kept per input and picture mode, and suit the panel.
  picture_mode: 'panel', pictureMode: 'panel', energySaving: 'panel', backlight: 'panel',
  screenShift: 'panel', logoDimming: 'panel', oledProtection: 'panel', serviceMenuLock: 'panel',
  // LG's sound section, carried as lgsettings.js's rows.
  sound_output: 'carried', soundOutput: 'carried',
  // The logo light is only on some models, and is the same switch as the standby light on others.
  logoLight: 'panel',
  // LG's own agreements, each one a choice to make on the TV.
  consent: 'choose',
  // An On or Off Timer wakes or switches off the TV it was set on.
  powerTimer: 'choose',
  blockTvUpdates: 'choose',
  // Rewrites LG's app list and restarts its app manager; Glasshouse Home's own hiding is in the layout.
  tileHiding: 'choose',
  // Screen saver entity slots can be bound to different sensors on different TVs.
  screensaverEntities: 'choose',
  setTileHidingAllowed: 'experimental', setWebos10ScreensaversAllowed: 'experimental', setInputBarAllowed: 'experimental',
  setNetworkDebuggerAllowed: 'access', setDashboardPort: 'access',
  setDeviceName: 'tvName',
  // config.json's, in backup.js's GLASSHOUSE.
  // The adBlock part's control under its other names.
  adblock: 'carried', toggleAdBlock: 'carried',
  updateAutoCheck: 'carried', setPrometheusEnabled: 'carried', setNtpServer: 'carried', setNtpEnabled: 'carried',
  setHistoryEnabled: 'carried', setBackupDaily: 'carried',
  // One of lgsettings.js's rows: carried by its section.
  lgSetting: 'carried'
};

function init(opts) {
  luna = opts.luna;
  control = opts.control;
  config = opts.config || null;
  privacy = opts.privacy;
  services = opts.services;
  remoteKeys = opts.remoteKeys;
  quickAccess = opts.quickAccess;
  screensavers = opts.screensavers;
  apps = opts.apps;
  home = opts.home || null;
  if (opts.alwaysOnSupported) alwaysOnSupported = opts.alwaysOnSupported;
}

module.exports = {
  init: init,
  PARTS: PARTS,
  NOT_CARRIED: NOT_CARRIED
};
