#!/usr/bin/env node
/*
 * Prints, as JSON, every Home Assistant discovery config the server can
 * publish, built as publishDiscovery in server/tvweb.js builds them, with
 * every optional entity in. check-ha-discovery.py runs them through Home
 * Assistant's own validation.
 *
 *   node scripts/discovery-configs.js [--server <dir>] [lg settings rows file]
 *
 * The rows default to test/fixtures/lgsettings-c2-webos22.json, as a C2 on
 * webOS 22 reports LG's settings. --server builds from another copy of
 * server/, such as a release's, which check-entity-stability.py compares.
 */
var fs = require('fs');
var path = require('path');

var args = process.argv.slice(2);
var serverDir = path.join(__dirname, '..', 'server');
var at = args.indexOf('--server');
if (at !== -1) { serverDir = path.resolve(args[at + 1]); args.splice(at, 2); }
var ha = require(path.join(serverDir, 'lib', 'ha.js'));

var rowsFile = args[0] || path.join(__dirname, '..', 'test', 'fixtures', 'lgsettings-c2-webos22.json');
var lgRows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')).rows || [];

// No filterWithholds: it only removes entities, and every one is checked.
var entities = ha.buildEntities({
  pfx: 'tv', allowPower: true, isOled: true, piccap: true, updatesElsewhere: false,
  installedApps: [{ id: 'youtube.leanback.v4', title: 'YouTube' }],
  pictureModes: [{ value: 'hdrGame', label: 'HDR Game' }, { value: 'hdrVivid', label: 'HDR Vivid' }],
  lgRows: lgRows
});
var device = { identifiers: ['lg_tv'], name: 'LG webOS TV', model: 'webOS TV', manufacturer: 'LG', sw_version: 'webOS (tvweb)' };
var out = entities.map(function (item) {
  item.payload.unique_id = 'lg_tv_' + item.id;
  item.payload.device = device;
  // Releases before 0.79.1 set availability in tvweb.js instead.
  if (ha.withAvailability) ha.withAvailability(item, 'tv/status');
  return { type: item.type, id: item.id, conf: item.payload };
});
process.stdout.write(JSON.stringify(out) + '\n');
