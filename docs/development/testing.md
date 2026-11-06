# Testing and CI

Every pull request is checked on [GitHub Actions](https://github.com/rorygallagher2024/glasshouse/actions) before it is merged. Most of
the checks exist because a mistake of that kind once reached a release, or
could have without anyone noticing: the TV gives little feedback when
something is wrong, and Home Assistant and the TV's own browser fail quietly.

## On every pull request

`test-audio.js` exercises the public audio endpoint with captured G3/Marantz
declarations: receiver formats remain separate from TV capabilities, an eARC
EDID flag does not promote ARC, stale driver values do not become live audio,
and corrupt or missing evidence remains unknown. A named read of the sound output
wins over a stale whole-category read, and a refused one leaves the category's
values. Synthetic C9 cases cover `dimension.input`, HAWK2's native EDID, invalid
checksums/lengths/bytes, failed native reads without family fallback, and
omission of unspecified, disconnected or unstable channel metadata. They check
logical input parameters and that native-app playback never reads an arbitrary
HDMI port. Channel metadata does not establish a codec, playback or eARC
negotiation. Additional C9 cases identify one connected CEC audio system when
the ARC service is unavailable; failed, disconnected, non-audio, negative ARC
flags and ambiguous devices do not choose a receiver. Explicit inactive ARC
state remains inactive despite CEC presence. `test-audio-detection-ui.js` checks
receiver naming, escaping and the distinction between device detection,
unknown live status and negotiated transport.

The suite also checks that wrong targets, unverified helpers, read-only
mode and cross-origin requests cannot launch the privileged helper. On a
mocked OLED83G54LW with the native package, it checks that HD payload is
reported only with every readiness signal, that leftover changes ask for
restoration, that a receiver or link not fit for the mode is refused before
the controller runs, and that a failed or incomplete disable is not confirmed.
Hardware qualification of a DTS override still requires a source-to-receiver
trial.

The dashboard check opens both Audio tabs: the sound settings come first and
are gone from the TV app's System tab, experimental forwarding asks for a
second OK to enable and stops in one, and unsupported, read-only and
failed-read states offer no override. Helper writes are intercepted in the
browser; this does not qualify forwarding on hardware. Both tabs render C9
source channel metadata separately from incoming audio. The web tab also
rejects a late pre-change snapshot, removes stale controls after a failed read
and restores them after a successful retry.

`test-lgsettings.js` checks that picture writes refuse hidden settings and
inactive choices, alongside locked rows and values outside the TV's range, and
that a TV which describes none of its picture settings is offered none, and
that colour management follows Colour adjustment where the TV offers User
Selection and is greyed out in Game mode. Sound settings read again by name
win over the whole category's, only keys the whole read returned are named,
and a failed named read leaves the category's values.

The TV dashboard check adjusts two picture sliders before the first write
answers. Both changes must be sent, including when the first write is refused
or its connection fails. With no picture settings offered, neither dashboard
shows the Picture tab.

[`checks.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml) runs these on each pull request and each merge to main.

| Check | What it catches |
| :--- | :--- |
| [`check-es5.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L23-L24) | Newer JavaScript in the on-TV server or the TV app. webOS 2 runs node 0.10 and webOS 4 (the B8) 0.12, where it is a parse error and the server never starts. |
| [`Modules parse`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L26-L27) | A syntax error in `tvweb.js` or a server module. |
| [`check-ui-ids.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L29-L30) | An element the dashboard's script reaches for that the page no longer has. |
| [`check-module-calls.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L34-L35) | A call to something a server module no longer exports, such as a caller left behind by a rename. TypeScript reads it as `any` in JavaScript, so only this finds it. |
| [`check-strings.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L37-L38) | Dashboard text without a translation key, English joined from pieces with `+`, and translations made from English that has since changed. [Translating the dashboards](../STRINGS.md) has the rules. |
| [`check-screensavers.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L40-L41) | Screen saver QML that the TV's QtQuick version cannot load. |
| [`check-drift.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L43-L44) | The [entity reference](../HOME-ASSISTANT-ENTITIES.md) out of step with the entities the server publishes, and a dashboard file missing from `deploy.sh`'s list, which would never be installed. |
| [`check-entity-stability.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L47-L48) | A Home Assistant entity from the last release that has gone, been renamed or changed domain, which leaves it unavailable and stops every automation that used it. A deliberate removal is listed in [`scripts/retired-entities.txt`](https://github.com/rorygallagher2024/glasshouse/blob/main/scripts/retired-entities.txt) with the reason. |
| [`shellcheck`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L51-L52) | Mistakes in `deploy.sh`, `tvwebctl`, the boot script, `check-all.sh` and `tv.sh`. |
| [`TypeScript`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L54-L55) | Type errors, from the JSDoc types in the server's JavaScript. |
| [`check-entities.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L57-L58) | A Home Assistant entity reading a field the TV's telemetry does not have, checked against a B8's real telemetry. A field read with a fallback (`else`, or `or` another field) may be absent. |
| [`check-upgrade.js`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L61-L62) | A release the updater already installed on a TV would refuse. The updaters of the latest release and the oldest still in use install the change in place, from a local copy, as a TV does when it updates; 0.82.0 and 0.82.1 could not be installed that way (#586). |
| [`Package build`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L65-L77) | The Homebrew Channel `.ipk` still builds, and passes the Homebrew Channel's own compatibility check for webOS 2.2 and later, the oldest confirmed (a 49LF632V). |
| [`Unit tests`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L81-L97) | Each part of the server, and one suite that starts the whole server against a fake TV and MQTT broker, with a TV that answers, one that answers late, wrongly or not at all, MQTT disabled, and a Glasshouse Home file missing, and checking the dashboard keeps answering and telemetry keeps flowing. |

No unit test runs a TV's own commands on the computer it runs on. A module
that restarts LG's services, such as `apps.js` and `samrescan.js`, takes the
function that runs them from its `init`, and the tests pass one that records
the command instead: run for real, the sam restart in `test-apps.js` asked a
Linux computer for a password and could end a Mac's own processes (#918).

## On each supported TV's node

The unit tests run on node 0.10 (webOS 2, a 49LF632V), 0.12 (webOS 4, the B8), 8.12 (webOS 6), 16
(webOS 9, the C2), 20 and 24, each in parallel in the [`tv-node` job](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L81-L97). A computer's node
accepts calls an older one lacks.

So the tests run on node 0.10 as well, and use none of what it lacks: no
`execSync`, `spawnSync`, `fs.mkdtempSync`, zlib's sync calls or `Buffer#equals`
unless a fallback is in place. `test/test-syslog.js` and `test/test-logs.js`
make temporary folders without `mkdtempSync`, and `test/test-installer.js`
gzips without `zlib.gzipSync`. The suites that run the repository's own scripts
through `execSync`, `test-module-calls.js`, `test-tvwebctl.js` and
`test-remote-worker.js`, skip on node 0.10.

Some of what node 0.10 lacks only fails when the call is made, on a TV. It
takes `'inherit'` only as a child's whole `stdio`, not in the list, which kept
the remote's buttons from reaching Home Assistant on webOS 2;
`test-spawn-stdio.js` fails on one in the server's code.

`test-installer.js` checks that Glasshouse's own package install holds the
restart and install guards, then releases both before reporting success or failure.

`test-remote-worker.js` runs the remote-button worker's Python tests
(`test/test_remote_buttons.py`) under Python 3: a disconnected device and one at
EOF are dropped rather than read in a busy loop, a device with nothing to read
yet is kept, and a device that comes back is reopened and its buttons arrive.
The worker itself stays Python 2.7 compatible for the TV.

Remote-key log checks include the first press immediately after assigning a
key: the reader polls from its saved byte offset, so the press is not lost
before its first read.

`test-repo.js` checks declared source URLs from the Homebrew Channel and added catalogs, including missing, malformed and unsafe addresses, GitHub downloads mapped to their repository, and other `.ipk` downloads omitted without changing installation URLs. `test-catalog-ui.js` checks source-link escaping, new-tab attributes, placement beside the primary action using the idle pill style, and availability across app states and disabled controls in both lists, including corrected and omitted download links.

`test-saver-manifests.js` reads screen saver folders: the order and ids, a folder with something wrong listed with the reason, staging, translated names, and what one added on the TV does past the screen. An installed homebrew app's screen saver is listed from its app, by either file name, with the same checks, an app without one is left out, only its QML is staged, and one whose app has gone counts as LG's.

`test-remote-buttons.js` checks the codes of the buttons reported to Home Assistant, that the Python worker that reads the devices has the same codes as `remotebuttons.js`, and that the Remote Button entity declares every reported button as an event type. `test-remotekeys.js` also checks that Power off requests standby once on release, works with the panel blank, and does not switch off after a press that wakes the TV; `test-remotekeys-webos11.js` checks that native filters neither offer nor accept it. `test-remotekeys.js` checks that the Home Assistant choice is offered only with MQTT on and for those buttons, and that the filter keeps a key set to it from the TV.

`test-screensaver-dropped.js` covers a refused request's fallback, remote dismissal and restart recovery, failed closes, delayed replies, and playback or source changes that must prevent a launch. `test-remote-buttons.js` checks that Home, coloured buttons and ordinary keys reach the dismissal handler through both parsed events and the worker stream, including split lines.

`test-idlesaver.js` checks that an idle screen saver refused by panel care is asked for again without its hold, and that the hold is put back when it closes or is still refused, but not over an app that has come to the front since. An app that still refuses it is not lifted again until another app is in front or the TV leaves On. Failed restores are retried, a lost policy reply remains tracked, and a server restart recovers an outstanding lift. Delayed idle callbacks respect later power changes, and a dashboard lift expires if no screen saver starts. Its own request's refusal, playback and a TV without `setEplAppInfo` are left alone. The assertions run on Node 0.10 and 0.12 as well as newer versions.

`test-luna-absent.js` checks that a failed call to an LG service missing from the TV's service files makes later calls to it fail at once, for 10 minutes, while listed services and homebrew ones keep being called, and that a renamed service the TV lists only by its legacy name moves to that name after no answer under the newer one, rather than being skipped.

`test-luna-slow.js` checks that the tuner's channel list, 4.6 MB and 3.6 s on a satellite TV, is given a longer wait and a larger reply limit and is asked for without `-f`, while other calls keep their 2 s wait and `-f`.

`test-window-state.js` checks that short gaps in window focus do not publish empty remote attributes, persistent gaps do, standby clears immediately, and reconnects republish the retained state. The server boot test checks that the three SurfaceManager subscriptions start only with MQTT enabled.

The state-push suite checks `keyboard_visible` from the window list: pushed on change, the app under it kept as the control target, false in standby, and left out on a TV without the method. `test-controls.js` checks that remote keys go to the remote's device while the keyboard is up and that typing, Enter and Backspace reach the input method service in order, and that the Server tab's TV name is saved and applied without a restart, with empty putting back LG and the model; `test-mqtt-remote.js` that typed text keeps its spaces and schedules no telemetry read.

`test-home.js` checks that switching on has sam read the mounted app before LG's Home is stopped and switching off the reverse, that on webOS 11 an LG Home started again is stopped and the preload manager told not to keep it while the place is held, both undone with the place and neither done on webOS 9 or 10, that on webOS 4 no starting notice holds the Home key and a press the view does not answer closes it and opens it afresh before LG's ribbon has the key, that elsewhere a short press with the view in front opens it again, which closes its folder, guide or player, and from another app leaves the opening to the TV and the page's escape when its first load fails is ignored, that the heartbeat says when the view is covered, by the screen saver or on webOS 4 by what is in front, that where eim names neither `hdmiPlugIn` nor `connected`, as on a B8, the ports' HDMI reading says which are plugged in, that on webOS 11 the view is closed and opened again once after a wake while it is in front, but not where an app was opened since, after a switch-off or on other webOS, that on webOS 10 sam rereads it on a block and release and has it as the home category's app, that a server finding it mounted with an earlier release's manifest has sam read the new one even after a restart between staging and rereading, that a refused upgrade puts LG's Home back and reports failure, that webOS 4, 10 and 11 are offered and webOS 3 and webOS 12 and later only with `allowExperimentalHome`, webOS 3 as on webOS 4, that after a start the rows come from the lists last read while they are read again, a change among them reloading the view, that LG's files go back where sam does not take the app, the ways back to LG's Home and the return, a switch-off cut short being finished at start, what earlier builds changed being put back once, failed saves, a healthy view whose heartbeats later stop, and a short Home press that brings no heartbeat: WebAppMgr started and the view opened again where it is not running, as for a view that stops beating, LG's Home given its place where it will not start, or where it is running once the longer wait for a page still loading is over, the view kept where it answers within that wait, and nothing done when the view answers. It also checks that a view gone quiet behind another app's window is left alone, that on webOS 6 an input put back over LG's Home just after sam restarts has LG's Home opened again once, and that a C1's 6.4.0 answer of no `defaultApps` at all reads as unset. A short Home press followed by an input opened from the view, or by anything else coming to the front, keeps Glasshouse Home. A view opened after a wake or by the boot hook whose page never runs gives LG's Home its place after the short wait, one whose page runs only after the longer wait, and one that answers, or an input chosen meanwhile, keeps Glasshouse Home. It also checks that the wallpaper's darkening is 100% until set, taken from 0 to 100 and kept when not sent, that a Glasshouse Home switched on fresh is Pure white while one that saved the view's own look keeps it, that LG's layout is left alone unless the empty one is chosen, that the choice applies at once while Glasshouse Home has the place, that a TV an earlier build left on the empty layout keeps it, that LG's notifications and search are on the Apps row, marked as opening over Home, that fading and leaving out inputs with nothing plugged in stay off until switched on and outlast a reset, beside inputs hidden one by one, which are kept, and that a row set to Last opened puts what was opened last first, from the view or the remote, with the channel Live TV was on even when the view asks before Live TV has left, records nothing while Glasshouse Home is off, and forgets a row put back in its own order. `test-tvwebctl.js` also checks that a third restart in ten minutes gives LG's Home its place back. `test-remotekeys.js` checks that a mapping which could not be deleted is reported as a failed change, and that the starting notice holds Home for 90 s after the filter loads, and not at all without the compositor's timer. `test-remotekeys-webos11.js` checks webOS 11's path: LG's input switcher offered first as a choice of its own and set like an app, the streaming buttons LG has switched on, Guide, Home Hub and the ? button offered with no filter chain and left out of the JavaScript filter, the ? button refusing Nothing, the AI button switching LG's voice assistant off and back on and answering its log line once, read from a log that is appended to and replaced, and not offered without that service, the Netflix button set to Screen off switching LG's app off and turning the screen off from the log only with the picture on, after tvpower has finished a change or a screen saver the press ends has gone, and set again unasked after LG writes its list back, Screen off refused on Guide, the Alexa button blocking Amazon's view and releasing it, an already blocked view counting as blocked, toasts switched off for the Alexa press only and back on at the start after a restart, LG's list set again after LG writes it back, after a power change where nothing is announced, and at most twelve times a minute, each change written to LG's own value and only that one, LG's value put back for As LG has it, a key set again after LG sends its list again with LG's newer entry kept to put back, `restore` putting back every key, and nothing written while no key is set. `test-tesseract.js` checks the tesseract screen saver's geometry: 16 corners and 32 edges along one axis each, rotations that keep distances, a six-hour clock that starts again without a jump, and the figure staying on screen through the whole cycle.

`test-i18n-pick.js` checks which language the pages pick: the browser's, except one translated only in part on a page it does not cover in full, and one chosen or asked for in the address on every page. A language with its region, such as `pt-br`, is picked whole, and only for that region.

`test-home-launcher.js` puts a custom launcher in Glasshouse Home's place through the HTTP routes: a single HTML file, a zip of a folder and an ipk's web app each unpacked and served with the kit first in the start page's head, the start page and title taken from `appinfo.json` or the page, links and macOS's extra files left out of a zip, and a web address shown in the frame with its address escaped. A zip reaching outside its folder, a native app, a file of another kind and an upload the TV has no room for are refused, keeping the launcher before them. Only a launcher kept can be chosen, Home's page and the heartbeat follow the choice, Minimal, which comes with Glasshouse, is listed first, served with the kit when chosen and never removed, removing the chosen one gives Glasshouse Home its place again, and the first release's single launcher is kept as the owner's own, still chosen.

`test-home-picture.js` reads a G3's receiver files with Glasshouse Home on screen: the signal and HDR of the input behind it, the picture mode asked for with both input and dynamic range, an empty input, and HDR from the receiver's packets (PQ, HLG, none, Dolby Vision). Only the mode for the range coming in is asked for, none without a signal, and a channel's SDR mode. It also checks that tracking runs only while Glasshouse Home, picture details and the TV are all on, that it retains an app's first video before any app plate is read, and that standby or switching either off stops it and leaves the recorded video available.

The same suite checks the preview's HDMI signal read and a channel's decoded
format through the public picture read, including SDR, HLG, HDR10, Dolby
Vision and Technicolor HDR selecting their stored picture modes, and another
broadcast's HDR context being ignored. `test-home.js` checks that Live preview
defaults to off and saves its choice. The browser check changes Picture details
during HDMI and channel previews, without restarting playback, rejects a late
reply after the details are disabled, and checks that switching Live preview
off releases its media source. Desktop media methods are stubbed; webOS
decoding, sound and CEC still need a real TV.
Delayed guide and catalogue replies cannot reopen a preview after **OK**;
a refused launch or returning to Home allows it again.
A browser check opens Glasshouse Home with each animated background and
checks that it shows, draws on its canvas and hides the wallpaper pictures,
and that Off takes it away and leaves the canvas without pixels. The upload
check opens the dashboard's Background section on None, where the pictures'
settings are hidden, and chooses Pictures, whose sets leave Black out. `test-home.js` checks that only the backgrounds
offered are kept, and their colours: Time of day unless chosen, a preset, or
`#rrggbb` of one's own.
A browser check sets up a custom launcher on the Home tab: its button opens
the section, a web address with Glasshouse Home on becomes the TV's Home at
once, the Apps and Inputs rows stay to arrange while it is in use without
Glasshouse Home's other settings, the four choices read LG Home, Glasshouse
Home, Glasshouse Minimal and Custom, Custom's settings show only while it is
chosen or being set up, and Glasshouse Minimal, Glasshouse Home and Custom
swap without a second press, the upload is offered only where installing from a file is,
and Remove takes it away. It
then uploads a page to the real server and checks that `window.Glasshouse`
lists the fake TV's apps before the page's own script runs.
A second browser check covers the TV tile and the preview's options: the TV
tile previews its last channel as a broadcast preview, an app tile previews
nothing, **Preview in the tile** puts the preview in the tile in focus and keeps
it there when the rows are rebuilt, and **Keep the preview on** shows the input
last watched with the focus on Apps. A heartbeat saying the screen saver is over
the view stops the preview, and the next one without it brings it back. `test-home.js` checks the TV tile is first
in the Inputs row on a TV with channels, absent without them, opens Live TV,
and that both options default to off and save.

`test-routes.js` checks that an upload aborted before its file opens leaves no staged file, including a disconnect while disk space is being reserved. It also checks that the phone's setup link serves its page, `i18n.js` and a language file with the one-time code, the page asking for `i18n.js` with it, and refuses them without.

`test-stats-timeout.js` checks that a stats collection past its limit answers its callers with the last complete one, or the empty stand-in when none has finished, and carries on with no second collection started beside it; that `expireStats` does not take that fallback away; and that one given up on after 60 s answers no caller of the next.

The Home suite also checks auto-launch restoration with a delayed settings
read, no write when auto launch was already off, and a refused takeover with
and without an earlier hold. Wake cases cover source changes, standby,
server stop and switch-off, including delayed power-on reason replies, and
a wake with Quick Start+ on, where LG's own auto launch value is read and
nothing is opened with Home already in front.

## Home Assistant

[`home-assistant.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/home-assistant.yml) builds every discovery config the server can publish and
runs each through Home Assistant's own validation, then checks that the volume
entities are available exactly when the TV lets their volume be changed. Home
Assistant creates no entity for a config it rejects, and says so only in its
own log, which is how Volume and Mute went missing in 0.78.0. It also renders
every template that reads telemetry against the stats each fixture TV reported
and fails on any warning Home Assistant logs: a field missing from the payload
is logged on every message, which was tens of thousands of lines an hour with
a few TVs (#761).

The job keeps the installed Home Assistant for a week, so it runs the newest release from the first run each week, the weekly scheduled one included.

It runs when the server or the check changes, not for documentation, and
weekly, since Home Assistant is not pinned: a release that starts rejecting a
config shows there first.

## The dashboards in a browser

[`dashboards.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/dashboards.yml) starts the real server against a fake TV, opens every tab of
the web dashboard and the TV app in a headless browser, and fails on any
script error or failed request, naming the tab. A 404 for an app's icon is
not a failure: it is how the server says an app has none, and the fake TV's
installed apps have no icon files. A function a page calls that has gone, or an
element it reaches for that has moved, breaks only when that tab opens, which
no unit test does. It runs when the server, the pages or the fake TV change.

The checks run in four groups side by side, each against its own server and fake TV, since the Home checks change the layout and uploads they read back. A new check goes in the group it shares state with, or in the shortest. The scrolling and motion checks, which measure the rows frame by frame, run on their own server after the others have finished, as they missed frames with the groups sharing CI's processor.

A check that waits for something to arrive, a reply or a tile opening, waits for it with `waitUntil`, up to a few seconds, rather than for a fixed time. Replies come in real time, after a faked clock has moved on, and a CI runner can take longer than a wait that is enough on a laptop: a fixed 100 ms for the preview's picture reply failed there now and then. A check that something stays off still looks after a fixed wait, so that it does not pass before the wrong state appears.

For the Home view, arranging checks cover a late catalogue reply, resetting after moving a tile, and an update noticed while arranging. Picture checks cover a layout with picture details left at their default (off), the plate's single mode and OLED light, an input with no signal keeping its line level with the source's first line, a delayed reply after changing source, and a delayed reply after switching picture details off. Its service replies are simulated; the page and its timers run in Chromium.

Scrolling checks, on a row of 30 apps under the pointer, cover hovering a tile leaving its row in place, the pointer resting at the screen's side gliding the row and coming to rest when it moves away, a click held still while the row glides opening the tile under the pointer, the wheel moving the row a tile a notch and a click after it opening the tile now under the pointer, moving down a row leaving the scrolled row where it is, the keys focusing a tile in view, and the rows still gliding after Recent apps closes while its cards glide. Motion checks read the row's place every frame: a flick to the screen's side gathers speed over several frames instead of starting at full speed, the row brakes into its last tile, and moving the pointer away lets it slow to a stop. A guide check moves a channel's programme on through the minute's refresh and finds its tile left in place rather than the rows rebuilt.

Home colour checks cover custom accents matching the stylesheet's original colours, changes and reset arriving through the heartbeat, and malformed colour values being discarded without stopping the server.

Home visibility checks delay the layout reply behind the source reply: last watched stays hidden until its saved switch is known and updates as soon as a changed layout arrives. They also cover app counts, CEC addresses, older layouts with no switches, the clock keeping its place, and with the clock switched off and the rows along the bottom, the clock hidden and the rows lower, and in Alternative View the clock right of Last watched and no row titles. `test-home.js` covers saving each switch, switching them back on and ignoring non-boolean updates.

The Home availability check covers a TV with neither Glasshouse Home nor LG's Home's options, which has no Home tab; one with LG's Home's options alone, which shows them, Open Home at power-on usable among them, without Glasshouse Home's switch or options; and Glasshouse Home switched on, which leaves LG's Home's layout and hidden system apps out. `test-home-lg-options.js` checks the server's side: the Home tab offered for hiding system apps on webOS 3.8, and for Open Home at power-on alone, the options only sent when asked for, no tab with none of them, and hiding system apps neither offered nor switched on under Glasshouse Home. `test-tile-hiding-handover.js` checks its handover to Glasshouse Home: the apps it hid hidden there, those in More apps kept, and sam never restarted for it.

For the TV app dashboard, checks verify the two-column layout geometry (the row list on the left and the hint pane on the right with non-zero dimensions and horizontal adjacency), remote D-pad navigation (`ArrowDown`, `ArrowUp`, `PageDown`), list translateY scrolling with the scroll arrow indicator, tab switching (`ArrowRight`, `ArrowLeft`), and that the OLED Care tab is dropped when running on a non-OLED (LCD) TV profile.

## Documentation

[`docs.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/docs.yml) builds this site on each pull request that changes it, with every
link and section link checked, and [`docs-publish.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/docs-publish.yml) publishes it when the
change is merged.

## Releases

Publishing a release runs [`homebrew-channel.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/homebrew-channel.yml), which builds the `.ipk`,
attaches it and the Homebrew Channel manifest to the release, and records the
package's sha256 in the manifest.

A release's notes open with a short summary for people using Glasshouse, one
to three plain lines, then a `## Details` heading with the full notes and their
pull requests. The Server tab, the TV app and Home Assistant's update entity
show only the summary, so it leaves out changes to the docs and the code
that people using it would not notice. Releases before 0.91 have no summary,
and show none.

## Running them locally

From the repository root, `scripts/check-all.sh` runs the checks CI runs, side by side, and shows the output of any that fail. It runs `npm ci` only when `package-lock.json` has changed since the last install, and `--quick` leaves out the dashboard and updater checks. `check-upgrade.js` reads the committed tree, so commit first.

```bash
scripts/check-all.sh
```

`node test/run-all.js` runs only the unit tests. Words after it run only the suites whose file name contains one, as `node test/run-all.js home luna`, and `--times` lists the slowest. A failing suite's output is printed again after the results, so the end of a long CI log shows it. A suite whose header says `@shards N` is started N times, each copy running every Nth step through `test/shard.js`: `test-home.js` waits on Glasshouse Home's real timers, up to 10 s a step, and runs as 16 copies. Each of its steps sets up the TV it needs, as no copy sees the steps another runs.

The dashboard check needs Playwright and its browser:

```bash
npm install --no-save playwright && npx playwright install chromium
node scripts/check-dashboards.js
```

A check that finds a problem runs once more on its own before the run fails:
one that passes the second time is listed as `flaky:` with what it first found,
and does not fail the run, while one that fails twice does. CI's runners are
shared and slower than a computer, so a check that times something rather than
waiting for it fails there now and then. `CPU_SLOWDOWN=4` runs every page on a
CPU slowed four times, which finds such a check before CI does:

```bash
CPU_SLOWDOWN=4 node scripts/check-dashboards.js
```

The Home Assistant check needs Python 3.13 and the `homeassistant` package:

```bash
pip install homeassistant
./scripts/check-ha-discovery.py
```

The documentation check needs MkDocs, Material for MkDocs, and `markdown-callouts`:

```bash
pip install 'mkdocs>=1.6,<2' 'mkdocs-material>=9.7,<10' 'markdown-callouts>=0.4,<0.5'
NO_MKDOCS_2_WARNING=1 mkdocs build
```

Use `NO_MKDOCS_2_WARNING=1 mkdocs serve` to preview the site locally at `http://127.0.0.1:8000/glasshouse/` with live reloading.

## Measuring Glasshouse Home on a TV

`scripts/tv.sh <tv> frames [key ...]` measures how smoothly Glasshouse Home
runs while keys are pressed. While `/var/lib/tvweb/home-trace` exists, the
view records each frame, the browser's long tasks and the time its main
functions take, and sends them with its heartbeat every 5 s. The server logs
each as a `home: frames` line. The command creates the file, presses the keys
through the dashboard's remote 0.15 s apart, prints the lines, and removes the
file however it ends. For example, Home, a run along the Apps row, and Recent
apps opened and closed:

```bash
scripts/tv.sh 192.168.1.131 frames home wait wait right right right right right right down right right wait back wait wait back
```

`over33` counts frames that took longer than two vsyncs at 60 Hz, and
`worst` is the longest, in ms. `long` lists long tasks, which webOS 4's
browser does not report. `fn` gives each timed function's calls, average and
longest ms. A gap with nothing in `fn` to explain it is the browser's own
work: style, layout, painting or decoding images.

## Local TV emulation

`scripts/emulate-tv.js` runs the server inside a simulated TV environment with procfs, sysfs, Luna calls, installed apps, remote key filters, and recent apps mocked. It serves the web dashboard, the TV app dashboard, and Glasshouse Home locally for development and visual testing without physical TV hardware:

```bash
npm run emulate
node scripts/emulate-tv.js [--port 8080] [--model c2|b8|c3|cx|c1] [--webos 6.5.3] [--home on|off] [--open]
```

The models are a C2 (webOS 9.2), a B8 (webOS 4.4), a C3 (webOS 10.3), a CX (webOS 5.6) and a C1 (webOS 6.5). `--webos` reports another version on the chosen model, for a version no profile covers. Glasshouse Home starts switched on from webOS 7, where main supports it; `--home on` starts it switched on elsewhere, for a branch that adds a version. Switching it in the emulator changes nothing, since nothing is mounted. The pages run in the computer's browser, not the TV's, so the emulator does not show what an older TV's browser gets wrong.


Home recovery checks cover a switch-off cut short, failed layout restoration and its retry, failed migration without losing the snapshot or removing the old app, closing the old app when it is left running in the background, and a missing first heartbeat when Home already has the foreground id. A refused device tile is followed by a remote input switch to check that Last opened still records the whole input. Remote-key checks cover clearing the startup notice on escape and retrying a configd write after the local map was saved. Browser checks cover pending/failed layout edits, each row's Order on the view, the Home tab and the TV app, edits attempted during an Order save and refresh, keeping unsaved moves when Order changes, clicking Order while a tile is held, first-catalogue failure, delayed readiness, the Home tab left out where Glasshouse Home is not offered, and the Apps tab's notes while it is on.

`test-home.js` also checks LG's native CEC launch contract: a receiver and a
console on the same port select their own device IDs, a direct source selects
its ID, and missing or unusable IDs and non-CEC inputs open the port alone.
Last watched on that port names the device the TV last selected there, read
fresh past the cached device list, and every device on the port when the TV
has not recorded one.

`test-home-wallpaper-upload.js` exercises the real HTTP boundary: rejected and interrupted uploads preserve the previous image, concurrent uploads are refused, the lock is released after an abort, an uploaded JPEG survives reinitialisation and is served with its image type, and one time of day's picture is removed alone, an unknown one refused. With the download stubbed, a chosen set is fetched from its tag and not again once on the TV, the owner's own pictures are kept while it shows, a picture that fails its checksum or download is not kept and leaves the choice as it was, and an older install's four example pictures become the landscape set while other uploads become the owner's own. The dashboard check chooses **Your own**, then Morning and uploads to it, preparing a PNG as JPEG, shows the pending upload in a second tab and the picture once done, drops an image on Evening, removes Morning alone and then all of them.

`test-homescreen-webos10.js` checks webOS 10's Home screen layout over a stand-in folder: the banner taking the height of the rows hidden, nothing changed before the experimental switch is on, the layout put back after a restart of the TV, the banner text hidden by a copy of LG's language files with the two strings blank and LG's left alone, a black or uploaded banner picture in each size folder, an upload cropped for each shape the banner takes with the one for its shape shown and the others kept until a part shown or hidden needs them, a bad upload refused with the picture before kept, and putting LG's Home screen back forgetting the choices and the upload.

`test-home-recent-apps.js` exercises the recent-app HTTP routes: refused and
unconfirmed stops retain their cards for retry, unavailable running lists
report failure, Close all stops web and native apps while preserving Home,
unlisted apps and newer cards, and snapshots stay out of shared caches while an
unchanged one keeps its address and is answered with a 304. The browser
check covers held OK acting once on release, close errors above the panel,
and Back or a Home relaunch cancelling a delayed panel reply.

`test-home-date.js` runs Glasshouse Home's date with the browser's default locale at en-US, as on webOS 10: a Russian page gets Russian words with the month as it follows a number (`24 октября`), and the line starts with a capital, an English page is unchanged, a browser without `formatToParts` still uses the page's language, and so does a page in a language with its region. It is skipped on a node without full ICU.

`test-home-search.js` feeds a G3's real answer for "Dune" to Glasshouse
Home's search: one film on three services is one title, only the TV's apps
are listed, a listed title opens in its app at the id LG's item detail gives,
anything not listed opens nothing, and LG's error is a failure. With a G3's
details for Severance and The Bear, a series opens at Prime Video's first
season and at Disney+'s first episode, and with no detail a title opens at
its item id less LG's service tag. A B8's answer for "the office" is listed
by the category each title is under, its detail asked of `sdp_secure` when
`sdp_onnow` gives none, and a title opened with the id put into the app's
template, or as its `contentTarget` without one. From the G3's answers for promo words,
trailers, teasers and sneak peeks are never listed while Trailer Park Boys
and Trailer War are, a series never opens at a trailer numbered as its first
episode, and switched off the search asks LG nothing.
Delayed app-list replies cannot replace a newer search's launch targets, and
an empty answer removes the preceding search's targets. Partial host discovery
retries the unanswered service after a minute. Switching Search off or blocking
its host during a series lookup prevents further detail reads and the launch.

The browser check exercises search through the Home view: editing the query clears
the previous titles before the typing delay, Enter waits for its reply, failed queries can be retried,
and repeated OK during a detail lookup sends one launch. Returning from that
app keeps the panel, a changed sleep counter closes it, late search replies
cannot refill a closed panel, and switching search off removes its entry point.
Home interaction fixtures mark both introductory hints as seen so hint saves
do not count as layout edits.

`test-iptv-parse.js` feeds Internet TV's readers in chunks of every size,
from one character up: an M3U with a BOM, CRLF, a name with commas after a
quoted group with commas, `#EXTGRP`, `#EXTVLCOPT` and `|User-Agent=` headers,
`#KODIPROP` DRM, films and series to leave out, a bare URL, a multicast link
and comma lists of guide links; Xtream's JSON with brackets and escaped
quotes inside strings, and a refusal object where the list should be; an
XMLTV guide with a DTD whose entity must not expand, CDATA, numeric entities,
offsets and shortened times. Logins are refused by `auth` and `status`
whatever the HTTP status, short EPG text is decoded only when it is base64 of
UTF-8 text, a guide id matches loosely only where one guide channel does, and
two channels whose links differ only in a rotated token keep separate keys.

`test-iptv.js` runs the server module with real worker processes and curl
against a local provider: a playlist read and published 0600 in a 0700
folder, search leaving out a provider's `### NEWS ###` headings, an added
channel's logo, play link and now and next from the playlist's own guide, a
500 keeping the last list, an edit replacing it, a refused Xtream login not
tried again until edited, a blank password keeping the saved one, no link,
token, user name or password in any reply, the row's order and removal, a
whole group added as a section numbered after the picks with its guide from
the Xtream `xmltv.php`, sections moved and given start numbers, a channel
taken out of a group staying out until added again, a rename and a star
reaching the row, a hidden group left out of a whole-playlist search, Undo
putting a channel taken out back at its number, a removed playlist's
folder deleted, and a channel whose variant playlist names FairPlay found to
be protected once checked, marked in the lineup and given no play link,
while one with a plain AES-128 key is not. It is skipped where there is no
curl. `test-iptv-drm.js` checks which HLS keys the TV's player cannot use,
and the resolving of a master playlist's first variant.

`test-iptv-worker.js` runs real playlist workers against a local provider with
a shell that sends itself SIGABRT before executing curl. It checks that an
early abort is retried once, repeated aborts stop after two attempts, and a
partial body, ordinary network error or other signal is never retried, and
two aborts are reported as such rather than as a network failure. A
failed job leaves no partial snapshot. The native webOS libuv fault still
needs a Node 8 TV; the test injects its downloader exit signal.

`test-iptv-lineup.js` checks the lineup's rules alone: a version 1 selection
becoming one section of favourites, numbering through sections with a start
number already passed moved on, a channel in two sections counted once, a
channel removed from a pick ahead of its group staying out of both, the 60
favourites, stars kept by a channel another section still carries, renames,
the 2,000 cap, moved keys followed, malformed entries dropped, several
groups added or sections removed in one edit, stars for many stopping at a
full row, channels moved out of a group into a new section and added into
one, sections and single channels taken out in one edit, and a refused
edit leaving the selection as it was.

`scripts/fake-iptv.js` is a provider to drive Internet TV by hand or in the
emulator (it is not deployed). It serves an M3U and an Xtream panel with
the quirks above, logos in the styles real ones come in (and dead links), an
XMLTV guide, and three live HLS test channels from ffmpeg, one without CORS:

```bash
node scripts/fake-iptv.js --port 8090
node scripts/fake-iptv.js --port 8091 --channels 100000 --guide-channels 16000 --no-video
node scripts/fake-iptv.js --port 8095 --channels 20000 --groups 120 --no-video
```

`--groups` adds that many country groups (*DE | Sport*, *FR | News* and so
on), as a subscription of hundreds of groups lists them, for the channel
manager.

Its M3U takes `?mode=401`, `403`, `429` (with `Retry-After`), `500`, `html`,
`gzip`, `slow` and `truncate`; a wrong Xtream password is `auth: 0` with HTTP
200, three in a minute block the address for a minute, and its live links
redirect to a token that expires after 90 s. It allows one connection, counted
as a panel does, by the client address that fetched a segment in the last
12 s, so a TV changing channel replaces its own; `/admin/state` reports
`concurrentSessions` apart, the streams fetching segments in the last 4 s,
which stays at 1 when each is closed before the next opens.
`/admin/rotate` rotates every M3U token. The second command makes a
100,000-entry playlist and a guide of about 200 MB unzipped, for the size
drills. The emulator starts Internet TV's overdue jobs after 5 s rather than
3 to 8 minutes (`iptv.catchupMs` in its config).

The Home tab loads Internet TV playlist settings from `assets/ui/iptv.js` and
the channel manager from `assets/ui/tvchannels.js`; the browser check exercises
both through their page entry points.

The browser check drives Internet TV on Glasshouse Home with its API answered
in the page: the row's names tidied, a channel previewed after its dwell with
the lease taken, the preview grown into the player without opening the stream
again, OK during the dwell giving one stream and keeping the player's picture,
the channel list changing channel after releasing the last stream, Back, the
guide's schedule, and the add panel listing a playlist's groups. It then
drives the channel manager the same way: a hidden group left out, a group's
channels listed and added whole, a star, a Shift-click run added from the
bar in one edit, Delete taking a selected channel out, Escape clearing a
selection before it closes the page and its address, one pane at a time at phone width, and in the TV app, the groups,
a channel added with OK, and Back up one list.

The sideload route check forces an upload to abort before its file opens,
then confirms that the eventual descriptor closes and the staging file is
removed. This catches Node 0.12's destroy-before-open behaviour without
relying on the filesystem finishing within a fixed delay.

The Internet TV regression checks also cover a full 2,000-channel lineup
through real workers, a bulk add that overlaps channels already carried,
and failed selection saves (including Undo) without changing the lineup or
its history. Home accepts unstarred lineup channels and refuses unknown
ones; the generated remote filter opens the standalone Home app's guide
when the Home key names it. Browser checks cover the Guide tile and
now-and-next without favourites, and a delayed response from the previous
provider leaving the chosen provider's groups in place.
With **Preview in the tile** on, the browser check verifies the IPTV preview
fills its tile, opens at full-screen size and returns without reopening the
stream, and leaves the hidden rows when the guide opens.
The TV app's manager check opens the lineup through the Home tab with
Glasshouse Home enabled in its API fixture, then uses the remote keys.
The audio route checks use a readable stream for request bodies, including
the UTF-8 decoding used by every JSON POST.
The split-character route fixture uses the server's buffer helper so it
also runs on Node 0.10 and 0.12.
