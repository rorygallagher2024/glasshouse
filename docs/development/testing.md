# Testing and CI

Every pull request is checked on [GitHub Actions](https://github.com/rorygallagher2024/glasshouse/actions) before it is merged. Most of
the checks exist because a mistake of that kind once reached a release, or
could have without anyone noticing: the TV gives little feedback when
something is wrong, and Home Assistant and the TV's own browser fail quietly.

## On every pull request

`test-audio.js` exercises the public audio endpoint with captured G3/Marantz
declarations: receiver formats remain separate from TV capabilities, an eARC
EDID flag does not promote ARC, stale driver values do not become live audio,
and corrupt or missing evidence remains unknown. The endpoint is read-only and
starts no process.

The dashboard check opens both Audio tabs: the sound settings come first and
are gone from the TV app's System tab, and a failed read leaves no stale
readings. The web tab removes stale controls after a failed read and restores
them after a successful retry.

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
| [`shellcheck`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L51-L52) | Mistakes in `deploy.sh`, `tvwebctl` and the boot script. |
| [`TypeScript`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L54-L55) | Type errors, from the JSDoc types in the server's JavaScript. |
| [`check-entities.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L57-L58) | A Home Assistant entity reading a field the TV's telemetry does not have, checked against a B8's real telemetry. A field read with a fallback (`else`, or `or` another field) may be absent. |
| [`check-upgrade.js`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L61-L62) | A release the updater already installed on a TV would refuse. The updaters of the latest release and the oldest still in use install the change in place, from a local copy, as a TV does when it updates; 0.82.0 and 0.82.1 could not be installed that way (#586). |
| [`Package build`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L65-L77) | The Homebrew Channel `.ipk` still builds, and passes the Homebrew Channel's own compatibility check for webOS 2.2 and later, the oldest confirmed (a 49LF632V). |
| [`Unit tests`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L81-L97) | Each part of the server, and one suite that starts the whole server against a fake TV and MQTT broker, with a TV that answers, one that answers late, wrongly or not at all, MQTT disabled, and a Glasshouse Home file missing, and checking the dashboard keeps answering and telemetry keeps flowing. |

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

`test-installer.js` checks that Glasshouse's own package install holds the
restart and install guards, then releases both before reporting success or failure.

`test-remote-worker.js` runs the remote-button worker's Python tests
(`test/test_remote_buttons.py`) under Python 3: a disconnected device and one at
EOF are dropped rather than read in a busy loop, a device with nothing to read
yet is kept, and a device that comes back is reopened and its buttons arrive.
The worker itself stays Python 2.7 compatible for the TV.

`test-screensaver-dropped.js` covers a refused request's fallback, remote dismissal and restart recovery, failed closes, delayed replies, and playback or source changes that must prevent a launch. `test-remote-buttons.js` checks that Home, coloured buttons and ordinary keys reach the dismissal handler through both parsed events and the worker stream, including split lines.

`test-idlesaver.js` checks that an idle screen saver refused by panel care is asked for again without its hold, and that the hold is put back when it closes or is still refused, but not over an app that has come to the front since. Failed restores are retried, a lost policy reply remains tracked, and a server restart recovers an outstanding lift. Delayed idle callbacks respect later power changes, and a dashboard lift expires if no screen saver starts. Its own request's refusal, playback and a TV without `setEplAppInfo` are left alone. The assertions run on Node 0.10 and 0.12 as well as newer versions.

`test-window-state.js` checks that short gaps in window focus do not publish empty remote attributes, persistent gaps do, standby clears immediately, and reconnects republish the retained state. The server boot test checks that both SurfaceManager subscriptions start only with MQTT enabled.

`test-home.js` checks that switching on has sam read the mounted app before LG's Home is stopped and switching off the reverse, that on webOS 10 sam rereads it on a block and release and has it as the home category's app, that a server finding it mounted with an earlier release's manifest has sam read the new one even after a restart between staging and rereading, that a refused upgrade puts LG's Home back and reports failure, that webOS 10 is offered and webOS 11 only with `allowExperimentalHome`, that LG's files go back where sam does not take the app, the ways back to LG's Home and the return, a switch-off cut short being finished at start, what earlier builds changed being put back once, failed saves, a healthy view whose heartbeats later stop, and a short Home press that brings no heartbeat: WebAppMgr started and the view opened again where it is not running, as for a view that stops beating, LG's Home given its place where it will not start, or where it is running once the longer wait for a page still loading is over, the view kept where it answers within that wait, and nothing done when the view answers. A view opened after a wake or by the boot hook whose page never runs gives LG's Home its place after the short wait, one whose page runs only after the longer wait, and one that answers, or an input chosen meanwhile, keeps Glasshouse Home. It also checks that LG's layout is left alone unless the empty one is chosen, that the choice applies at once while Glasshouse Home has the place, that a TV an earlier build left on the empty layout keeps it, that LG's notifications and search are on the Apps row, marked as opening over Home, that fading and leaving out inputs with nothing plugged in stay off until switched on and outlast a reset, beside inputs hidden one by one, which are kept, and that a row set to Last opened puts what was opened last first, from the view or the remote, with the channel Live TV was on even when the view asks before Live TV has left, records nothing while Glasshouse Home is off, and forgets a row put back in its own order. `test-tvwebctl.js` also checks that a third restart in ten minutes gives LG's Home its place back. `test-remotekeys.js` checks that a mapping which could not be deleted is reported as a failed change, and that the starting notice holds Home for 90 s after the filter loads, and not at all without the compositor's timer. `test-remotekeys-webos11.js` checks webOS 11's path: LG's input switcher offered first as a choice of its own and set like an app, the streaming buttons LG has switched on, Guide, Home Hub and the ? button offered with no filter chain and left out of the JavaScript filter, the ? button refusing Nothing, the AI button switching LG's voice assistant off and back on and answering its log line once, read from a log that is appended to and replaced, and not offered without that service, the Alexa button blocking Amazon's view and releasing it, an already blocked view counting as blocked, toasts switched off for the Alexa press only and back on at the start after a restart, LG's list set again after LG writes it back, after a power change where nothing is announced, and at most twelve times a minute, each change written to LG's own value and only that one, LG's value put back for As LG has it, a key set again after LG sends its list again with LG's newer entry kept to put back, `restore` putting back every key, and nothing written while no key is set. `test-tesseract.js` checks the tesseract screen saver's geometry: 16 corners and 32 edges along one axis each, rotations that keep distances, a six-hour clock that starts again without a jump, and the figure staying on screen through the whole cycle.

`test-i18n-pick.js` checks which language the pages pick: the browser's, except one translated only in part on a page it does not cover in full, and one chosen or asked for in the address on every page.

`test-home-picture.js` reads a G3's receiver files with Glasshouse Home on screen: the signal and HDR of the input behind it, the picture mode asked for with both input and dynamic range, an empty input, and HDR from the receiver's packets (PQ, HLG, none, Dolby Vision). Only the mode for the range coming in is asked for, none without a signal, and a channel's SDR mode. It also checks that tracking runs only while Glasshouse Home, picture details and the TV are all on, that it retains an app's first video before any app plate is read, and that standby or switching either off stops it and leaves the recorded video available.

`test-routes.js` checks that an upload aborted before its file opens leaves no staged file, including a disconnect while disk space is being reserved.

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

For the Home view, arranging checks cover a late catalogue reply, resetting after moving a tile, and an update noticed while arranging. Picture checks cover a layout with picture details left at their default (off), the plate's single mode and OLED light, an input with no signal keeping its line level with the source's first line, a delayed reply after changing source, and a delayed reply after switching picture details off. Its service replies are simulated; the page and its timers run in Chromium.

Scrolling checks, on a row of 30 apps under the pointer, cover hovering a tile leaving its row in place, the pointer resting at the screen's side gliding the row and coming to rest when it moves away, a click held still while the row glides opening the tile under the pointer, the wheel moving the row a tile a notch and a click after it opening the tile now under the pointer, moving down a row leaving the scrolled row where it is, the keys focusing a tile in view, and the rows still gliding after Recent apps closes while its cards glide. Motion checks read the row's place every frame: a flick to the screen's side gathers speed over several frames instead of starting at full speed, the row brakes into its last tile, and moving the pointer away lets it slow to a stop. A guide check moves a channel's programme on through the minute's refresh and finds its tile left in place rather than the rows rebuilt.

Home colour checks cover custom accents matching the stylesheet's original colours, changes and reset arriving through the heartbeat, and malformed colour values being discarded without stopping the server.

Home visibility checks delay the layout reply behind the source reply: last watched stays hidden until its saved switch is known and updates as soon as a changed layout arrives. They also cover app counts, CEC addresses, older layouts with no switches, and the clock keeping its place. `test-home.js` covers saving each switch, switching them back on and ignoring non-boolean updates.

The Home availability check covers a TV with neither Glasshouse Home nor LG's Home's options, which has no Home tab; one with LG's Home's options alone, which shows them, Open Home at power-on usable among them, without Glasshouse Home's switch or options; and Glasshouse Home switched on, which leaves LG's Home's layout and hidden system apps out. `test-home-lg-options.js` checks the server's side: the Home tab offered for hiding system apps on webOS 4.4, and for Open Home at power-on alone, the options only sent when asked for, no tab with none of them, and hiding system apps neither offered nor switched on under Glasshouse Home. `test-tile-hiding-handover.js` checks its handover to Glasshouse Home: the apps it hid hidden there, those in More apps kept, and sam never restarted for it.

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

From the repository root:

```bash
npm ci && npx tsc
node test/run-all.js
for s in check-es5 check-module-calls check-ui-ids check-strings check-screensavers check-drift; do ./scripts/$s.py || break; done
./scripts/check-entities.py --stats test/fixtures/stats-b8-webos4.json
node scripts/check-upgrade.js
```

The dashboard check needs Playwright and its browser:

```bash
npm install --no-save playwright && npx playwright install chromium
node scripts/check-dashboards.js
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

`test-home-wallpaper-upload.js` exercises the real HTTP boundary: rejected and interrupted uploads preserve the previous image, concurrent uploads are refused, the lock is released after an abort, an uploaded JPEG survives reinitialisation and is served with its image type, and one time of day's picture is removed alone, an unknown one refused. The example set, with the download stubbed, fills only the times of day without a picture, and a picture that fails its checksum or download is not kept and releases the lock. The dashboard check chooses Morning and uploads to it, preparing a PNG as JPEG, shows the pending upload in a second tab and the picture once done, drops an image on Evening, removes Morning alone and then all of them.

`test-home-recent-apps.js` exercises the recent-app HTTP routes: refused and
unconfirmed stops retain their cards for retry, unavailable running lists
report failure, Close all stops web and native apps while preserving Home,
unlisted apps and newer cards, and snapshots forbid caching. The browser
check covers held OK acting once on release, close errors above the panel,
and Back or a Home relaunch cancelling a delayed panel reply.

`test-home-date.js` runs Glasshouse Home's date with the browser's default locale at en-US, as on webOS 10: a Russian page gets Russian words with the month as it follows a number (`24 октября`), and the line starts with a capital, an English page is unchanged, and a browser without `formatToParts` still uses the page's language. It is skipped on a node without full ICU.

`test-home-search.js` feeds a G3's real answer for "Dune" to Glasshouse
Home's search: one film on three services is one title, only the TV's apps
are listed, a listed title opens in its app at the id LG's item detail gives,
anything not listed opens nothing, and LG's error is a failure. With a G3's
details for Severance and The Bear, a series opens at Prime Video's first
season and at Disney+'s first episode, and with no detail a title opens at
its item id less LG's service tag. From the G3's answers for promo words,
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

The sideload route check forces an upload to abort before its file opens,
then confirms that the eventual descriptor closes and the staging file is
removed. This catches Node 0.12's destroy-before-open behaviour without
relying on the filesystem finishing within a fixed delay.
