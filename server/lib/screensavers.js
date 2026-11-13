/**
 * screensavers.js - Screensaver subsystem for webOS
 *
 * Manages custom QML screensavers, directory staging, appinfo.json patching,
 * runner compatibility between Flutter and QML on newer webOS versions,
 * and bind mounting over /usr/palm/applications/com.webos.app.screensaver.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var samrescan = require('./samrescan');
var say = require('./say');
var msg = say.msg;
var fs = require('fs');
var mkdirp = require('./util').mkdirp;
var readTrimmed = require('./util').readTrimmed;
var unlinkQuiet = require('./util').unlinkQuiet;
var writeJsonAtomic = require('./util').writeJsonAtomic;
var path = require('path');
var execFile = require('child_process').execFile;
var power = require('./power');
var idlesaver = require('./idlesaver');
var names = require('./names');
var saverPowerOff = require('./saverpoweroff');
var qmlcheck = require('./qmlcheck');

var SCREENSAVER_APP_ID = 'com.webos.app.screensaver';
var SCREENSAVER_APP_DIR = '/usr/palm/applications/' + SCREENSAVER_APP_ID;
var SCREENSAVER_DIR = '/var/lib/tvweb/screensaver';
var SCREENSAVER_MARKER = '.tvweb-screensaver';
var SCREENSAVER_LEVEL_MARKER = '.tvweb-brightness';
var SCREENSAVER_ENTITIES_FILE = '/var/lib/tvweb/screensaver-entities.json';
var SCREENSAVER_COLORS_FILE = '/var/lib/tvweb/screensaver-colors.json';
/** @type {typeof import('./haentity') | null} */
var haEntityModule = null;
/*
 * Brightness is a percentage. Glasshouse's own are drawn at two levels, each
 * tuned by hand, their dim one about two thirds as bright as their bright
 * one: 100% is the bright level and TUNED_DIM% the dim one, each as it always
 * was, and a black layer over the nearer level above makes every step between
 * and below. The old Dim and Bright are these two.
 */
var TUNED_DIM = 65;
var MIN_BRIGHTNESS = 5;
// The option picked from a screen saver's choices, staged beside the level.
var SCREENSAVER_CHOICE_MARKER = '.tvweb-choice';
/*
 * Screen savers folded into another's options, by their old id: what a TV that
 * had one in use stored, and what an automation may still send. Clock with date
 * was its own folder until options could be given to a QML screen saver.
 */
var RENAMED = { 'clock-date': { mode: 'clock', choice: 'date', label: 'Clock with date' } };
// Survives a server restart, but not a TV reboot. sam also retains native
// screen savers after dismissal, so its running list alone cannot prove ours.
var LAUNCHED_MARKER = '/var/run/tvweb-screensaver-launched';
// Outside the staged directory, which is bind-mounted over the app and so hides
// the stock manifest whenever one of ours is in use.
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

// Once set while sam restarted for a switch; sam is no longer restarted, so it
// stays clear, and the dashboards' notice for it does not show.
var SWITCH_TIMEOUT_MS = 150000;
// Half-second looks for a screen saver closed before a switch to be gone.
var CLOSE_LOOKS = 16;
// After a switch, before the new one is asked for in place of one closed for it.
var SHOW_AGAIN_MS = 3000;
// How long tvpower may sit at "Screen Saver Ready" before it counts as stuck.
var STUCK_CHECK_MS = 3000;
var SWITCHING_ERROR = msg('srv.saver.switching', 'The TV is still switching screen savers. Try again in a minute.');
var HELD_ERROR = msg('srv.saver.held', 'Custom screen savers are turned off on this TV for now, as they have not been tried on its webOS version. Before 0.98.1, on webOS 10, they could leave the picture, the sound and HDMI control off until the TV was unplugged. One already in use stays until the TV is next fully restarted.');
// The switch is undone rather than sam restarted, the step behind #366.
var LOST_ERROR = msg('srv.saver.lost', 'The TV has lost track of its screen saver app and did not find it again. Restarting the TV brings it back.');
var STUCK_ERROR = msg('srv.saver.stuck', 'The TV is stuck starting a screen saver and refuses to start another until it is restarted. Restart the TV to clear it.');
var NOT_TAKEN_ERROR = msg('srv.saver.notTaken', 'The TV did not take the new screen saver without restarting its app manager, which has left the picture or sound off on some TVs, so LG\'s screen saver is kept.');
var STOCK_LATER_ERROR = msg('srv.saver.stockLater', 'LG\'s screen saver is set, and the TV uses it from its next restart: it did not take the change without restarting its app manager, which has left the picture or sound off on some TVs.');

// LG's own, always first. The others are folders, each with a saver.json.
var STOCK = {
  id: 'stock',
  label: msg('srv.saver.stock', 'LG default'),
  description: msg('srv.saver.stock.desc', 'The screen saver the TV shipped with.'),
  builtin: true
};

var RANDOM = {
  id: 'random',
  label: msg('srv.saver.random', 'Random'),
  description: msg('srv.saver.random.desc', 'Picks a different screen saver each time the screen saver appears.'),
  builtin: true
};

var RANDOM_CONFIG_FILE = '/var/lib/tvweb/screensaver-random.json';
var randomConfigFile = RANDOM_CONFIG_FILE;
var wasInScreenSaver = false;
/*
 * LG's own screen saver ends itself when the Magic Remote's pointer appears,
 * by asking tvpower to turnOnScreen; tvpower ends it on a key by itself, and
 * on a C2 (webOS 9.2.2) on a click, but not on the pointer moving, nor on a
 * click on a C3 (webOS 11.2.0, #1364). So while one of these screen savers
 * shows, the remote's input devices are watched and the pointer ends it.
 */
var BTN_LEFT = 272;
var POINTER_END_GAP_MS = 2000;
/** @type {function(boolean): void} */
var watchPointerFn = function () {};
var lastPointerEnd = 0;

/*
 * Screen savers are folders: one per saver, holding a saver.json, its QML and
 * anything else it uses, all of it staged together. Glasshouse's own are in
 * assets/screensavers; ones added on the TV are in /var/lib/tvweb/screensavers,
 * which an update leaves alone. Both are read the same way. A folder's name is
 * its id, so two in one place cannot clash; an added one's id starts "user-",
 * so it cannot clash with one of Glasshouse's either. The format is described
 * in docs/development/SCREENSAVER-DESIGN.md.
 */
var USER_SAVERS_DIR = '/var/lib/tvweb/screensavers';
var MANIFEST = 'saver.json';
var MANIFEST_FORMAT = 1;
var USER_PREFIX = 'user-';
// The id comes from it, so it has to be safe in a setting, a URL and Home
// Assistant. One named otherwise is listed with the reason.
var FOLDER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
var MAX_SAVER_BYTES = 5 * 1024 * 1024;
var MAX_SAVER_FILES = 200;
// What a saver may ask Glasshouse to fill in, and the placeholder for each.
// "ha" has one placeholder per entity it declares, so it carries no value here.
var USES = { level: '__TVWEB_LEVEL__', stats: '__TVWEB_URL__', choice: '__TVWEB_CHOICE__', ha: '', 'ha-list': '__TVWEB_HA_LIST__', 'ha-all': '__TVWEB_HA_ALL__', color: '__TVWEB_COLOR__' };
var DEFAULT_SAVER_COLOR = 'white';
var COLOR_PRESETS = [
  { id: 'white', label: msg('srv.saver.color.white', 'White'), bright: '#ffffff', dim: '#a8aeb6' },
  { id: 'blue', label: msg('srv.saver.color.blue', 'Blue'), bright: '#7ecaff', dim: '#4a8cb8' },
  { id: 'green', label: msg('srv.saver.color.green', 'Green'), bright: '#8ce99a', dim: '#4e9960' },
  { id: 'amber', label: msg('srv.saver.color.amber', 'Amber'), bright: '#ffd479', dim: '#b88635' },
  { id: 'red', label: msg('srv.saver.color.red', 'Red'), bright: '#ff8a8a', dim: '#b35252' },
  { id: 'purple', label: msg('srv.saver.color.purple', 'Purple'), bright: '#c5a3ff', dim: '#8265b8' }
];
// A choice's value goes into the QML as text: kept to what a name needs.
var CHOICE_VALUE = /^[\w.=&-]{0,100}$/;
var CHOICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
var MAX_CHOICES = 500;
// A screen saver's own reads: a short name it puts in __TVWEB_HA_<name>__, and
// the Home Assistant entity it is given. Both are checked before anything is
// staged, because a placeholder left in a QML file draws as nothing.
var HA_NAME = /^[a-z][a-z0-9_]{0,31}$/;
var HA_ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;
var MAX_HA_ENTITIES = 24;
var MAX_HA_LIST_ENTITIES = 100;
var NEEDS_HA_ERROR = msg('srv.saver.needsHa', 'Configure the Home Assistant API on the HA and MQTT tab first.');
/*
 * Homebrew Channel apps that ship a screen saver as one QML file, which they
 * bind-mount over LG's qml/main.qml themselves: Custom Screensaver, the two
 * Aerial ones and Idlegif. That only works where LG's is QML (up to webOS 9),
 * and choosing anything here takes it off again (#1067). Listed here, one is
 * staged like Glasshouse's own. Each loads what else it needs by its full
 * path into its own folder or state, so only the QML is staged.
 */
var APPS_DIR = '/media/developer/apps/usr/palm/applications';
var APP_PREFIX = 'app-';
var APP_SAVER_FILES = ['assets/screensaver-main.qml', 'assets/screensaver.qml'];
var MAX_APP_QML_BYTES = 512 * 1024;
var DEFAULT_ROOTS = [
  { dir: path.join(__dirname, '..', 'assets', 'screensavers'), builtin: true },
  { dir: USER_SAVERS_DIR, builtin: false },
  { dir: APPS_DIR, builtin: false, apps: true }
];
var saverRoots = DEFAULT_ROOTS;
var catalogCache = null;  // { list: [entries, stock first], byId: {} }
// The entities the screen saver on the TV declared, or null. /api/entity serves
// these and no others, so a saver reads its own readings and nothing else.
var stagedEntities = null;
var stagedEntityLabels = null;
// What qmlcheck found in each QML file, kept while the file is unchanged, as
// the list is read each time the tab asks: path -> { stamp, wrong, src }.
var qmlChecked = {};

// A name or description: a string, or { en: ..., es: ... } with en.
function manifestText(v) {
  if (typeof v === 'string' && v) return { en: v };
  if (v && typeof v === 'object' && typeof v.en === 'string' && v.en) return v;
  return null;
}

