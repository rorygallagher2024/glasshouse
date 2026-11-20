/*
 * Art screen saver: the owner's own pictures and paintings in the public
 * domain, one at a time, each fading into the next.
 *
 * Glasshouse picks each picture (lib/art.js) and serves it from this TV, so
 * nothing here reaches past the TV. The answer also carries how long each
 * stays, how it fits the screen and when its label shows, so a change on the
 * dashboard takes effect with the next picture.
 *
 * For an OLED: the picture changes every few minutes, drifts slowly while it
 * is up, and its label shows for a moment after each change, in a different
 * corner each time, unless asked to stay.
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

    property int level: __TVWEB_LEVEL__
    property string api: "__TVWEB_ART__"
    property string origin: api.split("/api/")[0]

    property int minutes: 10
    property string fit: "fit"
    property string caption: "brief"
    property bool started: false
    property string note: ""
    // Seconds since it started, from a random point, for the drift.
    property real t: Math.random() * 10000
    property int corner: Math.floor(Math.random() * 4)
    property var shownInfo: null
    property bool labelUp: false

    FontLoader { id: lgRegular; source: "file:///usr/share/fonts/LG_Display-Regular.ttf" }
    FontLoader { id: lgLight; source: "file:///usr/share/fonts/LG_Display-Light.ttf" }
    property string titleFamily: lgRegular.status === FontLoader.Ready ? lgRegular.name : ""
    property string textFamily: lgLight.status === FontLoader.Ready ? lgLight.name : titleFamily

    // The TV's language, for the message shown with nothing to show.
    function lang() {
        var n = String(Qt.locale().name || "en").toLowerCase().replace("_", "-");
        return n === "pt-br" ? n : n.split("-")[0];
    }

    function later(seconds) {
        asker.interval = Math.max(1, seconds) * 1000;
        asker.restart();
    }

    function ask() {
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE) return;
            var d = null;
            try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
            if (!d) { win.later(30); return; }
            if (d.minutes) win.minutes = d.minutes;
            if (d.fit) win.fit = d.fit;
            if (d.caption) win.caption = d.caption;
            if (!d.ok || !d.image) {
                if (!win.started) win.note = d.message || d.error || "";
                // The first painting is on its way, or nothing is picked yet.
                win.later(d.waiting ? 10 : 60);
                return;
            }
            var next = a.opacity > 0.5 ? b : a;
            next.fit = win.fit;
            next.show(win.origin + d.image, d.info);
        };
        x.open("GET", win.api);
        x.setRequestHeader("X-Glasshouse-Lang", win.lang());
        x.send();
    }

    function shown(f) {
        var other = f === a ? b : a;
        f.z = 2;
        other.z = 1;
        f.opacity = 1;
        other.opacity = 0;
        release.target = other;
        release.restart();
        win.started = true;
        win.note = "";
        win.labelUp = false;
        win.shownInfo = f.info;
        win.corner = (win.corner + 1 + Math.floor(Math.random() * 3)) % 4;
        labelIn.restart();
        win.later(win.minutes * 60);
    }

    Timer { id: asker; interval: 500; running: true; repeat: false; onTriggered: win.ask() }
    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.t += 1 }
    // The picture faded out lets go of its memory.
    Timer {
        id: release
        property var target: null
        interval: 3500
        onTriggered: if (target && target.opacity === 0) target.clear()
    }
    // The label comes once the picture is in, and for "brief" goes again.
    Timer {
        id: labelIn
        interval: 3000
        onTriggered: {
            win.labelUp = !!win.shownInfo && win.caption !== "off";
            if (win.labelUp && win.caption === "brief") labelOut.restart();
        }
    }
    Timer { id: labelOut; interval: 20000; onTriggered: win.labelUp = false }

    // 0 is drawn at about two thirds of 1.
    Item {
        anchors.fill: parent
        opacity: win.level ? 1 : 0.68

        Frame { id: a; t: win.t; onReady: win.shown(a); onFailed: win.later(20) }
        Frame { id: b; t: win.t; onReady: win.shown(b); onFailed: win.later(20) }

        // A museum's label: title, artist and date, and where it is from.
        Rectangle {
            id: label
            z: 3
            property int margin: 72
            width: words.width + 44
            height: words.height + 32
            radius: 4
            color: "#000000"
            opacity: win.labelUp ? 0.82 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 1500 } }
            x: (win.corner % 2) ? win.width - width - margin : margin
            y: win.corner >= 2 ? win.height - height - margin : margin

            Column {
                id: words
                x: 22
                y: 16
                spacing: 6
                Text {
                    text: win.shownInfo && win.shownInfo.title ? win.shownInfo.title : ""
                    visible: text !== ""
                    width: Math.min(implicitWidth, 760)
                    wrapMode: Text.WordWrap
                    maximumLineCount: 2
                    elide: Text.ElideRight
                    color: "#f2f2f2"
                    font.family: win.titleFamily
                    font.pixelSize: 30
                    font.italic: true
                }
                Text {
                    text: win.shownInfo ? [win.shownInfo.artist, win.shownInfo.date].filter(function (s) { return !!s; }).join(", ") : ""
                    visible: text !== ""
                    width: Math.min(implicitWidth, 760)
                    elide: Text.ElideRight
                    color: "#c8c8c8"
                    font.family: win.textFamily
                    font.pixelSize: 24
                }
                Text {
                    text: win.shownInfo && win.shownInfo.credit ? win.shownInfo.credit : ""
                    visible: text !== ""
                    color: "#8c8c8c"
                    font.family: win.textFamily
                    font.pixelSize: 19
                }
            }
        }

        // With nothing to show: where to add some, drifting like the pictures.
        Text {
            visible: !win.started && win.note !== ""
            text: win.note
            width: 900
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            color: "#8c8c8c"
            font.family: win.textFamily
            font.pixelSize: 30
            x: (win.width - width) / 2 + 300 * Math.sin(win.t / 47)
            y: (win.height - height) / 2 + 300 * Math.sin(win.t / 61 + 1)
        }
    }
}
