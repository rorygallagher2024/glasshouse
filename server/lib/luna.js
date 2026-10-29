/*
 * Luna transport for one-shot calls and long-lived subscriptions.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var childProcess = require('child_process');
var execFile = childProcess.execFile;
var spawn = childProcess.spawn;
var children = require('./children');
var monotonicMs = require('./util').monotonicMs;

// Overridable so the start-up test can run the whole server against a stand-in.
var LUNA_SEND = process.env.TVWEB_LUNA_SEND || '/usr/bin/luna-send';

// Services renamed between webOS generations. The codebase uses the newer
// name; on older TVs the first call that gets "Service does not exist"
// switches to the legacy name and retries transparently.
var SERVICE_MAP = [
  { newer: 'com.webos.service.settings/',       legacy: 'com.webos.settingsservice/' },
  { newer: 'com.webos.service.systemservice/',   legacy: 'com.palm.systemservice/' }
];
// Learned on first call: which service name the TV actually uses.
var _serviceName = {};

/*
 * ls-hubd routes only services named in its service files. On webOS 3.9
 * (a 43UJ750V) a call to an unlisted one, such as com.webos.service.audio,
 * gets no answer until luna-send's 2 s wait runs out, and the TV logs
 * LSHUB_NOT_LSTED as an error each time; readings polled every few seconds
 * filled its log (#1112). A failed call to an unlisted LG service makes later
 * calls to it fail at once, for 10 minutes in case the list read was wrong.
 * Homebrew services are left out: they are listed when installed.
 */
var SERVICE_DIRS = (process.env.TVWEB_LUNA_SERVICE_DIRS ||
  '/usr/share/luna-service2/services.d;/usr/share/dbus-1/system-services;' +
  '/mnt/otycabi/usr/share/luna-service2/services.d;/mnt/otncabi/usr/share/luna-service2/services.d').split(';');
// Off a TV, such as a Linux test runner, the D-Bus folder lists other services.
var SERVICE_DIRS_APPLY = !!process.env.TVWEB_LUNA_SERVICE_DIRS || fs.existsSync(LUNA_SEND);
var ABSENT_MS = 10 * 60 * 1000;
var listedServices = null;
var listedCount = 0;
var absentUntil = {};

function readListedServices() {
  listedServices = {};
  SERVICE_DIRS.forEach(function (dir) {
    var files;
    try { files = fs.readdirSync(dir); } catch (e) { return; }
    files.forEach(function (file) {
      if (!/\.service$/.test(file)) return;
      var text;
      try { text = fs.readFileSync(dir + '/' + file, 'utf8'); } catch (e) { return; }
      var name = /^Name=(.*)$/m.exec(text);
      if (!name) return;
      name[1].split(';').forEach(function (service) {
        service = service.trim();
        if (service && !listedServices[service]) {
          listedServices[service] = true;
          listedCount++;
        }
      });
    });
  });
}

function isUnlistedLgService(service) {
  if (!/^com\.(webos|palm|lge)\./.test(service)) return false;
  if (!SERVICE_DIRS_APPLY) return false;
  if (!listedServices) readListedServices();
  return listedCount > 0 && !listedServices[service];
}

function noteFailure(uri, parsed) {
  if (parsed && parsed.returnValue !== false) return;
  var service = uri.split('/')[0];
  if (!isUnlistedLgService(service)) return;
  if (!(service in absentUntil)) console.log('luna: ' + service + ' is not on this TV; calls to it are skipped');
  absentUntil[service] = monotonicMs() + ABSENT_MS;
}

function findServiceMapping(uri) {
  for (var i = 0; i < SERVICE_MAP.length; i++) {
    if (uri.indexOf(SERVICE_MAP[i].newer) === 0) return SERVICE_MAP[i];
  }
  return null;
}

function resolveUri(uri) {
  var serviceMap = findServiceMapping(uri);
  if (!serviceMap) return uri;
  if (_serviceName[serviceMap.newer] === serviceMap.legacy) {
    return serviceMap.legacy + uri.slice(serviceMap.newer.length);
  }
  return uri;
}

