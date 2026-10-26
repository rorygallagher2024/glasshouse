# Apps and home screen launcher

The **Apps** tab, `/?tab=apps`, has three groups: **Apps**, for installing and removing apps and the web pages saved to the Home screen; **Home screen and remote**, for what the Home screen shows and what the remote's keys do; and **Background**, for the memory LG's background apps and services take up.

![Apps tab in three groups: installed applications and saved web pages under Apps, the Home screen layout with its inputs and parts, Quick Access and hidden system apps under Home screen and remote, and apps kept ready and background services under Background](../screenshots/apps.png)

*The three groups, with installed applications, saved web pages, the Home screen layout, apps kept ready in the background and background services open.*

## Apps

### Manage applications

![Manage applications, listing each installed app with its size and Launch and Uninstall buttons](../screenshots/apps-manage.png)

Lists the apps downloaded from the LG store or installed by hand, with their version, vendor, and storage badge showing disk footprint. Launch opens the application on the TV, while Uninstall deletes an app completely and frees its storage. LG's built-in apps can't be removed this way; they can be hidden instead.

### Install homebrew apps

![Install homebrew apps, with category filters, a search box and the Homebrew Channel catalog, each app with its size and an Install button](../screenshots/apps-install.png)

Lists the Homebrew Channel catalog, with category filters (All, Media, Games, Utilities, Ambilight, Screensavers) and keyword search, and Install, Update or Uninstall for each app, with Launch beside an installed one. The list shows 10 apps at a time, with **Show 10 more** beneath; a search or category looks through the whole catalog. Downloads are checked against the catalog before they are installed, and the dashboard asks first when something needs a decision, such as replacing a copy installed from the LG store.

