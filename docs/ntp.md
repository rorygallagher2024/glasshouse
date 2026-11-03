# Network time (NTP)

Glasshouse can set the TV's clock from a time server on the local network, instead of leaving it to LG's time servers.

Most TVs don't need this. It is for a network that already runs its own time server: some routers do, as do many NAS boxes and home servers (chrony, ntpd, or the one built into a router's firmware). If none is set, the TV keeps setting its own clock from LG, as it always has.

## Why use it

The TV needs the right date for apps and streaming to work: with a wrong date, secure connections fail, and apps refuse to load or install.

The TV normally gets its time from LG's servers. The ad blocker's **Everything** setting blocks those servers, and only leaves them reachable for a while after a power cut so that the TV can set its clock. With a time server set here, the TV no longer needs LG's at all, and the clock is right from the first answer after Glasshouse starts.

## Setting it

On the [Server tab](dashboard/server.md), open **Advanced** and switch on **Set the clock from a time server**. Type the time server's address and press **Save**: a name such as `time.lan`, or an address such as `192.168.1.1`. A port other than the usual 123 goes after a colon, as in `time.lan:1123`.

The tab then shows whether the server answered:

* **On**, with when the clock was last set and last checked.
* **No answer**, with the reason. The TV keeps the time it has, and the server is asked again every 30 seconds.
* **Not taking the time**, with how far out the TV's clock still is. The server answered, but the TV kept its own time. It is tried again every hour.

Switching it off stops it and keeps the address, so switching it back on needs no retyping.

The same setting can be made in `/var/lib/tvweb/config.json` on the TV, followed by a restart of the server. `enabled` is optional, and on unless it is `false`:

```json
"ntp": { "server": "time.lan", "port": 123, "enabled": true }
```

## How it works

The server is asked when Glasshouse starts, every hour, and whenever the TV switches on. The TV's clock is only changed when it is out by a second or more, and the time is handed to the TV's own time service, so the TV treats it exactly as it treats LG's.

NTP is not encrypted or authenticated: anything that can answer in the server's place can set the TV's clock. Use a server on a network you trust. [Security](SECURITY.md) and [Internals](IMPLEMENTATION.md#setting-the-clock-from-ntp) have the details.
