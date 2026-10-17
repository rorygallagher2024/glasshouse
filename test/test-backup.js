/**
 * test/test-backup.js - A backup of the TV's settings, and restoring it
 */

var assert = require('assert');
var backup = require('../server/lib/backup');

console.log('Running test-backup.js ...');

// Rows as lgsettings.collect gives them on a TV, and what set was asked.
function fakeLg(rows) {
  var sets = [];
  return {
    sets: sets,
    collect: function (sections, cb) {
      assert.deepEqual(sections, ['promotions', 'sound', 'devices', 'hdmi'], 'no game settings');
      cb({ ok: true, rows: rows });
    },
    set: function (id, value, cb) {
      sets.push([id, value]);
      cb({ ok: id !== 'refuses' });
    }
  };
}

var C4_ROWS = [
  { id: 'homePromotion', section: 'promotions', type: 'switch', on: false },
  { id: 'soundMode', section: 'sound', type: 'choice', value: 'standard',
    choices: [{ value: 'standard' }, { value: 'cinema' }, { value: 'aiSoundPro' }] },
  { id: 'avSync', section: 'sound', type: 'number', value: 0, min: -5, max: 15 },
  { id: 'deepColor2', section: 'hdmi', type: 'switch', on: false, active: false }
];

var CONFIG = {
  port: 8080, host: '::', token: 'secret', allowControl: true, allowPower: true,
  allowNetworkDebugger: false, allowTileHiding: false,
  mqtt: { enabled: true, host: 'nas', topicPrefix: 'lgtv', password: 'pw' },
  device: { id: 'lg_tv', name: 'Living room', model: 'OLED65C43LA' },
  logging: { level: 'info' },
  syslog: { server: 'nas', port: 514, hostname: 'c4', sources: ['system'], redact: true },
  ntp: { server: '192.168.8.1', port: 123 },
  history: { enabled: true },
  prometheus: { enabled: true },
  update: { check: false, intervalHours: 24 }
};

// The list of apps to install is kept here, not in /var/lib/tvweb.
var PENDING = require('path').join(require('os').tmpdir(), 'gh-restore-apps-early-' + process.pid + '.json');

// 1. What a backup holds
(function () {
  backup.init({ lgSettings: fakeLg(C4_ROWS), config: CONFIG, pendingFile: PENDING, about: function () { return { model: 'OLED65C43LA', version: '0.95.0' }; } });
  backup.create(function (b) {
    assert.strictEqual(b.format, 'glasshouse-backup');
    assert.strictEqual(b.version, 1);
    assert.deepEqual(b.from, { model: 'OLED65C43LA', glasshouse: '0.95.0' });
    assert.deepEqual(b.lg, { homePromotion: false, soundMode: 'standard', avSync: 0, deepColor2: false });
    assert.deepEqual(b.glasshouse, {
      logging: { level: 'info' },
      syslog: { server: 'nas', port: 514, sources: ['system'], redact: true },
      ntp: { server: '192.168.8.1', port: 123 },
      history: { enabled: true },
      prometheus: { enabled: true },
      update: { check: false }
    }, 'no access, MQTT, device or experimental settings, and no syslog hostname');
    var text = JSON.stringify(b);
    assert.strictEqual(text.indexOf('secret'), -1, 'no token');
    assert.strictEqual(text.indexOf('pw'), -1, 'no MQTT password');
    console.log('  ✓ a backup holds LG\'s known settings and the Glasshouse settings that suit any TV');
  });
})();

// 2. Restoring onto another TV
(function () {
  var lg = fakeLg(C4_ROWS.concat([{ id: 'refuses', section: 'devices', type: 'switch', on: false }]));
  var config = JSON.parse(JSON.stringify(CONFIG));
  var written = null;
  backup.init({ lgSettings: lg, config: config, writeSettings: function (patch, cb) { written = patch; cb(null); } });
  backup.restore({
    format: 'glasshouse-backup', version: 1,
    lg: {
      homePromotion: false,      // already so
      soundMode: 'cinema',       // offered here
      avSync: 40,                // out of this TV's range
      deepColor2: true,          // greyed out now
      eArc: true,                // not on this TV
      refuses: true              // the TV refuses
    },
    glasshouse: {
      ntp: { server: '192.168.8.2', port: 123 },
      history: { enabled: true },
      prometheus: { enabled: 'yes' },
      token: 'other', port: 9999, allowControl: false, host: '0.0.0.0',
      mqtt: { topicPrefix: 'lgtv' }, allowNetworkDebugger: true
    }
  }, function (r) {
    assert.strictEqual(r.ok, true);
    assert.deepEqual(lg.sets, [['soundMode', 'cinema'], ['refuses', true]]);
    assert.deepEqual(r.lg.applied, ['soundMode']);
    assert.strictEqual(r.lg.unchanged, 1);
    assert.deepEqual(r.lg.skipped, [
      { id: 'avSync', reason: 'value' }, { id: 'deepColor2', reason: 'inactive' }, { id: 'eArc', reason: 'absent' }
    ]);
    assert.deepEqual(r.lg.failed, [{ id: 'refuses', error: 'refused' }]);
    assert.deepEqual(written, { ntp: { server: '192.168.8.2' } }, 'only an allowed setting that differs is written');
    assert.deepEqual(r.glasshouse, ['ntp.server']);
    assert.strictEqual(r.restart, true);
    console.log('  ✓ a restore sets what this TV has and offers, and says why it skipped the rest');
    console.log('  ✓ a backup cannot change who can reach or control the server');
  });
})();

