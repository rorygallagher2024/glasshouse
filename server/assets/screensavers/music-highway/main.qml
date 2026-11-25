/*
 * Music Highway screen saver.
 *
 * A neon track floats through the dark, rising, dipping and banking through
 * bends, speeding up and turning from blue to magenta as the TV's sound gets
 * busier. Beats and hits in the sound put blocks on the road, and a craft
 * steers itself to catch them. The road's edges beat like a heart on each
 * beat, the bass lights the horizon, and hits flash walls of laser beams
 * that stand along both sides of the road. With nothing playing the road
 * cruises slowly and dimly, so the screen still never stands still.
 *
 * The levels come from /api/audio/levels, polled 15 times a second; the
 * server records the TV's output only while this asks. In beat mode the
 * server's tempo, bar and section place each block to reach the craft on an
 * eighth note of the bar's learned rhythm, a gate marks each 8-bar phrase,
 * and a build winds up to the drop it expects on the next phrase line. In
 * react mode, or until the tempo is found, blocks start on each beat or hit
 * as it is heard.
 */
import QtQuick 2.4
import Eos.Window 0.1

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

    FontLoader { id: lightFace; source: "file:///usr/share/fonts/MuseoSans-Light.ttf" }
    FontLoader { id: boldFace;  source: "file:///usr/share/fonts/MuseoSans-Bold.ttf" }

    property int level: __TVWEB_LEVEL__
    property real bright: level > 0 ? 1.0 : 0.65
    property real unit: height / 1080
    property string levelsUrl: "__TVWEB_AUDIO__"

    // The track is a ribbon in 3D: its centre line wanders sideways and up
    // and down as sums of sines of the distance along it, the camera rides
    // 1.3 units above it, and the vertex shader and project() below place
    // points the same way. Every frequency is a whole number of turns over
    // TRACK_PERIOD, so the distance can wrap without a jump.
    property real trackPeriod: 2000
    property real k1: 2 * Math.PI * 10 / trackPeriod
    property real k2: 2 * Math.PI * 23 / trackPeriod
    property real k3: 2 * Math.PI * 14 / trackPeriod
    property real k4: 2 * Math.PI * 31 / trackPeriod
    property real camHeight: 1.3
    property real focal: 900 * unit
    property real centreY: height * 0.45
    property real laneStep: 2 / 3
    property real spawnAhead: 45
    property real craftAhead: 3

    property real t: 0
    property real lastStepAt: 0
    property real dist: 0
    property real speed: 3
    property real curveAmp: 0.5
    property real hillAmp: 0.6
    property real pulse: 0
    property real hue: 0.6
    property real intensity: 0
    property real loudness: 0
    property bool silent: true
    property var bands: [0, 0, 0, 0, 0, 0, 0, 0]
    // The bass, quick to rise and slow to fall: the edges and horizon glow.
    property real bass: 0
    // The edges' heartbeat, the whole outline at once: a short thump on
    // every beat, and a softer one after it where the beats leave room
    // (0.45 s apart, about 133 BPM). At 155 BPM a longer double thump kept
    // the edges lit nearly all the time.
    property real heart: 0
    property real heartAt: 0
    property real heartAmp: 0
    // How brightly the lasers show, set on each hit and fading fast.
    property real laserFlash: 0
    property real laserSweep: 0
    property int lastBeats: -1
    property int lastHits: -1
    property int lastLane: 1
    property real lastSpawnAt: 0
    property bool polling: false

    // Beat mode (1) or react mode (0), from the Blocks choice.
    property int syncMode: __TVWEB_CHOICE__
    property bool locked: false
    property real beatAt: 0
    property real periodMs: 500
    property int beatIndex: 0
    property int downbeatIndex: 0
    property int barInPhrase: 0
    property string section: "groove"
    property var barsToDrop: null
    property var pattern: []
    property int lastDrops: -1
    property int nextSlot: -1
    property int lastPulsedBeat: -1
    property real dropBoost: 0
    property real surge: 0
    // How fast blocks come, apart from the road's own surges. Changing it
    // moves every block still on its way, since each is placed by how long
    // it has left: a chorus that took the speed from 12 to 28 at once
    // stretched them all. So it changes by at most a third of itself a
    // second, slow enough that no block ever moves back.
    property real blockSpeed: 10
    property real lastDropShownAt: 0

    // The camera, worked out once a frame for the shader and project().
    property real camX: 0
    property real camY: 0
    property real cosYaw: 1
    property real sinYaw: 0
    property real cosPitch: 1
    property real sinPitch: 0
    property real cosRoll: 1
    property real sinRoll: 0
    property real horizonY: centreY

    property real craftX: 0
    property int blockCount: 24
    property int sparkCount: 20
    property int nextSpark: 0

    function trackX(d) { return win.curveAmp * 6 * (Math.sin(d * win.k1) + 0.6 * Math.sin(d * win.k2 + 1.3)); }
    function trackY(d) { return win.hillAmp * 3 * (Math.sin(d * win.k3 + 0.7) + 0.5 * Math.sin(d * win.k4 + 2.1)); }
    function laneX(lane) { return (lane - 1) * win.laneStep; }

    function placeCamera() {
        var d = win.dist;
        var look = 8;
        win.camX = trackX(d);
        // The height drifts over minutes, so the ship never sits on the same
        // rows of pixels.
        win.camY = trackY(d) + win.camHeight + 0.3 * Math.sin(win.t / 53);
        var yaw = Math.atan2(trackX(d + look) - win.camX, look);
        var pitch = Math.atan2(trackY(d + look) - trackY(d), look) * 0.8;
        // Lean into a bend, by how fast the track turns just ahead.
        var yawAhead = Math.atan2(trackX(d + look + 10) - trackX(d + 10), look);
        var roll = Math.max(-0.25, Math.min(0.25, -(yawAhead - yaw) * 1.5));
        win.cosYaw = Math.cos(yaw);
        win.sinYaw = Math.sin(yaw);
        win.cosPitch = Math.cos(pitch);
        win.sinPitch = Math.sin(pitch);
        win.cosRoll = Math.cos(roll);
        win.sinRoll = Math.sin(roll);
        win.horizonY = win.centreY + Math.tan(pitch) * win.focal;
    }

    // A point on the track, distance ahead and sideways and up from its
    // centre line, on screen: { x, y, depth }, depth 0 when behind the camera.
    function project(ahead, side, up) {
        var d = win.dist + ahead;
        var rx = trackX(d) + side - win.camX;
        var ry = trackY(d) + up - win.camY;
        var rz = ahead;
        var x1 = rx * win.cosYaw - rz * win.sinYaw;
        var z1 = rx * win.sinYaw + rz * win.cosYaw;
        var y2 = ry * win.cosPitch - z1 * win.sinPitch;
        var z2 = ry * win.sinPitch + z1 * win.cosPitch;
        if (z2 < 0.2) return { x: 0, y: 0, depth: 0 };
        var sx = x1 / z2 * win.focal;
        var sy = -y2 / z2 * win.focal;
        return {
            x: win.width / 2 + sx * win.cosRoll - sy * win.sinRoll,
            y: win.centreY + sx * win.sinRoll + sy * win.cosRoll,
            depth: z2
        };
    }

    function mod(a, b) { return ((a % b) + b) % b; }
    function slotTime(slot) { return win.beatAt + (slot / 2 - win.beatIndex) * win.periodMs; }
    function syncing() { return win.syncMode === 1 && win.locked && !win.silent; }

    function freeBlock() {
        for (var i = 0; i < win.blockCount; i++) {
            var b = blocks.itemAt(i);
            if (b && !b.active) return b;
        }
        return null;
    }

    // A block to reach the craft at arriveAt. Kind 0 kick, 1 snare or clap,
    // 2 hat, 3 a phrase gate across the track, 4 the drop's gate.
    function scheduleBlock(arriveAt, lane, kind) {
        var b = freeBlock();
        if (!b) return;
        b.arriveAt = arriveAt;
        b.lane = lane;
        b.kind = kind;
        b.active = true;
    }

    // What the bar's rhythm puts on one eighth note. Each eighth goes to its
    // strongest instrument (kick left, clap or snare middle, hat right) when
    // that clears the section's bar: on a recording at 142 BPM the learned
    // pattern's median was 0.43 for the kick, so a fixed 0.85 left the road
    // nearly empty.
    property int sameLaneRun: 0
    property int lastPlannedLane: -1
    function planSlot(slot) {
        var pos = mod(slot - 2 * win.downbeatIndex, 8);
        var cell = win.pattern[pos] || [0, 0, 0];
        var onBeat = pos % 2 === 0;
        var barsAhead = Math.floor((slot - 2 * win.downbeatIndex) / 8);
        var t = slotTime(slot);
        var sec = win.section;

        if (pos === 0 && win.barsToDrop !== null && barsAhead === win.barsToDrop) {
            scheduleBlock(t, 1, 4);
            return;
        }
        if (pos === 0 && mod(win.barInPhrase + barsAhead, 8) === 0 && sec !== "breakdown") {
            scheduleBlock(t, 1, 3);
            return;
        }
        if (sec === "build") {
            // One block a beat, then the last two bars before the drop run
            // across every lane on each eighth note.
            var toDrop = win.barsToDrop === null ? 8 : win.barsToDrop - barsAhead;
            if (toDrop <= 2) scheduleBlock(t, mod(slot, 3), 2);
            else if (onBeat) scheduleBlock(t, cell[1] >= cell[2] ? 1 : 2, cell[1] >= cell[2] ? 1 : 2);
            return;
        }
        var bar;
        if (sec === "breakdown") bar = onBeat ? 0.3 : 2;
        else if (sec === "drop") bar = onBeat ? 0 : 0.25;
        else bar = onBeat ? 0 : 0.5;

        // Instruments by strength on this eighth, strongest first.
        var order = [0, 1, 2].sort(function (a, b) { return cell[b] - cell[a]; });
        if (cell[order[0]] < bar) return;
        var pick = order[0];
        // Four in one lane in a row: the next goes to the runner-up, so the
        // craft keeps moving.
        if (pick === win.lastPlannedLane && win.sameLaneRun >= 3 && cell[order[1]] >= bar * 0.5) pick = order[1];
        win.sameLaneRun = pick === win.lastPlannedLane ? win.sameLaneRun + 1 : 0;
        win.lastPlannedLane = pick;
        scheduleBlock(t, pick, pick);
    }

    function planAhead(now) {
        var lead = (win.spawnAhead - win.craftAhead) / Math.max(1, win.blockSpeed) * 1000;
        var half = win.periodMs / 2;
        // Start at the far end of the road, or pick up again after a gap.
        if (win.nextSlot < 0 || slotTime(win.nextSlot) < now)
            win.nextSlot = Math.ceil((now + lead * 0.85 - win.beatAt) / half) + 2 * win.beatIndex;
        var guard = 0;
        while (slotTime(win.nextSlot) <= now + lead && guard++ < 32) {
            planSlot(win.nextSlot);
            win.nextSlot++;
        }
    }

    function showDrop() {
        var now = Date.now();
        if (now - win.lastDropShownAt < 4000) return;
        win.lastDropShownAt = now;
        win.dropBoost = 1;
        dropFlash.restart();
        burst(win.width / 2, win.horizonY, 0, 16);
    }

    function spawn(kind) {
        var now = Date.now();
        if (now - win.lastSpawnAt < 120) return;
        var lane;
        if (kind === 0) {
            // A beat goes to the lane of the loudest third of the spectrum.
            var low = win.bands[0] + win.bands[1] + win.bands[2];
            var mid = win.bands[3] + win.bands[4] + win.bands[5];
            var high = (win.bands[6] + win.bands[7]) * 1.5;
            lane = low >= mid && low >= high ? 0 : (mid >= high ? 1 : 2);
        } else {
            lane = (win.lastLane + 1 + Math.floor(Math.random() * 2)) % 3;
        }
        for (var i = 0; i < win.blockCount; i++) {
            var b = blocks.itemAt(i);
            if (!b || b.active) continue;
            b.ahead = win.spawnAhead;
            b.arriveAt = 0;
            b.lane = lane;
            b.kind = kind;
            b.active = true;
            win.lastLane = lane;
            win.lastSpawnAt = now;
            return;
        }
    }

    function beatHeart(amp) {
        win.heartAt = Date.now();
        win.heartAmp = amp;
    }

    function heartbeat(now) {
        var e = (now - win.heartAt) / 1000;
        var second = win.periodMs >= 450 && e > 0.17 ? 0.5 * Math.exp(-(e - 0.17) / 0.08) : 0;
        win.heart = 0.6 * win.heartAmp * (Math.exp(-e / 0.08) + second);
    }

    // Sparks in a block's colour: its tint, as an offset from the road's hue.
    function burst(x, y, tint, count) {
        for (var k = 0; k < count; k++) {
            var sp = sparks.itemAt(win.nextSpark);
            win.nextSpark = (win.nextSpark + 1) % win.sparkCount;
            if (!sp) continue;
            var angle = Math.PI + Math.random() * Math.PI;
            var v = (250 + Math.random() * 450) * win.unit;
            sp.sx = x;
            sp.sy = y;
            sp.svx = Math.cos(angle) * v;
            sp.svy = Math.sin(angle) * v;
            sp.tint = tint;
            sp.life = 1;
        }
    }

    function applyLevels(d) {
        if (!d) return;
        win.silent = !d.ok || !!d.silent;
        if (d.bands && d.bands.length === 8) win.bands = d.bands;
        win.loudness = d.level || 0;
        var m = d.music;
        var wasLocked = win.locked;
        win.locked = !!(m && m.locked);
        if (win.locked) {
            // The beat count or tempo can jump: half or double the tempo
            // scales the count, a new song starts the clock again. Planning
            // and the beat's pulse then go by the new count at once, rather
            // than wait for it to reach the old one: a switch from 190 to 95
            // BPM left the road without blocks or pulses for about 90 s.
            if (wasLocked) {
                var expected = win.beatIndex + Math.round((m.beatAt - win.beatAt) / m.periodMs);
                if (Math.abs(m.beatIndex - expected) > 1 || Math.abs(m.periodMs - win.periodMs) > win.periodMs * 0.1) {
                    win.nextSlot = -1;
                    win.lastPulsedBeat = -1;
                }
            }
            win.beatAt = m.beatAt;
            win.periodMs = m.periodMs;
            win.beatIndex = m.beatIndex;
            win.downbeatIndex = m.downbeatIndex;
            win.barInPhrase = m.barInPhrase;
            win.section = m.section;
            win.barsToDrop = m.barsToDrop;
            win.pattern = m.pattern;
            // A drop the plan did not see coming still gets its moment.
            if (win.lastDrops >= 0 && m.drops > win.lastDrops) showDrop();
            win.lastDrops = m.drops;
            if (!wasLocked) win.nextSlot = -1;
        }
        var reacting = !syncing();
        if (typeof d.beats === "number") {
            if (win.lastBeats >= 0 && d.beats > win.lastBeats && !win.silent && reacting) {
                win.pulse = 1;
                beatHeart(1);
                spawn(0);
            }
            win.lastBeats = d.beats;
        }
        if (typeof d.hits === "number") {
            if (win.lastHits >= 0 && d.hits > win.lastHits && !win.silent) {
                if (reacting) spawn(1);
                // A breakdown keeps its lasers down.
                if (win.section !== "breakdown" || reacting) win.laserFlash = Math.max(win.laserFlash, 0.8);
            }
            win.lastHits = d.hits;
        }
    }

    function poll() {
        if (win.polling) return;
        win.polling = true;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE) return;
            win.polling = false;
            if (x.status !== 200) { win.silent = true; return; }
            try { applyLevels(JSON.parse(x.responseText)); } catch (e) { }
        };
        x.open("GET", win.levelsUrl);
        x.send();
    }

    function step() {
        var now = Date.now();
        var dt = Math.min(0.1, Math.max(0, (now - win.lastStepAt) / 1000));
        win.lastStepAt = now;
        win.t += dt;

        var target = win.silent ? 0 : win.loudness;
        win.intensity += (target - win.intensity) * Math.min(1, dt * 1.5);
        var sync = syncing();
        var wantSpeed = win.silent ? 3 : 9 + win.intensity * 12 + win.pulse * 3;
        var hueShift = 0;
        // The track's shape for the section: flat for a breakdown, climbing
        // through a build, big hills and bends for a drop.
        var wantCurve = win.silent ? 0.35 : 0.5 + win.intensity * 0.5;
        var wantHills = win.silent ? 0.4 : 0.6 + win.intensity * 0.9;
        var morphRate = 0.15;
        if (sync) {
            var toDrop = win.barsToDrop === null ? 8 : win.barsToDrop;
            if (win.section === "breakdown") {
                wantSpeed = 6; hueShift = -0.08; wantCurve = 0.3; wantHills = 0.25;
            } else if (win.section === "build") {
                wantSpeed = 8 + (8 - Math.min(8, toDrop)) * 1.8;
                wantCurve = 0.45; wantHills = 0.5 + (8 - Math.min(8, toDrop)) * 0.12;
            } else if (win.section === "drop") {
                wantSpeed = 22 + win.intensity * 8; wantCurve = 1.1; wantHills = 1.6; morphRate = 0.6;
            } else {
                wantSpeed = 12 + win.intensity * 10; wantCurve = 0.7; wantHills = 0.9;
            }
            hueShift += win.dropBoost * 0.12;
            // The road pulses and surges on the beat clock, beat 1 hardest.
            var beatNow = win.beatIndex + Math.floor((now - win.beatAt) / win.periodMs);
            if (beatNow > win.lastPulsedBeat) {
                var first = mod(beatNow - win.downbeatIndex, 4) === 0;
                win.pulse = first ? 1 : 0.6;
                win.surge = Math.max(win.surge, first ? 7 : 4);
                win.lastPulsedBeat = beatNow;
                beatHeart(first ? 1 : 0.6);
                if (first && win.section === "drop") win.laserFlash = 1;
            }
        }
        win.surge *= Math.exp(-dt * 6);
        var change = (wantSpeed - win.blockSpeed) * Math.min(1, dt * 0.35);
        var most = win.blockSpeed * dt / 3;
        win.blockSpeed += Math.max(-most, Math.min(most, change));
        // The road and camera add the beat's surge and the drop's rush.
        wantSpeed = sync ? win.blockSpeed + win.surge + win.dropBoost * 12 : wantSpeed + win.surge;
        win.dropBoost *= Math.exp(-dt / 2.5);
        win.speed += (wantSpeed - win.speed) * Math.min(1, dt * 4);
        win.dist = (win.dist + win.speed * dt) % win.trackPeriod;
        win.pulse *= Math.exp(-dt * 5);
        // Blue when calm, toward magenta as it gets busy, drifting a little.
        win.hue = (0.6 + win.intensity * 0.35 + hueShift + Math.sin(win.t * 0.05) * 0.03 + 2) % 1;
        if (sync) planAhead(now);
        // Busier music, steeper hills and sharper bends, eased in slowly so
        // the track ahead reshapes gently.
        var morph = Math.min(1, dt * morphRate);
        win.curveAmp += (wantCurve - win.curveAmp) * morph;
        win.hillAmp += (wantHills - win.hillAmp) * morph;
        placeCamera();

        var bassNow = win.silent ? 0 : (win.bands[0] + win.bands[1]) / 2;
        win.bass = bassNow > win.bass ? win.bass + (bassNow - win.bass) * Math.min(1, dt * 20)
                                       : win.bass - Math.min(win.bass - bassNow, dt * 1.5);
        heartbeat(now);
        // A drop keeps the lasers lit and sweeping; elsewhere they flash on
        // hits and sway slowly.
        var laserFloor = sync && win.section === "drop" ? 0.45 : 0;
        win.laserFlash = Math.max(laserFloor, win.laserFlash * Math.exp(-dt * 4));
        if (win.silent) win.laserFlash = 0;
        win.laserSweep += dt * (sync && win.section === "drop" ? 1.6 : 0.4);

        // Steer for the nearest block still ahead.
        var aim = null;
        var aimAhead = 999;
        var i, b;
        for (i = 0; i < win.blockCount; i++) {
            b = blocks.itemAt(i);
            if (!b || !b.active) continue;
            if (b.arriveAt > 0) b.ahead = win.craftAhead + (b.arriveAt - now) / 1000 * win.blockSpeed;
            else b.ahead -= win.speed * dt;
            if (b.ahead <= win.craftAhead) {
                b.active = false;
                if (b.kind >= 3) {
                    // A gate spans the track: always through it.
                    craft.flash();
                    burst(craft.x + craft.width / 2, craft.y + craft.height / 2, b.tint, 16);
                    if (b.kind === 4) showDrop();
                } else if (Math.abs(win.laneX(b.lane) - win.craftX) < win.laneStep * 0.5) {
                    craft.flash();
                    burst(craft.x + craft.width / 2, craft.y + craft.height / 2, b.tint, 8);
                }
                continue;
            }
            if (b.kind < 3 && b.ahead < aimAhead) { aimAhead = b.ahead; aim = b; }
            b.place();
        }
        var aimX = aim ? win.laneX(aim.lane) : 0;
        // Fast enough to change lane between eighth notes at 180 BPM.
        var maxMove = 7 * dt;
        win.craftX += Math.max(-maxMove, Math.min(maxMove, aimX - win.craftX));
        var c = project(win.craftAhead, win.craftX, 0.1);
        craft.x = Math.round(c.x - craft.width / 2);
        craft.y = Math.round(c.y - craft.height);

        for (i = 0; i < win.sparkCount; i++) {
            var sp = sparks.itemAt(i);
            if (!sp || sp.life <= 0) continue;
            sp.sx += sp.svx * dt;
            sp.sy += sp.svy * dt;
            sp.svy += 900 * win.unit * dt;
            sp.life = Math.max(0, sp.life - dt * 2);
        }
    }

    // A glow where the horizon is, under the track, breathing with the bass
    // and, with nothing playing, slowly on its own.
    Rectangle {
        width: win.width
        height: Math.round((300 + win.bass * 160) * win.unit)
        y: Math.round(win.horizonY - height)
        opacity: win.silent ? 0.45 + 0.1 * Math.sin(win.t / 7) : 0.55 + win.bass * 0.35 + win.pulse * 0.1
        gradient: Gradient {
            GradientStop { position: 0.0; color: "black" }
            GradientStop { position: 1.0; color: Qt.hsla(win.hue, 0.9, win.level > 0 ? 0.1 : 0.065, 1) }
        }
    }

    // Lasers: a wall of beams rising from beside each edge of the near half
    // of the road, under the track, leaning outward and up out of the screen.
    // Faint between hits, they flash on each hit, grow with the bass and
    // beat with the road's edges; the beams sway back and forth along the
    // road, the two walls mirrored, faster through a drop. Drawn at
    // 960x540 and scaled up: the walls cover much of the screen, and on an
    // OLED55A19LA (webOS 6.5.3) the saver lagged drawing them at full size.
    Item {
      anchors.fill: parent
      layer.enabled: true
      layer.textureSize: Qt.size(960, 540)
      layer.smooth: true
      Repeater {
        model: 2
        ShaderEffect {
            anchors.fill: parent
            mesh: GridMesh { resolution: Qt.size(1, 120) }
            property real wallSide: index === 0 ? -1.25 : 1.25
            property real wallHeight: 2 + win.bass * 1.5 + win.laserFlash
            // How far the top leans out past the foot, per unit of height.
            property real splay: 0.55
            property real camD: win.dist
            property real camX: win.camX
            property real camY: win.camY
            property real cosYaw: win.cosYaw
            property real sinYaw: win.sinYaw
            property real cosPitch: win.cosPitch
            property real sinPitch: win.sinPitch
            property real cosRoll: win.cosRoll
            property real sinRoll: win.sinRoll
            property real curveAmp: win.curveAmp
            property real hillAmp: win.hillAmp
            property real k1: win.k1
            property real k2: win.k2
            property real k3: win.k3
            property real k4: win.k4
            property real focal: win.focal
            property real centreX: win.width / 2
            property real centreY: win.centreY
            property real hue: win.hue
            property real flash: win.silent ? 0 : win.laserFlash
            property real sweep: win.laserSweep
            property real mirror: index === 0 ? -1 : 1
            property real heart: win.heart
            property real bright: win.bright * (win.silent ? 0.6 : 1.0)
            vertexShader: "
                uniform highp mat4 qt_Matrix;
                attribute highp vec4 qt_Vertex;
                attribute highp vec2 qt_MultiTexCoord0;
                uniform highp float wallSide;
                uniform highp float wallHeight;
                uniform highp float splay;
                uniform highp float camD;
                uniform highp float camX;
                uniform highp float camY;
                uniform highp float cosYaw;
                uniform highp float sinYaw;
                uniform highp float cosPitch;
                uniform highp float sinPitch;
                uniform highp float cosRoll;
                uniform highp float sinRoll;
                uniform highp float curveAmp;
                uniform highp float hillAmp;
                uniform highp float k1;
                uniform highp float k2;
                uniform highp float k3;
                uniform highp float k4;
                uniform highp float focal;
                uniform highp float centreX;
                uniform highp float centreY;
                varying highp float vUp;
                varying highp float vDist;
                varying highp float vAhead;
                void main() {
                    highp float far = 1.0 - qt_MultiTexCoord0.y;
                    // The near half of the road only.
                    highp float ahead = 0.6 + 30.0 * far * far;
                    highp float d = camD + ahead;
                    highp float up = qt_MultiTexCoord0.x * wallHeight;
                    highp float rx = curveAmp * 6.0 * (sin(d * k1) + 0.6 * sin(d * k2 + 1.3)) + wallSide
                        + sign(wallSide) * up * splay - camX;
                    highp float ry = hillAmp * 3.0 * (sin(d * k3 + 0.7) + 0.5 * sin(d * k4 + 2.1)) + up - camY;
                    highp float x1 = rx * cosYaw - ahead * sinYaw;
                    highp float z1 = rx * sinYaw + ahead * cosYaw;
                    highp float y2 = ry * cosPitch - z1 * sinPitch;
                    highp float z2 = max(0.05, ry * sinPitch + z1 * cosPitch);
                    highp float sx = x1 / z2 * focal;
                    highp float sy = -y2 / z2 * focal;
                    highp vec2 p = vec2(centreX + sx * cosRoll - sy * sinRoll, centreY + sx * sinRoll + sy * cosRoll);
                    vUp = qt_MultiTexCoord0.x;
                    vDist = d;
                    vAhead = ahead;
                    gl_Position = qt_Matrix * vec4(p, 0.0, 1.0);
                }"
            fragmentShader: "
                uniform lowp float qt_Opacity;
                uniform highp float hue;
                uniform highp float flash;
                uniform highp float sweep;
                uniform highp float mirror;
                uniform highp float heart;
                uniform highp float bright;
                varying highp float vUp;
                varying highp float vDist;
                varying highp float vAhead;

                lowp vec3 hsv(highp float h, highp float s, highp float v) {
                    highp vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
                    return v * mix(vec3(1.0), k, s);
                }

                void main() {
                    // A beam every 1.5 units of road, leaning as the sweep goes.
                    highp float lean = mirror * sin(sweep + vDist * 0.08) * 2.5;
                    highp float b = fract((vDist + vUp * lean) / 1.5);
                    highp float width = 0.05 + vAhead * 0.002;
                    lowp float beam = smoothstep(width, 0.0, min(b, 1.0 - b));
                    // Bright at the foot, fading out high above the screen.
                    lowp float rise = 1.0 - vUp * 0.8;
                    lowp float wave = heart;
                    lowp float light = (beam * rise + 0.2 * rise * rise) * (0.12 + flash * 0.88)
                        + wave * rise * rise * 0.5;
                    lowp float fog = exp(-vAhead * 0.045) * (1.0 - smoothstep(18.0, 30.0, vAhead));
                    lowp float a = clamp(light * fog * bright, 0.0, 1.0);
                    gl_FragColor = vec4(hsv(hue + 0.08, 0.85, 1.0) * a, a * 0.8) * qt_Opacity;
                }"
        }
      }
    }

    // The track: a strip of 140 rows, far end first so nearer rows paint over
    // a crest, bent into place by the vertex shader.
    ShaderEffect {
        id: track
        anchors.fill: parent
        // Ten columns: with one, each row's two triangles bend the lane lines
        // into a sawtooth where the row is not a parallelogram.
        mesh: GridMesh { resolution: Qt.size(10, 160) }
        property real camD: win.dist
        property real camX: win.camX
        property real camY: win.camY
        property real cosYaw: win.cosYaw
        property real sinYaw: win.sinYaw
        property real cosPitch: win.cosPitch
        property real sinPitch: win.sinPitch
        property real cosRoll: win.cosRoll
        property real sinRoll: win.sinRoll
        property real curveAmp: win.curveAmp
        property real hillAmp: win.hillAmp
        property real k1: win.k1
        property real k2: win.k2
        property real k3: win.k3
        property real k4: win.k4
        property real focal: win.focal
        property real centreX: win.width / 2
        property real centreY: win.centreY
        property real hue: win.hue
        property real pulse: win.pulse
        property real heart: win.heart
        property real bright: win.bright * (win.silent ? 0.6 : 1.0)
        vertexShader: "
            uniform highp mat4 qt_Matrix;
            attribute highp vec4 qt_Vertex;
            attribute highp vec2 qt_MultiTexCoord0;
            uniform highp float camD;
            uniform highp float camX;
            uniform highp float camY;
            uniform highp float cosYaw;
            uniform highp float sinYaw;
            uniform highp float cosPitch;
            uniform highp float sinPitch;
            uniform highp float cosRoll;
            uniform highp float sinRoll;
            uniform highp float curveAmp;
            uniform highp float hillAmp;
            uniform highp float k1;
            uniform highp float k2;
            uniform highp float k3;
            uniform highp float k4;
            uniform highp float focal;
            uniform highp float centreX;
            uniform highp float centreY;
            varying highp float vSide;
            varying highp float vDist;
            varying highp float vAhead;
            void main() {
                highp float far = 1.0 - qt_MultiTexCoord0.y;
                highp float ahead = 0.6 + 60.0 * far * far;
                highp float d = camD + ahead;
                highp float side = (qt_MultiTexCoord0.x - 0.5) * 4.8;
                highp float rx = curveAmp * 6.0 * (sin(d * k1) + 0.6 * sin(d * k2 + 1.3)) + side - camX;
                highp float ry = hillAmp * 3.0 * (sin(d * k3 + 0.7) + 0.5 * sin(d * k4 + 2.1)) - camY;
                highp float x1 = rx * cosYaw - ahead * sinYaw;
                highp float z1 = rx * sinYaw + ahead * cosYaw;
                highp float y2 = ry * cosPitch - z1 * sinPitch;
                highp float z2 = max(0.05, ry * sinPitch + z1 * cosPitch);
                highp float sx = x1 / z2 * focal;
                highp float sy = -y2 / z2 * focal;
                highp vec2 p = vec2(centreX + sx * cosRoll - sy * sinRoll, centreY + sx * sinRoll + sy * cosRoll);
                vSide = side;
                vDist = d;
                vAhead = ahead;
                gl_Position = qt_Matrix * vec4(p, 0.0, 1.0);
            }"
        fragmentShader: "
            uniform lowp float qt_Opacity;
            uniform highp float hue;
            uniform highp float pulse;
            uniform highp float heart;
            uniform highp float bright;
            varying highp float vSide;
            varying highp float vDist;
            varying highp float vAhead;

            lowp vec3 hsv(highp float h, highp float s, highp float v) {
                highp vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
                return v * mix(vec3(1.0), k, s);
            }

            void main() {
                lowp vec3 tint = hsv(hue, 0.85, 1.0);
                lowp vec3 tint2 = hsv(hue + 0.12, 0.8, 1.0);
                highp float ax = abs(vSide);
                // Lines widen with distance by about what one pixel covers.
                highp float px = 0.004 * vAhead + 0.006;
                highp float sp = fract(vDist * 0.25);
                // Along the track a pixel covers more distance than across it.
                lowp float stripe = smoothstep(px * (1.5 + vAhead * 0.15), 0.0, min(sp, 1.0 - sp) * 4.0);
                lowp float fog = exp(-vAhead * 0.045);
                lowp float wave = heart;
                lowp vec3 col;
                lowp float alpha = 1.0;
                if (ax < 1.0) {
                    lowp float dash = step(0.5, fract(vDist * 0.125));
                    lowp float divider = smoothstep(px * 1.5, 0.0, abs(ax - 1.0 / 3.0)) * dash;
                    // The heartbeat widens the edge and lights it toward white.
                    lowp float edge = smoothstep(px * (2.5 + pulse * 3.0 + wave * 6.0), 0.0, 1.0 - ax);
                    col = tint * 0.06 + tint * stripe * (0.25 + pulse * 0.25) + tint2 * divider * 0.55
                        + tint * edge * (0.9 + pulse * 0.5 + wave * 1.2) + vec3(1.0) * edge * wave * 1.4;
                } else {
                    highp float gx = fract(ax * 2.0);
                    lowp float grid = smoothstep(px * 2.0, 0.0, min(gx, 1.0 - gx));
                    lowp float glow = exp(-(ax - 1.0) / (0.15 + pulse * 0.25 + wave * 0.45));
                    col = tint * (grid * 0.12 + stripe * 0.08 + glow * (0.35 + wave * 1.3));
                    alpha = 1.0 - smoothstep(1.6, 2.4, ax);
                }
                // The far end fades out, so a bend or crest there never shows
                // as a hook against the sky.
                alpha *= 1.0 - smoothstep(42.0, 60.0, vAhead);
                col *= fog * bright;
                gl_FragColor = vec4(col * alpha, alpha) * qt_Opacity;
            }"
    }

    Repeater {
        id: blocks
        model: win.blockCount
        Item {
            property bool active: false
            property real ahead: 0
            property real arriveAt: 0
            property int lane: 1
            property int kind: 0
            property bool gate: kind >= 3
            property real tint: kind === 4 ? 0.0 : (kind === 3 ? 0.15 : (kind === 0 ? 0.5 : (kind === 1 ? 0.33 : 0.72)))
            visible: false
            // Above the track (z 0), nearer blocks over farther ones.
            z: 1 + (100 - ahead) / 100

            function place() {
                var p = win.project(ahead, gate ? 0 : win.laneX(lane), 0);
                if (p.depth <= 0 || ahead > win.spawnAhead + 2) { visible = false; return; }
                var w = win.laneStep * (gate ? 3 : 0.6) / p.depth * win.focal;
                width = w;
                height = w * (gate ? (kind === 4 ? 0.3 : 0.18) : 0.55);
                x = p.x - w / 2;
                y = p.y - height;
                rotation = Math.atan2(win.sinRoll, win.cosRoll) * 180 / Math.PI;
                opacity = Math.min(1, (win.spawnAhead - ahead) / 6) * Math.exp(-ahead * 0.02);
                visible = true;
            }
            onActiveChanged: if (!active) visible = false

            Rectangle {
                anchors.fill: parent
                radius: Math.max(1, height * 0.12)
                color: parent.gate ? "transparent" : Qt.hsla((win.hue + parent.tint) % 1, 0.95, win.level > 0 ? 0.18 : 0.1, 1)
                border.width: Math.max(1, Math.round(parent.height * (parent.gate ? 0.2 : 0.09)))
                border.color: Qt.hsla((win.hue + parent.tint) % 1, 0.95, win.level > 0 ? 0.62 : 0.4, 1)
            }
        }
    }

    Item {
        id: craft
        width: Math.round(150 * win.unit)
        height: Math.round(80 * win.unit)
        z: 10
        rotation: Math.atan2(win.sinRoll, win.cosRoll) * 180 / Math.PI

        // A catch flares the engines, fading over half a second.
        property real catchFlare: 0
        function flash() { flashAnim.restart(); }

        // Two engines under the hull, pulsing on the beat and flaring on a
        // catch; drawn as items so the ship itself is painted only when its
        // colour changes.
        Repeater {
            model: 2
            Rectangle {
                property real size: (14 + win.pulse * 8 + craft.catchFlare * 10) * win.unit
                width: size
                height: size * 1.5
                radius: size / 2
                x: craft.width * (index === 0 ? 0.43 : 0.57) - width / 2
                y: craft.height * 0.86 - height * 0.3
                color: Qt.hsla((win.hue + 0.5) % 1, 0.95, win.level > 0 ? 0.6 : 0.4, 1)
                opacity: 0.45 + win.pulse * 0.35 + craft.catchFlare * 0.2
            }
        }

        Canvas {
            id: craftShape
            anchors.fill: parent
            property real hue: Math.round(win.hue * 40) / 40
            onHueChanged: requestPaint()
            onPaint: {
                var c = getContext("2d");
                var w = width;
                var h = height;
                c.clearRect(0, 0, w, h);
                var light = win.level > 0 ? 0.7 : 0.45;
                c.lineJoin = "round";
                c.lineWidth = 3 * win.unit;
                c.strokeStyle = Qt.hsla(hue, 0.9, light, 1);
                c.fillStyle = Qt.hsla(hue, 0.9, light * 0.16, 1);
                function shape(points) {
                    c.beginPath();
                    c.moveTo(points[0] * w, points[1] * h);
                    for (var i = 2; i < points.length; i += 2) c.lineTo(points[i] * w, points[i + 1] * h);
                    c.closePath();
                    c.fill();
                    c.stroke();
                }
                // Swept wings, then tail fins, then the hull over them.
                shape([0.41, 0.48, 0.03, 0.80, 0.06, 0.88, 0.40, 0.80]);
                shape([0.59, 0.48, 0.97, 0.80, 0.94, 0.88, 0.60, 0.80]);
                shape([0.43, 0.60, 0.35, 0.30, 0.45, 0.52]);
                shape([0.57, 0.60, 0.65, 0.30, 0.55, 0.52]);
                shape([0.50, 0.04, 0.58, 0.40, 0.61, 0.84, 0.50, 0.94, 0.39, 0.84, 0.42, 0.40]);
                // The cockpit, lit.
                c.fillStyle = Qt.hsla((hue + 0.5) % 1, 0.8, light, 1);
                c.beginPath();
                c.ellipse(w * 0.465, h * 0.26, w * 0.07, h * 0.2);
                c.fill();
            }
        }

        SequentialAnimation {
            id: flashAnim
            NumberAnimation { target: craft; property: "catchFlare"; to: 1; duration: 60 }
            NumberAnimation { target: craft; property: "catchFlare"; to: 0; duration: 450; easing.type: Easing.InQuad }
        }
    }

    Repeater {
        id: sparks
        model: win.sparkCount
        Rectangle {
            property real sx: -100
            property real sy: -100
            property real svx: 0
            property real svy: 0
            property real life: 0
            property real tint: 0
            visible: life > 0
            z: 11
            width: Math.round(7 * win.unit)
            height: width
            radius: width / 2
            x: Math.round(sx - width / 2)
            y: Math.round(sy - height / 2)
            opacity: life
            color: Qt.hsla((win.hue + tint) % 1, 0.95, win.level > 0 ? 0.65 : 0.42, 1)
        }
    }

    // The drop: a brief, dim wash of colour, as the track lets go.
    Rectangle {
        id: dropWash
        anchors.fill: parent
        z: 13
        color: Qt.hsla((win.hue + 0.5) % 1, 0.9, 0.5, 1)
        opacity: 0
        visible: opacity > 0
    }

    ParallelAnimation {
        id: dropFlash
        SequentialAnimation {
            NumberAnimation { target: dropWash; property: "opacity"; to: 0.25; duration: 90 }
            NumberAnimation { target: dropWash; property: "opacity"; to: 0.0; duration: 900; easing.type: Easing.InQuad }
        }
    }

    Timer { interval: 33; running: true; repeat: true; onTriggered: win.step() }
    Timer { interval: 66; running: true; repeat: true; onTriggered: win.poll() }

    Component.onCompleted: {
        win.lastStepAt = Date.now();
        win.hue = 0.6;
        placeCamera();
        poll();
    }
}
