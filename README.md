# Glasshouse Notify Overlay — klaar om in te plakken

Alles hier is bevestigd tegen de echte broncode van `rorygallagher2024/glasshouse`
(`luna.js`, `ha.js`, `controls.js`, `tvweb.js`, `install-app.sh`), en werkend
getest op een LG TV (webOS 6.5.3).

## Twee manieren om dit toe te passen

### Optie A — Complete, al-gepatchte bestanden (makkelijkst)
In `server/lib-patched/` staan `controls.js` en `tvweb.js` al **volledig
met de wijzigingen erin verwerkt** — kopieer ze gewoon direct over de
originelen in je gecloonde repo:
```bash
cp server/lib-patched/controls.js <jouw-repo>/server/lib/controls.js
cp server/lib-patched/tvweb.js <jouw-repo>/server/tvweb.js
```

**Let op:** deze zijn gebaseerd op de versie van beide bestanden die in dit
gesprek is gedeeld. Als de repo intussen is bijgewerkt, zijn de originelen
niet meer identiek — in dat geval dus liever optie B gebruiken en handmatig
samenvoegen.

### Optie B — Patches handmatig toepassen
Zie `patches/controls.js.patch.md` en `patches/tvweb.js.patch.md` voor de
losse, uitgelegde wijzigingen om zelf in de (mogelijk nieuwere) actuele
bestanden door te voeren.

## Overige bestanden — altijd gewoon kopiëren
```bash
cp -r server/lib/notify.js <jouw-repo>/server/lib/
cp -r server/assets/notify-app <jouw-repo>/server/assets/
cp -r server/assets/notify-templates <jouw-repo>/server/assets/
```

## Resulterende structuur
```
server/
├── lib/
│   ├── controls.js                        ← gepatcht
│   └── notify.js                          ← nieuw
├── assets/
│   ├── notify-app/                        ← nieuw
│   │   ├── appinfo.json
│   │   ├── index.html
│   │   ├── packageinfo.json
│   │   └── assets/{icon80,icon130}.png
│   └── notify-templates/                  ← nieuw
│       ├── appinfo.overlay.json
│       └── appinfo.topui.json
└── tvweb.js                                ← gepatcht
```

## Daarna
```bash
sh tools/check.sh
```
En op je TV deployen/testen zoals je gewend bent.

## Wat nog verder getest moet worden
- De `appinfo.topui.json`-variant (webOS 25+) is nooit op een echte nieuwere TV getest
- De volledige integratie binnen hun draaiende server — alles hiervoor is als losse PoC getest, nooit samen binnen hun `tvweb.js`-proces
