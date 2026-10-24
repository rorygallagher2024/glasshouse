/*
 * Tesseract screen saver: a four-dimensional cube turning through the fourth
 * dimension, drawn as fine lines of light on black.
 *
 * tesseract.js has the geometry: 16 corners and 32 edges, turned in the XW,
 * ZW and YW planes, projected from 4D to 3D and from 3D to the screen. Each
 * edge here is a thin rounded Rectangle laid along it, over a wider faint one
 * for its glow, so it is all drawn by the scene graph with no shader. The far
 * edges are thinner, fainter and more violet than the near ones.
 *
 * Kind to the panel: the background is black, every line moves all the time,
 * and the whole figure drifts gently about the middle of the screen.
 */
import QtQuick 2.4
import Eos.Window 0.1
import "tesseract.js" as Tesseract

WebOSWindow {
    id: win

    // Sized for the compositor's 1920x1080 layout rather than from Screen,
    // which can report smaller: a 43LM5760PTC drew the window in a corner.
    width: 1920
    height: 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    property real unit: win.height / 1080

    // Dim or bright, written in when the screen saver is staged. Dim lowers
    // the colours themselves as well as the alpha.
    property int level: __TVWEB_LEVEL__
    property real gain: level > 0 ? 1.0 : 0.6

    // Seconds, round a six-hour cycle that every period divides.
    property real t: 0
    NumberAnimation on t {
        from: 0; to: Tesseract.CYCLE
        duration: Tesseract.CYCLE * 1000
        loops: Animation.Infinite
    }

    property var geo: Tesseract.frame(win.t)
    property real cx: win.width / 2 + win.geo.driftX * win.unit
    property real cy: win.height / 2 + win.geo.driftY * win.unit

    function tint(depth, alpha) {
        var c = Tesseract.tint(depth);
        return Qt.rgba(c[0] * win.gain, c[1] * win.gain, c[2] * win.gain, alpha);
    }

    Repeater {
        model: Tesseract.EDGES.length
        Item {
            property var edge: win.geo.edges[index]
            property real dx: (edge.x2 - edge.x1) * win.unit
            property real dy: (edge.y2 - edge.y1) * win.unit
            property real length: Math.sqrt(dx * dx + dy * dy)
            property real core: (1.0 + 1.6 * edge.depth) * win.unit
            property real glow: (7 + 9 * edge.depth) * win.unit

            x: win.cx + edge.x1 * win.unit
            y: win.cy + edge.y1 * win.unit
            transformOrigin: Item.TopLeft
            rotation: Math.atan2(dy, dx) * 180 / Math.PI

            Rectangle {
                x: -parent.glow / 2
                y: -parent.glow / 2
                width: parent.length + parent.glow
                height: parent.glow
                radius: height / 2
                antialiasing: true
                color: win.tint(parent.edge.depth, 0.05 + 0.10 * parent.edge.depth)
            }
            Rectangle {
                x: -parent.core / 2
                y: -parent.core / 2
                width: parent.length + parent.core
                height: parent.core
                radius: height / 2
                antialiasing: true
                color: win.tint(parent.edge.depth, 0.30 + 0.65 * parent.edge.depth)
            }
        }
    }

    // A point of light at each corner.
    Repeater {
        model: Tesseract.VERTICES.length
        Item {
            property var vertex: win.geo.vertices[index]
            property real dot: (2.5 + 3.5 * vertex.depth) * win.unit
            property real halo: (12 + 14 * vertex.depth) * win.unit

            x: win.cx + vertex.x * win.unit
            y: win.cy + vertex.y * win.unit

            Rectangle {
                x: -parent.halo / 2
                y: -parent.halo / 2
                width: parent.halo
                height: parent.halo
                radius: width / 2
                antialiasing: true
                color: win.tint(parent.vertex.depth, 0.05 + 0.10 * parent.vertex.depth)
            }
            Rectangle {
                x: -parent.dot / 2
                y: -parent.dot / 2
                width: parent.dot
                height: parent.dot
                radius: width / 2
                antialiasing: true
                color: win.tint(parent.vertex.depth, 0.45 + 0.55 * parent.vertex.depth)
            }
        }
    }
}
