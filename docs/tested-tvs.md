# Tested TVs

Confirmed on **54 TVs across 37 series** running **webOS 2.2 through 11** (LG's webOS 26). Any other rooted webOS model should work as well.

* **Series & sizes:** Screen sizes and regional variants of a series run the same software, so the summary table groups them into one row per series. Years are LG's model years; many TVs have since been updated to a later webOS.
* **Version numbers:** Versions here are what the TV reports itself, as the dashboard shows them; see [webOS version numbers](#webos-version-numbers) below for LG's marketing names (webOS 22–26).
* **Older firmware:** webOS 2 and 3 have fewer of LG's services, so readings and controls that rely on them are automatically omitted there.

=== "By series (37)"

    | Series        | Year | Panel | webOS seen        | Reports |
    | :------------ | :--- | :---- | :---------------- | :------ |
    | LF632V        | 2015 | LCD   | 2.2               | 1       |
    | UH600V        | 2016 | LCD   | 2.2               | 1       |
    | UH6030        | 2016 | LCD   | 3.4               | 1       |
    | UH610V        | 2016 | LCD   | 3.4               | 1       |
    | UH635V        | 2016 | LCD   | 3.x               | 1       |
    | B7            | 2017 | OLED  | 3.9               | 1       |
    | B8            | 2018 | OLED  | 4.4               | 1       |
    | C8            | 2018 | OLED  | 4.4               | 1       |
    | LK61          | 2018 | LCD   | 4.4               | 1       |
    | LM57          | 2019 | LCD   | 4.5               | 1       |
    | UM71          | 2019 | LCD   | 4.10              | 1       |
    | UM73          | 2019 | LCD   | 4.10              | 1       |
    | C9            | 2019 | OLED  | 4.9 – 4.10        | 3       |
    | CX            | 2020 | OLED  | 5.5 – 5.6         | 4       |
    | GX            | 2020 | OLED  | 5.6               | 1       |
    | C1            | 2021 | OLED  | 6.x               | 2       |
    | UP80          | 2021 | LCD   | 6.5               | 1       |
    | UP81          | 2021 | LCD   | 6.5               | 1       |
    | C2            | 2022 | OLED  | 9.2, 10.3         | 2       |
    | G2            | 2022 | OLED  | 7.4               | 1       |
    | QNED82        | 2022, 2025 | LCD   | 7.6, 10.3         | 2       |
    | UQ80          | 2022 | LCD   | 7.6               | 1       |
    | LX3           | 2022 | OLED  | —                 | 1       |
    | CS            | 2022 | OLED  | 10                | 1       |
    | C3            | 2023 | OLED  | 10 – 11           | 3       |
    | G3            | 2023 | OLED  | 11                | 1       |
    | B4            | 2024 | OLED  | 9                 | 1       |
    | C4            | 2024 | OLED  | 9 – 10            | 5       |
    | G4            | 2024 | OLED  | 10                | 2       |
    | UT73          | 2024 | LCD   | —                 | 1       |
    | UT81          | 2024 | LCD   | 10                | 1       |
    | C5            | 2025 | OLED  | 10                | 3       |
    | G5            | 2025 | OLED  | 10 – 11           | 2       |
    | UA73          | 2025 | LCD   | 10.3.1            | 1       |
    | C6            | 2026 | OLED  | 11.2              | 1       |
    | NU80          | 2026 | LCD   | 11                | 1       |
    | QNED84        | 2026 | LCD   | 11.0              | 1       |

=== "All reports (54)"

    | Model       | webOS        | Firmware | Panel | Notes                                                          |
    | :---------- | :----------- | :------- | :---- | :------------------------------------------------------------- |
    | 49LF632V-ZC | 2.2.3        | —        | LCD   | Settings service under its older name; server on Node 0.10     |
    | 55UH600V-ZA | 2.2.3        | 04.26.35 | LCD   | PicCap withheld on webOS 2 to prevent watchdog reboot ([#746](https://github.com/rorygallagher2024/glasshouse/issues/746)); runs cleanly |
    | 43UH610V-ZB | 3.4.3        | 05.70.50 | LCD   | No SoC temp, eMMC wear, or OLED metrics by hardware design     |
    | 55UH6030-UC | 3.4.3        | —        | LCD   |                                                                |
    | 58UH635V    | 3.x          | 05.70.40 | LCD   | no eMMC wear reported                                          |
    | OLED65B7V-Z | 3.9.3        | 06.10.65 | OLED  | No SoC temperature or eMMC wear readings                       |
    | OLED65C8PUA | 4.4.0        | 05.50.15 | OLED  | No `getAdid` on this firmware                                  |
    | OLED65B8SLC | 4.4.3        | 05.50.70 | OLED  | Everything works. Misses a few metrics found on newer versions |
    | 32LK6100PLB | 4.4.3        | 05.50.70 | LCD   | Rooted with faultmanager; dashboard, apps and SSH confirmed    |
    | 43LM5760PTC | 4.5          | —        | LCD   | Configured with panel: lcd; service and web UI confirmed       |
    | OLED55C9PLA | 4.9.0        | 05.30.40 | OLED  | Working fine                                                   |
    | OLED65C9AUA | 4.9.x (4.5+) | 05.50.00 | OLED  |                                                                |
    | OLED65C9PLA | 4.10.2       | —        | OLED  | Working fine                                                   |
    | 50UM7300AUE | 4.10.0       | —        | LCD   | Working; hiding system apps did not work                       |
    | 55UM7100PLB | 4.10.2       | 05.40.97 | LCD   | Homebrew Channel, telnet install; privacy controls and preload confirmed |
    | OLED77CX6LA | 5.5.0        | 04.50.90 | OLED  | OLED Care, telemetry and MQTT bridge confirmed                 |
    | OLED77CXAUA | 5.6.0        | 04.60.65 | OLED  | Rooted with faultmanager; SSH install; dashboard and telemetry |
    | OLED48CXPUB | 5.6.2        | 04.64.00 | OLED  | Rooted with slopbro; dashboard, telemetry and API .ipk installs |
    | OLED65CXPUA | 5.6.2        | 04.64.00 | OLED  | Rooted with slopbro; dashboard, telemetry and API .ipk installs |
    | OLED55GX6LA | 5.6.2        | 04.64.00 | OLED  | MQTT bridge and screen savers confirmed                        |
    | OLED55C17LB | 6.x          | —        | OLED  | HDMI 2.1 diagnostics and remote battery reporting              |
    | OLED55C1PUB | 6.x (6.3+)   | 03.53.45 | OLED  | SSH install and MQTT bridge confirmed                          |
    | 50UP81006LR | 6.5.0        | 03.51.16 | LCD   | Installed over telnet; in-app update confirmed                 |
    | 43UP80006LA | 6.5.3        | 03.53.45 | LCD   | MQTT bridge confirmed                                          |
    | OLED65G29LA | 7.4.0        | 04.40.90 | OLED  | Confirmed working                                              |
    | 55QNED826QB | 7.6.0        | 04.60.90 | LCD   | Installed over SSH; MQTT bridge confirmed                      |
    | 65UQ801C0SB | 7.6.0        | 04.60.90 | LCD   | Rooted with slopbro; SSH install; Glasshouse Home confirmed    |
    | OLED42C24LA | 9.2.2        | 23.25.55 | OLED  | Rooted with jsbro-autoroot                                     |
    | OLED55C4PUA | 9.2.0        | 23.20.35 | OLED  | Rooted with faultmanager; SSH install; no internet access      |
    | OLED55B46LA | 9.24.8       | 23.23.30 | OLED  | Installed over telnet                                          |
    | OLED55G42LW | 10           | 33.31.68 | OLED  | Rooted with slopbro, not the Homebrew Channel                  |
    | OLED55C41LA | 10.2.0       | 33.21.85 | OLED  | OLED Care, remote keys, privacy controls and screen saver confirmed |
    | 50UT81006LA | 10.2.1       | 33.22.56 | LCD   | Partial: blocking works; some settings reported not to apply   |
    | OLED55C31LA | 10.2.2       | 33.22.80 | OLED  | Installed over SSH; in-app updates confirmed                   |
    | OLED65CSPSA | 10.3.0       | 33.31.20 | OLED  | Reported working                                               |
    | OLED65C41LA | 10.3.0       | 33.31.24 | OLED  | Rooted with Dangbro; installed with webOS Dev Manager          |
    | OLED65C3PUA | 10.3.1       | 33.31.68 | OLED  | MQTT and volume control confirmed                              |
    | OLED55C25LB | 10.3.1       | 33.31.68 | OLED  | Reported working; screen saver confirmed                       |
    | OLED65C4PSA | 10.3.1       | 33.31.6  | OLED  |                                                                |
    | OLED65G45LW | 10.3.1       | —        | OLED  | Rooted with Dangbro                                            |
    | OLED77C4PSA | 10.3.1       | 33.31.68 | OLED  | Rooted with Dangbro; resolution reported stuck at 1920x1081    |
    | OLED48C55LA | 10.3.1       | 33.31.68 | OLED  | Installed over telnet; in-app update to 0.37.2 confirmed       |
    | OLED77C57LA | 10.3.1       | 33.31.68 | OLED  | MQTT, privacy, screen saver and web dashboard confirmed        |
    | OLED48C5PUA | 10.3.1       | 33.31.69 | OLED  | Rooted with slopbro; dashboard, telemetry and API .ipk installs |
    | 55UA73006LA | 10.3.1       | 33.31.61 | LCD   | Homebrew Channel; SSH install; dashboard and telemetry confirmed |
    | 55QNED82AUA | 10.3.1       | 33.31.61 | LCD   | Rooted with slopbro; SSH install; privacy switches, Glasshouse Home confirmed |
    | OLED65G5WUA | 10           | 33.30.69 | OLED  | No screen saver tab; volume stuck at +10 on optical output     |
    | 42LX3Q6LA   | —            | 33.31.68 | OLED  | Flex; model number has no OLED prefix                          |
    | 43UT73006LA | —            | —        | LCD   | Reported working                                               |
    | 43NU800BPSC | 11.0.0       | 43.02.50 | LCD   | Rooted with slopbro; privacy controls confirmed                |
    | 85QNED84BUA | 11.0.1       | 43.11.76 | LCD   | Dashboard, telemetry disabling and privacy controls confirmed |
    | OLED65G36LA | 11.2.0       | 43.21.71 | OLED  | Rooted with DualBro; privacy, app installs and custom screen savers confirmed |
    | OLED83G5WUA | 11.2.0       | 43.21.71 | OLED  | Rooted with DualBro; runs with internet access blocked         |
    | OLED42C35LA | 11.2.0       | 43.21.71 | OLED  | Working                                                        |
    | OLED55C61LA | 11.2.0       | 43.21.79 | OLED  | Rooted with Dualbro; screen saver and remote keys confirmed    |

> [!TIP]
> **Tested on another model?** Please [open an issue](https://github.com/rorygallagher2024/glasshouse/issues/new) with the TV model, webOS version, and the contents of `/var/lib/tvweb/tvweb.log` — whether everything worked or something broke — and we will add a row.

## webOS version numbers

LG names webOS versions two ways. The TV itself, and this project, use the version it reports (`/etc/issue`, or the dashboard's Metrics tab): 3.4, 4.4, 9.2 and so on. From 2022 LG markets them by year instead, so the same software is also called webOS 22, 23, 24 and so on: always the reported major version plus 15.

| The TV reports | LG calls it    | First shipped on |
| :------------- | :------------- | :--------------- |
| 1.x            | webOS 1.0      | 2014 TVs         |
| 2.x            | webOS 2.0      | 2015 TVs         |
| 3.x            | webOS 3.0, 3.5 | 2016–2017 TVs    |
| 4.x            | webOS 4.0, 4.5 | 2018–2019 TVs    |
| 5.x            | webOS 5.0      | 2020 TVs         |
| 6.x            | webOS 6.0      | 2021 TVs         |
| 7.x            | webOS 22       | 2022 TVs         |
| 8.x            | webOS 23       | 2023 TVs         |
| 9.x            | webOS 24       | 2024 TVs         |
| 10.x           | webOS 25       | 2025 TVs         |
| 11.x           | webOS 26       | 2026 TVs         |

LG's updates have moved some TVs to a later version than they shipped with, so a TV's model year does not give its webOS: a 2022 C2 updated to webOS 24 reports 9.2.