// Every file in a folder, below it too, by path relative to it. Links are
// left out, so a folder cannot reach outside itself.
function saverFiles(dir) {
  var out = [];
  (function walk(rel) {
    var entries = fs.readdirSync(path.join(dir, rel));
    for (var i = 0; i < entries.length; i++) {
      var r = rel ? rel + '/' + entries[i] : entries[i];
      var st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push({ rel: r, size: st.size, mtime: st.mtime.getTime() });
    }
  })('');
  return out;
}

// One saver's folder as an entry for the list. Something wrong with it is
// kept as its problem: the saver is listed but cannot be picked.
function readSaver(root, name) {
  var dir = path.join(root.dir, name);
  var id = (root.builtin ? '' : USER_PREFIX) + name;
  var e = { id: id, dir: dir, builtin: root.builtin, label: name, description: '', order: 1e9, uses: [] };
  function problem(text) { e.problem = text; return e; }
  if (!FOLDER_NAME.test(name)) {
    return problem(msg('srv.saver.badFolder', 'Its folder name, "{name}", can only have lowercase letters, digits and -, starting with a letter or digit, up to 32 characters.', { name: name }));
  }
  var m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); }
  catch (err) {
    return problem(msg('srv.saver.badManifest', '{file} could not be read: {error}', { file: MANIFEST, error: err.message }));
  }
  if (!m || typeof m !== 'object') return problem(msg('srv.saver.notObject', '{file} is not a JSON object.', { file: MANIFEST }));
  var name_ = manifestText(m.name), desc = manifestText(m.description);
  if (name_) e.label = say.define('saver.' + id + '.name', name_.en, name_);
  if (desc) e.description = say.define('saver.' + id + '.desc', desc.en, desc);
  e.version = typeof m.version === 'string' ? m.version : '';
  e.author = typeof m.author === 'string' ? m.author : '';
  e.license = typeof m.license === 'string' ? m.license : '';
  e.homepage = typeof m.homepage === 'string' ? m.homepage : '';
  if (typeof m.order === 'number' && root.builtin) e.order = m.order;
  if (m.manifest !== MANIFEST_FORMAT) {
    return problem(msg('srv.saver.format', '{file} is in format {format}, and this Glasshouse reads format {known}.',
                       { file: MANIFEST, format: String(m.manifest), known: String(MANIFEST_FORMAT) }));
  }
  if (!name_ || !desc || !e.version) {
    return problem(msg('srv.saver.missing', '{file} needs a name, a description and a version.', { file: MANIFEST }));
  }
  e.main = m.main === undefined ? 'main.qml' : m.main;
  if (typeof e.main !== 'string' || !/^[\w.-]+\.qml$/.test(e.main)) {
    return problem(msg('srv.saver.badMain', '{file}: main must name a .qml file in the folder.', { file: MANIFEST }));
  }
  var uses = m.uses === undefined ? [] : m.uses;
  if (!Array.isArray(uses)) return problem(msg('srv.saver.badUses', '{file}: uses must be a list.', { file: MANIFEST }));
  for (var i = 0; i < uses.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(USES, uses[i])) {
      return problem(msg('srv.saver.unknownUse', '{file}: uses has "{value}", which Glasshouse does not know.', { file: MANIFEST, value: String(uses[i]) }));
    }
  }
  e.uses = uses;
  // The stats address carries the dashboard's access token.
  if (!root.builtin && uses.indexOf('stats') !== -1) {
    return problem(msg('srv.saver.noStats', 'It asks for the TV\'s readings, which only Glasshouse\'s own screen savers are given.'));
  }
  if (m.choices !== undefined) {
    var choices = readChoices(m.choices, id);
    if (typeof choices === 'string') return problem(choices);
    e.choices = choices;
  }
  if ((uses.indexOf('choice') !== -1) !== !!e.choices) {
    return problem(msg('srv.saver.choiceUses', '{file}: choices and "choice" in uses go together.', { file: MANIFEST }));
  }
  // A saver's own Home Assistant readings. It is given the address of each, and
  // the server serves those addresses and no others while it is showing.
  if (m.entities !== undefined) {
    var ents = readEntities(m.entities);
    if (typeof ents === 'string') return problem(ents);
    e.entities = ents;
  }
  if ((uses.indexOf('ha') !== -1 || uses.indexOf('ha-all') !== -1) !== !!e.entities) {
    return problem(msg('srv.saver.haUses', '{file}: entities and "ha" or "ha-all" in uses go together.', { file: MANIFEST }));
  }
  if (m.entityList !== undefined) {
    var el = readEntityList(m.entityList);
    if (typeof el === 'string') return problem(el);
    e.entityList = el;
  }
  if ((uses.indexOf('ha-list') !== -1) !== !!e.entityList) {
    return problem(msg('srv.saver.haListUses', '{file}: entityList and "ha-list" in uses go together.', { file: MANIFEST }));
  }
  if (Array.isArray(m.panels) && m.panels.length === 1 && (m.panels[0] === 'oled' || m.panels[0] === 'lcd')) e.panels = m.panels[0];
  var need = m.requires && typeof m.requires.webos === 'number' ? m.requires.webos : 0;
  var have = parseInt(String(webosVersion || ''), 10);
  if (need && have && have < need) {
    return problem(msg('srv.saver.needsWebos', 'It needs webOS {need} or later.', { need: String(need) }));
  }
  var files;
  try { files = saverFiles(dir); }
  catch (err2) { return problem(msg('srv.saver.unreadable', 'Its folder could not be read: {error}', { error: err2.message })); }
  var bytes = 0, hasMain = false;
  for (var j = 0; j < files.length; j++) {
    bytes += files[j].size;
    if (files[j].rel === e.main) hasMain = true;
  }
  if (!hasMain) return problem(msg('srv.saver.noMain', '{main} is missing from its folder.', { main: e.main }));
  if (files.length > MAX_SAVER_FILES || bytes > MAX_SAVER_BYTES) {
    return problem(msg('srv.saver.tooBig', 'Its folder is over the limit of {files} files and {mb} MB.',
                       { files: String(MAX_SAVER_FILES), mb: String(MAX_SAVER_BYTES / 1048576) }));
  }
  // A placeholder it did not ask for would be left in, and the QML fail.
  var qml;
  try { qml = fs.readFileSync(path.join(dir, e.main), 'utf8'); }
  catch (err3) { return problem(msg('srv.saver.unreadable', 'Its folder could not be read: {error}', { error: err3.message })); }
  for (var u in USES) {
    if (USES[u] && qml.indexOf(USES[u]) !== -1 && uses.indexOf(u) === -1) {
      return problem(msg('srv.saver.undeclared', '{main} uses {placeholder} without "{use}" in uses.',
                         { main: e.main, placeholder: USES[u], use: u }));
    }
  }
  // Its own reads: __TVWEB_HA_<name>__ for each entity it declares, and none
  // other, since a name it did not declare would be left in and draw nothing.
  var haPlaceholder = /__TVWEB_HA_([a-z0-9_]*)__/g;
  var found;
  while ((found = haPlaceholder.exec(qml)) !== null) {
    if (!e.entities || !Object.prototype.hasOwnProperty.call(e.entities, found[1])) {
      return problem(msg('srv.saver.undeclaredHa', '{main} uses {placeholder}, and saver.json does not name that entity under entities.', { main: e.main, placeholder: found[0] }));
    }
  }
  // A mistake that would leave it black, in any of its QML files. What one
  // added on the TV does past the screen is noted under it, not refused.
  var sources = [];
  for (var k = 0; k < files.length; k++) {
    if (!/\.qml$/i.test(files[k].rel)) continue;
    var full = path.join(dir, files[k].rel);
    var stamp = files[k].size + ':' + files[k].mtime + ':' + (have || 0);
    var seen = qmlChecked[full];
    if (!seen || seen.stamp !== stamp) {
      var src;
      try { src = fs.readFileSync(full, 'utf8'); }
      catch (err4) { return problem(msg('srv.saver.unreadable', 'Its folder could not be read: {error}', { error: err4.message })); }
      seen = qmlChecked[full] = { stamp: stamp, wrong: qmlcheck.problem(src, files[k].rel, have || 0), src: root.builtin ? '' : src };
    }
    if (seen.wrong) return problem(seen.wrong);
    sources.push(seen.src);
  }
  if (!root.builtin) e.cautions = qmlcheck.reaches(sources.join('\n'));
  return e;
}

function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

/*
 * saver.json's choices: { label, default, options: [{ id, name, value, group }] },
 * a list the dashboard offers as a dropdown, under the group's heading where
 * an option has one, the picked option's value put in for __TVWEB_CHOICE__.
 * The options or the reason they cannot be read.
 */
function readChoices(c, saverId) {
  var bad = msg('srv.saver.badChoices', '{file}: choices needs options, each with an id, a name and a short value without spaces or quotes, and a default naming one of them.', { file: MANIFEST });
  if (!c || typeof c !== 'object' || !isArray(c.options) || !c.options.length || c.options.length > MAX_CHOICES) return bad;
  var out = { options: [], def: c['default'] }, seen = {};
  if (c.label !== undefined) {
    var label = manifestText(c.label);
    if (!label) return bad;
    out.label = say.define('saver.' + saverId + '.choices', label.en, label);
  }
  for (var i = 0; i < c.options.length; i++) {
    var o = c.options[i], name = o && manifestText(o.name), group = o && o.group !== undefined ? manifestText(o.group) : null;
    if (!o || typeof o.id !== 'string' || !CHOICE_ID.test(o.id) || !name ||
        typeof o.value !== 'string' || !CHOICE_VALUE.test(o.value) || (o.group !== undefined && !group)) return bad;
    if (seen[o.id]) return bad;
    seen[o.id] = true;
    var opt = { id: o.id, value: o.value, label: say.define('saver.' + saverId + '.choice.' + o.id, name.en, name) };
    if (group) opt.group = say.define('saver.' + saverId + '.group.' + group.en.toLowerCase().replace(/[^a-z0-9]+/g, '-'), group.en, group);
    out.options.push(opt);
  }
  if (!out.options.some(function (x) { return x.id === out.def; })) return bad;
  return out;
}

/*
 * saver.json's entities: { daylight: 'sensor.sun_daylight', ... }, the
 * Home Assistant readings a screen saver draws, each put in for
 * __TVWEB_HA_<name>__ as the address to read it from. The map or the reason it
 * cannot be read.
 */
