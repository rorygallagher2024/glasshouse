/*
 * qmlcheck.js - The QML mistakes that make a screen saver fail to load, and
 * what in one reaches past the screen.
 *
 * qml-runner reports nothing for a file it cannot load: the screen saver just
 * shows black. So the mistakes scripts/check-screensavers.py finds in
 * Glasshouse's own are looked for here too, in one added on the TV, before it
 * can be picked. The two lists of rules are kept the same.
 *
 * What reaches past the screen - the network, sound, other apps - is allowed,
 * as the design principles are a guide for one added on the TV, but noted.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var msg = require('./say').msg;

// property -> QtQuick version that introduced it
var SINCE = {
  topPadding: [2, 6], bottomPadding: [2, 6], leftPadding: [2, 6], rightPadding: [2, 6], padding: [2, 6],
  advance: [2, 10], renderTypeQuality: [2, 15], palette: [2, 13], containmentMask: [2, 11]
};
// Each property as it is set, made once: the list is read often.
var SINCE_RE = {};
for (var p in SINCE) SINCE_RE[p] = new RegExp('(^|[\\s{;])' + p + '\\s*:');
// One line naming any of them, so most lines are passed over with one test.
var ANY_SINCE = new RegExp('(' + Object.keys(SINCE).join('|') + ')\\s*:');
// anchors a Row or Column will not honour on its own children
var BANNED = {
  Column: ['left', 'right', 'horizontalCenter', 'fill', 'centerIn'],
  Row: ['top', 'bottom', 'verticalCenter', 'fill', 'centerIn']
};
// The newest QtQuick each webOS version has, where it is known: Qt 5.6 on a
// B8, 5.9 on a CX, 5.12 on a C2 and a C5.
var QTQUICK_BY_WEBOS = { 4: 6, 5: 9, 9: 12, 10: 12 };

function before(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }

// The code with strings emptied and comments removed. Strings first: a path
// like "file:///usr/share/fonts/x.ttf" holds //.
function codeOnly(src) {
  return src
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// The first mistake in one QML file, as a message, or null. name is the
// file's name in its folder; webos the TV's major version, if known.
function problem(src, name, webos) {
  var stripped = codeOnly(src);
  var opens = (stripped.match(/\{/g) || []).length, closes = (stripped.match(/\}/g) || []).length;
  if (opens !== closes) {
    return msg('srv.saver.qmlBraces', '{file}: unbalanced braces, {open} open and {close} close.',
               { file: name, open: String(opens), close: String(closes) });
  }
  var im = /^\s*import\s+QtQuick\s+(\d+)\.(\d+)\s*$/m.exec(src);
  if (!im) return msg('srv.saver.qmlImport', '{file}: no plain "import QtQuick x.y" line.', { file: name });
  var ver = [parseInt(im[1], 10), parseInt(im[2], 10)];
  var most = QTQUICK_BY_WEBOS[webos];
  if (most && ver[0] === 2 && ver[1] > most) {
    return msg('srv.saver.qmlTooNew', '{file} imports QtQuick {want}, and this TV has QtQuick 2.{have}.',
               { file: name, want: ver.join('.'), have: String(most) });
  }

  var lines = src.split('\n');
  var depth = 0, layouts = [];
  for (var n = 0; n < lines.length; n++) {
    var code = lines[n].replace(/\/\/.*$/, '');
    if (ANY_SINCE.test(code)) {
      for (var prop in SINCE) {
        if (SINCE_RE[prop].test(code) && before(ver, SINCE[prop])) {
          return msg('srv.saver.qmlSince', '{file} line {line}: {prop} needs QtQuick {need}, and it imports {have}.',
                     { file: name, line: String(n + 1), prop: prop, need: SINCE[prop].join('.'), have: ver.join('.') });
        }
      }
    }
    var am = /anchors\.(\w+)\s*:/.exec(code);
    if (am && layouts.length) {
      var top = layouts[layouts.length - 1];
      var pre = code.slice(0, am.index);
      var here = depth + (pre.match(/\{/g) || []).length - (pre.match(/\}/g) || []).length;
      if (here === top.depth + 1 && BANNED[top.kind].indexOf(am[1]) !== -1) {
        return msg('srv.saver.qmlAnchor', '{file} line {line}: anchors.{anchor} is ignored on a direct child of a {layout}.',
                   { file: name, line: String(n + 1), anchor: am[1], layout: top.kind });
      }
    }
    var start = /^\s*(Row|Column)\s*\{/.exec(code);
    var o = (code.match(/\{/g) || []).length, c = (code.match(/\}/g) || []).length;
    if (start && o) layouts.push({ depth: depth + 1, kind: start[1] });
    depth += o - c;
    while (layouts.length && depth < layouts[layouts.length - 1].depth) layouts.pop();
  }
  return null;
}

// What in it reaches past the screen, as notes: [] for none.
function reaches(src) {
  var code = codeOnly(src), out = [];
  // A quoted web address, such as an Image's source, loads from the network.
  if (/\bXMLHttpRequest\b|\bWebSocket\b|^\s*import\s+Qt(WebSockets|WebEngine|WebKit|Network)\b/m.test(code) ||
      /["']https?:\/\//.test(src)) {
    out.push(msg('srv.saver.reachNetwork', 'It reaches the network.'));
  }
  if (/^\s*import\s+QtMultimedia\b/m.test(code) || /\b(Audio|SoundEffect|MediaPlayer|Video)\s*\{/.test(code)) {
    out.push(msg('srv.saver.reachSound', 'It can play sound.'));
  }
  if (/\bQt\.openUrlExternally\b|\bLunaService\b|^\s*import\s+(WebOSServices|WebOS\.Service)\b/m.test(code)) {
    out.push(msg('srv.saver.reachApps', 'It can open apps or use the TV\'s services.'));
  }
  return out;
}

module.exports = { problem: problem, reaches: reaches, QTQUICK_BY_WEBOS: QTQUICK_BY_WEBOS };
