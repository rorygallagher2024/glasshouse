# Patch voor server/lib/controls.js

## 1. Nieuwe require bovenaan, bij de andere module-vars
```js
/** @type {typeof import('./notify')} */
var notifyModule = null;
```

## 2. In init(opts), bij de andere `if (opts.x) xModule = opts.x;`-regels
```js
if (opts.notify) notifyModule = opts.notify;
```

## 3. De 'toast'-case zelf — ALLEEN dit blok vervangen
Oorspronkelijk:
```js
case 'toast':
  /* Both the payload's sourceId and luna-send's -a have to name an app the
     bus already knows; "tvweb" is rejected as an Unknown Source. */
  if (value && typeof value === 'object' && TOAST_TYPES.indexOf(value.type) === -1) {
    return cb({ ok: false, error: 'toast type must be one of ' + TOAST_TYPES.join(', ') });
  }
  var toast = toastParams(value);
  return luna('com.webos.notification/createToast', toast, function (r) {
    if (r && r.returnValue) return cb({ ok: true });
    if (!toast.type) return cb({ ok: false, error: r && r.errorText });
    console.log('toast: the TV refused a ' + toast.type + ' toast (' + ((r && r.errorText) || 'no answer') + '); sending it as a standard one');
    luna('com.webos.notification/createToast', { sourceId: toast.sourceId, message: toast.message },
         function (r2) { cb({ ok: !!(r2 && r2.returnValue), error: r2 && r2.errorText }); }, toastSourceId);
  }, toastSourceId);
```

Nieuw (alleen de eerste regels zijn toegevoegd, de rest is ongewijzigd):
```js
case 'toast':
  /*
   * Een object met image, seconds of position vraagt om meer dan de native
   * toast kan (geen positie-controle, zie webOS's createToast-documentatie) —
   * die route naar de losse overlay-app (notify.js) i.p.v. createToast.
   * Kale tekst of { type, text } (zonder die velden) blijft het bestaande,
   * onveranderde pad volgen, voor volledige achterwaartse compatibiliteit.
   */
  if (value && typeof value === 'object' &&
      (value.image || value.seconds !== undefined || value.position) &&
      notifyModule) {
    return notifyModule.showNotification(value, function (parsed) {
      cb({ ok: !!(parsed && parsed.returnValue), error: parsed && parsed.errorText });
    });
  }

  /* Both the payload's sourceId and luna-send's -a have to name an app the
     bus already knows; "tvweb" is rejected as an Unknown Source. */
  if (value && typeof value === 'object' && TOAST_TYPES.indexOf(value.type) === -1) {
    return cb({ ok: false, error: 'toast type must be one of ' + TOAST_TYPES.join(', ') });
  }
  var toast = toastParams(value);
  return luna('com.webos.notification/createToast', toast, function (r) {
    if (r && r.returnValue) return cb({ ok: true });
    if (!toast.type) return cb({ ok: false, error: r && r.errorText });
    console.log('toast: the TV refused a ' + toast.type + ' toast (' + ((r && r.errorText) || 'no answer') + '); sending it as a standard one');
    luna('com.webos.notification/createToast', { sourceId: toast.sourceId, message: toast.message },
         function (r2) { cb({ ok: !!(r2 && r2.returnValue), error: r2 && r2.errorText }); }, toastSourceId);
  }, toastSourceId);
```

## 4. In module.exports (optioneel, als notify elders ook direct nodig is)
Niet strikt noodzakelijk — notifyModule wordt alleen intern in doControl() gebruikt.
