/*
 * names.js - The names of the raw values the TV reports, each in two forms
 * from the one raw value: display, as the API, the dashboards and Home
 * Assistant show it, and label, as Prometheus labels it.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
var msg = require('./say').msg;

function snakeCase(v) {
  return v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// A label outside the table keeps its own name rather than being dropped.
function mapped(table, v) {
  return table.hasOwnProperty(v) ? table[v] : snakeCase(v);
}

// A value outside the table is shown as the TV gave it.
function named(table, raw) {
  return table.hasOwnProperty(raw) ? table[raw] : { display: raw, label: snakeCase(raw) };
}

// A value no consumer shows yet has only its label.
function labelled(table, raw) {
  return { label: mapped(table, raw) };
}

// The HDMI receiver's names for the chroma format and the HDCP version in use.
var HDMI_CHROMA = {
  R444: { display: 'RGB 4:4:4', label: 'rgb_444' },
  Y444: { display: 'YCbCr 4:4:4', label: 'ycbcr_444' },
  Y422: { display: 'YCbCr 4:2:2', label: 'ycbcr_422' },
  Y420: { display: 'YCbCr 4:2:0', label: 'ycbcr_420' }
};
var HDMI_HDCP = {
  HDCP23: { display: 'HDCP 2.3', label: '2_3' },
  HDCP22: { display: 'HDCP 2.2', label: '2_2' },
  HDCP14: { display: 'HDCP 1.4', label: '1_4' },
  HDCP0: { display: 'None', label: 'none' }
};

/*
 * The receiver's PHY mode, such as "FRL 12G 4L(R6)" or "6G", and the link's
 * rate. FRL runs at its lane rate on every lane, "FRL 12G 4L" being 48 Gbps.
 * TMDS's "3G" and "6G" are ceilings rather than rates: the rate is the
 * character clock, ten bits a character, on the three data channels. A mode
 * named neither way is other, with no rate.
 */
function hdmiPhyMode(raw, tmdsClockKhz) {
  var mode = String(raw || '');
  var frl = mode.match(/^FRL\s+(\d+)G\s+(\d+)L\b/i);
  if (frl) {
    var gbps = parseInt(frl[1], 10) * parseInt(frl[2], 10);
    return { display: 'FRL ' + gbps + ' Gbps', label: 'frl_' + gbps, bitsPerSecond: gbps * 1e9 };
  }
  var tmds = mode.match(/^(?:TMDS\s*)?([36])G$/i);
  if (tmds) {
    var clock = typeof tmdsClockKhz === 'number' && isFinite(tmdsClockKhz) && tmdsClockKhz > 0 ? tmdsClockKhz : null;
    return {
      display: 'TMDS (' + tmds[1] + 'G)',
      label: 'tmds_' + tmds[1] + 'g',
      bitsPerSecond: clock === null ? null : clock * 1000 * 10 * 3
    };
  }
  return { display: mode, label: 'other', bitsPerSecond: null };
}

function hdmiChroma(raw) {
  return named(HDMI_CHROMA, raw);
}

function hdmiHdcp(raw) {
  return named(HDMI_HDCP, raw);
}

/*
 * The picture settings' dynamic range ("dimension"). The settings service
 * accepts these four, each with or without an ALLM suffix, and nothing else:
 * /etc/palm/description.json on a CX (webOS 5) and a C4 (webOS 9) declares the
 * same eight. ALLM is the source asking for Auto Low Latency Mode, the TV's
 * game-style low-latency picture, and is read off separately.
 */
var DYNAMIC_RANGES = {
  sdr: { display: 'SDR', label: 'sdr' },
  hdr: { display: 'HDR', label: 'hdr' },
  dolbyHdr: { display: 'Dolby Vision', label: 'dolby_vision' },
  technicolorHdr: { display: 'Technicolor HDR', label: 'technicolor' }
};

// Anything else is shown readably rather than as one word: hdr10Plus is
// "HDR10 Plus".
function readable(raw) {
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^(sdr|hdr|hlg)/i, function (m) { return m.toUpperCase(); })
    .replace(/^./, function (c) { return c.toUpperCase(); });
}

function dynamicRange(raw) {
  var lowLatency = /ALLM$/.test(raw);
  var range = lowLatency ? raw.slice(0, -4) : raw;
  var name = DYNAMIC_RANGES.hasOwnProperty(range) ? DYNAMIC_RANGES[range] : { display: readable(range), label: snakeCase(range) };
  return {
    display: lowLatency ? name.display + ' \u00b7 Low latency' : name.display,
    label: name.label,
    lowLatency: lowLatency
  };
}

