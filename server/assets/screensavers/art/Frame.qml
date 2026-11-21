/*
 * One picture of the Picture frame screen saver. There are two, one fading in over the
 * other as the picture changes.
 *
 * The picture drifts slowly over a few dozen pixels, too slowly to be seen
 * moving, so on an OLED no edge stays on the same pixels for its whole time on
 * screen. Filling the screen, it is drawn a little larger than the screen, so
 * the drift never shows an edge.
 */
import QtQuick 2.5

Item {
    id: frame
    anchors.fill: parent
    opacity: 0
    visible: opacity > 0

    property string fit: "fit"
    // Seconds, from the window's clock.
    property real t: 0
    property real seed: Math.random() * 1000
    property var info: null
    property var pending: null
    property bool waiting: false

    signal ready()
    signal failed()

    property int fadeMs: 3000
    Behavior on opacity { NumberAnimation { duration: frame.fadeMs; easing.type: Easing.InOutQuad } }

    function show(url, details) {
        frame.pending = details || null;
        frame.waiting = true;
        frame.seed = Math.random() * 1000;
        img.source = "";
        img.source = url;
    }

    function clear() {
        frame.waiting = false;
        img.source = "";
    }

    // About ten minutes for one sweep, each frame on its own path.
    property real phase: frame.t * 2 * Math.PI / 600 + frame.seed
    property bool filling: frame.fit === "fill"
    property real driftX: (filling ? 0.025 : 0.022) * width
    property real driftY: (filling ? 0.025 : 0.022) * height

    Image {
        id: img
        asynchronous: true
        cache: false
        smooth: true
        // A phone's photo, turned as its camera says.
        autoTransform: true
        fillMode: frame.filling ? Image.PreserveAspectCrop : Image.PreserveAspectFit
        // Decoded at the screen's size: a museum's 3400 pixel print would take
        // a tenfold share of the TV's memory otherwise.
        sourceSize.width: 1920
        sourceSize.height: 1080
        width: frame.width * (frame.filling ? 1.06 : 0.86)
        height: frame.height * (frame.filling ? 1.06 : 0.86)
        x: (frame.width - width) / 2 + frame.driftX * Math.sin(frame.phase)
        y: (frame.height - height) / 2 + frame.driftY * Math.sin(frame.phase * 0.73 + 1.7)

        onStatusChanged: {
            if (!frame.waiting) return;
            if (status === Image.Ready) {
                frame.waiting = false;
                frame.info = frame.pending;
                frame.ready();
            } else if (status === Image.Error) {
                frame.waiting = false;
                frame.failed();
            }
        }
    }
}
