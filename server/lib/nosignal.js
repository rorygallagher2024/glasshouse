'use strict';
/*
 * lib/nosignal.js - LG's No Signal screen as just "No Signal", an icon or Art
 *
 * An input with nothing coming in shows LG's No Signal screen, drawn by the
 * input app (com.webos.app.inputcommon, QML) in its Screensaver.qml: an
 * animated picture, the heading and a line of advice under it, drifting over
 * the screen. Switched on, a copy of the TV's own file is mounted over it with
 * two lines changed, so for No Signal only the picture and the line under the
 * heading are not drawn; the other messages it shows (a scrambled channel, no
 * CI module) keep theirs, and the text still drifts.
 *
 * The file is under qml/UserInterfaceLayer/Containers/BgViewLayer on webOS 9
 * (a C2, 9.2.2) and qml/TvComponent/ScreenSaver on webOS 4 (a B8, 4.4.3), with
 * the same two lines. Each must be there exactly once, as on those two, or
 * nothing is mounted: a firmware that changed them keeps LG's screen. On webOS
 * 9 and later, LG's "No Signal Image" gallery photo hides RandomMoveItem via
 * noSignalPhotoModel and paints PhotoSlide instead, so those two lines are
 * also adjusted when present.
 *
 * The input app holds the file it loaded until it starts again, so it is
 * restarted, and only while no input with a picture is on screen, as
 * restarting it blanks the input in front for a moment, and while no input is
 * open behind an app: on a C9 (webOS 4.10) an HDMI input open in the background
 * when it restarted never came back to the screen until a reboot (#1755). A
 * B8 (webOS 4.4) closed it instead. A mount does not
 * outlive a reboot; the server mounts it again at start. A TV boots onto its
 * last input with the input app started before the server (5 s into a C2's
 * boot, 7 s into a B8's), so an input with nothing coming in does not hold the
 * restart back: its No Signal screen is drawn again, plain, with nothing lost.
 *
 * Art mode draws the picture frame's pictures (lib/art) full screen under
 * LG's drifting box, which fades once the first picture is in, so until then,
 * or with nothing to show, LG's "No Signal" stays. It asks Art's address only
 * while the No Signal screen shows.
 *
 * Strict ES5: runs on node 0.12 (0.10 on webOS 2).
 */
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var util = require('./util');
var qmlcheck = require('./qmlcheck');
var say = require('./say');
var msg = say.msg;

var USER_NOSIGNALS_DIR = '/var/lib/tvweb/nosignals';
var USER_PREFIX = 'user-';
var ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
var NS_MANIFEST = 'nosignal.json';
var NS_MANIFEST_FORMAT = 1;
var MAX_NS_FILES = 200;
var MAX_NS_BYTES = 5 * 1024 * 1024;

