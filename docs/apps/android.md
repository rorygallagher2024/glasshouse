# Glasshouse for Android

[Glasshouse for Android](https://github.com/rorygallagher2024/glasshouse-android) is an Android companion app for Glasshouse on rooted LG webOS TVs. It keeps a list of TVs on your network, shows each one's state and what it is showing, turns TVs on and off (with Wake-on-LAN when they are fully off), and opens each TV's dashboard full screen.

The app runs on Android 10 and later, and follows the dashboard's design: monochrome styling, Manrope typography, and light/dark theme matching.

<p align="center" markdown>
  ![The TV list, with power, volume and Open dashboard on each TV](../screenshots/android-tvs.png){ width="300" }
  &nbsp;&nbsp;&nbsp;&nbsp;
  ![A TV's dashboard, with TVs and the section menu along the bottom](../screenshots/android-dashboard.png){ width="300" }
</p>

*The TV list, with power and volume on each TV, and a TV's dashboard with the app's back button and section menu along the bottom.*

## How to get the app

Install [Glasshouse from Google Play](https://play.google.com/store/apps/details?id=org.glasshouse.android). Suggestions and bug reports go on the [GitHub repository issues page](https://github.com/rorygallagher2024/glasshouse-android/issues).

## Adding a TV

TVs can be added to the app in three ways:

* **Scan a QR code**: Scan the QR code shown under the **Settings** tab in the TV app or on the web dashboard. This automatically imports the TV's address and access token. Scanning a TV that is already saved updates its token.
* **Network discovery**: Tap **Find TVs on this network** to discover Glasshouse TVs automatically using SSDP and local subnet scanning.
* **Manual address**: Enter the TV's IP address or hostname directly. The default port `8080` is used if none is specified.

Saved TVs, including their tokens, remain stored securely in private app storage and are excluded from cloud backups and device transfers.

## The TV list

Each TV is a card with its model number, the name given to it and its power state, and, while it is on, what is on screen and its volume, with the remote's volume steps and mute. **Turn on** or **Turn off** works from the list without opening the dashboard, and keeps saying so until the TV reports the change; **Open dashboard** opens it. The list opens on each TV's last state, shown faint until the TV answers, and pulling it down checks every TV at once.

A **Quick Settings tile** turns one TV on and off: the one chosen with **Use for Quick Settings tile** in its card's menu, or the only one.

## Turning a TV on

> [!IMPORTANT]
> A TV that is powered off or in standby can only be woken over the network if Wake-on-LAN is enabled. On the TV, turn on **Turn on via Wi-Fi** (or **Mobile TV On** on older webOS versions), or check Power under the dashboard's **Advanced** tab.

* **Active Standby / Screen Off**: If the TV is in Active Standby (running panel clearing or Always Ready), the app displays a standby ring and a power button that triggers the server's `powerOn` API.
* **Cold Standby / Powered Off**: If the TV's MAC address is known, the app sends Wake-on-LAN magic packets across the local broadcast domain every five seconds until the server responds.

## Dashboard features

* **Full-screen WebView**: The dashboard displays full screen, hiding system bars and matching the TV's dark or light theme.
* **Controls at the bottom**: The back button and, on a phone, the dashboard's section menu sit in a bar along the bottom of the screen, within a thumb's reach. The menu is named after the section on screen, and replaces the page's own menu bar.
* **Pull-to-refresh**: Pull down at the top of any dashboard screen to reload the page.
* **Package sideloading**: Integrates with Android's system file picker, allowing `.ipk` Homebrew packages stored on your phone to be sideloaded directly onto the TV.
* **Battery efficient**: Polling and WebView JavaScript timers pause automatically whenever the app moves to the background.

## Source code & contributing

The app is open source under the MIT license. The source code, issue tracker, and release workflows are hosted on GitHub:

* **Repository**: [https://github.com/rorygallagher2024/glasshouse-android](https://github.com/rorygallagher2024/glasshouse-android)
