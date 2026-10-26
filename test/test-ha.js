/**
 * test/test-ha.js - Unit tests for Home Assistant MQTT discovery payloads and filtering
 */

var assert = require('assert');
var ha = require('../server/lib/ha');

console.log('Running test-ha.js ...');

// 1. Categories and catalog integrity
(function testCategoriesIntegrity() {
  assert.strictEqual(Array.isArray(ha.HA_CATEGORIES), true);
  assert.strictEqual(ha.HA_CATEGORIES.length >= 4, true);

  var catMap = {};
  ha.HA_CATEGORIES.forEach(function (c) {
    assert.strictEqual(typeof c.id, 'string');
    assert.strictEqual(typeof c.name, 'string');
    assert.strictEqual(typeof c.desc, 'string');
    catMap[c.id] = true;
  });

  // Core categories exist
  assert.strictEqual(catMap.controls, true);
  assert.strictEqual(catMap.system, true);
  assert.strictEqual(catMap.oled, true);
  assert.strictEqual(catMap.video, true);
  assert.strictEqual(catMap.diagnostics, true);

  // Every entity in HA_ENTITIES maps to a valid category
  ha.HA_ENTITIES.forEach(function (ent) {
    assert.strictEqual(!!catMap[ent.cat], true, 'Entity ' + ent.id + ' maps to unknown category: ' + ent.cat);
  });

  // ENTITY_CATEGORIES index matches known categories
  for (var key in ha.ENTITY_CATEGORIES) {
    var cat = ha.ENTITY_CATEGORIES[key];
    assert.strictEqual(!!catMap[cat], true, 'Category mapping ' + key + ' maps to unknown category: ' + cat);
  }

  console.log('  ✓ Category definitions and entity catalogue are valid');
})();

// 2. buildEntities schema and structure
(function testBuildEntities() {
  var baseEntities = ha.buildEntities({
    pfx: 'home/tv',
    allowPower: false,
    installedApps: [
      { id: 'youtube', title: 'YouTube' },
      { id: 'netflix', title: 'Netflix' }
    ],
    pictureModes: [
      { value: 'cinema', label: 'Cinema' },
      { value: 'game', label: 'Game' }
    ]
  });

  assert.strictEqual(Array.isArray(baseEntities), true);
  assert.strictEqual(baseEntities.length > 50, true, 'Should build over 50 entities');

  var seenIds = {};
  baseEntities.forEach(function (e) {
    assert.strictEqual(typeof e.type, 'string', 'Entity type must be string: ' + JSON.stringify(e));
    assert.strictEqual(typeof e.id, 'string', 'Entity id must be string: ' + JSON.stringify(e));
    assert.strictEqual(typeof e.payload, 'object', 'Entity payload must be object: ' + e.id);
    assert.strictEqual(typeof e.payload.name, 'string', 'Entity name must be string: ' + e.id);

    var fullKey = e.type + '.' + e.id;
    assert.strictEqual(!seenIds[fullKey], true, 'Duplicate entity type.id: ' + fullKey);
    seenIds[fullKey] = true;

    // Verify entity category resolves
    var cat = ha.entityCategory(e);
    assert.strictEqual(typeof cat, 'string');
  });

  // Without allowPower, power control buttons must NOT be present
  assert.strictEqual(!seenIds['button.restart'], true);
  assert.strictEqual(!seenIds['button.power_off'], true);
  assert.strictEqual(!seenIds['button.power_on'], true);

  // With allowPower, power control buttons MUST be present
  var powerEntities = ha.buildEntities({
    pfx: 'home/tv',
    allowPower: true
  });
  var powerSeen = {};
  powerEntities.forEach(function (e) { powerSeen[e.type + '.' + e.id] = true; });
  assert.strictEqual(powerSeen['button.restart'], true);
  assert.strictEqual(powerSeen['button.power_off'], true);
  assert.strictEqual(powerSeen['button.power_on'], true);

  // Dynamic app select options
  var appEntity = null;
  baseEntities.forEach(function (e) { if (e.id === 'app') appEntity = e; });
  assert.strictEqual(!!appEntity, true);
  assert.strictEqual(Array.isArray(appEntity.payload.options), true);
  assert.strictEqual(appEntity.payload.options.indexOf('YouTube') !== -1, true);
  assert.strictEqual(appEntity.payload.options.indexOf('Netflix') !== -1, true);

  // Dynamic picture mode select options
  var picEntity = null;
  baseEntities.forEach(function (e) { if (e.id === 'picture_mode') picEntity = e; });
  assert.strictEqual(!!picEntity, true);
  assert.strictEqual(Array.isArray(picEntity.payload.options), true);
  assert.strictEqual(picEntity.payload.options.indexOf('Cinema') !== -1, true);
  assert.strictEqual(picEntity.payload.options.indexOf('Game') !== -1, true);

  // TV Speaker + Bluetooth's surround variant adds no option, and
  // the option sets the setting's key.
  var outEntity = null;
  baseEntities.forEach(function (e) { if (e.id === 'sound_output') outEntity = e; });
  var btOptions = outEntity.payload.options.filter(function (o) { return o === 'TV Speaker + Bluetooth'; });
  assert.strictEqual(btOptions.length, 1);
  assert.ok(outEntity.payload.command_template.indexOf('"TV Speaker + Bluetooth":"tv_speaker_bluetooth"') !== -1);

  console.log('  ✓ buildEntities generates unique, valid Home Assistant entities and dynamic options');
})();