var INPUT_APP = 'com.webos.app.inputcommon';
var APP_QML = '/usr/palm/applications/' + INPUT_APP + '/qml/';
var CANDIDATES = ['UserInterfaceLayer/Containers/BgViewLayer/Screensaver.qml', 'TvComponent/ScreenSaver/Screensaver.qml'];
var PATCHES = [
  // The animated picture above the heading.
  { find: /(\n[ \t]*visible: element\.isDynamic && \(headerText\.text \|\| bodyText\.text\))(?=\n)/g,
    add: ' && currentKey !== "noSignal"' },
  // The line of advice under it.
  { find: /(\n[ \t]*visible: text\.length > 0)(?=\n)/g,
    add: ' && currentKey !== "noSignal"' }
];
var HEADER_START = /\n([ \t]*)ScreensaverMainText \{\s*\n[ \t]*id: headerText(?=\n)/g;
var HEADER_ID = /(\n([ \t]*)id: headerText)(?=\n)/g;
// webOS 9+ "No Signal Image" photo slide and RandomMoveItem guard (absent on webOS 4).
var PHOTO_MODEL = /(\n[ \t]*photoModel:\s*)noSignalPhotoModel(?=\n)/g;
var MOVER_PHOTO_VISIBLE = /(\n[ \t]*visible:\s*visibleScreensaver)\s*&&\s*(noSignalPhotoModel\s*&&\s*!noSignalPhotoModel\.enabled(?:\s*&&\s*!noSignalPhotoModel\.opene?d)?)(?=\n)/g;
// Art: drawn under LG's drifting box, which fades once a picture is in.
var MOVER_START = /\n([ \t]*)RandomMoveItem \{(?=\n)/g;
var MOVER_ID = /(\n([ \t]*)id: element)(?=\n)/g;

/*
 * The picture frame's pictures (lib/art) as the No Signal screen: the same
 * address it asks, each picture fading into the next and drifting slowly, its
 * label for a moment, always or never, with LG's own "No Signal" above it.
 * It fills the screen even where LG draws its box small, and asks for
 * pictures only while it shows, letting them go when it does not.
 */
function artBlock(indent, api) {
  var lines = [
    'Item {',
    '    id: glasshouseArt',
    '    property bool active: currentKey === "noSignal" && screensaverRoot.visible',
    '    property string api: ' + JSON.stringify(api),
    '    property string origin: api.split("/api/")[0]',
    '    property real t: Math.random() * 10000',
    '    property int seconds: 600',
    '    property int seq: -1',
    '    property string commandUrl: api.replace("/api/art/next", "/api/art/command") + (api.indexOf("?") === -1 ? "?" : "&") + "view=nosignal"',
    '    property string fit: "fit"',
    '    property string caption: "brief"',
    '    property bool started: false',
    '    property var info: null',
    '    property bool labelUp: false',
    '    property int corner: Math.floor(Math.random() * 4)',
    '    property real k: height / 1080',
    '    visible: active',
    '    x: -screensaverRoot.x',
    '    y: -screensaverRoot.y',
    '    width: screensaverRoot.parent ? screensaverRoot.parent.width : screensaverRoot.width',
    '    height: screensaverRoot.parent ? screensaverRoot.parent.height : screensaverRoot.height',
    '    onActiveChanged: {',
    '        if (active) { glasshouseArtAsk.interval = 300; glasshouseArtAsk.restart(); return; }',
    '        glasshouseArtAsk.stop();',
    '        seq = -1;',
    '        glasshouseArtOut.stop();',
    '        started = false;',
    '        labelUp = false;',
    '        glasshouseArtA.waiting = false; glasshouseArtA.opacity = 0; glasshouseArtA.source = "";',
    '        glasshouseArtB.waiting = false; glasshouseArtB.opacity = 0; glasshouseArtB.source = "";',
    '    }',
    '    function later(seconds) { glasshouseArtAsk.interval = Math.max(1, seconds) * 1000; glasshouseArtAsk.restart(); }',
    '    function ask(dir) {',
    '        if (!active) return;',
    '        var x = new XMLHttpRequest();',
    '        x.onreadystatechange = function () {',
    '            if (x.readyState !== XMLHttpRequest.DONE) return;',
    '            var d = null;',
    '            try { d = JSON.parse(x.responseText); } catch (e) { d = null; }',
    '            if (!d) { later(30); return; }',
    '            if (d.seconds) seconds = d.seconds;',
    '            if (seq < 0 && typeof d.seq === "number") seq = d.seq;',
    '            if (d.fit) fit = d.fit;',
    '            if (d.caption) caption = d.caption;',
    '            if (!d.ok || !d.image) { later(d.waiting ? 10 : 60); return; }',
    '            var f = glasshouseArtA.opacity > 0.5 ? glasshouseArtB : glasshouseArtA;',
    '            f.details = d.info || null;',
    '            f.seed = Math.random() * 1000;',
    '            f.fadeMs = dir ? 800 : 3000;',
    '            f.waiting = true;',
    '            f.source = "";',
    '            f.source = origin + d.image;',
    '        };',
    '        x.open("GET", api + (dir ? (api.indexOf("?") === -1 ? "?" : "&") + "dir=" + dir : ""));',
    '        x.send();',
    '    }',
    '    function shown(f) {',
    '        var other = f === glasshouseArtA ? glasshouseArtB : glasshouseArtA;',
    '        other.fadeMs = f.fadeMs;',
    '        f.z = 2; other.z = 1;',
    '        f.opacity = 1; other.opacity = 0;',
    '        started = true;',
    '        labelUp = false;',
    '        info = f.details;',
    '        corner = (corner + 1 + Math.floor(Math.random() * 3)) % 4;',
    '        glasshouseArtIn.restart();',
    '        later(seconds);',
    '    }',
    '    function poll() {',
    '        if (!active) return;',
    '        var x = new XMLHttpRequest();',
    '        x.onreadystatechange = function () {',
    '            if (x.readyState !== XMLHttpRequest.DONE) return;',
    '            var d = null;',
    '            try { d = JSON.parse(x.responseText); } catch (e) { d = null; }',
    '            if (!d || typeof d.seq !== "number") return;',
    '            if (seq < 0) { seq = d.seq; return; }',
    '            if (d.seq === seq) return;',
    '            seq = d.seq;',
    '            glasshouseArtAsk.stop();',
    '            ask(d.dir === "prev" ? "prev" : "next");',
    '        };',
    '        x.open("GET", commandUrl);',
    '        x.send();',
    '    }',
    '    Timer { id: glasshouseArtAsk; interval: 300; onTriggered: glasshouseArt.ask("") }',
    '    Timer { interval: 1500; running: glasshouseArt.active; repeat: true; onTriggered: glasshouseArt.poll() }',
    '    Timer { interval: 1000; running: glasshouseArt.active; repeat: true; onTriggered: glasshouseArt.t += 1 }',
    '    Timer {',
    '        id: glasshouseArtIn',
    '        interval: 3000',
    '        onTriggered: {',
    '            glasshouseArt.labelUp = glasshouseArt.caption !== "off";',
    '            if (glasshouseArt.labelUp && glasshouseArt.caption === "brief") glasshouseArtOut.restart();',
    '        }',
    '    }',
    '    Timer { id: glasshouseArtOut; interval: 20000; onTriggered: glasshouseArt.labelUp = false }',
    '    Rectangle { anchors.fill: parent; color: "black" }'
  ];
  ['glasshouseArtA', 'glasshouseArtB'].forEach(function (id) {
    lines.push(
      '    Image {',
      '        id: ' + id,
      '        property var details: null',
      '        property bool waiting: false',
      '        property real seed: 0',
      '        property int fadeMs: 3000',
      '        property bool filling: glasshouseArt.fit === "fill"',
      '        property real phase: glasshouseArt.t * 2 * Math.PI / 600 + seed',
      '        opacity: 0',
      '        visible: opacity > 0',
      '        Behavior on opacity { NumberAnimation { duration: ' + id + '.fadeMs; easing.type: Easing.InOutQuad } }',
      '        asynchronous: true',
      '        cache: false',
      '        smooth: true',
      '        autoTransform: true',
      '        fillMode: filling ? Image.PreserveAspectCrop : Image.PreserveAspectFit',
      '        sourceSize.width: 1920',
      '        sourceSize.height: 1080',
      '        width: glasshouseArt.width * (filling ? 1.06 : 0.86)',
      '        height: glasshouseArt.height * (filling ? 1.06 : 0.86)',
      '        x: (glasshouseArt.width - width) / 2 + 0.024 * glasshouseArt.width * Math.sin(phase)',
      '        y: (glasshouseArt.height - height) / 2 + 0.024 * glasshouseArt.height * Math.sin(phase * 0.73 + 1.7)',
      '        onStatusChanged: {',
      '            if (!waiting) return;',
      '            if (status === Image.Ready) { waiting = false; glasshouseArt.shown(' + id + '); }',
      '            else if (status === Image.Error) { waiting = false; glasshouseArt.later(20); }',
      '        }',
      '    }'
    );
  });
  lines.push(
    '    Rectangle {',
    '        z: 3',
    '        property real margin: 72 * glasshouseArt.k',
    '        width: glasshouseArtWords.width + 44 * glasshouseArt.k',
    '        height: glasshouseArtWords.height + 32 * glasshouseArt.k',
    '        radius: 4 * glasshouseArt.k',
    '        color: "black"',
    '        opacity: glasshouseArt.started && glasshouseArt.labelUp ? 0.82 : 0',
    '        visible: opacity > 0',
    '        Behavior on opacity { NumberAnimation { duration: 1500 } }',
    '        x: (glasshouseArt.corner % 2) ? glasshouseArt.width - width - margin : margin',
    '        y: glasshouseArt.corner >= 2 ? glasshouseArt.height - height - margin : margin',
    '        Text { id: glasshouseArtCredit; visible: false; text: glasshouseArt.info && glasshouseArt.info.credit ? glasshouseArt.info.credit : ""; font.pixelSize: 19 * glasshouseArt.k }',
    '        Text { id: glasshouseArtTitle; visible: false; text: glasshouseArt.info && glasshouseArt.info.title ? glasshouseArt.info.title : ""; font.pixelSize: 30 * glasshouseArt.k; font.italic: true }',
    '        Column {',
    '            id: glasshouseArtWords',
    '            x: 22 * glasshouseArt.k',
    '            y: 16 * glasshouseArt.k',
    '            spacing: 6 * glasshouseArt.k',
    '            Text { text: headerText.text; visible: text !== ""; color: "#8c8c8c"; font.pixelSize: 19 * glasshouseArt.k; font.capitalization: Font.AllUppercase; font.letterSpacing: 2 * glasshouseArt.k }',
    '            Text { text: glasshouseArt.info && glasshouseArt.info.title ? glasshouseArt.info.title : ""; visible: text !== ""; width: Math.min(glasshouseArtTitle.implicitWidth + 1, 760 * glasshouseArt.k); wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight; color: "#f2f2f2"; font.pixelSize: 30 * glasshouseArt.k; font.italic: true }',
    '            Text { text: glasshouseArt.info ? [glasshouseArt.info.artist, glasshouseArt.info.date].filter(function (s) { return !!s; }).join(", ") : ""; visible: text !== ""; width: Math.min(implicitWidth, 760 * glasshouseArt.k); elide: Text.ElideRight; color: "#c8c8c8"; font.pixelSize: 24 * glasshouseArt.k }',
    '            Text { text: glasshouseArt.info && glasshouseArt.info.credit ? glasshouseArt.info.credit : ""; visible: text !== ""; width: Math.min(glasshouseArtCredit.implicitWidth + 1, 760 * glasshouseArt.k); wrapMode: Text.WordWrap; color: "#8c8c8c"; font.pixelSize: 19 * glasshouseArt.k }',
    '        }',
    '    }',
    '    Rectangle {',
    '        z: 3',
    '        property string line: glasshouseArt.info ? [glasshouseArt.info.artist, glasshouseArt.info.credit].filter(function (s) { return !!s; }).join(" \\u00b7 ") : ""',
    '        width: glasshouseArtSmall.width + 20 * glasshouseArt.k',
    '        height: glasshouseArtSmall.height + 12 * glasshouseArt.k',
    '        radius: 3 * glasshouseArt.k',
    '        color: "black"',
    '        opacity: glasshouseArt.started && !glasshouseArt.labelUp && glasshouseArt.info && glasshouseArt.info.mustCredit ? 0.7 : 0',
    '        visible: opacity > 0',
    '        Behavior on opacity { NumberAnimation { duration: 1500 } }',
    '        x: (glasshouseArt.corner % 2) ? 40 * glasshouseArt.k : glasshouseArt.width - width - 40 * glasshouseArt.k',
    '        y: glasshouseArt.height - height - 36 * glasshouseArt.k',
    '        Text { id: glasshouseArtSmallMeasure; visible: false; text: parent.line; font.pixelSize: 17 * glasshouseArt.k }',
    '        Text { id: glasshouseArtSmall; x: 10 * glasshouseArt.k; y: 6 * glasshouseArt.k; text: parent.line; width: Math.min(glasshouseArtSmallMeasure.implicitWidth + 1, 900 * glasshouseArt.k); wrapMode: Text.WordWrap; color: "#b4b4b4"; font.pixelSize: 17 * glasshouseArt.k }',
    '    }',
    '}'
  );
  return lines.map(function (l) { return indent + l; }).join('\n');
}

function iconBlock(indent) {
  var pad = indent + '    ';
  var body = pad + '    ';
  var lines = [
    indent + 'Canvas {',
    pad + 'id: glasshouseNoSignalIcon',
    pad + 'anchors.horizontalCenter: parent.horizontalCenter',
    pad + 'width: Math.round(128 * screensaverRoot.height / 1080)',
    pad + 'height: Math.round(64 * screensaverRoot.height / 1080)',
    pad + 'visible: currentKey === "noSignal"',
    pad + 'onVisibleChanged: if (visible) requestPaint();',
    pad + 'onWidthChanged: requestPaint();',
    pad + 'onHeightChanged: requestPaint();',
    pad + 'onPaint: {',
    body + 'if (width <= 0 || height <= 0) return;',
    body + 'var ctx = getContext("2d");',
    body + 'var s = width / 128;',
    body + 'ctx.clearRect(0, 0, width, height);',
    body + 'ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";',
    body + 'ctx.lineWidth = Math.max(2, 2.6 * s);',
    body + 'ctx.lineCap = "round";',
    body + 'ctx.lineJoin = "round";',
    body + 'ctx.beginPath();',
    body + 'ctx.moveTo(20 * s, 32 * s);',
    body + 'ctx.lineTo(34 * s, 32 * s);',
    body + 'ctx.moveTo(42 * s, 26 * s);',
    body + 'ctx.lineTo(34 * s, 26 * s);',
    body + 'ctx.lineTo(34 * s, 38 * s);',
    body + 'ctx.lineTo(42 * s, 38 * s);',
    body + 'ctx.moveTo(42 * s, 24 * s);',
    body + 'ctx.lineTo(48 * s, 18 * s);',
    body + 'ctx.lineTo(66 * s, 18 * s);',
    body + 'ctx.lineTo(66 * s, 46 * s);',
    body + 'ctx.lineTo(48 * s, 46 * s);',
    body + 'ctx.lineTo(42 * s, 40 * s);',
    body + 'ctx.closePath();',
    body + 'ctx.moveTo(52 * s, 24 * s);',
    body + 'ctx.lineTo(52 * s, 40 * s);',
    body + 'ctx.moveTo(57 * s, 24 * s);',
    body + 'ctx.lineTo(57 * s, 40 * s);',
    body + 'ctx.moveTo(66 * s, 23 * s);',
    body + 'ctx.lineTo(79 * s, 23 * s);',
    body + 'ctx.lineTo(79 * s, 41 * s);',
    body + 'ctx.lineTo(66 * s, 41 * s);',
    body + 'ctx.moveTo(72.5 * s, 27.5 * s);',
    body + 'ctx.lineTo(72.5 * s, 29.5 * s);',
    body + 'ctx.moveTo(72.5 * s, 34.5 * s);',
    body + 'ctx.lineTo(72.5 * s, 36.5 * s);',
    body + 'ctx.moveTo(95 * s, 12 * s);',
    body + 'ctx.lineTo(95 * s, 23 * s);',
    body + 'ctx.lineTo(108 * s, 23 * s);',
    body + 'ctx.lineTo(108 * s, 41 * s);',
    body + 'ctx.lineTo(95 * s, 41 * s);',
    body + 'ctx.lineTo(95 * s, 52 * s);',
    body + 'ctx.moveTo(101.5 * s, 28 * s);',
    body + 'ctx.lineTo(101.5 * s, 36 * s);',
    body + 'ctx.stroke();',
    pad + '}',
    indent + '}'
  ];
  return lines.join('\n');
}
// An input on screen, which restarting the input app would blank.
var INPUT_IN_FRONT = /^com\.webos\.app\.(hdmi|externalinput|livetv|inputcommon|livemenuplayer|livezoom|acrhdmi|adhdmi)/;
var RETRY_MS = 60000;

var luna = null;
var execFn = execFile;
var stateDir = '/var/lib/tvweb';
var userNoSignalsDir = USER_NOSIGNALS_DIR;
var appQml = APP_QML;
var retryMs = RETRY_MS;
var mountinfo = '/proc/self/mountinfo';
// A restart still owed, kept where a reboot clears it, so a server restart takes it up again.
var pendingFile = '/var/run/tvweb-nosignal-restart';
var retryTimer = null;
var restartPending = false;
// The input open behind an app that holds the restart back, or ''.
var heldBy = '';
var inputNames = {};   // short id (hdmi2) to the input's name, as the Inputs tab shows it

// The input holding the restart back, by its name.
function heldByName() {
  if (!heldBy) return '';
  var short = heldBy.replace(/^com\.webos\.app\./, '');
  var m = /^hdmi(\d)$/.exec(short);
  return inputNames[short] || (m ? 'HDMI ' + m[1] : short);
}
var lastProblem = '';
var config = {};
var webosMajor = 0;
var customCache = null;

// Art's next picture, as the screen saver asks for it, with the token.
function artUrl() {
  var port = config.port || 8080;
  return 'http://127.0.0.1:' + port + '/api/art/next' + (config.token ? '?k=' + encodeURIComponent(config.token) : '');
}

function customUrl(id, mainFile) {
  var port = config.port || 8080;
  return 'http://127.0.0.1:' + port + '/nosignal/' + encodeURIComponent(id) + '/' + encodeURIComponent(mainFile);
}

/*
 * Community No Signal screen wrapper: full-screen Loader inside
 * com.webos.app.inputcommon's Screensaver.qml. LG's drifting box hides while
 * the screen signals ready (hidesLg), and comes back after 3 s if loading stalls.
 */
function customNoSignalBlock(indent, loadUrl) {
  var lines = [
    'Item {',
    '    id: glasshouseCustomNoSignal',
    '    property bool active: currentKey === "noSignal" && screensaverRoot.visible',
    '    property bool late: false',
    '    property bool itemHides: glasshouseCustomNoSignalLoader.item && glasshouseCustomNoSignalLoader.item.hidesLg !== undefined ? !!glasshouseCustomNoSignalLoader.item.hidesLg : (glasshouseCustomNoSignalLoader.status === Loader.Ready)',
    '    property bool hidesLg: glasshouseCustomNoSignalLoader.status === Loader.Ready ? itemHides : (!late && glasshouseCustomNoSignalLoader.status !== Loader.Error)',
    '    visible: active',
    '    x: -screensaverRoot.x',
    '    y: -screensaverRoot.y',
    '    width: screensaverRoot.parent ? screensaverRoot.parent.width : screensaverRoot.width',
    '    height: screensaverRoot.parent ? screensaverRoot.parent.height : screensaverRoot.height',
    '    onActiveChanged: { if (active) late = false; }',
    '    Timer { interval: 3000; running: glasshouseCustomNoSignal.active && glasshouseCustomNoSignalLoader.status !== Loader.Ready; onTriggered: glasshouseCustomNoSignal.late = true }',
    '    Rectangle { anchors.fill: parent; color: "black" }',
    '    Loader {',
    '        id: glasshouseCustomNoSignalLoader',
    '        anchors.fill: parent',
    '        asynchronous: true',
    '        active: glasshouseCustomNoSignal.active',
    '        source: active ? ' + JSON.stringify(loadUrl) + ' : ""',
    '        onLoaded: { if (item && item.headingText !== undefined) item.headingText = Qt.binding(function () { return headerText.text; }); }',
    '    }',
    '}'
  ];
  return lines.map(function (l) { return indent + l; }).join('\n');
}

function manifestText(v) {
  if (typeof v === 'string' && v) return { en: v };
  if (v && typeof v === 'object' && typeof v.en === 'string' && v.en) return v;
  return null;
}

function scanFiles(dir) {
  var out = [];
  (function walk(rel) {
    var entries = fs.readdirSync(path.join(dir, rel));
    for (var i = 0; i < entries.length; i++) {
      var r = rel ? rel + '/' + entries[i] : entries[i];
      var st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push({ rel: r, size: st.size });
    }
  })('');
  return out;
}

function readCustomDir(dir, id) {
  var localId = USER_PREFIX + id;
  var entry = {
    id: id,
    localId: localId,
    dir: dir,
    label: id,
    description: '',
    author: '',
    license: '',
    homepage: '',
    version: '',
    main: 'main.qml',
    cautions: []
  };
  function problem(text) { entry.problem = text; return entry; }
  if (!ID_RE.test(id)) {
    return problem(msg('srv.saver.badFolder', 'Its folder name, "{name}", can only have lowercase letters, digits and -, starting with a letter or digit, up to 32 characters.', { name: id }));
  }
  var m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, NS_MANIFEST), 'utf8')); }
  catch (err) {
    return problem(msg('srv.saver.badManifest', '{file} could not be read: {error}', { file: NS_MANIFEST, error: err.message }));
  }
  if (!m || typeof m !== 'object') return problem(msg('srv.saver.notObject', '{file} is not a JSON object.', { file: NS_MANIFEST }));
  var name_ = manifestText(m.name), desc = manifestText(m.description);
  if (name_) entry.label = say.define('nosignal.' + localId + '.name', name_.en, name_);
  if (desc) entry.description = say.define('nosignal.' + localId + '.desc', desc.en, desc);
  entry.version = typeof m.version === 'string' ? m.version : '';
  entry.author = typeof m.author === 'string' ? m.author : '';
  entry.license = typeof m.license === 'string' ? m.license : '';
  entry.homepage = typeof m.homepage === 'string' ? m.homepage : '';
  if (m.manifest !== NS_MANIFEST_FORMAT) {
    return problem(msg('srv.saver.format', '{file} is in format {format}, and this Glasshouse reads format {known}.',
                       { file: NS_MANIFEST, format: String(m.manifest), known: String(NS_MANIFEST_FORMAT) }));
  }
  if (!name_ || !desc || !entry.version) {
    return problem(msg('srv.saver.missing', '{file} needs a name, a description and a version.', { file: NS_MANIFEST }));
  }
  entry.main = m.main === undefined ? 'main.qml' : m.main;
  if (typeof entry.main !== 'string' || !/^[\w.-]+\.qml$/.test(entry.main)) {
    return problem(msg('srv.nosignal.badMain', '{file}: main must name a .qml file.', { file: NS_MANIFEST }));
  }
  var need = m.requires && typeof m.requires.webos === 'number' ? m.requires.webos : 0;
  if (need && webosMajor && webosMajor < need) {
    return problem(msg('srv.saver.needsWebos', 'It needs webOS {need} or later.', { need: String(need) }));
  }
  var files;
  try { files = scanFiles(dir); }
  catch (err2) { return problem(msg('srv.saver.unreadable', 'Its folder could not be read: {error}', { error: err2.message })); }
  var bytes = 0, hasMain = false;
  for (var i = 0; i < files.length; i++) {
    bytes += files[i].size;
    if (files[i].rel === entry.main) hasMain = true;
  }
  if (!hasMain) return problem(msg('srv.saver.noMain', '{main} is missing from its folder.', { main: entry.main }));
  if (files.length > MAX_NS_FILES || bytes > MAX_NS_BYTES) {
    return problem(msg('srv.saver.tooBig', 'Its folder is over the limit of {files} files and {mb} MB.',
                       { files: String(MAX_NS_FILES), mb: String(MAX_NS_BYTES / 1048576) }));
  }
  var sources = [];
  for (var k = 0; k < files.length; k++) {
    if (!/\.qml$/i.test(files[k].rel)) continue;
    var src;
    try { src = fs.readFileSync(path.join(dir, files[k].rel), 'utf8'); }
    catch (err3) { return problem(msg('srv.saver.unreadable', 'Its folder could not be read: {error}', { error: err3.message })); }
    var wrong = qmlcheck.problem(src, files[k].rel, webosMajor || 0);
    if (wrong) return problem(wrong);
    sources.push(src);
  }
  entry.cautions = qmlcheck.reaches(sources.join('\n'));
  return entry;
}

