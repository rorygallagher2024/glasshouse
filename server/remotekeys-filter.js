/* Written by Glasshouse: the remote keys set on its Remote tab, read from the
 * configd value glasshouse.remoteKeys. First in com.webos.surfacemanager.keyFilters,
 * so a key set there never reaches LG's filters. */
var glasshouseKeyIds = {};
// Glasshouse Home: the toast for Home until it is in place, and whether it is.
var glasshouseStarting = "";
var glasshouseHomeReady = false;
var glasshouseHoldingHome = false;
var glasshouseHoldOver = false;
var glasshouseMediaCodes = {"ok":28,"play":207,"pause":119,"stop":128,"rewind":168,"fastForward":208,"volumeUp":115,"volumeDown":114,"mute":113};
var glasshouseMediaRepeats = {"volumeUp":true,"volumeDown":true};
// tvpower's state, and whether the Screen off key went down with the picture on.
var glasshousePowerState = "Active";
var glasshouseScreenOffArmed = false;
var glasshousePowerOffArmed = {};
var glasshouseBarPress = 0;
var glasshouseBrightnessStep = 10;

// Key code by name; a name this firmware lacks is left out.
function glasshouseKeyCodes() {
    var codes = {};
    try { codes["netflix"] = WebOS.Key_webOS_Netflix; } catch (e) {}
    try { codes["amazon"] = WebOS.Key_webOS_Amazon; } catch (e) {}
    try { codes["disneyplus"] = WebOS.Key_webOS_Disneyplus; } catch (e) {}
    try { codes["lgchannels"] = WebOS.Key_webOS_LGChannels; } catch (e) {}
    try { codes["rakutentv"] = WebOS.Key_webOS_RakutenTV; } catch (e) {}
    try { codes["movies"] = WebOS.Key_webOS_USP; } catch (e) {}
    try { codes["hulu"] = WebOS.Key_webOS_Hulu; } catch (e) {}
    try { codes["iplayer"] = WebOS.Key_webOS_IPlayer; } catch (e) {}
    try { codes["freeviewplay"] = WebOS.Key_webOS_FreeviewPlay; } catch (e) {}
    try { codes["slingtv"] = WebOS.Key_webOS_SlingTV; } catch (e) {}
    try { codes["globoplay"] = WebOS.Key_webOS_Globoplay; } catch (e) {}
    try { codes["shahid"] = WebOS.Key_webOS_Shahid; } catch (e) {}
    try { codes["alexa"] = WebOS.Key_webOS_ALEXA; } catch (e) {}
    try { codes["googleassistant"] = WebOS.Key_webOS_GoogleVoice; } catch (e) {}
    try { codes["voice"] = WebOS.Key_webOS_Voice; } catch (e) {}
    try { codes["apps"] = WebOS.Key_webOS_Apps; } catch (e) {}
    try { codes["guide"] = WebOS.Key_webOS_TVGuide; } catch (e) {}
    try { codes["input"] = WebOS.Key_webOS_InputSource; } catch (e) {}
    try { codes["livetv"] = WebOS.Key_webOS_InputTV; } catch (e) {}
    try { codes["search"] = Qt.Key_Search; } catch (e) {}
    try { codes["info"] = WebOS.Key_webOS_Info; } catch (e) {}
    try { codes["help"] = Qt.Key_Help; } catch (e) {}
    try { codes["red"] = WebOS.Key_webOS_Red; } catch (e) {}
    try { codes["green"] = WebOS.Key_webOS_Green; } catch (e) {}
    try { codes["yellow"] = WebOS.Key_webOS_Yellow; } catch (e) {}
    try { codes["blue"] = WebOS.Key_webOS_Blue; } catch (e) {}
    return codes;
}

function glasshouseKeysChanged(payload) {
    try {
        var r = typeof payload === "string" ? JSON.parse(payload) : payload;
        var value = (r && r.configs && r.configs["glasshouse.remoteKeys"]) || {};
        var set = value.keys || {};
        var codes = glasshouseKeyCodes(), ids = {};
        for (var name in set) {
            if (set.hasOwnProperty(name) && codes[name] !== undefined && typeof set[name] === "string") ids[codes[name]] = set[name];
        }
        // Home, only while Glasshouse Home sets it.
        if (typeof value.home === "string" && value.home) ids[Qt.Key_Super_L] = value.home;
        glasshouseKeyIds = ids;
        glasshousePowerOffArmed = {};
        glasshouseStarting = typeof value.starting === "string" ? value.starting : "";
        glasshouseBrightnessStep = typeof value.brightnessStep === "number" && value.brightnessStep >= 1 ? value.brightnessStep : 10;
    } catch (e) {
        console.warn("glasshouse keyfilter: " + e + "; keys left as they were");
    }
}

