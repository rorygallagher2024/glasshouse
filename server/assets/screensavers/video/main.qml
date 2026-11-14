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
    property int current: 0
    property string caption: ""

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

    VideoOutput {
        anchors.fill: parent
        source: player
        fillMode: VideoOutput.PreserveAspectCrop
    }
    MediaPlayer {
        id: player
        muted: true
        autoPlay: true
        source: playlist && playlist.items && playlist.items.length ? playlist.items[0].url : ""
        onStatusChanged: if (status === MediaPlayer.EndOfMedia) win.advance()
    }
    Timer { interval: 500; running: true; repeat: true; onTriggered: win.updateCaption() }
    Rectangle {
        visible: win.caption !== ""
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: 100
        height: captionText.paintedHeight + 32
        color: "#99000000"
        radius: 8
        z: 100
        Text {
            id: captionText
            anchors.fill: parent
            anchors.margins: 16
            text: win.caption
            textFormat: Text.PlainText
            color: "white"
            font.pixelSize: 30
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            wrapMode: Text.WordWrap
        }
    }
    Rectangle {
        anchors.fill: parent
        color: "black"
        opacity: 1 - (win.level / 100)
        z: 1000000
    }
}
