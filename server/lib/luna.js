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
var busBinding = require('./palmbus');
var path = require('path');

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
 * filled its log (#1112). An unlisted LG service that does not answer, or that
 * the hub says does not exist, makes later calls to it fail at once, for 10
 * minutes in case the list read was wrong. One that answers, even with an
 * error, is there: some TVs leave a service they have out of the list.
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

function hasService(service) {
  if (!SERVICE_DIRS_APPLY) return true;
  if (!listedServices) readListedServices();
  return listedCount === 0 || !!listedServices[service];
}

function isUnlistedLgService(service) {
  if (!/^com\.(webos|palm|lge)\./.test(service)) return false;
  if (!SERVICE_DIRS_APPLY) return false;
  if (!listedServices) readListedServices();
  return listedCount > 0 && !listedServices[service];
}

/*
 * A failure that says the service is not there: no answer at all, or the
 * hub's own refusal. An error from the service itself, such as a B8's
 * com.webos.service.tv.capture answering "Invalid argument" to a capture,
 * shows it is there, though not listed.
 */
var HUB_ABSENT = /Service does not exist|not (?:be )?listed|LSHUB_NOT_LSTED|no such service/i;

function noteFailure(uri, parsed) {
  if (parsed && parsed.returnValue !== false) return;
  if (parsed && !HUB_ABSENT.test(String(parsed.errorText || ''))) return;
  // A renamed service is never skipped: its other name is tried instead.
  if (findServiceMapping(uri)) return;
  var service = uri.split('/')[0];
  if (!isUnlistedLgService(service)) return;
  if (!(service in absentUntil)) console.log('luna: ' + service + ' is not on this TV; calls to it are skipped');
  absentUntil[service] = monotonicMs() + ABSENT_MS;
}

/*
 * A method the service does not have: luna-service answers "Unknown method
 * \"x\" for category \"/y\"". An A1 (webOS 6, #1418) was asked for
 * getAudioInputProperty every few seconds and refused each time. It is answered
 * with that refusal, without a call, for 10 minutes, then asked once more in
 * case its service was still registering its methods.
 */
var missingMethod = {};

function noteMissingMethod(uri, parsed, raw) {
  var text = parsed ? parsed.errorText : raw;
  if (!/Unknown method/i.test(String(text || ''))) return;
  if (!(uri in missingMethod)) console.log('luna: ' + uri + ' is not on this TV; asked again every 10 minutes');
  missingMethod[uri] = { until: monotonicMs() + ABSENT_MS, reply: parsed ? JSON.stringify(parsed) : null, raw: String(raw || '') };
}

/*
 * No answer under the newer name, which the TV does not list, where it lists
 * the legacy one: a 55SJ800V-ZB (webOS 3.9.3) answers nothing for an unlisted
 * service rather than "Service does not exist" (#1137).
 */
function legacyOnlyListed(uri, parsed) {
  var serviceMap = findServiceMapping(uri);
  if (!serviceMap || _serviceName[serviceMap.newer] || parsed) return false;
  if (!isUnlistedLgService(serviceMap.newer.slice(0, -1))) return false;
  return !!(listedServices && listedServices[serviceMap.legacy.slice(0, -1)]);
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
 * open, so they are not counted. Four on a later node, which has not shown
 * it (children.OLD_NODE).
 */
var PARALLEL = children.OLD_NODE ? 2 : 4;

/*
 * At the debug log level each call is logged as it starts and ends, and each
 * subscription as it starts, for a TV that restarts itself (#746): the last
 * lines before the cut name what was running. Each line is flushed to disk at
 * once, since a watchdog reset loses what the page cache still holds.
 */
var debugCalls = false;

/*
 * Every luna-send started, by URI, since the server started: one-shot calls
 * (retries included) and subscription spawns. Glasshouse Home's frame trace
 * logs the change at each beat, to tell which forks a key or a return costs.
 */
var started = { calls: {}, subscriptions: {}, palmbus: {} };
function countStart(kind, uri) { started[kind][uri] = (started[kind][uri] || 0) + 1; }
function stats() {
  var out = { calls: {}, subscriptions: {}, palmbus: {} };
  ['calls', 'subscriptions', 'palmbus'].forEach(function (kind) {
    Object.keys(started[kind]).forEach(function (uri) { out[kind][uri] = started[kind][uri]; });
  });
  return out;
}

// The old limit, for the tests that check the queue's order by it.
function setParallel(n) {
  PARALLEL = n;
}

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

// After the urgent calls and the first ones: where a first call goes.
function firstOrdinary() {
  var i = 0;
  while (i < waiting.length && (waiting[i].urgent || waiting[i].first)) i++;
  return i;
}

function enqueue(job) {
  waiting.splice(job.urgent ? firstNormal() : job.first ? firstOrdinary() : waiting.length, 0, job);
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

// A child that died before reaching luna-send is run again (lib/children).
var diedEarly = children.diedEarly;

/*
 * Node's own limit on a child's output is 200 KB up to node 10, and a reply
 * over it comes back as an error with nothing parsed. listApps with -f was
 * 219 KB on an OLED48CXPUB (webOS 5.6, node v8.12.0) with 120 apps.
 */
var MAX_REPLY = 4 * 1024 * 1024;

/*
 * A satellite tuner's channel list runs to several MB and takes seconds to
 * read. It is asked for without -f, whose indenting made the B8's 146
 * channels 385 KB rather than 226 KB.
 */
var SLOW_CALLS = { 'com.webos.service.apiadapter/tv/getChannelList': true };
var WAIT_MS = 2000;
var SLOW_WAIT_MS = 15000;
var SLOW_MAX_REPLY = 32 * 1024 * 1024;

function run(job) {
  children.launch(function () { runNow(job); }, job.urgent, job.first);
}

function runNow(job) {
  var startedAt = monotonicMs();
  var callUri = job.args[job.args.length - 2].replace('luna://', '');
  noteCall('call ' + callUri);
  countStart('calls', callUri);
  var wait = job.slow ? SLOW_WAIT_MS : WAIT_MS;
  execFile(LUNA_SEND, job.args, { timeout: wait + 1500, maxBuffer: job.slow ? SLOW_MAX_REPLY : MAX_REPLY }, function (err, stdout) {
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
    settle(job, parsed, stdout, startedAt, endedAt, function (again) {
      running++;
      if (again.urgent) urgentRunning++;
      run(again);
    });
  });
}

/*
 * What every answer goes through, whichever way the call went: the legacy
 * service name tried where the newer one is not on the TV, what is absent
 * noted, then the caller. again(job) makes the call once more, the same way.
 */
function settle(job, parsed, stdout, startedAt, endedAt, again) {
  // Service fallback: the first call that gets "Service does not exist"
  // switches to the legacy name and retries transparently.
  var rawUri = job.args[job.args.length - 2].replace('luna://', '');
  if ((isServiceNotFound(rawUri, parsed) || legacyOnlyListed(rawUri, parsed)) && !job.serviceRetried) {
    var serviceMap = findServiceMapping(rawUri);
    _serviceName[serviceMap.newer] = serviceMap.legacy;
    var oldUri = serviceMap.legacy + rawUri.slice(serviceMap.newer.length);
    job.args[job.args.length - 2] = 'luna://' + oldUri;
    job.serviceRetried = true;
    return again(job);
  }
  handleServiceResult(rawUri, parsed);
  noteFailure(rawUri, parsed);
  noteMissingMethod(rawUri, parsed, stdout);

  // When the child that answered started and ended, on the monotonic clock.
  if (job.cb) job.cb(parsed, String(stdout || ''), { startedAt: startedAt, endedAt: endedAt });
}

/*
 * Calls through palmbus (lib/palmbus.js): on by default on the webOS versions
 * it has been tried on (lib/compat), and where the owner switches it on. Not
 * for a call made as another app (-a), which needs luna-send's own identity,
 * nor the slow channel list.
 *
 * Node has no role on the bus of its own, so LG refuses some calls to it that
 * luna-send may make, and leaves others unanswered. Such a method goes
 * through luna-send from then on, and is kept in the state folder
 * (palmbus.json) so the next start does the same:
 *   - refused, in whatever words: the first returnValue false a method gets
 *     on the bus is checked with luna-send once (BUS_REFUSED are known
 *     refusals, needing no check);
 *   - answered differently: the first answer each read method gets on the
 *     bus is compared with luna-send's, by its shape, once;
 *   - unanswered, or unreadable.
 * A refused call to a renamed service (SERVICE_MAP) is tried under its other
 * name first.
 *
 * Only a read is ever made twice. A call the bus leaves unanswered may still
 * have been carried out, so anything else, a key press or a launch, gets no
 * answer, as a luna-send call that times out does, and is not sent again.
 *
 * palmbus is switched off for this TV, until Glasshouse's next version, when
 * five calls in a row get no answer on the bus, or when the server stops
 * without exiting twice in one boot while it is on: LG's binding is native
 * code, and one that crashes or hangs the server on a TV nobody has tried
 * would otherwise do so at every start.
 */
var BUS_REFUSED = /denied|not allowed|permission|was not handled/i;
var READ_METHOD = /^(get|list|is|has|query|read|search|check|find|status|describe|count)/i;
var SILENT_LIMIT = 5;
var UNCLEAN_LIMIT = 2;
var SETTLED_MS = 6 * 60 * 60 * 1000;

var viaPalmbus = false;
var busState = { lunaSend: {}, checked: {} };
var busStateFile = null;
var busSetting = null;
var busTried = false;
var busVersion = '';
var busBoot = '';
var busChecked = {};
var busComparing = {};
var busAlias = {};
var busSilent = 0;
var busCalls = 0;
var settledTimer = null;

function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function saveBusState() {
  if (!busStateFile) return;
  try { fs.writeFileSync(busStateFile, JSON.stringify(busState)); } catch (e) {}
}

function isRead(uri) {
  return READ_METHOD.test(uri.slice(uri.lastIndexOf('/') + 1));
}

// Running with palmbus, for the next start to tell an exit from a crash.
function markRunning() {
  busState.running = { boot: busBoot, version: busVersion };
  saveBusState();
  if (!settledTimer) {
    settledTimer = setTimeout(function () {
      busState.uncleanEnds = 0;
      saveBusState();
    }, SETTLED_MS);
    if (settledTimer.unref) settledTimer.unref();
  }
}

function markStopped() {
  if (!busState.running) return;
  delete busState.running;
  saveBusState();
}

function switchBusOff(reason) {
  viaPalmbus = false;
  busState.off = { reason: reason, version: busVersion };
  delete busState.running;
  saveBusState();
  console.log('luna: palmbus switched off for this TV (' + reason + '); every call goes through luna-send until Glasshouse is updated or it is switched on again');
}

function decideBus() {
  var wanted = busSetting === true || (busSetting === null && busTried);
  var off = busState.off && busState.off.version === busVersion ? busState.off : null;
  viaPalmbus = wanted && !off && busBinding.available();
  if (viaPalmbus) markRunning(); else markStopped();
  return viaPalmbus;
}

var exitHooked = false;

/*
 * opts: setting (true, false, or null for the default), tried (whether this
 * webOS version has been tried, lib/compat), stateDir, version, boot (the
 * kernel's boot id). Returns whether calls go through palmbus.
 */
function configurePalmbus(opts) {
  opts = opts || {};
  busSetting = opts.setting === true || opts.setting === false ? opts.setting : null;
  busTried = !!opts.tried;
  busVersion = String(opts.version || '');
  busBoot = String(opts.boot || '');
  busStateFile = opts.stateDir ? path.join(opts.stateDir, 'palmbus.json') : null;
  busState = { lunaSend: {}, checked: {} };
  busChecked = {};
  busComparing = {};
  compareFailed = {};
  busAlias = {};
  busSilent = 0;
  if (busStateFile) {
    try {
      var kept = JSON.parse(fs.readFileSync(busStateFile, 'utf8'));
      if (kept && typeof kept === 'object') {
        busState.lunaSend = kept.lunaSend && typeof kept.lunaSend === 'object' ? kept.lunaSend : {};
        busState.checked = kept.checked && typeof kept.checked === 'object' ? kept.checked : {};
        busState.uncleanEnds = typeof kept.uncleanEnds === 'number' ? kept.uncleanEnds : 0;
        if (kept.off && kept.off.version === busVersion) busState.off = kept.off;
        // Still marked running in this boot, by this version: it did not exit.
        if (kept.running && kept.running.boot === busBoot && busBoot && kept.running.version === busVersion) {
          busState.uncleanEnds++;
          console.log('luna: the server stopped without exiting while it used palmbus (' + busState.uncleanEnds + ' of ' + UNCLEAN_LIMIT + ')');
        }
        // A new version tries again from the start.
        if (!kept.off || kept.off.version !== busVersion) {
          if (kept.running && kept.running.version !== busVersion) busState.uncleanEnds = 0;
        }
      }
    } catch (e) {}
  }
  if ((busState.uncleanEnds || 0) >= UNCLEAN_LIMIT && !busState.off) {
    switchBusOff('the server stopped without exiting ' + UNCLEAN_LIMIT + ' times while it used palmbus');
    busState.uncleanEnds = 0;
    saveBusState();
  }
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', function (code) { if (code === 0) markStopped(); });
  }
  var on = decideBus();
  if (!on && (busSetting === true || (busSetting === null && busTried)) && !busState.off) {
    console.log('luna: palmbus cannot be used (' + busBinding.unavailableReason() + '); calls stay with luna-send');
  }
  return on;
}

// The owner's switch on the dashboard: true, false, or null for the default.
function setPalmbus(setting) {
  busSetting = setting === true || setting === false ? setting : null;
  // Switched on by hand after it switched itself off: tried again.
  if (busSetting === true && busState.off) {
    delete busState.off;
    busState.uncleanEnds = 0;
    busSilent = 0;
    saveBusState();
  }
  return decideBus();
}

function palmbusStatus() {
  var lunaSend = Object.keys(busState.lunaSend || {});
  return {
    on: viaPalmbus,
    setting: busSetting,
    byDefault: busTried,
    available: busBinding.available(),
    off: busState.off ? busState.off.reason : null,
    calls: busCalls,
    lunaSend: lunaSend.map(function (u) { return { method: u, why: busState.lunaSend[u] }; })
  };
}

// Back compatible with the first form: usePalmbus(on, stateDir).
function usePalmbus(on, stateDir) {
  return configurePalmbus({ setting: !!on, stateDir: stateDir, version: busVersion, boot: busBoot });
}

function busRefused(parsed) {
  return !!(parsed && parsed.returnValue === false && BUS_REFUSED.test(String(parsed.errorText || '')));
}

function sendWithLunaSend(uri, why) {
  if (own(busState.lunaSend, uri)) return;
  busState.lunaSend[uri] = why;
  console.log('luna: ' + uri + ' goes through luna-send (' + why + ')');
  saveBusState();
}

function busFor(job) {
  if (!viaPalmbus || job.appId || job.slow) return false;
  var uri = job.args[job.args.length - 2].replace('luna://', '');
  return !own(busState.lunaSend, uri);
}

/*
 * The other name of a renamed service (SERVICE_MAP), where the TV answers to
 * both: the OLED65B8SLC's settings daemon refused the bus as
 * com.webos.service.settings and answered it as com.webos.settingsservice,
 * the same settings, so its reads need no process. Learned per method.
 */
function otherName(uri) {
  for (var i = 0; i < SERVICE_MAP.length; i++) {
    var m = SERVICE_MAP[i];
    if (uri.indexOf(m.newer) === 0) return m.legacy + uri.slice(m.newer.length);
    if (uri.indexOf(m.legacy) === 0) return m.newer + uri.slice(m.legacy.length);
  }
  return null;
}

// What an answer is made of, two levels down: its keys and the lengths of its lists.
function shape(v, depth) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.length + (depth > 0 && v.length ? ':' + shape(v[0], depth - 1) : '') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).filter(function (k) { return k !== 'subscribed'; }).sort().map(function (k) {
      return depth > 0 ? k + '=' + shape(v[k], depth - 1) : k;
    }).join(',') + '}';
  }
  return typeof v;
}

