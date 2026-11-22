/*
 * Scores screen saver: the time and date over today's matches in the leagues
 * picked on the Screensaver tab, with kick-off times, live scores and results.
 *
 * The server reads ESPN at most once a minute and words each match in the
 * TV's menu language (/api/scores, filled in for __TVWEB_SCORES__), so this
 * file only lays the rows out. Five rows at a time, the next five every ten
 * seconds, and the whole block somewhere new every minute.
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
    // A match being played, in a green dim enough for hours on an OLED.
    property color inkLive:   level > 0 ? "#7fd18b" : "#4a7a52"

    property bool hour12: __TVWEB_CLOCK12__
    property string tvLocale: "__TVWEB_LOCALE__"
    property string scoresUrl: "__TVWEB_SCORES__"

    property int rowsPerPage: 5
    property int page: 0
    property var matches: []
    property string boardTitle: ""
    property string boardNote: ""
    // Wide enough for "Paris Saint-Germain" at 44 px.
    property int teamWidth: Math.round(480 * win.unit)

    function two(n) { return n < 10 ? "0" + n : "" + n }

    // The weekday and date in the TV's language: the screen saver app's own
    // QML locale is en_US whatever the TV is set to.
    function dateText(d) {
        var text = win.tvLocale ? d.toLocaleDateString(Qt.locale(win.tvLocale), "dddd d MMMM")
                                : Qt.formatDate(d, "dddd d MMMM");
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    ListModel { id: shown }

    // The league, when more than one is picked, and the match's state, as one
    // small line under the score.
    function joined(a, b) {
        if (a && b) return a + " · " + b;
        return a || b || "";
    }

    function pageCount() {
        return Math.max(1, Math.ceil(win.matches.length / win.rowsPerPage));
    }

    function showPage() {
        if (win.page >= win.pageCount()) win.page = 0;
        shown.clear();
        var from = win.page * win.rowsPerPage;
        for (var i = from; i < Math.min(win.matches.length, from + win.rowsPerPage); i++) {
            var m = win.matches[i];
            shown.append({
                league: m.league || "",
                home: m.home || "",
                away: m.away || "",
                // Between the teams: the kick-off before it starts, the score
                // after; under it the minute, half time or full time. A match
                // called off before it started has words, not a time.
                middle: m.state !== "pre" ? (m.homeScore + " – " + m.awayScore)
                      : (/\d/.test(m.detail || "") ? m.detail : "–"),
                under: win.joined(m.league, m.state !== "pre" || !/\d/.test(m.detail || "") ? m.detail : ""),
                live: m.state === "in"
            });
        }
    }

    // Where move() last sent the block. block.x and block.y read mid-animation
    // are on the way there, so the clamp below works from these.
    property real goalX: 0
    property real goalY: 0

    // The block grows when matches arrive or a page has more rows: pulled back
    // inside the margin rather than left off the edge until the next move.
    // Called on the block's size changing, which comes after the Column has
    // laid the new rows out.
    function keepInside() {
        var margin = Math.round(40 * win.unit);
        var nx = Math.max(margin, Math.min(win.goalX, win.width - block.width - margin));
        var ny = Math.max(margin, Math.min(win.goalY, win.height - block.height - margin));
        if (nx !== win.goalX) { win.goalX = nx; block.x = nx; }
        if (ny !== win.goalY) { win.goalY = ny; block.y = ny; }
    }

    function fetchScores() {
        if (!win.scoresUrl || win.scoresUrl.indexOf("__TVWEB_") === 0) return;
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr.status !== 200) return;
            try {
                var d = JSON.parse(xhr.responseText);
                // A failed read keeps what is on screen.
                if (!d.ok) return;
                win.boardTitle = d.title || "";
                win.boardNote = d.note || "";
                win.matches = d.matches || [];
                win.showPage();
            } catch (e) {}
        };
        xhr.open("GET", win.scoresUrl, true);
        xhr.send();
    }

    Item {
        id: block

        width: stack.width
        height: stack.height
        onWidthChanged: win.keepInside()
        onHeightChanged: win.keepInside()

        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: stack
            spacing: Math.round(10 * win.unit)

            Text {
                id: timeText
                width: board.width
                horizontalAlignment: Text.AlignHCenter
                font.family: win.digitFamily
                font.pixelSize: Math.round(150 * win.unit)
                color: win.inkBright
                text: ""
            }

            Text {
                id: dateLine
                width: board.width
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: Math.round(48 * win.unit)
                color: win.inkDim
                text: ""
            }

            Item { width: 1; height: Math.round(26 * win.unit) }

            Text {
                width: board.width
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: Math.round(34 * win.unit)
                font.capitalization: Font.AllUppercase
                font.letterSpacing: Math.round(4 * win.unit)
                color: win.inkDim
                visible: text !== ""
                text: win.boardTitle + (win.pageCount() > 1 ? "  " + (win.page + 1) + "/" + win.pageCount() : "")
            }

            Text {
                width: board.width
                horizontalAlignment: Text.AlignHCenter
                font.pixelSize: Math.round(44 * win.unit)
                color: win.inkBright
                visible: win.boardNote !== ""
                text: win.boardNote
            }

            Column {
                id: board
                width: win.teamWidth * 2 + Math.round(200 * win.unit) + Math.round(48 * win.unit)
                spacing: Math.round(6 * win.unit)

                Repeater {
                    model: shown

                    Row {
                        height: Math.round(80 * win.unit)
                        spacing: Math.round(24 * win.unit)

                        Text {
                            width: win.teamWidth
                            height: parent.height
                            verticalAlignment: Text.AlignVCenter
                            horizontalAlignment: Text.AlignRight
                            elide: Text.ElideRight
                            font.pixelSize: Math.round(44 * win.unit)
                            color: win.inkBright
                            text: model.home
                        }
                        Item {
                            width: Math.round(200 * win.unit)
                            height: parent.height

                            Text {
                                id: middleText
                                width: parent.width
                                y: model.under !== "" ? Math.round(4 * win.unit) : Math.round((parent.height - height) / 2)
                                horizontalAlignment: Text.AlignHCenter
                                font.family: win.digitFamily
                                font.pixelSize: Math.round(48 * win.unit)
                                color: model.live ? win.inkLive : win.inkBright
                                text: model.middle
                            }
                            Text {
                                width: parent.width
                                anchors.top: middleText.bottom
                                horizontalAlignment: Text.AlignHCenter
                                font.pixelSize: Math.round(24 * win.unit)
                                color: model.live ? win.inkLive : win.inkDim
                                visible: text !== ""
                                text: model.under
                            }
                        }
                        Text {
                            width: win.teamWidth
                            height: parent.height
                            verticalAlignment: Text.AlignVCenter
                            elide: Text.ElideRight
                            font.pixelSize: Math.round(44 * win.unit)
                            color: win.inkBright
                            text: model.away
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

    // Somewhere new every minute, never touching an edge and never close to
    // where it was.
    function move() {
        var margin = Math.round(40 * win.unit);
        var spanX = Math.max(0, win.width - block.width - margin * 2);
        var spanY = Math.max(0, win.height - block.height - margin * 2);
        var nx = 0, ny = 0;
        for (var i = 0; i < 8; i++) {
            nx = margin + Math.random() * spanX;
            ny = margin + Math.random() * spanY;
            if (Math.abs(nx - win.goalX) > spanX / 4 || Math.abs(ny - win.goalY) > spanY / 4) break;
        }
        win.goalX = nx;
        win.goalY = ny;
        block.x = nx;
        block.y = ny;
    }

    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: { win.move(); win.fetchScores(); } }
    Timer {
        interval: 10000; running: true; repeat: true
        onTriggered: { if (win.pageCount() > 1) { win.page = (win.page + 1) % win.pageCount(); win.showPage(); } }
    }

    Component.onCompleted: {
        digitFamily = chooseDigitFamily(Math.round(150 * win.unit));
        refresh();
        fetchScores();
        move();
    }
}
