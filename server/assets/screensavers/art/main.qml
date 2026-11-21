/*
 * Picture frame screen saver (id "art"): the owner's own pictures, paintings
 * in the public domain and network folders, one at a time, each fading into
 * the next. Next and Previous on the dashboard step through them: it asks
 * every couple of seconds whether one was pressed.
 *
 * Glasshouse picks each picture (lib/art.js) and serves it from this TV, so
 * nothing here reaches past the TV. The answer also carries how long each
 * stays, how it fits the screen and when its label shows, so a change on the
 * dashboard takes effect with the next picture.
 *
 * For an OLED: the picture changes every so often, drifts slowly while it
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

    property int seconds: 600
    // The last Next or Previous taken up; -1 until the first answer says where it stands.
    property int seq: -1
    property string commandUrl: api.replace("/api/art/next", "/api/art/command") + (api.indexOf("?") === -1 ? "?" : "&") + "view=saver"
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

    // The TV's menu language, such as sv_SE: LG's screen saver app keeps en_US.
    property string tvLocale: "__TVWEB_LOCALE__"

    // The TV's language, for the message shown with nothing to show.
    function lang() {
        var n = String(win.tvLocale || Qt.locale().name || "en").toLowerCase().replace("_", "-");
        return n === "pt-br" ? n : n.split("-")[0];
    }

    function later(seconds) {
        asker.interval = Math.max(1, seconds) * 1000;
        asker.restart();
    }

    function ask(dir) {
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE) return;
            var d = null;
            try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
            if (!d) { win.later(30); return; }
            if (d.seconds) win.seconds = d.seconds;
            if (win.seq < 0 && typeof d.seq === "number") win.seq = d.seq;
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
            // Stepped through by hand: a quicker fade.
            next.fadeMs = dir ? 800 : 3000;
            next.show(win.origin + d.image, d.info);
        };
        x.open("GET", win.api + (dir ? (win.api.indexOf("?") === -1 ? "?" : "&") + "dir=" + dir : ""));
        x.setRequestHeader("X-Glasshouse-Lang", win.lang());
        x.send();
    }

    function shown(f) {
        var other = f === a ? b : a;
        other.fadeMs = f.fadeMs;
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
        win.later(win.seconds);
    }

    // Next or Previous pressed on the dashboard: a new seq.
    function poll() {
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE) return;
            var d = null;
            try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
            if (!d || typeof d.seq !== "number") return;
            if (win.seq < 0) { win.seq = d.seq; return; }
            if (d.seq === win.seq) return;
            win.seq = d.seq;
            asker.stop();
            win.ask(d.dir === "prev" ? "prev" : "next");
        };
        x.open("GET", win.commandUrl);
        x.send();
    }

    Timer { id: asker; interval: 500; running: true; repeat: false; onTriggered: win.ask("") }
    Timer { interval: 1500; running: true; repeat: true; onTriggered: win.poll() }
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

            Text {
                id: titleMeasure
                visible: false
                text: win.shownInfo && win.shownInfo.title ? win.shownInfo.title : ""
                font.family: win.titleFamily
                font.pixelSize: 30
                font.italic: true
            }
            Text {
                id: creditMeasure
                visible: false
                text: win.shownInfo && win.shownInfo.credit ? win.shownInfo.credit : ""
                font.family: win.textFamily
                font.pixelSize: 19
            }
            Column {
                id: words
                x: 22
                y: 16
                spacing: 6
                Text {
                    text: win.shownInfo && win.shownInfo.title ? win.shownInfo.title : ""
                    visible: text !== ""
                    // A wrapped Text's own measure follows its width, so an
                    // unwrapped copy says how wide the title wants to be.
                    width: Math.min(titleMeasure.implicitWidth + 1, 760)
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
                    // A museum's credit line is shown whole, so it wraps.
                    width: Math.min(creditMeasure.implicitWidth + 1, 760)
                    wrapMode: Text.WordWrap
                    color: "#8c8c8c"
                    font.family: win.textFamily
                    font.pixelSize: 19
                }
            }
        }

        /*
         * A picture whose licence asks for its credit (ESA's, a photographer's
         * on Commons) keeps it on screen, small, while the label is not up,
         * in the bottom corner on the other side from the label.
         */
        Rectangle {
            id: creditBox
            z: 3
            property bool needed: !!(win.shownInfo && win.shownInfo.mustCredit) && win.started
            property string line: win.shownInfo ? [win.shownInfo.artist, win.shownInfo.credit].filter(function (s) { return !!s; }).join(" \u00b7 ") : ""
            width: creditText.width + 20
            height: creditText.height + 12
            radius: 3
            color: "#000000"
            opacity: needed && !win.labelUp ? 0.7 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 1500 } }
            x: (win.corner % 2) ? 40 : win.width - width - 40
            y: win.height - height - 36
            Text {
                id: creditMeasureSmall
                visible: false
                text: creditBox.line
                font.family: win.textFamily
                font.pixelSize: 17
            }
            Text {
                id: creditText
                x: 10
                y: 6
                text: creditBox.line
                width: Math.min(creditMeasureSmall.implicitWidth + 1, 900)
                wrapMode: Text.WordWrap
                color: "#b4b4b4"
                font.family: win.textFamily
                font.pixelSize: 17
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
