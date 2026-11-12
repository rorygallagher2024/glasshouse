import QtQuick 2.4

// A screen saver that draws values of its own, addressed by the server.
Item {
    id: win
    property int level: __TVWEB_LEVEL__

    function load() {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "__TVWEB_HA_daylight__", true);
        xhr.send();
    }

    Component.onCompleted: load()
}