function glasshouseBarInFront() {
    try {
        return typeof global !== "undefined" && typeof global.isForegroundApp === "function" &&
            typeof global.sendKeyToFocusWindow === "function" && global.isForegroundApp("com.tvweb.inputbar") === true;
    } catch (e) {
        return false;
    }
}

var glasshouseBrightnessBusy = false;
var glasshouseBrightnessHeld = 0;
var glasshouseBrightnessSteps = 0;
var glasshouseBrightnessRun = 0;
var glasshouseBrightnessPress = 0;
var glasshouseBrightnessPending = [];
function glasshouseBrightnessKey(direction, pressed, autoRepeat) {
    if (!pressed) { glasshouseBrightnessHeld = 0; return; }
    if (autoRepeat) return;
    glasshouseBrightnessHeld = direction;
    glasshouseBrightnessSteps = 0;
    glasshouseBrightnessRequest(direction, ++glasshouseBrightnessPress);
}
function glasshouseBrightnessRequest(direction, press) {
    if (glasshouseBrightnessBusy) {
        if (glasshouseBrightnessPending.length < 5) glasshouseBrightnessPending.push({ direction: direction, press: press });
        return;
    }
    glasshouseBrightness(direction, press);
}
function glasshouseBrightnessNext(direction, atEnd, press) {
    glasshouseBrightnessBusy = false;
    if (glasshouseBrightnessPending.length) {
        var queued = glasshouseBrightnessPending.shift();
        glasshouseBrightness(queued.direction, queued.press);
        return;
    }
    if (atEnd || glasshouseBrightnessHeld !== direction || press !== glasshouseBrightnessPress || ++glasshouseBrightnessSteps > 60) return;
    try {
        genericTimer.set(glasshouseBrightnessSteps === 1 ? 400 : 100, function () {
            if (glasshouseBrightnessHeld === direction && press === glasshouseBrightnessPress) glasshouseBrightnessRequest(direction, press);
        });
    } catch (e) {}
}
function glasshouseBrightness(direction, press) {
    var delta = direction * glasshouseBrightnessStep;
    glasshouseBrightnessBusy = true;
    var run = ++glasshouseBrightnessRun;
    try { genericTimer.set(1500, function () { if (run === glasshouseBrightnessRun) glasshouseBrightnessBusy = false; }); } catch (e) {}
    lunaCall.send("com.webos.service.settings", "/getSystemSettings", JSON.stringify({ "category": "picture", "keys": ["backlight"] }), function (payload) {
        try {
            var r = typeof payload === "string" ? JSON.parse(payload) : payload;
            var current = r && r.settings ? Math.round(parseFloat(r.settings.backlight)) : NaN;
            var level = Math.max(0, Math.min(100, current + delta));
            if (isNaN(current) || level === current) { glasshouseBrightnessNext(direction, true, press); return; }
            lunaCall.send("com.webos.service.settings", "/setSystemSettings", JSON.stringify({ "category": "picture", "settings": { "backlight": String(level) } }), function () {
                glasshouseBrightnessNext(direction, level === 0 || level === 100, press);
            });
        } catch (e) {
            glasshouseBrightnessBusy = false;
            console.warn("glasshouse keyfilter: " + e);
        }
    });
}

function glasshousePowerChanged(payload) {
    try {
        var r = typeof payload === "string" ? JSON.parse(payload) : payload;
        if (r && typeof r.state === "string") glasshousePowerState = r.state;
    } catch (e) {
        console.warn("glasshouse keyfilter: " + e);
    }
}

// Down with the picture on, the release blanks it; down with it off, the key only wakes it.
function glasshouseScreenOffKey(pressed, autoRepeat) {
    if (pressed) {
        if (!autoRepeat) glasshouseScreenOffArmed = glasshousePowerState === "Active";
        return;
    }
    if (!glasshouseScreenOffArmed) return;
    glasshouseScreenOffArmed = false;
    lunaCall.send("com.webos.service.tvpower", "/power/turnOffScreen", "{}", function () {});
}

function glasshouseSendKey(code) {
    lunaCall.send("com.webos.service.networkinput", "/test/sendKeyCode", JSON.stringify({ "keyCode": code }), function () {});
}

// Sends the media key a key is set to, by its name after "media:".
function glasshouseMedia(name) {
    if (glasshouseMediaCodes.hasOwnProperty(name)) glasshouseSendKey(glasshouseMediaCodes[name]);
}

