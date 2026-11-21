/*
 * lib/ask.js - a question on the TV's screen, answered with the remote
 *
 * Home Assistant sends a question to <prefix>/command/ask as JSON:
 *
 *   {"id": "cinema", "title": "Cinema mode?", "message": "Dim the lights",
 *    "options": [{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}],
 *    "timeout": 25}
 *
 * The question app (assets/ask-app/), an overlay like the input bar, shows it
 * over the picture with a button for each option. The answer goes back on
 * <prefix>/events/ask, the event entity's topic: event_type "answer" with the
 * option's id in "choice", "dismissed" for Back, "timeout" when left alone,
 * or "replaced" when another question came before it was answered.
 *
 * The page cannot POST to the server (its file:// origin is refused), so it
 * reads the question and hands back the answer with GETs, which routes.js
 * takes only from the TV itself.
 *
 * Strict ES5: runs on node 0.12.
 */
var APP = 'com.tvweb.ask';
var MAX_OPTIONS = 4;
var MAX_TEXT = 200;
var MAX_LABEL = 40;
var DEFAULT_TIMEOUT_S = 30;
var MAX_TIMEOUT_S = 600;
// The server answers "timeout" itself this long after the page should have,
// for a page that never opened or never got its answer back.
var GRACE_MS = 5000;

var lunaFn = null;
var tvAppFn = null;
/** @type {function(Object): void} */
var publishFn = function () {};
var installed = null;   // whether the app is on the TV, once looked at
var pending = null;     // { id, title, message, options, timeout, seq }
var backstop = null;
var seq = 0;

function trimmed(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().substring(0, max);
}

// The question as sent, or null with what was wrong in it.
function parse(raw) {
  var q = raw;
  if (typeof raw === 'string') {
    var text = raw.trim();
    if (text.charAt(0) !== '{') q = { title: text };
    else {
      try { q = JSON.parse(text); } catch (e) { return { error: 'not JSON' }; }
    }
  }
  if (!q || typeof q !== 'object') return { error: 'not an object' };
  var title = trimmed(q.title || q.question, MAX_TEXT);
  var message = trimmed(q.message, MAX_TEXT);
  if (!title && !message) return { error: 'no title or message' };
  var options = [];
  (Array.isArray(q.options) ? q.options : []).forEach(function (o, i) {
    if (options.length >= MAX_OPTIONS) return;
    if (typeof o === 'string') o = { id: o, label: o };
    if (!o || typeof o !== 'object') return;
    var label = trimmed(o.label || o.title || o.id, MAX_LABEL);
    var id = trimmed(o.id || label || ('option' + (i + 1)), MAX_LABEL);
    if (label) options.push({ id: id, label: label });
  });
  if (!options.length) options = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
  var timeout = parseInt(q.timeout, 10);
  if (!(timeout > 0)) timeout = DEFAULT_TIMEOUT_S;
  if (timeout > MAX_TIMEOUT_S) timeout = MAX_TIMEOUT_S;
  var focus = parseInt(q.focus, 10);
  if (!(focus >= 0 && focus < options.length)) focus = 0;
  return {
    question: {
      id: trimmed(q.id, MAX_LABEL) || 'question',
      title: title,
      message: message,
      options: options,
      focus: focus,
      timeout: timeout
    }
  };
}

function finish(eventType, choice) {
  if (!pending) return false;
  var q = pending;
  pending = null;
  clearTimeout(backstop);
  backstop = null;
  var out = { event_type: eventType, id: q.id };
  if (choice) {
    out.choice = choice.id;
    out.label = choice.label;
  }
  publishFn(out);
  return true;
}

function launch(q, cb) {
  lunaFn('com.webos.applicationManager/launch', { id: APP, params: { ask: q.seq } }, function (r) {
    cb(!!(r && r.returnValue), r);
  });
}

// Shows a question; cb({ ok, error }).
function ask(raw, cb) {
  cb = cb || function () {};
  var parsed = parse(raw);
  if (!parsed.question) return cb({ ok: false, error: parsed.error });
  if (!lunaFn) return cb({ ok: false, error: 'not ready' });
  finish('replaced');
  var q = parsed.question;
  q.seq = ++seq;
  pending = q;
  backstop = setTimeout(function () {
    if (pending === q) finish('timeout');
  }, q.timeout * 1000 + GRACE_MS);
  if (backstop.unref) backstop.unref();

  function go() {
    launch(q, function (ok, r) {
      if (ok) return cb({ ok: true });
      console.log('ask: launch refused: ' + ((r && (r.errorText || r.errorCode)) || 'no answer'));
      if (pending === q) finish('failed');
      cb({ ok: false, error: 'the TV would not open the question' });
    });
  }
  if (installed === true || !tvAppFn) return go();
  // Installed the first time it is needed; the install leaves it in place
  // for the next question.
  tvAppFn('status', function (st) {
    if (st && st.installed) { installed = true; return go(); }
    tvAppFn('install', function (r) {
      installed = !!(r && r.ok);
      if (!installed) {
        console.log('ask: app could not be installed');
        if (pending === q) finish('failed');
        return cb({ ok: false, error: 'the question app could not be put on the TV' });
      }
      go();
    });
  });
}

// What the page shows: the question waiting, or null.
function current() {
  if (!pending) return null;
  return {
    seq: pending.seq, id: pending.id, title: pending.title, message: pending.message,
    options: pending.options, focus: pending.focus, timeout: pending.timeout
  };
}

/*
 * From the page: choice is an option's id, or empty with how it ended
 * ('dismissed' or 'timeout'). A seq that is no longer the question waiting
 * is an answer to one already replaced, and is dropped.
 */
function answer(seqNo, choice, how) {
  if (!pending || String(pending.seq) !== String(seqNo)) return false;
  if (choice) {
    var picked = pending.options.filter(function (o) { return o.id === choice; })[0];
    if (!picked) return false;
    return finish('answer', picked);
  }
  return finish(how === 'timeout' ? 'timeout' : 'dismissed');
}

/*
 * opts: luna (call), tvApp(action, cb) the app's install script,
 * publish(event) the answer to MQTT.
 */
function init(opts) {
  opts = opts || {};
  if (opts.luna) lunaFn = opts.luna;
  if (typeof opts.tvApp === 'function') tvAppFn = opts.tvApp;
  if (typeof opts.publish === 'function') publishFn = opts.publish;
}

// The app is reinstalled by a release; it is looked at again before the next question.
function forgetInstalled() {
  installed = null;
}

module.exports = {
  APP: APP,
  EVENT_TYPES: ['answer', 'dismissed', 'timeout', 'replaced', 'failed'],
  init: init,
  parse: parse,
  ask: ask,
  current: current,
  answer: answer,
  forgetInstalled: forgetInstalled
};
