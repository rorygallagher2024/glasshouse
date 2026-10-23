# Server

The **Server** tab, `/?tab=server`, holds Glasshouse's own settings: Glasshouse itself and an Advanced section for developers and home-lab setups. Preferences for this browser (theme, sidebar, and language) are located in the sidebar navigation area.

![Server tab: Glasshouse's version and updates, server health, the daily update check, watch time, the settings backup and daily backup, the app on the TV's home screen, and the Advanced section](../screenshots/server.png)

*Glasshouse's updates, watch time, settings backups and the Advanced section.*

## Glasshouse

![Glasshouse: the version and Check now, server health, daily update check, watch time, settings backup, daily backup and the app on the home screen](../screenshots/server-glasshouse.png)

Shows the installed version and whether a newer release is out. **Check now** looks straight away, and **Install** appears when there is something to install, with **What's new**: a short summary of what each release since the installed one brings, newest first, and a link to its full notes. **Roll back**, under the version, puts back the version installed before, after asking first. [Updating](../managing.md#updating) covers installs from before the tab existed.

**Check for updates daily** looks once a day on its own, and lets Home Assistant offer the update.

**Update pop-up** shows a pop-up in the browser it is switched on in when a newer release is out, over whichever tab is open, with the release's one-line summary. **Update** installs it the way **Install** does, with its progress in the pop-up, and **Dismiss** leaves it until the next release. It is off by default and kept per browser. Where the update cannot be installed from the dashboard, because controls are off or the Homebrew Channel owns the install, the pop-up only says it is out.

**Server health** shows the background process uptime and memory footprint on the TV.

**Watch time** counts how long the screen is on, per app and input, for [the Metrics tab](metrics.md#watch-time) and Home Assistant. It is off by default, as it records what the household watches. **Clear history** deletes what has been kept, whether counting is on or off.

**Settings backup** saves LG's sound, device, HDMI and ad settings, and Glasshouse's own, to a file, and restores one, on the same TV or another. A restore sets only the settings the TV has and offers, skips those LG greys out at the moment, such as an HDMI input's settings while another input is on screen, and says how many it changed and skipped. Glasshouse restarts if its own settings changed. A backup also lists the apps installed from the Homebrew Channel or by hand. A restore installs none of them itself: those the TV lacks and the Homebrew Channel catalog has are offered on the [Apps tab](apps.md) with **Install all**, each through its usual preview, which stops for a choice such as root, and those not in the catalog are named to install by hand. A backup leaves out what decides who can reach the dashboard (port, host, token, controls), MQTT, whose topic prefix and device id must differ between TVs, the experimental switches, and LG's game settings, which LG keeps per input and genre.

**Daily backup** saves the same backup on the TV once a day, in `/var/lib/tvweb/backups`, and keeps the last 7. It is off by default. Switched on, it saves that day's at once, then one each day the TV is on, as the server checks hourly. Each one kept is listed by its date with **Download** and **Restore**. Switching it off keeps those saved.

**App on the TV's home screen** adds or removes [the dashboard's own app](../apps/tv-app.md), which opens it on the TV and is driven by the remote.

## Advanced

![Advanced opened: time server, Prometheus metrics, the web app debugger, SSH keys and experimental features](../screenshots/server-advanced.png)

Folded away, since nothing in it needs changing for everyday use. Once opened, it stays open in that browser.

* **Dashboard port** is the port the dashboard answers on, 8080 unless changed. Change it when another app on the TV needs 8080 (Stremio's background service binds it, and fails to start while the dashboard holds it). Saving checks the port is free, writes `port` to `config.json` and restarts the server; the page then opens on the new address. The TV apps that open the dashboard follow the new port at the server's next start.
* **Set the clock from a time server** switches the TV over to [a time server on the local network](../ntp.md), for networks that run one. Switched on, it asks for the server's address. Switched off, the address is kept for next time.
* **Prometheus metrics** turns on the [Prometheus endpoint](../PROMETHEUS.md).
* **Web app debugger** opens or closes Developer Mode's debugger to the network. It is closed unless it is needed, since webOS leaves it open with no password. On a TV whose kernel has no firewall there is no switch, since the port cannot be closed, and the row says the debugger stays open to the network.
* **SSH keys** lists the public keys that can log in as root over SSH, in `/home/root/.ssh/authorized_keys`, by comment, type and SHA256 fingerprint, as `ssh-keygen -l` prints it. A public key pasted in is added, and **Remove** takes one out. While the file is there, the Homebrew Channel leaves root without a password, so only those keys get in. **Delete the key file** stops every key at once, and from the next reboot the Homebrew Channel gives root the password `alpine`, which everyone knows; until that reboot nothing can log in over SSH. The row says which applies now and after the next reboot, and offers **Reboot now** when they differ. None of it applies while SSH is off in the Homebrew Channel. Changing the keys needs a [token](../SECURITY.md); without one the row only lists them, by type and fingerprint.
* **Experimental features**: hiding built-in apps from the Home screen, custom screen savers on webOS 11 and later, and the Home screen layout on webOS 10. See [Experimental features](../experimental.md) for why they are experimental.