function handleServiceResult(uri, parsed) {
  var serviceMap = findServiceMapping(uri);
  if (!serviceMap || _serviceName[serviceMap.newer]) return;
  if (parsed && parsed.returnValue !== false) {
    _serviceName[serviceMap.newer] = serviceMap.newer;
  }
}

function isServiceNotFound(uri, parsed) {
  var serviceMap = findServiceMapping(uri);
  return !!serviceMap &&
    !_serviceName[serviceMap.newer] &&
    parsed && parsed.returnValue === false &&
    typeof parsed.errorText === 'string' &&
    parsed.errorText.indexOf('Service does not exist') !== -1;
}

/*
 * One-shot calls run at most two at a time, the rest in turn. Node 0.12 on a
 * B8 (webOS 4) has frozen in its first second at start: a luna-send child
 * stuck between fork and exec on a lock it inherited held, the server waiting
 * on it, and every later child the same. Start fires off a burst of these
 * calls at once, which is when it happened. Subscriptions start once and stay
 * open, so they are not counted.
 */
var PARALLEL = 2;

/*
 * At the debug log level each call is logged as it starts and ends, and each
 * subscription as it starts, for a TV that restarts itself (#746): the last
 * lines before the cut name what was running. Each line is flushed to disk at
 * once, since a watchdog reset loses what the page cache still holds.
 */
var debugCalls = false;

function setDebug(on) {
  debugCalls = !!on;
}

function noteCall(text) {
  if (!debugCalls) return;
  console.debug('luna: ' + text);
  try { fs.fsyncSync(1); } catch (e) {}
}
var running = 0;
var waiting = [];

/*
 * An urgent call, a remote key press, goes ahead of every normal call waiting
 * and behind urgent ones already there, and may take one slot beyond PARALLEL
 * so two slow reads cannot hold it up. Urgent calls run one at a time: two key
 * presses running together could reach the TV in the wrong order. Urgent calls
 * sit at the front of waiting, so a normal call at the front means none is
 * queued.
 */
var urgentRunning = 0;

function firstNormal() {
  var i = 0;
  while (i < waiting.length && waiting[i].urgent) i++;
  return i;
}

function enqueue(job) {
  waiting.splice(job.urgent ? firstNormal() : waiting.length, 0, job);
}

// A call run again goes first among its kind: it was started before the rest.
function requeue(job) {
  waiting.splice(job.urgent ? 0 : firstNormal(), 0, job);
}

