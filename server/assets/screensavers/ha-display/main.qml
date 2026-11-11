/*
 * Home Assistant: Data Display screen saver: sequences through 2 to 100
 * configured Home Assistant entities one at a time on pure black, stepping
 * along a subtle pixel orbit on every change to protect OLED panels.
 *
 * QtQuick 2.4 and Eos.Window 0.1 for compatibility with webOS 4 through webOS 10+.
 */
import QtQuick 2.4
import Eos.Window 0.1

WebOSWindow {
    id: win

    width: 1920
    height: 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    FontLoader { id: thinFace;  source: "file:///usr/share/fonts/MuseoSans-Thin.ttf" }
    FontLoader { id: misoFace;  source: "file:///usr/share/fonts/Miso-Light.ttf" }
    FontLoader { id: lgLight;   source: "file:///usr/share/fonts/LG_Display-Light.ttf" }
    FontLoader { id: lgRegular; source: "file:///usr/share/fonts/LG_Display-Regular.ttf" }

    Text { id: metric; visible: false; text: "0" }

    property string digitFamily: ""

    function chooseDigitFamily(px) {
        var cands = [misoFace, lgLight, lgRegular, thinFace];
        metric.font.pixelSize = px;
        for (var i = 0; i < cands.length; i++) {
            if (cands[i].status !== FontLoader.Ready) continue;
            metric.font.family = cands[i].name;
            if (metric.width > 0 && metric.width / px < 0.9) return cands[i].name;
        }
        return "";
    }

    property real unit: win.height / 1080
    property int level: __TVWEB_LEVEL__
    property color inkBright: level > 0 ? "#ffffff" : "#a8aeb6"
    property color inkDim:    level > 0 ? "#9ca3af" : "#5c6066"
    property color inkAccent: level > 0 ? "#7ecaff" : "#4a8cb8"
    property int stepMs: __TVWEB_CHOICE__
    property var items: __TVWEB_HA_LIST__

    property int currentIndex: 0
    property int pendingIndex: 0
    property int orbitStep: 0
    property real baseX: 0
    property real baseY: 0
    Behavior on baseX { NumberAnimation { duration: 2400; easing.type: Easing.InOutQuad } }
    Behavior on baseY { NumberAnimation { duration: 2400; easing.type: Easing.InOutQuad } }
    property real orbitDx: 0
    property real orbitDy: 0

    property string shownLabel: ""
    property string shownValue: ""
    property string shownUnit: ""

    property var cache: ({})
    // Subtle multi-step pixel orbit around the current anchor position (px at 1080p).
    property var orbitPath: [
        [0, 0], [3, 1], [5, 4], [3, 6], [0, 7], [-3, 6],
        [-5, 4], [-3, 1], [-2, -3], [2, -5], [5, -3], [1, -1]
    ]

    function formatNumeric(raw) {
        if (raw === undefined || raw === null || raw === "unavailable" || raw === "unknown") return "—";
        var s = String(raw);
        if (/^-?\d+(\.\d+)?$/.test(s)) {
            var num = parseFloat(s);
            if (!isNaN(num)) return (Math.round(num * 10) / 10).toString();
        }
        return s;
    }

    function applyOrbit() {
        orbitStep = (orbitStep + 1) % orbitPath.length;
        var pt = orbitPath[orbitStep];
        orbitDx = Math.round(pt[0] * win.unit);
        orbitDy = Math.round(pt[1] * win.unit);
    }

    function fetchIndex(idx, done) {
        if (!items || idx < 0 || idx >= items.length) return;
        var item = items[idx];
        if (!item || !item.url || item.url.indexOf("__TVWEB_HA_") === 0) return;
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var attrs = d.attributes || {};
                    var u = attrs.unit_of_measurement || "";
                    var valStr = formatNumeric(d.state);
                    var lbl = item.label || d.label || attrs.friendly_name || item.entity || "";
                    cache[idx] = { label: lbl, value: valStr, unit: u };
                    if (idx === win.currentIndex) {
                        win.shownLabel = lbl;
                        win.shownValue = valStr;
                        win.shownUnit = u;
                    }
                    if (done) done();
                } catch (e) {}
            } else {
                var fallbackLbl = item.label || item.entity || "";
                cache[idx] = { label: fallbackLbl, value: "—", unit: "" };
                if (idx === win.currentIndex) {
                    win.shownLabel = fallbackLbl;
                    win.shownValue = "—";
                    win.shownUnit = "";
                }
            }
        };
        xhr.open("GET", item.url, true);
        xhr.send();
    }

    function showIndex(idx) {
        if (!items || items.length < 2) {
            win.shownLabel = "Home Assistant";
            win.shownValue = "Add at least 2 entities";
            win.shownUnit = "";
            return;
        }
        win.currentIndex = idx;
        var entry = cache[idx];
        if (entry) {
            win.shownLabel = entry.label;
            win.shownValue = entry.value;
            win.shownUnit = entry.unit;
        } else {
            var item = items[idx];
            win.shownLabel = (item && (item.label || item.entity)) || "";
            win.shownValue = "…";
            win.shownUnit = "";
        }
        // Always refresh live reading and warm up the next entity in sequence.
        fetchIndex(idx);
        fetchIndex((idx + 1) % items.length);
    }

    function commitAdvance() {
        applyOrbit();
        showIndex(pendingIndex);
    }

    function moveAnchor() {
        var marginX = Math.round(180 * win.unit);
        var marginY = Math.round(160 * win.unit);
        var maxW = Math.max(block.width, Math.round(640 * win.unit));
        var maxH = Math.max(block.height, Math.round(240 * win.unit));
        var spanX = Math.max(0, win.width - maxW - marginX * 2);
        var spanY = Math.max(0, win.height - maxH - marginY * 2);
        var nx = marginX + Math.random() * spanX;
        var ny = marginY + Math.random() * spanY;
        for (var i = 0; i < 6; i++) {
            nx = marginX + Math.random() * spanX;
            ny = marginY + Math.random() * spanY;
            if (Math.abs(nx - baseX) > win.width / 6 || Math.abs(ny - baseY) > win.height / 6) break;
        }
        baseX = nx;
        baseY = ny;
    }

    Item {
        id: block

        x: win.baseX + win.orbitDx
        y: win.baseY + win.orbitDy
        width: col.width
        height: col.height

        Column {
            id: col
            spacing: Math.round(14 * win.unit)

            property real contentWidth: Math.min(Math.round(1320 * win.unit), Math.max(labelText.implicitWidth, valRow.width, Math.round(420 * win.unit)))

            Text {
                id: labelText
                width: col.contentWidth
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: Math.round(44 * win.unit)
                fontSizeMode: Text.Fit
                minimumPixelSize: Math.round(26 * win.unit)
                elide: Text.ElideRight
                maximumLineCount: 1
                color: win.inkDim
                text: win.shownLabel
            }

            Item {
                width: col.contentWidth
                height: valRow.height

                Row {
                    id: valRow
                    anchors.horizontalCenter: parent.horizontalCenter
                    spacing: Math.round(18 * win.unit)

                    Text {
                        id: valText
                        width: Math.min(implicitWidth, Math.round(1120 * win.unit))
                        horizontalAlignment: Text.AlignHCenter
                        font.family: win.digitFamily
                        font.pixelSize: Math.round(156 * win.unit)
                        fontSizeMode: Text.Fit
                        minimumPixelSize: Math.round(64 * win.unit)
                        elide: Text.ElideRight
                        maximumLineCount: 1
                        color: win.inkAccent
                        text: win.shownValue
                    }

                    Item {
                        visible: win.shownUnit.length > 0
                        width: unitText.width
                        height: valText.height

                        Text {
                            id: unitText
                            y: parent.height - height - Math.round(20 * win.unit)
                            font.pixelSize: Math.round(58 * win.unit)
                            color: win.inkBright
                            text: win.shownUnit
                        }
                    }
                }
            }
        }
    }

    SequentialAnimation {
        id: swapAnim
        NumberAnimation { target: block; property: "opacity"; to: 0.0; duration: 340; easing.type: Easing.InOutQuad }
        ScriptAction { script: win.commitAdvance() }
        NumberAnimation { target: block; property: "opacity"; to: 1.0; duration: 380; easing.type: Easing.InOutQuad }
    }

    Timer {
        interval: Math.max(3000, win.stepMs)
        running: items && items.length >= 2
        repeat: true
        onTriggered: {
            win.pendingIndex = (win.currentIndex + 1) % items.length;
            swapAnim.restart();
        }
    }

    Timer {
        interval: 60000
        running: true
        repeat: true
        onTriggered: win.moveAnchor()
    }

    Component.onCompleted: {
        digitFamily = chooseDigitFamily(Math.round(156 * win.unit));
        moveAnchor();
        showIndex(0);
    }
}
