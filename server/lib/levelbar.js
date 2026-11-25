/*
 * lib/levelbar.js - what the level bar of a Brightness key shows, and where it gets it
 *
 * A Brightness key (lib/remotekeys.js) opens the input bar's app
 * (assets/inputbar-app) with the level it has set, and the app's page asks the
 * server for the panel's level every 120 ms while the key is held. This module
 * answers those asks and holds what the bar's two styles need.
 *
 * The level: each luna call is a fork and exec of luna-send, so the answer
 * comes from a subscription to the settings service's backlight, one
 * long-lived luna-send started by the first ask and stopped idleMs after the
 * last. Until the subscription has answered, or after it has closed, the ask
 * is made of the settings service itself.
 *
 * The style, 'lg' (a vertical bar at the right edge, laid out like the TV's
 * own volume bar), 'horizontal' (a pill low on the screen), 'vertical' (the same
 * pill upright at the right edge) or 'none' (no bar: the keys change the
 * brightness and show nothing), is read through the function remotekeys.js
 * gives, at most every STYLE_CACHE_MS.
 *
 * It also gives the part of the key filter that opens the bar, which the
 * filter's own source (remotekeys.js's filterSource) places in itself. On
 * webOS 10 and below the filter runs inside the compositor, so every style is
 * drawn there as a QML item beside LG's own volume bar (COMPOSITOR_BAR_QML),
 * made once and then only shown and hidden as LG's is: no app is launched for a
 * press. The bar's app is the fallback where the item cannot be made.
 *
 * Strict ES5: runs on node 0.12.
 */
var STYLES = ['lg', 'horizontal', 'vertical', 'none'];
var BACKLIGHT_IDLE_MS = 30000;
var STYLE_CACHE_MS = 2000;

var lunaFn = null;
var SubscriptionCtor = null; // luna.Subscription
var readStyleFn = function () { return 'lg'; };
var idleMs = BACKLIGHT_IDLE_MS;

var sub = null;
var level = -1;              // -1: not known
var idleTimer = null;
var styleCache = { value: 'lg', at: 0 };

/*
 * opts.luna: the function that calls a luna service, opts.subscription:
 * luna.Subscription, opts.readStyle: () => 'lg' | 'horizontal' | 'vertical' | 'none' as kept,
 * opts.idleMs: how long the subscription stays after the last ask.
 */
function init(opts) {
  opts = opts || {};
  stop();
  lunaFn = opts.luna || null;
  SubscriptionCtor = opts.subscription || null;
  readStyleFn = typeof opts.readStyle === 'function' ? opts.readStyle : function () { return 'lg'; };
  idleMs = typeof opts.idleMs === 'number' ? opts.idleMs : BACKLIGHT_IDLE_MS;
  styleCache.at = 0;
}

function isStyle(value) {
  return STYLES.indexOf(value) !== -1;
}

// The style changed: the next ask reads it again.
function forgetStyle() {
  styleCache.at = 0;
}

function styleForAsk() {
  var now = Date.now();
  if (now - styleCache.at > STYLE_CACHE_MS || now < styleCache.at) styleCache = { value: readStyleFn(), at: now };
  return styleCache.value;
}

function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (sub) { sub.stop(); sub = null; }
  level = -1;
}

function backlightMessage(r) {
  var n = r && r.returnValue !== false && r.settings ? Math.round(parseFloat(r.settings.backlight)) : NaN;
  level = isNaN(n) ? -1 : n;
}

function watch() {
  if (!SubscriptionCtor) return;
  if (!sub) {
    sub = new SubscriptionCtor('com.webos.settingsservice/getSystemSettings',
      { category: 'picture', keys: ['backlight'], subscribe: true }, null,
      { message: backlightMessage, close: function () { level = -1; } });
    sub.start();
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, idleMs);
  if (idleTimer.unref) idleTimer.unref();
}

// The current picture mode's brightness and the bar's style, for the bar's page to follow while a key is held. cb({ ok, level, style }).
function getBrightness(cb) {
  if (!lunaFn) return cb({ ok: false });
  watch();
  if (level >= 0) return cb({ ok: true, level: level, style: styleForAsk() });
  lunaFn('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['backlight'] }, function (r) {
    var n = r && r.settings ? parseFloat(r.settings.backlight) : NaN;
    cb(isNaN(n) ? { ok: false } : { ok: true, level: Math.round(n), style: styleForAsk() });
  });
}

