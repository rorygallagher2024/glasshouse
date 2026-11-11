/*
 * Audio clips played over whatever the TV is showing, from an MQTT message:
 * a doorbell, a spoken alert. The clip goes to PulseAudio's `ptts` device,
 * which plays beside the TV's own audio, and the TV's media audio can be
 * muted for the length of the clip.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * The mute is on one audio connection, ADEC1 to MAIN (the decoder the TV's
 * own playback goes through), not the master volume or the global mute, so
 * the clip itself stays audible and the volume the viewer chose is untouched.
 */
var fs = require('fs');
var spawn = require('child_process').spawn;
var children = require('./children');
var util = require('./util');
var msg = require('./say').msg;

var MUTE_URI = 'com.webos.service.audiooutput/audio/mute';
// Not one of the calls checked on a TV: read through readNativeMute() only.
var STATUS_URI = 'com.webos.service.audiooutput/audio/getStatus';
var SOURCE = 'ADEC1';
var SINK = 'MAIN';

var DEFAULTS = {
  enabled: true,
  // Mute the TV's own audio while a clip plays.
  muteTv: true,
  device: 'ptts',
  paplay: 'paplay',
  clientName: 'glasshouse',
  // A clip arrives whole in one MQTT message and is held in memory.
  maxBytes: 4 * 1024 * 1024,
  // paplay is killed after this, so a clip that never ends cannot hold the TV muted.
  maxSeconds: 60,
  // Clips waiting behind the one playing; a later one is dropped.
  maxQueue: 5,
  tmpDir: '/tmp'
};

// Written while the TV is muted by us, so a restart mid-clip can undo it.
var PENDING_FILE = '/tmp/glasshouse-clip-restore.json';

var lunaFn = null;
var lunaUrgentFn = null;
var config = {};
var settings = DEFAULTS;
var onChange = function () {};
var saveMuteTv = function (value, cb) { cb(null); };
var queue = [];
var playing = false;
var sequence = 0;
var activeChild = null;
var lastResult = null;

function option(name) {
  var v = config[name];
  return v === undefined || v === null ? DEFAULTS[name] : v;
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  lunaUrgentFn = opts.lunaUrgent || lunaFn;
  config = opts.config || {};
  if (opts.onChange) onChange = opts.onChange;
  if (opts.saveMuteTv) saveMuteTv = opts.saveMuteTv;
  if (opts.pendingFile) PENDING_FILE = opts.pendingFile;
  restoreAfterRestart();
}

function enabled() { return option('enabled') !== false; }
function muteTv() { return option('muteTv') !== false; }

function status() {
  return { enabled: enabled(), muteTv: muteTv(), playing: playing, queued: queue.length, last: lastResult };
}

function setMuteTv(on, cb) {
  config.muteTv = !!on;
  saveMuteTv(!!on, function (err) {
    if (err) console.error('audioclip: could not save the setting: ' + err.message);
    onChange();
    if (cb) cb({ ok: !err, error: err ? err.message : undefined });
  });
}

/* ------------------------------------------------------------ native mute */

function setNativeMute(muted, urgent, cb) {
  var call = urgent ? lunaUrgentFn : lunaFn;
  call(MUTE_URI, { source: SOURCE, sink: SINK, mute: muted }, function (reply) {
    // Only a plain refusal is certain: no answer at all may still have applied.
    cb(!(reply && reply.returnValue === false), reply);
  });
}

/*
 * Whether the ADEC1 to MAIN connection is muted now, true, false, or null
 * where the reply holds no answer. Looks for the connection among whatever
 * lists the reply carries, then for a flag of its own. Check the reply on the
 * TV (luna-send -n 1 -f luna://com.webos.service.audiooutput/audio/getStatus
 * '{}') before relying on it.
 */
function parseNativeMute(reply) {
  var found = null;
  function visit(node, depth) {
    if (found !== null || !node || typeof node !== 'object' || depth > 5) return;
    var key;
    if (node.source === SOURCE && node.sink === SINK) {
      if (typeof node.mute === 'boolean') found = node.mute;
      else if (typeof node.muted === 'boolean') found = node.muted;
      return;
    }
    for (key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) visit(node[key], depth + 1);
    }
  }
  visit(reply, 0);
  return found;
}

function readNativeMute(cb) {
  lunaFn(STATUS_URI, {}, function (reply) {
    cb(reply && reply.returnValue !== false ? parseNativeMute(reply) : null);
  });
}

/* ---------------------------------------------------------- restore marker */

function writePending(wasMuted) {
  try { util.writeJsonAtomic(PENDING_FILE, { wasMuted: wasMuted === true }, parseInt('600', 8)); } catch (e) {}
}

function clearPending() {
  util.unlinkQuiet(PENDING_FILE);
}

// The server died or was stopped while it held the TV's audio muted.
function restoreAfterRestart() {
  var pending = util.readJson(PENDING_FILE, null);
  if (!pending) return;
  console.log('audioclip: a clip was cut off by a restart - putting the TV audio back');
  setNativeMute(pending.wasMuted === true, true, function () { clearPending(); });
}

/* ---------------------------------------------------------------- playback */

