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

* **Keep it short:** State what changed and why. A pull request description is usually a paragraph or two explaining the rationale.
* **No process narration:** Do not narrate the investigative path, false starts, or how verification was performed. Record decisions and their reasons.
* **Third person, always:** Write "the TV", "the panel switch", never "you" or "your TV".
* **No filler structure:** Avoid unnecessary headings or bullet lists for simple changes.

## Code review guidelines (Conventional Comments)

To keep code reviews constructive, clear, and actionable, code review comments should follow the [Conventional Comments](https://conventionalcomments.org/) standard.

Each review comment should start with a label indicating its intent:

| Label | Purpose |
| :--- | :--- |
| `praise:` | Highlight positive aspects, elegant solutions, or great improvements. |
| `nitpick:` | Minor stylistic or preference points that are non-blocking. |
| `suggestion:` | Propose a concrete alternative way to implement something. |
| `issue:` | Highlight a defect, bug, regression, or missing requirement that must be addressed. |
| `question:` | Ask for clarification or context when something is not understood. |
| `thought:` | Share an observation or idea without requiring immediate action. |
| `chore:` | Request minor housekeeping (updating docs, test cases, formatting). |

Optional decorations may clarify the comment's priority:

* `(blocking)`: Must be addressed before the pull request can be merged.
* `(non-blocking)`: Informational or optional feedback that does not prevent merging.
* `(if-minor)`: Apply only if the change is quick and low-effort.

**Example:**
> `suggestion (non-blocking):` Consider caching this Luna response if the property does not change between invocations.

## Environment and compatibility

### Strict ES5 for on-TV code

The server runs on the TV under Node.js 0.12 (on webOS 3.x and 4.x models). All files executing on the TV must remain strict ES5:

* `server/tvweb.js`
* `server/lib/*.js`
* `server/assets/dashboard.html`
* `server/assets/setup.html`
* `server/assets/setup-phone.html`

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
```

All automated checks must pass cleanly.
