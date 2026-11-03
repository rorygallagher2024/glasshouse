/*
 * Live TV state subscriptions and the latest-value state cache.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var luna = require('./luna');
var powerModule = require('./power');
var names = require('./names');

function StateManager() {
  this.values = {};
  this.times = {};
  this.listeners = [];
}

StateManager.prototype.onChange = function (listener) {
  if (typeof listener === 'function') this.listeners.push(listener);
  return this;
};

StateManager.prototype.update = function (group, key, value, sourceTime) {
  var values = this.values[group] || (this.values[group] = {});
  var times = this.times[group] || (this.times[group] = {});
  var changed = !Object.prototype.hasOwnProperty.call(values, key) || values[key] !== value;
  var event, i;

  sourceTime = typeof sourceTime === 'number' ? sourceTime : Date.now();
  if (typeof times[key] === 'number' && sourceTime < times[key]) return false;
  times[key] = sourceTime;
  if (!changed) return false;

  values[key] = value;
  event = { group: group, key: key, value: value, sourceTime: sourceTime };
  for (i = 0; i < this.listeners.length; i++) {
    try { this.listeners[i](event); } catch (e) {}
  }
  return true;
};

StateManager.prototype.snapshot = function () {
  var result = {}, group, key;
  for (group in this.values) {
    result[group] = {};
    for (key in this.values[group]) result[group][key] = this.values[group][key];
  }
  return result;
};

function StateGroup(name, subscription, mapResponse, onError) {
  var self = this;
  this.name = name;
  this.subscription = subscription;
  this.mapResponse = mapResponse;
  this.onError = onError;
  /** @type {?function(Object): void} A reply with returnValue false. */
  this.onRefused = null;
  /** @type {?function(Object): void} Every other reply, as the TV sent it. */
  this.onReply = null;
  this.listeners = [];
  this.snapshotPending = true;
  // Starts not yet matched by a stop: the subscription runs while any remain.
  this.users = 0;

  subscription.handlers.message = function (response) {
    self._message(response);
  };
  subscription.handlers.close = function (code, signal) {
    self.snapshotPending = true;
  };
  subscription.handlers.error = function (err, line) {
    if (self.onError) self.onError(err, line);
  };
}

StateGroup.prototype.onState = function (listener) {
  if (typeof listener === 'function') this.listeners.push(listener);
  return this;
};

StateGroup.prototype.start = function () {
  if (this.users++ === 0) this.subscription.start();
  return this;
};

StateGroup.prototype.stop = function () {
  if (this.users === 0) return this;
  if (--this.users === 0) this.subscription.stop();
  return this;
};

StateGroup.prototype._message = function (response) {
  var values, key, sourceTime, event, i;
  if (response && response.returnValue === false && this.onRefused) this.onRefused(response);
  if (!response || response.returnValue === false) return;
  if (this.onReply) {
    try { this.onReply(response); } catch (e) {}
  }
  values = this.mapResponse(response);
  if (!values) return;
  sourceTime = Date.now();
  for (key in values) {
    if (values[key] === null || typeof values[key] === 'undefined') continue;
    event = {
      group: this.name,
      key: key,
      value: values[key],
      snapshot: this.snapshotPending,
      sourceTime: sourceTime
    };
    for (i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](event); } catch (e) {}
    }
  }
  this.snapshotPending = false;
};

function applicationValues(appId, inputNames, inputKey) {
  var full = String(appId || '');
  var short = inputKey ? inputKey(full) : names.shortAppId(full);
  return {
    app_id: full,
    app: short,
    display_title: names.inputTitle(short, inputNames[short])
  };
}

/*
 * The volume reply comes in one of two shapes. The newer audio service,
 * com.webos.service.audio/master/getVolume (webOS 5 and later), nests it in
 * volumeStatus. The older com.webos.audio/getVolume replies flat, and is all
 * a webOS 4 TV such as the B8 has. The newer one is read where it exists:
 * when sound goes to an eARC soundbar that controls the volume, the older one
 * reports 0 instead of the soundbar's level (#406).
 */
// -1 means the TV is not setting the level - see telemetry's sound read.
function level(v) {
  return typeof v === 'number' && v >= 0 ? v : null;
}