function readEntities(list) {
  var bad = msg('srv.saver.badEntities', '{file}: entities needs short names, each with a Home Assistant entity id such as sensor.outdoor_temperature, up to {max} of them.', { file: MANIFEST, max: String(MAX_HA_ENTITIES) });
  if (!list || typeof list !== 'object' || isArray(list)) return bad;
  var out = {}, count = 0;
  for (var name in list) {
    if (!Object.prototype.hasOwnProperty.call(list, name)) continue;
    var id = list[name];
    // A blank id is a slot the owner fills in on the Screensaver tab: no
    // default is better than one most Home Assistant installs do not have.
    if (!HA_NAME.test(name) || typeof id !== 'string' || (id !== '' && !HA_ENTITY.test(id))) return bad;
    out[name] = id;
    if (++count > MAX_HA_ENTITIES) return bad;
  }
  return count ? out : bad;
}

function isIntIn(v, lo, hi) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi;
}

/*
 * saver.json's entityList: { min: 2, max: 100 }, for a screen saver that steps
 * through a configured list of Home Assistant entities via __TVWEB_HA_LIST__.
 */
function readEntityList(obj) {
  var bad = msg('srv.saver.badEntityList', '{file}: entityList needs integer min (1 to {max}) and max (min to {max}).', { file: MANIFEST, max: String(MAX_HA_LIST_ENTITIES) });
  if (!obj || typeof obj !== 'object' || isArray(obj)) return bad;
  var min = obj.min === undefined ? 1 : obj.min;
  var max = obj.max === undefined ? MAX_HA_LIST_ENTITIES : obj.max;
  if (!isIntIn(min, 1, MAX_HA_LIST_ENTITIES) || !isIntIn(max, min, MAX_HA_LIST_ENTITIES)) return bad;
  return { min: min, max: max };
}

function readStoredEntities() {
  try {
    if (fs.existsSync(SCREENSAVER_ENTITIES_FILE)) {
      return JSON.parse(fs.readFileSync(SCREENSAVER_ENTITIES_FILE, 'utf8')) || {};
    }
  } catch (e) {}
  return {};
}

function writeStoredEntities(all) {
  try {
    writeJsonAtomic(SCREENSAVER_ENTITIES_FILE, all);
  } catch (e) {
    console.warn('screensaver: could not save entity overrides: ' + e.message);
  }
}

function parseStoredSlot(raw, defEntity) {
  if (raw === undefined || raw === null) return { entity: defEntity, customLabel: '' };
  if (typeof raw === 'string') {
    var ent = (raw === '' || HA_ENTITY.test(raw)) ? raw : defEntity;
    return { entity: ent, customLabel: '' };
  }
  if (typeof raw === 'object') {
    var hasEnt = typeof raw.entity === 'string' && (raw.entity === '' || HA_ENTITY.test(raw.entity));
    var lbl = typeof raw.label === 'string' ? raw.label.trim().slice(0, 64) : '';
    return { entity: hasEnt ? raw.entity : defEntity, customLabel: lbl };
  }
  return { entity: defEntity, customLabel: '' };
}

function effectiveSaverEntitySpecs(e) {
  if (!e || !e.entities) return null;
  var stored = readStoredEntities();
  var overrides = (stored && stored[e.id]) || {};
  var out = {};
  for (var k in e.entities) {
    if (!Object.prototype.hasOwnProperty.call(e.entities, k)) continue;
    out[k] = parseStoredSlot(Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : undefined, e.entities[k]);
  }
  return out;
}

function effectiveSaverEntities(e) {
  return effectiveFromSpecs(effectiveSaverEntitySpecs(e));
}

function effectiveSaverEntityList(e) {
  if (!e || !e.entityList) return null;
  var stored = readStoredEntities();
  var raw = stored && stored[e.id];
  var arr = isArray(raw) ? raw : (raw && isArray(raw.items) ? raw.items : []);
  var out = [];
  for (var i = 0; i < arr.length && out.length < e.entityList.max; i++) {
    var item = arr[i];
    var ent = '', lbl = '';
    if (typeof item === 'string') {
      ent = item.trim();
    } else if (item && typeof item === 'object') {
      ent = typeof item.entity === 'string' ? item.entity.trim() : '';
      lbl = typeof item.label === 'string' ? item.label.trim().slice(0, 64) : '';
    }
    if (!ent || !HA_ENTITY.test(ent)) continue;
    out.push({ entity: ent, customLabel: lbl });
  }
  return out;
}

function saverUsesHa(e) {
  return !!(e && e.uses && (e.uses.indexOf('ha') !== -1 || e.uses.indexOf('ha-list') !== -1 || e.uses.indexOf('ha-all') !== -1));
}

function saverMissingHa(e) {
  return !!(haEntityModule && saverUsesHa(e) && !haEntityModule.configured());
}

function saverMinEntitiesError(e) {
  if (!e || !e.entityList) return '';
  var list = effectiveSaverEntityList(e) || [];
  if (list.length < e.entityList.min) {
    return msg('srv.saver.tooFewEntities',
      'Add at least {min} Home Assistant entities to "{saver}" before starting it (OLED burn-in protection).',
      { min: String(e.entityList.min), saver: e.label });
  }
  return '';
}

function setSaverEntities(saverId, newEntities, cb) {
  cb = cb || function () {};
  var saver = saverById(saverId);
  if (!saver) return cb({ ok: false, error: 'unknown screen saver: ' + saverId });
  if (!saver.entities && !saver.entityList) return cb({ ok: false, error: saverId + ' does not declare entities' });
  if (!newEntities || typeof newEntities !== 'object') return cb({ ok: false, error: 'entities must be an object' });

  if (saver.entityList) {
    var listIn = isArray(newEntities) ? newEntities : (isArray(newEntities.items) ? newEntities.items : null);
    if (!listIn) return cb({ ok: false, error: saverId + ' expects an entity list' });
    if (listIn.length > saver.entityList.max) {
      return cb({ ok: false, error: 'up to ' + saver.entityList.max + ' Home Assistant entities allowed' });
    }
    var nextList = [];
    for (var li = 0; li < listIn.length; li++) {
      var rawItem = listIn[li];
      var iEnt = '', iLbl = '';
      if (typeof rawItem === 'string') {
        iEnt = rawItem.trim();
      } else if (rawItem && typeof rawItem === 'object') {
        iEnt = String(rawItem.entity || '').trim();
        if (rawItem.label !== undefined) iLbl = String(rawItem.label || '').trim().slice(0, 64);
      } else {
        return cb({ ok: false, error: 'each entity entry must be a string or object' });
      }
      if (!iEnt || !HA_ENTITY.test(iEnt)) {
        return cb({ ok: false, error: 'not a valid Home Assistant entity id: ' + iEnt });
      }
      nextList.push(iLbl ? { entity: iEnt, label: iLbl } : iEnt);
    }
    var storedList = readStoredEntities();
    if (nextList.length) storedList[saverId] = nextList;
    else delete storedList[saverId];
    writeStoredEntities(storedList);
    if (stagedScreensaver() === saverId) {
      restageScreensaver();
      restartScreensaverApp(function () {});
    }
    return cb({ ok: true });
  }

  var stored = readStoredEntities();
  stored[saverId] = stored[saverId] || {};

  // A slot the screen saver declares, whatever its default: Ambient's are blank,
  // for the owner to fill in (#1446). One it does not declare is refused, rather
  // than answered as saved.
  for (var named in newEntities) {
    if (Object.prototype.hasOwnProperty.call(newEntities, named) && !Object.prototype.hasOwnProperty.call(saver.entities, named)) {
      return cb({ ok: false, error: saverId + ' has no entity slot named ' + named });
    }
  }

  for (var k in newEntities) {
    if (!Object.prototype.hasOwnProperty.call(newEntities, k)) continue;
    var val = newEntities[k];
    if (val === null) {
      delete stored[saverId][k];
      continue;
    }
    var def = saver.entities[k];
    var cur = parseStoredSlot(stored[saverId][k], def);
    var nextEnt = cur.entity;
    var nextLbl = cur.customLabel;
    var entExplicit = Object.prototype.hasOwnProperty.call(stored[saverId], k) && (
      typeof stored[saverId][k] === 'string' ||
      (stored[saverId][k] && typeof stored[saverId][k] === 'object' && stored[saverId][k].entity !== undefined)
    );

    if (typeof val === 'string') {
      var trimmed = val.trim();
      if (trimmed !== '' && !HA_ENTITY.test(trimmed)) {
        return cb({ ok: false, error: 'not a valid Home Assistant entity id: ' + trimmed });
      }
      nextEnt = trimmed;
      entExplicit = true;
      if (trimmed === '') nextLbl = '';
    } else if (val && typeof val === 'object') {
      if (val.entity !== undefined) {
        if (val.entity === null) {
          nextEnt = def;
          entExplicit = false;
        } else {
          var oe = String(val.entity || '').trim();
          if (oe !== '' && !HA_ENTITY.test(oe)) {
            return cb({ ok: false, error: 'not a valid Home Assistant entity id: ' + oe });
          }
          nextEnt = oe;
          entExplicit = true;
          if (oe === '') nextLbl = '';
        }
      }
      if (val.label !== undefined) {
        nextLbl = String(val.label || '').trim().slice(0, 64);
      }
    } else {
      continue;
    }

    if (!entExplicit && !nextLbl) {
      delete stored[saverId][k];
    } else if (!nextLbl) {
      stored[saverId][k] = nextEnt;
    } else {
      var rec = { label: nextLbl };
      if (entExplicit) rec.entity = nextEnt;
      stored[saverId][k] = rec;
    }
  }
  if (Object.keys(stored[saverId]).length === 0) delete stored[saverId];
  writeStoredEntities(stored);

  if (stagedScreensaver() === saverId) {
    restageScreensaver();
    restartScreensaverApp(function () {});
  }
  cb({ ok: true });
}

// An installed app's screen saver as an entry, or null where the app has none.
function readAppSaver(root, appId) {
  var dir = path.join(root.dir, appId);
  var main = null;
  for (var i = 0; i < APP_SAVER_FILES.length && !main; i++) {
    try { if (fs.lstatSync(path.join(dir, APP_SAVER_FILES[i])).isFile()) main = APP_SAVER_FILES[i]; } catch (e) {}
  }
  if (!main) return null;
  var info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'appinfo.json'), 'utf8')) || {}; } catch (e2) {}
  var title = typeof info.title === 'string' && info.title ? info.title : appId;
  var e = { id: APP_PREFIX + appId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48),
            dir: dir, main: main, builtin: false, fromApp: appId, appTitle: title, label: title, order: 1e9, uses: [],
            description: msg('srv.saver.fromApp', 'The screen saver from the {app} app. Any settings it has are in that app.', { app: title }),
            version: typeof info.version === 'string' ? info.version : '',
            author: typeof info.vendor === 'string' ? info.vendor : '', license: '' };
  var have = parseInt(String(webosVersion || ''), 10);
  var full = path.join(dir, main), st, src;
  try {
    st = fs.statSync(full);
    if (st.size > MAX_APP_QML_BYTES) {
      e.problem = msg('srv.saver.appTooBig', 'Its screen saver file is over {kb} KB.', { kb: String(MAX_APP_QML_BYTES / 1024) });
      return e;
    }
    var stamp = st.size + ':' + st.mtime.getTime() + ':' + (have || 0);
    var seen = qmlChecked[full];
    if (!seen || seen.stamp !== stamp) {
      src = fs.readFileSync(full, 'utf8');
      seen = qmlChecked[full] = { stamp: stamp, wrong: qmlcheck.problem(src, path.basename(main), have || 0), src: src };
    }
    if (seen.wrong) e.problem = seen.wrong;
    else e.cautions = qmlcheck.reaches(seen.src);
  } catch (err) {
    e.problem = msg('srv.saver.unreadable', 'Its folder could not be read: {error}', { error: err.message });
  }
  return e;
}

