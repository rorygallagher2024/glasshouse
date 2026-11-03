import QtQuick 2.4
import QtMultimedia 5.6
import Eos.Window 0.1

WebOSWindow {
    property string basePath: "file:///media/developer/apps/usr/palm/applications/org.example.aerial/assets/"
    Video { id: video; anchors.fill: parent }
    Component.onCompleted: {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', basePath + 'videos.json');
        xhr.send();
    }
}
