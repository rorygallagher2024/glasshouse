/*
 * Messages the server shows on the dashboards, in English, with a key.
 *
 *   error: msg('srv.saver.switching', 'The TV is still switching screen savers.')
 *   error: msg('srv.update.failed', 'The update failed: {error}', { error: e.message })
 *
 * msg() returns the plain English string, so everything that compares, joins
 * or logs it works as before, and Home Assistant, MQTT and the log stay in
 * English. It also remembers which key and English template the string came
 * from. When a dashboard asks for another language, translate() swaps such
 * strings for the translation in the fields a page shows (DISPLAY_FIELDS),
 * using the same files as the pages: server/assets/i18n/<lang>.json.
 *
 * Only display fields are touched, so a raw value that happens to read the same
 * as a message - a TV state such as "Running" - is never changed.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var fs = require('fs');
var path = require('path');

var DISPLAY_FIELDS = {
  error: 1, note: 1, label: 1, name: 1, detail: 1, desc: 1, description: 1,
  title: 1, badge: 1, message: 1, hint: 1, limitTrackingLabel: 1, limitTrackingDetail: 1,
  // A Home Assistant tile's reading and the line under it (lib/habar.js).
  valueText: 1, subText: 1,
  // Lists of the names above, which a page joins into a sentence.
  sharesWith: 1, agreements: 1, kept: 1, cautions: 1,
  // [id, title, note] rows: only the strings msg() made are changed, never an id.
  consentGroups: 1
};

// Filled English -> { key, en, vars }. A fixed message, such as a screen
// saver's name, is remembered for good: it is made once, at load. One with
// values is bounded, since an error carrying a changing detail makes a new
// entry each time.
var MAX_FILLED = 1000;
var fixed = {};
var filled = {};
var filledCount = 0;

// es, or pt-br where a region's language differs enough to have its own file.
var LANG_CODE = /^[a-z]{2}(-[a-z]{2})?$/;

/*
 * The language files are read when a language is first asked for, not at
 * start: all 13 took 1.2 s to parse and 16 MB on a B8 (node 0.12), on a TV
 * whose dashboards may never ask for any of them. One read is kept.
 */
var dicts = {};              // lang -> { key: { text, from } }, or null where it did not parse
var langFiles = {};          // lang -> its file, for each language there is one for
var langDir = null;
// Strings that bring their own translations instead of being in the language
// files, such as a screen saver's name in its saver.json. Kept apart so that
// reading the files again does not lose them: lang -> { key: { text, from } }.
var given = {};

function fill(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, function (whole, name) {
    return vars[name] === undefined ? whole : String(vars[name]);
  });
}

function msg(key, en, vars) {
  var text = fill(en, vars);
  if (!vars) {
    fixed[text] = { key: key, en: en, vars: null };
    return text;
  }
  if (!Object.prototype.hasOwnProperty.call(filled, text)) {
    if (filledCount >= MAX_FILLED) { filled = {}; filledCount = 0; }
    filledCount++;
  }
  filled[text] = { key: key, en: en, vars: vars };
  return text;
}

// A fixed string with its translations by language, as a screen saver's
// saver.json gives them: { en: 'Clock', es: 'Reloj' }. Returns the English,
// as msg() does. A language Glasshouse has no file for stays in English.
function define(key, en, texts) {
  fixed[en] = { key: key, en: en, vars: null };
  for (var lang in texts) {
    if (!Object.prototype.hasOwnProperty.call(texts, lang)) continue;
    if (lang === 'en' || !LANG_CODE.test(lang) || typeof texts[lang] !== 'string' || !texts[lang]) continue;
    if (!given[lang]) given[lang] = {};
    given[lang][key] = { text: texts[lang], from: en };
    if (dicts[lang]) dicts[lang][key] = given[lang][key];
  }
  return en;
}

// "A, B and C" as a message, so the joining word follows the page's language
// too. The items are left as they are: they may be messages themselves, or
// names the TV gave in its own language.
function list(items) {
  if (items.length < 2) return items[0] || '';
  return msg('srv.list', '{items} and {last}', { items: items.slice(0, -1).join(', '), last: items[items.length - 1] });
}

// The language files beside the pages. Listed here and read on first use; a
// new release restarts the server, which is when they change.
function init(dir) {
  langDir = dir;
  dicts = {};
  langFiles = {};
  var files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return; }
  for (var i = 0; i < files.length; i++) {
    var m = /^(.+)\.json$/.exec(files[i]);
    if (!m || !LANG_CODE.test(m[1])) continue;
    langFiles[m[1]] = path.join(dir, files[i]);
  }
}

