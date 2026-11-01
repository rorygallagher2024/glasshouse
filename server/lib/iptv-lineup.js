/*
 * lib/iptv-lineup.js - the owner's Internet TV lineup: which of a
 * subscription's channels the TV carries, in what order and under what
 * numbers, and which of them make Home's row
 *
 * A subscription lists tens of thousands of channels; the lineup is the few
 * hundred the owner watches, built from sections, as a broadcaster's guide
 * is (101 Entertainment, 401 Sports):
 *   - a group section carries one of the provider's groups whole, and follows
 *     it as the provider adds and drops channels; channels taken out of it
 *     are kept in its except list;
 *   - a pick section carries channels chosen one by one, from any group or
 *     playlist, in the owner's order.
 * Channels are numbered through the sections in order; a section can start
 * at a number of its own. The favourites (at most 60) are Home's row. A
 * channel can be renamed, and a provider's groups hidden from browsing.
 *
 * selection.json, version 2:
 *   { version: 2, generation, sections: [...], favourites: [{ pl, key, name, group }],
 *     names: { 'pl:key': 'name' }, hidden: { pl: ['group', ...] } }
 * Version 1 ({ generation, channels }) becomes one pick section, every
 * channel a favourite: the row looks as it did.
 *
 * Pure functions over the selection: lib/iptv owns the file, the jobs and
 * what the worker published, and hands that in as ctx.
 *
 * Strict ES5: runs on node 0.12.
 */
var crypto = require('crypto');

var LIMITS = { favourites: 60, lineup: 2000, sections: 100, picks: 2000, name: 60, hidden: 4000, except: 4000, names: 4000 };
var KEY_RE = /^[a-z][0-9a-z]{1,24}$/;
var PL_RE = /^p[0-9a-f]{6,12}$/;
var SECTION_RE = /^s[0-9a-f]{8}$/;

function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

