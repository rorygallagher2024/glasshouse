/*
 * names.js - The names of the raw values the TV reports, each in two forms
 * from the one raw value: display, as the API, the dashboards and Home
 * Assistant show it, and label, as Prometheus labels it.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

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
var SIGNAL_HDR_TYPES = { none: 'sdr', dolby_ll: 'dolby_vision_low_latency' };

// CTA-861-G's EOTF codes in the HDR static metadata; 4 to 7 are reserved.
var SIGNAL_EOTFS = ['sdr', 'hdr', 'pq', 'hlg'];

// Its colorimetry names: BT.2020 in RGB or YCbCr, one name for either.
var SIGNAL_COLORIMETRY = { BT2020_RGBORYCbCr: 'bt2020_rgb_or_ycbcr' };

// Its pixel encodings, named as the HDMI link's chroma is.
var SIGNAL_ENCODING = { RGB: 'rgb_444', YCbCr444: 'ycbcr_444', YCbCr422: 'ycbcr_422', YCbCr420: 'ycbcr_420' };

function signalHdrType(raw) {
  return labelled(SIGNAL_HDR_TYPES, snakeCase(raw));
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
  hdrEffect: { display: 'HDR Effect', label: 'hdr_effect' }
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
  PICTURE_MODES: PICTURE_MODES,
  pictureMode: pictureMode
};