function validateFolder(dir, name) {
  var e = readCustomDir(dir, name);
  return { ok: !e.problem, screen: e, error: e.problem || null };
}

function scanCustom() {
  var list = [], byId = {};
  var entries = [];
  try { entries = fs.readdirSync(userNoSignalsDir); } catch (e) { entries = []; }
  entries.sort();
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    if (name.charAt(0) === '.') continue;
    var full = path.join(userNoSignalsDir, name);
    var st;
    try { st = fs.lstatSync(full); } catch (e2) { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    var e = readCustomDir(full, name);
    list.push(e);
    byId[e.localId] = e;
  }
  customCache = { list: list, byId: byId };
  return customCache;
}

function customCatalog() {
  return customCache || scanCustom();
}

function invalidateCatalog() {
  customCache = null;
}

function listCustom() {
  var raw = customCatalog().list;
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i];
    out.push({
      id: s.id,
      localId: s.localId,
      label: s.label,
      description: s.description,
      author: s.author,
      license: s.license,
      homepage: s.homepage,
      version: s.version,
      main: s.main,
      cautions: s.cautions,
      problem: s.problem || null
    });
  }
  return out;
}

function resolve(id, relPath) {
  if (!ID_RE.test(String(id || '')) || typeof relPath !== 'string' || !relPath) return null;
  if (relPath.indexOf('\\') !== -1 || relPath.charAt(0) === '/') return null;
  var parts = relPath.split('/');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..' || parts[i].charAt(0) === '.') return null;
  }
  var base = path.resolve(path.join(userNoSignalsDir, id));
  var cur = base;
  try {
    var baseSt = fs.lstatSync(base);
    if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) return null;
    for (var j = 0; j < parts.length; j++) {
      cur = path.join(cur, parts[j]);
      var st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) return null;
      if (j < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return null;
    }
  } catch (e) { return null; }
  if (path.resolve(cur).indexOf(base + path.sep) !== 0) return null;
  return { file: cur };
}

