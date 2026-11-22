/*
 * News screen saver: the time and date, with the headlines of the feeds given
 * on the Home tab running along the bottom.
 *
 * The server reads the feeds at most every 10 minutes and gives the headlines
 * through /api/news (filled in for __TVWEB_NEWS__); this file asks once a
 * minute and takes a new set at the end of a run, so a headline is never cut
 * off mid-way. The clock moves every minute and the strip a little with it,
 * and the text itself is always moving.
 *
 * QtQuick 2.4 and Eos.Window 0.1, as the Clock saver: what a webOS 4 set has.
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

    // The first face whose "0" comes out a plausible digit width at this size:
    // Museo Sans lays digits out far too wide at clock sizes on a B8.
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
    property color inkDim:    level > 0 ? "#aab0b8" : "#5c6066"

    property bool hour12: __TVWEB_CLOCK12__
    property string tvLocale: "__TVWEB_LOCALE__"
    property string newsUrl: "__TVWEB_NEWS__"

    // The headlines, eight a run and the next eight the run after, so the
    // moving text stays a few thousand pixels wide rather than all of them.
    property var items: []
    property var waiting: null
    property int at: 0
    property int batch: 8
    property string note: ""
    // Pixels a second, as chosen for Home's strip and given with the
    // headlines: 60 or 100.
    property real speed: 60
    // Each headline on its own for this long, fading to the next, as Home's
    // strip shows them unless set to running: 0 runs them right to left.
    property int flipMs: 8000
    property var flipPart: []
    property int flipAt: 0
    property bool flipShown: false

    function two(n) { return n < 10 ? "0" + n : "" + n }

    // The weekday and date in the TV's language: the screen saver app's own
    // QML locale is en_US whatever the TV is set to.
    function dateText(d) {
        var text = win.tvLocale ? d.toLocaleDateString(Qt.locale(win.tvLocale), "dddd d MMMM")
                                : Qt.formatDate(d, "dddd d MMMM");
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    function escaped(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // One run of the strip: each headline after its source, dimmer.
    function runOf(items) {
        var parts = [];
        for (var i = 0; i < items.length; i++) {
            parts.push("<font color=\"" + win.inkDim + "\">" + win.escaped(items[i].source || "") + "</font>&nbsp;&nbsp;" +
                       win.escaped(items[i].title || ""));
        }
        return parts.join("&nbsp;&nbsp;&nbsp;&nbsp;<font color=\"" + win.inkDim + "\">•</font>&nbsp;&nbsp;&nbsp;&nbsp;");
    }

    function fetchNews() {
        if (!win.newsUrl || win.newsUrl.indexOf("__TVWEB_") === 0) return;
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr.status !== 200) return;
            try {
                var d = JSON.parse(xhr.responseText);
                var items = d.items || [];
                win.note = items.length ? "" : (d.note || "");
                if (d.speed > 0) win.speed = d.speed;
                if (typeof d.flipMs === "number") win.flipMs = d.flipMs;
                // A failed read keeps what runs; new headlines wait for the
                // next run.
                if (items.length) win.waiting = items;
                if (!ticker.text && win.waiting) win.startRun();
            } catch (e) {}
        };
        xhr.open("GET", win.newsUrl, true);
        xhr.send();
    }

    function startRun() {
        if (win.waiting) {
            win.items = win.waiting;
            win.waiting = null;
            if (win.at >= win.items.length) win.at = 0;
        }
        if (!win.items.length) return;
        var part = win.items.slice(win.at, win.at + win.batch);
        win.at = win.at + win.batch >= win.items.length ? 0 : win.at + win.batch;
        run.stop();
        flipTimer.stop();
        if (win.flipMs > 0) {
            var margin = Math.round(112 * win.unit);
            ticker.x = margin;
            ticker.width = strip.width - margin * 2;
            ticker.elide = Text.ElideRight;
            win.flipPart = part;
            win.flipAt = 0;
            win.nextFlip();
            return;
        }
        ticker.elide = Text.ElideNone;
        ticker.width = Qt.binding(function () { return ticker.implicitWidth; });
        ticker.opacity = 1;
        win.flipShown = false;
        ticker.text = win.runOf(part);
        // A whole distance, a multiple of 6 pixels, so the run lasts whole
        // milliseconds at 60 and 100 pixels a second.
        var distance = Math.max(Math.ceil((strip.width + ticker.paintedWidth) / 6) * 6, win.speed);
        run.from = strip.width;
        run.to = strip.width - distance;
        run.duration = Math.round(distance / win.speed * 1000);
        run.start();
    }

    // Fade out, then the next headline in; after the run's last, the next run.
    function nextFlip() {
        if (win.flipShown) {
            win.flipShown = false;
            ticker.opacity = 0;
            flipTimer.interval = 400;
            flipTimer.start();
            return;
        }
        if (win.flipAt >= win.flipPart.length) { win.startRun(); return; }
        ticker.text = win.runOf([win.flipPart[win.flipAt]]);
        win.flipAt = win.flipAt + 1;
        ticker.opacity = 1;
        win.flipShown = true;
        flipTimer.interval = 400 + win.flipMs;
        flipTimer.start();
    }

    Timer { id: flipTimer; repeat: false; onTriggered: win.nextFlip() }

    Item {
        id: block

        width: stack.width
        height: stack.height

        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: stack
            spacing: Math.round(10 * win.unit)

            Text {
                id: timeText
                width: Math.round(900 * win.unit)
                horizontalAlignment: Text.AlignHCenter
                font.family: win.digitFamily
                font.pixelSize: Math.round(190 * win.unit)
                color: win.inkBright
                text: ""
            }

            Text {
                id: dateLine
                width: timeText.width
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: Math.round(52 * win.unit)
                color: win.inkDim
                text: ""
            }

            Text {
                width: timeText.width
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: Math.round(36 * win.unit)
                color: win.inkDim
                visible: win.note !== "" && ticker.text === ""
                text: win.note
            }
        }
    }

    // The strip: the whole width, clipped, a little higher or lower each
    // minute with the clock.
    Item {
        id: strip
        x: 0
        width: win.width
        height: Math.round(70 * win.unit)
        y: win.height - height - Math.round(60 * win.unit)
        clip: true

        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Text {
            id: ticker
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.StyledText
            font.pixelSize: Math.round(42 * win.unit)
            color: win.inkBright
            wrapMode: Text.NoWrap
            text: ""

            Behavior on opacity { NumberAnimation { duration: 400 } }

            NumberAnimation on x {
                id: run
                running: false
                // At the end of a run the next set, which may be new.
                onStopped: { if (ticker.x <= run.to + 1) win.startRun(); }
            }
        }
    }

    property int shownMinute: -1
    property int shownDay: -1

    function refresh() {
        var now = new Date();
        var minute = now.getHours() * 60 + now.getMinutes();
        if (minute !== win.shownMinute) {
            win.shownMinute = minute;
            var hour = now.getHours();
            var h = win.hour12 ? "" + ((hour % 12) || 12) : win.two(hour);
            timeText.text = h + ":" + win.two(now.getMinutes()) + (win.hour12 ? (hour < 12 ? " AM" : " PM") : "");
        }
        var day = now.getFullYear() * 1000 + now.getMonth() * 40 + now.getDate();
        if (day !== win.shownDay) {
            win.shownDay = day;
            dateLine.text = win.dateText(now);
        }
    }

    // The clock somewhere new every minute, above the strip, never touching
    // an edge; the strip a few pixels up or down.
    function move() {
        var margin = Math.round(40 * win.unit);
        var spanX = Math.max(0, win.width - block.width - margin * 2);
        var spanY = Math.max(0, strip.y - block.height - margin * 2);
        block.x = margin + Math.random() * spanX;
        block.y = margin + Math.random() * spanY;
        strip.y = win.height - strip.height - Math.round((40 + Math.random() * 40) * win.unit);
    }

    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: { win.move(); win.fetchNews(); } }

    Component.onCompleted: {
        digitFamily = chooseDigitFamily(Math.round(190 * win.unit));
        refresh();
        move();
        fetchNews();
    }
}
