/* Audio declarations and the active return channel.
 * Strict ES5 for the TV's Node 0.10/0.12 runtime. */
var os = require('os');
var child = require('child_process');
var children = require('./children');
var util = require('./util');
var names = require('./names');
var luna = null;
var cached = null;
var receiverMap = null;
var decoderCache = null;
var decoderAt = 0;
var decoderWaiters = null;
var FORMATS = [
  { id: 'pcm', label: 'PCM', sad: 1, aliases: ['PCM', 'LPCM'] },
  { id: 'ac3', label: 'Dolby Digital', sad: 2, aliases: ['AC3'] },
  { id: 'eac3', label: 'Dolby Digital Plus', sad: 10, aliases: ['EAC3'] },
  { id: 'mat', label: 'Dolby TrueHD / MAT', sad: 12, aliases: ['TRUEHD', 'MLP'] },
  { id: 'dts', label: 'DTS', sad: 7, aliases: ['DTS'] },
  { id: 'dtshd', label: 'DTS-HD', sad: 11, aliases: ['DTSH'] },
  { id: 'dtsx', label: 'DTS:X', sad: null, aliases: ['DTSX'] }
];

function sectionValues(text) {
  /** @type {Object.<string, any>} */
  var out = { '': {} };
  var section = '';
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var heading = /^\[([^\]]+)\]$/.exec(line.trim());
    if (heading) { section = heading[1]; out[section] = {}; return; }
    var pair = /^([^=]+)=(.*)$/.exec(line);
    if (pair) out[section][pair[1].trim()] = pair[2].trim();
  });
  return out;
}

// SAD strings can include CTA's audio-block header, or be bare triplets.
function sads(text) {
  if (typeof text !== 'string' || !/^[\da-f\s,:]+$/i.test(text)) return null;
  var hex = text.replace(/[\s,:]/g, '');
  if (!hex.length || hex.length % 2) return null;
  var bytes = [];
  for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  if ((bytes[0] >> 5) === 1 && (bytes[0] & 31) === bytes.length - 1) bytes.shift();
  if (!bytes.length || bytes.length % 3) return null;
  var out = {};
  for (i = 0; i < bytes.length; i += 3) {
    var code = (bytes[i] >> 3) & 15;
    if (!code) return null;
    out[code] = Math.max(out[code] || 0, (bytes[i] & 7) + 1);
  }
  return out;
}

function currentInputPort(reply) {
  var dimension = reply && reply.returnValue !== false && reply.dimension || {};
  var input = /^hdmi([1-9])$/.exec(String(dimension.audioInput || '')) ||
    /^hdmi([1-9])$/.exec(String(dimension.input || ''));
  return input ? Number(input[1]) : null;
}

function edidSads(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 128 || bytes.length % 128 ||
      bytes.some(function (n) { return typeof n !== 'number' || n !== Math.floor(n) || n < 0 || n > 255; }) ||
      bytes.slice(0, 8).join(',') !== '0,255,255,255,255,255,255,0') return null;
  var count = bytes[126] + 1;
  if (bytes.length < count * 128) return null;
  for (var block = 0; block < count; block++) {
    var sum = 0;
    for (var offset = block * 128; offset < (block + 1) * 128; offset++) sum += bytes[offset];
    if (sum % 256) return null;
  }
  var formats = {}, found = false;
  for (var n = 1; n < count; n++) {
    var at = n * 128;
    if (bytes[at] !== 2) continue;
    var end = bytes[at + 2] || 4;
    if (end < 4 || end > 127) return null;
    found = true;
    if (bytes[at + 3] & 64) formats[1] = 2;
    for (var pos = 4; pos < end;) {
      var head = bytes[at + pos++], len = head & 31;
      if (pos + len > end) return null;
      if (head >> 5 === 1) {
        if (!len || len % 3) return null;
        for (var j = pos; j < pos + len; j += 3) {
          var code = (bytes[at + j] >> 3) & 15;
          if (code) formats[code] = Math.max(formats[code] || 0, (bytes[at + j] & 7) + 1);
        }
      }
      pos += len;
    }
  }
  return found ? formats : null;
}

