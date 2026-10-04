/*
 * Luna transport for one-shot calls and long-lived subscriptions.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var childProcess = require('child_process');
var execFile = childProcess.execFile;
var spawn = childProcess.spawn;

// Overridable so the start-up test can run the whole server against a stand-in.
var LUNA_SEND = process.env.TVWEB_LUNA_SEND || '/usr/bin/luna-send';

/*
 * One-shot calls run at most two at a time, the rest in turn. Node 0.12 on a
 * B8 (webOS 4) has frozen in its first second at start: a luna-send child
 * stuck between fork and exec on a lock it inherited held, the server waiting
 * on it, and every later child the same. Start fires off a burst of these
 * calls at once, which is when it happened. Subscriptions start once and stay
 * open, so they are not counted.
 */
var PARALLEL = 2;
var running = 0;
var waiting = [];

/*
 * Every process start, one-shot or subscription, waits its turn here, with a
 * gap between starts. Starting a child is the moment the freeze above can
 * happen, and it is likeliest while node's own threads are busy, as they are
 * just after start: 6 of 11 wedges a B8 logged in a fortnight came within 5
 * minutes of the server starting. The first 30s get a wider gap, so the
 * start-up calls and subscriptions spread out instead of landing together.
 */
var GAP_MS = 50;
// Not wider: a stats read makes about a dozen calls, and at 400ms apart it ran
// past its 4.5s limit and came back incomplete during start-up.
var STARTUP_GAP_MS = 150;
var STARTUP_MS = 30000;
/*
 * Monotonic, not Date.now(): the wall clock can step back, and a start due
 * "later" by the old clock then waited out the whole step, every call and
 * subscription with it, while the heartbeat carried on.
 */
function monotonicMs() {
  var t = process.hrtime();
  return t[0] * 1000 + t[1] / 1e6;
}
var bornAt = monotonicMs();
var launches = [];
var launchTimer = null;
var nextLaunchAt = 0;

function launch(fn) {
  launches.push(fn);
  drainLaunches();
}

function drainLaunches() {
  if (launchTimer || !launches.length) return;
  var now = monotonicMs();
  var gap = now - bornAt < STARTUP_MS ? STARTUP_GAP_MS : GAP_MS;
  var wait = nextLaunchAt - now;
  if (wait > 0) {
    launchTimer = setTimeout(function () { launchTimer = null; drainLaunches(); }, wait);
    return;
  }
  nextLaunchAt = now + gap;
  launches.shift()();
  drainLaunches();
}

function startWaiting() {
  while (running < PARALLEL && waiting.length) {
    var job = waiting.shift();
    running++;
    run(job);
  }
}

/*
 * A child killed by a signal it was not sent by the timeout died before
 * answering. On a 50UP81006LR (webOS 6.5, node v8.12.0) children aborted with
 * libuv's "uv_close: Assertion `!uv__is_closing(handle)' failed" at start and
 * the model name was lost; run by hand, the same call answered. Such a child
 * never reached luna-send, so running the call again is safe, writes included.
 */
function diedEarly(err) {
  return !!(err && err.signal && !err.killed);
}

function run(job) {
  launch(function () { runNow(job); });
}

function runNow(job) {
  execFile(LUNA_SEND, job.args, { timeout: 3500 }, function (err, stdout) {
    running--;
    if (diedEarly(err)) {
      var uri = job.args[job.args.length - 2];
      console.error('luna: ' + uri + ' died (' + err.signal + ') before answering' +
                    (job.retried ? ', giving up' : ', trying once more'));
      if (!job.retried) {
        job.retried = true;
        waiting.unshift(job);
        return startWaiting();
      }
    }
    startWaiting();
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }
    if (job.cb) job.cb(parsed, String(stdout || ''));
  });
}