// Opens Home once the app manager runs Glasshouse Home under its id, and
// says it is starting until then. The key has been kept from LG's filters.
function glasshouseHomePressed() {
    lunaCall.send("com.webos.applicationManager", "/getAppInfo", JSON.stringify({ "id": "com.webos.app.home" }), function (payload) {
        try {
            var r = typeof payload === "string" ? JSON.parse(payload) : payload;
            if (r && r.appInfo && r.appInfo.type === "web") {
                glasshouseHomeReady = true;
                applicationManager.launch("com.webos.app.home", JSON.stringify({ "activateType": "home", "launchType": "homeKey" }));
                return;
            }
            lunaCall.send("com.webos.notification", "/createToast",
                JSON.stringify({ "sourceId": lunaCall.appId, "message": glasshouseStarting }), function () {});
        } catch (e) {
            console.warn("glasshouse keyfilter: " + e);
        }
    });
}

function init() {
    try {
        genericTimer.set(90000, function () { glasshouseHoldOver = true; });
    } catch (e) {
        glasshouseHoldOver = true;
        console.warn("glasshouse keyfilter: " + e + "; Home not held");
    }
    try {
        lunaCall.subscribe("com.webos.service.config", "/getConfigs",
            JSON.stringify({ "configNames": ["glasshouse.remoteKeys"], "subscribe": true }), glasshouseKeysChanged, true);
    } catch (e) {
        console.warn("glasshouse keyfilter: " + e + "; no keys set");
    }
    try {
        lunaCall.subscribe("com.webos.service.tvpower", "/power/getPowerState",
            JSON.stringify({ "subscribe": true }), glasshousePowerChanged, true);
    } catch (e) {
        console.warn("glasshouse keyfilter: " + e + "; power state not followed");
    }
}

function handleGlasshouseKeys(key, pressed, autoRepeat) {
    try {
        // LG's filters open Home on the release, so a release whose press was kept
        // here is kept too, even where Home has opened in between.
        if (key === Qt.Key_Super_L && !pressed && glasshouseHoldingHome) {
            glasshouseHoldingHome = false;
            return KeyPolicy.Accepted;
        }
        if (key === Qt.Key_Super_L && pressed && glasshouseStarting && !glasshouseHomeReady && !glasshouseHoldOver) {
            glasshouseHoldingHome = true;
            if (!autoRepeat) glasshouseHomePressed();
            return KeyPolicy.Accepted;
        }
        if (!glasshouseKeyIds.hasOwnProperty(key)) return KeyPolicy.NextPolicy;
        var id = glasshouseKeyIds[key];
        if (id.indexOf("media:") === 0) {
            var media = id.substring(6);
            if (pressed && (!autoRepeat || glasshouseMediaRepeats.hasOwnProperty(media))) {
                if (!autoRepeat) console.info("glasshouse keyfilter: key", key, "sends", id);
                glasshouseMedia(media);
            }
        } else if (id === "action:homeAssistant") {
            // Nothing on the TV: Glasshouse reads the press from the remote itself.
        } else if (id === "action:homeGuide") {
            if (pressed && !autoRepeat) {
                console.info("glasshouse keyfilter: key", key, "opens Glasshouse Home's guide");
                applicationManager.launch(glasshouseKeyIds[Qt.Key_Super_L] || "com.webos.app.home", JSON.stringify({ "activateType": "home", "launchType": "homeKey", "glasshouse": "guide" }));
            }
        } else if (id === "action:screenOff") {
            if (!pressed && glasshouseScreenOffArmed) console.info("glasshouse keyfilter: key", key, "turns the screen off");
            glasshouseScreenOffKey(pressed, autoRepeat);
        } else if (id === "action:brightnessUp" || id === "action:brightnessDown") {
            glasshouseBrightnessKey(id === "action:brightnessUp" ? 1 : -1, pressed, autoRepeat);
        } else if (id === "action:powerOff") {
            if (pressed && !autoRepeat) {
                var state = glasshousePowerState.toLowerCase().replace(/[\s_-]/g, "");
                glasshousePowerOffArmed[key] = state === "active" || state === "on" || state === "screenoff" || state === "screensaver";
            } else if (!pressed && glasshousePowerOffArmed[key]) {
                delete glasshousePowerOffArmed[key];
                lunaCall.send("com.webos.service.tvpower", "/power/powerOff", JSON.stringify({ "reason": "remoteKey" }), function () {});
            }
        } else if (id === "com.tvweb.inputbar" && glasshouseBarInFront()) {
            if (!autoRepeat) global.sendKeyToFocusWindow(Qt.Key_Right, pressed, 106);
        } else if (pressed && !autoRepeat && id) {
            console.info("glasshouse keyfilter: key", key, "opens", id);
            applicationManager.launch(id, id === "com.webos.app.home"
                ? JSON.stringify({ "activateType": "home", "launchType": "homeKey" })
                : (id === "com.tvweb.homebar" ? JSON.stringify({ "glasshouse": "bar", "press": ++glasshouseBarPress }) : "{}"));
        }
        return KeyPolicy.Accepted;
    } catch (e) {
        console.warn("glasshouse keyfilter: " + e + "; key passed on");
        return KeyPolicy.NextPolicy;
    }
}