// Every screen saver, read from the folders again: LG's first, then
// Glasshouse's in their order, then the TV's own by name, then the apps'.
function scanSavers() {
  var list = [], byId = { stock: STOCK };
  for (var r = 0; r < saverRoots.length; r++) {
    var entries;
    try { entries = fs.readdirSync(saverRoots[r].dir); } catch (e) { continue; }
    entries.sort();
    var found = [];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].charAt(0) === '.') continue;   // hidden
      // An update adds files but removes none, so one folded into another's
      // options is still there after it.
      if (saverRoots[r].builtin && RENAMED[entries[i]]) continue;
      try { if (!fs.statSync(path.join(saverRoots[r].dir, entries[i])).isDirectory()) continue; }
      catch (e2) { continue; }
      var entry = saverRoots[r].apps ? readAppSaver(saverRoots[r], entries[i]) : readSaver(saverRoots[r], entries[i]);
      if (!entry || byId[entry.id]) continue;
      byId[entry.id] = entry;
      found.push(entry);
    }
    // Two apps of the same name, as both Aerial ones are, are told apart by who made each.
    if (saverRoots[r].apps) {
      found.forEach(function (e) {
        var same = found.filter(function (o) { return o.appTitle === e.appTitle; }).length > 1;
        if (same) e.label = e.appTitle + ' (' + (e.author || e.fromApp) + ')';
      });
    }
    found.sort(function (a, b) {
      return a.order - b.order || (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0);
    });
    list = list.concat(found);
  }
  catalogCache = { list: [STOCK].concat(list), byId: byId };
  return catalogCache;
}

function savers() { return catalogCache || scanSavers(); }

// The screen savers, LG's first, each { id, label, description, builtin, ... }.
// Reads the folders again, so one just added on the TV is there.
function catalog() { return scanSavers().list; }

function saverById(id) {
  var byId = savers().byId;
  return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
}

var webosVersion = null;  // as the TV reports it
var lunaFn = null;
var configObj = null;
var hour12Fn = function () { return false; };
var injectKeyFn = null;
var keyBackVal = null;
// An app id's short id, an HDMI input's port key (hdmi3) under any app id.
var inputKeyFn = names.shortAppId;
var switchingSince = 0;
// True while a screen saver started by launching its app may be showing:
// tvpower stays Active under one started that way, so it cannot tell.
var launchedDirectly = false;
var launchGeneration = 0;
var closeCallbacks = [];
/** @type {function(boolean): void} */
var watchKeysFn = function () {};
/** @type {function(function(?{state: string, fullScreen: boolean}): void, boolean=): void} */
var mediaStateFn = function (cb) { cb(null); };

function clearStagedScreensaver() {
  stagedEntities = null;
  stagedEntityLabels = null;
  unlinkQuiet(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER));
  unlinkQuiet(path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER));
  unlinkQuiet(path.join(SCREENSAVER_DIR, SCREENSAVER_CHOICE_MARKER));
  unlinkQuiet(path.join(SCREENSAVER_DIR, 'appinfo.json'));
  removeTree(path.join(SCREENSAVER_DIR, 'qml'));
}

// A folder and everything in it, quietly: the staged copy of a saver.
function removeTree(dir) {
  var entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  for (var i = 0; i < entries.length; i++) {
    var p = path.join(dir, entries[i]);
    var isDir = false;
    try { isDir = fs.lstatSync(p).isDirectory(); } catch (e2) {}
    if (isDir) removeTree(p);
    else unlinkQuiet(p);
  }
  try { fs.rmdirSync(dir); } catch (e3) {}
}

// Whether the staged copy is bind-mounted over the app. The root in
// mountinfo is the path inside its filesystem, the tail of SCREENSAVER_DIR
// where /var or /var/lib is a mount of its own.
function stagedCopyMounted() {
  var lines;
  try { lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n'); } catch (e) { return false; }
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split(' ');
    if (parts.length < 5 || parts[4] !== SCREENSAVER_APP_DIR) continue;
    var root = parts[3];
    if (root.length > 1 && SCREENSAVER_DIR.slice(-root.length) === root) return true;
  }
  return false;
}

function unmountScreensaver(cb) {
  cb = cb || function () {};
  var qmlFile = path.join(SCREENSAVER_APP_DIR, 'qml', 'main.qml');
  execFile('/bin/umount', ['-l', qmlFile], { timeout: 4000 }, function () {
    execFile('/bin/umount', [SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
      if (err) {
        return execFile('/bin/umount', ['-l', SCREENSAVER_APP_DIR], { timeout: 4000 }, function () {
          cb();
        });
      }
      cb();
    });
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  configObj = opts.config;
  haEntityModule = opts.haEntity || null;
  hour12Fn = opts.hour12 || function () { return false; };
  webosVersion = opts.webosVersion || null;
  saverRoots = opts.saverRoots || DEFAULT_ROOTS;
  catalogCache = null;
  injectKeyFn = opts.injectKey;
  keyBackVal = opts.KEY_BACK;
  if (opts.inputKey) inputKeyFn = opts.inputKey;
  watchKeysFn = opts.watchKeys || function () {};
  watchPointerFn = opts.watchPointer || function () {};
  lastPointerEnd = 0;
  mediaStateFn = opts.mediaState || function (cb) { cb(null); };
  launchedDirectly = false;
  launchGeneration++;
  closeCallbacks = [];
  randomConfigFile = (opts && opts.randomConfigFile) ? opts.randomConfigFile : RANDOM_CONFIG_FILE;
  wasInScreenSaver = false;

  // Auto-heal: If the screensaver is currently stock (no active bind-mount on SCREENSAVER_APP_DIR),
  // but an orphaned marker remains in SCREENSAVER_DIR, remove it so the boot hook does not
  // re-mount a stale screensaver on the next cold reboot. Never while the staged copy is
  // mounted: clearing it would empty the app, and an app's saver can read as gone only
  // because the staged copy is mounted over its folder too, by propagation (#1378).
  if (!stagedCopyMounted() && screensaverMode() === 'stock') {
    clearStagedScreensaver();
    rememberStockType();
  }
}

function manifestType(json) {
  try { return JSON.parse(json).type || null; } catch (e) { return null; }
}

// Only valid while the stock app is showing, i.e. nothing is mounted over it.
function rememberStockType(json) {
  try {
    if (json === undefined) json = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
    var type = manifestType(json);
    if (type) fs.writeFileSync(STOCK_TYPE_FILE, type);
  } catch (e) {}
}

// True where LG's screen saver runs on another runner than ours (Flutter on
// webOS 10), so going to or from it restarts sam. Unknown until the stock
// manifest has been seen once.
function slowSwitch() {
  var t = readTrimmed(STOCK_TYPE_FILE);
  return !!t && t !== 'qml';
}

// Where the stock screen saver is not QML (Flutter on webOS 10 and 11), custom
// screen savers were followed by the picture muted, HDMI-CEC and ARC dead and
// sound on the TV speakers only, until a power cut (#366), when switching to
// one restarted sam. Since 0.98.1 the switch asks sam to reread the one app
// instead (ensureScreensaverRunner), which has held on a C5 (webOS 10.3.1), a
// C2 (webOS 10.3) and a G3 (webOS 11.2, with forceBlockSystemApp), so they are
// on there by default (#768). Later versions are untried and stay held back:
// the boot hook does not apply them and nothing here restarts sam. "allowExperimentalScreensavers": true in config.json turns them on
// anywhere; it does not let sam be restarted.
function heldBack() {
  return slowSwitch() && !onByDefault() && !allowedAnyway();
}

function onByDefault() {
  return slowSwitch() && /^1[01]\./.test(String(webosVersion || ''));
}

// Where custom screen savers are experimental: held back, or turned on anyway.
function experimental() {
  return slowSwitch() && !onByDefault();
}

function allowedAnyway() {
  // The old name, until migrateConfigFile() has renamed it.
  return !!(configObj && (configObj.allowExperimentalScreensavers === true || configObj.allowOnWebos10 === true));
}

// Held back but turned back on, so the dashboards can say so.
function heldOverridden() {
  return experimental() && allowedAnyway();
}

function switching() {
  if (switchingSince && Date.now() - switchingSince > SWITCH_TIMEOUT_MS) switchingSince = 0;
  return !!switchingSince;
}

// A percentage from one, or from "dim" and "bright" as they were stored and sent before.
function brightnessOf(v) {
  if (v === 'bright') return 100;
  var n = typeof v === 'number' ? v : (/^\d{1,3}$/.test(String(v)) ? parseInt(v, 10) : NaN);
  if (isNaN(n)) return TUNED_DIM;
  return Math.max(MIN_BRIGHTNESS, Math.min(100, Math.round(n)));
}

function screensaverBrightness() {
  return brightnessOf(readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_LEVEL_MARKER)));
}

// Dim or Bright, for what still reads one of the two: Bright only at 100%.
function screensaverLevel() {
  return screensaverBrightness() >= 100 ? 'bright' : 'dim';
}

// The level a saver taking one is drawn at, and the black layer over it.
function tunedLevel(brightness) { return brightness > TUNED_DIM ? 1 : 0; }
function layerOpacity(e, brightness) {
  var top = e.uses.indexOf('level') !== -1 && !tunedLevel(brightness) ? TUNED_DIM : 100;
  return Math.round((1 - brightness / top) * 1000) / 1000;
}

// The option in use from the screen saver's choices, or its default.
function screensaverChoice(e) {
  if (!e || !e.choices) return undefined;
  var stored = readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER));
  var picked = RENAMED[stored] ? RENAMED[stored].choice : readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_CHOICE_MARKER));
  return pickChoice(e, picked);
}
function pickChoice(e, id) {
  return e.choices.options.some(function (o) { return o.id === id; }) ? id : e.choices.def;
}