function inputSads(port, map) {
  if (!port || !map || typeof map[port] !== 'number') return null;
  var raw = util.readTrimmed('/proc/lg/hdmi20/port' + map[port] + '/edid');
  if (!raw) return null;
  var bytes = [];
  raw.split(/\r?\n/).forEach(function (line) {
    var row = /^\[0x[\da-f]+\]\s*\|((?:\s*\[0x[\da-f]{2}\]){16})\s*$/i.exec(line);
    if (row) (row[1].match(/\[0x[\da-f]{2}\]/ig) || []).forEach(function (value) { bytes.push(parseInt(value.slice(3, -1), 16)); });
  });
  for (var n = 0; n <= bytes.length - 128; n++) {
    if (bytes.slice(n, n + 8).join(',') === '0,255,255,255,255,255,255,0') return edidSads(bytes.slice(n));
  }
  return null;
}

function nativeInputSads(reply) {
  var data = reply && reply.returnValue === true && reply.edidData;
  return data && data.length === 256 && Array.isArray(data.data) && data.data.length === data.length
    ? edidSads(data.data) : null;
}

function hdmiChannelInfo(port, map) {
  if (!port || !map || typeof map[port] !== 'number') return null;
  var raw = util.readTrimmed('/proc/lg/hdmi20/port' + map[port] + '/status');
  if (!raw || !/^connected:\s*on\s*$/m.test(raw) || !/^timing-invalid:\s*no\b/m.test(raw)) return null;
  var stable = /^stable_cnt:\s*(\d+)/m.exec(raw);
  if (!stable || Number(stable[1]) < 1) return null;
  function field(name, max) {
    var match = new RegExp('^' + name + ':\\s*0x([0-9a-f]+)\\s', 'mi').exec(raw);
    var value = match ? parseInt(match[1], 16) : null;
    return value !== null && value <= max ? value : null;
  }
  // Zero means "refer to stream", not stereo or a known sample rate. An
  // InfoFrame can survive a pause, so this is metadata, not playback proof.
  var count = field('AIF-CC2-0', 7);
  if (!count) return null;
  var rate = field('AIF-SF2-0', 7);
  return { channels: count + 1, channelAllocation: field('AIF-CA7-0', 255),
    sampleRate: [null, 32000, 44100, 48000, 88200, 96000, 176400, 192000][rate || 0] };
}

function formatId(raw) {
  var key = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({ pcm: 'pcm', lpcm: 'pcm', ac3: 'ac3', dolbydigital: 'ac3',
    eac3: 'eac3', ddp: 'eac3', dolbydigitalplus: 'eac3',
    mat: 'mat', truehd: 'mat', dolbytruehd: 'mat', mlp: 'mat',
    dts: 'dts', dtsh: 'dtshd', dtshd: 'dtshd', dtshdma: 'dtshd',
    dtsx: 'dtsx' })[key] || null;
}

function records(value) {
  return Array.isArray(value) ? value.filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); }) : [];
}

function inspectDts(cb) {
  if (decoderAt && Date.now() - decoderAt < 300000) return cb(decoderCache);
  if (decoderWaiters) { decoderWaiters.push(cb); return; }
  if (!util.existsQuiet('/usr/bin/gst-inspect-1.0')) return cb(null);
  decoderWaiters = [cb];
  children.launch(function () {
    child.execFile('/usr/bin/gst-inspect-1.0', ['dts_audiodec'], { timeout: 3000, maxBuffer: 131072 }, function (err, stdout) {
      // A registered DTS-L-only element is not evidence of a DTS-core decoder.
      var sink = /SINK template:[\s\S]*?(?=Element has|SRC template:|Pads:)/.exec(String(stdout || ''));
      decoderCache = err ? null : !!(sink && /audio\/x-dts(?:\s|$)/m.test(sink[0]));
      decoderAt = Date.now();
      var list = decoderWaiters;
      decoderWaiters = null;
      list.forEach(function (next) { next(decoderCache); });
    });
  });
}