function startWaiting() {
  while (waiting.length) {
    var urgent = waiting[0].urgent;
    if (urgent ? urgentRunning > 0 || running >= PARALLEL + 1 : running >= PARALLEL) break;
    var job = waiting.shift();
    running++;
    if (urgent) urgentRunning++;
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

/*
 * Node's own limit on a child's output is 200 KB up to node 10, and a reply
 * over it comes back as an error with nothing parsed. listApps with -f was
 * 219 KB on an OLED48CXPUB (webOS 5.6, node v8.12.0) with 120 apps.
 */
var MAX_REPLY = 4 * 1024 * 1024;

function run(job) {
  children.launch(function () { runNow(job); }, job.urgent);
}

function runNow(job) {
  var startedAt = monotonicMs();
  var callUri = job.args[job.args.length - 2].replace('luna://', '');
  noteCall('call ' + callUri);
  execFile(LUNA_SEND, job.args, { timeout: 3500, maxBuffer: MAX_REPLY }, function (err, stdout) {
    var endedAt = monotonicMs();
    noteCall('done ' + callUri + ' in ' + Math.round(endedAt - startedAt) + 'ms' +
             (err ? ' (' + (err.killed ? 'timed out' : err.signal || err.code) + ')' : ''));
    running--;
    if (job.urgent) urgentRunning--;
    if (diedEarly(err)) {
      var uri = job.args[job.args.length - 2];
      console.error('luna: ' + uri + ' died (' + err.signal + ') before answering' +
                    (job.retried ? ', giving up' : ', trying once more'));
      if (!job.retried) {
        job.retried = true;
        requeue(job);
        return startWaiting();
      }
    }
    startWaiting();
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }

    // Service fallback: the first call that gets "Service does not exist"
    // switches to the legacy name and retries transparently.
    var rawUri = job.args[job.args.length - 2].replace('luna://', '');
    if (isServiceNotFound(rawUri, parsed) && !job.serviceRetried) {
      var serviceMap = findServiceMapping(rawUri);
      _serviceName[serviceMap.newer] = serviceMap.legacy;
      var oldUri = serviceMap.legacy + rawUri.slice(serviceMap.newer.length);
      job.args[job.args.length - 2] = 'luna://' + oldUri;
      job.serviceRetried = true;
      running++;
      if (job.urgent) urgentRunning++;
      return run(job);
    }
    handleServiceResult(rawUri, parsed);
    noteFailure(rawUri, parsed);

    // When the child that answered started and ended, on the monotonic clock.
    if (job.cb) job.cb(parsed, String(stdout || ''), { startedAt: startedAt, endedAt: endedAt });
  });
}

function queueCall(uri, payload, cb, appId, urgent) {
  uri = resolveUri(uri);
  var service = uri.split('/')[0];
  if (absentUntil[service] > monotonicMs()) {
    var reply = { returnValue: false, errorCode: -1, errorText: 'Service does not exist: ' + service + '.' };
    var now = monotonicMs();
    return process.nextTick(function () {
      if (cb) cb(reply, JSON.stringify(reply), { startedAt: now, endedAt: now });
    });
  }
  var args = appId ? ['-a', appId] : [];
  args = args.concat(['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})]);
  enqueue({ args: args, cb: cb, urgent: urgent });
  startWaiting();
}

function call(uri, payload, cb, appId) {
  queueCall(uri, payload, cb, appId, false);
}

// The same, ahead of the queue: for a remote key press, which someone is waiting on.
function callUrgent(uri, payload, cb, appId) {
  queueCall(uri, payload, cb, appId, true);
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
  children.launch(function () {
    self.launching = false;
    self._spawn();
  });
};

Subscription.prototype._spawn = function () {
  var self = this;
  if (self.stopped || self.child) return;

  var args = self.appId ? ['-a', self.appId] : [];
  // Prefer compact output; some services still send formatted JSON.
  args = args.concat(['-i', 'luna://' + resolveUri(self.uri), JSON.stringify(self.payload)]);
  self.buffer = '';
  noteCall('subscribe ' + resolveUri(self.uri));
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
  var i, start = -1, depth = 0, quoted = false, escaped = false, ch, raw;
  this.buffer += chunk;
  // SurfaceManager on webOS 6.4 formats its own JSON, even without -f.
  // Frame complete objects rather than assuming one response per line.
  for (i = 0; i < this.buffer.length; i++) {
    ch = this.buffer.charAt(i);
    if (start < 0) {
      if (ch !== '{') continue;
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) {
        raw = this.buffer.slice(start, i + 1);
        try {
          var parsed = JSON.parse(raw);
          if (this.handlers.message) this.handlers.message(parsed);
        } catch (e) {
          if (this.handlers.error) this.handlers.error(e, raw);
        }
        this.buffer = this.buffer.slice(i + 1);
        i = -1;
        start = -1;
      }
    }
  }
  if (start < 0) this.buffer = '';
  else this.buffer = this.buffer.slice(start);
  if (this.buffer.length > 1048576) {
    this.buffer = '';
    if (this.handlers.error) this.handlers.error(new Error('Luna subscription response too large'));
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
  setDebug: setDebug,
  call: call,
  callUrgent: callUrgent,
  Subscription: Subscription,
  createCache: createCache
};
