<p align="center"><img src="docs/logo/glasshouse-512.png" width="128" alt="Glasshouse logo: a G whose top is a roof"></p>

# Glasshouse

**Own the glass.** A dashboard, privacy controls and Home Assistant bridge for rooted LG webOS TVs.

> [!NOTE]
>
> ## You bought the TV.
>
> **It's your TV and you should control it. You own the glass.**
>
> Designed for those who reject their network-connected home appliances being
> used as a platform for advertising, telemetry and vendor-controlled
> experiences, this project brings control, visibility and automation back to
> the device.
>
> It offers multiple ways to remove ads, withdraw from agreements and services
> designed to monetize your data, and make the TV a simpler, more streamlined
> experience — alongside a wide range of useful features, customisation and
> local smart-home integration.
>
> Glasshouse itself is local, transparent, and requires no cloud service.
> No nonsense, no data collection, no ads, no dark patterns. I don't want your data.

**Glasshouse** is a server that runs directly on a rooted LG webOS TV, providing both a live browser dashboard and a dashboard app.

Use it for remote control, app installation and removal, OLED panel care, privacy controls, service menu access, and hardware telemetry. It also includes an MQTT bridge for integrating the TV with Home Assistant and other smart-home software.

### Compatibility at a glance

* **webOS**: 2.2 through 11 (LG's webOS 26) confirmed; tested across 2015–2026 models. Other versions likely work as well. LG names its versions two ways: [webOS version numbers](https://rorygallagher2024.github.io/glasshouse/tested-tvs/#webos-version-numbers) gives both
* **Panels**: OLED (full panel wear telemetry and burn-in controls) and LCD (core dashboard, controls, and telemetry; OLED Care tab hides automatically)
* **Access**: Rooted via [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel). Telnet or SSH. No external dependencies or internet access needed on the TV
* **Tested hardware**: 48 TVs across 33 series verified so far (LF632V, UH600V, UH6030, UH610V, UH635V, B7, B8, C8, LM57, UM73, C9, CX, GX, C1, UP80, UP81, QNED82, C2, G2, C3, B4, G3, C4, G4, UT73, UT81, C5, G5, CS, LX3, UA73, C6, NU80). Other rooted models should work; [see full table](https://rorygallagher2024.github.io/glasshouse/tested-tvs/)

**[Read the documentation](https://rorygallagher2024.github.io/glasshouse/)** for the features, installation, Home Assistant and security.

---

## Quick start

1. Root the TV and install the [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).
2. Clone this repository on a computer on the same network as the TV.
3. Run `./deploy.sh <tv-ip>` from the `server/` directory.
4. Open `http://<tv-ip>:8080/` in a browser.

That's it. The dashboard is ready to use.

The [installation guide](https://rorygallagher2024.github.io/glasshouse/install/) has the details and troubleshooting.

---

## What it's for

This project is intended to give a rooted webOS TV a useful local control surface instead of requiring the owner to work around the TV's built-in menus, vendor services and cloud dependencies.

1. **[Controlling the TV without the cloud](https://rorygallagher2024.github.io/glasshouse/dashboard/control/).** A D-pad to navigate the TV itself, volume, mute, media playback keys (play, pause, stop, skip), app launcher, picture presets, sound output routing, power and reboot.

2. **[Seeing what the TV is configured to collect, and switching it off](https://rorygallagher2024.github.io/glasshouse/dashboard/privacy/).** Whether LG's content-recognition engine is running and sampling the screen, the advertising identifier and whether ad tracking is limited, and every data agreement recorded on the TV with most of them switchable from the dashboard. Includes an on-TV blocker for LG's ad and telemetry endpoints, and a switch for the two diagnostics services that upload to LG.

3. **[App management, debloating and home screen cleanup](https://rorygallagher2024.github.io/glasshouse/dashboard/apps/).** Install apps from the Homebrew Channel catalog, permanently uninstall apps to reclaim internal flash storage, disable unnecessary background system services to free up RAM and CPU cycles, stop LG keeping apps loaded in the background that are never used, hide non-removable built-in LG system apps from the home launcher, and on webOS 9 strip LG's Home screen down to the apps and inputs.

4. **[Remapping the remote's buttons](https://rorygallagher2024.github.io/glasshouse/dashboard/apps/#remote-keys).** Point Netflix, Prime Video, Guide, the color keys and the TV's other shortcut buttons at any installed app, an HDMI input or Live TV, or turn them off. The change applies straight away and lasts across reboots, without waiting for the dashboard to start.

5. **[Replacing the screen saver](https://rorygallagher2024.github.io/glasshouse/dashboard/screen-savers/).** A clock, a starfield, fireworks, or the TV's own readings, each dim or bright, in place of LG's.

6. **[Integrating the TV with a smart home](https://rorygallagher2024.github.io/glasshouse/HOME-ASSISTANT/).** The MQTT bridge exposes the TV as a single device with its controls and telemetry, with Home Assistant support through MQTT Discovery and the same underlying interface available to other MQTT clients. You can also send button press events to Home Assistant to control your smart home from your TV remote.

7. **[Seeing what the TV is actually doing](https://rorygallagher2024.github.io/glasshouse/dashboard/metrics/).** SoC temperature, per-core CPU load, memory, swap, Wi-Fi signal and throughput.

8. **[Observing OLED panel wear](https://rorygallagher2024.github.io/glasshouse/dashboard/oled-care/).** Cumulative panel hours, compensation cycle progress, Pixel Refresher countdown with scheduling, completed cycle counters and refresher failure alerts.

9. **[Controlling the OLED burn-in protections](https://rorygallagher2024.github.io/glasshouse/dashboard/oled-care/).** What each one does and a switch for it: screen shift and logo dimming on any OLED, and on TVs that expose them, ASBL and Global Stress Reduction (normally reachable only from the TV's service menu, with a service remote and a PIN).

10. **[Opening the service menu, and unlocking it where it is locked](https://rorygallagher2024.github.io/glasshouse/dashboard/service-menu/).** LG's own engineering menu, put on the TV screen from a browser which means no service remote is needed. Newer firmware shows a cut-down version of it until it is unlocked, which the dashboard can do as well.

11. **[Reading all of it on the TV itself](https://rorygallagher2024.github.io/glasshouse/apps/tv-app/).** An optional app on the home screen puts the same readings and controls on the TV, driven by the remote, for when there is no phone or laptop to hand.

12. **[Managing TVs from Android](https://rorygallagher2024.github.io/glasshouse/apps/android/).** A phone app that keeps a list of TVs, shows which are online, wakes them over Wake-on-LAN, and opens each one's dashboard full screen.

---

## Screenshots

<p align="center">
  <a href="docs/screenshots/dashboard.png"><img src="docs/screenshots/dashboard.png" alt="Metrics tab: SoC temperature, system readouts, storage, watch time, Magic Remote battery and HDMI ports, dark theme (OLED42C24LA)" width="440"></a>
  &nbsp;
  <a href="docs/screenshots/dashboard-light.png"><img src="docs/screenshots/dashboard-light.png" alt="Control tab: panel, source, volume, playback, sleep timer and power, light theme (OLED42C24LA)" width="440"></a>
  <br>
  <sub>Metrics and Control tabs, shown in dark and light themes.</sub>
</p>

[More screenshots](https://rorygallagher2024.github.io/glasshouse/#screenshots), including Home Assistant.

---

## Android app

[Glasshouse for Android](https://github.com/rorygallagher2024/glasshouse-android) keeps a list of TVs, shows which are online and opens each one's dashboard full screen. A TV is added by scanning any QR code on its dashboard, which carries the token as well. See the [Android app documentation](https://rorygallagher2024.github.io/glasshouse/apps/android/) for more details.

It is on [Google Play](https://play.google.com/store/apps/details?id=org.glasshouse.android), for Android 10 and later. Problems and suggestions go in the app's [issues](https://github.com/rorygallagher2024/glasshouse-android/issues).

---

## Documentation

* [Installing](https://rorygallagher2024.github.io/glasshouse/install/) and [tested TVs](https://rorygallagher2024.github.io/glasshouse/tested-tvs/)
* [The dashboard](https://rorygallagher2024.github.io/glasshouse/dashboard/), tab by tab
* [Home Assistant](https://rorygallagher2024.github.io/glasshouse/HOME-ASSISTANT/), [entities](https://rorygallagher2024.github.io/glasshouse/HOME-ASSISTANT-ENTITIES/) and [remote button events](https://rorygallagher2024.github.io/glasshouse/HOME-ASSISTANT-REMOTE-BUTTONS/)
* [Updating and uninstalling](https://rorygallagher2024.github.io/glasshouse/managing/)
* [Security](https://rorygallagher2024.github.io/glasshouse/SECURITY/)
* [What it changes on the TV](https://rorygallagher2024.github.io/glasshouse/TV-CHANGES/)
* [Internals](https://rorygallagher2024.github.io/glasshouse/IMPLEMENTATION/)

The pages are built from [docs/](docs/), so they can also be read there.

---

## Security

The dashboard has **no authentication by default**, for frictionless control from any phone or browser on a trusted local network. **Never expose port 8080 directly to the internet (do not port-forward).** [Security](https://rorygallagher2024.github.io/glasshouse/SECURITY/) covers the token, closing the port to the network, and MQTT.

---

## Support the project

Glasshouse is free, open-source, and maintained in spare time alongside community contributions. If it provides value to you, donations are much appreciated, helping to offset the personal cost of LLM tokens used for development and webOS research.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Donate-yellow.svg)](https://buymeacoffee.com/rorygallagher2024)

---

## Disclaimer

**Use this software at your own risk.**

* **Root access and hardware.** This runs custom software with `root` privileges on an embedded TV OS. It is designed to be lightweight and to leave the read-only rootfs untouched, but the author accepts **no responsibility** for damage, bootloops, bricked devices, voided warranties, data loss or panel issues.
* **Power and control commands.** Reboot, power off, screen blanking and Pixel Refresher scheduling issue low-level `luna-send` calls. Understand what each does before using it.
* **Trademarks.** An independent, unofficial community project, not affiliated with or endorsed by LG Electronics. webOS is a trademark of LG Electronics.
* **Fonts.** Bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and [Manrope](https://github.com/sharanda/manrope) under the [SIL Open Font License 1.1](https://openfontlicense.org/); licence texts ship in `server/assets/fonts/`.

## License

MIT. See [LICENSE](LICENSE).