// videooutput's hdrType, snake-cased, renamed where that alone misleads. An
// SDR source reports none, and a C4 (webOS 9) reports player-led
// (low-latency) Dolby Vision as dolby_ll.
var SIGNAL_HDR_TYPES = {
  none: { display: 'SDR', label: 'sdr' },
  hdr10: { display: 'HDR10', label: 'hdr10' },
  hlg: { display: 'HLG', label: 'hlg' },
  dolby_vision: { display: 'Dolby Vision', label: 'dolby_vision' },
  dolby_ll: { display: 'Dolby Vision (low latency)', label: 'dolby_vision_low_latency' }
};

// CTA-861-G's EOTF codes in the HDR static metadata; 4 to 7 are reserved.
var SIGNAL_EOTFS = ['sdr', 'hdr', 'pq', 'hlg'];

// Its colorimetry names: BT.2020 in RGB or YCbCr, one name for either.
var SIGNAL_COLORIMETRY = { BT2020_RGBORYCbCr: 'bt2020_rgb_or_ycbcr' };

// Its pixel encodings, named as the HDMI link's chroma is.
var SIGNAL_ENCODING = { RGB: 'rgb_444', YCbCr444: 'ycbcr_444', YCbCr422: 'ycbcr_422', YCbCr420: 'ycbcr_420' };