// 3. filterWithholds capability filtering (OLED vs LCD, sensors, user configs)
(function testFilterWithholds() {
  function getEntities() {
    return ha.buildEntities({ pfx: 'test/tv', allowPower: true });
  }

  // OLED set
  var oledList = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: true,
      hasMediaState: true,
      hasHdrStatus: true,
      socArch: 'aarch64',
      thermalPresent: true,
      emmcWearPresent: true,
      hasLightSensor: true,
      updateCheck: true,
      hasGpuClock: true,
      hasSoundFormat: true
    }
  });
  var oledIds = {};
  oledList.forEach(function (e) { oledIds[e.id] = true; });
  assert.strictEqual(oledIds.sound_format, true, 'a TV that reports its sound format gets the sensor');
  assert.strictEqual(oledIds.oled_screen_shift, true, 'OLED must retain oled_screen_shift');
  assert.strictEqual(oledIds.oled_logo_dimming, true, 'OLED must retain oled_logo_dimming');
  assert.strictEqual(oledIds.pixel_refresher_schedule, true, 'OLED must retain pixel_refresher_schedule');
  assert.strictEqual(!oledIds.panel_dimming, true, 'OLED must withhold panel_dimming');

  // LCD set (non-OLED)
  var lcdList = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: false,
      hasMediaState: true,
      hasHdrStatus: true,
      socArch: 'armv7l',
      thermalPresent: true,
      emmcWearPresent: true,
      hasLightSensor: true,
      updateCheck: true,
      hasGpuClock: true
    }
  });
  var lcdIds = {};
  lcdList.forEach(function (e) { lcdIds[e.id] = true; });
  assert.strictEqual(!lcdIds.sound_format, true, 'a TV that has not reported its sound format (webOS 4) does not');
  assert.strictEqual(!lcdIds.oled_screen_shift, true, 'LCD must withhold oled_screen_shift');
  assert.strictEqual(!lcdIds.oled_logo_dimming, true, 'LCD must withhold oled_logo_dimming');
  assert.strictEqual(!lcdIds.pixel_refresher_schedule, true, 'LCD must withhold pixel_refresher_schedule');
  assert.strictEqual(lcdIds.panel_dimming, true, 'LCD must retain panel_dimming');

  // Missing sensors
  var missingSensorsList = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: true,
      thermalPresent: false,
      hasLightSensor: false,
      hasGpuClock: false
    }
  });
  var msIds = {};
  missingSensorsList.forEach(function (e) { msIds[e.id] = true; });
  assert.strictEqual(!msIds.soc_temperature, true, 'thermalPresent:false withholds soc_temperature');
  assert.strictEqual(!msIds.ambient_light, true, 'hasLightSensor:false withholds ambient_light');
  assert.strictEqual(!msIds.gpu_clock, true, 'hasGpuClock:false withholds gpu_clock');
  assert.strictEqual(msIds.on_timer && msIds.off_timer, true, 'timers not yet read keeps both timer switches');

  // A TV with an On Timer and no Off Timer, once its settings have been read
  var timerIds = {};
  ha.filterWithholds(getEntities(), { capabilities: { isOled: true, hasOnTimer: true, hasOffTimer: false } })
    .forEach(function (e) { timerIds[e.id] = true; });
  assert.strictEqual(timerIds.on_timer, true, 'hasOnTimer:true keeps on_timer');
  assert.strictEqual(!timerIds.off_timer, true, 'hasOffTimer:false withholds off_timer');

  // User configuration withholding category or specific entity
  var userFiltered = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: true,
      userEntities: {
        controls: false,
        disabled: ['cpu_load']
      }
    }
  });
  var ufIds = {};
  userFiltered.forEach(function (e) { ufIds[e.id] = true; });
  assert.strictEqual(!ufIds.volume, true, 'controls:false withholds volume');
  assert.strictEqual(!ufIds.mute, true, 'controls:false withholds mute');
  assert.strictEqual(!ufIds.cpu_load, true, 'disabled cpu_load withholds cpu_load');
  assert.strictEqual(ufIds.memory_usage, true, 'other categories remain untouched');

  console.log('  ✓ filterWithholds properly respects panel capabilities, hardware sensors, and user preferences');
})();

