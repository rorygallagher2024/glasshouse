/*
 * Retained MQTT topics for the live state cache.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var topics = require('./topics');

function scalar(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function init(opts) {
  opts = opts || {};
  var client = opts.client;
  var topic = topics(opts.prefix);
  var legacyScreenTopic = opts.legacyScreenTopic || topic.state('screen');
  var manager = null;
  var emptyRemoteTimer = null;
  var lastRemoteBody = null;
  var remoteSnapshotPending = false;

  function publishValue(group, key, value) {
    if (value === null || typeof value === 'undefined') return;
    client.publish(topic.state(group + '/' + key), scalar(value), true);
    // tvpower's reply gives screenOn before systemOn, so on a switch-on
    // screenOn arrives while systemOn still reads false. Worked out again on
    // either, the screen follows whichever comes second.
    if (group === 'power' && (key === 'screenOn' || key === 'systemOn')) {
      var snap = manager ? manager.snapshot() : null;
      var pwr = snap && snap.power;
      var screenOn = key === 'screenOn' ? !!value : !!(pwr && pwr.screenOn);
      if (key === 'systemOn' && !(pwr && typeof pwr.screenOn === 'boolean')) return;
      if (pwr && pwr.systemOn === false) screenOn = false;
      client.publish(legacyScreenTopic, screenOn ? 'ON' : 'OFF', true);
    }
  }

  /*
   * Active App's attributes: the foreground app's id, and the window the
   * remote's keys reach, from the focused window where the TV reports one and
   * the windows on screen otherwise. A TV without SurfaceManager's window
   * reports leaves control_app_id out; an empty one is a screen with nothing
   * focused, or the TV off, and must not be read as the last app.
   */
  function publishRemote(force, settled) {
    if (!manager) return;
    if (force) remoteSnapshotPending = true;
    var snap = manager.snapshot();
    var payload = { app_id: (snap.application && snap.application.app_id) || '' };
    var windowGroups = [snap.surface, snap.focus];
    for (var i = 0; i < windowGroups.length; i++) {
      if (windowGroups[i] && typeof windowGroups[i].control_app_id === 'string') {
        payload.control_app_id = windowGroups[i].control_app_id;
      }
    }
    // Omitted, like control_app_id, where the window list is not offered.
    if (snap.keyboard && typeof snap.keyboard.keyboard_visible === 'boolean') {
      payload.keyboard_visible = snap.keyboard.keyboard_visible;
    }
    if (snap.power && snap.power.systemOn === false) {
      if (payload.control_app_id !== undefined) payload.control_app_id = '';
      if (payload.keyboard_visible !== undefined) payload.keyboard_visible = false;
    }
    // Closing an LG window can report no focus for about 100 ms before HDMI
    // regains it. Standby still releases the remote immediately.
    if (payload.control_app_id === '' && !(snap.power && snap.power.systemOn === false) && !settled) {
      if (!emptyRemoteTimer) emptyRemoteTimer = setTimeout(function () {
        emptyRemoteTimer = null;
        publishRemote(false, true);
      }, 200);
      return;
    }
    if (emptyRemoteTimer) clearTimeout(emptyRemoteTimer);
    emptyRemoteTimer = null;
    var body = JSON.stringify(payload);
    if (!remoteSnapshotPending && body === lastRemoteBody) return;
    remoteSnapshotPending = false;
    lastRemoteBody = body;
    client.publish(topic.state('application/remote'), body, true);
  }

  function changesRemote(event) {
    return (event.group === 'application' && event.key === 'app_id') ||
           event.group === 'surface' || event.group === 'focus' || event.group === 'keyboard' ||
           (event.group === 'power' && event.key === 'systemOn');
  }

  function onChange(event) {
    publishValue(event.group, event.key, event.value);
    if (changesRemote(event)) publishRemote();
  }

  function attach(stateManager) {
    manager = stateManager;
    manager.onChange(onChange);
  }

  function publishSnapshot() {
    var values, group, key;
    if (!manager) return;
    values = manager.snapshot();
    for (group in values) {
      for (key in values[group]) publishValue(group, key, values[group][key]);
    }
    publishRemote(true);
  }

  return {
    attach: attach,
    publishSnapshot: publishSnapshot,
    publishValue: publishValue
  };
}

/*
 * Calls publish soon after a change: settleMs after the first of a run of
 * changes, which go out as one, and never sooner than gapMs after the last
 * publish began. A change while a publish is under way is held until
 * finished(), since that publish may have read the value from before. A
 * publish that never finishes is forgotten after 15s rather than holding
 * changes back for good.
 */
function changePublisher(opts) {
  var timer = null, since = 0, last = 0, again = false;
  function busy() { return since !== 0 && Date.now() - since < 15000; }
  function changed() {
    if (busy()) { again = true; return; }
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (busy()) { again = true; return; }
      opts.publish();
    }, Math.max(opts.settleMs, last + opts.gapMs - Date.now()));
  }
  return {
    changed: changed,
    started: function () { since = last = Date.now(); },
    finished: function () {
      since = 0;
      if (again) { again = false; changed(); }
    }
  };
}

module.exports = {
  init: init,
  changePublisher: changePublisher
};
