# Inputs

The **Inputs** tab (`/?tab=inputs`) controls how the remote's **Input** key behaves, which inputs Glasshouse shows, and what appears on screen when an input has nothing connected. Switching directly to an input is on the [Control](control.md) tab.

## Glasshouse Input bar

**Glasshouse Input bar** replaces LG's stock input list with a sleek overlay bar over whatever is playing, opened by the **Input** key (or any key set to **Input bar** under [Remote keys](remote.md#remote-keys)).

### Choosing the input bar

* **When you press Input on the remote:** Preview cards choose between **LG's list** and **Glasshouse Input bar**. This is the same setting as the **Input** key under [Remote keys](remote.md#remote-keys), where you can also assign the bar to any other remote key.
* **Transparent tiles:** Off by default so the bar's tiles stay opaque and stepping through inputs does not repaint translucent tiles or shadows over the picture. Switch it on if you prefer the picture to show subtly through the bar.

### How it works

* **Stepping & switching:** Pressing **Input** opens the bar on the current input (marked with a green dot). Over Glasshouse Home or another launcher, it starts on the last watched input with **OK** switching straight back to it. Each press moves to the next input, wrapping round to the first, and the TV switches a second after the last press.
* **Navigation:** **Left** and **Right** step horizontally (**Up** and **Down** move between rows in the two-row layout), **OK** switches at once, and **Back** closes it. With the Magic Remote pointer, hovering focuses a tile and clicking switches immediately.
* **Auto-close:** Left alone, the bar closes after 3 seconds on the input already on screen, or after 6 seconds on another input highlighted by the pointer.
* **Two-row layout:** When **6 or more** inputs are shown, the bar automatically stacks them into two rows so every source fits on screen without horizontal scrolling.

### What the bar shows

Each tile shows its name, subtitle (such as HDMI port or source type), and an automatic icon, in the order configured under [Your inputs](#your-inputs):

* **Live TV** tuner (when broadcast or cable channels are tuned).
* **HDMI ports & SIMPLINK (CEC) devices**, including devices connected through an AV receiver or soundbar, waking and routing them on selection.
* **USB storage** attached to the TV, and **Media Servers** discovered over DLNA/UPnP when **Show media servers** is switched on under [Your inputs](#your-inputs).
* **AirPlay**, **Screen Share**, and **All Inputs** (LG's Input Hub / Home Hub), wherever the TV includes them.

### Supported TVs & background preloading

* **Supported versions:** Offered without any experimental switch on **webOS 4 to 10**, where the compositor filter can hand further **Input** presses to the bar. Not offered on webOS 11 (whose remote keys are compiled inside LG's compositor) or before webOS 4.
* **Fast opening:** Choosing the bar installs a hidden companion app (`com.tvweb.inputbar`) with no Home tile and keeps it preloaded in the background while the TV is on so it appears in roughly 0.4 s. Setting the last key that used it back to LG's (or uninstalling Glasshouse) removes the app.

## Your inputs

Shows when **Glasshouse Input bar** or a Glasshouse launcher ([Glasshouse Home](home.md), [Glasshouse Bar](home.md#glasshouse-bar), [Glasshouse Minimal](home.md#glasshouse-minimal), or [Custom](home.md#custom-launcher)) is active. Any change here updates both the Input bar and the TV launcher, even when Glasshouse Home itself is switched off.

* **Order:** Choose **Your order** to keep your manual arrangement, or **Last opened** to automatically bubble recently used inputs to the front.
* **Hide inputs with nothing connected:** Completely omits disconnected HDMI ports instead of showing them dimmed (labelled **Left out**). They still show dimmed in arrange mode on Glasshouse Home and reappear automatically when a cable or device is connected.
* **Show media servers:** Off by default so speakers and network devices broadcasting DLNA do not clutter your inputs list. Switch it on to show discovered DLNA media servers across your inputs; leave it off to omit all current and future media servers.
* **Input cards:** Each input card lets you:
  * **Rename** the input inline by clicking its name (HDMI ports and extra sources keep their physical port or source type in the subtitle; clearing the name restores the TV's own name).
  * **Reorder** with `←` and `→` when **Order** is set to **Your order**.
  * **Show or hide** each tile individually using the **Shown** / **Hidden** pill.

## No Signal screen

Offered on TVs whose No Signal overlay Glasshouse knows how to replace (tried on a B8 running webOS 4.4.3 and a C2 running webOS 9.2.2):

* **LG's screen:** LG's default No Signal graphic, text, and help banner.
* **Just “No Signal”:** Strips out the animated picture and help text so only the words “No Signal” drift quietly across a black screen.
* **Disconnected cable:** Hides the “No Signal” text as well and shows a subtle disconnected HDMI cable icon instead.

Switching modes takes effect immediately when an idle input is already on screen, and otherwise the next time no HDMI input is active (such as at Home), so restarting the input app never interrupts what you are watching. LG's other messages, such as a scrambled channel notice, remain untouched. The chosen mode is preserved across restarts and is also available in the TV app under **Screen saver**.

## webOS versions

**Glasshouse Input bar** is offered on webOS 4 to 10; [why not elsewhere](../tested-tvs.md#why-some-versions-are-not-offered). Where no one has yet reported it working on the TV's version, a note above the choice says so, with links to report a problem or that it works; see [Launchers and overlays by webOS version](../tested-tvs.md#launchers-and-overlays-by-webos-version).

## TVs without the Input bar

On TVs where **Glasshouse Input bar** cannot be offered (for example, **webOS 11** and **webOS 3**):

* **When you press Input on the remote** is hidden automatically.
* **Your inputs** still appears if you have enabled [Glasshouse Home](home.md), [Glasshouse Minimal](home.md#glasshouse-minimal), or a [Custom](home.md#custom-launcher) launcher on the **Home** tab, so you can rename, reorder, and hide inputs there.
* **No Signal screen** appears if supported on your webOS version.
* If none of those sections apply (for instance, **LG Home** is active on webOS 11), the tab simply states: *"Nothing about this TV’s inputs can be changed from here."*
