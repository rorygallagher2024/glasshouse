# System tools & logs

The **Tools** tab, `/?tab=tools`, manages screenshots and provides live system logs for system activity, service telemetry and hardware diagnostics.

## Screenshots

Open **Screenshots** to view captures from an assigned physical remote key, newest first. Choose the capture mode and resolution in [Remote keys](remote.md#remote-keys). Captures show a saved-path or error notice on the TV.

Each card shows the capture time and resolution; hover over the image for its filename. Select a loaded preview to enlarge it. Close with **×**, outside the image or Escape; keyboard focus returns to the preview. **Download** shows the file size and saves the original PNG and filename.

While the server runs, old captures are removed oldest first to target 32 MiB of saved images. The total size and target appear beside **Clear all**. The newest capture and recently modified files are kept. Images also disappear when the TV restarts.

The gallery refreshes every three seconds while open and visible, pausing during deletion and viewing. **Refresh** clears the previous result, reloads the list and retries failed previews. Already loaded images are reused when refreshing or returning to the gallery. Deleting an image keeps the remaining previews in place. Viewing, downloading and refreshing work with controls disabled.

**Delete** asks for a second press on the same image within five seconds. **Clear all** uses the same confirmation to delete every saved screenshot. Choosing another deletion, closing Screenshots, leaving Tools or hiding the browser cancels the confirmation. Manual deletion requires controls enabled. A failed deletion shows the error and refreshes the remaining images.

## System logs

Under its title, the tab says whether these logs are also sent to a log server on the network; [Log forwarding](../syslog.md) explains how to set that up.

### Log sources

* **System (`/var/log/messages`)**: webOS system daemon logs written by PmLogDaemon, tracking system services (e.g. `sam`, `audiooutputd`, `pqcontroller`, `fancontroller`).
* **Glasshouse (`/var/lib/tvweb/tvweb.log`)**: Output from the Glasshouse server, stamped with the TV's uptime so it interleaves with the other sources, and tagged `[INFO]`, `[WARN]`, `[ERR]` or `[DBG]`. When the file has just been trimmed, the lines kept from before are shown with it. The file outlives a restart of the TV, and lines from an earlier boot come before this boot's. A crash is written as `fatal:` lines with the error, its stack and the memory in use.
* **Kernel (`dmesg`)**: Linux kernel ring buffer, covering device drivers, thermal alerts, USB events, and network interfaces.

### Inspection features

* **Multi-source interleaving**: Merges lines from selected sources into a single unified timeline based on monotonic seconds since boot.
* **Filtering & search**: Instant search with match highlighting, plus level filters (All, Errors, Warnings, Info), with the number of errors and warnings shown on their filters.
* **Live view & pause**: The view follows new lines as they are written, fetching only what is new, and stops while the browser tab is hidden. It opens at the newest line; scrolling up holds it in place, and **Jump to latest** follows again.
* **Inspector drawer**: Clicking any log line expands detailed metadata and renders pretty-printed, syntax-highlighted JSON for structured webOS event payloads.
* **Export & copy**: The lines shown, after any filter, copied to the clipboard or saved as a timestamped `.txt` file for a bug report.
* **Hide private details**: On by default, it takes passwords, tokens, serial numbers, postcodes and locations, Wi-Fi network names, and MAC and IP addresses out of what is copied or exported. The view itself always shows the full log. The logs can still name the apps in use, so it is worth reading them before posting.

### Log levels

How much the Glasshouse server writes is set in `/var/lib/tvweb/config.json`:

```json
"logging": { "level": "info" }
```

`info`, the default, writes the server's normal activity. `quiet` leaves that out and writes only warnings and errors. `debug` adds extra detail for troubleshooting: each call to the TV's services as it starts and ends, flushed to disk at once so the last lines survive a TV that restarts itself, and the timing of each remote key. The level is read when the server starts, so a change takes effect after `/var/lib/tvweb/tvwebctl restart` or a reboot of the TV.

![Tools tab: source, level and line filters, search, Live switch, and the log](../screenshots/tools.png)

*Live webOS system logs, Glasshouse daemon events, and kernel ring buffer diagnostics.*