function stagedScreensaver() {
  var m = readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER));
  if (RENAMED[m]) m = RENAMED[m].mode;
  var e = m && m !== 'stock' ? saverById(m) : null;
  return e && !e.problem ? m : 'stock';
}

function screensaverMode() {
  var staged = stagedScreensaver();
  if (staged !== 'stock' && isRandomEnabled()) return 'random';
  return staged;
}

function defaultRandomPool() {
  return catalog().filter(function (e) {
    return e.id !== 'stock' && e.id !== 'random' && !e.problem && !saverMissingHa(e) && !saverMinEntitiesError(e) && (!heldBack() || e.builtin);
  }).map(function (e) {
    return e.id;
  });
}

function readRandomConfig() {
  try {
    var raw = fs.readFileSync(randomConfigFile, 'utf8');
    var data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch (e) {}
  return { enabled: false, pool: null };
}

function isRandomEnabled() {
  return !!readRandomConfig().enabled;
}

function getRandomPool() {
  var cfg = readRandomConfig();
  var allValid = defaultRandomPool();
  if (!Array.isArray(cfg.pool)) return allValid;
  var filtered = cfg.pool.filter(function (id) {
    return allValid.indexOf(id) !== -1;
  });
  return filtered.length > 0 ? filtered : allValid;
}

function saveRandomConfig(patch) {
  var cur = readRandomConfig();
  if (patch.enabled !== undefined) cur.enabled = !!patch.enabled;
  if (patch.pool !== undefined) {
    if (Array.isArray(patch.pool)) {
      var allValid = defaultRandomPool();
      cur.pool = patch.pool.filter(function (id) {
        return allValid.indexOf(id) !== -1;
      });
    } else {
      cur.pool = null;
    }
  }
  try {
    fs.writeFileSync(randomConfigFile, JSON.stringify(cur, null, 2));
  } catch (e) {
    console.error('screensaver: could not save random config: ' + e.message);
  }
}

function setRandomPool(pool) {
  if (!Array.isArray(pool)) return;
  var allValid = defaultRandomPool();
  var validPool = pool.filter(function (id) {
    return allValid.indexOf(id) !== -1;
  });
  saveRandomConfig({ pool: validPool });
  if (isRandomEnabled()) {
    var cur = stagedScreensaver();
    if (validPool.length > 0 && validPool.indexOf(cur) === -1) {
      advanceRandomSaver();
    }
  }
}

function pickNextRandomSaver(currentId) {
  var pool = getRandomPool();
  if (!pool || pool.length === 0) pool = defaultRandomPool();
  if (pool.length === 0) return null;
  var candidates = pool;
  if (pool.length > 1 && currentId) {
    candidates = pool.filter(function (id) { return id !== currentId; });
    if (candidates.length === 0) candidates = pool;
  }
  var pickedId = candidates[Math.floor(Math.random() * candidates.length)];
  return saverById(pickedId);
}

function advanceRandomSaver() {
  if (!isRandomEnabled()) return;
  var curStaged = stagedScreensaver();
  var nextSaver = pickNextRandomSaver(curStaged);
  if (!nextSaver || nextSaver.problem) return;
  try {
    stageSaverFiles(nextSaver, screensaverBrightness(), screensaverChoice(nextSaver));
    fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), nextSaver.id);
    try { fs.writeFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER), nextSaver.id); } catch (errApp) {}
    console.log('screensaver: random mode queued "' + nextSaver.id + '" for next screen saver');
  } catch (e) {
    console.error('screensaver: could not stage random screen saver: ' + e.message);
  }
}

function onPowerChange(rawState) {
  var raw = (rawState && typeof rawState === 'object') ? (rawState.raw || rawState.state || rawState) : rawState;
  var isSS = power.isScreenSaver(power.mapState(raw));
  if (wasInScreenSaver && !isSS) {
    if (isRandomEnabled()) {
      advanceRandomSaver();
    }
  }
  if (isSS !== wasInScreenSaver) watchPointerFn(isSS && stagedScreensaver() !== 'stock');
  wasInScreenSaver = isSS;
}

// The pointer moved or clicked: one of these screen savers showing ends.
function pointerUsed() {
  if (!lunaFn) return;
  if (launchedDirectly) return keyPressed();
  if (!wasInScreenSaver || stagedScreensaver() === 'stock') return;
  var now = Date.now();
  if (now - lastPointerEnd < POINTER_END_GAP_MS) return;
  lastPointerEnd = now;
  console.log('screensaver: the pointer ends the screen saver');
  lunaFn('com.webos.service.tvpower/power/turnOnScreen', {}, function () {});
}

function detectExternal() {
  var active = false;
  var hook = false;
  try {
    var info = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
    for (var i = 0; i < info.length; i++) {
      var parts = info[i].split(' ');
      if (parts.length >= 5) {
        var root = parts[3];
        var target = parts[4];
        if (target.indexOf(SCREENSAVER_APP_DIR) === 0 && root.indexOf('/var/lib/tvweb/screensaver') === -1) {
          active = true;
          break;
        }
      }
    }
  } catch (e) {}
  if (!active) {
    try {
      var mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
      for (var m = 0; m < mounts.length; m++) {
        var mparts = mounts[m].split(' ');
        if (mparts.length >= 2 && mparts[1].indexOf(SCREENSAVER_APP_DIR) === 0) {
          if (mparts[0].indexOf('/var/lib/tvweb/screensaver') === -1 && mparts[1] !== SCREENSAVER_APP_DIR) {
            active = true;
            break;
          }
        }
      }
    } catch (e2) {}
  }
  try {
    var initFiles = fs.readdirSync('/var/lib/webosbrew/init.d');
    for (var j = 0; j < initFiles.length; j++) {
      if (/screensaver/i.test(initFiles[j])) {
        hook = true;
        break;
      }
    }
  } catch (e3) {}
  return { active: active, hook: hook };
}

function screensaverColorOptions() {
  return COLOR_PRESETS.map(function (c) { return { id: c.id, label: c.label, hex: c.bright }; });
}

function findColorPreset(id) {
  for (var i = 0; i < COLOR_PRESETS.length; i++) {
    if (COLOR_PRESETS[i].id === id) return COLOR_PRESETS[i];
  }
  return COLOR_PRESETS[0];
}

function readStoredColors() {
  try {
    if (fs.existsSync(SCREENSAVER_COLORS_FILE)) {
      return JSON.parse(fs.readFileSync(SCREENSAVER_COLORS_FILE, 'utf8')) || {};
    }
  } catch (e) {}
  return {};
}

function writeStoredColors(all) {
  try {
    writeJsonAtomic(SCREENSAVER_COLORS_FILE, all);
  } catch (e) {
    console.warn('screensaver: could not save color preference: ' + e.message);
  }
}

function screensaverColor(e) {
  if (!e || !e.uses || e.uses.indexOf('color') === -1) return undefined;
  var stored = readStoredColors();
  var raw = stored && stored[e.id];
  return findColorPreset(raw).id;
}

function setSaverColor(saverId, colorId, cb) {
  cb = cb || function () {};
  var saver = saverById(saverId);
  if (!saver) return cb({ ok: false, error: 'unknown screen saver: ' + saverId });
  if (!saver.uses || saver.uses.indexOf('color') === -1) {
    return cb({ ok: false, error: saverId + ' does not support color customization' });
  }
  var preset = null;
  for (var i = 0; i < COLOR_PRESETS.length; i++) {
    if (COLOR_PRESETS[i].id === colorId) { preset = COLOR_PRESETS[i]; break; }
  }
  if (!preset) return cb({ ok: false, error: 'unknown color: ' + colorId });
  var stored = readStoredColors();
  if (preset.id === DEFAULT_SAVER_COLOR) delete stored[saverId];
  else stored[saverId] = preset.id;
  writeStoredColors(stored);
  if (stagedScreensaver() === saverId) {
    restageScreensaver();
    restartScreensaverApp(function () {});
  }
  cb({ ok: true, color: preset.id });
}

function screensaverList() {
  var cur = screensaverMode();
  var staged = isRandomEnabled() ? stagedScreensaver() : undefined;
  var out = [];
  var all = catalog();
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var specs = e.entities ? effectiveSaverEntitySpecs(e) : null;
    var listItems = e.entityList ? effectiveSaverEntityList(e) : null;
    var needsHa = saverMissingHa(e);
    var hasColor = e.uses && e.uses.indexOf('color') !== -1;
    out.push({
      id: e.id,
      label: e.label,
      description: e.description,
      active: e.id === cur,
      available: e.id === 'stock' || (!heldBack() && !e.problem && !needsHa),
      needsHa: needsHa || undefined,
      builtin: e.builtin,
      author: e.author || undefined,
      license: e.license || undefined,
      version: e.version || undefined,
      panels: e.panels,
      // Why it cannot be picked, where something is wrong with its folder or HA API.
      note: e.problem || (needsHa ? NEEDS_HA_ERROR : undefined),
      // What one added on the TV does past the screen: the network, sound.
      cautions: e.cautions && e.cautions.length ? e.cautions : undefined,
      // The app it comes from, where it is an installed app's.
      fromApp: e.fromApp ? e.appTitle : undefined,
      // Options to pick from, and the one in use (or its default).
      choices: e.choices ? e.choices.options.map(function (o) { return { id: o.id, label: o.label, group: o.group }; }) : undefined,
      choice: e.choices ? (e.id === cur ? screensaverChoice(e) : e.choices.def) : undefined,
      // What the dropdown is called, where the screen saver names it.
      choicesLabel: e.choices ? e.choices.label : undefined,
      // Optional value color selection for savers declaring "color" in uses.
      color: hasColor ? screensaverColor(e) : undefined,
      colors: hasColor ? screensaverColorOptions() : undefined,
      // Home Assistant entities declared by the saver, with effective overrides.
      entities: e.entities ? Object.keys(e.entities).map(function (k) {
        var lbl = k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        var spec = specs && specs[k];
        return {
          id: k,
          label: lbl,
          entity: spec ? spec.entity : e.entities[k],
          customLabel: spec ? spec.customLabel : '',
          def: e.entities[k]
        };
      }) : undefined,
      // Ordered list of Home Assistant entities configured for a cycling saver.
      entityList: e.entityList ? {
        min: e.entityList.min,
        max: e.entityList.max,
        items: (listItems || []).map(function (it) {
          return { entity: it.entity, label: it.customLabel };
        })
      } : undefined
    });
    if (e.id === 'stock') {
      out.push({
        id: 'random',
        label: msg('srv.saver.random', 'Random'),
        description: msg('srv.saver.random.desc', 'Picks a different screen saver each time the screen saver appears.'),
        active: cur === 'random',
        available: !heldBack(),
        builtin: true
      });
    }
  }
  var res = {
    ok: true,
    current: cur,
    staged: staged,
    random: {
      enabled: isRandomEnabled(),
      pool: getRandomPool()
    },
    level: screensaverLevel(), brightness: screensaverBrightness(),
    choice: screensaverChoice(saverById(cur === 'random' ? staged : cur)),
    haConfigured: haEntityModule ? haEntityModule.configured() : false,
    modes: out,
    writable: !!(configObj && configObj.allowControl),
    slowSwitch: slowSwitch(),
    // Always: held back, the tab offers the switch that turns custom screen
    // savers on, with its warning. A hidden tab read as broken (#630, #665).
    available: true,
    held: heldBack(),
    heldOverridden: heldOverridden(),
    switching: switching(),
    external: detectExternal(),
    // Poweroff after, in minutes (0 for off); it needs power actions allowed.
    powerOffMinutes: saverPowerOff.minutes(),
    allowPower: !!(configObj && configObj.allowPower)
  };
  res.filter = function (fn) { return out.filter(fn); };
  res.map = function (fn) { return out.map(fn); };
  return res;
}