/*
 * The first answer a read method gets on the bus, checked against luna-send's.
 * Only two answers that both succeeded are compared: on the OLED42C24LA
 * luna-send once failed getSoundOut while the bus answered it, which says
 * nothing about the bus. A method luna-send fails COMPARE_TRIES times is left
 * to the bus, as luna-send cannot answer it any better.
 */
var COMPARE_TRIES = 3;
var compareFailed = {};

function compareOnce(job, uri, busParsed) {
  if (own(busState.checked, uri) || own(busComparing, uri) || !isRead(uri)) return;
  busComparing[uri] = true;
  enqueue({ args: job.args.slice(), urgent: false, first: false, slow: false, appId: null, cb: function (lsParsed) {
    delete busComparing[uri];
    if (!lsParsed || lsParsed.returnValue === false) {
      compareFailed[uri] = (compareFailed[uri] || 0) + 1;
      if (compareFailed[uri] >= COMPARE_TRIES) {
        busState.checked[uri] = true;
        saveBusState();
      }
      return;
    }
    var a = shape(busParsed, 2), b = shape(lsParsed, 2);
    if (a === b) {
      busState.checked[uri] = true;
      return saveBusState();
    }
    sendWithLunaSend(uri, 'answered differently: ' + a.slice(0, 120) + ' against ' + b.slice(0, 120));
  } });
  startWaiting();
}

