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
    property string readUrl: "__TVWEB_HA_ALL__"

    Text {
        anchors.centerIn: parent
        color: "white"
        font.pixelSize: 48
        text: win.readUrl
    }
}
