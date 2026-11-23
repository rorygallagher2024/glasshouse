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
 * webOS 10 and below the filter runs inside the compositor, so the 'lg' style
 * is drawn there as a QML item beside LG's own volume bar (COMPOSITOR_BAR_QML),
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
 * The LG-style bar as a QML item in the compositor, laid out as LG's volume
 * bar (WebOSCompositor's views/volume/StarfishVolume.qml and the "volume"
 * block of StarfishDefaultSettings.qml): sizes at 1920x1080 scaled to the
 * screen, LG's own track and fill images read from the TV at run time, the
 * level in LG Smart UI 85 at its normal weight (LG's volume bar sets the
 * family as its language-style.js gives it, and no weight) with a shadow, a
 * 150 ms fade and 1.5 s on screen. The sun is about as big in its 72 box as
 * LG's speaker in ic_speaker.png: 38 across, with 3-wide strokes.
 * show(level) returns false where the TV has no such images, so the filter
 * opens the bar's app instead. The sun is drawn, as LG has no image of one
 * beside the volume bar. The two bars never show at once: a level shown closes
 * LG's volume bar early, and LG's volume bar or mute icon opening hides this
 * one once LG's has faded in under it, so the track stays drawn throughout. LG's mute icon is never closed, as it stays while the TV is
 * muted and LG shows it again only at the next volume change.
 */
var COMPOSITOR_BAR = 'glasshouseBrightnessBar';
var COMPOSITOR_BAR_QML = [
  'import QtQuick 2.4',
  'import QtGraphicalEffects 1.0',
  'Item {',
  '    id: bar',
  '    objectName: "' + COMPOSITOR_BAR + '"',
  '    anchors.fill: parent',
  '    enabled: false',
  '    opacity: 0',
  '    visible: opacity > 0',
  '    property real s: width > 0 ? width / 1920 : 1',
  // LG's imagePath: its 4k and qhd images at exactly 2 and 4/3, the 1080p ones otherwise.
  '    property string img: "file:///usr/lib/qml/WebOSCompositor/images/" + (Math.abs(s - 2) < 0.000001 ? "4k/" : Math.abs(s - 4 / 3) < 0.000001 ? "qhd/" : "")',
  '    property int level: 0',
  '    property string digits: String(level)',
  '    property var digitWidths: [51, 39, 48, 49, 50, 48, 51, 45, 51, 51]',
  '    property var iconMargins: [18, 81, 131, 171]',
  // LG's volume bar and mute icon (StarfishVolume, StarfishVolumeMute), set by the filter:
  // the two never show at once, whichever came last having the place.
  '    property Item volumeBar: null',
  '    property Item volumeMute: null',
  '    function show(value) {',
  '        if (track.status !== Image.Ready) return false;',
  '        level = Math.max(0, Math.min(100, Math.round(value)));',
  '        fade.stop();',
  '        opacity = 1;',
  '        hold.restart();',
  '        if (volumeBar && volumeBar.isOpen) volumeBar.closeView();',
  '        return true;',
  '    }',
  '    function hide() { hold.stop(); fade.start(); }',
  // This item is drawn over LG's volume view. Fading both at once would leave
  // the track at three quarters for a moment, so this one stays until LG's has
  // faded in underneath (opened), then fades out over it.
  '    function giveWay(done) { hold.stop(); if (done && opacity > 0) fade.start(); }',
  '    Connections { target: bar.volumeBar; ignoreUnknownSignals: true; onOpening: bar.giveWay(false); onOpened: bar.giveWay(true) }',
  '    Connections { target: bar.volumeMute; ignoreUnknownSignals: true; onOpening: bar.giveWay(false); onOpened: bar.giveWay(true) }',
  '    Timer { id: hold; interval: 1500; onTriggered: fade.start() }',
  '    NumberAnimation { id: fade; target: bar; property: "opacity"; to: 0; duration: 150 }',
  '    Item {',
  '        id: indicator',
  '        height: 570 * bar.s',
  '        width: height',
  '        anchors.right: parent.right',
  '        anchors.verticalCenter: parent.verticalCenter',
  '        Image {',
  '            id: track',
  '            source: bar.img + "vol_bar_bg.png"',
  '            asynchronous: false',
  '            anchors.right: parent.right',
  '            anchors.rightMargin: 51 * bar.s',
  '            anchors.verticalCenter: parent.verticalCenter',
  '            Image {',
  '                source: bar.img + "vol_gage_top.png"',
  '                anchors.top: parent.top',
  '                anchors.topMargin: 8 * bar.s',
  '                anchors.horizontalCenter: parent.horizontalCenter',
  '                visible: bar.level >= 100',
  '            }',
  '            Image {',
  '                source: bar.img + "vol_gage.png"',
  '                fillMode: Image.Stretch',
  '                height: Math.max(0, Math.min(534 * bar.s, (bar.level - 1) * 534 * bar.s / 98))',
  '                anchors.bottom: bottomCap.top',
  '                anchors.horizontalCenter: parent.horizontalCenter',
  '                visible: bar.level > 1',
  '            }',
  '            Image {',
  '                id: bottomCap',
  '                source: bar.img + "vol_gage_bottom.png"',
  '                anchors.bottom: parent.bottom',
  '                anchors.bottomMargin: 10 * bar.s',
  '                anchors.horizontalCenter: parent.horizontalCenter',
  '                visible: bar.level > 0',
  '            }',
  '        }',
  '        Image { source: bar.img + "vol_up.png"; anchors.horizontalCenter: track.horizontalCenter; anchors.bottom: track.top; anchors.bottomMargin: -3 * bar.s }',
  '        Image { source: bar.img + "vol_dn.png"; anchors.horizontalCenter: track.horizontalCenter; anchors.top: track.bottom; anchors.topMargin: -4 * bar.s }',
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
  // Four bars through the middle, each a ray on either side of the ring.
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
  '                    font.family: "\\"LG Smart UI\\",\\"LG Smart UI Dingbat\\""',
  '                    font.pixelSize: 85 * bar.s',
  '                    color: "#E6E5E5"',
  '                    layer.enabled: true',
  '                    layer.effect: DropShadow { transparentBorder: true; verticalOffset: Math.ceil(2.5 * bar.s); color: "#b3000000"; radius: 8; samples: 17 }',
  '                }',
  '            }',
  '        }',
  '    }',
  '}'
].join('\n');

/*
 * The filter's part. filterConfig() reads the two values of the configd
 * value glasshouse.remoteKeys that the bar needs: osd, whether a Brightness
 * key is set where the bar's app can be shown, and osdStyle, and makes the
 * compositor's bar ahead of the first press where the LG style is chosen.
 * filterShow(app) draws each level a press sets on the compositor's bar, or
 * else opens the bar's app once for each press, with the level and the style;
 * its page follows the level itself while the key is held.
 */
function filterConfig() {
  return [
    '        glasshouseOsd = value.osd === true;',
    '        glasshouseOsdStyle = value.osdStyle === "horizontal" || value.osdStyle === "vertical" ? value.osdStyle : "lg";',
    '        if (glasshouseOsd && glasshouseOsdStyle === "lg") glasshouseCompositorBar();',
    '        else if (glasshouseOsdBar) glasshouseOsdBar.hide();'
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
    // view or its positioner for rolling screens.
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
    'function glasshouseBrightnessShow(level, press) {',
    '    if (!glasshouseOsd) return;',
    '    if (glasshouseOsdStyle === "lg") {',
    '        var bar = glasshouseCompositorBar();',
    '        try { if (bar && bar.show(level) === true) return; } catch (e) {}',
    '    }',
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
