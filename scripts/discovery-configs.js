#!/usr/bin/env node
/*
 * Prints, as JSON, every Home Assistant discovery config the server can
 * publish, built as publishDiscovery in server/tvweb.js builds them, with
 * every optional entity in. check-ha-discovery.py runs them through Home
 * Assistant's own validation.
 *
 *   node scripts/discovery-configs.js [lg settings rows file]
 *
 * The rows default to test/fixtures/lgsettings-c2-webos22.json, as a C2 on
 * webOS 22 reports LG's settings.
 */
var fs = require('fs');
var path = require('path');
var ha = require('../server/lib/ha.js');

var rowsFile = process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'lgsettings-c2-webos22.json');
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
  ha.withAvailability(item, 'tv/status');
  return { type: item.type, id: item.id, conf: item.payload };
});
process.stdout.write(JSON.stringify(out) + '\n');