// A type outside the table is spelled out from its snake-cased name:
// hdr10_plus is "HDR10 Plus".
function spelledHdrType(type) {
  return type.split('_').map(function (word) {
    return /^(sdr|hdr\d*|hlg)$/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function signalHdrType(raw) {
  var type = snakeCase(raw);
  return SIGNAL_HDR_TYPES.hasOwnProperty(type) ? SIGNAL_HDR_TYPES[type] : { display: spelledHdrType(type), label: type };
}

// A reserved code has no name.
function signalEotf(code) {
  return SIGNAL_EOTFS.hasOwnProperty(code) ? { label: SIGNAL_EOTFS[code] } : null;
}

function signalColorimetry(raw) {
  return labelled(SIGNAL_COLORIMETRY, raw);
}

function signalEncoding(raw) {
  return labelled(SIGNAL_ENCODING, raw);
}

/*
 * Why tvpower says the TV last powered on, labelled by its own name, as its
 * log lines give it. /etc/tvpowerd/tvpowerd.json lists 104 on a C4 (webOS 9.2),
 * many of them named after apps, such as netflix. Only names snake case splits
 * wrongly are here.
 */
var POWER_ON_REASONS = {
  wakeOnWiFi: 'wake_on_wifi'
};

function powerOnReason(raw) {
  return labelled(POWER_ON_REASONS, raw);
}

/*
 * tvpower's power state, lowercased without spaces, dashes or underscores:
 * "Screen Saver" is screensaver. tvpower reports the panel separately from the
 * system: a set can be "Active" with the screen lit, or "ScreenOff"
 * with the system running and the panel blanked, which is what the Screen Off
 * control does.
 */
var POWER_STATES = {
  active: { display: msg('srv.power.on', 'On'), systemOn: true, screenOn: true },
  on: { display: msg('srv.power.on', 'On'), systemOn: true, screenOn: true },
  screenoff: { display: msg('srv.power.screenOff', 'Screen off'), systemOn: true, screenOn: false },
  screensaver: { display: msg('srv.power.screenSaver', 'Screen Saver'), systemOn: true, screenOn: true },
  // LG's Always Ready display: switched off, showing a clock or artwork.
  alwaysready: { display: msg('srv.power.alwaysReady', 'Always Ready'), systemOn: false, screenOn: false },
  activestandby: { display: msg('srv.power.standby', 'Standby'), systemOn: false, screenOn: false },
  standby: { display: msg('srv.power.standby', 'Standby'), systemOn: false, screenOn: false },
  suspend: { display: msg('srv.power.standby', 'Standby'), systemOn: false, screenOn: false },
  preparesuspend: { display: msg('srv.power.standby', 'Standby'), systemOn: false, screenOn: false },
  requestpoweroff: { display: msg('srv.power.off', 'Off'), systemOn: false, screenOn: false },
  poweroff: { display: msg('srv.power.off', 'Off'), systemOn: false, screenOn: false },
  off: { display: msg('srv.power.off', 'Off'), systemOn: false, screenOn: false },
  prepared: { display: msg('srv.power.starting', 'Starting up'), systemOn: true, screenOn: false },
  processing: { display: msg('srv.power.standby', 'Standby'), systemOn: false, screenOn: false }
};

// The inputs the dashboards and Home Assistant switch to, by short app id,
// which is also their label.
var INPUTS = {
  hdmi1: 'HDMI 1',
  hdmi2: 'HDMI 2',
  hdmi3: 'HDMI 3',
  hdmi4: 'HDMI 4',
  livetv: 'Live TV'
};

function input(id) {
  return { display: INPUTS.hasOwnProperty(id) ? INPUTS[id] : id, label: id };
}

var APP_PREFIX = 'com.webos.app.';

/*
 * HDMI inputs go by the port's key, hdmi3, whatever else the TV calls them:
 * HDMI_3 in eim's input list, com.webos.app.hdmi3 as the usual app id. A G5
 * (webOS 10) reported one input under another app id, so the app id is not
 * enough on its own: aliases maps such short ids to their port's key.
 */
function hdmiKey(port) {
  return 'hdmi' + port;
}

// HDMI_3 (eim) or HDMI3 (getVRRInfo) as hdmi3; null for anything not an
// HDMI port.
function hdmiKeyForPortId(portId) {
  var m = /^HDMI_?([1-4])$/i.exec(String(portId || ''));
  return m ? hdmiKey(m[1]) : null;
}

// hdmi3 as 3; null for anything not an HDMI input's key. LG's TVs have up to
// four, the inputs INPUTS names and the input command switches to.
function hdmiPort(key) {
  var m = /^hdmi([1-4])$/.exec(String(key || ''));
  return m ? parseInt(m[1], 10) : null;
}

function isHdmiKey(key) {
  return hdmiPort(key) !== null;
}

// An app id without LG's prefix, or the port's key where aliases name it.
function shortAppId(appId, aliases) {
  var id = String(appId || '');
  if (id.indexOf(APP_PREFIX) === 0) id = id.slice(APP_PREFIX.length);
  return aliases && aliases.hasOwnProperty(id) ? aliases[id] : id;
}

// Whether an app id is one of the TV's inputs rather than an app.
function isInputAppId(id) {
  return /^com\.webos\.app\.(hdmi\d|livetv|av\d|comp\d)/.test(String(id || ''));
}

// The app id LG launches an input under, as the input command does.
function inputAppId(key) {
  return APP_PREFIX + key;
}

/*
 * An input in the foreground, as the TV's settings name it with the short app
 * id after it: "Apple TV (HDMI2)". Without a name of its own it is the id.
 */
function inputTitle(id, name) {
  return name && name !== id ? name + ' (' + id.toUpperCase() + ')' : id;
}

// A state outside the table, or none, is taken as system and screen off.
function powerState(raw) {
  var key = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  return POWER_STATES.hasOwnProperty(key) ? POWER_STATES[key] :
    { display: raw || 'Unknown', systemOn: false, screenOn: false };
}

/*
 * A picture mode is the range's prefix (none, hdr, dolbyHdr) and a base mode;
 * the label is the base, since the range has its own. LG's display names are
 * no use as labels: they differ by webOS version (dolbyHdrCinema is "Cinema"
 * on webOS 5, "FILMMAKER MODE" on webOS 9) and by region. hdrExternal and
 * dolbyHdrDarkAmazon appear only in LG's name tables, named as Standard and
 * Cinema Home. hdrEffect is an SDR mode. A mode named one way only is named
 * the other way as one outside the table.
 */
var PICTURE_MODES = {
  personalized: { display: 'Personalized', label: 'personalized' },
  hdrPersonalized: { display: 'HDR Personalized', label: 'personalized' },
  dolbyHdrPersonalized: { label: 'personalized' },
  vivid: { display: 'Vivid', label: 'vivid' },
  hdrVivid: { display: 'HDR Vivid', label: 'vivid' },
  dolbyHdrVivid: { display: 'Dolby Vision Vivid', label: 'vivid' },
  standard: { display: 'Standard' },
  normal: { display: 'Standard', label: 'standard' },
  hdrStandard: { display: 'HDR Standard', label: 'standard' },
  dolbyHdrStandard: { display: 'Dolby Vision Standard', label: 'standard' },
  hdrExternal: { label: 'standard' },
  eco: { display: 'Eco', label: 'eco' },
  hdrEco: { label: 'eco' },
  cinema: { display: 'Cinema', label: 'cinema' },
  hdrCinema: { display: 'HDR Cinema', label: 'cinema' },
  dolbyHdrCinema: { display: 'Dolby Vision Cinema', label: 'cinema' },
  hdrCinemaBright: { display: 'HDR Cinema Bright', label: 'cinema_bright' },
  dolbyHdrCinemaBright: { display: 'Dolby Vision Cinema Bright', label: 'cinema_bright' },
  dolbyHdrDarkAmazon: { label: 'cinema_bright' },
  hdrCinemaHome: { display: 'HDR Cinema Home' },
  dolbyHdrCinemaHome: { display: 'Dolby Vision Cinema Home' },
  sports: { label: 'sports' },
  game: { display: 'Game', label: 'game' },
  hdrGame: { display: 'HDR Game', label: 'game' },
  dolbyHdrGame: { display: 'Dolby Vision Game', label: 'game' },
  photo: { label: 'photo' },
  filmMaker: { display: 'Filmmaker', label: 'filmmaker' },
  hdrFilmMaker: { display: 'HDR Filmmaker', label: 'filmmaker' },
  dolbyHdrFilmMaker: { display: 'Dolby Vision Filmmaker' },
  expert1: { display: 'ISF Expert (Bright)', label: 'expert_bright' },
  expert2: { display: 'ISF Expert (Dark)', label: 'expert_dark' },
  technicolor: { display: 'Technicolor' },
  technicolorHdr: { display: 'Technicolor HDR' },
  hdrEffect: { display: 'HDR Effect', label: 'hdr_effect' },
  gallery: { display: 'Gallery', label: 'gallery' }
};

/*
 * A mode outside the table is spelled out from its id rather than shown as
 * one word: dolbyHdrCinemaBright reads "Dolby Vision Cinema Bright".
 */
function spelledOut(raw) {
  return raw
    .replace(/^dolbyHdr(?=[A-Z])/, 'Dolby Vision ')
    .replace(/^hdr(?=[A-Z])/, 'HDR ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^[a-z]/, function (c) { return c.toUpperCase(); });
}

function pictureMode(raw) {
  var mode = String(raw);
  var name = PICTURE_MODES.hasOwnProperty(mode) ? PICTURE_MODES[mode] : {};
  return { display: name.display || spelledOut(mode), label: name.label || snakeCase(mode) };
}

// The sound output's keys. Several are the same output and share its name;
// each is snake case already, and is its own label.
var SOUND_OUTPUTS = {
  tv_speaker: 'TV Speaker',
  external_arc: 'HDMI ARC',
  optical: 'Optical',
  external_optical: 'Optical',
  ext_speaker_optical: 'Optical',
  ext_speaker_builtin_lg_optical: 'Optical',
  ext_speaker_arc: 'HDMI ARC',
  headphone: 'Headphone / AUX',
  bt_soundbar: 'Bluetooth',
  tv_external_speaker: 'TV Speaker + Optical',
  tv_speaker_bluetooth: 'TV Speaker + Bluetooth',
  // tv_speaker_bluetooth with the Bluetooth mode on surround, as the volume
  // service reports it (C4, webOS 9.2). After the setting key, so a select
  // offering the name sets the key.
  tv_speaker_bt_surround: 'TV Speaker + Bluetooth',
  tv_speaker_external_arc: 'TV Speaker + HDMI ARC',
  wow_cast: 'LG WOWCAST',
  mobile_phone: 'Mobile Phone',
  wisa_speaker: 'WiSA Speakers',
  external_speaker: 'External Speaker',
  lineout: 'Line Out',
  soundbar: 'LG Sound Sync',
  tv_speaker_headphone: 'TV Speaker + Headphone',
  internal: 'TV Speaker'
};

// An output outside the table is still shown readably: usb_speaker reads as
// "Usb Speaker" rather than as the raw key.
function soundOutput(raw) {
  var output = String(raw);
  return {
    display: SOUND_OUTPUTS.hasOwnProperty(output) ? SOUND_OUTPUTS[output] :
      output.replace(/_/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }),
    label: snakeCase(output)
  };
}

/*
 * The format of the sound being played, as the audio service's
 * tv/getAudioInputProperty names it: a C2 (webOS 9.2) gave pcm for an HDMI
 * source and opus for YouTube, and its audio libraries name the rest.
 */
var AUDIO_CODECS = {
  pcm: 'PCM',
  lpcm: 'PCM',
  aac: 'AAC',
  heaac: 'HE-AAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  ac4: 'Dolby AC-4',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
  dtshd: 'DTS-HD',
  dtsx: 'DTS:X',
  mpeg: 'MPEG audio',
  mpegh: 'MPEG-H',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC'
};

// A codec outside the table is shown as the TV gives it, in capitals.
function audioCodec(raw) {
  var codec = String(raw || '').toLowerCase();
  return {
    display: AUDIO_CODECS.hasOwnProperty(codec) ? AUDIO_CODECS[codec] : codec.toUpperCase(),
    label: snakeCase(codec)
  };
}

/*
 * The same answer's immersive: none, or the object-based format on top of the
 * codec. The libraries spell Atmos atmos, DOLBY_ATMOS and "Dolby Atmos".
 * null for none or nothing.
 */
function audioImmersive(raw) {
  var v = String(raw || '').toLowerCase().replace(/[\s_:-]+/g, '');
  if (!v || v === 'none') return null;
  if (v === 'atmos' || v === 'dolbyatmos') return { display: 'Dolby Atmos', label: 'dolby_atmos' };
  if (v === 'dtsx') return { display: 'DTS:X', label: 'dts_x' };
  if (v === 'mpegh') return { display: 'MPEG-H', label: 'mpeg_h' };
  return { display: String(raw), label: snakeCase(String(raw)) };
}

/*
 * What the settings service accepts for logoLuminanceAdjust, per
 * getSystemSettingValues on a B8, and its names. "strong" is the strongest,
 * not an on/off; the TV's own menu shows it as High.
 */
var LOGO_DIMMING = {
  off: 'Off',
  light: 'Light',
  strong: 'High'
};

// The energy saving steps the picture service accepts, in the TV's own order.
var ENERGY_SAVING_STEPS = ['auto', 'off', 'min', 'med', 'max', 'screen_off'];

/*
 * The panel service's Pixel Refresher status. cancel_schedule is a run queued
 * for the next standby; anything else is Idle.
 */
var REFRESHER_STATUSES = {
  cancel_schedule: 'Scheduled',
  processing: 'Running'
};

function refresherStatus(raw) {
  return REFRESHER_STATUSES.hasOwnProperty(raw) ? REFRESHER_STATUSES[raw] : 'Idle';
}

// The short compensation cycle, which the TV gives only as running or not.
var COMPENSATION_STATUSES = {
  running: { display: 'Running', detail: 'Completing Panel Maintenance (Short Cycle)' },
  idle: { display: 'Idle', detail: 'Idle' }
};

function compensationStatus(running) {
  return COMPENSATION_STATUSES[running ? 'running' : 'idle'];
}

// The JEDEC eMMC PRE_EOL_INFO states; other values are not defined.
var EMMC_EOL_STATES = {
  1: { display: 'Normal', label: 'normal' },
  2: { display: 'Warning', label: 'warning' },
  3: { display: 'Urgent', label: 'urgent' }
};

function emmcEol(code) {
  return EMMC_EOL_STATES.hasOwnProperty(code) ? EMMC_EOL_STATES[code] : null;
}

// The kind of VRR in use, such as gsync, or off without one.
function vrrType(raw) {
  return { label: typeof raw === 'string' && raw ? snakeCase(raw) : 'off' };
}

module.exports = {
  snakeCase: snakeCase,
  mapped: mapped,
  hdmiPhyMode: hdmiPhyMode,
  hdmiChroma: hdmiChroma,
  hdmiHdcp: hdmiHdcp,
  dynamicRange: dynamicRange,
  signalHdrType: signalHdrType,
  signalEotf: signalEotf,
  signalColorimetry: signalColorimetry,
  signalEncoding: signalEncoding,
  powerOnReason: powerOnReason,
  INPUTS: INPUTS,
  hdmiKey: hdmiKey,
  hdmiKeyForPortId: hdmiKeyForPortId,
  hdmiPort: hdmiPort,
  isHdmiKey: isHdmiKey,
  shortAppId: shortAppId,
  inputAppId: inputAppId,
  isInputAppId: isInputAppId,
  input: input,
  inputTitle: inputTitle,
  POWER_STATES: POWER_STATES,
  powerState: powerState,
  PICTURE_MODES: PICTURE_MODES,
  pictureMode: pictureMode,
  SOUND_OUTPUTS: SOUND_OUTPUTS,
  soundOutput: soundOutput,
  audioCodec: audioCodec,
  audioImmersive: audioImmersive,
  LOGO_DIMMING: LOGO_DIMMING,
  ENERGY_SAVING_STEPS: ENERGY_SAVING_STEPS,
  REFRESHER_STATUSES: REFRESHER_STATUSES,
  refresherStatus: refresherStatus,
  COMPENSATION_STATUSES: COMPENSATION_STATUSES,
  compensationStatus: compensationStatus,
  EMMC_EOL_STATES: EMMC_EOL_STATES,
  emmcEol: emmcEol,
  vrrType: vrrType
};