function sniffExtension(buf) {
  var head = buf.slice(0, 4).toString('binary');
  if (head === 'RIFF') return 'wav';
  if (head === 'OggS') return 'ogg';
  if (head === 'fLaC') return 'flac';
  if (head.slice(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  return 'wav';
}

function playFile(file, done) {
  var finished = false;
  var timer = null;
  function finish(err) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    activeChild = null;
    done(err);
  }
  children.launch(function () {
    var child;
    try {
      child = spawn(String(option('paplay')),
        ['--device=' + option('device'), '--client-name=' + option('clientName'), file],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return finish(e.message);
    }
    activeChild = child;
    var stderr = '';
    child.stderr.on('data', function (chunk) { if (stderr.length < 400) stderr += String(chunk); });
    child.on('error', function (err) { finish(err.code === 'ENOENT' ? 'paplay not found' : err.message); });
    child.on('close', function (code, signal) {
      if (code === 0) return finish(null);
      finish(signal ? 'stopped by ' + signal : (stderr.split('\n')[0].trim() || 'paplay exited ' + code));
    });
    timer = setTimeout(function () {
      try { child.kill('SIGKILL'); } catch (e) {}
      finish('timed out after ' + option('maxSeconds') + 's');
    }, option('maxSeconds') * 1000);
  });
}

/*
 * One mute window for as many queued clips as are waiting: the state is read
 * once, before the first, and put back after the last, so clips following one
 * another do not let the programme's audio through between them.
 */
function runQueue() {
  if (playing || !queue.length) return;
  playing = true;
  onChange();
  var useMute = muteTv();
  var wasMuted = null;
  var weMuted = false;

  function drain() {
    var item = queue.shift();
    if (!item) return restoreThen(function () { playing = false; onChange(); runQueue(); });
    playFile(item.file, function (err) {
      util.unlinkQuiet(item.file);
      lastResult = { ok: !err, error: err || undefined, at: Date.now() };
      if (err) console.error('audioclip: playback failed: ' + err);
      else console.log('audioclip: played');
      drain();
    });
  }

  function restoreThen(next) {
    if (!weMuted) return next();
    // Back to what it was: a TV already muted before the clip stays muted.
    setNativeMute(wasMuted === true, true, function (ok) {
      if (!ok) console.error('audioclip: could not put the TV audio back');
      clearPending();
      next();
    });
  }

  if (!useMute) return drain();
  readNativeMute(function (current) {
    wasMuted = current;
    if (current === true) return drain();     // nothing of the TV's to silence
    writePending(current);
    weMuted = true;
    setNativeMute(true, false, function (ok) {
      if (!ok) {
        // Refused: playing over the programme beats not playing, and nothing
        // was muted, so nothing is put back.
        console.error('audioclip: could not mute the TV audio, playing over it');
        weMuted = false;
        clearPending();
      }
      drain();
    });
  });
}

/*
 * A clip: a Buffer of audio, written out for paplay. Returns an error string,
 * or null once it is queued.
 */
function enqueue(audio) {
  if (!enabled()) return msg('srv.audioclip.off', 'audio clips are switched off');
  if (!audio || !audio.length) return msg('srv.audioclip.empty', 'the clip is empty');
  if (audio.length > option('maxBytes')) return msg('srv.audioclip.big', 'the clip is too large');
  if (queue.length >= option('maxQueue')) return msg('srv.audioclip.busy', 'too many clips waiting');
  var file = option('tmpDir') + '/glasshouse-clip-' + process.pid + '-' + (++sequence) + '.' + sniffExtension(audio);
  try {
    fs.writeFileSync(file, audio, { mode: parseInt('600', 8) });
  } catch (e) {
    return e.message;
  }
  queue.push({ file: file });
  runQueue();
  return null;
}

/*
 * The MQTT payload. Audio bytes go straight in. A URL, or JSON with a url and
 * optionally muteTv for this clip alone, names a clip to fetch.
 * Returns true when the topic was this module's.
 */
function handleMqttCommand(action, text, raw, fetchModule) {
  if (action !== 'play_audio') return false;
  var body = raw || null;
  var first = body && body.length ? String.fromCharCode(body[0]) : '';
  if (first === '{' || first === 'h') {
    var url = String(text || '').trim();
    if (first === '{') {
      try { url = String(JSON.parse(text).url || ''); } catch (e) { url = ''; }
    }
    if (!/^https?:\/\//i.test(url)) {
      console.error('audioclip: expected audio, a URL or {"url": ...}');
      return true;
    }
    var file = option('tmpDir') + '/glasshouse-clip-dl-' + process.pid + '-' + (++sequence);
    fetchModule.download(url, file, {}, function (err) {
      if (err) { console.error('audioclip: download failed: ' + (err.message || err)); return util.unlinkQuiet(file); }
      var data;
      try {
        // Checked before it is read: the download has no limit of its own.
        if (fs.statSync(file).size > option('maxBytes')) throw new Error(msg('srv.audioclip.big', 'the clip is too large'));
        data = fs.readFileSync(file);
      } catch (e) {
        util.unlinkQuiet(file);
        return console.error('audioclip: ' + e.message);
      }
      util.unlinkQuiet(file);
      var problem = enqueue(data);
      if (problem) console.error('audioclip: ' + problem);
    });
    return true;
  }
  var refused = enqueue(body);
  if (refused) console.error('audioclip: ' + refused);
  return true;
}

// For a stop of the server: whatever is playing ends and the TV's audio returns.
function shutdown() {
  queue = [];
  if (activeChild) { try { activeChild.kill('SIGKILL'); } catch (e) {} }
  if (util.existsQuiet(PENDING_FILE)) {
    var pending = util.readJson(PENDING_FILE, null);
    setNativeMute(pending && pending.wasMuted === true, true, function () { clearPending(); });
  }
}

module.exports = {
  init: init,
  status: status,
  enabled: enabled,
  muteTv: muteTv,
  setMuteTv: setMuteTv,
  enqueue: enqueue,
  handleMqttCommand: handleMqttCommand,
  parseNativeMute: parseNativeMute,
  shutdown: shutdown,
  DEFAULTS: DEFAULTS
};