function str(v, max) {
  if (typeof v !== 'string') return '';
  v = v.replace(/^\s+|\s+$/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
  return v.length > max ? v.slice(0, max) : v;
}

function idOf(c) { return c.pl + ':' + c.key; }

function splitId(id) {
  if (typeof id !== 'string') return null;
  var i = id.indexOf(':');
  var pl = id.slice(0, i), key = id.slice(i + 1);
  return i > 0 && PL_RE.test(pl) && KEY_RE.test(key) ? { pl: pl, key: key } : null;
}

function channelRef(c) {
  if (!c || typeof c.pl !== 'string' || !PL_RE.test(c.pl) || typeof c.key !== 'string' || !KEY_RE.test(c.key)) return null;
  return { pl: c.pl, key: c.key, name: str(c.name, 200), group: str(c.group, 120) };
}

function newSectionId(sel) {
  for (;;) {
    var id = 's' + crypto.randomBytes(4).toString('hex');
    if (!sectionById(sel, id)) return id;
  }
}

function sectionById(sel, id) {
  for (var i = 0; i < sel.sections.length; i++) if (sel.sections[i].id === id) return sel.sections[i];
  return null;
}

function empty() { return { version: 2, generation: 0, sections: [], favourites: [], names: {}, hidden: {} }; }

// ---------------------------------------------------------------- reading

/*
 * A selection as read from disk, whatever its version, as one that holds to
 * the limits: anything malformed is dropped rather than refused, so a bad
 * edit by hand costs that entry, not the lineup.
 */
function normalise(raw) {
  var sel = empty();
  if (!raw || typeof raw !== 'object') return sel;
  sel.generation = typeof raw.generation === 'number' ? raw.generation : 0;
  if (raw.version !== 2) {
    // Version 1: the row's channels, in its order.
    var old = isArray(raw.channels) ? raw.channels.map(channelRef).filter(Boolean).slice(0, LIMITS.favourites) : [];
    if (old.length) {
      sel.sections.push({ id: 's' + crypto.createHash('sha1').update(JSON.stringify(old)).digest('hex').slice(0, 8),
        kind: 'pick', name: '', from: 0, channels: old });
      sel.favourites = old.map(function (c) { return { pl: c.pl, key: c.key, name: c.name, group: c.group }; });
    }
    return sel;
  }
  var seenSection = {}, seenPick = {}, picks = 0;
  (isArray(raw.sections) ? raw.sections : []).forEach(function (s) {
    if (!s || typeof s.id !== 'string' || !SECTION_RE.test(s.id) || seenSection[s.id] || sel.sections.length >= LIMITS.sections) return;
    var out = { id: s.id, kind: s.kind === 'group' ? 'group' : 'pick', name: str(s.name, LIMITS.name),
      from: typeof s.from === 'number' && s.from >= 0 && s.from <= 9999 ? Math.floor(s.from) : 0 };
    if (out.kind === 'group') {
      if (typeof s.pl !== 'string' || !PL_RE.test(s.pl) || typeof s.group !== 'string') return;
      out.pl = s.pl;
      out.group = s.group.slice(0, 120);
      out.except = (isArray(s.except) ? s.except : []).filter(function (k) { return typeof k === 'string' && KEY_RE.test(k); }).slice(0, LIMITS.except);
    } else {
      out.channels = [];
      (isArray(s.channels) ? s.channels : []).forEach(function (c) {
        var r = channelRef(c);
        if (!r || seenPick[idOf(r)] || picks >= LIMITS.picks) return;
        seenPick[idOf(r)] = true;
        picks++;
        out.channels.push(r);
      });
    }
    seenSection[s.id] = true;
    sel.sections.push(out);
  });
  var seenFav = {};
  (isArray(raw.favourites) ? raw.favourites : []).forEach(function (c) {
    var r = channelRef(c);
    if (!r || seenFav[idOf(r)] || sel.favourites.length >= LIMITS.favourites) return;
    seenFav[idOf(r)] = true;
    sel.favourites.push(r);
  });
  if (raw.names && typeof raw.names === 'object') {
    var n = 0;
    Object.keys(raw.names).forEach(function (id) {
      var name = str(raw.names[id], LIMITS.name);
      if (splitId(id) && name && n++ < LIMITS.names) sel.names[id] = name;
    });
  }
  if (raw.hidden && typeof raw.hidden === 'object') {
    Object.keys(raw.hidden).forEach(function (pl) {
      if (!PL_RE.test(pl) || !isArray(raw.hidden[pl])) return;
      var groups = raw.hidden[pl].filter(function (g) { return typeof g === 'string'; }).map(function (g) { return g.slice(0, 120); });
      if (groups.length) sel.hidden[pl] = groups.slice(0, LIMITS.hidden);
    });
  }
  return sel;
}

// ---------------------------------------------------------------- for the worker

/*
 * The channels the select job is to find in a playlist by key: the picks,
 * the favourites and the renamed ones. A refresh that moves a key (an M3U
 * entry whose token rotated) is followed for these; a group section's own
 * channels come from its group afresh each time.
 */
function trackedKeys(sel, pl) {
  var out = [], seen = {};
  function add(c) {
    if (c.pl !== pl || seen[c.key]) return;
    seen[c.key] = true;
    out.push({ key: c.key, name: c.name || '', group: c.group || '', epgId: '' });
  }
  sel.sections.forEach(function (s) { if (s.kind === 'pick') s.channels.forEach(add); });
  sel.favourites.forEach(add);
  Object.keys(sel.names).forEach(function (id) {
    var r = splitId(id);
    if (r && r.pl === pl && !seen[r.key]) { seen[r.key] = true; out.push({ key: r.key, name: '', group: '', epgId: '' }); }
  });
  return out;
}

function groupSectionsOf(sel, pl) {
  return sel.sections.filter(function (s) { return s.kind === 'group' && s.pl === pl; })
    .map(function (s) { return { id: s.id, group: s.group, except: s.except.slice() }; });
}

function usesPlaylist(sel, pl) {
  return sel.sections.some(function (s) {
    return s.kind === 'group' ? s.pl === pl : s.channels.some(function (c) { return c.pl === pl; });
  }) || sel.favourites.some(function (c) { return c.pl === pl; });
}

// Keys a refresh moved follow, everywhere the old one was named.
function applyRematch(sel, pl, moves) {
  var touched = false;
  function move(c) {
    if (c.pl === pl && moves.hasOwnProperty(c.key) && KEY_RE.test(moves[c.key])) { c.key = moves[c.key]; touched = true; }
  }
  sel.sections.forEach(function (s) { if (s.kind === 'pick') s.channels.forEach(move); });
  sel.favourites.forEach(move);
  Object.keys(sel.names).forEach(function (id) {
    var r = splitId(id);
    if (r && r.pl === pl && moves.hasOwnProperty(r.key) && KEY_RE.test(moves[r.key])) {
      sel.names[pl + ':' + moves[r.key]] = sel.names[id];
      delete sel.names[id];
      touched = true;
    }
  });
  return touched;
}

// A playlist removed: everything of it goes.
function dropPlaylist(sel, pl) {
  sel.sections = sel.sections.filter(function (s) { return !(s.kind === 'group' && s.pl === pl); });
  sel.sections.forEach(function (s) {
    if (s.kind === 'pick') s.channels = s.channels.filter(function (c) { return c.pl !== pl; });
  });
  sel.sections = sel.sections.filter(function (s) { return s.kind === 'group' || s.channels.length; });
  sel.favourites = sel.favourites.filter(function (c) { return c.pl !== pl; });
  Object.keys(sel.names).forEach(function (id) { if (id.indexOf(pl + ':') === 0) delete sel.names[id]; });
  delete sel.hidden[pl];
}

// ---------------------------------------------------------------- the lineup

/*
 * The lineup as it stands: sections in order, each channel once (the first
 * section to carry it keeps it), numbered through, at most LIMITS.lineup.
 * ctx.added(pl) is the select job's published document for a playlist (its
 * channels, and each group section's keys); ctx.hasPlaylist(pl).
 */
function compute(sel, ctx) {
  var sections = [], channels = [], byId = {}, next = 1, cut = false;
  var favs = {};
  sel.favourites.forEach(function (c) { favs[idOf(c)] = true; });
  function push(sec, pl, key, hint) {
    var id = pl + ':' + key;
    if (byId[id]) return false;
    if (channels.length >= LIMITS.lineup) { cut = true; return false; }
    var added = ctx.added(pl);
    var a = added && added.channels && added.channels[key];
    var c = { id: id, pl: pl, key: key, sid: sec.id, number: next++,
      name: sel.names[id] || (a && a.name) || (hint && hint.name) || key,
      provName: (a && a.name) || (hint && hint.name) || '', group: (a && a.group) || (hint && hint.group) || '' };
    if (sel.names[id]) c.renamed = true;
    if (favs[id]) c.fav = true;
    if (a && a.logo) c.logo = a.logo;
    if (a && a.dupe) c.dupe = a.dupe;
    if (a && (a.headers || a.drm || a.unsupported)) c.unplayable = a.drm ? 'drm' : a.headers ? 'headers' : 'format';
    if (!ctx.hasPlaylist(pl)) c.missing = true;
    else if (!a) {
      if (added && ctx.selCurrent(pl) && (added.missing || []).indexOf(key) !== -1) c.missing = true;
      else c.pending = true;
    }
    byId[id] = c;
    channels.push(c);
    return true;
  }
  sel.sections.forEach(function (s) {
    var start = s.from > 0 ? Math.max(s.from, next) : next;
    var out = { id: s.id, kind: s.kind, name: s.name, from: s.from, start: start, count: 0, state: 'ready' };
    if (s.from > 0 && s.from < next) out.clash = true;
    next = start;
    if (s.kind === 'group') {
      out.pl = s.pl;
      out.group = s.group;
      out.except = s.except.length;
      var added = ctx.added(s.pl);
      var keys = added && added.groups && added.groups[s.id];
      if (!ctx.hasPlaylist(s.pl)) out.state = 'gone';
      // Added since the select job last ran: its channels are being read.
      else if (!keys) out.state = 'pending';
      else {
        // Taken out since the select job last read the group: out now, not after it runs again.
        var except = {};
        s.except.forEach(function (k) { except[k] = true; });
        keys.forEach(function (k) { if (!except[k] && push(s, s.pl, k, null)) out.count++; });
        if (added.groupsCut && added.groupsCut[s.id]) out.cut = true;
      }
    } else {
      s.channels.forEach(function (c) { if (push(s, c.pl, c.key, c)) out.count++; });
    }
    out.end = out.count ? next - 1 : start;
    sections.push(out);
  });
  var favourites = [];
  sel.favourites.forEach(function (c) {
    var id = idOf(c);
    if (byId[id]) return favourites.push(byId[id]);
    // Starred, and its section not read yet: shown waiting, under its last name.
    favourites.push({ id: id, pl: c.pl, key: c.key, name: sel.names[id] || c.name || c.key, provName: c.name, group: c.group,
      fav: true, pending: ctx.hasPlaylist(c.pl), missing: !ctx.hasPlaylist(c.pl) });
  });
  return { sections: sections, channels: channels, byId: byId, favourites: favourites, cut: cut };
}

// ---------------------------------------------------------------- edits

/*
 * One edit from the dashboards or Home. ctx as for compute, and
 * ctx.lineup() for the lineup before the edit. Returns { ok, error?,
 * changed, composition, section? }; the selection is changed in place, and
 * its generation moves only when the channels it carries do.
 */
function apply(sel, body, ctx) {
  var action = body && body.action;
  var before = JSON.stringify(sel), carriedBefore = carried(sel);
  var r = run(sel, action, body || {}, ctx);
  // A refused edit leaves nothing half done (an add that filled the lineup part way).
  if (!r.ok) restore(sel, before);
  r.changed = r.ok && JSON.stringify(sel) !== before;
  // Which channels the lineup carries: only then has the select job anything to read again.
  r.composition = r.changed && carried(sel) !== carriedBefore;
  if (r.composition) sel.generation++;
  return r;
}

// The selection put back, in place, from its JSON.
function restore(sel, json) {
  var old = JSON.parse(json), k;
  for (k in sel) if (sel.hasOwnProperty(k)) delete sel[k];
  for (k in old) if (old.hasOwnProperty(k)) sel[k] = old[k];
}

// What decides the channels the lineup carries, less names and numbers.
function carried(sel) {
  return JSON.stringify(sel.sections.map(function (s) {
    return s.kind === 'group' ? [s.id, s.pl, s.group, s.except] : [s.id, s.channels.map(idOf)];
  }));
}

function fail(code, extra) {
  var r = { ok: false, error: code };
  if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
  return r;
}

function pickCount(sel) {
  var n = 0;
  sel.sections.forEach(function (s) { if (s.kind === 'pick') n += s.channels.length; });
  return n;
}

function isFav(sel, id) { return sel.favourites.some(function (c) { return idOf(c) === id; }); }

function star(sel, ref, on) {
  var id = idOf(ref);
  if (!on) {
    sel.favourites = sel.favourites.filter(function (c) { return idOf(c) !== id; });
    return null;
  }
  if (isFav(sel, id)) return null;
  if (sel.favourites.length >= LIMITS.favourites) return 'full';
  sel.favourites.push({ pl: ref.pl, key: ref.key, name: ref.name || '', group: ref.group || '' });
  return null;
}

function run(sel, action, body, ctx) {
  var s, i;
  if (action === 'add-group') {
    // One group, or several (groups) added in the order given.
    var groups = isArray(body.groups) ? body.groups : [body.group];
    if (typeof body.pl !== 'string' || !ctx.hasPlaylist(body.pl) || !groups.length || groups.some(function (g) { return typeof g !== 'string'; })) return fail('group');
    var first = null, at = typeof body.at === 'number' ? body.at : -1;
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi].slice(0, 120);
      s = null;
      for (i = 0; i < sel.sections.length; i++) {
        if (sel.sections[i].kind === 'group' && sel.sections[i].pl === body.pl && sel.sections[i].group === group) s = sel.sections[i];
      }
      // Again: whatever was taken out of it comes back.
      if (s) s.except = [];
      else {
        if (sel.sections.length >= LIMITS.sections) return fail('sections', { max: LIMITS.sections });
        s = { id: newSectionId(sel), kind: 'group', pl: body.pl, group: group, name: groups.length === 1 ? str(body.name, LIMITS.name) : '', from: 0, except: [] };
        insertAt(sel, s, at);
        if (at >= 0) at++;
      }
      first = first || s.id;
    }
    return { ok: true, section: first };
  }
  if (action === 'add') {
    var list = (isArray(body.channels) ? body.channels : []).map(channelRef);
    if (!list.length || list.some(function (c) { return !c || !ctx.hasPlaylist(c.pl); })) return fail('channel');
    var target = body.section && body.section !== 'new' ? sectionById(sel, body.section) : null;
    if (body.section && body.section !== 'new' && (!target || target.kind !== 'pick')) return fail('section');
    var fresh = body.section === 'new';
    var lineup = ctx.lineup();
    var full = null;
    for (i = 0; i < list.length; i++) {
      var c = list[i], id = idOf(c);
      var inGroup = groupSectionCarrying(sel, c, ctx);
      // Taken out of its group and now added to a section named: it goes there, and stays out of the group.
      if (inGroup && body.section && inGroup.except.indexOf(c.key) !== -1) inGroup = null;
      if (inGroup) inGroup.except = inGroup.except.filter(function (k) { return k !== c.key; });
      else if (!pickHolding(sel, id)) {
        if (pickCount(sel) >= LIMITS.picks || (lineup.channels.length + i >= LIMITS.lineup)) return fail('lineup-full', { max: LIMITS.lineup });
        if (!target && fresh) {
          // A section of their own, named and placed as asked (at the end by default).
          if (sel.sections.length >= LIMITS.sections) return fail('sections', { max: LIMITS.sections });
          target = { id: newSectionId(sel), kind: 'pick', name: str(body.name, LIMITS.name), from: 0, channels: [] };
          insertAt(sel, target, body.at);
        }
        if (!target) target = firstPick(sel) || newPick(sel);
        if (!target) return fail('sections', { max: LIMITS.sections });
        target.channels.push(c);
      }
      if (body.favourite) full = star(sel, c, true) || full;
    }
    return { ok: true, full: !!full, section: target ? target.id : null };
  }
  if (action === 'remove') {
    var ids = (isArray(body.ids) ? body.ids : []).map(splitId).filter(Boolean);
    // Sections can go in the same edit (groups taken out from the list of groups), so one Undo brings all back.
    var withSections = isArray(body.sections) && body.sections.length;
    if (!ids.length && !withSections) return fail('ids');
    if (withSections) {
      var rs = run(sel, 'remove-section', { sections: body.sections }, ctx);
      if (!rs.ok) return rs;
    }
    ids.forEach(function (r) {
      var id = idOf(r);
      sel.sections.forEach(function (sec) {
        if (sec.kind === 'pick') sec.channels = sec.channels.filter(function (c) { return idOf(c) !== id; });
        else if (sec.pl === r.pl && groupHas(ctx, sec, r.key) && sec.except.indexOf(r.key) === -1 && sec.except.length < LIMITS.except) {
          // Also when a pick ahead of it carried it: taken out, it stays out.
          sec.except.push(r.key);
        }
      });
      star(sel, r, false);
      delete sel.names[id];
    });
    dropEmptyPicks(sel);
    return { ok: true };
  }
  if (action === 'remove-section') {
    // One section, or several (sections).
    var ids0 = isArray(body.sections) ? body.sections : [body.section];
    var drop = ids0.map(function (id) { return sectionById(sel, id); }).filter(Boolean);
    if (!drop.length) return fail('section');
    var gone = {}, dropIds = {};
    drop.forEach(function (d) { dropIds[d.id] = true; });
    ctx.lineup().channels.forEach(function (c) { if (dropIds[c.sid]) gone[c.id] = true; });
    sel.sections = sel.sections.filter(function (d) { return !dropIds[d.id]; });
    // A starred channel carried by another section keeps its star.
    var after = compute(sel, ctx);
    sel.favourites = sel.favourites.filter(function (c) { return !gone[idOf(c)] || after.byId[idOf(c)]; });
    return { ok: true };
  }
  if (action === 'section') {
    s = sectionById(sel, body.section);
    if (!s) return fail('section');
    if (body.name !== undefined) s.name = str(body.name, LIMITS.name);
    if (body.from !== undefined) {
      var from = +body.from;
      if (!(from >= 0 && from <= 9999) || Math.floor(from) !== from) return fail('from');
      s.from = from;
    }
    return { ok: true, section: s.id };
  }
  if (action === 'move-section') {
    s = sectionById(sel, body.section);
    if (!s || typeof body.to !== 'number') return fail('section');
    sel.sections.splice(sel.sections.indexOf(s), 1);
    insertAt(sel, s, body.to);
    return { ok: true, section: s.id };
  }
  if (action === 'order') {
    // A pick section's channels in a new order; any not named keep theirs, after.
    s = sectionById(sel, body.section);
    if (!s || s.kind !== 'pick' || !isArray(body.ids)) return fail('section');
    var byId = {};
    s.channels.forEach(function (c) { byId[idOf(c)] = c; });
    var out = [];
    body.ids.forEach(function (id) { if (byId[id] && out.indexOf(byId[id]) === -1) out.push(byId[id]); });
    s.channels.forEach(function (c) { if (out.indexOf(c) === -1) out.push(c); });
    s.channels = out;
    return { ok: true };
  }
  if (action === 'star') {
    if (isArray(body.ids)) return starMany(sel, body.ids, body.on !== false, ctx);
    var ref = splitId(body.id);
    if (!ref) return fail('ids');
    if (body.on !== false) {
      var lc = ctx.lineup().byId[body.id];
      if (!lc) return fail('not-in-lineup');
      ref.name = lc.provName || lc.name;
      ref.group = lc.group;
    }
    var err = star(sel, ref, body.on !== false);
    return err ? fail(err, { max: LIMITS.favourites }) : { ok: true };
  }
  if (action === 'move') return move(sel, body, ctx);
  if (action === 'favourites') {
    // The row as arranged on Home or a dashboard: one left out is unstarred.
    if (!isArray(body.ids)) return fail('ids');
    var favById = {};
    sel.favourites.forEach(function (c) { favById[idOf(c)] = c; });
    var favs = [];
    body.ids.forEach(function (id) { if (favById[id] && favs.indexOf(favById[id]) === -1) favs.push(favById[id]); });
    sel.favourites = favs;
    return { ok: true };
  }
  if (action === 'rename') {
    var rr = splitId(body.id);
    if (!rr) return fail('ids');
    var name = str(body.name, LIMITS.name);
    if (name) {
      if (!sel.names[body.id] && Object.keys(sel.names).length >= LIMITS.names) return fail('names');
      sel.names[body.id] = name;
    } else delete sel.names[body.id];
    return { ok: true };
  }
  if (action === 'hide') {
    if (typeof body.pl !== 'string' || !ctx.hasPlaylist(body.pl) || !isArray(body.groups)) return fail('group');
    var hid = sel.hidden[body.pl] || [];
    body.groups.forEach(function (g) {
      if (typeof g !== 'string') return;
      g = g.slice(0, 120);
      var at = hid.indexOf(g);
      if (body.hidden === false) { if (at !== -1) hid.splice(at, 1); }
      else if (at === -1 && hid.length < LIMITS.hidden) hid.push(g);
    });
    if (hid.length) sel.hidden[body.pl] = hid;
    else delete sel.hidden[body.pl];
    return { ok: true };
  }
  return fail('action');
}

