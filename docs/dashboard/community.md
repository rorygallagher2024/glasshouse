# Community add-ons

People write screen savers, home screens and No Signal screens for Glasshouse and share them through its community catalog, [glasshouse-catalog](https://github.com/rorygallagher2024/glasshouse-catalog). Each is installed with one click from the tab it belongs to, and removed the same way.

| Kind | Where to find them | In the catalog now |
| :--- | :--- | :--- |
| **Screen savers** | [Screensaver](screen-savers.md#community-screen-savers) tab, under **Community screen savers** | Pigs - Three Different Ones, Music highway |
| **Launchers** (home screens) | [Home](launchers.md#custom-launcher) tab, under **Custom → Community launchers** | Example launcher, Glasshouse's own starting point |
| **No Signal screens** | [Inputs](inputs.md) tab, under **No Signal screen → Community No Signal screens** | DVD style |

Each listing shows what it looks like, who made it, its licence and version, and a link to its source. Each list's summary says how many installed add-ons have an update, and an **Update to** button on the add-on installs it.

## How safe they are

Add-ons are written and maintained by their authors, not by Glasshouse, so the catalog is built to limit what one can do:

* **Checked downloads:** each package is downloaded over HTTPS and checked against the checksum recorded in the catalog before it is unpacked. One that does not match is refused.
* **Limited access:** a community screen saver cannot read the values that would give it the dashboard's token, a No Signal screen runs inside the TV's input app with only its own files, and a launcher has the same access as one you upload yourself.
* **Withdrawn add-ons:** the catalog can withdraw an add-on found to be unsafe. It can no longer be installed, and where one is installed already, its listing says so, with the reason, so it can be removed.
* **Reviewed submissions:** every submission to the catalog is a pull request: its package is checked automatically, including what it asks to use, and reviewed before it is listed.

[Security](../SECURITY.md) has the details.

## Trying one that is not listed

An add-on can also be installed from an `https://` GitHub repository or a `.zip` link, to try one before it is in the catalog. This is offered only where installing from a link is allowed: with **Install app from a URL or file** on the [Apps](apps.md#install-app-from-a-url-or-file) tab, a dashboard token, or from the TV itself.

## Making your own

Each kind has a guide, and the [catalog's README](https://github.com/rorygallagher2024/glasshouse-catalog#readme) explains how to submit one:

* [Writing a screen saver](../development/WRITING-SCREENSAVERS.md) and [Screen saver design principles](../development/SCREENSAVER-DESIGN.md)
* [Writing a launcher](../development/WRITING-LAUNCHERS.md)
* [Writing a No Signal screen](../development/WRITING-NOSIGNAL.md)

The Example launcher is a good place to start a launcher from: it is one short HTML file, [in the catalog](https://github.com/rorygallagher2024/glasshouse-catalog/tree/main/packages/launchers/example).
