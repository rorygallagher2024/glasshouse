/*
 * lib/remotes.js - the LG remotes Glasshouse knows: what each is called by the
 * TV, which of the Remote tab's keys it has, and its picture
 *
 * The data is remotes.json, kept as plain data so docs/remotes.md is made from
 * it (scripts/gen-remotes-doc.py) and the two cannot drift. Each entry's keys
 * are the ids in remotekeys.js's KEYS with where the fact came from: measured
 * on a TV, documented, or assumed. An entry is `complete` only once its list is
 * every button the remote has; a list that is not complete says what is known
 * and never says a key is absent.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');

// Stands in for a remote with no picture of its own; served as /assets/remotes/<file>.
var GENERIC_IMAGE = 'generic.png';

var cache = null;

function load() {
  if (cache) return cache;
  var list = [];
  try {
    var parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'remotes.json'), 'utf8'));
    if (parsed && Array.isArray(parsed.remotes)) list = parsed.remotes;
  } catch (e) {
    console.error('remotes: could not read remotes.json: ' + e.message);
  }
  cache = list;
  return cache;
}

// Every remote, in the file's order.
function all() {
  return load().slice();
}

// "LGE MR25GA", "lge mr25ga" and "MR25GA" are one name.
function normalizeName(name) {
  return String(name == null ? '' : name).replace(/^\s*LGE\s+/i, '').replace(/\s+/g, '').toUpperCase();
}

// The remote a name the TV reports belongs to, or null.
function find(name) {
  var wanted = normalizeName(name);
  if (!wanted) return null;
  var list = load();
  for (var i = 0; i < list.length; i++) {
    if (normalizeName(list[i].id) === wanted) return list[i];
    for (var n = 0; n < list[i].names.length; n++) {
      if (normalizeName(list[i].names[n]) === wanted) return list[i];
    }
  }
  return null;
}

// The Remote tab key names the remote is known to have.
function keysOf(remote) {
  return remote && remote.keys ? Object.keys(remote.keys) : [];
}

function hasKey(remote, key) {
  // The number keys go with numberKeys rather than ten entries each.
  if (/^num[0-9]$/.test(key)) return !!(remote && remote.numberKeys === true);
  return !!(remote && remote.keys && Object.prototype.hasOwnProperty.call(remote.keys, key));
}

/*
 * The keys, out of keyNames, that none of the selected remotes has, which the
 * Remote tab folds away. Only where that is known: every selected remote has
 * to be in the catalogue (null is a remote that is not) with a list marked
 * complete, and there has to be one. Otherwise nothing is folded, so a remote
 * that is unknown or whose list is not finished never hides a button.
 */
function keysOffRemotes(selected, keyNames) {
  if (!selected || !selected.length) return [];
  for (var i = 0; i < selected.length; i++) {
    if (!selected[i] || selected[i].complete !== true) return [];
  }
  return keyNames.filter(function (key) {
    return !selected.some(function (remote) { return hasKey(remote, key); });
  });
}

/*
 * The name printed on the selected remotes for a Remote tab key, such as AI
 * for the microphone key on the MR25GA, or null. Only where every selected
 * remote that has the key prints the same name; one that has it under its own
 * name, or a remote that is not known, keeps the key's own name.
 */
function labelFor(selected, key) {
  var label = null;
  for (var i = 0; i < (selected || []).length; i++) {
    var remote = selected[i];
    if (!remote) return null;
    if (!hasKey(remote, key)) continue;
    var own = remote.labels && typeof remote.labels[key] === 'string' ? remote.labels[key] : null;
    if (!own || (label !== null && own !== label)) return null;
    label = own;
  }
  return label;
}

// The file name of the remote's picture, under /assets/remotes/.
function imageFile(remote) {
  return remote && remote.image ? remote.image : GENERIC_IMAGE;
}

module.exports = {
  all: all,
  find: find,
  normalizeName: normalizeName,
  keysOf: keysOf,
  hasKey: hasKey,
  keysOffRemotes: keysOffRemotes,
  labelFor: labelFor,
  imageFile: imageFile,
  GENERIC_IMAGE: GENERIC_IMAGE
};
