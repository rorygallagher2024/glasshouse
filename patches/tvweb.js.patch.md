# Patch voor server/tvweb.js

## 1. Nieuwe require, bij de andere `var xModule = require('./lib/x');`-regels
```js
var notify = require('./lib/notify');
```

## 2. controls.init({...}) — één regel toevoegen aan het bestaande object
```js
controls.init({
  luna: luna,
  lunaUrgent: lunaTransport.callUrgent,
  piccap: piccap,
  huesync: huesync,
  // ... alle bestaande regels ongewijzigd ...
  notify: notify,   // <-- NIEUW
  keyboardVisible: function () { ... }
});
```

## 3. Installatie + heartbeat opstarten
BEVESTIGD tegen de echte `install-app.sh`: dat script is generiek (`SRC`
als tweede argument), kopieert letterlijk `appinfo.json`, `index.html`,
`assets/icon80.png` en `assets/icon130.png`, en verwacht ook een
`packageinfo.json` ernaast. Het kiest zelf GEEN `overlay`/`topui`-variant —
dat moet dus vooraf gebeuren, met `notify.installAppinfo()`, die de juiste
inhoud in `assets/notify-app/appinfo.json` zet vóórdat het script 'm inpakt.

```js
// Ergens bij de overige init-aanroepen, na telemetry.init() (nodig voor
// detectWebosVersion()) en vóór setupHomeAssistant() — de heartbeat hoeft
// niet op MQTT te wachten, in tegenstelling tot de discovery-entiteit:
if (!CLI_MODE) {
  var notifyAppDir = path.join(__dirname, 'assets', 'notify-app');
  notify.installAppinfo(notifyAppDir, telemetry.detectWebosVersion(), function (err) {
    if (err) {
      console.error('notify: could not prepare appinfo.json: ' + err.message);
      return;
    }
    tvApp('install', function (r) {
      if (r && r.ok) {
        notify.startHeartbeat();
      } else {
        console.error('notify: could not install the overlay app: ' + (r && r.error));
      }
    }, 'notify-app');
  });
}
```

**Bestandsstructuur, nu volledig bevestigd** — `assets/notify-app/` naast
`assets/home-app/` en `assets/dashboard-app/`, met:
- `appinfo.json` (wordt overschreven door `installAppinfo()`, dus de inhoud
  van `appinfo.overlay.json`/`appinfo.topui.json` als bronbestanden elders,
  bijv. in `server/assets/notify-templates/`)
- `index.html`
- `assets/icon80.png`, `assets/icon130.png`
- `packageinfo.json` — BEVESTIGD tegen het echte `assets/home-app/packageinfo.json`:
  `{"id", "version", "app" (= id), "vendor": "tvweb", "loc_name"}`. Zie de
  bijgewerkte `packageinfo.json` in deze PoC.

## 5. Bij uninstall (optioneel, nette opruiming)
In `checkHomebrewChannelApp()`'s uninstall-pad, waar Home en remote keys al
worden teruggedraaid, zou `notify.closeNotificationApp()` en het verwijderen
van de notify-app-map logisch aansluiten — niet strikt noodzakelijk voor een
eerste werkende versie.
