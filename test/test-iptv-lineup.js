/*
 * The Internet TV lineup's rules (server/lib/iptv-lineup.js): sections,
 * numbering, favourites, renames and hidden groups, over published
 * documents made up here.
 */
var assert = require('assert');
var lineup = require('../server/lib/iptv-lineup');

console.log('Running test-iptv-lineup.js ...');

var PL = 'p0a1b2c3d', OTHER = 'p9f8e7d6c';

// A select job's published document: each group section's keys and the channels it found.
function added(groups) {
  var doc = { channels: {}, groups: {}, missing: [] };
  Object.keys(groups).forEach(function (sid) {
    doc.groups[sid] = groups[sid].map(function (k) { return k; });
    groups[sid].forEach(function (k) { doc.channels[k] = { name: 'Channel ' + k, group: 'G ' + sid }; });
  });
  return doc;
}

function ctxFor(sel, docs) {
  var ctx = {
    added: function (pl) { return docs[pl] || null; },
    hasPlaylist: function (pl) { return pl === PL || pl === OTHER; },
    selCurrent: function (pl) { return !!docs[pl]; },
    lineup: function () { return lineup.compute(sel, ctx); }
  };
  return ctx;
}

function test(name, fn) { fn(); console.log('  ✓ ' + name); }

test('a version 1 selection becomes one pick section, every channel a favourite', function () {
  var sel = lineup.normalise({ generation: 4, channels: [{ pl: PL, key: 'x1', name: 'One', group: 'G' }, { pl: PL, key: 'x2', name: 'Two', group: 'G' }] });
  assert.equal(sel.version, 2);
  assert.equal(sel.sections.length, 1);
  assert.equal(sel.sections[0].kind, 'pick');
  assert.deepEqual(sel.favourites.map(function (c) { return c.key; }), ['x1', 'x2']);
  assert.equal(sel.generation, 4);
});

test('numbers run through the sections; a start number already passed moves on and is flagged', function () {
  var sel = lineup.normalise({ version: 2, sections: [
    { id: 's00000001', kind: 'group', pl: PL, group: 'A', from: 0, except: [] },
    { id: 's00000002', kind: 'group', pl: PL, group: 'B', from: 401, except: [] },
    { id: 's00000003', kind: 'group', pl: PL, group: 'C', from: 402, except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000001: ['x1', 'x2'], s00000002: ['x3', 'x4'], s00000003: ['x5'] });
  var lu = lineup.compute(sel, ctxFor(sel, docs));
  assert.deepEqual(lu.channels.map(function (c) { return c.number; }), [1, 2, 401, 402, 403]);
  assert.equal(lu.sections[2].clash, true);
  assert.equal(lu.sections[1].end, 402);
});

test('a channel in two sections is numbered once, in the first', function () {
  var sel = lineup.normalise({ version: 2, sections: [
    { id: 's00000001', kind: 'pick', channels: [{ pl: PL, key: 'x3', name: 'Three' }] },
    { id: 's00000002', kind: 'group', pl: PL, group: 'B', except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000002: ['x3', 'x4'] });
  var lu = lineup.compute(sel, ctxFor(sel, docs));
  assert.deepEqual(lu.channels.map(function (c) { return c.id; }), [PL + ':x3', PL + ':x4']);
  assert.equal(lu.byId[PL + ':x3'].sid, 's00000001');
});

test('removing a channel a pick carries ahead of its group takes it out of both', function () {
  var sel = lineup.normalise({ version: 2, sections: [
    { id: 's00000001', kind: 'pick', channels: [{ pl: PL, key: 'x3' }] },
    { id: 's00000002', kind: 'group', pl: PL, group: 'B', except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000002: ['x3', 'x4'] });
  var ctx = ctxFor(sel, docs);
  assert.equal(lineup.apply(sel, { action: 'remove', ids: [PL + ':x3'] }, ctx).ok, true);
  var lu = lineup.compute(sel, ctx);
  assert.deepEqual(lu.channels.map(function (c) { return c.key; }), ['x4']);
  assert.equal(sel.sections.length, 1, 'the empty pick section goes');
  assert.deepEqual(sel.sections[0].except, ['x3']);
  // Added again, it comes back into its group rather than a pick.
  lineup.apply(sel, { action: 'add', channels: [{ pl: PL, key: 'x3', name: 'Three', group: 'B' }] }, ctx);
  assert.deepEqual(sel.sections[0].except, []);
  assert.equal(sel.sections.length, 1);
});

test('the row holds 60 favourites, and a channel must be in the lineup to be starred', function () {
  var keys = [];
  for (var i = 0; i < 61; i++) keys.push('x' + (100 + i));
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000001: keys });
  var ctx = ctxFor(sel, docs);
  for (i = 0; i < 60; i++) assert.equal(lineup.apply(sel, { action: 'star', id: PL + ':' + keys[i] }, ctx).ok, true);
  var r = lineup.apply(sel, { action: 'star', id: PL + ':' + keys[60] }, ctx);
  assert.deepEqual([r.ok, r.error], [false, 'full']);
  r = lineup.apply(sel, { action: 'star', id: OTHER + ':x1' }, ctx);
  assert.deepEqual([r.ok, r.error], [false, 'not-in-lineup']);
});

test('removing a section unstars its channels, unless another section carries them', function () {
  var sel = lineup.normalise({ version: 2, sections: [
    { id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] },
    { id: 's00000002', kind: 'pick', channels: [{ pl: PL, key: 'x1' }] }],
    favourites: [{ pl: PL, key: 'x1' }, { pl: PL, key: 'x2' }] });
  var docs = {};
  docs[PL] = added({ s00000001: ['x1', 'x2'] });
  var ctx = ctxFor(sel, docs);
  lineup.apply(sel, { action: 'remove-section', section: 's00000001' }, ctx);
  assert.deepEqual(sel.favourites.map(function (c) { return c.key; }), ['x1']);
});

test('a rename shows everywhere, and an empty name gives the provider’s back', function () {
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000001: ['x1'] });
  var ctx = ctxFor(sel, docs);
  lineup.apply(sel, { action: 'rename', id: PL + ':x1', name: '  BBC One London  ' }, ctx);
  var c = lineup.compute(sel, ctx).channels[0];
  assert.deepEqual([c.name, c.provName, c.renamed], ['BBC One London', 'Channel x1', true]);
  lineup.apply(sel, { action: 'rename', id: PL + ':x1', name: '' }, ctx);
  assert.equal(lineup.compute(sel, ctx).channels[0].name, 'Channel x1');
});

test('the lineup stops at 2,000 channels and says it was cut', function () {
  var keys = [];
  for (var i = 0; i < 2100; i++) keys.push('x' + (1000 + i));
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000001: keys });
  var lu = lineup.compute(sel, ctxFor(sel, docs));
  assert.equal(lu.channels.length, 2000);
  assert.equal(lu.cut, true);
});