// 4. Select state mapping and appNames
(function testMappingsAndAppNames() {
  // selectState template generation
  var tmpl = ha.selectState('value_json.sound.output', ['TV Speaker', 'HDMI ARC']);
  assert.strictEqual(tmpl, "{{ (value_json.sound.output) if (value_json.sound.output) in ['TV Speaker', 'HDMI ARC'] else 'None' }}");

  // Output mappings
  // appNames deduplication and collision resolution
  var apps = [
    { id: 'app.one', title: 'Media Player' },
    { id: 'app.two', title: 'Media Player' },
    { id: 'app.three', title: 'Browser' }
  ];
  var mapped = ha.appNames(apps);
  assert.strictEqual(mapped['app.three'], 'Browser');
  assert.notStrictEqual(mapped['app.one'], mapped['app.two'], 'Duplicate titles must be disambiguated');
  assert.strictEqual(mapped['app.one'].indexOf('Media Player') !== -1, true);
  assert.strictEqual(mapped['app.two'].indexOf('Media Player') !== -1, true);

  console.log('  ✓ selectState mappings and appNames collision handling function correctly');
})();

// LG's own settings: only the ones the TV has, niche ones disabled, selects
// with the TV's own options
(function testLgSettingEntities() {
  var ents = ha.buildEntities({ pfx: 'test/tv', lgRows: [
    { id: 'soundMode', type: 'choice', value: 'standard',
      choices: [{ value: 'standard', label: 'Standard' }, { value: 'movie', label: 'Cinema' }] },
    { id: 'audioBalance', type: 'number', value: 0, min: -50, max: 50 },
    { id: 'btSpeakerMode', type: 'switch', on: true }
  ] });
  var by = {};
  ents.forEach(function (e) { by[e.id] = e; });
  assert.ok(by.sound_mode && by.balance && by.bluetooth_speaker_mode);
  assert.strictEqual(by.game_genre, undefined, 'a setting the TV lacks is not published');
  assert.deepEqual(by.sound_mode.payload.options, ['Standard', 'Cinema']);
  assert.strictEqual(by.sound_mode.payload.command_topic, 'test/tv/command/lgs/soundMode');
  assert.strictEqual(by.sound_mode.payload.enabled_by_default, undefined);
  assert.strictEqual(by.balance.payload.enabled_by_default, false);
  assert.strictEqual(by.balance.payload.entity_category, 'config');
  assert.strictEqual(by.balance.payload.min, -50);
  // A retained message from before the settings were published has no lgs.
  assert.ok(by.bluetooth_speaker_mode.payload.value_template.indexOf("(value_json.get('lgs') or {})") !== -1);
  var none = ha.buildEntities({ pfx: 'test/tv' }).filter(function (e) { return e.id === 'sound_mode'; });
  assert.strictEqual(none.length, 0);
  console.log('  ✓ LG settings become entities only where the TV has them');
})();

// The blocker's switch turns on the tier that leaves the app store and
// updates working, and reads on for either tier
(function testAdBlocker() {
  var ab = ha.buildEntities({ pfx: 'test/tv' }).filter(function (e) { return e.id === 'ad_blocker'; })[0];
  assert.strictEqual(ab.payload.command_topic, 'test/tv/command/adblock');
  assert.strictEqual(ab.payload.payload_on, 'ads');
  assert.strictEqual(ab.payload.payload_off, 'off');
  assert.strictEqual(ab.payload.state_on, 'ON', 'the state is compared with ON, not with what is sent');
  console.log('  ✓ the ad blocker switch turns on Ads & telemetry, not Everything');
})();

