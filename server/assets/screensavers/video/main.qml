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
    property string weatherUrl: "__TVWEB_HOME_WEATHER__"
    property int current: 0
    property int videoRetries: 0
    property bool playWhenLoaded: false
    property string caption: ""
    property string clockText: ""
    property string dateText: ""
    property string weatherCity: ""
    property string weatherCondition: ""
    property string weatherTemp: ""
    property string playbackIssue: ""
    property string videoFrameSize: ""
    readonly property color mainInk: "#ece7df"
    readonly property color quietInk: "#a39d93"

    FontLoader {
        id: outfitLight
        source: "file:///var/lib/tvweb/assets/fonts/Outfit-Light.ttf"
    }
    FontLoader {
        id: manropeRegular
        source: "file:///var/lib/tvweb/assets/fonts/Manrope-Regular.ttf"
    }

    function pad(value) { return value < 10 ? "0" + value : "" + value }

    function updateClock() {
        var now = new Date(), hours = now.getHours(), minutes = pad(now.getMinutes());
        clockText = pad(hours) + ":" + minutes;
        dateText = Qt.formatDate(now, "dddd d MMMM");
    }

    function conditionLabel(condition) {
        var labels = {
            "clear-night": "Clear night", sunny: "Sunny", partlycloudy: "Partly cloudy",
            cloudy: "Cloudy", fog: "Fog", rainy: "Rain", pouring: "Heavy rain",
            snowy: "Snow", "snowy-rainy": "Sleet", hail: "Hail", lightning: "Lightning",
            "lightning-rainy": "Thunderstorms", windy: "Windy", "windy-variant": "Windy",
            exceptional: "Severe weather"
        };
        return labels[condition] || "";
    }

    function playerStatusName() {
        if (player.status === MediaPlayer.NoMedia) return "No media";
        if (player.status === MediaPlayer.Loading) return "Loading";
        if (player.status === MediaPlayer.Loaded) return "Loaded";
        if (player.status === MediaPlayer.Buffering) return "Buffering";
        if (player.status === MediaPlayer.Buffered) return "Buffered";
        if (player.status === MediaPlayer.Stalled) return "Stalled";
        if (player.status === MediaPlayer.EndOfMedia) return "End of media";
        if (player.status === MediaPlayer.InvalidMedia) return "Invalid media";
        return "Unknown status " + player.status;
    }

    function streamDiagnostic(reason) {
        var size = videoFrameSize || "output size unknown";
        return reason + " (" + playerStatusName() + ", buffer " + Math.round(player.bufferProgress * 100) + "%, position " + Math.floor(player.position / 1000) + "s, " + size + (player.errorString ? "; " + player.errorString : "") + ").";
    }

    function refreshWeather() {
        var request = new XMLHttpRequest();
        request.onreadystatechange = function() {
            if (request.readyState !== 4) return;
            try {
                var data = JSON.parse(request.responseText);
                if (data && data.ok) {
                    weatherCity = data.city || "";
                    weatherCondition = data.condition || "";
                    weatherTemp = Math.round(data.temp) + "°";
                } else {
                    weatherCity = "";
                    weatherCondition = "";
                    weatherTemp = "";
                }
            } catch (e) {
                weatherCity = "";
                weatherCondition = "";
                weatherTemp = "";
            }
        };
        request.open("GET", weatherUrl);
        request.send();
    }

    function startCurrentVideo() {
        if (!playlist || !playlist.items || !playlist.items.length) {
            playbackIssue = "No videos are configured.";
            return;
        }
        var item = playlist.items[current];
        caption = item.title || "";
        playbackIssue = "";
        videoFrameSize = "";
        videoRetries = 0;
        loadCurrentVideo();
    }

    function loadCurrentVideo() {
        if (!playlist || !playlist.items || !playlist.items.length) return;
        var item = playlist.items[current];
        videoWatch.stop();
        playWhenLoaded = true;
        player.stop();
        player.source = "";
        player.source = item.url;
        loadWatch.restart();
    }

    function retryVideo(reason) {
        if (retryTimer.running) return;
        loadWatch.stop();
        videoWatch.stop();
        if (videoRetries >= 2) {
            playbackIssue = reason || player.errorString || ("Video did not start (player status " + player.status + ").");
            return;
        }
        videoRetries++;
        playbackIssue = "Waiting for the TV video player…";
        retryTimer.restart();
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
        startCurrentVideo();
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
        startCurrentVideo();
    }

    VideoOutput {
        id: videoOutput
        anchors.fill: parent
        source: player
        fillMode: VideoOutput.PreserveAspectCrop
        onSourceRectChanged: {
            if (sourceRect.width > 0 && sourceRect.height > 0) {
                win.videoFrameSize = Math.round(sourceRect.width) + " × " + Math.round(sourceRect.height);
                if (player.position > 0) win.playbackIssue = "";
            }
        }
    }

    MediaPlayer {
        id: player
        muted: true
        onStatusChanged: {
            if ((status === MediaPlayer.Loaded || status === MediaPlayer.Buffered) && win.playWhenLoaded) {
                win.playWhenLoaded = false;
                loadWatch.stop();
                player.play();
                videoWatch.restart();
            } else if (status === MediaPlayer.EndOfMedia) win.advance();
            else if (status === MediaPlayer.Stalled)
                win.retryVideo(win.streamDiagnostic("Stream stopped while buffering"));
            else if (status === MediaPlayer.InvalidMedia)
                win.retryVideo(errorString || "The TV cannot play this video format.");
        }
        onAvailabilityChanged: if (availability === MediaPlayer.Busy)
            win.retryVideo("Another app is still releasing the TV video decoder.");
        onError: {
            console.log("video screensaver: player error " + error + ": " + errorString);
            win.retryVideo(errorString || ("Video playback error " + error + "."));
        }
        onPositionChanged: {
            if (position > 0) {
                if (win.videoFrameSize !== "") {
                    win.videoRetries = 0;
                    win.playbackIssue = "";
                    videoWatch.stop();
                }
            }
        }
    }

    Timer { interval: 500; running: true; repeat: true; onTriggered: { win.updateCaption(); win.updateClock(); } }
    Timer { interval: 600000; running: true; repeat: true; onTriggered: win.refreshWeather() }
    Timer {
        id: loadWatch
        interval: 18000
        repeat: false
        onTriggered: if (win.playWhenLoaded)
            win.retryVideo(player.errorString || ("TV player did not load the video (status " + player.status + ")."))
    }
    Timer {
        id: retryTimer
        interval: 1800
        repeat: false
        onTriggered: {
            win.loadCurrentVideo();
        }
    }
    Timer {
        id: videoWatch
        interval: 12000
        repeat: false
        onTriggered: {
            if (player.position <= 0) {
                win.retryVideo(win.streamDiagnostic("No playback progress"));
            } else if (win.videoFrameSize === "") {
                win.retryVideo(win.streamDiagnostic("No video size reported by TV output"));
            }
        }
    }

    // Smaller Home-style clock at upper left; weather sits independently at upper right.
    Item {
        id: homeInfo
        anchors.fill: parent
        z: 100

        Column {
            id: clockInfo
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.leftMargin: 112
            anchors.topMargin: 72
            width: 520
            spacing: 12
            Text {
                text: win.clockText
                color: win.mainInk
                font.family: outfitLight.name || "sans-serif"
                font.pixelSize: 112
                font.weight: Font.Light
                font.letterSpacing: -2
            }
            Text {
                text: win.dateText
                color: win.quietInk
                font.family: manropeRegular.name || "sans-serif"
                font.pixelSize: 22
            }
        }

        Row {
            id: weatherInfo
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.topMargin: 72
            anchors.rightMargin: 112
            spacing: 8
            visible: win.weatherTemp !== ""
            Item {
                width: 64
                height: 150
                Canvas {
                    id: weatherIcon
                    width: 64
                    height: 64
                    anchors.centerIn: parent
                    onPaint: {
                    var ctx = getContext("2d");
                    ctx.clearRect(0, 0, width, height);
                    ctx.save();
                    ctx.scale(width / 24, height / 24);
                    ctx.strokeStyle = win.mainInk;
                    ctx.lineWidth = 1.3;
                    ctx.lineCap = "round";
                    ctx.lineJoin = "round";
                    function ray(x1, y1, x2, y2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
                    function sun(x, y, radius) {
                        ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
                        ray(x, y - radius - 2, x, y - radius - 5); ray(x, y + radius + 2, x, y + radius + 5);
                        ray(x - radius - 2, y, x - radius - 5, y); ray(x + radius + 2, y, x + radius + 5, y);
                        ray(x - radius - 2, y - radius - 2, x - radius - 4, y - radius - 4);
                        ray(x + radius + 2, y + radius + 2, x + radius + 4, y + radius + 4);
                        ray(x - radius - 2, y + radius + 2, x - radius - 4, y + radius + 4);
                        ray(x + radius + 2, y - radius - 2, x + radius + 4, y - radius - 4);
                    }
                    function cloud() {
                        ctx.moveTo(7, 17); ctx.lineTo(17, 17);
                        ctx.bezierCurveTo(19.4, 17, 21, 15.3, 21, 13.2);
                        ctx.bezierCurveTo(21, 10.8, 19.2, 9.1, 16.8, 9.1);
                        ctx.bezierCurveTo(15.8, 5.6, 12.7, 4.2, 9.8, 5.1);
                        ctx.bezierCurveTo(7.1, 5.8, 5.8, 7.8, 5.7, 10.1);
                        ctx.bezierCurveTo(3.5, 10.2, 2.4, 11.8, 2.4, 13.6);
                        ctx.bezierCurveTo(2.4, 15.7, 4.1, 17, 7, 17);
                    }
                    ctx.beginPath();
                    var c = win.weatherCondition;
                    if (c === "sunny") sun(12, 12, 4);
                    else if (c === "clear-night") {
                        ctx.moveTo(20, 14.5); ctx.bezierCurveTo(15.5, 21, 5.2, 19.5, 4.2, 11.5);
                        ctx.bezierCurveTo(3.6, 7.2, 6.2, 4.1, 9.5, 3.2);
                        ctx.bezierCurveTo(8.5, 9.1, 14, 16.8, 20, 14.5);
                    } else if (c === "partlycloudy") { sun(8, 8, 3); cloud(); }
                    else if (c === "fog") { ray(4, 8, 20, 8); ray(3, 12, 21, 12); ray(5, 16, 19, 16); }
                    else if (c === "windy" || c === "windy-variant") {
                        ctx.moveTo(3, 8); ctx.lineTo(14, 8); ctx.bezierCurveTo(18, 8, 18, 3, 14.5, 4);
                        ctx.moveTo(3, 12); ctx.lineTo(19, 12); ctx.bezierCurveTo(22, 12, 22, 16, 19, 16);
                        ctx.moveTo(3, 16); ctx.lineTo(11, 16);
                    } else if (c === "exceptional") {
                        ctx.moveTo(12, 3); ctx.lineTo(21, 20); ctx.lineTo(3, 20); ctx.closePath();
                        ray(12, 9, 12, 14); ctx.moveTo(12, 17); ctx.arc(12, 17, 0.35, 0, Math.PI * 2);
                    } else if (c === "cloudy" || c === "rainy" || c === "pouring" || c === "snowy" || c === "snowy-rainy" || c === "hail" || c === "lightning" || c === "lightning-rainy") {
                        cloud();
                        if (c === "rainy" || c === "snowy-rainy") { ray(9, 18, 8, 21); ray(15, 18, 14, 21); }
                        else if (c === "pouring") { ray(8, 18, 6.5, 22); ray(12, 18, 10.5, 22); ray(16, 18, 14.5, 22); }
                        else if (c === "lightning" || c === "lightning-rainy") { ray(13, 17, 10, 20); ray(10, 20, 14, 20); ray(14, 20, 11, 23); }
                        else if (c === "snowy") { ctx.moveTo(9, 19); ctx.arc(9, 19, 0.45, 0, Math.PI * 2); ctx.moveTo(16, 21); ctx.arc(16, 21, 0.45, 0, Math.PI * 2); }
                        else if (c === "hail") { ctx.moveTo(9, 20); ctx.arc(9, 20, 0.8, 0, Math.PI * 2); ctx.moveTo(15, 21); ctx.arc(15, 21, 0.8, 0, Math.PI * 2); }
                        else { ray(16, 18, 15, 21); }
                    } else {
                        ctx.moveTo(10, 14); ctx.lineTo(10, 5); ctx.arc(12, 5, 2, Math.PI, 0);
                        ctx.lineTo(14, 14); ctx.arc(12, 16, 4, 0, Math.PI);
                    }
                    ctx.stroke();
                    ctx.restore();
                    }
                    Connections {
                        target: win
                        onWeatherConditionChanged: weatherIcon.requestPaint()
                    }
                }
            }
            Column {
                width: 360
                spacing: 8
                Text {
                    text: win.weatherTemp
                    color: win.mainInk
                    font.family: outfitLight.name || "sans-serif"
                    font.pixelSize: 96
                    font.weight: Font.Light
                    font.letterSpacing: -2
                    horizontalAlignment: Text.AlignRight
                    width: parent.width
                }
                Text {
                    text: (win.weatherCity ? win.weatherCity : "") +
                          (win.weatherCity && win.conditionLabel(win.weatherCondition) ? "  ·  " : "") +
                          win.conditionLabel(win.weatherCondition)
                    color: win.quietInk
                    font.family: manropeRegular.name || "sans-serif"
                    font.pixelSize: 22
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignRight
                    width: parent.width
                }
            }
        }
    }

    Text {
        visible: win.caption !== ""
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: 112
        anchors.bottomMargin: 86
        width: parent.width * 0.34
        text: win.caption
        textFormat: Text.PlainText
        color: win.mainInk
        font.family: manropeRegular.name || "sans-serif"
        font.pixelSize: 32
        wrapMode: Text.WordWrap
        horizontalAlignment: Text.AlignRight
        style: Text.Outline
        styleColor: "#aa000000"
        z: 100
    }

    Text {
        visible: win.playbackIssue !== ""
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        anchors.leftMargin: 112
        anchors.bottomMargin: 72
        width: parent.width * 0.72
        text: win.playbackIssue
        color: win.quietInk
        font.family: manropeRegular.name || "sans-serif"
        font.pixelSize: 22
        wrapMode: Text.WordWrap
        style: Text.Outline
        styleColor: "#aa000000"
        z: 100
    }
}
