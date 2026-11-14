/*
 * The status the MQTT bridge publishes when its connection comes back.
 *
 * The connection can be back - the TV waking, Wi-Fi back - a couple of seconds
 * before the power group's own subscription answers with the same change, and
 * the flag is then the one from before the TV slept. Publishing "off" at once
 * means a moment of off right before the "online" the answer corrects it to,
 * so while the TV reads off the status is queued, and cancel() drops it once
 * the answer is in. With the TV on there is nothing to wait for: its status
 * goes out at once, so a server started with the TV on does not leave Power at
 * the "asleep" the broker kept from the last will.
 *
 * Node's timers stop while the TV is suspended and the wall clock runs on, so
 * a status queued just before the TV slept comes due the moment it wakes, ahead
 * of the answer it was waiting for (an OLED48CX8LC showed off for 2 s on waking
 * from it). One that comes due long after it was queued is queued again.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var DELAY_MS = 2500;

/*
 * opts: isOff() says whether the TV reads off, publish() sends the status,
 * and delayMs, now, setTimeout and clearTimeout replace the defaults in a test.
 */
function create(opts) {
  var wait = typeof opts.delayMs === 'number' ? opts.delayMs : DELAY_MS;
  var setTimer = opts.setTimeout || setTimeout;
  var clearTimer = opts.clearTimeout || clearTimeout;
  var now = opts.now || Date.now;
  var timer = null;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function queue() {
    var queuedAt = now();
    timer = setTimer(function () {
      timer = null;
      // Due long after it was queued: the TV slept in between and is only waking.
      if (now() - queuedAt > wait * 2) return queue();
      opts.publish();
    }, wait);
  }

  return {
    // The connection is up.
    connected: function () {
      cancel();
      if (!opts.isOff()) return opts.publish();
      queue();
    },
    // The power group has answered: a status still queued is behind it.
    cancel: cancel,
    // Whether a status is queued, so nothing else publishes the same one ahead of it.
    pending: function () { return timer !== null; }
  };
}

module.exports = { create: create, DELAY_MS: DELAY_MS };
