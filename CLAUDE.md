# Working conventions

## Never push to main

Branch, push the branch, open a PR. This applies to "commit and push" too.
Push to an existing PR branch rather than opening a second one for the same
line of work. Merging is the maintainer's call.

## Draft until tried on a TV

A PR that has not been tried on a real TV stays a draft, even when feedback on
it is wanted. Mark it ready for review once it has been, with the result in its
Testing section.

## Docs move with the change

A change updates the docs that describe it, in the same PR, before it is
pushed:

- CI, tests or `scripts/`: docs/development/testing.md. Its links into
  `.github/workflows/*.yml` name line ranges, so check them whenever a
  workflow changes.
- Something the dashboards show or do: docs/dashboard/ for that tab, and its
  screenshot once released.
- Anything the server changes on the TV: docs/TV-CHANGES.md.
- What contributors must do differently: docs/CONTRIBUTING.md.
- A finding about how LG's software works: docs/development/TV-RESEARCH.md.

# Code map

The server runs on the TV under node 0.12 (0.10 on webOS 2), so it and the pages the TV's own
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
  subscriptions), `children` (the turn every child process start waits
  for), `notifications`, `privacy` (consent, ad blocking),
  `devtools` (closing the web app debugger to the network),
  `oled` (panel care, service menu), `homescreen` and `homescreen-webos9`
  (LG's Home screen layout and input tiles, one module per home app), `home`
  (Glasshouse Home, a home screen in place of LG's), `lgsettings` (LG's own settings as
  rows), `game`, `apps` (tiles, uninstall, saved pages), `installer` and
  `repo` (installing .ipk packages, the Homebrew Channel catalog),
  `services` (background services), `screensavers`, `idlesaver` (lifting
  panel care's hold on LG's idle screen saver), `updater` and `fetch`
  (self-update over curl or wget), `piccap`, `say` (server-side strings),
  `names` (raw TV values as display strings and Prometheus labels),
  `util` (small shared helpers).
- `server/assets/ui.html` - the web dashboard's markup; its CSS and script
  are in `server/assets/ui/`, one script per tab or concern.
- `server/assets/dashboard.html`, `setup.html`, `setup-phone.html` - the pages
  the TV app shows. `server/assets/dashboard-app/` is the TV app itself.
  `server/assets/home.html` and `server/assets/home-app/` are Glasshouse
  Home's view and its app.
- `server/assets/i18n/` - translations. `server/assets/screensavers/` - the
  screen savers, a folder each with a `saver.json`. `server/screensavers/` is
  installed into the TV's folder for added ones, as an example of one.
- `server/tvwebctl`, `server/50-tvweb.sh` - start, stop and watchdog on the TV,
  and the boot hook. `server/deploy.sh` installs over ssh; its `FILES` list
  must name every file the server needs.
- `hbc/` and `scripts/build-ipk.py` - the Homebrew Channel package.
- `test/` - `node test/run-all.js` runs every `test-*.js`; fixtures are real
  stats from a B8 (webOS 4), a CX (webOS 5), and a G4 and a C4 (webOS 9).

Before pushing, run what CI runs: `scripts/check-all.sh` runs it all side
by side. One at a time: `node test/run-all.js`, `npx tsc`, and
`scripts/check-es5.py`, `check-module-calls.py`, `check-ui-ids.py`,
`check-strings.py`, `check-screensavers.py`, `check-drift.py`,
`check-entity-stability.py` and
`check-entities.py --stats test/fixtures/stats-b8-webos4.json`, and
`node scripts/check-upgrade.js`. A module
handed to another through init() is typed with
`/** @type {typeof import('./x')} */`, so check-module-calls.py follows it.

# Working with a TV

`scripts/tv.sh <address> version|app|luna|log|capture` covers the usual
look at a rooted TV over SSH; run it with no arguments for its usage.

- `luna-send` prints nothing over SSH without a terminal: use `ssh -tt`,
  as tv.sh does, and strip the carriage returns.
- Glasshouse lives in `/var/lib/tvweb`: its log is `tvweb.log` there and its
  settings `config.json`. `server/deploy.sh <address>` installs a branch.
- A TV whose `config.json` sets `host` to `127.0.0.1` answers only on the TV:
  reach its dashboard through `ssh -L 18080:127.0.0.1:8080 root@<address>`.
- The app in front is empty while a Home screen is, and names the input
  (`com.webos.app.hdmi2`) while one is. An HDMI input shows another device's
  screen: capture it only when asked. Protected video captures black.
- Screen capture is `com.webos.service.capture/executeOneShot` on webOS 9
  (a C2) and `com.webos.service.tv.capture` on webOS 4 (a B8); tv.sh tries
  one, then the other.

For background, open the doc for the area rather than README.md:
docs/IMPLEMENTATION.md (platform quirks and how each subsystem works),
docs/HOME-ASSISTANT.md (setup) and docs/HOME-ASSISTANT-ENTITIES.md (entities), docs/TV-CHANGES.md (what the server changes
on the TV), docs/development/tv-specs/index.md (hardware of the tested TVs),
docs/development/TV-RESEARCH.md (how LG's software was found to work, to
read before investigating it again and to add findings to), docs/ACR.md,
docs/SECURITY.md and docs/STRINGS.md.

# Writing conventions

Applies to commit messages, PR descriptions, release notes, README and docs.

## Keep it short

State what changed and why. Stop. A PR description is usually a paragraph or
two, not a report.

Length should track the size of the change, not the effort behind it. A
one-line fix gets one line.

## PR descriptions: summary first

A PR description must be readable at a glance by someone who has not seen
the code. Open with a plain-language summary of what changes for the people
using Glasshouse: short sentences or a few bullets, no file names, function
names or PR numbers. Put the technical detail - the code changes, related PRs,
config keys, what was left out - under a `## Technical details` heading after
it.

A small change can skip the heading: one or two plain sentences are enough.

## Don't narrate the work

No process commentary: what was tried, what was ruled out, what turned out to
be a false alarm. If a check found nothing, that is not a finding worth
writing down.

The exception is a PR's **Testing** section, which docs/CONTRIBUTING.md asks
for: the TV and webOS version the change was tried on, what was done and seen,
and what wasn't tested. State them as facts, briefly, not as a story.

Record decisions and their reasons, not the route taken to reach them.

## Third person in PRs, commits and release notes

PR descriptions, commit messages and release notes are project artefacts, not
messages to a reader. Never "you", "your TV", "as you asked". Write "the TV",
"the panel switch". The README and the docs may address the reader as "you".

## No filler structure

Don't add headings, tables or bullet lists to a short change (the
`## Technical details` split above is for larger PRs). Tables are for
genuine matrices - a compatibility list, a unit reference - not for restating
three sentences.

Don't list things that did not change.

## Comments in code

Explain why, where a reader would otherwise wonder or get it wrong: a platform
quirk, a non-obvious ordering constraint, a value that looks wrong but isn't.
Skip comments that restate the code.

Keep the measured facts that justify a decision (an observed value, a version,
a threshold). Drop the story around them.

## webOS versions

Name a webOS version as the TV reports it (`/etc/issue`, the dashboard): webOS
4.4, webOS 9, webOS 10. LG's year names (webOS 22 to 26) are the reported major
version plus 15; give one only in brackets, as "LG's webOS 25", where an owner
would look for it. A TV's model year is not its webOS: the C2 runs 9.2.
docs/tested-tvs.md#webos-version-numbers has the table.

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