/** @returns {Object.<string, any>} */
function build(replies, decoder) {
  var cfg = replies.config && replies.config.returnValue !== false && replies.config.configs || {};
  var info = replies.identity && replies.identity.returnValue !== false && replies.identity || {};
  var sr = replies.settings && replies.settings.returnValue !== false && replies.settings || {};
  var settings = {};
  var categorySettings = sr.settings && typeof sr.settings === 'object' ? sr.settings : {};
  Object.keys(categorySettings).forEach(function (key) { settings[key] = categorySettings[key]; });
  var current = replies.outputSettings && replies.outputSettings.returnValue === true && replies.outputSettings.settings;
  ['soundOutput', 'soundOutputDigital'].forEach(function (key) {
    if (current && typeof current[key] === 'string') settings[key] = current[key];
  });
  var arc = replies.arc && replies.arc.returnValue !== false ? replies.arc : null;
  var edid = replies.edid && replies.edid.returnValue !== false ? replies.edid : null;
  var port = currentInputPort(sr);
  var hawk2 = cfg['tv.model.hdmiSwitchType'] === 'HAWK2';
  var edids = records(edid && edid.edidInfo);
  var chosen = edids.filter(function (x) { return x.inputType === 'hdmi' && x.port === port; })[0];
  // HAWK2's source-facing EDID belongs to the switch, not the lower HDMI20
  // buffer. Its family name also omits DTS even when its native EDID has it.
  var advertised = hawk2 ? nativeInputSads(replies.nativeEdid) :
    inputSads(port, replies.receiverMap) || (chosen ? sads(chosen.SADs) : null);
  var edidType = typeof cfg['tv.model.edidType'] === 'string' ? cfg['tv.model.edidType'] : null;
  var knownType = /^(TrueHD|ac3)(\+dts)?$/.test(edidType || '');
  var receiverFormats = null;
  var receiverComplete = true;
  var details = records(arc && arc.advancedEarcCapability);
  if (arc && Array.isArray(arc.advancedEarcCapability) && details.length !== arc.advancedEarcCapability.length) receiverComplete = false;
  var arcActive = arc ? /^(e?arc)$/i.test(String(arc.arcActivation || '')) : false;
  if (arcActive && details.length) {
    receiverFormats = {};
    details.forEach(function (x) {
      var id = formatId(x.audioCodingType);
      if (id) receiverFormats[id] = x.maxChannelNumber || true;
      else receiverComplete = false;
    });
  } else if (arcActive && arc && Array.isArray(arc.earcCapability) && arc.earcCapability.length) {
    receiverFormats = {};
    arc.earcCapability.forEach(function (x) {
      var id = formatId(x);
      if (id) receiverFormats[id] = true;
      else receiverComplete = false;
    });
  }
  if (receiverFormats && !Object.keys(receiverFormats).length) receiverFormats = null;
  var file = util.readJson('/etc/umediaserver/device_codec_capability_config.json', null);
  var declarations = file && Array.isArray(file.audioCodecs) ? records(file.audioCodecs).filter(function (x) { return typeof x.name === 'string' && x.name.length > 0; }) : null;
  var rows = FORMATS.map(function (f) {
    var tv = advertised && f.sad !== null ? !!advertised[f.sad] : null;
    if (tv === null && !hawk2 && knownType && f.id === 'dts') tv = /\+dts$/.test(edidType);
    if (tv === null && !hawk2 && knownType && f.id === 'mat') tv = /^TrueHD/.test(edidType);
    var declared = declarations ? declarations.filter(function (x) { return f.aliases.indexOf(String(x.name).toUpperCase()) !== -1; }) : [];
    return { id: f.id, name: f.label, advertised: tv,
      receiver: receiverFormats && receiverFormats[f.id] ? true : receiverFormats && receiverComplete ? false : null,
      playback: declarations ? declared.length > 0 : null,
      playbackChannels: declared.length ? declared[0].channels || null : null };
  });
  var sound = sectionValues(util.readTrimmed('/proc/lgtv-driver/audio/sndout'));
  var hdmi = sectionValues(util.readTrimmed('/proc/lgtv-driver/audio/hdmi'))[''];
  var adecs = [0, 1].map(function (n) { return sectionValues(util.readTrimmed('/proc/lgtv-driver/audio/adec.p' + n))['']; });
  var audio = replies.input && replies.input.returnValue !== false && replies.input.audioInputProperty;
  var activeInput = Array.isArray(audio) && audio[0] && audio[0].codec ? audio[0] : null;
  var started = adecs.some(function (a) { return a.Start === '1' && /^HDMI_PORT/.test(a.Connect || ''); });
  var liveInput = activeInput ? { codec: names.audioCodec(activeInput.codec).display,
    immersive: activeInput.immersive ? names.audioImmersive(activeInput.immersive) : null } :
    started && hdmi.AudioData === '1' && Number(hdmi.SamplingRate) > 0 ?
      { codec: names.audioCodec(hdmi.Codec).display, sampleRate: Number(hdmi.SamplingRate) } : null;
  // getARCEDIDInfo.eARC describes EDID policy, not the negotiated link. The
  // G3 returned true there while getARCState and its driver reported ARC.
  var earc = sound.EARC && sound.EARC.EArcOnOff === 'On';
  var link = earc ? 'eARC' : arcActive ? 'ARC' : arc ? 'inactive' : 'unknown';
  var arcPort = edid && Number(edid.arcHDMIPort) || null;
  var devices = records(replies.devices && replies.devices.devices);
  var receiverName = null;
  devices.forEach(function (d) {
    if (Number(d.port) !== arcPort) return;
    records(d.subList).forEach(function (s) {
      if (s.id === 'SIMPLINK' && s.cecpDevType === 5 && s.osdName) receiverName = s.osdName;
    });
  });
  return {
    ok: true, capturedAt: Date.now(),
    identity: { model: info.modelName || cfg['tv.model.modelname'] || null,
      firmware: info.firmwareVersion || null, webos: info.sdkVersion || null, kernel: os.release() },
    tv: { edidType: edidType, input: port, dtsDecoder: decoder, formats: rows,
      playbackDeclarations: declarations ? declarations.map(function (x) { return { name: String(x.name), channels: x.channels || null }; }) : null },
    receiver: { name: receiverName, connected: arc ? arcActive : null, link: link, port: arcPort,
      formatsKnown: receiverFormats !== null },
    settings: settings,
    outputName: settings.soundOutput ? names.soundOutput(settings.soundOutput).display : null,
    live: { input: liveInput, hdmi: hawk2 ? hdmiChannelInfo(port, replies.receiverMap) : null,
      output: liveInput && settings.soundOutput === 'external_arc' && link !== 'inactive' && link !== 'unknown' && sound.ARC && Number(sound.ARC.OutputChannel) > 0 ? sound.ARC.OutputCodec : null }
  };
}