After a [settings backup](server.md#glasshouse) is restored, the apps it listed that this TV lacks and the catalog has are shown above the catalog. **Install all** installs them one after another, each as if picked from the catalog, so it stops for any decision; **Dismiss** forgets the list.

### Other app catalogs

Catalogs other than the Homebrew Channel's, such as the one a developer keeps for a fork of an app. Pasting a catalog's address and choosing **Add catalog** lists its apps here, each with Install, Update or Uninstall (and Launch, once installed) and the catalog it is from, and they are checked for updates with the rest. A GitHub repository's page can be pasted in place of the address, and the dashboard reads the `repo.json` it keeps, as many such catalogs do. Each catalog shows how many apps it offers, or why it could not be read, and **Remove** takes it off the list; apps installed from it stay on the TV. Their apps show 10 at a time, as the Homebrew Channel's do, with a search box once there are more than 10.

These apps are listed apart from the Homebrew Channel's, so an app both list, such as YouTube AdFree and a fork of it, shows in each, and Install or Update installs the one in that list. Where the TV has an LG store app under the same id, as YouTube is for YouTube AdFree and its forks, the catalog's app shows as not installed, and installing it asks before replacing the store's. An app from an added catalog is never given root without asking, as for an install from a URL.

Adding or removing a catalog needs **Install app from a URL or file** turned on, or a token, since whoever runs a catalog chooses what it offers to install. Catalogs listed in `config.json` show here too.

### Install app from a URL or file

![Install app from a URL or file while it is off, with the button that turns it on](../screenshots/apps-sideload.png)

Installs an `.ipk` package from outside the catalog. **From URL...** downloads one from an http or https address, with an optional sha256 to check it against, and **Upload .ipk** sends one from the browser. Both show the same preview as a catalog install.

It is off until it is switched on in this section (after a warning) or a token is set, since a package from outside the catalog can run anything on the TV. A request from the TV itself is always allowed.

### Saved web pages

![Saved web pages, two pages with Edit and Remove buttons, and the fields for adding another](../screenshots/apps-saved-pages.png)

Lists the web pages on the Home screen, each of which opens in the TV's browser. A page saved from the browser takes its whole title as its name, so a long one can be given a shorter name here. Pages can also be added, pointed at a new address, or removed.

## Home screen and remote

### Home screen layout

![Home screen layout on webOS 9, with HDMI 1 and HDMI 2 on Home, the banner, Quick Cards and recent input hidden, and the app tiles shown](../screenshots/apps-home-layout.png)

Switches parts of LG's Home screen off, for a Home screen with only the apps and inputs on it:

* **Banner**: the large picture at the top, with LG's adverts or, with them off, its own message and a Go to Apps button. The profile, notifications, settings and search buttons beside it go with it; Settings and search stay on the remote's own buttons.
* **Quick Cards**: the coloured buttons for LG's offers, Sports, Gaming, Music and others.
* **App tiles**: the row of apps and inputs.
* **Recent Input and Device Functions**: the last input used, and cards for editing the app list, the TV guide, the user guide and Home Hub.

At least one part stays. A change takes a few seconds, while the Home screen starts again, and lasts through restarts and power cuts. While [Glasshouse Home](home.md) is on, LG's Home screen is not changed here; the layout set here is kept, and is what LG's Home shows when opened from Glasshouse Home or once Glasshouse Home is switched off. The rows further down, such as Live TV and LG Channels, come from LG's servers and stay.

**Inputs on Home** shows each HDMI input as a tile, dimmed while it is not on Home; choosing one adds or removes the Home screen's tile for it, named as the TV names the input. The input tiles go before the apps, in HDMI order; adding one moves any input tiles moved elsewhere back to the front, and starts the Home screen again to show it. It is LG's own tile for the input, so it can be moved or removed on the TV like any other.

On webOS 9, highlighting an input tile shows its HDMI port and the CEC device
names, including devices behind a receiver, or the TV's own name for the input
where no device gives one. Long names scroll in LG's title area. Titles are
read again when the Home screen opens and shortly after the TV switches on,
never while it is in standby. Only input tiles added by Glasshouse are updated;
a failed discovery keeps the last good title.

**Put back LG's Home screen** shows every part again and takes off the input tiles added here; ones added on the TV stay. The TV app has the same switches.

It is offered on webOS 9 (LG's webOS 24), where it has been tried on a C2, and as an [experimental feature](../experimental.md#home-screen-layout-on-webos-10) on webOS 10 (LG's webOS 25), where it has been tried on a C2 with webOS 10.3.1. webOS 3 and 4 have a much plainer Home screen, so they do not have it. A webOS 8 TV may have the same home app as webOS 9, and webOS 11 a layout of its own; neither is offered it until one has been tried.

On webOS 10 the section has a switch at the top, with its warning, and nothing in it changes until that is on. The parts that can be switched off there are the **Side buttons** (profile, notifications, settings and search), the **Quick Cards** and the **Recommended shelf**. The banner stays.

### Quick Access

![Quick Access, number keys 1 to 9, each with what it opens](../screenshots/apps-quick-access.png)

Sets what each number key on the remote opens when it is held: an installed app, an HDMI input or Live TV, for keys 1 to 9. The keys are tiles laid out as the remote's number pad, each showing what it opens; choosing one opens the choices under its row, as for Remote keys. Holding 0 shows the list on the TV. A change applies straight away, the same as changing it in the TV's own Quick Access list, which shows it too.

**None** leaves a key opening nothing, including one LG set itself, such as its help on 9. A streaming button set to None is still reported to Home Assistant as a [remote button event](../HOME-ASSISTANT-REMOTE-BUTTONS.md). A key LG set for an app that is not installed, as it does for some regions' channel apps, shows as **App not installed**, with the app's id beneath. A key set to a live TV channel on the TV shows the channel, and can be changed here but not set to another channel. The TV app lists the keys without changing them.

### Remote keys

![Remote keys as tiles in streaming buttons, color keys and other keys, each showing what the key does, with buttons on remotes sold elsewhere folded at the end](../screenshots/apps-remote-keys.png)

Sets what a key on the remote does: **As LG has it**, **Nothing**, **Input switcher**, a media control (**Play**, **Pause**, **Stop**, **Rewind**, **Fast forward**, **Volume up**, **Volume down** or **Mute**), or opening an installed app, an HDMI input or Live TV instead. A media control acts as the remote's own play or pause key would on what is on screen. The volume controls change the volume as the remote's own keys do, a sound bar on HDMI ARC included, and repeat while the key is held. **Input switcher** opens LG's list of inputs, as the remote's Input button does; it is offered on TVs that have LG's quick input picker, such as a C5 on webOS 11. Each key is a tile showing what it does now, grouped as streaming buttons, color keys and other keys; choosing a tile opens the choices under its row. The keys listed are the ones this TV's own key handling names, so a C5 lists its Disney+ button and a CX does not; Netflix, Prime Video, Guide, Input, TV, Search, Info, Help and the four color keys are typical, 2020 remotes add a Movies button, and recent Magic Remotes add Alexa and Google Assistant buttons. The microphone button is not offered, since it drives voice control itself. Home, Back, volume, mute, channel and power are not offered.

The list is what the TV handles, not what any one remote has. A Magic Remote has no Guide, Info or color keys, and a plain IR remote no Netflix or Prime Video button, while the TV handles all of them because other remotes send them. LG also ships the same key handling to many countries, so a UK TV names Hulu and Sling TV; once the TV has reported its country, keys only sold on remotes elsewhere (Hulu and Sling TV in the US, BBC iPlayer and Freeview Play in the UK) are folded away under **Buttons on remotes sold elsewhere**, unless already changed. Look at the remote before setting a key: a key it cannot send does nothing when set, and does no harm either.

A change applies straight away, on whatever is on screen, and lasts across reboots, working before the server has started. Setting every key back to **As LG has it** gives every key back to the TV; `tvwebctl restore-keys`, which uninstalling from the Homebrew Channel runs, also takes Glasshouse's filter out of the TV's key handling.

A key set here is taken before any app sees it, so it wins over an app's own use of that key. YouTube uses **Guide** for its own guide, and Live TV and the HDMI inputs use the color keys for their banners and teletext: with such a key set here, those apps no longer get it, whatever is on screen, until the key is **As LG has it** again. There is no per-app setting. How it works is in [Remote keys through the compositor's filter chain](../IMPLEMENTATION.md#remote-keys-through-the-compositors-filter-chain).

With [LG Input Hook](https://repo.webosbrew.org/apps/org.webosbrew.inputhook/) from the Homebrew Channel installed, keys set here may do nothing. Input Hook takes the streaming buttons before the TV's own key handling sees them, which is where Glasshouse changes them, and acts on its own key bindings instead; on a CX (webOS 5.5) none of the streaming buttons reached Glasshouse while it was installed. For keys set here to work, uninstall Input Hook and restart the TV: its bindings keep working after it is uninstalled, until the restart.

On webOS 11 (LG's webOS 26) LG handles keys differently. The streaming buttons, Apps, Guide, Home Hub (the house in a circle on an MR25 Magic Remote), the **AI** and **Alexa** buttons and the **?** button can be changed, the **?** button separately when pressed and when held; Input, the color keys, Search, Info, Home and **123** cannot, and are not listed. A streaming button set to **Nothing** shows LG's short notice instead of opening an app, and the **?** button cannot be set to **Nothing**. Media controls are not offered there, since LG's handling of these keys only opens apps. Guide set here still opens the guide of Live TV or an HDMI input while one is on screen. LG puts its own streaming buttons back each time the TV is switched off or on; the server sets them again within a few seconds. A streaming button pressed to switch the TV on still opens LG's app.

The **AI** button is answered by LG's voice assistant itself, which no setting changes, so setting it here switches the voice assistant off: voice search, the AI assistant and the microphone stop working until the button is **As LG has it** again, which switches it back on, as uninstalling does. Glasshouse then opens what was chosen about a second after the press. After the TV restarts, the button does nothing until the server has started.

The **Alexa** button set here keeps Alexa from opening until it is **As LG has it** again; LG's voice assistant is left as it is. Glasshouse opens what was chosen right after the press, and for 4 s from it no notice is shown on the TV, so that Amazon's "Alexa is loading" does not appear; a notice anything else sends in those seconds is not shown either. How it works is in [webOS 11: LG's own values](../IMPLEMENTATION.md#webos-11-lgs-own-values).

### Hide home screen system apps

![Hide home screen system apps switched on, with each built-in LG app as a tile marked hidden or shown](../screenshots/apps-system-apps.png)

Hides built-in LG apps that can't be uninstalled, such as Gallery, Music, Sports, Alexa and the User Guide, from the Home screen ribbon. Each app is a tile, dimmed and marked **Hidden** while hidden; choosing one hides or shows it. The apps themselves stay on the TV, and switching the feature off brings every one back. The Web Browser is not offered: hidden, it no longer opens, and saved web pages and links from other apps open in it. A TV that had it hidden shows it again.

On a TV where the app manager can be made to reread its apps through LG's region list (webOS 9 has it, webOS 4 does not), hidden apps come back hidden at each start without restarting it. Elsewhere it is restarted at each cold boot, which can blank the screen for a moment before the active input returns, and the section says so.

It is experimental, and off until it is turned on under **Server** → **Advanced** → **Experimental features**; see [Experimental features](../experimental.md) for why. It is not offered on a Homebrew Channel install.

## Background

### Apps kept ready in the background

![Apps kept ready in the background, each as a tile with the memory it takes when loaded, all switched off](../screenshots/apps-preload.png)

LG keeps some apps loaded so they open faster, including ones that are never used, and each takes up memory. Each app is a tile with roughly how much memory it takes once loaded, and whether it is loaded now; choosing one switches it off, or keeps it ready again. A switched-off app's tile is dimmed and marked in orange, the colour the Apps tab uses for a change from LG's own setting.

Switching an app off frees its memory once the app is next closed or the TV restarts, and it then takes a few seconds longer to open. Switching it back on returns it to LG's setting. Home, Live TV, the HDMI inputs and the other parts the TV relies on are not listed, and the section only appears on TVs that keep such a list.

### Turn off background services

![Turn off background services, each with what it does, its memory or effect, and a Disabled button](../screenshots/apps-services.png)

Stops background services that most TVs don't need, such as the connected-car listener, the USB camera watcher, and LG's diagnostics and telemetry uploaders. Only the services present on the TV are listed. A service switched off stays off across restarts, and is stopped again if something on the TV starts it.

## Notes

* Live TV, Settings, Home, the HDMI inputs, the Homebrew Channel and Glasshouse itself are protected: they can't be hidden or uninstalled.
* Everything on this tab also works from the TV app, except saved web pages and installing from a URL or a file, which are in the browser dashboard only.
* Apps that check they were installed from the LG store may refuse to run when installed another way, and apps built for a newer webOS than the TV runs may not launch.