// 3. Files that are not a backup this TV can take
(function () {
  var lg = fakeLg(C4_ROWS);
  backup.init({ lgSettings: lg, config: CONFIG });
  backup.restore({ hello: 1 }, function (r) { assert.strictEqual(r.ok, false); });
  backup.restore(null, function (r) { assert.strictEqual(r.ok, false); });
  backup.restore({ format: 'glasshouse-backup', version: 2, lg: { soundMode: 'cinema' } }, function (r) {
    assert.strictEqual(r.ok, false, 'from a newer Glasshouse');
  });
  assert.deepEqual(lg.sets, [], 'nothing set');
  backup.restore({ format: 'glasshouse-backup', version: 1, lg: { homePromotion: false } }, function (r) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.restart, false, 'nothing of Glasshouse\'s changed, so no restart');
  });
  console.log('  ✓ anything that is not a backup, or is from a newer Glasshouse, is refused and changes nothing');
})();

// A failed Home layout must not be reported as a complete backup restore.
(function () {
  backup.init({ lgSettings: fakeLg(C4_ROWS), config: CONFIG,
    home: { setLayout: function (layout, cb) { cb({ ok: false, error: 'Home is busy' }); } } });
  backup.restore({ format: 'glasshouse-backup', version: 1, home: { channels: ['one'] } }, function (r) {
    assert.strictEqual(r.ok, false);
    assert.ok(/Home is busy/.test(r.error));
    assert.strictEqual(r.home, false);
  });
})();

// 4. The developer apps: listed in a backup, offered to install on restore
(function () {
  var os = require('os'), path = require('path'), fs = require('fs');
  var pending = path.join(os.tmpdir(), 'gh-restore-apps-' + process.pid + '.json');
  var dev = '/media/developer/apps/usr/palm/applications/';
  function app(id, title, version, folder) { return { id: id, title: title, version: version, folderPath: folder || dev + id }; }
  var installed = [
    app('org.webosbrew.hbchannel', 'Homebrew Channel', '0.7.3'),
    app('com.tvweb.dashboard', 'Glasshouse', '1.0.0'),
    app('youtube.leanback.v4', 'YouTube AdFree', '0.5.3'),
    app('org.xbmc.kodi', 'Kodi', '21.90.901'),
    app('netflix', 'Netflix', '1.0', '/usr/palm/applications/netflix')
  ];
  function luna(uri, payload, cb) {
    assert.strictEqual(uri, 'com.webos.applicationManager/listApps');
    cb({ returnValue: true, apps: installed });
  }
  var catalog = { getCatalog: function (force, cb) {
    cb({ ok: true, apps: [{ id: 'youtube.leanback.v4' }, { id: 'org.xbmc.kodi' }, { id: 'com.example.piccap' }] });
  } };
  var keepApp = function (id) { return id !== 'org.webosbrew.hbchannel' && id !== 'com.tvweb.dashboard'; };
  backup.init({ lgSettings: fakeLg(C4_ROWS), config: CONFIG, luna: luna, repo: catalog, keepApp: keepApp, pendingFile: pending });

  backup.create(function (b) {
    assert.deepEqual(b.apps, [
      { id: 'org.xbmc.kodi', title: 'Kodi', version: '21.90.901' },
      { id: 'youtube.leanback.v4', title: 'YouTube AdFree', version: '0.5.3' }
    ], 'developer apps only, without the Homebrew Channel and Glasshouse');
  });

  // Onto a TV that has Kodi but neither YouTube AdFree nor the sideloaded tool.
  installed = installed.filter(function (a) { return a.id !== 'youtube.leanback.v4'; });
  backup.restore({
    format: 'glasshouse-backup', version: 1, lg: {},
    apps: [
      { id: 'org.xbmc.kodi', title: 'Kodi' },
      { id: 'youtube.leanback.v4', title: 'YouTube AdFree' },
      { id: 'my.sideloaded.tool', title: 'My tool' },
      { id: 'org.webosbrew.hbchannel', title: 'Homebrew Channel' },
      { id: '../../etc', title: 'bad id' }
    ]
  }, function (r) {
    assert.deepEqual(r.apps, {
      toInstall: [{ id: 'youtube.leanback.v4', title: 'YouTube AdFree' }],
      manual: [{ id: 'my.sideloaded.tool', title: 'My tool' }],
      present: 1,
      catalogError: null
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(pending, 'utf8')).apps, [{ id: 'youtube.leanback.v4', title: 'YouTube AdFree' }],
      'kept for the Apps tab, across a restart');
    backup.pendingApps(function (list) {
      assert.deepEqual(list.map(function (a) { return a.id; }), ['youtube.leanback.v4']);
      installed.push(app('youtube.leanback.v4', 'YouTube AdFree', '0.5.3'));
      backup.pendingApps(function (after) {
        assert.deepEqual(after, [], 'an app installed since is no longer offered');
        backup.clearPendingApps();
        assert.ok(!fs.existsSync(pending));
        console.log('  ✓ a backup lists the developer apps, and a restore offers those missing from the catalog and names the rest');
        console.log('test-backup.js passed');
      });
    });
  });
})();
