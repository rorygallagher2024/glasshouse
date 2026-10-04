/*
 * The MQTT topics under the configured prefix (lgtv unless config says
 * otherwise). Home Assistant's discovery configs name these, so the bridge and
 * the entities must agree on every one.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */
function topics(pfx) {
  pfx = pfx || 'lgtv';
  return {
    status: pfx + '/status',
    telemetry: pfx + '/telemetry',
    update: pfx + '/update',
    commands: pfx + '/command/',   // what every command topic starts with
    command: function (name) { return pfx + '/command/' + name; },
    state: function (path) { return pfx + '/state/' + path; }
  };
}

module.exports = topics;