// Every discovery config has one form of availability: Home Assistant
// rejects a config with an availability list and availability_topic together,
// which left volume, mute and the volume buttons uncreated (#437)
(function testAvailabilityOneForm() {
  var all = ha.buildEntities({ pfx: 'test/tv', allowPower: true, isOled: true });
  all.forEach(function (e) { ha.withAvailability(e, 'test/tv/status'); });
  all.forEach(function (e) {
    var c = e.payload;
    assert.ok(!(c.availability && c.availability_topic), e.id + ' has both forms of availability');
  });
  var byId = {};
  all.forEach(function (e) { byId[e.id] = e.payload; });
  ['volume', 'mute', 'volume_up', 'volume_down'].forEach(function (id) {
    var a = byId[id].availability;
    assert.strictEqual(a.length, 2, id + ': the status check and its own, once each');
    assert.strictEqual(a[0].topic, 'test/tv/status');
    assert.strictEqual(a[1].topic, 'test/tv/telemetry');
    assert.strictEqual(byId[id].availability_mode, 'all');
  });
  assert.strictEqual(byId.input_source.availability_topic, 'test/tv/status', 'the rest keep the flat form');
  assert.strictEqual(byId.input_source.payload_available, 'online');
  console.log('  ✓ no discovery config has both forms of availability, and volume needs both checks');
})();

// PicCap's switch, only while PicCap answers
(function testPiccap() {
  var on = ha.buildEntities({ pfx: 'test/tv', piccap: true }).filter(function (e) { return e.id === 'piccap'; });
  assert.strictEqual(on.length, 1);
  assert.strictEqual(on[0].type, 'switch');
  assert.strictEqual(on[0].payload.command_topic, 'test/tv/command/piccap/power');
  assert.strictEqual(on[0].payload.state_topic, 'test/tv/state/piccap/power');
  assert.strictEqual(on[0].payload.payload_on, 'ON');
  assert.ok(ha.HA_ENTITIES.some(function (e) { return e.id === 'piccap' && e.cat === 'controls'; }), 'listed under Controls & Media, so it can be switched off');
  var kept = ha.filterWithholds(on, { capabilities: { hasRemoteInfo: true, hasPnwash: true, hasCell: true, hasHdmiProc: true, userEntities: { diagnostics: false } } });
  assert.strictEqual(kept.length, 1, 'filed under Controls, not Diagnostics');
  assert.strictEqual(ha.buildEntities({ pfx: 'test/tv' }).filter(function (e) { return e.id === 'piccap'; }).length, 0);
  console.log('  ✓ PicCap Capture is a switch only while PicCap answers');
})();

// OLED Light as a slider, and the remote's D-pad as buttons
(function testBacklightAndRemote() {
  var by = {};
  ha.buildEntities({ pfx: 'test/tv', isOled: true }).forEach(function (e) { by[e.type + '.' + e.id] = e; });
  var light = by['number.oled_light'];
  assert.ok(light && !by['sensor.oled_light'], 'a number, no longer a sensor');
  assert.strictEqual(light.payload.name, 'OLED Light');
  assert.strictEqual(light.payload.command_topic, 'test/tv/command/backlight');
  assert.strictEqual(light.payload.state_topic, 'test/tv/state/picture/backlight', 'the live topic, not telemetry');
  assert.strictEqual(light.payload.min, 0);
  assert.strictEqual(light.payload.max, 100);
  assert.ok(ha.RETIRED_ENTITIES.some(function (r) { return r.type === 'sensor' && r.id === 'oled_light'; }), 'the old sensor is cleared');
  var lcd = ha.buildEntities({ pfx: 'test/tv', isOled: false }).filter(function (e) { return e.id === 'oled_light'; })[0];
  assert.strictEqual(lcd.payload.name, 'Backlight', 'named as LG names it on an LCD');
  ['up', 'down', 'left', 'right', 'ok', 'back', 'home'].forEach(function (k) {
    var b = by['button.remote_' + k];
    assert.ok(b, k);
    assert.strictEqual(b.payload.command_topic, 'test/tv/command/rcu');
    assert.strictEqual(b.payload.payload_press, k);
    assert.ok(ha.HA_ENTITIES.some(function (e) { return e.id === 'remote_' + k && e.cat === 'controls'; }));
  });
  [['rewind', 'rewind', 'mdi:rewind'], ['fast_forward', 'fastForward', 'mdi:fast-forward']].forEach(function (m) {
    var b = by['button.' + m[0]];
    assert.ok(b, m[0]);
    assert.strictEqual(b.payload.command_topic, 'test/tv/command/playback');
    assert.strictEqual(b.payload.payload_press, m[1]);
    assert.strictEqual(b.payload.icon, m[2]);
    assert.ok(require('../server/lib/controls').RCU_KEY_CODES[m[1]], 'controls knows ' + m[1]);
    assert.ok(ha.HA_ENTITIES.some(function (e) { return e.id === m[0] && e.type === 'button' && e.cat === 'controls'; }));
  });
  console.log('  ✓ OLED Light is a slider on the live topic, and the D-pad, Back, Home, Rewind and Fast Forward are buttons');
})();

