# Inputs

The **Inputs** tab (`/?tab=inputs`) controls how the remote's **Input** key behaves, which inputs Glasshouse shows, and what appears on screen when an input has nothing connected. Switching directly to an input is on the [Control](control.md) tab.

## Glasshouse Input bar

**Glasshouse Input bar** replaces LG's stock input list with a sleek overlay bar over whatever is playing, opened by the **Input** key (or any key set to **Input bar** under [Remote keys](remote.md#remote-keys)).

### Choosing the input bar

* **When you press Input on the remote:** Preview cards choose between **LG's list** and **Glasshouse Input bar**. This is the same setting as the **Input** key under [Remote keys](remote.md#remote-keys), where you can also assign the bar to any other remote key.
* **Switch only on OK:** Off by default, so the TV switches a second after your last press. Switched on, moving along the bar only picks an input, and **OK** switches to it.
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
* **AV** and **Component**, on TVs that have those inputs, with their connection shown as for HDMI.
* **AirPlay**, **Screen Share**, and **All Inputs** (LG's Input Hub / Home Hub), wherever the TV includes them.

### Supported TVs & background preloading

* **Supported versions:** Offered without any experimental switch on **webOS 4 to 10**, where the compositor filter can hand further **Input** presses to the bar. Not offered before webOS 4. On webOS 11, whose remote keys are compiled inside LG's compositor, it is offered only on a TV whose key handler Glasshouse knows how to change (an OLED48C31LA on firmware 44.00.92 so far): choosing the bar changes a few bytes of LG's `libappLaunch.so.1` in a copy mounted over it and restarts the TV's screen once, which takes about 35 s, and again each time the TV starts, and choosing **LG's list** puts it back with another restart.
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
* **Picture frame:** Shows the [Picture frame screen saver](screen-savers.md#picture-frame)'s pictures, your own and the collections picked there, each fading into the next. Each picture's label starts with LG's own “No Signal”, and shows as the picture frame's does: for a moment after each change, always, or never. Until the first picture is in, or with nothing picked, LG's “No Signal” stays on screen. Pictures are asked for only while the screen shows. With it chosen, **Now showing**, with **Previous** and **Next**, is under the cards, and **Picture frame settings** opens the dialog where its pictures are picked, the same one the Screensaver tab opens. The remote's left and right step back and forward through them too, where Glasshouse can read the remote's keys. Tried on a B8 running webOS 4.4.3.

Switching modes takes effect immediately when an idle input is already on screen, and otherwise the next time no HDMI input is active (such as at Home), so restarting the input app never interrupts what you are watching. LG's other messages, such as a scrambled channel notice, remain untouched. The chosen mode is preserved across restarts and is also available in the TV app under **Screen saver**.

## webOS versions

**Glasshouse Input bar** is offered on webOS 4 to 10, and on webOS 11 for the TVs described above; [why not elsewhere](../tested-tvs.md#why-some-versions-are-not-offered). Where no one has yet reported it working on the TV's version, a note above the choice says so, with links to report a problem or that it works; see [Launchers and overlays by webOS version](../tested-tvs.md#launchers-and-overlays-by-webos-version).

## TVs without the Input bar

On TVs where **Glasshouse Input bar** cannot be offered (for example, **webOS 3**, or a **webOS 11** TV whose key handler Glasshouse does not know):

* **When you press Input on the remote** is hidden automatically.
* **Your inputs** still appears if you have enabled [Glasshouse Home](home.md), [Glasshouse Minimal](home.md#glasshouse-minimal), or a [Custom](home.md#custom-launcher) launcher on the **Home** tab, so you can rename, reorder, and hide inputs there.
* **No Signal screen** appears if supported on your webOS version.
* If none of those sections apply (for instance, **LG Home** is active on webOS 11), the tab simply states: *"Nothing about this TV’s inputs can be changed from here."*
