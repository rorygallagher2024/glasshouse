# Testing and CI

Every pull request is checked on GitHub Actions before it is merged. Most of
the checks exist because a mistake of that kind once reached a release, or
could have without anyone noticing: the TV gives little feedback when
something is wrong, and Home Assistant and the TV's own browser fail quietly.

## On every pull request

`checks.yml` runs these on each pull request and each merge to main.

| Check | What it catches |
| :--- | :--- |
| `check-es5.py` | Newer JavaScript in the on-TV server or the TV app. The B8 runs node 0.12 (webOS 4), where it is a parse error and the server never starts. |
| Modules parse | A syntax error in `tvweb.js` or a server module. |
| `check-ui-ids.py` | An element the dashboard's script reaches for that the page no longer has. |
| `check-module-calls.py` | A call to something a server module no longer exports, such as a caller left behind by a rename. TypeScript reads it as `any` in JavaScript, so only this finds it. |
| `check-strings.py` | Dashboard text without a translation key, and translations made from English that has since changed. [Translating the dashboards](../STRINGS.md) has the rules. |
| `check-screensavers.py` | Screen saver QML that the TV's QtQuick version cannot load. |
| `check-drift.py` | The [entity reference](../HOME-ASSISTANT-ENTITIES.md) out of step with the entities the server publishes, and a dashboard file missing from `deploy.sh`'s list, which would never be installed. |
| `check-entity-stability.py` | A Home Assistant entity from the last release that has gone, been renamed or changed domain, which leaves it unavailable and stops every automation that used it. A deliberate removal is listed in `scripts/retired-entities.txt` with the reason. |
| shellcheck | Mistakes in `deploy.sh`, `tvwebctl` and the boot script. |
| TypeScript | Type errors, from the JSDoc types in the server's JavaScript. |
| Unit tests | Each part of the server, and one suite that starts the whole server against a fake TV and MQTT broker, once with a TV that answers and once with one that answers late, wrongly or not at all, and checking the dashboard keeps answering and telemetry keeps flowing. |
| Package build | The Homebrew Channel `.ipk` still builds. |
| `check-entities.py` | A Home Assistant entity reading a field the TV's telemetry does not have, checked against a B8's real telemetry. |

## On each supported TV's node

The unit tests run on node 0.12 (webOS 4, the B8), 8.12 (webOS 6), 16
(webOS 9, the C2) and the current LTS, each in parallel. A computer's node
accepts calls an older one lacks.

## Home Assistant

`home-assistant.yml` builds every discovery config the server can publish and
runs each through Home Assistant's own validation, then checks that the volume
entities are available exactly when the TV lets their volume be changed. Home
Assistant creates no entity for a config it rejects, and says so only in its
own log, which is how Volume and Mute went missing in 0.78.0.

It runs when the server or the check changes, not for documentation, and
weekly, since Home Assistant is not pinned: a release that starts rejecting a
config shows there first.

## The dashboards in a browser

`dashboards.yml` starts the real server against a fake TV, opens every tab of
the web dashboard and the TV app in a headless browser, and fails on any
script error, naming the tab. A function a page calls that has gone, or an
element it reaches for that has moved, breaks only when that tab opens, which
no unit test does. It runs when the server, the pages or the fake TV change.

## Documentation

`docs.yml` builds this site on each pull request that changes it, with every
link and section link checked, and publishes it when the change is merged.

## Releases

Publishing a release runs `homebrew-channel.yml`, which builds the `.ipk`,
attaches it and the Homebrew Channel manifest to the release, and records the
package's sha256 in the manifest.

## Running them locally

From the repository root:

```bash
npm ci && npx tsc
node test/run-all.js
for s in check-es5 check-module-calls check-ui-ids check-strings check-screensavers check-drift; do ./scripts/$s.py || break; done
./scripts/check-entities.py --stats test/fixtures/stats-b8-webos4.json
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