// LG's PHY error count is no longer published, and Home Assistant is told to
// drop the entity it had
(function testNoHdmiErrorCount() {
  var ents = ha.buildEntities({ pfx: 'test/tv' });
  assert.ok(!ents.some(function (e) { return e.id === 'hdmi_cable_errors'; }));
  assert.ok(ha.RETIRED_ENTITIES.some(function (r) { return r.type === 'sensor' && r.id === 'hdmi_cable_errors'; }));
  console.log('  ✓ the HDMI error count is retired');
})();

// defaultEntityId provides valid Home Assistant entity IDs, slugifying device IDs
(function testDefaultEntityId() {
  assert.strictEqual(ha.defaultEntityId('switch', 'lg_c9', 'mute'), 'switch.lg_c9_mute');
  assert.strictEqual(ha.defaultEntityId('sensor', 'lg_b8_tv', 'soc_temperature'), 'sensor.lg_b8_tv_soc_temperature');
  // Hyphens, uppercase, and spaces are sanitized to underscores
  assert.strictEqual(ha.defaultEntityId('switch', 'LG-C9', 'on_timer'), 'switch.lg_c9_on_timer');
  assert.strictEqual(ha.defaultEntityId('sensor', 'Living Room TV', 'active_app'), 'sensor.living_room_tv_active_app');
  var activeApp = ha.buildEntities({ pfx: 'test/tv' }).filter(function (e) { return e.id === 'active_app'; })[0];
  assert.strictEqual(activeApp.payload.json_attributes_topic, 'test/tv/state/application/remote', 'routing arrives without waiting for telemetry');
  assert.strictEqual(activeApp.payload.json_attributes_template, '{{ value_json | tojson }}');
  var launch = ha.buildEntities({ pfx: 'test/tv', installedApps: [{ id: 'netflix', title: 'Netflix' }, { id: 'com.example.player', title: 'Example Player' }] })
    .filter(function (e) { return e.id === 'app'; })[0];
  var ids = JSON.parse(launch.payload.json_attributes_template.replace(/^\{\{ | \| tojson \}\}$/g, '')).app_ids;
  assert.strictEqual(ids['Example Player'], 'com.example.player', 'each launchable title carries its app id');
  assert.strictEqual(ids.Netflix, 'netflix');
  assert.strictEqual(ids.Settings, 'com.palm.app.settings', 'LG Settings is launchable from the select');
  assert.ok(launch.payload.options.indexOf('Settings') >= 0);
  assert.strictEqual(ha.defaultEntityId('button', '__LG_TV__', 'restart'), 'button.lg_tv_restart');
  // Empty or missing device id produces domain.item_id
  assert.strictEqual(ha.defaultEntityId('number', '', 'volume'), 'number.volume');
  assert.strictEqual(ha.defaultEntityId('select', null, 'sound_output'), 'select.sound_output');
  console.log('  ✓ defaultEntityId generates valid, sanitized Home Assistant entity IDs');
})();

