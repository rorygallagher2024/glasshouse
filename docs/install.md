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

The models confirmed so far are listed under [Tested TVs](tested-tvs.md). LG names its webOS versions two ways; [webOS version numbers](tested-tvs.md#webos-version-numbers) gives both.

## Install steps

### 1. Get the files

> [!TIP]
> **Git is required.** On Windows, install [Git for Windows](https://git-scm.com/download/win), which also provides the Git Bash window used by the commands below. macOS and most Linux distributions already include Git or make it available through their standard package manager.

Download the project onto a computer on the same network as the TV.

```bash
git clone https://github.com/rorygallagher2024/glasshouse.git
cd glasshouse/server
```

### 2. Install the dashboard

Find the TV's address under Settings → Network on the TV, or in the router's list of devices. The installer automatically uses SSH if the TV has it, and falls back to the Homebrew Channel's telnet if not.

> [!CAUTION]
> Rooting an LG TV will often open an unauthenticated telnet server by default, leaving a root shell open on the local network. It is good practice to turn telnet off and turn SSH on, for more secure access — [moving from telnet to SSH](SECURITY.md#moving-from-telnet-to-ssh) takes about five minutes and is strongly recommended.

Then, from the `server/` directory in a terminal:

```bash
./deploy.sh <tv-ip>
```

For example:

```bash
./deploy.sh 192.168.1.50
```

The script takes about ten seconds to copy the server files and verify that the service is running. Once complete:

* **In your browser:** Open **`http://<tv-ip>:8080/`** on any phone, tablet, or computer on your home network.
* **On the TV:** Open the new **Glasshouse** tile on your TV's home screen using your remote (see [The TV app](apps/tv-app.md)).

> [!TIP]
> **Static IP recommendation:** Reserving a fixed DHCP IP address for the TV in your home router settings ensures the dashboard address never changes.

> [!NOTE]
> **Private & local by default:** The server runs directly on the TV and talks only to your local network. No analytics or telemetry leave your home. The TV reaches the internet only when checking for new Glasshouse releases.

## Configuration options

Glasshouse can be configured either directly on the TV screen with the remote or headlessly via `config.json` and command-line flags:

=== "On-screen TV setup (Recommended)"

    When Glasshouse is installed, opening the app on the TV for the first time starts an interactive setup wizard designed for the remote.

    ![Network access selection in the Glasshouse TV app setup wizard](screenshots/tv-app-setup-network.png)

    *Choosing whether the web dashboard is open to devices on the home network or TV-local only.*

    The wizard guides you through three key choices:

    * **Web dashboard access**: Choose between opening the web dashboard to phones and computers on your home network, or keeping it private to this TV only (`127.0.0.1`).
    * **Home Assistant integration**: Connect your TV to Home Assistant via MQTT. The TV displays a QR code to scan with your phone, allowing you to enter your MQTT broker credentials easily from your mobile browser without typing on the TV remote.
    * **Active Standby (Always-on)**: On TVs that support Always Ready / Active Standby (such as the LG C2 or G2), choose whether Glasshouse and Home Assistant remain connected with the screen off so the TV can be controlled and turned back on over the network.

    Any choice made during setup can be changed at any time from the TV app's **Settings** tab or the web dashboard. For a full walkthrough with screenshots, see [The TV app setup wizard](apps/tv-app.md#first-run-setup-wizard).

=== "Configuration file & flags (Headless)"

    For headless installs, multi-TV households, or users who prefer configuring files directly, Glasshouse reads its settings from `/var/lib/tvweb/config.json` on the TV.

    To pre-configure a TV before installation, create a `server/config.json` file (or `server/config.<tv-ip>.json` if deploying to multiple TVs) in your cloned repository before running `./deploy.sh`. The installer automatically seeds the TV with that configuration on first deploy.

    #### Core settings

    These are the most common properties you can set in `config.json`:

    | Property | Default | Description |
    | :--- | :--- | :--- |
    | `port` | `8080` | Port for the web dashboard and REST API. Also set under Server → Advanced → Dashboard port; the port after it (`port + 1`) and the one after that (`port + 2`) serve the phone handoff and the icons. |
    | `host` | `"::"` | Bind address. `"::"` listens dual-stack (IPv4 and IPv6), `"0.0.0.0"` listens on all IPv4 interfaces, and `"127.0.0.1"` keeps the dashboard private to the TV only. |
    | `token` | `""` | Optional access token. When set, every web dashboard visit and API request requires `?k=<token>`. The TV app automatically embeds this token into its phone pairing QR code. |
    | `allowControl` | `true` | When `false`, disables remote TV controls (volume, inputs, screen on/off, app launch, toast). |
    | `allowPower` | `true` | When `false`, hides and refuses power off, power on, and reboot actions. |
    | `mqtt.enabled` | `false` | Enables the Home Assistant MQTT bridge. |
    | `mqtt.host` | `""` | IP address or hostname of your MQTT broker (e.g., `"192.168.1.5"`). |
    | `mqtt.port` | `1883` / `8883` | Broker port. Defaults to `1883` (plain) or `8883` when `mqtt.tls` is `true`. |
    | `mqtt.tls` | `false` | Encrypts the broker connection with TLS. |
    | `mqtt.username` | `""` | MQTT username (use a dedicated user restricted to the TV's topics). |
    | `mqtt.password` | `""` | MQTT password. |
    | `mqtt.topicPrefix` | `"lgtv"` | Root segment for published state topics and commands. |
    | `mqtt.discoveryPrefix` | `"homeassistant"` | Home Assistant MQTT discovery prefix. |

    An example `config.json` with Home Assistant enabled:

    ```json
    {
      "port": 8080,
      "token": "my-secret-token",
      "mqtt": {
        "enabled": true,
        "host": "192.168.1.50",
        "username": "lgtv",
        "password": "broker-password"
      }
    }
    ```

    #### Advanced and hardware settings

    Advanced settings can be adjusted in `config.json` or through the dashboard's Server and Tools tabs:

    | Property | Default | Description |
    | :--- | :--- | :--- |
    | `panel` | Auto | Overrides panel detection with `"oled"` or `"lcd"` if automatic detection does not detect your panel correctly. |
    | `logging.level` | `"info"` | Server logging verbosity: `"quiet"` (warnings/errors only), `"info"` (standard), or `"debug"` (verbose diagnostics). |
    | `ntp.server` | `""` | Hostname of an NTP server (e.g., `"pool.ntp.org"`) to synchronize the TV's clock on boot and hourly. |
    | `syslog.server` | `""` | Remote syslog server address to forward TV and Glasshouse logs over RFC 5424 UDP (port `514`). |
    | `allowTileHiding` | `false` | Experimental: allows hiding built-in LG system tiles and apps on the home screen. |
    | `allowExperimentalHome` | `false` | Experimental: offers [Glasshouse Home](dashboard/home.md) on webOS 11, where it is untried. |
    | `allowExperimentalScreensavers` | `false` | Experimental: allows custom QML screensavers on webOS 12 and newer, which are untried there. Named `allowOnWebos10` before 0.105; that name is still read, and renamed when the server starts. |
    | `screensaverPowerOffMinutes` | unset (off) | Puts the TV in standby once a screen saver has been on this many minutes (1 to 1440). Also set from the Screensaver tab as **Poweroff after**. |
    | `allowNetworkDebugger` | `false` | Exposes the webOS app inspector on port `9998` over the local network for developers using `ares-inspect`. |
    | `iconServer` | `false` | Serves installed apps' icons, read-only and without a token, at `http://<tv-ip>:8082/icons/<appId>.png` (the dashboard's port plus two), for launchers on other devices. Home Assistant's Launch App select then lists each icon's address in `app_icons`. Also switched from the MQTT tab. |
    | `update.check` | `false` | When `true`, automatically queries GitHub once daily for new Glasshouse releases. |

    #### Command-line flags

    **Installer flags (`./deploy.sh <tv-ip> [flags]`)**:

    * `--app`: Ensure the Glasshouse app tile is installed on the TV home screen.
    * `--no-app`: Omit installing the TV app tile (runs the background server only).
    * `--telnet`: Force connection over telnet even if SSH is available.
    * `--no-persist`: Run the server only until the next TV reboot (skips the boot persistence hook).

    **Server flags (`node tvweb.js [flags]`)**:

    Used when running the server directly in testing or custom scripts:

    * `--port <port>`: Overrides the configured listening port.
    * `--host <host>`: Overrides the configured bind address.
    * `--config <path>`: Loads a specific configuration file instead of `/var/lib/tvweb/config.json`.
    * `--no-mqtt`: Disables the MQTT bridge regardless of the configuration file.
    * `--no-control`: Disables remote control actions.
    * `--log-level <quiet|info|debug>` (or `-q` / `-d`): Sets logging verbosity.
    * `--emulate-setup`: Simulates the first-run setup wizard in non-destructive test mode without altering TV settings or restarting.

## Troubleshooting

* **Connection refused or password prompt during install.** The installer tries passwordless SSH first, then telnet. If SSH prompts for a password, make sure telnet is toggled **ON** in the TV's Homebrew Channel app settings, or run `./deploy.sh <tv-ip> --telnet` to connect directly over telnet.
* **Nothing on port 8080.** On the TV, `/var/lib/tvweb/tvwebctl status` says whether the server is running and `/var/lib/tvweb/tvweb.log` says why it is not.
* **Panel hours and OLED Care missing on an OLED TV**, or showing on an LCD one. Panel detection went the wrong way: set `"panel": "oled"` or `"panel": "lcd"` in `server/config.json` before a first deploy, or in `/var/lib/tvweb/config.json` on a TV that already has one.