/*
 * The level bar as a QML item in the compositor, made once and then only shown
 * and hidden, as LG's own volume bar is: no app is launched for a press. It has
 * four looks, chosen by the style and by what this TV has:
 *
 *   lg       LG's volume bar (WebOSCompositor's views/volume/StarfishVolume.qml
 *            and the "volume" block of StarfishDefaultSettings.qml): sizes at
 *            1920x1080 scaled to the screen, LG's own track, fill and arrow
 *            pictures read from the TV at run time, the level in LG Smart UI 85
 *            at its normal weight (LG sets the family as its language-style.js
 *            gives it, and no weight) with a shadow, a 150 ms fade and 1.5 s on
 *            screen. Used where every one of the pictures loads and the
 *            compositor's volume view holds LG's volume bar.
 *   lgdrawn  The same layout drawn with shapes (a tube 18 x 552 with a 1 px
 *            outline, a fill, + and -), where LG's pictures are not there.
 *   h, v     The pill, low on the screen and upright at the right edge, as the
 *            bar's app draws them (assets/inputbar-app).
 *
 * The sun is drawn in all of them, as LG has no picture of one: about as big
 * as LG's speaker in ic_speaker.png, 38 across with 3 wide strokes.
 *
 * show(level, style) returns true once it has drawn the level, so the filter
 * opens the bar's app only where the item could not be made. Where the look is
 * at the right edge, showing it closes LG's volume bar early, and LG's volume
 * bar or mute icon opening keeps this one drawn until LG's has faded in under
 * it and then fades it out, so the track stays drawn throughout; LG's mute icon
 * is never closed, as it stays while the TV is muted and LG shows it again only
 * at the next volume change.
 */