function status(cb, force) {
  /** @type {Object.<string, any>} */
  var replies = {};
  var left = 10;
  var decoder = null;
  function done() {
    if (--left) return;
    var cfg = replies.config && replies.config.returnValue !== false && replies.config.configs || {};
    var port = currentInputPort(replies.settings);
    if (cfg['tv.model.hdmiSwitchType'] === 'HAWK2' && port >= 1 && port <= 4) {
      var params = { inputType: 0, portNumber: port };
      var next = function (reply) { replies.nativeEdid = reply; cb(build(replies, decoder)); };
      if (force) luna('com.webos.service.tv.systemproperty/getEdidData', params, next);
      else cached('com.webos.service.tv.systemproperty/getEdidData', params, 3000, next);
    } else cb(build(replies, decoder));
  }
  function ask(key, uri, params, ttl) {
    var next = function (r) { replies[key] = r; done(); };
    if (force) luna(uri, params, next);
    else cached(uri, params, ttl, next);
  }
  ask('config', 'com.webos.service.config/getConfigs', { configNames: ['tv.model.edidType', 'tv.model.modelname', 'tv.model.hdmiSwitchType'] }, 300000);
  ask('identity', 'com.webos.service.tv.systemproperty/getSystemInfo', { keys: ['modelName', 'firmwareVersion', 'sdkVersion'] }, 300000);
  ask('arc', 'com.webos.service.arccontroller/getARCState', {}, 3000);
  ask('edid', 'com.webos.service.arccontroller/getARCEDIDInfo', {}, 3000);
  ask('devices', 'com.webos.service.eim/getAllInputStatus', {}, 10000);
  // The whole category, as lgsettings asks: webOS 4.4 answers nothing when a
  // named key it lacks, such as eArcSupport, is in the list.
  ask('settings', 'com.webos.service.settings/getSystemSettings', { category: 'sound' }, 3000);
  // G5 33.31.68 returned auto for the whole category while a named query
  // returned the actual Pass Through setting. A failed named query keeps the
  // category values and dimension metadata used by older TVs.
  ask('outputSettings', 'com.webos.service.settings/getSystemSettings',
    { category: 'sound', keys: ['soundOutput', 'soundOutputDigital'] }, 3000);
  ask('input', 'com.webos.service.audio/tv/getAudioInputProperty', {}, 3000);
  inspectDts(function (value) { decoder = value; done(); });
  if (receiverMap) receiverMap(function (map) { replies.receiverMap = map; done(); });
  else done();
}

function init(opts) {
  luna = opts.luna;
  cached = opts.lunaCached;
  receiverMap = opts.hdmiReceiverMap || null;
}

module.exports = { init: init, status: status };