function stageScreensaverAppinfo() {
  var stock = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
  rememberStockType(stock);
  var out = stock;
  try {
    var info = JSON.parse(stock);
    info.type = 'qml';
    info.main = 'qml/main.qml';
    out = JSON.stringify(info, null, 2);
  } catch (e) {
    console.error('screensaver: stock appinfo.json did not parse, staging it unchanged: ' + e.message);
  }
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'appinfo.json'), out);
}

// cb(samRestarted, notTaken): notTaken where sam still holds the other type.
// sam is never restarted for a screen saver: that restart is the step behind
// #366, so a switch it does not take is undone instead.
function ensureScreensaverRunner(cb) {
  var staged;
  try {
    staged = JSON.parse(fs.readFileSync(
      path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8')).type;
  } catch (e) {
    return cb(false);
  }
  if (!lunaFn) return cb(false);
  lunaFn('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (r) {
    var cached = r && r.appInfo && r.appInfo.type;
    // No answer means the bus is not up yet. Leave the service alone.
    if (!cached || cached === staged) return cb(false);
    console.log('screensaver: sam holds the app as "' + cached + '" and it is now "'
                + staged + '" - making sam read the manifest again');
    // A block and release of this one app first (webOS 10 and later), then
    // the nudge where the TV has one, then the restart (lib/samrescan, #366).
    // Neither of the first two stops a running screen saver, so cb(false) has
    // the caller restart the app.
    function samHasIt(done) {
      lunaFn('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (a) {
        done(!!(a && a.appInfo && a.appInfo.type === staged));
      });
    }
    samrescan.rereadApp('com.webos.app.screensaver', samHasIt, function (reread) {
      if (reread) {
        console.log('screensaver: sam read the manifest again after a block and release, without a restart');
        return cb(false);
      }
      samrescan.refresh(samHasIt, function (nudged) {
        if (nudged) {
          console.log('screensaver: sam read the manifest again, without a restart');
          return cb(false);
        }
        console.log('screensaver: sam did not read the manifest again, and is not restarted (#366)');
        cb(false, true);
      });
    });
  });
}

// cb(notTaken), as ensureScreensaverRunner gives it.
function settleScreensaverApp(cb) {
  ensureScreensaverRunner(function (samRestarted, notTaken) {
    if (samRestarted || notTaken) return cb(!!notTaken);
    restartScreensaverApp(function () { cb(false); });
  });
}

// A saver's whole folder into the staged app's qml folder, its main file as
// main.qml, with what it asked for in uses filled in.
function stageSaverFiles(e, level, choice) {
  if (e.choices) choice = pickChoice(e, choice);
  var qmlDir = path.join(SCREENSAVER_DIR, 'qml');
  removeTree(qmlDir);
  mkdirp(qmlDir);
  // An app's screen saver loads the rest from its own folder.
  var files = e.fromApp ? [] : saverFiles(e.dir);
  for (var i = 0; i < files.length; i++) {
    var rel = files[i].rel;
    if (rel === MANIFEST || rel === e.main) continue;
    mkdirp(path.dirname(path.join(qmlDir, rel)));
    fs.writeFileSync(path.join(qmlDir, rel), fs.readFileSync(path.join(e.dir, rel)));
  }
  var specs = effectiveSaverEntitySpecs(e);
  var effEnts = effectiveFromSpecs(specs);
  var entityList = effectiveSaverEntityList(e);
  fs.writeFileSync(path.join(qmlDir, 'main.qml'), fillSaverQml(e, fs.readFileSync(path.join(e.dir, e.main), 'utf8'), level, choice, effEnts, entityList));
  fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER), String(level));
  stagedEntities = mergeActiveEntities(activeSaverEntities(effEnts), entityList);
  stagedEntityLabels = mergeActiveLabels(activeSaverLabels(specs), entityList);
  if (e.choices) fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_CHOICE_MARKER), choice);
  else unlinkQuiet(path.join(SCREENSAVER_DIR, SCREENSAVER_CHOICE_MARKER));
}

function mergeActiveEntities(base, entityList) {
  var out = base;
  if (entityList && entityList.length) {
    if (!out) out = {};
    for (var i = 0; i < entityList.length; i++) {
      if (entityList[i].entity) out['list_' + i] = entityList[i].entity;
    }
  }
  return out;
}

function mergeActiveLabels(base, entityList) {
  var out = base;
  if (entityList && entityList.length) {
    for (var i = 0; i < entityList.length; i++) {
      if (entityList[i].entity && entityList[i].customLabel) {
        if (!out) out = {};
        out[entityList[i].entity] = entityList[i].customLabel;
      }
    }
  }
  return out;
}

function effectiveFromSpecs(specs) {
  if (!specs) return null;
  var out = {};
  for (var k in specs) {
    if (Object.prototype.hasOwnProperty.call(specs, k)) out[k] = specs[k].entity;
  }
  return out;
}

function activeSaverEntities(effEnts) {
  if (!effEnts) return null;
  var out = null;
  for (var k in effEnts) {
    if (Object.prototype.hasOwnProperty.call(effEnts, k) && effEnts[k]) {
      if (!out) out = {};
      out[k] = effEnts[k];
    }
  }
  return out;
}

function activeSaverLabels(specs) {
  if (!specs) return null;
  var out = null;
  for (var k in specs) {
    if (!Object.prototype.hasOwnProperty.call(specs, k)) continue;
    var s = specs[k];
    if (s.entity && s.customLabel) {
      if (!out) out = {};
      out[s.entity] = s.customLabel;
    }
  }
  return out;
}

/*
 * A QML screen saver with a black layer over it, as the last child of its
 * window: drawn above everything else in it, and over nothing outside it.
 */
function withLayer(qml, opacity) {
  var end = qml.lastIndexOf('}');
  if (!(opacity > 0) || end === -1) return qml;
  return qml.slice(0, end) +
    '\n    // Glasshouse\'s brightness: a black layer over the screen saver.\n' +
    '    Rectangle { anchors.fill: parent; color: "black"; opacity: ' + opacity + '; z: 1000000 }\n' +
    qml.slice(end);
}

function fillSaverQml(e, qml, level, choice, effEnts, entityList) {
  var port = (configObj && configObj.port) || 8080;
  var token = configObj && configObj.token;
  if (e.uses.indexOf('stats') !== -1) {
    qml = qml.replace(/__TVWEB_URL__/g,
      'http://127.0.0.1:' + port + '/api/stats' + (token ? '?k=' + encodeURIComponent(token) : ''));
  }
  effEnts = effEnts || effectiveSaverEntities(e);
  // One address per declared entity, carrying the token like any other read.
  if (effEnts) {
    for (var name in effEnts) {
      if (!Object.prototype.hasOwnProperty.call(effEnts, name)) continue;
      var replacement = effEnts[name]
        ? 'http://127.0.0.1:' + port + '/api/entity/' + effEnts[name] + (token ? '?k=' + encodeURIComponent(token) : '')
        : '';
      qml = qml.replace(new RegExp('__TVWEB_HA_' + name + '__', 'g'), function () { return replacement; });
    }
  }
  if (e.uses.indexOf('ha-all') !== -1) {
    qml = qml.replace(/__TVWEB_HA_ALL__/g, function () {
      return 'http://127.0.0.1:' + port + '/api/homeassistant' +
        (token ? '?k=' + encodeURIComponent(token) : '');
    });
  }
  if (e.uses.indexOf('ha-list') !== -1) {
    entityList = entityList || effectiveSaverEntityList(e) || [];
    var payload = [];
    for (var li = 0; li < entityList.length; li++) {
      var item = entityList[li];
      payload.push({
        entity: item.entity,
        label: item.customLabel || '',
        url: 'http://127.0.0.1:' + port + '/api/entity/' + item.entity + (token ? '?k=' + encodeURIComponent(token) : '')
      });
    }
    var listJson = JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    qml = qml.replace(/__TVWEB_HA_LIST__/g, function () { return listJson; });
  }
  if (e.uses.indexOf('level') !== -1) qml = qml.replace(/__TVWEB_LEVEL__/g, String(tunedLevel(level)));
  if (e.uses.indexOf('color') !== -1) {
    var preset = findColorPreset(screensaverColor(e));
    var hex = tunedLevel(level) ? preset.bright : preset.dim;
    qml = qml.replace(/__TVWEB_COLOR__/g, function () { return hex; });
  }
  if (e.choices) {
    var value = e.choices.options.filter(function (o) { return o.id === choice; })[0].value;
    qml = qml.replace(/__TVWEB_CHOICE__/g, value);
  }
  // The hour cycle the clock screen savers draw: the TV's own (lib/clock).
  qml = qml.replace(/__TVWEB_CLOCK12__/g, hour12Fn() ? 'true' : 'false');
  if (!e.fromApp) qml = withLayer(qml, layerOpacity(e, level));
  return qml;
}