function audioValues(response, formatSoundOutput) {
  var vs = response && response.volumeStatus;
  if (vs && typeof vs === 'object') {
    return {
      volume: level(vs.volume),
      muted: typeof vs.muteStatus === 'boolean' ? vs.muteStatus : null,
      output: vs.soundOutput ? formatSoundOutput(String(vs.soundOutput)) : null
    };
  }
  var scenario = response && response.scenario ? String(response.scenario).replace(/^mastervolume_/, '') : null;
  return {
    volume: level(response && response.volume),
    muted: response && typeof response.muted !== 'undefined' ? !!response.muted : null,
    output: scenario ? formatSoundOutput(scenario) : null
  };
}

/** @this {StateGroup} */
function stopIfUnknownMethod(response) {
  if (/unknown method/i.test(String(response.errorText || ''))) this.subscription.stop();
}

var MASTER_VOLUME = 'com.webos.service.audio/master/getVolume';
var LEGACY_VOLUME = 'com.webos.audio/getVolume';
var KEYBOARD_WINDOW = '_WEBOS_WINDOW_TYPE_KEYBOARD';

function init(opts) {
  opts = opts || {};
  var state = new StateManager();
  var inputNames = opts.inputNameMap || {};
  var inputKey = opts.inputKey || null;
  var clearCache = opts.clearCache || function () {};
  var groups = {};
  var pictureKeys = ['backlight', 'pictureMode', 'energySaving', 'screenShift', 'logoLuminanceAdjust'];

  groups.picture = new StateGroup('picture', new luna.Subscription(
    'com.webos.service.settings/getSystemSettings',
    { category: 'picture', keys: pictureKeys, subscribe: true }, null
  ), function (response) {
    clearCache('picture');
    return response.settings;
  });
  groups.power = new StateGroup('power', new luna.Subscription(
    'com.webos.service.tvpower/power/getPowerState', { subscribe: true }, null
  ), function (response) {
    var rawState = response.state;
    if (!rawState && response.processing) rawState = response.processing;
    // A reply without a state is a failed read, not a TV switched off.
    if (!rawState) return null;
    var mapped = powerModule.mapState(rawState);
    var screenOn = !!(mapped.systemOn && mapped.screenOn);
    return { state: mapped.raw, screenOn: screenOn, systemOn: mapped.systemOn };
  });
  groups.application = new StateGroup('application', new luna.Subscription(
    'com.webos.applicationManager/getForegroundAppInfo', { subscribe: true }, null
  ), function (response) {
    clearCache('application');
    return response.appId ? applicationValues(response.appId, inputNames, inputKey) : null;
  });
  // applicationManager names the HDMI input beneath LG's Settings or Home;
  // SurfaceManager lists the windows on screen. Display 0 is the TV's panel.
  groups.surface = new StateGroup('surface', new luna.Subscription(
    'com.webos.surfacemanager/getForegroundAppInfo', { subscribe: true }, null
  ), function (response) {
    if (!Array.isArray(response.foregroundAppInfo)) return null;
    var windows = response.foregroundAppInfo, card = '', home = '', overlay = '', i, w;
    for (i = 0; i < windows.length; i++) {
      w = windows[i];
      if (w.displayId !== undefined && w.displayId !== 0) continue;
      if (w.windowType === '_WEBOS_WINDOW_TYPE_CARD') card = w.appId || '';
      if (w.windowType === '_WEBOS_WINDOW_TYPE_HOME' && w.appId === 'com.webos.app.home') home = w.appId;
      if (w.windowType === '_WEBOS_WINDOW_TYPE_OVERLAY' &&
          /^com\.(palm|webos)\.app\./.test(w.appId || '')) overlay = w.appId;
    }
    return { control_app_id: overlay || home || card };
  });
  // Quick Settings is not among the windows on screen, but has the focus, and
  // the focused window is the one the remote's keys reach.
  groups.focus = new StateGroup('focus', new luna.Subscription(
    'com.webos.surfacemanager/getFocusedWindowInfo', { subscribe: true }, null
  ), function (response) {
    if (!Array.isArray(response.focusedWindowInfo)) return null;
    var windows = response.focusedWindowInfo, id = '', i, w;
    for (i = 0; i < windows.length; i++) {
      w = windows[i];
      if (w.displayId === undefined || w.displayId === 0) id = w.appId || '';
    }
    return { control_app_id: id };
  });
  // A TV whose SurfaceManager lacks these methods refuses them each time:
  // stop asking, and Active App goes without control_app_id.
  // LG's on-screen keyboard is a _WEBOS_WINDOW_TYPE_KEYBOARD view in this
  // list. It never takes focus, so focus keeps naming the app typed into.
  groups.keyboard = new StateGroup('keyboard', new luna.Subscription(
    'com.webos.surfacemanager/getForegroundWindowInfo', { subscribe: true }, null
  ), function (response) {
    if (!Array.isArray(response.windows)) return null;
    return { keyboard_visible: response.windows.some(function (w) {
      return !!w && w.windowType === KEYBOARD_WINDOW;
    }) };
  });
  groups.surface.onRefused = groups.focus.onRefused = groups.keyboard.onRefused = stopIfUnknownMethod;
  groups.audio = new StateGroup('audio', new luna.Subscription(
    MASTER_VOLUME, { subscribe: true }, null
  ), function (response) {
    clearCache('audio');
    return audioValues(response, opts.formatSoundOutput || function (value) { return value; });
  });
  // A TV without the newer service (a B8 says "Unknown method") uses the older one from then on.
  groups.audio.onRefused = function (response) {
    var sub = this.subscription;
    if (sub.uri !== MASTER_VOLUME || !/unknown (method|service)/i.test(String(response.errorText || ''))) return;
    sub.stop();
    sub.uri = LEGACY_VOLUME;
    sub.start();
  };

  function apply(group, values, time) {
    var key;
    if (!values) return;
    for (key in values) {
      if (values[key] !== null && typeof values[key] !== 'undefined') {
        state.update(group, key, values[key], time);
      }
    }
  }

  function reconcile(stats) {
    var picture = stats && stats.picture;
    var power = stats && stats.powerState;
    var sound = stats && stats.audio_output !== undefined ? {
      volume: stats.volume,
      muted: stats.muted,
      output: stats.audio_output
    } : null;
    var app = stats && stats.app_id ? applicationValues(stats.app_id, inputNames, inputKey) : null;
    var time = stats && stats.time;

    if (picture) apply('picture', {
      pictureMode: picture.mode_raw,
      backlight: picture.backlight,
      energySaving: picture.energySaving,
      screenShift: picture.screenShift,
      logoLuminanceAdjust: picture.logoLuminanceAdjust
    }, time);
    if (power) apply('power', {
      state: power.raw,
      screenOn: power.screenOn,
      systemOn: power.systemOn
    }, time);
    apply('application', app, time);
    apply('audio', sound, time);
  }

  function start() {
    var key;
    // Window tracking is only useful to MQTT, which starts those groups itself.
    for (key in groups) {
      if (key !== 'surface' && key !== 'focus' && key !== 'keyboard') groups[key].start();
    }
  }

  function stop() {
    var key;
    for (key in groups) groups[key].stop();
  }

  // One group for a user of its own, alongside or without start().
  function startGroup(name) {
    if (groups[name]) groups[name].start();
  }

  function stopGroup(name) {
    if (groups[name]) groups[name].stop();
  }

  for (var groupName in groups) {
    (function (name) {
      groups[name].onState(function (event) {
        var changed = state.update(name, event.key, event.value, event.sourceTime);
        // Only what the TV reports changing, not the first answer after
        // subscribing nor a value telemetry filled in (reconcile).
        if (changed && !event.snapshot && opts.onTvChange) opts.onTvChange(event);
      });
    })(groupName);
  }

  return {
    state: state,
    groups: groups,
    reconcile: reconcile,
    start: start,
    stop: stop,
    startGroup: startGroup,
    stopGroup: stopGroup
  };
}

module.exports = {
  StateManager: StateManager,
  audioValues: audioValues,
  applicationValues: applicationValues,
  init: init
};
