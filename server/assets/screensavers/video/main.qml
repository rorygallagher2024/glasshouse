import QtQuick 2.4
import QtMultimedia 5.0
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
    property var playlist: __TVWEB_VIDEOS__
    property bool hour12: __TVWEB_CLOCK12__
    property string weatherUrl: "__TVWEB_HOME_WEATHER__"
    property int current: 0
    property string caption: ""
    property string clockText: ""
    property string weatherText: ""
    property string playbackIssue: ""

    function pad(value) { return value < 10 ? "0" + value : "" + value }

    function updateClock() {
        var now = new Date(), hours = now.getHours(), minutes = pad(now.getMinutes());
        clockText = hour12
            ? (((hours + 11) % 12 + 1) + ":" + minutes + (hours < 12 ? " AM" : " PM"))
            : (pad(hours) + ":" + minutes);
    }

    function refreshWeather() {
        var request = new XMLHttpRequest();
        request.onreadystatechange = function() {
            if (request.readyState !== 4) return;
            try {
                var data = JSON.parse(request.responseText);
                weatherText = data && data.ok
                    ? ((data.city ? data.city + "  ·  " : "") + Math.round(data.temp) + "°  ·  " + data.condition)
                    : "";
            } catch (e) { weatherText = ""; }
        };
        request.open("GET", weatherUrl);
        request.send();
    }

    function advance() {
        if (!playlist || !playlist.items || !playlist.items.length) return;
        if (playlist.shuffle && playlist.items.length > 1) {
            var next = Math.floor(Math.random() * (playlist.items.length - 1));
            if (next >= current) next++;
            current = next;
        } else {
            current = (current + 1) % playlist.items.length;
        }
        caption = playlist.items[current].title || "";
        playbackIssue = "";
        player.source = playlist.items[current].url;
        player.play();
    }

    function updateCaption() {
        var item = playlist && playlist.items && playlist.items[current];
        if (!item) { caption = ""; return; }
        var points = item.pointsOfInterest || [], text = item.title || "", seconds = player.position / 1000;
        for (var i = 0; i < points.length; i++) {
            if (Number(points[i].at) > seconds) break;
            text = points[i].text || text;
        }
        caption = text;
    }

    Component.onCompleted: {
        updateClock();
        refreshWeather();
        if (playlist && playlist.items && playlist.items.length) {
            caption = playlist.items[0].title || "";
            player.play();
        }
    }

    VideoOutput {
        anchors.fill: parent
        source: player
        fillMode: VideoOutput.PreserveAspectCrop
    }
    MediaPlayer {
        id: player
        muted: true
        autoPlay: true
        source: win.playlist && win.playlist.items && win.playlist.items.length ? win.playlist.items[0].url : ""
        onStatusChanged: {
            if (status === MediaPlayer.EndOfMedia) win.advance();
            else if (status === MediaPlayer.InvalidMedia && !win.playbackIssue)
                win.playbackIssue = errorString || "The TV cannot play this video format.";
            else if (status === MediaPlayer.Stalled && !win.playbackIssue)
                win.playbackIssue = errorString || "Video playback stalled while loading data.";
        }
        onError: {
            win.playbackIssue = errorString || "Video playback failed.";
            console.log("video screensaver: " + win.playbackIssue);
        }
        onPositionChanged: if (position > 0) win.playbackIssue = "";
        Component.onCompleted: if (source.toString().length) play();
    }
    Timer { interval: 500; running: true; repeat: true; onTriggered: { win.updateCaption(); win.updateClock(); } }
    Timer { interval: 600000; running: true; repeat: true; onTriggered: win.refreshWeather() }
    Timer {
        interval: 12000
        running: true
        repeat: false
        onTriggered: if (player.position <= 0 && !win.playbackIssue)
            win.playbackIssue = player.errorString || ("Video did not start (player status " + player.status + ").")
    }

    Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.margins: 72
        width: 620
        height: weatherLabel.visible ? clockLabel.paintedHeight + weatherLabel.paintedHeight + 46 : clockLabel.paintedHeight + 32
        color: "#66000000"
        radius: 8
        z: 100
        Column {
            anchors.fill: parent
            anchors.margins: 20
            spacing: 6
            Text {
                id: clockLabel
                text: win.clockText
                color: "white"
                font.pixelSize: 54
                font.weight: Font.Light
            }
            Text {
                id: weatherLabel
                visible: win.weatherText !== ""
                text: win.weatherText
                color: "white"
                font.pixelSize: 31
                wrapMode: Text.WordWrap
            }
        }
    }

    Rectangle {
        visible: win.caption !== ""
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: 72
        anchors.bottomMargin: 72
        width: Math.min(parent.width * 0.38, captionText.implicitWidth + 44)
        height: captionText.implicitHeight + 36
        color: "#88000000"
        radius: 8
        z: 100
        Text {
            id: captionText
            anchors.fill: parent
            anchors.margins: 18
            text: win.caption
            textFormat: Text.PlainText
            color: "white"
            font.pixelSize: 40
            horizontalAlignment: Text.AlignRight
            verticalAlignment: Text.AlignVCenter
            wrapMode: Text.WordWrap
        }
    }

    Text {
        visible: win.playbackIssue !== ""
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: 250
        width: parent.width * 0.72
        text: "Video unavailable: " + win.playbackIssue
        color: "white"
        font.pixelSize: 26
        wrapMode: Text.WordWrap
        horizontalAlignment: Text.AlignHCenter
        z: 200
    }
}