// Key presses one at a time, in the order made, as through luna-send.
var busUrgentBusy = false;
var busUrgentWaiting = [];

function dispatch(job) {
  if (!busFor(job)) {
    enqueue(job);
    return startWaiting();
  }
  if (job.urgent) {
    if (busUrgentBusy) return busUrgentWaiting.push(job);
    busUrgentBusy = true;
  }
  runBus(job);
}

function busUrgentDone() {
  busUrgentBusy = false;
  var next = busUrgentWaiting.shift();
  if (next) dispatch(next);
}

// The call made through luna-send instead; a key press holds the others until it is answered.
function viaLunaSend(job) {
  if (job.urgent) {
    var answered = job.cb;
    job.cb = function () {
      try { if (answered) answered.apply(null, arguments); } finally { busUrgentDone(); }
    };
  }
  enqueue(job);
  startWaiting();
}

// No answer, as a luna-send call that times out has: for a call that may have been carried out.
function unanswered(job, raw, startedAt, endedAt) {
  if (job.urgent) busUrgentDone();
  if (job.cb) job.cb(null, String(raw || ''), { startedAt: startedAt, endedAt: endedAt });
}

function runBus(job, alias) {
  var uri = job.args[job.args.length - 2].replace('luna://', '');
  var payload = job.args[job.args.length - 1];
  var onBus = alias || (own(busAlias, uri) ? busAlias[uri] : uri);
  var read = isRead(uri);
  var startedAt = monotonicMs();
  noteCall('call ' + onBus + ' (palmbus)');
  countStart('palmbus', onBus);
  busCalls++;
  busBinding.call(onBus, payload, WAIT_MS, function (err, raw) {
    var endedAt = monotonicMs();
    var cutShort = !!(err && /** @type {any} */ (err).retry);
    // Cut short by another call's timeout, so not this method's fault: a read
    // is made again on the new handle, twice at most; anything else may have
    // been carried out, and has no answer.
    if (cutShort) {
      if (read && (job.busRetries || 0) < 2) {
        job.busRetries = (job.busRetries || 0) + 1;
        return runBus(job, alias);
      }
      if (read) return viaLunaSend(job);
      return unanswered(job, '', startedAt, endedAt);
    }
    var parsed = null;
    if (!err) { try { parsed = JSON.parse(raw); } catch (e) {} }
    noteCall('done ' + uri + ' in ' + Math.round(endedAt - startedAt) + 'ms (palmbus' + (err ? ', ' + err.message : '') + ')');
    if (err) {
      sendWithLunaSend(uri, 'no answer through palmbus');
      if (++busSilent >= SILENT_LIMIT) switchBusOff(SILENT_LIMIT + ' calls in a row got no answer through palmbus');
      return read ? viaLunaSend(job) : unanswered(job, '', startedAt, endedAt);
    }
    busSilent = 0;
    if (!parsed) {
      sendWithLunaSend(uri, 'unreadable answer through palmbus');
      return read ? viaLunaSend(job) : unanswered(job, raw, startedAt, endedAt);
    }
    // Refused under one name: the other, where the service has one, before luna-send.
    if (busRefused(parsed) && !alias && onBus === uri) {
      var other = otherName(uri);
      if (other && !own(busState.lunaSend, other)) return runBus(job, other);
    }
    if (busRefused(parsed)) {
      sendWithLunaSend(uri, 'refused: ' + parsed.errorText);
      return viaLunaSend(job);
    }
    if (onBus !== uri && !own(busAlias, uri)) {
      busAlias[uri] = onBus;
      console.log('luna: ' + uri + ' goes through palmbus as ' + onBus);
    }
    // A false the bus gives a method for the first time: luna-send asked too.
    if (parsed.returnValue === false && !own(busChecked, uri)) {
      var busSaid = parsed.errorText || ('error ' + parsed.errorCode);
      var givenCb = job.cb;
      job.cb = function (lsParsed) {
        if (lsParsed && lsParsed.returnValue !== false) sendWithLunaSend(uri, 'refused: ' + busSaid);
        else busChecked[uri] = true;
        if (givenCb) givenCb.apply(null, arguments);
      };
      return viaLunaSend(job);
    }
    if (job.urgent) busUrgentDone();
    if (parsed.returnValue !== false) compareOnce(job, uri, parsed);
    settle(job, parsed, raw, startedAt, endedAt, dispatch);
  });
}

