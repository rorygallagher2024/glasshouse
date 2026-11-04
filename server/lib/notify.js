/*
 * server/lib/notify.js
 *
 * Strikt ES5, zoals de rest van Glasshouse (Node 0.12-compatibiliteit voor
 * webOS 4). Geschreven tegen de ECHTE server/lib/luna.js — call(uri, payload,
 * cb, appId) en callUrgent(...), beide zonder 'luna://'-prefix in uri (de
 * wrapper voegt die zelf toe), en met een al-geparste 'parsed'-callback in
 * plaats van ruwe stdout. Dit loopt vanzelf mee in hun PARALLEL=2-wachtrij
 * (server/lib/children.js), dus geen losse execFile-aanroepen meer nodig —
 * dat was de kernaanpassing t.o.v. de PoC-versie.
 */

var luna = require('./luna');
var fs = require('fs');
var path = require('path');

var NOTIFY_APP_ID = 'com.tvweb.notify';
var HEARTBEAT_INTERVAL_MS = 8000; // ruim onder de ~10-15s purge-drempel die op een echte TV is gemeten
var heartbeatTimer = null;

/**
 * Bevestigd via lasharor/cleanyourtv-WebOS issue #4 (webOS 5.6.2
 * compatibiliteitsrapport): SAM weigert 'topui' op webOS 5 t/m 24 met
 * "Unsupported Application Type", en accepteert daar 'overlay' voor.
 * Op webOS 25+ gebruikt CleanYourTV 'topui' (het lichtere venstertype).
 *
 * webosVersion: hergebruik de major-versie zoals telemetry.js die elders al
 * detecteert, niet opnieuw opvragen.
 */
function pickWindowType(webosVersion) {
  var major = parseInt(webosVersion, 10);
  if (isNaN(major)) return 'overlay'; // onbekende versie: breedst ondersteunde optie
  return major >= 25 ? 'topui' : 'overlay';
}

/**
 * Start de notify-overlay-app met de opgegeven parameters. Loopt via hun
 * bestaande luna.call(), dus automatisch binnen de PARALLEL-wachtrij.
 */
function showNotification(payload, callback) {
  var params = {
    title: String(payload.title || ''),
    text: String(payload.text || ''),
    image: String(payload.image || ''),
    seconds: parseInt(payload.seconds, 10) || 10,
    position: String(payload.position || 'top-right')
  };

  luna.call(
    'com.webos.applicationManager/launch',
    { id: NOTIFY_APP_ID, params: params },
    function (parsed, raw, timing) {
      if (callback) callback(parsed, raw, timing);
    }
  );
}

/**
 * Stille, onzichtbare launch — puur om de app wakker te houden. Dankzij
 * noSplashOnLaunch/spinnerOnLaunch in appinfo.json (bevestigd via
 * lasharor/cleanyourtv-WebOS PR #116/#131) geeft dit geen zichtbare
 * flikkering.
 */
function sendHeartbeat() {
  luna.call(
    'com.webos.applicationManager/launch',
    { id: NOTIFY_APP_ID, params: { silent: true } },
    function () {
      // Resultaat doet er niet toe — als de app niet (meer) draait, start
      // deze aanroep 'm gewoon weer op (stil), en de volgende heartbeat
      // houdt 'm daarna warm.
    }
  );
}

/** Idempotent: een tweede aanroep zonder stopHeartbeat() vervangt de timer. */
function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat(); // direct een eerste keer, niet pas na het eerste interval
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Sluit de notify-app daadwerkelijk af (procesmatig) — voor uninstall/reset,
 * niet voor normaal gebruik.
 */
function closeNotificationApp(callback) {
  luna.call(
    'com.webos.applicationManager/closeByAppId',
    { id: NOTIFY_APP_ID },
    function (parsed, raw, timing) {
      if (callback) callback(parsed, raw, timing);
    }
  );
}

/**
 * Parseert een binnenkomend MQTT-bericht op het notify command-topic.
 * Accepteert zowel kale tekst (compatibel met de bestaande
 * text.lg_tv_screen_notification-entiteit) als JSON met de volledige set.
 */
function handleCommandMessage(rawMessage) {
  var payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch (e) {
    payload = { title: '', text: rawMessage };
  }
  showNotification(payload);
}

/**
 * Discovery-fragment voor het notify-component. ONBEVESTIGD of ha.js dit als
 * los 'notify'-component toestaat naast bestaande entiteiten, of dat dit
 * eerst in hun buildEntities-logica moet worden toegevoegd — dat is het
 * enige overgebleven punt dat tegen de echte ha.js/mqtt.js geverifieerd moet
 * worden, net zoals we nu voor luna.js hebben gedaan.
 */
function buildDiscoveryFragment(deviceTopicPrefix) {
  return {
    notify: {
      tv_notify: {
        name: 'Notificatie',
        command_topic: deviceTopicPrefix + '/notify/set',
        command_template:
          '{"title":"{{ title | default(\'\') }}",' +
          '"text":"{{ message }}",' +
          '"image":"{{ data.image | default(\'\') }}",' +
          '"seconds":{{ data.seconds | default(10) }},' +
          '"position":"{{ data.position | default(\'top-right\') }}"}'
      }
    }
  };
}

/**
 * Kopieert het juiste appinfo.json-bestand (overlay- of topui-variant) naar
 * de uiteindelijke app-map, op basis van de gedetecteerde webOS-versie.
 * Eenmalig per TV, vanuit het installatie-/updatepad.
 */
function installAppinfo(appDir, webosVersion, callback) {
  var windowType = pickWindowType(webosVersion);
  var sourceFile = windowType === 'topui' ? 'appinfo.topui.json' : 'appinfo.overlay.json';
  var sourcePath = path.join(__dirname, '..', 'assets', 'notify-templates', sourceFile);
  var destPath = path.join(appDir, 'appinfo.json');

  fs.readFile(sourcePath, 'utf8', function (err, data) {
    if (err) { if (callback) callback(err); return; }
    fs.writeFile(destPath, data, function (writeErr) {
      if (callback) callback(writeErr, windowType);
    });
  });
}

module.exports = {
  showNotification: showNotification,
  closeNotificationApp: closeNotificationApp,
  startHeartbeat: startHeartbeat,
  stopHeartbeat: stopHeartbeat,
  handleCommandMessage: handleCommandMessage,
  buildDiscoveryFragment: buildDiscoveryFragment,
  pickWindowType: pickWindowType,
  installAppinfo: installAppinfo,
  NOTIFY_APP_ID: NOTIFY_APP_ID
};

/*
 * Aanhaken in server/tvweb.js (illustratief):
 *
 *   var notify = require('./lib/notify');
 *   notify.installAppinfo(appDir, webosMajorVersion, function (err) {
 *     if (!err) notify.startHeartbeat();
 *   });
 *   mqttClient.subscribe(topicPrefix + '/notify/set');
 *   mqttClient.on('message', function (topic, message) {
 *     if (topic === topicPrefix + '/notify/set') {
 *       notify.handleCommandMessage(message.toString());
 *     }
 *   });
 *
 * En in ha.js (buildEntities), het discoveryfragment van
 * notify.buildDiscoveryFragment() samenvoegen met de rest van de
 * device-discovery-payload — dit is het laatste onbevestigde punt.
 */