/*
 * Several channels starred or unstarred at once. Starring stops when the row
 * is full and says how many made it (starred), rather than failing them all.
 */
function starMany(sel, ids, on, ctx) {
  var refs = ids.map(splitId).filter(Boolean);
  if (!refs.length) return fail('ids');
  var lineup = on ? ctx.lineup() : null, starred = 0, full = false;
  for (var i = 0; i < refs.length; i++) {
    var ref = refs[i];
    if (on) {
      var lc = lineup.byId[idOf(ref)];
      if (!lc) continue;
      if (isFav(sel, lc.id)) continue;
      ref.name = lc.provName || lc.name;
      ref.group = lc.group;
      if (star(sel, ref, true)) { full = true; break; }
      starred++;
    } else star(sel, ref, false);
  }
  return { ok: true, starred: starred, full: full };
}

/*
 * Channels already in the lineup moved into a section of picked channels
 * (section), or into a new one (section 'new', named name, placed at at).
 * A group section that carried one leaves it out from then on, so the
 * channel is numbered where it was moved to; stars and names go with it.
 */
function move(sel, body, ctx) {
  var lineup = ctx.lineup();
  var list = (isArray(body.ids) ? body.ids : []).map(function (id) { return lineup.byId[id]; }).filter(Boolean);
  if (!list.length) return fail('ids');
  var target;
  if (body.section === 'new') {
    if (sel.sections.length >= LIMITS.sections) return fail('sections', { max: LIMITS.sections });
    target = { id: newSectionId(sel), kind: 'pick', name: str(body.name, LIMITS.name), from: 0, channels: [] };
    insertAt(sel, target, body.at);
  } else {
    target = sectionById(sel, body.section);
    if (!target || target.kind !== 'pick') return fail('section');
  }
  var moving = {};
  list.forEach(function (c) { moving[c.id] = true; });
  sel.sections.forEach(function (sec) {
    if (sec === target) return;
    if (sec.kind === 'pick') sec.channels = sec.channels.filter(function (c) { return !moving[idOf(c)]; });
    else list.forEach(function (c) {
      if (sec.pl === c.pl && groupHas(ctx, sec, c.key) && sec.except.indexOf(c.key) === -1 && sec.except.length < LIMITS.except) sec.except.push(c.key);
    });
  });
  // In the order given, after what the section already holds.
  target.channels = target.channels.filter(function (c) { return !moving[idOf(c)]; });
  list.forEach(function (c) { target.channels.push({ pl: c.pl, key: c.key, name: c.provName || c.name, group: c.group }); });
  if (pickCount(sel) > LIMITS.picks) return fail('lineup-full', { max: LIMITS.lineup });
  dropEmptyPicks(sel);
  return { ok: true, section: target.id };
}

