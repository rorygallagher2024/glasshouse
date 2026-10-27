# Contributing to Glasshouse

Contributions are welcome. This guide outlines how to propose changes, write compatible code, and review pull requests.

## Core principles

* **You own the glass:** The project exists to give owners direct control over their TV without vendor lock-in, cloud dependencies, or tracking. No telemetry or analytics are collected.
* **Keep the TV lightweight:** The TV's onboard CPU and RAM are shared with video decoding and system processes. Code running on the TV must remain fast, lean, and free of unnecessary background work.
* **Zero runtime dependencies:** The on-TV server runs with no npm packages installed on the device.

## Working conventions

### Never push to main

Always work on a branch and submit a pull request:

1. Create a branch from `main`.
2. Make changes, keeping commits focused and logically distinct.
3. Push the branch to your fork or the repository.
4. Open a pull request against `main`.

If a pull request needs follow-up adjustments, push additional commits to the existing branch rather than opening a new pull request for the same work.

### Commit messages and PR descriptions

Focus on clarity and readability. Clearly state what changed and why, keeping pull request descriptions concise and focused on the context reviewers need.

If you are using AI coding assistants or automated agents, ensure they adhere to the repository conventions in `CLAUDE.md` (symlinked as `AGENTS.md`).

## Code reviews

