import QtQuick 2.4
import Eos.Window 0.1

WebOSWindow {
    id: root
    color: "black"
    Loader {
        anchors.fill: parent
        source: "file:///media/developer/apps/usr/palm/applications/org.example.split/assets/player/Player.qml"
    }
}
