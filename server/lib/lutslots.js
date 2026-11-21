/*
 * The picture calibration LG stores on a rooted TV, read from its files.
 *
 * A 1D or 3D LUT, a 3x3 gamut matrix or an enable flag written to the picture
 * service is kept in /mnt/lg/cmn_data/external_pqldb/<mode>_<profileN>_<RECORD>.
 * readSlots reports each file's size and checksum, never its contents;
 * readTable returns one table's bytes on request. It is the
 * stored state: a write sent with dataOpt 0 stays in RAM and is not in the
 * files, and the slot follows the picture mode a calibration session was
 * started in, not the mode on screen.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var crypto = require('crypto');

var SLOT_DIR = '/mnt/lg/cmn_data/external_pqldb';
// 3072 little-endian 16-bit values, and 33 x 33 x 33 x 3 of them.
var KINDS = [
  { suffix: '1D_DPG_DATA', kind: '1d-lut', bytes: 6144 },
  { suffix: '3D_LUT_DATA', kind: '3d-lut', bytes: 215622 },
  { suffix: '3BY3_GAMUT_DATA', kind: 'gamut-matrix', bytes: 36 },
  { suffix: '_EN', kind: 'enable-flag', bytes: 2 }
];
var NAME_PATTERN = /^([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)_(profile[0-9]+)_([A-Za-z0-9_]+)$/;

var dir = SLOT_DIR;

function endsWith(text, suffix) {
  return text.length >= suffix.length && text.substr(text.length - suffix.length) === suffix;
}

function classify(name) {
  var m = NAME_PATTERN.exec(name);
  if (!m) return null;
  var record = m[3];
  for (var i = 0; i < KINDS.length; i++) {
    if (endsWith(record, KINDS[i].suffix)) {
      return { mode: m[1], profile: m[2], record: record, kind: KINDS[i].kind, expectedBytes: KINDS[i].bytes };
    }
  }
  return { mode: m[1], profile: m[2], record: record, kind: 'other', expectedBytes: null };
}

function describeFile(name, cb) {
  var info = classify(name);
  if (!info) return cb(null);
  fs.readFile(dir + '/' + name, function (err, data) {
    if (err) return cb(null);
    info.file = name;
    info.bytes = data.length;
    info.sizeMatches = info.expectedBytes === null ? null : data.length === info.expectedBytes;
    info.sha256 = crypto.createHash('sha256').update(data).digest('hex');
    cb(info);
  });
}

/**
 * Calls cb with { available, dir, slots }, slots sorted by file name, or with
 * { available: false } where the folder is missing or unreadable.
 */
function readSlots(cb) {
  fs.readdir(dir, function (err, names) {
    if (err || !names) return cb({ available: false });
    names.sort();
    var slots = [];
    var pending = names.length;
    if (!pending) return cb({ available: true, dir: dir, slots: slots });
    names.forEach(function (name, index) {
      describeFile(name, function (info) {
        if (info) slots[index] = info;
        if (--pending === 0) {
          cb({ available: true, dir: dir, slots: slots.filter(Boolean) });
        }
      });
    });
  });
}

// The one table read a modern LG answers from a file through
// externalpq/getExternalPqData. GET_1D_DPG_DATA is not here: a modern TV
// answers it with the gamma table the picture engine applies, which the stored
// file is not (a dataOpt 0 write never reaches it), so it gets the failure reply.
var TABLES = {
  GET_3D_LUT_DATA: { suffix: '3D_LUT_DATA', bytes: 215622, count: 107811, type: 'unsigned integer16' }
};
var NO_FILE = 'no file path from tvservice';

function tableFailure(text) {
  return { returnValue: false, errorText: text };
}

/**
 * Answers getExternalPqData for one command from the stored slot file:
 * { returnValue, data (base64 little-endian uint16), dataCount, dataType,
 * source: 'stored' }. It is the file, never the live picture state, and a
 * write sent with dataOpt 0 is not in it. Unlike a modern TV it needs picMode
 * (and optionally profileNo and colorSpace) to name the slot; several matching
 * files without a colorSpace fail rather than guess, and file names the one
 * served. Anything else, or a missing or wrongly sized file, gets the failure
 * reply the C1 itself gives.
 */
function readTable(command, picMode, profileNo, colorSpace, cb) {
  var table = TABLES.hasOwnProperty(command) ? TABLES[command] : null;
  if (!table) return cb(tableFailure(NO_FILE));
  var profile = 'profile' + (profileNo === undefined || profileNo === null ? 0 : profileNo);
  var space = colorSpace === undefined || colorSpace === null ? '' : String(colorSpace);
  if (!/^[A-Za-z0-9_]+$/.test(String(picMode || '')) || !/^profile[0-9]+$/.test(profile) ||
      !/^[A-Za-z0-9]*$/.test(space)) {
    return cb(tableFailure(NO_FILE));
  }
  fs.readdir(dir, function (err, names) {
    // The app names a slot by its picMode (hdrFilmMaker); the file prefix is
    // either that name, full snake case (dolby_cinema_dark), or the HDR token
    // plus the mode in camelCase (hdr_filmMaker), so all three are tried.
    var name = String(picMode);
    var snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    var tokenMatch = /^(hdr|dolby)([A-Z].*)$/.exec(name);
    var spellings = [name, snake];
    if (tokenMatch) {
      spellings.push(tokenMatch[1] + '_' + tokenMatch[2].charAt(0).toLowerCase() + tokenMatch[2].slice(1));
    }
    var prefixes = [];
    for (var k = 0; k < spellings.length; k++) {
      var prefix = spellings[k] + '_' + profile + '_';
      if (prefixes.indexOf(prefix) < 0) prefixes.push(prefix);
    }
    var found = [];
    names = (!err && names) ? names.slice().sort() : [];
    for (var i = 0; i < names.length; i++) {
      if (!endsWith(names[i], table.suffix)) continue;
      for (var j = 0; j < prefixes.length; j++) {
        if (names[i].indexOf(prefixes[j]) !== 0) continue;
        var middle = names[i].slice(prefixes[j].length, names[i].length - table.suffix.length);
        // The middle is '' or a colour space such as BT709_.
        if (space ? middle === space + '_' : true) found.push(names[i]);
        break;
      }
    }
    // Several variants (BT709 and BT2020) match: do not guess which cube the
    // caller means.
    if (found.length !== 1) return cb(tableFailure(NO_FILE));
    fs.readFile(dir + '/' + found[0], function (e, data) {
      if (e || data.length !== table.bytes) return cb(tableFailure(NO_FILE));
      cb({ returnValue: true, data: data.toString('base64'), dataCount: table.count, dataType: table.type, source: 'stored', file: found[0] });
    });
  });
}

function init(opts) {
  if (opts && opts.dir) dir = opts.dir;
}

module.exports = { init: init, readSlots: readSlots, readTable: readTable, classify: classify };
