/*
 * Ambient screen saver: a clean digital clock, date, and up to three live Home
 * Assistant readings, drifting on black to protect OLED panels.
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
    property bool showLabels: __TVWEB_CHOICE__

    property string val1: ""
    property string lbl1: ""
    property string val2: ""
    property string lbl2: ""
    property string val3: ""
    property string lbl3: ""

    function two(n) { return n < 10 ? "0" + n : "" + n }

    function formatVal(raw, unitStr) {
        if (raw === undefined || raw === null || raw === "unavailable" || raw === "unknown") return "";
        var s = String(raw);
        var txt = s;
        if (/^-?\d+(\.\d+)?$/.test(s)) {
            var num = parseFloat(s);
            if (!isNaN(num)) txt = (Math.round(num * 10) / 10).toString();
        }
        return unitStr ? (txt + " " + unitStr) : txt;
    }

    function setSlot(idx, val, lbl) {
        if (idx === 1) { win.val1 = val; win.lbl1 = lbl; }
        else if (idx === 2) { win.val2 = val; win.lbl2 = lbl; }
        else if (idx === 3) { win.val3 = val; win.lbl3 = lbl; }
    }

    function fetchSensor(url, idx) {
        if (!url || url.indexOf("__TVWEB_HA_") === 0) {
            setSlot(idx, "", "");
            return;
        }
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var attrs = d.attributes || {};
                    var u = attrs.unit_of_measurement || "";
                    var formatted = formatVal(d.state, u);
                    var name = formatted ? (attrs.friendly_name || "") : "";
                    setSlot(idx, formatted, name);
                } catch (e) {}
            } else {
                setSlot(idx, "", "");
            }
        };
        xhr.open("GET", url, true);
        xhr.send();
    }

    function fetchAll() {
        fetchSensor("__TVWEB_HA_sensor_1__", 1);
        fetchSensor("__TVWEB_HA_sensor_2__", 2);
        fetchSensor("__TVWEB_HA_sensor_3__", 3);
    }

    Item {
        id: block

        width: stack.width
        height: stack.height

        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: stack
            spacing: Math.round(10 * win.unit)

            property real contentWidth: Math.max(timeRow.width, sensorsRow.width)

            Item {
                width: stack.contentWidth
                height: timeRow.height

                Row {
                    id: timeRow
                    anchors.horizontalCenter: parent.horizontalCenter
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
            }

            Text {
                id: dateLine
                width: stack.contentWidth
                height: Math.round(56 * win.unit)
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                font.pixelSize: Math.round(42 * win.unit)
                fontSizeMode: Text.Fit
                minimumPixelSize: Math.round(26 * win.unit)
                color: win.inkDim
                text: ""
            }

            Item {
                id: sensorWrap
                width: stack.contentWidth
                height: sensorsRow.height + Math.round(16 * win.unit)
                visible: (win.val1.length > 0 || win.val2.length > 0 || win.val3.length > 0)

                Row {
                    id: sensorsRow
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.bottom: parent.bottom
                    spacing: Math.round(42 * win.unit)

                    Column {
                        id: col1
                        visible: win.val1.length > 0
                        spacing: Math.round(4 * win.unit)
                        property real slotWidth: Math.max(valText1.implicitWidth, (win.showLabels && win.lbl1.length > 0) ? Math.min(Math.round(280 * win.unit), lblText1.implicitWidth) : 0)
                        Text {
                            id: lblText1
                            visible: win.showLabels && win.lbl1.length > 0
                            width: col1.slotWidth
                            horizontalAlignment: Text.AlignHCenter
                            font.pixelSize: Math.round(20 * win.unit)
                            color: win.inkDim
                            text: win.lbl1
                            elide: Text.ElideRight
                            maximumLineCount: 1
                        }
                        Text {
                            id: valText1
                            width: col1.slotWidth
                            horizontalAlignment: Text.AlignHCenter
                            font.pixelSize: Math.round(36 * win.unit)
                            color: win.inkAccent
                            text: win.val1
                        }
                    }

                    Column {
                        id: col2
                        visible: win.val2.length > 0
                        spacing: Math.round(4 * win.unit)
                        property real slotWidth: Math.max(valText2.implicitWidth, (win.showLabels && win.lbl2.length > 0) ? Math.min(Math.round(280 * win.unit), lblText2.implicitWidth) : 0)
                        Text {
                            id: lblText2
                            visible: win.showLabels && win.lbl2.length > 0
                            width: col2.slotWidth
                            horizontalAlignment: Text.AlignHCenter
                            font.pixelSize: Math.round(20 * win.unit)
                            color: win.inkDim
                            text: win.lbl2
                            elide: Text.ElideRight
                            maximumLineCount: 1
                        }
                        Text {
                            id: valText2
                            width: col2.slotWidth
                            horizontalAlignment: Text.AlignHCenter
                            font.pixelSize: Math.round(36 * win.unit)
                            color: win.inkAccent
                            text: win.val2
                        }
                    }

                    Column {
                        id: col3
                        visible: win.val3.length > 0
                        spacing: Math.round(4 * win.unit)
                        property real slotWidth: Math.max(valText3.implicitWidth, (win.showLabels && win.lbl3.length > 0) ? Math.min(Math.round(280 * win.unit), lblText3.implicitWidth) : 0)
                        Text {
                            id: lblText3
                            visible: win.showLabels && win.lbl3.length > 0
                            width: col3.slotWidth
                            horizontalAlignment: Text.AlignHCenter
                            font.pixelSize: Math.round(20 * win.unit)
                            color: win.inkDim
                            text: win.lbl3
                            elide: Text.ElideRight
                            maximumLineCount: 1
                        }
                        Text {
                            id: valText3
                            width: col3.slotWidth
                            horizontalAlignment: Text.AlignHCenter
                            font.pixelSize: Math.round(36 * win.unit)
                            color: win.inkAccent
                            text: win.val3
                        }
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
