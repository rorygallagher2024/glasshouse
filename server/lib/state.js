/*
 * Live TV state subscriptions and the latest-value state cache.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var luna = require('./luna');

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
  this.listeners = [];
  this.snapshotPending = true;

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
  this.subscription.start();
  return this;
};

StateGroup.prototype.stop = function () {
  this.subscription.stop();
  return this;
};

StateGroup.prototype._message = function (response) {
  var values, key, sourceTime, event, i;
  if (response && response.returnValue === false && this.onRefused) this.onRefused(response);
  if (!response || response.returnValue === false) return;
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

function applicationValues(appId, inputNames) {
  var full = String(appId || '');
  var short = full.replace('com.webos.app.', '');
  var name = inputNames[short] || short;
  return {
    app_id: full,
    app: short,
    display_title: (name && name !== short) ? name + ' (' + short.toUpperCase() + ')' : short
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
function audioValues(response, formatSoundOutput) {
  var vs = response && response.volumeStatus;
  if (vs && typeof vs === 'object') {
    return {
      volume: typeof vs.volume === 'number' ? vs.volume : null,
      muted: typeof vs.muteStatus === 'boolean' ? vs.muteStatus : null,
      output: vs.soundOutput ? formatSoundOutput(String(vs.soundOutput)) : null
    };
  }
  var scenario = response && response.scenario ? String(response.scenario).replace(/^mastervolume_/, '') : null;
  return {
    volume: response && typeof response.volume !== 'undefined' ? response.volume : null,
    muted: response && typeof response.muted !== 'undefined' ? !!response.muted : null,
    output: scenario ? formatSoundOutput(scenario) : null
  };
}

var MASTER_VOLUME = 'com.webos.service.audio/master/getVolume';
var LEGACY_VOLUME = 'com.webos.audio/getVolume';

function init(opts) {
  opts = opts || {};
  var state = new StateManager();
  var inputNames = opts.inputNameMap || {};
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
    var mapped = opts.mapPowerState ? opts.mapPowerState(rawState) : null;
    if (!mapped) return null;
    var screenOn = !!(mapped.systemOn && mapped.screenOn);
    return { state: mapped.raw, screenOn: screenOn, systemOn: mapped.systemOn };
  });
  groups.application = new StateGroup('application', new luna.Subscription(
    'com.webos.applicationManager/getForegroundAppInfo', { subscribe: true }, null
  ), function (response) {
    clearCache('application');
    return response.appId ? applicationValues(response.appId, inputNames) : null;
  });
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
    var app = stats && stats.app_id ? applicationValues(stats.app_id, inputNames) : null;
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
    for (key in groups) groups[key].start();
  }

  function stop() {
    var key;
    for (key in groups) groups[key].stop();
  }

  for (var groupName in groups) {
    (function (name) {
      groups[name].onState(function (event) {
        state.update(name, event.key, event.value, event.sourceTime);
      });
    })(groupName);
  }

  return {
    state: state,
    groups: groups,
    reconcile: reconcile,
    start: start,
    stop: stop
  };
}

module.exports = {
  StateManager: StateManager,
  audioValues: audioValues,
  init: init
};