test('a moved key follows into picks, favourites and names', function () {
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'pick', channels: [{ pl: PL, key: 'm1' }] }],
    favourites: [{ pl: PL, key: 'm1' }], names: { 'p0a1b2c3d:m1': 'Mine' } });
  assert.equal(lineup.applyRematch(sel, PL, { m1: 'm9' }), true);
  assert.equal(sel.sections[0].channels[0].key, 'm9');
  assert.equal(sel.favourites[0].key, 'm9');
  assert.equal(sel.names[PL + ':m9'], 'Mine');
});

test('malformed entries are dropped, not the selection', function () {
  var sel = lineup.normalise({ version: 2, sections: [{ id: 'bad', kind: 'pick' }, { id: 's00000001', kind: 'group', pl: 'nope', group: 'A' },
    { id: 's00000002', kind: 'pick', channels: [{ pl: PL, key: 'x1' }, { pl: PL, key: '../x' }] }], names: { bad: 'x' } });
  assert.equal(sel.sections.length, 1);
  assert.equal(sel.sections[0].channels.length, 1);
  assert.deepEqual(sel.names, {});
});

test('several groups are added in one edit, in order, and several sections removed in one', function () {
  var sel = lineup.normalise({ version: 2, sections: [] });
  var ctx = ctxFor(sel, {});
  var r = lineup.apply(sel, { action: 'add-group', pl: PL, groups: ['A', 'B', 'C'] }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(sel.sections.map(function (s) { return s.group; }), ['A', 'B', 'C']);
  assert.equal(r.section, sel.sections[0].id);
  // Adding one already there brings back what was taken out of it, and adds no second section.
  sel.sections[1].except = ['x9'];
  lineup.apply(sel, { action: 'add-group', pl: PL, groups: ['B', 'D'] }, ctx);
  assert.deepEqual(sel.sections.map(function (s) { return s.group; }), ['A', 'B', 'C', 'D']);
  assert.deepEqual(sel.sections[1].except, []);
  lineup.apply(sel, { action: 'remove-section', sections: [sel.sections[0].id, sel.sections[2].id] }, ctx);
  assert.deepEqual(sel.sections.map(function (s) { return s.group; }), ['B', 'D']);
});

test('stars for several channels stop when the row is full, and say how many were starred', function () {
  var keys = [];
  for (var i = 0; i < 70; i++) keys.push('x' + (100 + i));
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] }] });
  var docs = {};
  docs[PL] = added({ s00000001: keys });
  var ctx = ctxFor(sel, docs);
  var r = lineup.apply(sel, { action: 'star', ids: keys.map(function (k) { return PL + ':' + k; }) }, ctx);
  assert.deepEqual([r.ok, r.starred, r.full], [true, 60, true]);
  r = lineup.apply(sel, { action: 'star', ids: [PL + ':x100', PL + ':x101'], on: false }, ctx);
  assert.equal(sel.favourites.length, 58);
});

