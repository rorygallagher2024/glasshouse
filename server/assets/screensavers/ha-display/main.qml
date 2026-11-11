/*
 * Home Assistant: Data Display screen saver: sequences through 2 to 100
 * configured Home Assistant entities one at a time on pure black, gliding
 * gently around the screen to protect OLED panels and handling unreachable
 * entities gracefully.
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
    property color inkDim:    level > 0 ? "#c2c8d0" : "#5c6066"
    property color inkAccent: "__TVWEB_COLOR__"
    property int stepMs: __TVWEB_CHOICE__
    property var items: __TVWEB_HA_LIST__

    property int currentIndex: 0
    property int pendingIndex: 0
    property int probeIndex: 0
    property bool allDown: false
    property real baseX: 0
    property real baseY: 0
    Behavior on baseX { NumberAnimation { duration: 2400; easing.type: Easing.InOutQuad } }
    Behavior on baseY { NumberAnimation { duration: 2400; easing.type: Easing.InOutQuad } }

    property string shownLabel: ""
    property string shownValue: ""
    property string shownUnit: ""

    property var cache: ({})

    function isUnavailableState(raw) {
        if (raw === undefined || raw === null) return true;
        var s = String(raw);
        return s === "" || s === "unavailable" || s === "unknown";
    }

    function formatNumeric(raw) {
        if (isUnavailableState(raw)) return "—";
        var s = String(raw);
        if (/^-?\d+(\.\d+)?$/.test(s)) {
            var num = parseFloat(s);
            if (!isNaN(num)) return (Math.round(num * 10) / 10).toString();
        }
        return s;
    }

    function countCacheState() {
        var live = 0, unfetched = 0;
        if (!items) return { live: 0, unfetched: 0 };
        for (var i = 0; i < items.length; i++) {
            if (cache[i] === undefined) unfetched++;
            else if (cache[i].ok) live++;
        }
        return { live: live, unfetched: unfetched };
    }

    function fetchIndex(idx, done) {
        if (!items || idx < 0 || idx >= items.length) return;
        var item = items[idx];
        if (!item || !item.url || item.url.indexOf("__TVWEB_HA_") === 0) return;
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            var prev = cache[idx];
            var fallbackLbl = item.label || (prev && prev.label) || item.entity || "";
            if (xhr.status === 200) {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var attrs = d.attributes || {};
                    var lbl = item.label || d.label || attrs.friendly_name || fallbackLbl;
                    if (isUnavailableState(d.state)) {
                        cache[idx] = { ok: false, label: lbl, value: "—", unit: "" };
                    } else {
                        cache[idx] = {
                            ok: true,
                            label: lbl,
                            value: formatNumeric(d.state),
                            unit: attrs.unit_of_measurement || ""
                        };
                    }
                } catch (e) {
                    cache[idx] = { ok: false, label: fallbackLbl, value: "—", unit: "" };
                }
            } else {
                cache[idx] = { ok: false, label: fallbackLbl, value: "—", unit: "" };
            }

            if (cache[idx].ok && win.allDown) {
                win.allDown = false;
                win.pendingIndex = idx;
                swapAnim.restart();
            } else if (idx === win.currentIndex && !win.allDown) {
                win.shownLabel = cache[idx].label;
                win.shownValue = cache[idx].value;
                win.shownUnit = cache[idx].unit;
            }
            if (done) done();
        };
        xhr.open("GET", item.url, true);
        xhr.send();
    }

    function pickNextIndex() {
        if (!items || items.length < 2) return 0;
        var counts = countCacheState();
        var canSkipBad = (counts.live + counts.unfetched) >= 2;
        var skippedOne = -1;
        for (var step = 1; step <= items.length; step++) {
            var cand = (win.currentIndex + step) % items.length;
            var c = cache[cand];
            if (canSkipBad && c && !c.ok) {
                if (skippedOne === -1) skippedOne = cand;
                continue;
            }
            if (skippedOne !== -1) fetchIndex(skippedOne);
            return cand;
        }
        return (win.currentIndex + 1) % items.length;
    }

    function showIndex(idx) {
        if (!items || items.length < 2) {
            win.allDown = false;
            win.shownLabel = "Home Assistant";
            win.shownValue = "Add at least 2 entities";
            win.shownUnit = "";
            return;
        }
        var counts = countCacheState();
        if (counts.live === 0 && counts.unfetched === 0) {
            win.allDown = true;
            win.shownLabel = "Home Assistant";
            win.shownValue = "Unavailable";
            win.shownUnit = "";
            return;
        }
        win.allDown = false;
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
        // Refresh the shown entry and warm the next candidate in sequence.
        fetchIndex(idx);
        fetchIndex((idx + 1) % items.length);
    }

    function commitAdvance() {
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

        x: win.baseX
        y: win.baseY
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
                        color: win.allDown ? win.inkDim : win.inkAccent
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
            if (win.allDown) {
                win.probeIndex = (win.probeIndex + 1) % items.length;
                fetchIndex(win.probeIndex);
                return;
            }
            win.pendingIndex = pickNextIndex();
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
