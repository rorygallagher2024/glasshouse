# Keyboard

Sets what a USB keyboard's F-keys do. Each key appears as a tile, and selecting one opens its choices beneath the row, the same as a remote key.

**F1** to **F12** answer Fn+F1 to Fn+F12, which is how the keyboard sends the real F-keys. An assigned key is taken before LG's own handling, which is what makes it useful on keys LG otherwise answers: F2, F4, F5, F7 and F10 to F12 would open the inputs panel, Home or quick settings, launch LG Channels, or change the volume.

Ctrl combinations cannot be set. On a 43UR78006LK (webOS 10.3.2) the TV rewrites them before any key filter runs: Ctrl+F6 reaches the filter as Meta followed by the letter D, and Ctrl+F5 arrives as a single code of its own. The F-key never arrives, so there is nothing to assign.

The tab appears only where Glasshouse can take these keys: webOS 4 to 10, whose key filters are JavaScript. On webOS 11 the filters are native, so keyboard keys are not offered. The bare top row is not these keys: without Fn, F1 sends Browser Back and the rest send browser and media codes, which the TV renames before Glasshouse sees them, so they are left out.
