/**
 * test/test-i18n-compact.js - the released package's translation files, with
 * a hash of the English in place of the English (scripts/build-ipk.py), give
 * every page and server message the same text the repository's files do.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var spawn = require('child_process').spawn;

console.log('Running test-i18n-compact.js ...');

var ROOT = path.join(__dirname, '..');
var I18N_DIR = path.join(ROOT, 'server', 'assets', 'i18n');
var SRC = fs.readFileSync(path.join(ROOT, 'server', 'assets', 'i18n.js'), 'utf8');

// build-ipk.py's own functions, run on the input given; cb(stdout). Through
// spawn, which Node 0.10 has, unlike execFileSync.
function python(code, input, cb) {
  var prog = 'import importlib.util, json, sys\n' +
    'spec = importlib.util.spec_from_file_location("b", ' + JSON.stringify(path.join(ROOT, 'scripts', 'build-ipk.py')) + ')\n' +
    'b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)\n' + code;
  var child = spawn('python3', ['-c', prog]);
  var out = [], err = [];
  child.stdout.on('data', function (d) { out.push(d); });
  child.stderr.on('data', function (d) { err.push(d); });
  child.on('close', function (status) {
    assert.strictEqual(status, 0, 'python3: ' + Buffer.concat(err).toString());
    cb(Buffer.concat(out).toString('utf8'));
  });
  child.stdin.end(input);
}

// The page's I18N, in the language given, with the file given.
function page(lang, text) {
  var win = {
    navigator: { languages: [lang], language: lang },
    location: { pathname: '/', search: '?lang=' + lang },
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    document: {
      readyState: 'complete',
      documentElement: { setAttribute: function () {} },
      querySelectorAll: function () { return []; },
      addEventListener: function () {}
    },
    XMLHttpRequest: function () {
      this.open = function () {};
      this.send = function () { this.status = 200; this.responseText = text; };
    }
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  return win.I18N;
}

// 1. The same hash in Python and on the server, for text beyond ASCII. The
// page's copy is checked against the packaged files below.
var say = require('../server/lib/say');
var samples = ['', 'On', 'Écran éteint', 'Ελληνικά', 'العربية', 'Tiếng Việt', 'Emoji 📺 and 🏠', '{name} is running'];
python('print(json.dumps([b.english_hash(s) for s in json.load(sys.stdin)]))', JSON.stringify(samples), function (pyOut) {
var py = JSON.parse(pyOut);
samples.forEach(function (s, i) {
  assert.strictEqual(say.englishHash(s), py[i], 'server and package agree on ' + JSON.stringify(s));
});
console.log('  ✓ the package and the server hash the English alike');

// 2. Every language's packaged file gives each page string as its own does.
var langs = fs.readdirSync(I18N_DIR).filter(function (f) { return /\.json$/.test(f); });
python(
  'out = {}\n' +
  'for f in json.load(sys.stdin):\n' +
  '    out[f] = b.compact_i18n(open(' + JSON.stringify(I18N_DIR) + ' + "/" + f, "rb").read()).decode("utf-8")\n' +
  'print(json.dumps(out))', JSON.stringify(langs), function (compactOut) {
var compacted = JSON.parse(compactOut);
var before = 0, after = 0, checked = 0;
langs.forEach(function (f) {
  var lang = f.replace(/\.json$/, '');
  var full = fs.readFileSync(path.join(I18N_DIR, f), 'utf8');
  var small = compacted[f];
  before += Buffer.byteLength(full);
  after += Buffer.byteLength(small);
  assert.ok(small.indexOf('"from"') === -1, f + ' still carries the English');
  var a = page(lang, full), b = page(lang, small);
  var dict = JSON.parse(full);
  Object.keys(dict).forEach(function (key) {
    var e = dict[key];
    if (!e || typeof e.from !== 'string') return;
    assert.strictEqual(b.t(key, e.from), a.t(key, e.from), f + ' ' + key);
    assert.strictEqual(b.t(key, e.from + ' changed'), e.from + ' changed', f + ' ' + key + ' changed English');
    checked++;
  });
});
assert.ok(checked > 10000, 'checked ' + checked);
assert.ok(after < before * 0.8, 'packaged ' + after + ' of ' + before + ' bytes');
console.log('  ✓ ' + checked + ' strings read the same from the packaged files, ' +
  Math.round(before / 1024) + ' KB down to ' + Math.round(after / 1024) + ' KB');

// 3. The server's messages read the same, and fall back to English for new words.
var dir = path.join(os.tmpdir(), 'i18n-compact-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
var es = JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'es.json'), 'utf8'));
var srvKey = Object.keys(es).filter(function (k) { return /^srv\./.test(k) && es[k].from && es[k].from.indexOf('{') === -1; })[0];
fs.writeFileSync(path.join(dir, 'es.json'), compacted['es.json']);
say.init(dir);
var english = say.msg(srvKey, es[srvKey].from);
assert.strictEqual(say.translateBody(JSON.stringify({ message: english }), 'es'),
  JSON.stringify({ message: es[srvKey].text }), srvKey);
var changed = say.msg(srvKey, es[srvKey].from + ' now');
assert.strictEqual(say.translateBody(JSON.stringify({ message: changed }), 'es'), JSON.stringify({ message: changed }));
console.log('  ✓ server messages are translated from the packaged file, and new English stays English');

console.log('ALL test-i18n-compact.js assertions passed!');
});
});