function queueCall(uri, payload, cb, appId, urgent, first) {
  uri = resolveUri(uri);
  var service = uri.split('/')[0];
  if (absentUntil[service] > monotonicMs()) {
    var reply = { returnValue: false, errorCode: -1, errorText: 'Service does not exist: ' + service + '.' };
    var now = monotonicMs();
    return process.nextTick(function () {
      if (cb) cb(reply, JSON.stringify(reply), { startedAt: now, endedAt: now });
    });
  }
  var missing = missingMethod[uri];
  if (missing && missing.until > monotonicMs()) {
    var at = monotonicMs();
    return process.nextTick(function () {
      if (cb) cb(missing.reply ? JSON.parse(missing.reply) : null, missing.raw, { startedAt: at, endedAt: at });
    });
  }
  var args = appId ? ['-a', appId] : [];
  var slow = SLOW_CALLS[uri] === true;
  args = args.concat(['-n', '1', '-w', String(slow ? SLOW_WAIT_MS : WAIT_MS)], slow ? [] : ['-f'],
                     ['luna://' + uri, JSON.stringify(payload || {})]);
  dispatch({ args: args, cb: cb, urgent: urgent, first: !urgent && !!first, slow: slow, appId: appId || null });
}

function call(uri, payload, cb, appId) {
  queueCall(uri, payload, cb, appId, false);
}

// The same, ahead of the queue: for a remote key press, which someone is waiting on.
function callUrgent(uri, payload, cb, appId) {
  queueCall(uri, payload, cb, appId, true);
}

/*
 * The same, ahead of every normal call but behind a key press: for what the
 * start waits on, the TV's model and panel, which Home Assistant's connection
 * waits for. Behind the start's dozens of other calls it came 9 s after the
 * server did on a B8 (webOS 4.4.3).
 */
function callFirst(uri, payload, cb, appId) {
  queueCall(uri, payload, cb, appId, false, true);
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
  countStart('subscriptions', resolveUri(self.uri));
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
  usePalmbus: usePalmbus,
  configurePalmbus: configurePalmbus,
  setPalmbus: setPalmbus,
  palmbusStatus: palmbusStatus,
  setParallel: setParallel,
  hasService: hasService,
  call: call,
  callUrgent: callUrgent,
  callFirst: callFirst,
  Subscription: Subscription,
  stats: stats,
  createCache: createCache
};