// choice: one of the saver's options, where it has them; its default otherwise.
function setScreensaver(mode, level, cb, choice) {
  if (RENAMED[mode]) {
    if (choice === undefined) choice = RENAMED[mode].choice;
    mode = RENAMED[mode].mode;
  }
  if (mode === 'random') {
    if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
    if (heldBack()) return cb({ ok: false, error: HELD_ERROR });
    level = brightnessOf(level);
    saveRandomConfig({ enabled: true });
    var staged = stagedScreensaver();
    var pool = getRandomPool();
    var nextSaver = (staged && staged !== 'stock' && pool.indexOf(staged) !== -1)
      ? saverById(staged)
      : pickNextRandomSaver();
    if (!nextSaver || nextSaver.problem) {
      nextSaver = pickNextRandomSaver() || saverById('starfield') || catalog()[1];
    }
    if (stagedScreensaver() !== 'stock') {
      try {
        stageSaverFiles(nextSaver, level, screensaverChoice(nextSaver));
        fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), nextSaver.id);
        try { fs.writeFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER), nextSaver.id); } catch (errApp) {}
      } catch (err) {
        return cb({ ok: false, error: msg('srv.saver.stageFailed', 'could not stage the screen saver: {error}', { error: err.message }) });
      }
      return cb({
        ok: true,
        current: 'random',
        staged: nextSaver.id,
        level: screensaverLevel(),
        brightness: screensaverBrightness(),
        switching: false
      });
    }
    return switchTo(nextSaver, 'random', level, choice, cb);
  }
  saveRandomConfig({ enabled: false });
  // Read again, so a saver just added on the TV can be picked.
  if (mode !== 'stock') scanSavers();
  var saver = mode === 'stock' ? STOCK : saverById(mode);
  if (!saver) return cb({ ok: false, error: 'unknown screen saver: ' + mode });
  if (saver.problem) return cb({ ok: false, error: saver.problem });
  if (saverMissingHa(saver) && mode !== screensaverMode()) return cb({ ok: false, error: NEEDS_HA_ERROR });
  if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
  if (mode !== 'stock' && heldBack()) return cb({ ok: false, error: HELD_ERROR });
  level = brightnessOf(level);
  switchTo(saver, mode, level, choice, cb);
}

/*
 * The switch itself, with nothing on screen while it happens. sam rereading
 * the app under a screen saver that is showing kills it, and asking tvpower
 * for one again straight after left tvpower at "Screen Saver Ready", refusing
 * every request until a reboot, or rebooted the TV (a C5, webOS 10.3.1). One
 * closed with Back first, and started again once the switch is done, does
 * neither.
 */
function switchTo(saver, mode, level, choice, cb) {
  switchingSince = Date.now();
  closeShowing(function (wasShowing, error) {
    if (error) {
      switchingSince = 0;
      return cb({ ok: false, error: error, current: screensaverMode(), level: screensaverLevel(), brightness: screensaverBrightness(), switching: false });
    }
    swapScreensaver(saver, mode, level, choice, function (r) {
      switchingSince = 0;
      r.switching = switching();
      cb(r);
      if (r.ok && wasShowing && mode !== 'stock') {
        setTimeout(function () {
          trigger(function (t) {
            if (!t.ok) console.log('screensaver: could not show the new one again: ' + (t.error || 'refused'));
          });
        }, SHOW_AGAIN_MS);
      }
    });
  });
}

/*
 * cb(wasShowing) once no screen saver is on screen: one tvpower shows is
 * closed with Back, as the remote would, and one Glasshouse opened itself is
 * closed. cb(wasShowing, error) where it would not close.
 */
function closeShowing(cb) {
  if (!lunaFn) return cb(false);
  if (launchedDirectly) {
    return closeLaunched(function () {
      setLaunched(false);
      cb(true);
    });
  }
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    if (!power.isScreenSaver(power.mapState(pw && pw.state))) return cb(false);
    if (!injectKeyFn || !keyBackVal) return cb(true, msg('srv.saver.noRemote', 'could not reach the remote input device'));
    injectKeyFn(keyBackVal, function (ok) {
      if (!ok) return cb(true, msg('srv.saver.noRemote', 'could not reach the remote input device'));
      var looks = 0;
      (function look() {
        setTimeout(function () {
          lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (now) {
            var closed = now && now.state && !power.isScreenSaver(power.mapState(now.state)) &&
              (!now.processing || now.processing === 'Screen On');
            if (closed) return cb(true);
            if (++looks < CLOSE_LOOKS) return look();
            cb(true, msg('srv.saver.notClosed', 'the screen saver on the TV did not close, so the switch was left undone'));
          });
        }, 500);
      })();
    });
  });
}

function swapScreensaver(saver, mode, level, choice, cb) {
  unmountScreensaver(function () {
    if (mode === 'stock') {
      clearStagedScreensaver();
      return settleScreensaverApp(function (notTaken) {
        cb({ ok: !notTaken && screensaverMode() === 'stock', current: screensaverMode(), level: screensaverLevel(), brightness: screensaverBrightness(),
             switching: switching(), error: notTaken ? STOCK_LATER_ERROR : undefined });
      });
    }

    try {
      mkdirp(path.join(SCREENSAVER_DIR, 'qml'));
      stageScreensaverAppinfo();
      stageSaverFiles(saver, level, choice);
      fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), saver.id);
    } catch (e) {
      return cb({ ok: false, error: msg('srv.saver.stageFailed', 'could not stage the screen saver: {error}', { error: e.message }) });
    }

    execFile('/bin/mount', ['--bind', SCREENSAVER_DIR, SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
      settleScreensaverApp(function (notTaken) {
        if (notTaken) {
          // sam still runs LG's: put LG's files back under it, so they agree.
          return unmountScreensaver(function () {
            clearStagedScreensaver();
            cb({ ok: false, current: screensaverMode(), level: screensaverLevel(), brightness: screensaverBrightness(), switching: switching(), error: NOT_TAKEN_ERROR });
          });
        }
        var now = screensaverMode();
        cb({
          ok: !err && (now === mode || (mode === 'random' && now === 'random')),
          current: now,
          level: screensaverLevel(), brightness: screensaverBrightness(),
          error: (!err && (now === mode || (mode === 'random' && now === 'random'))) ? undefined : 'the mount did not take'
        });
      });
    });
  });
}

/*
 * An installed app's screen saver in use whose app has gone, or no longer has
 * it: LG's back, as the staged copy may need files that went with the app.
 */
function appSaverGone() {
  var m = readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER));
  if (!m || m.indexOf(APP_PREFIX) !== 0 || saverById(m)) return;
  console.log('screensaver: "' + m + '" is no longer installed; putting LG\'s back');
  setScreensaver('stock', 'dim', function (r) {
    if (!r.ok) console.error('screensaver: could not put LG\'s back: ' + (r.error || 'unknown error'));
  });
}

// At start, when the clock's format changes, and after an app is removed.
function restageScreensaver() {
  // Read again, as an app with a screen saver may have been removed.
  scanSavers();
  var mode = screensaverMode();
  if (mode === 'stock') { stagedEntities = null; stagedEntityLabels = null; return appSaverGone(); }
  var stagedId = stagedScreensaver();
  var saver = saverById(stagedId);
  if (!saver || saver.problem) {
    if (isRandomEnabled()) return advanceRandomSaver();
    return;
  }
  if (isRandomEnabled() && (saverMissingHa(saver) || saverMinEntitiesError(saver))) {
    return advanceRandomSaver();
  }
  try {
    var staged = path.join(SCREENSAVER_DIR, 'qml', 'main.qml');
    var before = fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : '';
    stageSaverFiles(saver, screensaverBrightness(), screensaverChoice(saver));
    // An old id stored is written again as the one it now is.
    if (RENAMED[readTrimmed(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER))]) {
      fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), saver.id);
    }
    if (fs.readFileSync(staged, 'utf8') !== before) {
      console.log('screensaver: restaged "' + saver.id + '" from a newer copy');
    }
  } catch (e) {
    console.error('screensaver: could not restage ' + saver.id + ': ' + e.message);
  }
}

// One a switch leaves running is closed, so it opens from the new files next
// time. One on screen is left alone: switchTo closes it before a switch, and
// one tvpower started in the moment since is not ours to restart.
function restartScreensaverApp(cb) {
  if (!lunaFn) return cb();
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    if (power.isScreenSaver(power.mapState(pw && pw.state))) return cb();
    lunaFn('com.webos.applicationManager/closeByAppId', { id: SCREENSAVER_APP_ID }, function () { cb(); });
  });
}

/*
 * cb(true) once sam knows the screen saver app, rereading its apps first if
 * it has lost it. A C2 (webOS 9.2.2) once answered getAppInfo for it with
 * "Invalid appId specified" while the app's files were in place, and the
 * screen saver then did not start, with no error, until a nudge brought it
 * back. cb(true) also where getAppInfo gave no answer at all, so a slow bus
 * does not stop a start that may well work.
 */
function ensureScreensaverKnown(cb) {
  var id = 'com.webos.app.screensaver';
  function known(done) {
    lunaFn('com.webos.applicationManager/getAppInfo', { id: id }, function (r) {
      done(!!(r && r.appInfo), r);
    });
  }
  known(function (ok, r) {
    if (ok || !r || r.returnValue !== false) return cb(true);
    console.log('screensaver: sam does not know the screen saver app (' + (r.errorText || 'no info') + ') - making it read its apps again');
    samrescan.refresh(known, function (nudged) {
      if (nudged) {
        console.log('screensaver: sam knows the screen saver app again');
        return cb(true);
      }
      samrescan.rereadApp(id, known, function (reread) {
        if (reread) console.log('screensaver: sam knows the screen saver app again, after a block and release');
        else console.log('screensaver: sam still does not know the screen saver app');
        cb(reread);
      });
    });
  });
}

function screensaverRunning(cb) {
  lunaFn('com.webos.applicationManager/running', {}, function (r) {
    if (!r || !r.running) return cb(null);
    for (var i = 0; i < r.running.length; i++) {
      if (r.running[i].id === SCREENSAVER_APP_ID) return cb(true);
    }
    cb(false);
  });
}

/*
 * Whether a screen saver started by launching its app is showing, as last
 * seen. Answers at once, for the stats, and checks sam behind it so it clears
 * a poll after the screen saver closes, whether by the remote or the dashboard.
 */
function launchedShowing() {
  if (launchedDirectly && lunaFn) {
    var generation = launchGeneration;
    screensaverRunning(function (running) {
      if (running === false && generation === launchGeneration) setLaunched(false);
    });
  }
  return launchedDirectly;
}

/*
 * LG's screen saver answers a key by asking tvpower to turnOnScreen, and
 * leaves closing it to tvpower. Under one tvpower did not start, tvpower is
 * Active and refuses ("The current sub state must be 'screen off'"), so the
 * remote cannot close it (G3, webOS 9.2.2). The remote's keys are watched
 * while it shows, and any of them closes it.
 */