We prefer code review comments to follow the [Conventional Comments](https://conventionalcomments.org/) standard (e.g. `praise:`, `suggestion:`, `issue:`, `nitpick:`, `question:`). This keeps feedback constructive, actionable, and makes it clear whether a comment is blocking or an optional suggestion. Refer to [conventionalcomments.org](https://conventionalcomments.org/) for the complete specification and examples.

## Environment and compatibility

### Strict ES5 for on-TV code

The server runs on the TV under Node.js 0.12 on webOS 3 and 4, and 0.10 on webOS 2. All files executing on the TV must remain strict ES5:

* `server/tvweb.js`
* `server/lib/*.js`
* `server/assets/dashboard.html`
* `server/assets/setup.html`
* `server/assets/setup-phone.html`
* `server/assets/home.html`
* `server/assets/home-app/index.html`

Avoid all ES6+ constructs in these files: no `const` or `let`, arrow functions, template literals, classes, default parameters, destructuring, promises, `async`/`await`, `for...of`, or ES6 built-in methods (`Object.assign`, `Array.prototype.find`, etc.).

Run `python3 scripts/check-es5.py` to verify compliance.

### Modern JavaScript in browser dashboards

Modern JavaScript (ES6+) is permitted exclusively in client-side code running in modern desktop/mobile browsers:

* `server/assets/ui.html`
* `server/assets/ui/*.js`

### Adding new server assets

The deploy script (`server/deploy.sh`) maintains an explicit list of files copied to the TV via SSH (`FILES`). Any new module or asset in `server/` required by the TV must be added to this list. `scripts/check-drift.py` verifies that all files on disk match the deploy manifest.

### Localized strings

All user-visible text on the dashboards is keyed for localization:

* In HTML: `data-t="section.key"`
* In JavaScript: `t('section.key', 'Default English string', { vars })`

Strings are cataloged in `server/assets/i18n/`. Refer to [Translating the dashboards](STRINGS.md) for full formatting rules. Run `python3 scripts/check-strings.py` to ensure all strings are keyed and translated without drift.

## Running tests and verification

Before opening a pull request, run the test suite and validation scripts locally:

```bash
# Run all unit and integration tests
node test/run-all.js

# Type checking
npx tsc

# Syntax and architecture checks
python3 scripts/check-es5.py
python3 scripts/check-drift.py
python3 scripts/check-strings.py
python3 scripts/check-ui-ids.py
python3 scripts/check-screensavers.py
python3 scripts/check-module-calls.py
python3 scripts/check-entity-stability.py
python3 scripts/check-entities.py --stats test/fixtures/stats-b8-webos4.json

# The release's updater can still install the change on TVs already out there
node scripts/check-upgrade.js
```

All automated checks must pass cleanly.

### Previewing UI changes locally

To visually preview and interact with the web dashboard, TV app, or Glasshouse Home on your computer without a physical TV:

```bash
npm run emulate
```

This starts the server against a virtual webOS environment with procfs, sysfs, Luna bus calls, apps, remote keys, and recent apps mocked. You can also specify a model or port:

```bash
node scripts/emulate-tv.js [--model c2|b8|c3|cx|c1] [--webos 6.5.3] [--home on|off] [--port 8080] [--open]
```

Direct URLs:
* Web Dashboard: `http://localhost:8080/`
* TV App Dashboard: `http://localhost:8080/assets/dashboard.html`
* Glasshouse Home: `http://localhost:8080/assets/home.html`

### Previewing documentation locally

The documentation site is built with [MkDocs](https://www.mkdocs.org/) and the [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) theme. To preview documentation changes locally with live reloading:

```bash
python3 -m venv .venv
.venv/bin/pip install 'mkdocs>=1.6,<2' 'mkdocs-material>=9.7,<10' 'markdown-callouts>=0.4,<0.5'
NO_MKDOCS_2_WARNING=1 .venv/bin/mkdocs serve
```

Then open `http://127.0.0.1:8000/glasshouse/` in a browser. The page reloads automatically whenever a file under `docs/` or `mkdocs.yml` is saved. (With Nix, `nix develop` provides these packages directly so `mkdocs serve` works without a virtual environment.)

To run the same strict build and link check that CI runs on pull requests:

```bash
NO_MKDOCS_2_WARNING=1 .venv/bin/mkdocs build
```

## Testing on a real TV

The automated checks run the server's code, not the TV. LG's services, the picture and sound pipeline and the start-up sequence behave differently between models and webOS versions, and only a real TV shows how a change behaves there. Before asking for a review:

* **Deploy the change to a rooted TV** with `server/deploy.sh <tv-ip>`, and use what it changes the way someone would: on the web dashboard, in the TV app, or from Home Assistant.
* **Check that what's around it still works.** The TV still shows its inputs, sound still plays, and the dashboard keeps updating.
* **Restart the server or the TV** if the change affects start-up, the boot hook (`server/50-tvweb.sh`), or anything that runs only once.
* **Mind older TVs.** On webOS 2 to 4 the server runs on Node 0.10 or 0.12, and a call newer firmware accepts may not exist there. If you can only test on one generation, say which.
* **Older TVs get fewer features, not a lower ceiling.** webOS 2 and 3 lack many of LG's services, so features that need them are left out there rather than held back everywhere: gate a feature on the TV's version or on the service answering. The oldest TVs set only one limit, that the server and the TV app stay ES5 for Node 0.10 and 0.12. Support for both goes together, once keeping it costs real development, such as wanting ES6 in the server.

### Testing details in the pull request

Add a short **Testing** section to the pull request description:

* the TV's model and webOS version, for example "OLED42C24LA, webOS 9.2";
* what you did and what you saw;
* what you didn't test, such as other webOS versions or something that needs hardware you don't have.

For example:

```
## Testing

- OLED42C24LA, webOS 9.2: hid and unhid three tiles from the Apps tab. Each took
  about 4 seconds, and HDMI 2 kept its picture and sound throughout.
- Not tested on webOS 4 or on webOS 10 and later.
```

### If you can't test on the right TV

If you don't have a TV to test on, or the change affects TVs you don't have, say so in the pull request and ask for testers. A maintainer will label it [testers wanted](https://github.com/rorygallagher2024/glasshouse/labels/testers%20wanted), where people with other TVs look for things to try.

### Help by testing on your TV

Some changes can only be checked on TVs the maintainers don't have, such as newer or less common models. If you have a rooted LG TV, you can help without writing any code: pull requests and issues labelled [testers wanted](https://github.com/rorygallagher2024/glasshouse/labels/testers%20wanted) say what to run and what to send back.
