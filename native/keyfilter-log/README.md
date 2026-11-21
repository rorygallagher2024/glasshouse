# Channel keys: a log line per key event

LG's first key filter on webOS 11, `handleKeyBlockByApp` in
`/usr/lib/libpreProcess.so`, takes the keys the system profile lists and shows
a "button not available" toast for them. While a channel key is set on the
Remote tab, `server/lib/guidepatch.js` mounts a copy of that library in which
the filter reads Glasshouse's list instead, and calls the code here in place
of the toast. It logs every event of channel up and down, pressed, repeated
every 50 ms while held, and released, as

```
LSM NL_INPUT_KEYFILTER_USE {"glasshouse_key":402,"ev":2}
```

which PmLogDaemon's whitelist passes to `/var/log/messages`, where the server
reads it. `lginput2` logs a channel press there too, but not reliably while the
key is held.

`channel-keys.s` is the source; `build.py` assembles it with clang and prints
the bytes guidepatch writes at 0x18858, and `build.py --check` compares them
with `CHANNEL_STUB` there. The addresses are those of one build of the
library, OLED48C54LA, webOS 11.2.0, firmware 43.21.77.