function call(uri, payload, cb, appId) {
  var args = appId ? ['-a', appId] : [];
  args = args.concat(['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})]);
  waiting.push({ args: args, cb: cb });
  startWaiting();
}

function Subscription(uri, payload, appId, handlers) {
  this.uri = uri;
  this.payload = payload || {};
  this.appId = appId;
  this.handlers = handlers || {};
  this.child = null;
  this.buffer = '';
  this.stopped = true;
  this.retryTimer = null;
  this.retryMs = 1000;
  this.launching = false;
}

Subscription.prototype.start = function () {
  if (!this.stopped) return;
  this.stopped = false;
  this.retryMs = 1000;
  this._connect();
};

Subscription.prototype.stop = function () {
  this.stopped = true;
  if (this.retryTimer) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
  if (this.child) {
    this.child.kill();
    this.child = null;
  }
  this.buffer = '';
};

Subscription.prototype._connect = function () {
  var self = this;
  if (self.stopped || self.child || self.launching) return;
  self.launching = true;
  launch(function () {
    self.launching = false;
    self._spawn();
  });
};

Subscription.prototype._spawn = function () {
  var self = this;
  if (self.stopped || self.child) return;

  var args = self.appId ? ['-a', self.appId] : [];
  // Formatted responses span several lines. Subscription responses are parsed
  // as one compact JSON response per line instead.
  args = args.concat(['-i', 'luna://' + self.uri, JSON.stringify(self.payload)]);
  self.buffer = '';
  self.child = spawn(LUNA_SEND, args);

  self.child.stdout.on('data', function (chunk) {
    self._consume(String(chunk));
  });
  self.child.stderr.on('data', function (chunk) {
    if (self.handlers.error) self.handlers.error(String(chunk));
  });
  self.child.on('error', function (err) {
    if (self.handlers.error) self.handlers.error(err);
  });
  self.child.on('close', function (code, signal) {
    self.child = null;
    if (self.stopped) return;
    if (self.handlers.close) self.handlers.close(code, signal);
    self.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self._connect();
    }, self.retryMs);
    self.retryMs = Math.min(self.retryMs * 2, 30000);
  });
};

Subscription.prototype._consume = function (chunk) {
  var lines, i, line, parsed;
  this.buffer += chunk;
  lines = this.buffer.split(/\r?\n/);
  this.buffer = lines.pop();
  for (i = 0; i < lines.length; i++) {
    line = lines[i].replace(/^\s+|\s+$/g, '');
    if (!line) continue;
    try {
      parsed = JSON.parse(line);
      if (this.handlers.message) this.handlers.message(parsed);
    } catch (e) {
      if (this.handlers.error) this.handlers.error(e, line);
    }
  }
};

/*
 * A cache for one-shot reads whose answers do not change between dashboard
 * ticks. Every call is a fork+exec of luna-send, and telemetry made a dozen of
 * them per collection at a 2s tick; node 0.12's spawn path can deadlock under
 * that (see the watchdog note in tvwebctl), so set-and-forget settings are
 * read once per TTL.
 *
 * forget() with no argument drops everything, for a control that has just
 * changed a setting. With a list of substrings it drops only the entries whose
 * key (uri|payload) contains one of them: a live event, such as a volume step,
 * makes the sound reads stale and nothing else. Dropping the lot there had
 * every step - and a held key sends one per repeat - fork the whole set of
 * settings again on the next read.
 */
function createCache(callFn) {
  var entries = {};
  return {
    get: function (uri, payload, ttlMs, cb) {
      var key = uri + '|' + JSON.stringify(payload || {});
      var hit = entries[key];
      // A negative age is a clock that stepped back: treat the entry as stale.
      var age = hit ? Date.now() - hit.t : -1;
      if (hit && age >= 0 && age < ttlMs) return cb(hit.v, hit.raw);
      callFn(uri, payload, function (parsed, raw) {
        // Only a real answer is worth pinning; a failed read should be retried.
        if (parsed) entries[key] = { t: Date.now(), v: parsed, raw: raw };
        cb(parsed, raw);
      });
    },
    forget: function (match) {
      if (!match) { entries = {}; return; }
      for (var key in entries) {
        for (var i = 0; i < match.length; i++) {
          if (key.indexOf(match[i]) !== -1) { delete entries[key]; break; }
        }
      }
    },
    size: function () { return Object.keys(entries).length; }
  };
}

module.exports = {
  call: call,
  Subscription: Subscription,
  createCache: createCache
};