function init(opts) {
  opts = opts || {};
  luna = opts.luna || null;
  config = opts.config || {};
  execFn = opts.exec || execFile;
  stateDir = opts.stateDir || '/var/lib/tvweb';
  userNoSignalsDir = opts.userNoSignalsDir || (opts.stateDir && opts.stateDir !== '/var/lib/tvweb' ? path.join(stateDir, 'nosignals') : USER_NOSIGNALS_DIR);
  appQml = opts.appQml || APP_QML;
  retryMs = opts.retryMs || RETRY_MS;
  mountinfo = opts.mountinfo || '/proc/self/mountinfo';
  pendingFile = opts.pendingFile || '/var/run/tvweb-nosignal-restart';
  webosMajor = opts.webos ? parseInt(String(opts.webos), 10) : 0;
  customCache = null;
  restartPending = false;
  heldBy = '';
  inputNames = opts.inputNames || {};
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function flagFile() { return path.join(stateDir, 'nosignal_plain'); }
function ownDir() { return path.join(stateDir, 'nosignal'); }
function ownFile() { return path.join(ownDir(), 'Screensaver.qml'); }
function origFile() { return path.join(ownDir(), 'Screensaver.lg.qml'); }

function normalizeMode(val) {
  if (val === 'icon') return 'icon';
  if (val === 'art') return 'art';
  if (typeof val === 'string' && val.indexOf(USER_PREFIX) === 0 && ID_RE.test(val.slice(USER_PREFIX.length))) return val;
  if (val === 'plain' || val === true || val === 'on' || val === 'true') return 'plain';
  return 'lg';
}

function validCustomEntry(mode) {
  if (typeof mode !== 'string' || mode.indexOf(USER_PREFIX) !== 0) return null;
  var e = customCatalog().byId[mode];
  return e && !e.problem ? e : null;
}

function wanted() {
  if (!fs.existsSync(flagFile())) return 'lg';
  try {
    var saved = fs.readFileSync(flagFile(), 'utf8').trim();
    if (saved === 'icon' || saved === 'art') return saved;
    if (saved.indexOf(USER_PREFIX) === 0 && ID_RE.test(saved.slice(USER_PREFIX.length))) {
      return validCustomEntry(saved) ? saved : 'lg';
    }
    return 'plain';
  } catch (e) {
    return 'plain';
  }
}

function modeLabel(mode) {
  if (mode === 'icon') return 'disconnected-cable';
  if (mode === 'art') return 'picture frame';
  if (mode === 'plain') return 'plain';
  var custom = validCustomEntry(mode);
  if (custom) return custom.label || custom.id;
  return 'LG\'s';
}

function target() {
  for (var i = 0; i < CANDIDATES.length; i++) {
    var f = appQml + CANDIDATES[i];
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Whether this server's copy is mounted over the file.
function mounted(file) {
  var info;
  try { info = fs.readFileSync(mountinfo, 'utf8'); } catch (e) { return false; }
  return info.split('\n').some(function (line) {
    var parts = line.split(' ');
    return parts[4] === file && parts[3] && parts[3].indexOf('/nosignal/') !== -1;
  });
}

function replaceIfUnique(text, find, replacement) {
  var found = text.match(find);
  if (!found || found.length !== 1) return text;
  return text.replace(find, replacement);
}

/*
 * The TV's own file patched for the requested mode ('plain', 'icon', 'art'
 * or 'user-<id>'), or null where a line this looks for is not there exactly once.
 */
function patch(text, mode, artApi) {
  var out = String(text || '');
  for (var i = 0; i < PATCHES.length; i++) {
    var found = out.match(PATCHES[i].find);
    if (!found || found.length !== 1) return null;
    out = out.replace(PATCHES[i].find, '$1' + PATCHES[i].add);
  }
  out = replaceIfUnique(out, PHOTO_MODEL, '$1({ enabled: false, currentIdx: 0, imgArray: [] })');
  out = replaceIfUnique(out, MOVER_PHOTO_VISIBLE, '$1 && (currentKey === "noSignal" || ($2))');
  if (mode === 'icon') {
    var heads = out.match(HEADER_START);
    if (!heads || heads.length !== 1) return null;
    out = out.replace(HEADER_START, function (match, indent) {
      return '\n' + iconBlock(indent) + match;
    });
    var ids = out.match(HEADER_ID);
    if (!ids || ids.length !== 1) return null;
    out = out.replace(HEADER_ID, function (match, line, indent) {
      return line + '\n' + indent + 'visible: currentKey !== "noSignal"';
    });
  }
  var custom = validCustomEntry(mode);
  if (mode === 'art' || custom || (typeof mode === 'string' && mode.indexOf(USER_PREFIX) === 0)) {
    if (typeof mode === 'string' && mode.indexOf(USER_PREFIX) === 0 && !custom) return null;
    var movers = out.match(MOVER_START);
    if (!movers || movers.length !== 1) return null;
    var moverIds = out.match(MOVER_ID);
    if (!moverIds || moverIds.length !== 1) return null;
    var blockId = custom ? 'glasshouseCustomNoSignal' : 'glasshouseArt';
    var hidesProp = custom ? 'hidesLg' : 'started';
    out = out.replace(MOVER_START, function (match, indent) {
      var blk = custom
        ? customNoSignalBlock(indent, customUrl(custom.id, custom.main))
        : artBlock(indent, artApi || artUrl());
      return '\n' + blk + match;
    });
    out = out.replace(MOVER_ID, function (match, line, indent) {
      return line + '\n' + indent + 'opacity: currentKey === "noSignal" && ' + blockId + '.' + hidesProp + ' ? 0 : 1';
    });
  }
  return out;
}

function problem(text) {
  if (text !== lastProblem) console.error('nosignal: ' + text);
  lastProblem = text;
}

/*
 * Whether the input an app shows has nothing coming in: the input manager's
 * `activate` for it is false (an empty HDMI port on a B8 and a C2, and a C2's
 * port with a device connected but sending nothing). Anything else, a failed
 * call included, counts as a picture.
 */
function nothingComingIn(reply, appId) {
  var devices = reply && Array.isArray(reply.devices) ? reply.devices : [];
  for (var i = 0; i < devices.length; i++) {
    if (devices[i] && devices[i].appId === appId) return devices[i].activate === false;
  }
  return false;
}

// An input SAM lists as running other than the one in front, or ''.
function inputsBehind(running, front) {
  for (var i = 0; i < running.length; i++) {
    var id = running[i] && running[i].id;
    if (typeof id === 'string' && id !== INPUT_APP && id !== front && INPUT_IN_FRONT.test(id)) return id;
  }
  return '';
}

/*
 * Restarts the input app: now if no input is in front or the one in front has
 * nothing coming in, otherwise once that is so.
 */
function restartWhenFree() {
  restartPending = true;
  try { fs.writeFileSync(pendingFile, '1\n', 'utf8'); } catch (e) { /* asked again only until the server restarts */ }
  if (retryTimer) return;
  var ask = luna ? luna : function (uri, params, cb) { cb(null); };
  var later = function () {
    retryTimer = setTimeout(check, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  };
  // reopen: the input in front. On webOS 9 (a C2) the input closes with the
  // input app and Home opens; on webOS 4 (a B8) it stays, and opening it again
  // changes nothing.
  var restart = function (reopen) {
    restartPending = false;
    heldBy = '';
    try { fs.unlinkSync(pendingFile); } catch (e) { /* not there */ }
    execFn('/usr/bin/killall', [INPUT_APP], { timeout: 5000 }, function () {
      console.log('nosignal: the input app restarted, so its No Signal screen is ' + modeLabel(wanted()));
      if (reopen) ask('com.webos.applicationManager/launch', { id: reopen }, function () {});
    });
  };
  var check = function () {
    retryTimer = null;
    if (!restartPending) return;
    ask('com.webos.applicationManager/getForegroundAppInfo', {}, function (r) {
      var appId = r && typeof r.appId === 'string' ? r.appId : '';
      ask('com.webos.applicationManager/running', {}, function (rr) {
        if (!restartPending) return;
        // Not known which apps run: asked again later, as one may be an input.
        if (!rr || !Array.isArray(rr.running)) return later();
        var behind = inputsBehind(rr.running, appId);
        if (behind) {
          if (behind !== heldBy) console.log('nosignal: the input app restarts once ' + behind + ', open behind ' + (appId || 'another app') + ', is closed');
          heldBy = behind;
          return later();
        }
        heldBy = '';
        if (!INPUT_IN_FRONT.test(appId)) return restart(null);
        ask('com.webos.service.eim/getAllInputStatus', {}, function (inputs) {
          if (!restartPending) return;
          if (nothingComingIn(inputs, appId)) restart(appId);
          else later();
        });
      });
    });
  };
  check();
}

/*
 * Mounts the copy, or takes it away, to match the setting. cb({ ok, ... }) once
 * the mount is done; the input app's restart may follow later.
 */
function writePatched(text, mode, saveOrig) {
  var next = patch(text, mode);
  if (!next) {
    problem('this firmware\'s No Signal screen is not the one known, so it is left as LG made it');
    return null;
  }
  try {
    util.mkdirp(ownDir());
    if (saveOrig) fs.writeFileSync(origFile(), text, 'utf8');
    fs.writeFileSync(ownFile(), next, 'utf8');
  } catch (e) {
    problem('could not write the ' + modeLabel(mode) + ' No Signal screen: ' + e.message);
    return null;
  }
  return next;
}

function mountOwn(file, mode, cb) {
  execFn('/bin/mount', ['--bind', ownFile(), file], { timeout: 5000 }, function (err) {
    if (err) problem('could not mount the ' + modeLabel(mode) + ' No Signal screen: ' + err.message);
    else {
      lastProblem = '';
      console.log('nosignal: the ' + modeLabel(mode) + ' No Signal screen is mounted');
      restartWhenFree();
    }
    cb(status());
  });
}

function apply(cb) {
  cb = cb || function () {};
  var file = target();
  if (!file) return cb(status());
  var mode = wanted();
  // Clean up flag if a previously selected custom screen was deleted outside set().
  if (mode === 'lg' && fs.existsSync(flagFile())) {
    try {
      var saved = fs.readFileSync(flagFile(), 'utf8').trim();
      if (saved.indexOf(USER_PREFIX) === 0 && !validCustomEntry(saved)) fs.unlinkSync(flagFile());
    } catch (e) {}
  }
  var on = mode !== 'lg', isMounted = mounted(file);
  if (on && !isMounted) {
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      problem('could not read the No Signal screen: ' + e.message);
      return cb(status());
    }
    if (!writePatched(text, mode, true)) return cb(status());
    return mountOwn(file, mode, cb);
  }
  if (on && isMounted) {
    if (!fs.existsSync(origFile())) {
      // Upgraded while plain was mounted: recover LG's copy before re-patching.
      return execFn('/bin/umount', [file], { timeout: 5000 }, function (err) {
        if (err) {
          problem('could not unmount the No Signal screen: ' + err.message);
          return cb(status());
        }
        var raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
          problem('could not read the No Signal screen: ' + e.message);
          return cb(status());
        }
        if (!writePatched(raw, mode, true)) return cb(status());
        mountOwn(file, mode, cb);
      });
    }
    var origText, currentOwn = '';
    try { origText = fs.readFileSync(origFile(), 'utf8'); } catch (e2) {
      problem('could not read the saved No Signal screen: ' + e2.message);
      return cb(status());
    }
    try { currentOwn = fs.readFileSync(ownFile(), 'utf8'); } catch (e3) { /* rewrite */ }
    var targetOwn = patch(origText, mode);
    if (!targetOwn) {
      problem('this firmware\'s No Signal screen is not the one known, so it is left as LG made it');
      return cb(status());
    }
    if (currentOwn !== targetOwn) {
      if (!writePatched(origText, mode, false)) return cb(status());
      lastProblem = '';
      console.log('nosignal: switched to the ' + modeLabel(mode) + ' No Signal screen');
      restartWhenFree();
    } else if (!restartPending && fs.existsSync(pendingFile)) {
      restartWhenFree();
    }
    return cb(status());
  }
  if (!on && isMounted) {
    return execFn('/bin/umount', [file], { timeout: 5000 }, function (err) {
      if (err) problem('could not unmount the No Signal screen: ' + err.message);
      else { lastProblem = ''; console.log('nosignal: LG\'s No Signal screen is back'); restartWhenFree(); }
      cb(status());
    });
  }
  if (!restartPending && fs.existsSync(pendingFile)) restartWhenFree();
  cb(status());
}

function set(val, cb) {
  var mode = normalizeMode(val);
  if (mode.indexOf(USER_PREFIX) === 0) {
    var entry = customCatalog().byId[mode];
    if (!entry) return cb({ ok: false, error: msg('srv.community.unknown', 'Unknown community item.') });
    if (entry.problem) return cb({ ok: false, error: entry.problem });
  }
  try {
    if (mode === 'lg') {
      if (fs.existsSync(flagFile())) fs.unlinkSync(flagFile());
    } else {
      fs.writeFileSync(flagFile(), mode + '\n', 'utf8');
    }
  } catch (e) { return cb({ ok: false, error: e.message }); }
  apply(cb);
}

// What the dashboards show: offered where the TV has the screen this knows.
function status() {
  var file = target(), mode = wanted(), available = false, art = false;
  var customScreens = listCustom();
  if (file) {
    var isMounted = mounted(file);
    // Mounted, the TV's own is the copy kept beside ours.
    var lgText = null;
    try { lgText = fs.readFileSync(isMounted ? origFile() : file, 'utf8'); } catch (e) { lgText = null; }
    available = isMounted || (lgText !== null && !!patch(lgText, 'icon'));
    art = lgText !== null && !!patch(lgText, 'art');
    return { ok: true, available: available, art: art, custom: art, customScreens: customScreens, on: mode !== 'lg', mode: mode, applied: isMounted, restartPending: restartPending, heldBy: restartPending ? heldByName() : '' };
  }
  return { ok: true, available: false, art: false, custom: false, customScreens: customScreens, on: mode !== 'lg', mode: mode, applied: false, restartPending: false, heldBy: '' };
}

module.exports = {
  init: init,
  apply: apply,
  set: set,
  status: status,
  patch: patch,
  validateFolder: validateFolder,
  listCustom: listCustom,
  invalidateCatalog: invalidateCatalog,
  resolve: resolve,
  USER_NOSIGNALS_DIR: USER_NOSIGNALS_DIR
};