function groupHas(ctx, sec, key) {
  var added = ctx.added(sec.pl);
  var keys = added && added.groups && added.groups[sec.id];
  return !!keys && keys.indexOf(key) !== -1;
}

function insertAt(sel, s, at) {
  var to = typeof at === 'number' && at >= 0 ? Math.min(Math.floor(at), sel.sections.length) : sel.sections.length;
  sel.sections.splice(to, 0, s);
}

function firstPick(sel) {
  for (var i = 0; i < sel.sections.length; i++) if (sel.sections[i].kind === 'pick') return sel.sections[i];
  return null;
}

function newPick(sel) {
  if (sel.sections.length >= LIMITS.sections) return null;
  var s = { id: newSectionId(sel), kind: 'pick', name: '', from: 0, channels: [] };
  // Picked channels lead: the ones chosen one by one are the ones watched most.
  sel.sections.unshift(s);
  return s;
}

function pickHolding(sel, id) {
  for (var i = 0; i < sel.sections.length; i++) {
    var s = sel.sections[i];
    if (s.kind === 'pick' && s.channels.some(function (c) { return idOf(c) === id; })) return s;
  }
  return null;
}

// The group section that carries, or carried until it was taken out, this channel.
function groupSectionCarrying(sel, c, ctx) {
  for (var i = 0; i < sel.sections.length; i++) {
    var s = sel.sections[i];
    if (s.kind === 'group' && s.pl === c.pl && (s.except.indexOf(c.key) !== -1 || groupHas(ctx, s, c.key))) return s;
  }
  return null;
}

function dropEmptyPicks(sel) {
  sel.sections = sel.sections.filter(function (s) { return s.kind === 'group' || s.channels.length; });
}

module.exports = {
  LIMITS: LIMITS,
  empty: empty,
  normalise: normalise,
  trackedKeys: trackedKeys,
  groupSectionsOf: groupSectionsOf,
  usesPlaylist: usesPlaylist,
  applyRematch: applyRematch,
  dropPlaylist: dropPlaylist,
  compute: compute,
  apply: apply,
  carried: carried,
  restore: restore,
  splitId: splitId
};
