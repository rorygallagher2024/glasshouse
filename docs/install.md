# Installing

## Quick start

1. Root the TV and install the [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).
2. Clone this repository on a computer on the same network as the TV.
3. Run `./deploy.sh <tv-ip>` from the `server/` directory.
4. Open `http://<tv-ip>:8080/` in a browser.

That's it. The dashboard is ready to use.

## Requirements

* A rooted LG webOS TV ([Root tool here](https://github.com/throwaway96/dejavuln-autoroot/)) with the [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).
* A computer on the same network to install from: a Mac, a Linux machine, or a Windows PC. The installation uses Git and requires no other software on the computer. The TV does not need internet access.

The MQTT bridge also needs an MQTT broker on the network. Home Assistant's Mosquitto add-on is one option, but any compatible MQTT broker works.

The models confirmed so far are listed under [Tested TVs](tested-tvs.md).

## Install steps

### 1. Get the files

> [!TIP]
> **Git is required.** On Windows, install [Git for Windows](https://git-scm.com/download/win), which also provides the Git Bash window used by the commands below. macOS and most Linux distributions already include Git or make it available through their standard package manager.

Download the project onto a computer on the same network as the TV.

```bash
git clone https://github.com/rorygallagher2024/lg-webos-dashboard.git
cd lg-webos-dashboard/server
```

### 2. Install the dashboard

Find the TV's address under Settings → Network on the TV, or in the router's list of devices. The installer automatically uses SSH if the TV has it, and falls back to the Homebrew Channel's telnet if not.

> [!CAUTION]
> Telnet leaves an unauthenticated root shell open on the local network.
> [Moving from telnet to SSH](SECURITY.md#moving-from-telnet-to-ssh)
> takes about five minutes and is strongly recommended.

Then, from the `server/` directory in a terminal:

```bash
./deploy.sh <tv-ip>
```

For example, `./deploy.sh 192.168.1.50`. It takes about ten seconds and finishes by checking that the dashboard answers. When it says `done`, open **`http://<tv-ip>:8080/`** in a browser. If anything goes wrong, it stops and says why.

A first install also adds the dashboard to the TV's home screen as an app, so it can be opened on the TV itself with the remote — see [The dashboard on the TV](dashboard/tv-app.md).

It can be removed again from the dashboard at any time. Updating an existing install leaves the home screen exactly as it is, so a removed app never comes back on its own.

`--no-app` skips it on a first install, and `--app` adds it to an existing one.

The server starts again by itself whenever the TV restarts. To try it without that, add `--no-persist`, and it runs only until the TV next restarts. Setting the router to always give the TV the same address saves looking it up again.

No configuration is needed for this part. Without a config file the dashboard runs on port 8080, the controls are live, including power off and reboot, and MQTT is off.

Nothing is sent anywhere: the server talks to the TV and to whoever opens the page, and reaches the internet only to look for a new release — when the dashboard's Server tab is opened, or daily if [checking automatically](managing.md#checking-automatically) is switched on.

## Troubleshooting

* **Connection refused or password prompt during install.** The installer tries passwordless SSH first, then telnet. If SSH prompts for a password, make sure telnet is toggled **ON** in the TV's Homebrew Channel app settings, or run `./deploy.sh <tv-ip> --telnet` to connect directly over telnet.
* **Nothing on port 8080.** On the TV, `/var/lib/tvweb/tvwebctl status` says whether the server is running and `/var/lib/tvweb/tvweb.log` says why it is not.
* **Panel hours and OLED Care missing on an OLED TV**, or showing on an LCD one. Panel detection went the wrong way: set `"panel": "oled"` or `"panel": "lcd"` in `server/config.json` before a first deploy, or in `/var/lib/tvweb/config.json` on a TV that already has one.