var COMPOSITOR_BAR = 'glasshouseBrightnessBar';
var COMPOSITOR_BAR_QML = [
  'import QtQuick 2.4',
  'import QtGraphicalEffects 1.0',
  'Item {',
  '    id: bar',
  '    objectName: "glasshouseBrightnessBar"',
  '    anchors.fill: parent',
  '    enabled: false',
  '    opacity: 0',
  '    visible: opacity > 0',
  '    // The screen in units of 1920 x 1080, as LG scales its own views.',
  '    property real s: width > 0 ? width / 1920 : 1',
  '    // LG\'s imagePath: its 4k and qhd pictures at exactly 2 and 4/3, the 1080p ones otherwise.',
  '    property string img: "file:///usr/lib/qml/WebOSCompositor/images/" + (Math.abs(s - 2) < 0.000001 ? "4k/" : Math.abs(s - 4 / 3) < 0.000001 ? "qhd/" : "")',
  '    property int level: 0',
  '    // lg: LG\'s own pictures; lgdrawn: the same layout drawn; h and v: the pill, low on the screen and upright at the right edge.',
  '    property string mode: "lg"',
  '    property string digits: String(level)',
  '    property var digitWidths: [51, 39, 48, 49, 50, 48, 51, 45, 51, 51]',
  '    property var iconMargins: [18, 81, 131, 171]',
  '    property string family: "\\"LG Smart UI\\",\\"LG Smart UI Dingbat\\""',
  '    // LG\'s volume bar and mute icon (StarfishVolume, StarfishVolumeMute), set by the filter.',
  '    property Item volumeBar: null',
  '    property Item volumeMute: null',
  '    // Whether every picture of LG\'s bar loaded from this TV.',
  '    property bool ready: trackImage.status === Image.Ready && fillImage.status === Image.Ready && capTop.status === Image.Ready &&',
  '                         capBottom.status === Image.Ready && arrowUp.status === Image.Ready && arrowDown.status === Image.Ready',
  '    // LG\'s pictures are used where they all loaded and the compositor\'s volume view is LG\'s: that is where this layout comes from.',
  '    property bool nativeLook: ready && volumeBar !== null',
  '    // The pill low on the screen does not meet LG\'s volume bar; the other looks are at its place.',
  '    property bool rightEdge: mode !== "h"',
  '    function show(value, style) {',
  '        mode = style === "horizontal" ? "h" : style === "vertical" ? "v" : (nativeLook ? "lg" : "lgdrawn");',
  '        level = Math.max(0, Math.min(100, Math.round(value)));',
  '        fade.stop();',
  '        opacity = 1;',
  '        hold.restart();',
  '        if (rightEdge && volumeBar && volumeBar.isOpen) volumeBar.closeView();',
  '        return true;',
  '    }',
  '    function hide() { hold.stop(); fade.start(); }',
  '    // Drawn over LG\'s volume view: fading both at once would leave the track at',
  '    // three quarters for a moment, so this one stays until LG\'s has faded in',
  '    // underneath (opened), then fades out over it. Restarting hold on opening',
  '    // keeps it from sticking on screen if opened never arrives.',
  '    function giveWay(done) {',
  '        if (!rightEdge || opacity <= 0) return;',
  '        if (done) { hold.stop(); fade.start(); }',
  '        else hold.restart();',
  '    }',
  '    Connections { target: bar.volumeBar; ignoreUnknownSignals: true; onOpening: bar.giveWay(false); onOpened: bar.giveWay(true) }',
  '    Connections { target: bar.volumeMute; ignoreUnknownSignals: true; onOpening: bar.giveWay(false); onOpened: bar.giveWay(true) }',
  '    Timer { id: hold; interval: bar.mode === "h" || bar.mode === "v" ? 1600 : 1500; onTriggered: fade.start() }',
  '    NumberAnimation { id: fade; target: bar; property: "opacity"; to: 0; duration: 150 }',
  '    Text { id: widest; visible: false; text: "000"; font.family: bar.family; font.pixelSize: 36 * bar.s; font.weight: Font.Medium }',
  '',
  '    // LG\'s layout: the track at the right edge with + above and - below, the sun and the number to its left.',
  '    Item {',
  '        id: indicator',
  '        anchors.fill: parent',
  '        visible: bar.mode === "lg" || bar.mode === "lgdrawn"',
  '        // The box of LG\'s track picture: 36 x 570, the tube 18 x 552 in the middle of it.',
  '        Item {',
  '            id: track',
  '            width: 36 * bar.s',
  '            height: 570 * bar.s',
  '            anchors.right: parent.right',
  '            anchors.rightMargin: 51 * bar.s',
  '            anchors.verticalCenter: parent.verticalCenter',
  '            Image { id: trackImage; anchors.fill: parent; source: bar.img + "vol_bar_bg.png"; visible: bar.mode === "lg" }',
  '            Image {',
  '                id: capTop',
  '                source: bar.img + "vol_gage_top.png"',
  '                anchors.top: parent.top',
  '                anchors.topMargin: 8 * bar.s',
  '                anchors.horizontalCenter: parent.horizontalCenter',
  '                visible: bar.mode === "lg" && bar.level >= 100',
  '            }',
  '            Image {',
  '                id: fillImage',
  '                source: bar.img + "vol_gage.png"',
  '                fillMode: Image.Stretch',
  '                height: Math.max(0, Math.min(534 * bar.s, (bar.level - 1) * 534 * bar.s / 98))',
  '                anchors.bottom: capBottom.top',
  '                anchors.horizontalCenter: parent.horizontalCenter',
  '                visible: bar.mode === "lg" && bar.level > 1',
  '            }',
  '            Image {',
  '                id: capBottom',
  '                source: bar.img + "vol_gage_bottom.png"',
  '                anchors.bottom: parent.bottom',
  '                anchors.bottomMargin: 10 * bar.s',
  '                anchors.horizontalCenter: parent.horizontalCenter',
  '                visible: bar.mode === "lg" && bar.level > 0',
  '            }',
  '            Rectangle {',
  '                id: tube',
  '                visible: bar.mode === "lgdrawn"',
  '                anchors.centerIn: parent',
  '                width: 18 * bar.s',
  '                height: 552 * bar.s',
  '                radius: 9 * bar.s',
  '                color: Qt.rgba(55 / 255, 58 / 255, 65 / 255, 0.66)',
  '                border.width: Math.max(1, bar.s)',
  '                border.color: "#e5e9eb"',
  '                antialiasing: true',
  '            }',
  '            Rectangle {',
  '                visible: bar.mode === "lgdrawn" && bar.level > 0',
  '                width: 18 * bar.s',
  '                height: Math.max(18 * bar.s, Math.round(bar.level * 547 / 100 * bar.s))',
  '                radius: 9 * bar.s',
  '                color: "#e4e7e6"',
  '                anchors.bottom: tube.bottom',
  '                anchors.bottomMargin: 3 * bar.s',
  '                anchors.horizontalCenter: tube.horizontalCenter',
  '                antialiasing: true',
  '            }',
  '        }',
  '        Image { id: arrowUp; source: bar.img + "vol_up.png"; visible: bar.mode === "lg"; anchors.horizontalCenter: track.horizontalCenter; anchors.bottom: track.top; anchors.bottomMargin: -3 * bar.s }',
  '        Image { id: arrowDown; source: bar.img + "vol_dn.png"; visible: bar.mode === "lg"; anchors.horizontalCenter: track.horizontalCenter; anchors.top: track.bottom; anchors.topMargin: -4 * bar.s }',
  '        // The + and - of the drawn look: 17 long and 3.8 thick in a 24 box, 10 above the tube and 9 below it.',
  '        Item {',
  '            visible: bar.mode === "lgdrawn"',
  '            width: 24 * bar.s',
  '            height: width',
  '            anchors.horizontalCenter: track.horizontalCenter',
  '            anchors.bottom: track.top',
  '            anchors.bottomMargin: 1 * bar.s',
  '            Rectangle { anchors.centerIn: parent; width: 17 * bar.s; height: 3.8 * bar.s; radius: height / 2; color: "#e5e9eb"; antialiasing: true }',
  '            Rectangle { anchors.centerIn: parent; width: 3.8 * bar.s; height: 17 * bar.s; radius: width / 2; color: "#e5e9eb"; antialiasing: true }',
  '        }',
  '        Item {',
  '            visible: bar.mode === "lgdrawn"',
  '            width: 24 * bar.s',
  '            height: width',
  '            anchors.horizontalCenter: track.horizontalCenter',
  '            anchors.top: track.bottom',
  '            Rectangle { anchors.centerIn: parent; width: 17 * bar.s; height: 3.8 * bar.s; radius: height / 2; color: "#e5e9eb"; antialiasing: true }',
  '        }',
  '        // A thin sun about as big as LG\'s speaker: 38 across, 3 wide strokes.',
  '        Item {',
  '            id: sun',
  '            width: 72 * bar.s',
  '            height: width',
  '            anchors.verticalCenter: parent.verticalCenter',
  '            anchors.right: track.left',
  '            anchors.rightMargin: bar.iconMargins[bar.digits.length] * bar.s',
  '            layer.enabled: true',
  '            layer.effect: DropShadow { transparentBorder: true; verticalOffset: Math.ceil(2.5 * bar.s); color: "#b3000000"; radius: 8; samples: 17 }',
  '            Rectangle {',
  '                anchors.centerIn: parent',
  '                width: 17 * bar.s',
  '                height: width',
  '                radius: width / 2',
  '                color: "transparent"',
  '                border.width: 3 * bar.s',
  '                border.color: "#E6E5E5"',
  '                antialiasing: true',
  '            }',
  '            // Four bars through the middle, each a ray on either side of the ring.',
  '            Repeater {',
  '                model: 4',
  '                Item {',
  '                    anchors.centerIn: parent',
  '                    width: 38 * bar.s',
  '                    height: 3 * bar.s',
  '                    rotation: index * 45',
  '                    Rectangle { x: 0; width: 7 * bar.s; height: parent.height; radius: height / 2; color: "#E6E5E5"; antialiasing: true }',
  '                    Rectangle { x: parent.width - width; width: 7 * bar.s; height: parent.height; radius: height / 2; color: "#E6E5E5"; antialiasing: true }',
  '                }',
  '            }',
  '        }',
  '        Row {',
  '            anchors.left: sun.right',
  '            anchors.verticalCenter: parent.verticalCenter',
  '            Repeater {',
  '                model: bar.digits.length',
  '                Text {',
  '                    text: bar.digits.charAt(index)',
  '                    width: bar.digitWidths[Number(text)] * bar.s',
  '                    horizontalAlignment: Text.AlignHCenter',
  '                    font.family: bar.family',
  '                    font.pixelSize: 85 * bar.s',
  '                    color: "#E6E5E5"',
  '                    layer.enabled: true',
  '                    layer.effect: DropShadow { transparentBorder: true; verticalOffset: Math.ceil(2.5 * bar.s); color: "#b3000000"; radius: 8; samples: 17 }',
  '                }',
  '            }',
  '        }',
  '    }',
  '',
  '    // The pill: 80 across, padded 32, the sun, a track of 460 and the number in 3 digits\' room; low on the screen (h) or upright at the right edge (v).',
  '    Item {',
  '        id: pill',
  '        visible: bar.mode === "h" || bar.mode === "v"',
  '        property bool horizontal: bar.mode === "h"',
  '        property real pad: 32 * bar.s',
  '        property real ico: 38 * bar.s',
  '        property real gap: 24 * bar.s',
  '        property real len: 460 * bar.s',
  '        property real thick: 11 * bar.s',
  '        property real after: pad + ico + gap + len + gap',
  '        width: horizontal ? after + widest.implicitWidth + pad : 80 * bar.s',
  '        height: horizontal ? 80 * bar.s : after + widest.implicitHeight + pad',
  '        x: horizontal ? (bar.width - width) / 2 : bar.width - width - 60 * bar.s',
  '        y: horizontal ? bar.height - height - 80 * bar.s : (bar.height - height) / 2',
  '        Rectangle { anchors.fill: parent; radius: 40 * bar.s; color: "#F0222224" }',
  '        Item {',
  '            width: pill.ico',
  '            height: width',
  '            x: pill.horizontal ? pill.pad : (pill.width - width) / 2',
  '            y: pill.horizontal ? (pill.height - height) / 2 : pill.pad',
  '            property real u: width / 48',
  '            Rectangle { anchors.centerIn: parent; width: 16 * parent.u; height: width; radius: width / 2; color: "white"; antialiasing: true }',
  '            Repeater {',
  '                model: 4',
  '                Item {',
  '                    anchors.centerIn: parent',
  '                    width: 38 * parent.u',
  '                    height: 3 * parent.u',
  '                    rotation: index * 45',
  '                    Rectangle { x: 0; width: 6 * parent.parent.u; height: parent.height; radius: height / 2; color: "white"; antialiasing: true }',
  '                    Rectangle { x: parent.width - width; width: 6 * parent.parent.u; height: parent.height; radius: height / 2; color: "white"; antialiasing: true }',
  '                }',
  '            }',
  '        }',
  '        Rectangle {',
  '            id: pillTrack',
  '            width: pill.horizontal ? pill.len : pill.thick',
  '            height: pill.horizontal ? pill.thick : pill.len',
  '            x: pill.horizontal ? pill.pad + pill.ico + pill.gap : (pill.width - width) / 2',
  '            y: pill.horizontal ? (pill.height - height) / 2 : pill.pad + pill.ico + pill.gap',
  '            radius: pill.thick / 2',
  '            color: Qt.rgba(1, 1, 1, 0.22)',
  '            antialiasing: true',
  '            Rectangle {',
  '                visible: bar.level > 0',
  '                width: pill.horizontal ? parent.width * bar.level / 100 : parent.width',
  '                height: pill.horizontal ? parent.height : parent.height * bar.level / 100',
  '                y: pill.horizontal ? 0 : parent.height - height',
  '                radius: pill.thick / 2',
  '                color: "white"',
  '                antialiasing: true',
  '            }',
  '        }',
  '        Text {',
  '            text: bar.digits',
  '            width: widest.implicitWidth',
  '            horizontalAlignment: pill.horizontal ? Text.AlignRight : Text.AlignHCenter',
  '            font.family: bar.family',
  '            font.pixelSize: 36 * bar.s',
  '            font.weight: Font.Medium',
  '            color: "white"',
  '            x: pill.horizontal ? pill.after : (pill.width - width) / 2',
  '            y: pill.horizontal ? (pill.height - implicitHeight) / 2 : pill.after',
  '        }',
  '    }',
  '}'
].join('\n');