// The Launch App select's icons and colours, for a launcher showing tiles
(function testLaunchAppIconsAndColors() {
  function launchAttrs(opts) {
    opts.pfx = 'test/tv';
    var launch = ha.buildEntities(opts).filter(function (e) { return e.id === 'app'; })[0];
    var tpl = launch.payload.json_attributes_template;
    assert.ok(/^\{\{ \{.*\} \| tojson \}\}$/.test(tpl), 'a dict literal piped through tojson');
    return JSON.parse(tpl.replace(/^\{\{ | \| tojson \}\}$/g, ''));
  }
  var apps = [
    { id: 'netflix', title: 'Netflix', iconColor: '#E50914' },
    { id: 'youtube.leanback.v4', title: 'YouTube', iconColor: '#fff' },
    { id: 'bad.colour', title: 'Bad', iconColor: 'red' },
    { id: 'no.colour', title: 'None' }
  ];

  var off = launchAttrs({ installedApps: apps });
  assert.strictEqual('app_icons' in off, false, 'no icons while the icon server is off or the address unknown');
  assert.ok(off.app_ids.Netflix, 'app_ids stays');

  var on = launchAttrs({ installedApps: apps, iconBaseUrl: 'http://192.168.1.131:8082/icons/' });
  assert.strictEqual(on.app_icons.netflix, 'http://192.168.1.131:8082/icons/netflix.png');
  assert.strictEqual(on.app_icons['youtube.leanback.v4'], 'http://192.168.1.131:8082/icons/youtube.leanback.v4.png');
  assert.strictEqual(on.app_icons['com.palm.app.settings'], 'http://192.168.1.131:8082/icons/com.palm.app.settings.png');
  console.log('  ✓ app_icons is published only with the icon server listening and the TV\'s address known');

  assert.deepEqual(on.app_colors, { netflix: '#e50914', 'youtube.leanback.v4': '#ffffff' });
  var plain = launchAttrs({ installedApps: [{ id: 'no.colour', title: 'None' }] });
  assert.strictEqual('app_colors' in plain, false, 'no app_colors when no app has a valid colour');
  console.log('  ✓ app_colors carries only valid hex colours, as #rrggbb');
})();

// A field missing from the telemetry is logged by Home Assistant each time a
// template reads it (#761), so every read goes through get().
(function testTemplatesReadSafely() {
  var ents = ha.buildEntities({ allowControl: true, allowPower: true, isOled: true,
    installedApps: [{ id: 'netflix', title: 'Netflix' }] });
  var unsafe = [];
  JSON.stringify(ents, function (k, v) {
    if (typeof v === 'string' && /template$/.test(k) && /value_json\.(?!get\()/.test(v)) unsafe.push(k + ': ' + v);
    return v;
  });
  assert.deepEqual(unsafe, [], 'a template reads value_json.<field> directly');
  assert.strictEqual(ha.safeFields('{{ value_json.a.b }}'), "{{ (value_json.get('a') or {}).get('b') }}");
  assert.strictEqual(ha.safeFields('{{ value_json.get("x") }}'), '{{ value_json.get("x") }}', 'get() is left');
  assert.strictEqual(ha.safeFields('{{ value_json.a.get("b") }}'), "{{ (value_json.get('a') or {}).get(\"b\") }}");
  var retired = ha.RETIRED_ENTITIES.map(function (e) { return e.type + '.' + e.id; });
  assert.ok(retired.indexOf('sensor.soc_current') !== -1 && retired.indexOf('binary_sensor.standby_stuck') !== -1);
  console.log('  ✓ every template reads telemetry fields with get(), and the removed SoC current and standby sensors are cleared');
})();

// Input Source names its HDMI inputs as the TV's settings do, as the Active
// App sensor shows them, and still sends the port's key
(function testInputSourceNames() {
  function inputSource(opts) {
    opts.pfx = 'test/tv';
    return ha.buildEntities(opts).filter(function (e) { return e.id === 'input_source'; })[0];
  }

  var plain = inputSource({});
  assert.deepEqual(plain.payload.options, ['HDMI 1', 'HDMI 2', 'HDMI 3', 'HDMI 4', 'Live TV']);
  assert.ok(plain.payload.command_template.indexOf('"HDMI 2":"hdmi2"') !== -1);

  var named = inputSource({ inputNames: {
    hdmi1: 'HDMI 1',              // the built-in name, not repeated as a title
    hdmi2: 'Apple TV',            // a name the TV's settings give it
    hdmi3: 'Apple TV',            // two inputs sharing one name stay distinct
    hdmi4: 'hdmi4'                // an id rather than a name is no name
  } });
  assert.deepEqual(named.payload.options, ['HDMI 1', 'Apple TV (HDMI2)', 'Apple TV (HDMI3)', 'HDMI 4', 'Live TV']);
  assert.ok(named.payload.command_template.indexOf('"Apple TV (HDMI2)":"hdmi2"') !== -1);
  assert.ok(named.payload.value_template.indexOf('"hdmi3":"Apple TV (HDMI3)"') !== -1);
  assert.deepEqual(ha.inputSourceNames({ hdmi2: 'Apple TV' }).hdmi2, 'Apple TV (HDMI2)');
  assert.deepEqual(ha.inputSourceNames({}).hdmi2, 'HDMI 2');
  console.log('  ✓ Input Source shows the names the TV gives its inputs, and sends the port key');
})();

console.log('ALL test-ha.js assertions passed!\n');

