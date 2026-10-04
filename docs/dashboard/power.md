# Power and standby

## Staying connected while the TV is off

Switched off, an LG TV sleeps within a couple of minutes, and the dashboard and the Home Assistant bridge sleep with it. On TVs that have LG's Always-on setting, **Stay connected when off** keeps the TV on the network with the screen dark instead: the dashboard keeps answering, Home Assistant keeps its readings and controls, and either can switch the TV back on.

The cost is power. On an OLED42C24LA it draws 12.5 W while off, against almost nothing in normal standby.

It does not hold all night. For five hours every night, 01:00 to 06:00 unless changed, LG suspends Always-on, and a TV switched off during those hours sleeps fully. It is offline until they end or it is switched on: the dashboard does not answer, and Home Assistant shows it asleep. LG fixes the length at five hours; **Nightly power-down**, next to the switch, moves them to hours the TV is not used.

The switch is under **Advanced &rarr; Power** in the web dashboard and **System &rarr; Power** on the TV, and setup offers it as a third step. TVs without the setting, such as webOS 4 models, do not show it; Wake-on-LAN still wakes them from standby.

## Always Ready

On TVs that have LG's Always Ready, the **Always Ready** switch under **Advanced &rarr; Power** makes the TV show LG's Always Ready screen, such as a clock or artwork, when it is switched off with the remote, instead of going dark. It is close to being on: an OLED42C24LA draws 31 W showing the clock. The dashboard and Home Assistant show the TV as switched off while it is up. It takes effect the next time the TV is switched off. The first time, the TV asks for OK on the remote. Home turns the TV back on from the clock; the power button switches it fully off, as in LG's own menu.