// A language's translations, read the first time, or null without a file
// that parses.
function dictFor(lang) {
  if (!lang || !Object.prototype.hasOwnProperty.call(langFiles, lang)) return null;
  if (Object.prototype.hasOwnProperty.call(dicts, lang)) return dicts[lang];
  var dict = null;
  try { dict = JSON.parse(fs.readFileSync(langFiles[lang], 'utf8')); }
  catch (e) { console.error('strings: ' + lang + '.json did not parse: ' + e.message); }
  if (dict && typeof dict === 'object') {
    for (var key in given[lang]) dict[key] = given[lang][key];
  } else {
    dict = null;
  }
  dicts[lang] = dict;
  return dict;
}

// The language a page asked for, if there is a file for it.
function langOf(req) {
  var want = String((req && req.headers && req.headers['x-glasshouse-lang']) || '').toLowerCase();
  return LANG_CODE.test(want) && want !== 'en' && dictFor(want) ? want : null;
}

// The language file for a locale as Qt or LG names it (sv_SE, pt-BR), or
// null without one: for what the TV shows, which follows the TV's language.
function langOfLocale(locale) {
  var parts = String(locale || '').toLowerCase().replace(/_/g, '-').split('-');
  var tries = parts.length > 1 ? [parts[0] + '-' + parts[1], parts[0]] : [parts[0]];
  for (var i = 0; i < tries.length; i++) {
    if (tries[i] !== 'en' && LANG_CODE.test(tries[i]) && dictFor(tries[i])) return tries[i];
  }
  return null;
}

// A released package's files carry a hash of the English, "h", in place of
// "from" (scripts/build-ipk.py, and englishHash in assets/i18n.js).
var hashes = {};
function englishHash(s) {
  if (Object.prototype.hasOwnProperty.call(hashes, s)) return hashes[s];
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (hashes[s] = h.toString(36));
}

function madeFrom(entry, english) {
  if (!entry) return false;
  if (typeof entry.from === 'string') return entry.from === english;
  return typeof entry.h === 'string' && entry.h === englishHash(String(english));
}

function translateText(text, dict) {
  var has = Object.prototype.hasOwnProperty;
  var m = has.call(fixed, text) ? fixed[text] : has.call(filled, text) ? filled[text] : null;
  if (!m) return text;
  var entry = Object.prototype.hasOwnProperty.call(dict, m.key) ? dict[m.key] : null;
  // Made from different English: show the English until it is redone.
  if (!madeFrom(entry, m.en) || typeof entry.text !== 'string' || !entry.text) return text;
  // A value can be a message itself, such as a service's name.
  var vars = null;
  if (m.vars) {
    vars = {};
    for (var k in m.vars) {
      if (has.call(m.vars, k)) vars[k] = typeof m.vars[k] === 'string' ? translateText(m.vars[k], dict) : m.vars[k];
    }
  }
  return fill(entry.text, vars);
}

function walk(v, dict, field) {
  if (typeof v === 'string') return field && DISPLAY_FIELDS[field] ? translateText(v, dict) : v;
  if (Array.isArray(v)) {
    // An array of strings in a display field, such as a list of names.
    for (var i = 0; i < v.length; i++) v[i] = walk(v[i], dict, field);
    return v;
  }
  if (v && typeof v === 'object') {
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) v[k] = walk(v[k], dict, k);
    }
  }
  return v;
}

// A message in the language of a locale, for what goes to the TV without a
// page to translate it, such as a toast. English without a file for it.
function forLocale(text, locale) {
  var lang = langOfLocale(locale);
  return lang ? translateText(text, dictFor(lang)) : text;
}

// A string by its key in the language of a locale, for words a page on the TV
// that loads no translation shows, such as a kind of input. Unlike msg(), the
// English is not marked as a message, so a name the TV gives that reads the
// same, such as an app called Screen Share, is never changed.
function textForLocale(key, en, locale) {
  var lang = langOfLocale(locale);
  var dict = lang ? dictFor(lang) : null;
  var entry = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
  return madeFrom(entry, en) && typeof entry.text === 'string' && entry.text ? entry.text : en;
}

// A JSON body for a response, translated in place where a page asked for a
// language. Anything that is not JSON goes out as it came.
function translateBody(body, lang) {
  var dict = typeof body === 'string' ? dictFor(lang) : null;
  if (!dict) return body;
  var obj;
  try { obj = JSON.parse(body); } catch (e) { return body; }
  return JSON.stringify(walk(obj, dict, null));
}

module.exports = {
  msg: msg,
  define: define,
  list: list,
  init: init,
  langOf: langOf,
  langOfLocale: langOfLocale,
  forLocale: forLocale,
  textForLocale: textForLocale,
  translateBody: translateBody,
  DISPLAY_FIELDS: DISPLAY_FIELDS,
  englishHash: englishHash
};
