/*
 * Ambient screen saver: a clean digital clock, date, and live Home Assistant
 * sensor readings, drifting on black to protect OLED panels.
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
    property color inkAccent: level > 0 ? "#7ecaff" : "#4a8cb8"
    property bool hour12: __TVWEB_CLOCK12__

    property string climateVal: ""
    property string secondaryVal: ""

    function two(n) { return n < 10 ? "0" + n : "" + n }

    function formatVal(raw, unitStr) {
        if (!raw || raw === "unavailable" || raw === "unknown") return "";
        var num = parseFloat(raw);
        var txt = raw;
        if (!isNaN(num)) {
            txt = (Math.round(num * 10) / 10).toString();
        }
        return unitStr ? (txt + " " + unitStr) : txt;
    }

    function fetchSensor(url, targetProp) {
        if (!url || url.indexOf("__TVWEB_HA_") === 0) return;
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var u = (d.attributes && d.attributes.unit_of_measurement) || "";
                    var formatted = formatVal(d.state, u);
                    if (targetProp === "climate") win.climateVal = formatted;
                    else if (targetProp === "secondary") win.secondaryVal = formatted;
                } catch (e) {}
            } else {
                if (targetProp === "climate") win.climateVal = "";
                else if (targetProp === "secondary") win.secondaryVal = "";
            }
        };
        xhr.open("GET", url, true);
        xhr.send();
    }

    function fetchAll() {
        fetchSensor("__TVWEB_HA_climate__", "climate");
        fetchSensor("__TVWEB_HA_secondary__", "secondary");
    }

    Item {
        id: block

        width: stack.width
        height: stack.height

        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: stack
            spacing: -Math.round(18 * win.unit)

            Row {
                id: timeRow
                spacing: 0

                Text {
                    id: gauge
                    visible: false
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(180 * win.unit)
                    text: "0"
                }

                Text {
                    id: hourTens
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(180 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Text {
                    id: hourUnits
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(180 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Item {
                    id: colon
                    width: Math.round(58 * win.unit)
                    height: gauge.height

                    SequentialAnimation on opacity {
                        loops: Animation.Infinite
                        running: true
                        NumberAnimation { to: 0.2; duration: 1000; easing.type: Easing.InOutQuad }
                        NumberAnimation { to: 1.0; duration: 1000; easing.type: Easing.InOutQuad }
                    }

                    Column {
                        anchors.centerIn: parent
                        spacing: Math.round(28 * win.unit)
                        Rectangle {
                            width: Math.round(12 * win.unit)
                            height: Math.round(12 * win.unit)
                            radius: Math.round(6 * win.unit)
                            color: win.inkBright
                        }
                        Rectangle {
                            width: Math.round(12 * win.unit)
                            height: Math.round(12 * win.unit)
                            radius: Math.round(6 * win.unit)
                            color: win.inkBright
                        }
                    }
                }
                Text {
                    id: minTens
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(180 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Text {
                    id: minUnits
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(180 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Item {
                    visible: win.hour12
                    width: merText.x + merText.width
                    height: gauge.height

                    Text {
                        id: merText
                        x: Math.round(24 * win.unit)
                        y: parent.height - height - Math.round(14 * win.unit)
                        font.family: win.digitFamily
                        font.pixelSize: Math.round(60 * win.unit)
                        color: win.inkDim
                        text: ""
                    }
                }
            }

            Text {
                id: dateLine
                width: timeRow.width
                height: Math.round(64 * win.unit)
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                font.pixelSize: Math.round(44 * win.unit)
                fontSizeMode: Text.Fit
                minimumPixelSize: Math.round(28 * win.unit)
                color: win.inkDim
                text: ""
            }

            Item {
                id: sensorWrap
                width: timeRow.width
                height: Math.round(54 * win.unit)
                visible: (win.climateVal.length > 0 || win.secondaryVal.length > 0)

                Row {
                    anchors.centerIn: parent
                    spacing: Math.round(20 * win.unit)

                    Text {
                        visible: win.climateVal.length > 0
                        font.pixelSize: Math.round(36 * win.unit)
                        color: win.inkAccent
                        text: win.climateVal
                    }

                    Text {
                        visible: win.climateVal.length > 0 && win.secondaryVal.length > 0
                        font.pixelSize: Math.round(36 * win.unit)
                        color: win.inkDim
                        text: "·"
                    }

                    Text {
                        visible: win.secondaryVal.length > 0
                        font.pixelSize: Math.round(36 * win.unit)
                        color: win.inkAccent
                        text: win.secondaryVal
                    }
                }
            }
        }
    }

    property int shownMinute: -1
    property int shownDay: -1

    function refresh() {
        var now = new Date();
        var m = now.getMinutes();
        if (m !== win.shownMinute) {
            win.shownMinute = m;
            var hour = now.getHours();
            if (win.hour12) merText.text = hour < 12 ? "AM" : "PM";
            var h = win.two(win.hour12 ? (hour % 12) || 12 : hour);
            var mm = win.two(m);
            hourTens.text = h.charAt(0);
            hourUnits.text = h.charAt(1);
            minTens.text = mm.charAt(0);
            minUnits.text = mm.charAt(1);
        }
        var day = now.getFullYear() * 1000 + now.getMonth() * 40 + now.getDate();
        if (day !== win.shownDay) {
            win.shownDay = day;
            dateLine.text = Qt.formatDate(now, "dddd d MMMM");
        }
    }

    function move() {
        var margin = Math.round(120 * win.unit);
        var spanX = Math.max(0, win.width - block.width - margin * 2);
        var spanY = Math.max(0, win.height - block.height - margin * 2);
        var nx = 0, ny = 0;
        for (var i = 0; i < 8; i++) {
            nx = margin + Math.random() * spanX;
            ny = margin + Math.random() * spanY;
            if (Math.abs(nx - block.x) > win.width / 6 || Math.abs(ny - block.y) > win.height / 6) break;
        }
        block.x = nx;
        block.y = ny;
    }

    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: win.move() }
    Timer { interval: 30000; running: true; repeat: true; onTriggered: win.fetchAll() }

    Component.onCompleted: {
        digitFamily = chooseDigitFamily(Math.round(180 * win.unit));
        refresh();
        fetchAll();
        move();
    }
}
