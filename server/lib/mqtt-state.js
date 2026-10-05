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

  function publishValue(group, key, value) {
    if (value === null || typeof value === 'undefined') return;
    client.publish(topic.state(group + '/' + key), scalar(value), true);
    if (group === 'power' && key === 'screenOn') {
      var screenOn = !!value;
      if (manager) {
        var snap = manager.snapshot();
        var pwr = snap && snap.power;
        if (pwr && pwr.systemOn === false) screenOn = false;
      }
      client.publish(legacyScreenTopic, screenOn ? 'ON' : 'OFF', true);
    }
  }

  function onChange(event) {
    publishValue(event.group, event.key, event.value);
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
