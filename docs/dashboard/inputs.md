# Inputs

The **Inputs** tab, `/?tab=inputs`, is about the TV's HDMI inputs: which ones are offered, the bar that switches between them, and what an input with nothing coming in shows. Switching to an input is on the [Control](control.md) tab.

## Glasshouse Input bar

A strip of the HDMI inputs over the picture, in place of LG's list of inputs, opened by the **Input** key once **Glasshouse Input bar** is chosen for it here, or by any key set to **Input bar** under [Remote keys](remote.md#remote-keys). Each input shows its device's name, its port and an icon for the kind of device it is, from the name: a console, a handheld, a streaming box, a sound bar, a disc player, a computer or a cable box, or an HDMI plug for any other. The one on screen is marked with a dot.

* The first press opens it on the input on screen. Over Glasshouse Home or a launcher, it opens on the input last watched, which is not marked, and **OK** switches to it. Each further press moves to the next input, round to the first, and the TV switches to it a second after the last press, as LG's does.
* **Left** and **Right** move too, **OK** switches at once and **Back** closes it. With the Magic Remote's pointer, hovering an input picks it and clicking switches, without the second's wait.
* Left alone, it closes after 3 seconds on the input already on screen, or after 6 on another one the pointer left it on.
* A device behind a receiver is switched to as Glasshouse Home's tile does, waking it through the receiver.

It shows the inputs chosen under [Your inputs](#your-inputs), in that order, without the hidden ones, and without those with nothing connected when **Hide inputs with nothing connected** is switched on. They are configured there with Glasshouse Home switched off too.

Choosing it for a key installs its app, a web app with no tile on the Home screen, `com.tvweb.inputbar`; setting the last key that used it to anything else removes it, as does uninstalling Glasshouse. While a key opens it and the TV is on, Glasshouse keeps the app loaded in the background, hidden and taking no keys, so a press shows it in about 0.4 s on a C1 rather than 0.7 s or more.

It is offered on webOS 4, 6 and 9, where it has been tried (a B8 with 4.4.3, a C1 with 6.5.3 and a C2 with 9.2.2), and on webOS 5, 7, 8 and 10 once switched on under **Server** → **Advanced** → **Experimental features**: see [Experimental features](../experimental.md#input-bar). webOS 11's remote keys are LG's own, and cannot hand the bar the further presses, so it is not offered there.

**The Input key opens** offers preview cards choosing between **LG's list** and **Glasshouse Input bar** for the remote's Input key. It is the same setting as the Input key's under [Remote keys](remote.md#remote-keys), where any other key can be set to the bar too.

## Your inputs

The inputs [Glasshouse Input bar](#glasshouse-input-bar) and Glasshouse launchers offer, shown when Glasshouse Input bar or a Glasshouse launcher ([Glasshouse Home](home.md), [Glasshouse Bar](home.md#glasshouse-bar), [Glasshouse Minimal](home.md#glasshouse-minimal), or [Custom](home.md#custom-launcher)) is in use. Each input appears as a card with its device icon, editable HDMI name (click the name to rename it across Glasshouse, or clear it to put the TV's own name back), port, and connection state (tuner inputs omit the connection state), alongside **Order** (**Your order** or **Last opened**), **Hide inputs with nothing connected**, `←` / `→` buttons to reorder them, and **Shown** or **Hidden** for each input.

## No Signal screen

Preview cards choose between **LG's screen**, **Just “No Signal”**, which leaves the animated picture and the line of advice off LG's No Signal screen so only the words “No Signal” drift over the screen, and **Disconnected cable**, which hides the “No Signal” text too and draws a subtle disconnected cable icon in its place. LG's other messages there, such as a scrambled channel, are unchanged. Switching between them takes effect at once on an input with nothing coming in, and otherwise the next time no input is on screen, such as at the Home screen: the TV's input app has to restart to pick it up, which would blank an input's picture for a moment. Offered where the TV's No Signal screen is one Glasshouse knows: tried on a B8 (webOS 4.4.3) and a C2 (webOS 9.2.2). It is kept across restarts. On the TV app both options are in the Screen saver section.