/*
 * The filter's part. filterConfig() reads the two values of the configd
 * value glasshouse.remoteKeys that the bar needs: osd, whether a Brightness
 * key is set where the bar can be shown, and osdStyle. It makes the
 * compositor's bar ahead of the first press, only while a Brightness key is
 * set, and takes it off the compositor again when none is (the keys cleared,
 * Glasshouse restored). filterShow(app) draws each level a press sets on the
 * compositor's bar in the chosen style, or else, where the compositor could not
 * hold it (no volume view to place it beside, or a QML error), opens the bar's
 * app once for each press, with the level and the style; its page follows the
 * level itself while the key is held. Only webOS 10.3.0 has been seen to look
 * right.
 */
function filterConfig() {
  return [
    '        glasshouseOsd = value.osd === true;',
    '        glasshouseOsdStyle = value.osdStyle === "horizontal" || value.osdStyle === "vertical" ? value.osdStyle : "lg";',
    '        if (glasshouseOsd) glasshouseCompositorBar();',
    '        else glasshouseDropBar();'
  ].join('\n');
}

function filterShow(inputBarId) {
  return [
    'var glasshouseOsd = false;',
    'var glasshouseOsdStyle = "lg";',
    'var glasshouseOsdPress = 0;',
    // The compositor's bar: null until tried, false where it cannot be made.
    'var glasshouseOsdBar = null;',
    // views is the compositor's key-filter item's own property, reached by
    // name from the filter's scope; its volume view's parent is the layer
    // LG's system UI views share. The compositor keeps an item made here when
    // configd hands it a new chain and this copy of the filter is dropped, so
    // one left by an earlier copy is taken off first.
    'function glasshouseCompositorBar() {',
    '    if (glasshouseOsdBar !== null) return glasshouseOsdBar;',
    '    glasshouseOsdBar = false;',
    '    try {',
    '        var host = typeof views !== "undefined" && views && views.starfishVolume ? views.starfishVolume.parent : null;',
    '        if (!host || typeof Qt === "undefined" || typeof Qt.createQmlObject !== "function") return false;',
    '        var kids = host.children || [];',
    '        for (var i = kids.length - 1; i >= 0; i--) {',
    '            if (kids[i] && kids[i].objectName === ' + JSON.stringify(COMPOSITOR_BAR) + ') kids[i].destroy();',
    '        }',
    '        glasshouseOsdBar = Qt.createQmlObject(' + JSON.stringify(COMPOSITOR_BAR_QML) + ', host, ' + JSON.stringify(COMPOSITOR_BAR) + ') || false;',
    '        if (glasshouseOsdBar) glasshouseVolumeViews(glasshouseOsdBar, views.starfishVolume);',
    '    } catch (e) {',
    '        glasshouseOsdBar = false;',
    '        console.warn("glasshouse keyfilter: " + e + "; the brightness bar opens as an app");',
    '    }',
    '    return glasshouseOsdBar;',
    '}',
    // LG's volume bar and mute icon, found by what they have, under the volume
    // view or its positioner for rolling screens. Without them the bar is still
    // drawn, but not in LG's pictures.
    'function glasshouseVolumeViews(bar, view) {',
    '    var list = [view];',
    '    for (var i = 0; i < list.length && i < 50; i++) {',
    '        var kids = list[i].children || [];',
    '        for (var j = 0; j < kids.length; j++) {',
    '            var kid = kids[j];',
    '            if (!kid || kid === bar) continue;',
    '            if (typeof kid.restartClosingTimer === "function" && typeof kid.closeView === "function") bar.volumeBar = kid;',
    '            else if (kid.moveDirection !== undefined && typeof kid.closeView === "function") bar.volumeMute = kid;',
    '            list.push(kid);',
    '        }',
    '    }',
    '}',
    // Taken off the compositor again when no Brightness key needs it (keys cleared, Glasshouse restored).
    'function glasshouseDropBar() {',
    '    try { if (glasshouseOsdBar) glasshouseOsdBar.destroy(); } catch (e) {}',
    '    glasshouseOsdBar = null;',
    '}',
    'function glasshouseBrightnessShow(level, press) {',
    '    if (!glasshouseOsd) return;',
    '    var bar = glasshouseCompositorBar();',
    '    try { if (bar && bar.show(level, glasshouseOsdStyle) === true) return; } catch (e) {}',
    '    if (press === glasshouseOsdPress) return;',
    '    glasshouseOsdPress = press;',
    '    try { applicationManager.launch(' + JSON.stringify(inputBarId) + ', JSON.stringify({ "glasshouse": "osd", "kind": "brightness", "level": level, "style": glasshouseOsdStyle })); } catch (e) {}',
    '}'
  ].join('\n');
}

module.exports = {
  init: init,
  stop: stop,
  getBrightness: getBrightness,
  forgetStyle: forgetStyle,
  isStyle: isStyle,
  filterConfig: filterConfig,
  filterShow: filterShow,
  COMPOSITOR_BAR: COMPOSITOR_BAR,
  COMPOSITOR_BAR_QML: COMPOSITOR_BAR_QML,
  STYLES: STYLES,
  BACKLIGHT_IDLE_MS: BACKLIGHT_IDLE_MS
};
