# Testing and CI

Every pull request is checked on [GitHub Actions](https://github.com/rorygallagher2024/glasshouse/actions) before it is merged. Most of
the checks exist because a mistake of that kind once reached a release, or
could have without anyone noticing: the TV gives little feedback when
something is wrong, and Home Assistant and the TV's own browser fail quietly.

## On every pull request

[`checks.yml`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml) runs these on each pull request and each merge to main.

| Check | What it catches |
| :--- | :--- |
| [`check-es5.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L23-L24) | Newer JavaScript in the on-TV server or the TV app. webOS 2 runs node 0.10 and webOS 4 (the B8) 0.12, where it is a parse error and the server never starts. |
| [`Modules parse`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L26-L27) | A syntax error in `tvweb.js` or a server module. |
| [`check-ui-ids.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L29-L30) | An element the dashboard's script reaches for that the page no longer has. |
| [`check-module-calls.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L34-L35) | A call to something a server module no longer exports, such as a caller left behind by a rename. TypeScript reads it as `any` in JavaScript, so only this finds it. |
| [`check-strings.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L37-L38) | Dashboard text without a translation key, and translations made from English that has since changed. [Translating the dashboards](../STRINGS.md) has the rules. |
| [`check-screensavers.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L40-L41) | Screen saver QML that the TV's QtQuick version cannot load. |
| [`check-drift.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L43-L44) | The [entity reference](../HOME-ASSISTANT-ENTITIES.md) out of step with the entities the server publishes, and a dashboard file missing from `deploy.sh`'s list, which would never be installed. |
| [`check-entity-stability.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L47-L48) | A Home Assistant entity from the last release that has gone, been renamed or changed domain, which leaves it unavailable and stops every automation that used it. A deliberate removal is listed in [`scripts/retired-entities.txt`](https://github.com/rorygallagher2024/glasshouse/blob/main/scripts/retired-entities.txt) with the reason. |
| [`shellcheck`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L51-L52) | Mistakes in `deploy.sh`, `tvwebctl` and the boot script. |
| [`TypeScript`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L54-L55) | Type errors, from the JSDoc types in the server's JavaScript. |
| [`check-entities.py`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L57-L58) | A Home Assistant entity reading a field the TV's telemetry does not have, checked against a B8's real telemetry. |
| [`check-upgrade.js`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L61-L62) | A release the updater already installed on a TV would refuse. The updaters of the latest release and the oldest still in use install the change in place, from a local copy, as a TV does when it updates; 0.82.0 and 0.82.1 could not be installed that way (#586). |
| [`Package build`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L65-L77) | The Homebrew Channel `.ipk` still builds, and passes the Homebrew Channel's own compatibility check for webOS 2.2 and later, the oldest confirmed (a 49LF632V). |
| [`Unit tests`](https://github.com/rorygallagher2024/glasshouse/blob/main/.github/workflows/checks.yml#L81-L97) | Each part of the server, and one suite that starts the whole server against a fake TV and MQTT broker, with a TV that answers, one that answers late, wrongly or not at all, and MQTT disabled, and checking the dashboard keeps answering and telemetry keeps flowing. |

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

`test-remote-worker.js` runs the remote-button worker's Python tests
(`test/test_remote_buttons.py`) under Python 3: a disconnected device and one at
EOF are dropped rather than read in a busy loop, a device with nothing to read
yet is kept, and a device that comes back is reopened and its buttons arrive.
The worker itself stays Python 2.7 compatible for the TV.

`test-window-state.js` checks that short gaps in window focus do not publish empty remote attributes, persistent gaps do, standby clears immediately, and reconnects republish the retained state. The server boot test checks that both SurfaceManager subscriptions start only with MQTT enabled.

`test-home.js` checks restoration with delayed screen-saver reads and writes, overlapping switch and layout requests, failed state saves, failed key or settings restoration blocking removal, an externally removed Home app, and a healthy view whose heartbeats later stop. `test-remotekeys.js` checks that a mapping which could not be deleted is reported as a failed change.

`test-routes.js` checks that an upload aborted before its file opens leaves no staged file, including a disconnect while disk space is being reserved.

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
script error, naming the tab. A function a page calls that has gone, or an
element it reaches for that has moved, breaks only when that tab opens, which
no unit test does. It runs when the server, the pages or the fake TV change.

The Home view also runs through fifteen idle minutes with catalogue refreshes, then wakes by remote key. Arranging checks cover a late catalogue reply, resetting after moving a tile, and an update noticed while arranging. Its service replies are simulated; the page and its timers run in Chromium.

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

Home recovery checks cover failed restoration with a durable retry state, definite absent-app replies, HBC cleanup on a TV that never used Home, and backup partial failures. Browser checks cover pending/failed layout edits, first-catalogue failure, and delayed readiness. Wallpaper validation covers corrupt downloads and staging cleanup; a real pinned download and Office G3 deployment are recorded in the PR testing evidence.