function setLaunched(on) {
  var was = launchedDirectly;
  if (on) {
    try { fs.writeFileSync(LAUNCHED_MARKER, '1\n', 'utf8'); }
    catch (e) { console.error('screensaver: could not record the launched screen saver: ' + e.message); }
  } else {
    unlinkQuiet(LAUNCHED_MARKER);
    if (was && isRandomEnabled()) {
      advanceRandomSaver();
    }
  }
  if (launchedDirectly === on) return;
  launchedDirectly = on;
  launchGeneration++;
  watchKeysFn(on);
}

function closeLaunched(cb) {
  closeCallbacks.push(cb);
  if (closeCallbacks.length > 1) return;
  var generation = launchGeneration;
  lunaFn('com.webos.applicationManager/closeByAppId', { id: SCREENSAVER_APP_ID }, function (r) {
    if (r && r.returnValue && generation === launchGeneration) setLaunched(false);
    var callbacks = closeCallbacks;
    closeCallbacks = [];
    for (var i = 0; i < callbacks.length; i++) callbacks[i](r);
  });
}

function keyPressed(code) {
  if (code === BTN_LEFT && !launchedDirectly) return pointerUsed();
  if (!launchedDirectly || !lunaFn) return;
  console.log('screensaver: a remote key closes the screen saver');
  closeLaunched(function () {});
}

// At start: one an earlier run launched may still be showing, which only
// this server can close.
function adoptLaunched() {
  if (!lunaFn || !fs.existsSync(LAUNCHED_MARKER)) return;
  var generation = launchGeneration;
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    if (!pw || pw.returnValue === false || generation !== launchGeneration) return;
    if (power.isScreenSaver(power.mapState(pw.state))) return setLaunched(false);
    screensaverRunning(function (running) {
      if (running !== null && generation === launchGeneration) setLaunched(running);
    });
  });
}

function launchScreensaverApp(cb) {
  // tvpower's refusal also protects playback. An unavailable media service
  // is not evidence that nothing is playing, including on older firmware.
  mediaStateFn(function (media) {
    if (!media) return cb(false, msg('srv.saver.unknownPlayback', 'the TV could not check whether anything is playing'));
    if (media.state === 'playing' && media.fullScreen) {
      return cb(false, msg('srv.saver.playing', 'the TV does not start a screen saver while something is playing'));
    }
    // The request and media checks can take seconds. Do not cover an input
    // or undo Screen Off if the source or power changed in the meantime.
    lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
      var currentPower = power.mapState(pw && pw.state);
      if (power.isScreenSaver(currentPower)) return cb(true);
      if (!pw || pw.returnValue === false || !currentPower.screenOn ||
          (pw.processing && pw.processing !== 'Screen On')) return cb(false);
      lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
        var fgId = fg && fg.returnValue !== false && fg.appId ? inputKeyFn(fg.appId) : '';
        if (!fgId || names.isHdmiKey(fgId) || fgId === 'livetv') return cb(false);
        console.log('screensaver: launching the screen saver app after a refused request');
        lunaFn('com.webos.applicationManager/launch', { id: SCREENSAVER_APP_ID }, function (r) {
          var ok = !!(r && r.returnValue);
          if (ok) setLaunched(true);
          cb(ok);
        });
      });
    });
  }, true);
}

/*
 * cb(true) where the screen saver tvpower agreed to start was then refused.
 * On a G3 (webOS 9.2.2) turnOnScreenSaver returned true, tvpower showed
 * "Request Screen Saver" and then "Screen On" 30 ms later, and went back to
 * Active with nothing started, from Home and from an app alike: one of the
 * services registered to answer screen saver requests said no, and none of
 * them logs why. Launching the app itself still brought the screen saver up.
 * cb(false) once it is showing, or while tvpower is still working on it after
 * the last look, so a slow start is not given a second one.
 */
function refusedAfterRequest(cb) {
  var looks = 0;
  (function look() {
    setTimeout(function () {
      lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
        if (!pw || power.isScreenSaver(power.mapState(pw.state))) return cb(false);
        var settled = power.mapState(pw.state).screenOn &&
          (!pw.processing || pw.processing === 'Screen On');
        if (settled) return cb(true);
        if (++looks < 6) return look();
        cb(false);
      });
    }, 500);
  })();
}

// tvpower at "Screen Saver Ready" with no screen saver showing: where it stays,
// it refuses every request until the TV restarts.
function readyLingers(pw) {
  return !!(pw && pw.processing === 'Screen Saver Ready' && !power.isScreenSaver(power.mapState(pw.state)));
}

function trigger(cb) {
  if (!lunaFn) return cb({ ok: false, error: 'luna bus not available' });
  // Asking tvpower for a screen saver while sam is down can park it at
  // "Screen Saver Ready" until a reboot.
  if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (first) {
    if (!readyLingers(first)) return withPower(first);
    // tvpower passes through it for a moment on the way to a screen saver.
    setTimeout(function () {
      lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (again) {
        if (readyLingers(again)) return cb({ ok: false, error: STUCK_ERROR });
        withPower(again);
      });
    }, STUCK_CHECK_MS);
  });

  function withPower(pw) {
    var isSS = power.isScreenSaver(power.mapState(pw && pw.state));
    if (isSS) {
      if (!injectKeyFn || !keyBackVal) {
        return cb({ ok: false, error: 'key injection not available' });
      }
      return injectKeyFn(keyBackVal, function (ok) {
        cb(ok ? { ok: true } : { ok: false, error: msg('srv.saver.noRemote', 'could not reach the remote input device') });
      });
    }
    if (launchedDirectly) {
      return screensaverRunning(function (running) {
        // Closed already: start one. No answer is not closed.
        if (running === false) {
          setLaunched(false);
          return trigger(cb);
        }
        closeLaunched(function (r) {
          cb(r && r.returnValue ? { ok: true } : {
            ok: false,
            error: msg('srv.saver.noClose', 'the TV would not close the screen saver: {error}', { error: (r && r.errorText) || 'no answer' })
          });
        });
      });
    }

    var activeSaver = saverById(stagedScreensaver());
    var minErr = saverMinEntitiesError(activeSaver);
    if (minErr) return cb({ ok: false, error: minErr });
    if (saverMissingHa(activeSaver)) return cb({ ok: false, error: NEEDS_HA_ERROR });

    lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
      var fgId = (fg && fg.appId) ? inputKeyFn(fg.appId) : '';
      if (names.isHdmiKey(fgId) || fgId === 'livetv') {
        return cb({ ok: false, error: msg('srv.saver.onlyInApps', 'the screen saver is only available from an app, not from {source}', { source: fgId }) });
      }
      ensureScreensaverKnown(function (known) {
        if (!known) return cb({ ok: false, error: LOST_ERROR });
        // Where panel care holds the screen saver back, the app in front is
        // handed to it without the hold first (lib/idlesaver.js).
        idlesaver.lift(function () {
          lunaFn('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function (r) {
            if (r && r.returnValue) {
              return refusedAfterRequest(function (refused) {
                if (!refused) return cb({ ok: true });
                idlesaver.restore();
                launchScreensaverApp(function (ok, error) {
                  cb(ok ? { ok: true } : {
                    ok: false,
                    error: error || (fgId ? msg('srv.saver.refusedFrom', 'the TV would not start a screen saver from {source}', { source: fgId })
                      : msg('srv.saver.refusedHere', 'the TV would not start a screen saver from this source'))
                  });
                });
              });
            }
            idlesaver.restore();
            if (r && (r.errorText === 'Invalid State change Request' ||
                      (r.errorText && r.errorText.indexOf('screenSaverEnabled') !== -1))) {
              return launchScreensaverApp(function (launched, error) {
                if (launched) return cb({ ok: true });
                cb({
                  ok: false,
                  error: error || msg('srv.saver.refused', 'the TV would not start a screen saver here: {error}', { error: r.errorText })
                });
              });
            }
            cb({
              ok: false,
              error: (r && r.errorText)
                ? msg('srv.saver.refused', 'the TV would not start a screen saver here: {error}', { error: r.errorText })
                : fgId ? msg('srv.saver.refusedFrom', 'the TV would not start a screen saver from {source}', { source: fgId })
                : msg('srv.saver.refusedHere', 'the TV would not start a screen saver from this source')
            });
          });
        });
      });
    });
  }
}

// The staged screen saver's declared entities: what /api/entity may serve.
function screensaverEntities() {
  return stagedEntities;
}

// Optional custom label set for an active screen saver entity.
function screensaverEntityLabel(entityId) {
  return (stagedEntityLabels && stagedEntityLabels[entityId]) || '';
}

module.exports = {
  SCREENSAVER_APP_DIR: SCREENSAVER_APP_DIR,
  SCREENSAVER_DIR: SCREENSAVER_DIR,
  USER_SAVERS_DIR: USER_SAVERS_DIR,
  catalog: catalog,
  init: init,
  clearStagedScreensaver: clearStagedScreensaver,
  stagedCopyMounted: stagedCopyMounted,
  unmountScreensaver: unmountScreensaver,
  screensaverLevel: screensaverLevel,
  screensaverBrightness: screensaverBrightness,
  screensaverMode: screensaverMode,
  screensaverList: screensaverList,
  switching: switching,
  detectExternal: detectExternal,
  heldBack: heldBack,
  heldOverridden: heldOverridden,
  experimental: experimental,
  onByDefault: onByDefault,
  slowSwitch: slowSwitch,
  allowedAnyway: allowedAnyway,
  setScreensaver: setScreensaver,
  setSaverEntities: setSaverEntities,
  setSaverColor: setSaverColor,
  screensaverColor: function () {
    var mode = screensaverMode();
    if (mode === 'random') mode = stagedScreensaver();
    return screensaverColor(saverById(mode));
  },
  screensaverChoice: function () {
    var mode = screensaverMode();
    if (mode === 'random') mode = stagedScreensaver();
    return screensaverChoice(saverById(mode));
  },
  RENAMED: RENAMED,
  RANDOM: RANDOM,
  isRandomEnabled: isRandomEnabled,
  getRandomPool: getRandomPool,
  setRandomPool: setRandomPool,
  saveRandomConfig: saveRandomConfig,
  defaultRandomPool: defaultRandomPool,
  pickNextRandomSaver: pickNextRandomSaver,
  advanceRandomSaver: advanceRandomSaver,
  onPowerChange: onPowerChange,
  stagedScreensaver: stagedScreensaver,
  restageScreensaver: restageScreensaver,
  screensaverEntities: screensaverEntities,
  screensaverEntityLabel: screensaverEntityLabel,
  launchedShowing: launchedShowing,
  keyPressed: keyPressed,
  pointerUsed: pointerUsed,
  adoptLaunched: adoptLaunched,
  trigger: trigger
};