test('channels moved into a new section leave their group, keep their stars, and are numbered there', function () {
  var sel = lineup.normalise({ version: 2, sections: [
    { id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] },
    { id: 's00000002', kind: 'pick', channels: [{ pl: PL, key: 'x9' }] }], favourites: [{ pl: PL, key: 'x2' }] });
  var docs = {};
  docs[PL] = added({ s00000001: ['x1', 'x2', 'x3'] });
  var ctx = ctxFor(sel, docs);
  var r = lineup.apply(sel, { action: 'move', ids: [PL + ':x2', PL + ':x9'], section: 'new', name: 'Mine', at: 0 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.composition, true);
  assert.equal(sel.sections.length, 2, 'the emptied pick section goes');
  assert.equal(sel.sections[0].name, 'Mine');
  assert.deepEqual(sel.sections[1].except, ['x2']);
  var lu = lineup.compute(sel, ctx);
  assert.deepEqual(lu.channels.map(function (c) { return c.key + '@' + c.number; }), ['x2@1', 'x9@2', 'x1@3', 'x3@4']);
  assert.equal(lu.byId[PL + ':x2'].fav, true);
  // Into a section that is not picked channels: refused.
  r = lineup.apply(sel, { action: 'move', ids: [PL + ':x1'], section: 's00000001' }, ctx);
  assert.deepEqual([r.ok, r.error], [false, 'section']);
});

test('channels can be added into a new section of their own, at the end', function () {
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'pick', channels: [{ pl: PL, key: 'x1' }] }] });
  var ctx = ctxFor(sel, {});
  var r = lineup.apply(sel, { action: 'add', section: 'new', name: 'Films', channels: [{ pl: PL, key: 'f1' }, { pl: PL, key: 'f2' }] }, ctx);
  assert.equal(r.ok, true);
  assert.equal(sel.sections.length, 2);
  assert.equal(sel.sections[1].name, 'Films');
  assert.equal(r.section, sel.sections[1].id);
  assert.deepEqual(sel.sections[1].channels.map(function (c) { return c.key; }), ['f1', 'f2']);
});

test('a channel taken out of its group and added to a section named goes there, staying out of the group', function () {
  var sel = lineup.normalise({ version: 2, sections: [{ id: 's00000001', kind: 'group', pl: PL, group: 'A', except: ['x2'] }] });
  var docs = {};
  docs[PL] = added({ s00000001: ['x1', 'x2'] });
  var ctx = ctxFor(sel, docs);
  var r = lineup.apply(sel, { action: 'add', section: 'new', name: 'Mine', channels: [{ pl: PL, key: 'x2' }] }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.section, sel.sections[1].id);
  assert.deepEqual(sel.sections[0].except, ['x2']);
  assert.deepEqual(sel.sections[1].channels.map(function (c) { return c.key; }), ['x2']);
  // With no section named, it goes back into its group as before.
  lineup.apply(sel, { action: 'remove', ids: [PL + ':x2'] }, ctx);
  lineup.apply(sel, { action: 'add', channels: [{ pl: PL, key: 'x2' }] }, ctx);
  assert.deepEqual(sel.sections[0].except, []);
});

test('one edit takes out whole sections and single channels together', function () {
  var sel = lineup.normalise({ version: 2, sections: [
    { id: 's00000001', kind: 'group', pl: PL, group: 'A', except: [] },
    { id: 's00000002', kind: 'pick', channels: [{ pl: PL, key: 'x7' }, { pl: PL, key: 'x8' }] }] });
  var docs = {};
  docs[PL] = added({ s00000001: ['x1', 'x2'] });
  var ctx = ctxFor(sel, docs);
  var r = lineup.apply(sel, { action: 'remove', ids: [PL + ':x7'], sections: ['s00000001'] }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(sel.sections.map(function (s) { return s.id; }), ['s00000002']);
  assert.deepEqual(sel.sections[0].channels.map(function (c) { return c.key; }), ['x8']);
});

test('a refused edit changes nothing, even part way through', function () {
  var sel = lineup.normalise({ version: 2, sections: [] });
  var ctx = ctxFor(sel, {});
  ctx.lineup = function () { return { channels: new Array(1999), byId: {} }; };
  var before = JSON.stringify(sel);
  var r = lineup.apply(sel, { action: 'add', channels: [{ pl: PL, key: 'a1' }, { pl: PL, key: 'a2' }] }, ctx);
  assert.deepEqual([r.ok, r.error], [false, 'lineup-full']);
  assert.equal(JSON.stringify(sel), before);
});

console.log('ALL test-iptv-lineup.js assertions passed!\n');
