/*
 * Clock with date screen saver.
 *
 * The Clock screen saver, with seconds, and the day and date under it. A copy
 * rather than a setting on Clock: each saver is staged from its own folder,
 * so they cannot share a file. Mounted over
 * com.webos.app.screensaver, so it runs as the platform's own screen saver and
 * is dismissed the same way. QtQuick 2.4 and Eos.Window are the versions a
 * webOS 4 set has; a webOS 9 set imports them too.
 *
 * Black ground rather than a dark grey: on an OLED that is the pixels off.
 */
import QtQuick 2.4
import Eos.Window 0.1

WebOSWindow {
    id: win

    // Sized for the compositor's 1920x1080 layout rather than from Screen,
    // which can report smaller: a 43LM5760PTC drew the window in a corner.
    width: 1920
    height: 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    // Loaded by path rather than family name, which differs between the two
    // firmwares.
    FontLoader { id: thinFace;  source: "file:///usr/share/fonts/MuseoSans-Thin.ttf" }

    // Candidates for the digits, best first. Miso and LG Display Regular are on
    // both firmwares; LG Display Light is on webOS 4 only.
    FontLoader { id: misoFace;  source: "file:///usr/share/fonts/Miso-Light.ttf" }
    FontLoader { id: lgLight;   source: "file:///usr/share/fonts/LG_Display-Light.ttf" }
    FontLoader { id: lgRegular; source: "file:///usr/share/fonts/LG_Display-Regular.ttf" }

    Text { id: metric; visible: false; text: "0" }

    property string digitFamily: ""

    /*
     * Pick a face by measuring it at the size it will actually be drawn.
     *
     * Measured on a B8: Museo Sans lays a digit out at 1.6em at 232px and at a
     * correct 0.6em at 38px, so the same face is fine for the date line and
     * useless for the clock. Rather than encode which face is good on which
     * model, ask each one how wide a "0" comes out and take the first answer
     * that is plausible for a digit.
     */
    function chooseDigitFamily(px) {
        var cands = [misoFace, lgLight, lgRegular, thinFace];
        metric.font.pixelSize = px;
        for (var i = 0; i < cands.length; i++) {
            if (cands[i].status !== FontLoader.Ready) continue;
            metric.font.family = cands[i].name;
            if (metric.width > 0 && metric.width / px < 0.9) return cands[i].name;
        }
        return "";   // whatever the platform defaults to
    }

    property real unit: win.height / 1080

    /*
     * Dim or bright, written in when the screen saver is staged.
     *
     * Dim is deliberately short of white: a screen saver is shown for hours at
     * a time and the point of it is to spare the panel. Bright is for a set in
     * a bright room, and is the reason the position still changes every minute.
     */
    property int level: __TVWEB_LEVEL__
    property color inkBright: level > 0 ? "#ffffff" : "#a8aeb6"
    property color inkDim:    level > 0 ? "#c2c8d0" : "#5c6066"

    /*
     * 12-hour or 24-hour, written in when the screen saver is staged, as for
     * Clock. With nothing at all in 24-hour, so the block keeps its width.
     */
    property bool hour12: __TVWEB_CLOCK12__

    function two(n) { return n < 10 ? "0" + n : "" + n }

    Item {
        id: block

        width: stack.width
        height: stack.height

        // The move itself is slow and eased, so a glance at the screen never
        // catches it jumping.
        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: stack
            // Negative: the digits' Text box carries the font's descender, none
            // of which is drawn, so a plain gap reads as a much larger one.
            spacing: -Math.round(28 * win.unit)

            Row {
                id: timeRow
                spacing: 0

                // One Text per digit, each boxed to the width of a "0", so the
                // clock does not shift as the time changes - these figures are
                // proportional, and a "1" is half the width of a "0".
                Text {
                    id: gauge
                    visible: false
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    text: "0"
                }

                Text {
                    id: hourTens
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Text {
                    id: hourUnits
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                // Drawn rather than set as a ":" so the gap either side and the
                // pulse are ours to set, whichever face the measuring picks.
                Item {
                    id: colon
                    width: Math.round(74 * win.unit)
                    height: gauge.height

                    // A second of fade each way, so it reads as a pulse rather
                    // than a flash.
                    SequentialAnimation on opacity {
                        loops: Animation.Infinite
                        running: true
                        NumberAnimation { from: 1.0; to: 0.25; duration: 1000; easing.type: Easing.InOutSine }
                        NumberAnimation { from: 0.25; to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
                    }

                    Rectangle {
                        width: Math.round(19 * win.unit)
                        height: width
                        radius: width / 2
                        color: win.inkBright
                        x: (colon.width - width) / 2
                        y: Math.round(colon.height * 0.36)
                    }
                    Rectangle {
                        width: Math.round(19 * win.unit)
                        height: width
                        radius: width / 2
                        color: win.inkBright
                        x: (colon.width - width) / 2
                        y: Math.round(colon.height * 0.63)
                    }
                }
                Text {
                    id: minTens
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Text {
                    id: minUnits
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                // The same colon again before the seconds. It starts with the
                // one above, so the two pulse together.
                Item {
                    id: colonSec
                    width: Math.round(74 * win.unit)
                    height: gauge.height

                    SequentialAnimation on opacity {
                        loops: Animation.Infinite
                        running: true
                        NumberAnimation { from: 1.0; to: 0.25; duration: 1000; easing.type: Easing.InOutSine }
                        NumberAnimation { from: 0.25; to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
                    }

                    Rectangle {
                        width: Math.round(19 * win.unit)
                        height: width
                        radius: width / 2
                        color: win.inkBright
                        x: (colonSec.width - width) / 2
                        y: Math.round(colonSec.height * 0.36)
                    }
                    Rectangle {
                        width: Math.round(19 * win.unit)
                        height: width
                        radius: width / 2
                        color: win.inkBright
                        x: (colonSec.width - width) / 2
                        y: Math.round(colonSec.height * 0.63)
                    }
                }
                Text {
                    id: secTens
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                Text {
                    id: secUnits
                    width: gauge.width
                    horizontalAlignment: Text.AlignHCenter
                    font.family: win.digitFamily
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "0"
                }
                // As Clock's: wrapped so its box matches the digits' height,
                // and the small type sits on their baseline.
                Item {
                    visible: win.hour12
                    width: merText.x + merText.width
                    height: gauge.height

                    Text {
                        id: merText
                        x: Math.round(34 * win.unit)
                        y: parent.height - height - Math.round(14 * win.unit)
                        font.family: win.digitFamily
                        font.pixelSize: Math.round(76 * win.unit)
                        color: win.inkBright
                        text: ""
                    }
                }
            }

            /*
             * Day and date beneath the time, in the dimmer ink so the clock
             * stays the thing read from across a room.
             *
             * Left to the platform's own face: the weekday is the TV's own word
             * for it, in whatever script its language uses. Fit keeps a long
             * one inside the clock's width rather than clipping it.
             */
            Text {
                id: dateLine
                width: timeRow.width
                height: Math.round(90 * win.unit)
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                font.pixelSize: Math.round(66 * win.unit)
                fontSizeMode: Text.Fit
                minimumPixelSize: Math.round(38 * win.unit)
                color: win.inkDim
                text: ""
            }
        }
    }

    property int shownSecond: -1
    property int shownDay: -1

    /*
     * Called four times a second, and does nothing on most of them: the
     * seconds are written only when they change, and the date is formatted
     * only when the day does. Formatting the date and refitting it every
     * second was enough to lose every other tick on a slower set.
     */
    function refresh() {
        var now = new Date();
        var s = now.getSeconds();
        if (s !== win.shownSecond) {
            win.shownSecond = s;
            var hour = now.getHours();
            if (win.hour12) merText.text = hour < 12 ? "AM" : "PM";
            var h = win.two(win.hour12 ? (hour % 12) || 12 : hour);
            var m = win.two(now.getMinutes());
            var ss = win.two(s);
            hourTens.text = h.charAt(0);
            hourUnits.text = h.charAt(1);
            minTens.text = m.charAt(0);
            minUnits.text = m.charAt(1);
            secTens.text = ss.charAt(0);
            secUnits.text = ss.charAt(1);
        }
        var day = now.getFullYear() * 1000 + now.getMonth() * 40 + now.getDate();
        if (day !== win.shownDay) {
            win.shownDay = day;
            // "dddd d MMMM" keeps one order everywhere and translates the
            // names into the TV's language.
            dateLine.text = Qt.formatDate(now, "dddd d MMMM");
        }
    }

    /*
     * Somewhere new every minute, inside a margin wide enough that the block
     * never touches an edge. Rejecting a spot close to the current one keeps it
     * from shuffling in place, which would defeat the point.
     */
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

    // Four checks a second, so every second lands even if a tick is late or
    // dropped. refresh() writes only what changed.
    Timer { interval: 250; running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: win.move() }

    Component.onCompleted: {
        digitFamily = chooseDigitFamily(Math.round(232 * win.unit));
        refresh();
        move();
    }
}
