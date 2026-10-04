# Working conventions

## Never push to main

Branch, push the branch, open a PR. This applies to "commit and push" too.
Push to an existing PR branch rather than opening a second one for the same
line of work. Merging is the maintainer's call.

# Code map

The server runs on the TV under node 0.12, so it and the pages the TV's own
browser shows are strict ES5: `scripts/check-es5.py` lists what it rejects.
Only `ui.html` and `assets/ui/` run in a phone or computer's browser and may
use modern JavaScript.

- `server/tvweb.js` - entry point: config, wiring the lib modules together,
  the MQTT bridge (`setupHomeAssistant`) and the heartbeat.
- `server/lib/routes.js` - every HTTP route, auth, first-run setup, and
  serving the dashboard (`loadUI` puts `assets/ui/` back inline).
- `server/lib/` otherwise, one concern each: `telemetry` (stats and hardware
  detection), `controls` (power, volume, input and other commands), `ha`
  (Home Assistant entities), `topics` (MQTT topic names), `mqtt` (the client),
  `mqtt-state` and `state` (live state), `luna` (luna-send calls and
  subscriptions), `notifications`, `privacy` (consent, ad blocking),
  `oled` (panel care, service menu), `lgsettings` (LG's own settings as
  rows), `game`, `apps` (tiles, uninstall, saved pages), `installer` and
  `repo` (installing .ipk packages, the Homebrew Channel catalog),
  `services` (background services), `screensavers`, `updater` and `fetch`
  (self-update over curl or wget), `piccap`, `say` (server-side strings),
  `util` (small shared helpers).
- `server/assets/ui.html` - the web dashboard's markup; its CSS and script
  are in `server/assets/ui/`, one script per tab or concern.
- `server/assets/dashboard.html`, `setup.html`, `setup-phone.html` - the pages
  the TV app shows. `server/assets/dashboard-app/` is the TV app itself.
- `server/assets/i18n/` - translations. `server/assets/screensavers/` - QML.
- `server/tvwebctl`, `server/50-tvweb.sh` - start, stop and watchdog on the TV,
  and the boot hook. `server/deploy.sh` installs over ssh; its `FILES` list
  must name every file the server needs.
- `hbc/` and `scripts/build-ipk.py` - the Homebrew Channel package.
- `test/` - `node test/run-all.js` runs every `test-*.js`; fixtures are real
  stats from a B8 (webOS 4) and a G4 (webOS 9).

Before pushing, run what CI runs: `node test/run-all.js`, `npx tsc`, and
`scripts/check-es5.py`, `check-module-calls.py`, `check-ui-ids.py`,
`check-strings.py`, `check-screensavers.py` and `check-drift.py`. A module
handed to another through init() is typed with
`/** @type {typeof import('./x')} */`, so check-module-calls.py follows it.

For background, open the doc for the area rather than README.md:
docs/IMPLEMENTATION.md (platform quirks and how each subsystem works),
docs/HOME-ASSISTANT.md (setup) and docs/HOME-ASSISTANT-ENTITIES.md (entities), docs/TV-CHANGES.md (what the server changes
on the TV), docs/TV-SPECS.md (hardware of the tested TVs), docs/ACR.md,
docs/SECURITY.md and docs/STRINGS.md.

# Writing conventions

Applies to commit messages, PR descriptions, release notes, README and docs.

## Keep it short

State what changed and why. Stop. A PR description is usually a paragraph or
two, not a report.

Length should track the size of the change, not the effort behind it. A
one-line fix gets one line.

## Don't narrate the work

No process commentary: what was tried, what was ruled out, what turned out to
be a false alarm, how something was verified. If a check found nothing, that
is not a finding worth writing down.

Record decisions and their reasons, not the route taken to reach them.

## Third person, always

These are project artefacts, not messages to a reader. Never "you", "your TV",
"as you asked". Write "the TV", "the panel switch".

## No filler structure

Don't add headings, tables or bullet lists to a short change. Tables are for
genuine matrices - a compatibility list, a unit reference - not for restating
three sentences.

Don't list things that did not change.

## Comments in code

Explain why, where a reader would otherwise wonder or get it wrong: a platform
quirk, a non-obvious ordering constraint, a value that looks wrong but isn't.
Skip comments that restate the code.

Keep the measured facts that justify a decision (an observed value, a version,
a threshold). Drop the story around them.

## Names in code

Name a function, or anything used beyond a few lines, for what it does:
`readTrimmed`, `sendCommand`, not `rd` or `c`. A name read away from its
definition has to carry the meaning, and an abbreviation is hard to search
for. Short names are fine for locals used within a few lines, and for the
dashboards' `q()` and `t()`, which every script uses.

# Strings on the dashboards

Text shown on the dashboards is keyed for translation: `data-t` in markup,
`t('key', 'English', {vars})` in script. docs/STRINGS.md has the rules, and
`scripts/check-strings.py` checks them. The parts already converted are listed
in `CONVERTED` in that script, and new text in one of them needs a key.
