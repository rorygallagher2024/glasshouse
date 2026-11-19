/**
 * lib/storagescan.js - What is using the TV's storage, for the Metrics tab's
 * Storage view.
 *
 * The writable partitions come from df, one per device (the same partition
 * is mounted in many places), and each is walked once with `du -kx`, which
 * stays on that partition. On the C2 the app and data partitions take well
 * under a second. The folders come back as a tree, small ones folded into
 * their parent, each sorted into who put it there: an app you installed, LG's
 * own preinstalled content, or the system. Folders named after an app are
 * also totalled per app, so an app's bundle, cache and sandbox count as one.
 *
 * Nothing is deleted from here; the view only shows.
 *
 * Strict ES5: runs on node 0.12.
 */

var childProcess = require('child_process');
var fs = require('fs');

var MAX_AGE_MS = 10 * 60 * 1000;
var DU_TIMEOUT_MS = 30000;
// A folder smaller than this share of its partition is folded into its parent.
var FOLD_SHARE = 1 / 4000;
var FOLD_MIN_KB = 64;

var deps = {
  execFile: childProcess.execFile,
  read: function (f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } },
  listApps: null,
  now: function () { return Date.now(); }
};

var cache = null;
var scanning = false;
var waiting = [];

function init(o) {
  o = o || {};
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) deps[k] = o[k];
}

function reset() { cache = null; scanning = false; waiting = []; }

// ---- Partitions ------------------------------------------------------------

function mountOptions(raw) {
  var out = {};
  String(raw || '').split('\n').forEach(function (line) {
    var f = line.split(/\s+/);
    if (f.length < 4) return;
    out[f[1]] = { dev: f[0], type: f[2], ro: /(^|,)ro(,|$)/.test(f[3]) };
  });
  return out;
}

// What a partition holds, from where it is mounted.
function volumeKind(mount, dev) {
  if (/^\/mnt\/lg\/appstore$/.test(mount) || mount === '/media') return 'apps';
  if (/^\/mnt\/lg\/(cmn_data|user|flash\/data)$/.test(mount) || mount === '/var' || mount === '/home') return 'data';
  if (/^\/mnt\/lg\/db8$/.test(mount) || mount === '/var/db') return 'db';
  if (/^\/tmp\/usb\//.test(mount) || /^\/dev\/sd/.test(dev)) return 'usb';
  return 'other';
}

var KIND_ORDER = { apps: 0, data: 1, db: 2, usb: 3, other: 4 };
var KIND_MOUNT = { apps: /^\/mnt\/lg\/appstore$/, data: /^\/mnt\/lg\/cmn_data$/, db: /^\/mnt\/lg\/db8$/ };

/*
 * df -k's lines as one entry per writable partition. Read-only images (the
 * root filesystem, fonts, certificates) show as full with nothing free and
 * cannot change, so they are left out, as are memory filesystems, loop
 * images and anything under 2 MB.
 */
function volumes(dfOut, mountsRaw) {
  var opts = mountOptions(mountsRaw);
  var byDev = {};
  var order = [];
  String(dfOut || '').split('\n').slice(1).forEach(function (line) {
    var f = line.trim().split(/\s+/);
    if (f.length < 6) return;
    var dev = f[0], total = parseInt(f[1], 10), used = parseInt(f[2], 10), avail = parseInt(f[3], 10);
    var mount = f.slice(5).join(' ');
    if (!/^\/dev\/(mmcblk|sd|mapper|ubi|nvme)/.test(dev)) return;
    if (!(total >= 2048)) return;
    var o = opts[mount];
    if (o && o.ro) return;
    if (avail === 0 && used >= total) return;
    var kind = volumeKind(mount, dev);
    // Certificate and key stores of a few kilobytes are not worth a bar.
    if (kind === 'other' && total < 16384) return;
    var cur = byDev[dev];
    if (!cur) {
      byDev[dev] = { dev: dev, mount: mount, kind: kind, totalKb: total, usedKb: used, freeKb: avail };
      order.push(dev);
      return;
    }
    // The same partition again: keep the mount that names it best.
    if (cur.kind === 'other' && kind !== 'other') { cur.kind = kind; cur.mount = mount; }
    if (KIND_MOUNT[cur.kind] && KIND_MOUNT[cur.kind].test(mount)) cur.mount = mount;
  });
  return order.map(function (d) { return byDev[d]; }).sort(function (a, b) {
    return (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (b.totalKb - a.totalKb);
  });
}

// ---- Who put it there --------------------------------------------------------

/*
 * The group a folder belongs to, from its path inside its partition:
 * 'app' for apps you installed (and Glasshouse's own data), 'lg' for what LG
 * puts on every TV and you cannot remove, 'sys' for the system's own files.
 */
function groupOf(rel, kind) {
  if (kind === 'usb') return 'app';
  if (/^\/(cryptofs|developer)(\/|$)/.test(rel)) return 'app';
  if (/^\/(preload|system)(\/|$)/.test(rel)) return 'lg';
  if (/^\/var\/lib\/tvweb(\/|$)/.test(rel)) return 'app';
  return 'sys';
}

// ---- The tree ----------------------------------------------------------------

function parseDu(out, root) {
  var nodes = {};
  String(out || '').split('\n').forEach(function (line) {
    var tab = line.indexOf('\t');
    if (tab < 0) return;
    var kb = parseInt(line.slice(0, tab), 10);
    var p = line.slice(tab + 1);
    if (!(kb >= 0) || (p !== root && p.indexOf(root === '/' ? '/' : root + '/') !== 0)) return;
    nodes[p] = { p: p, s: kb, c: [] };
  });
  if (!nodes[root]) return null;
  Object.keys(nodes).forEach(function (p) {
    if (p === root) return;
    var parent = p.slice(0, p.lastIndexOf('/')) || '/';
    while (!nodes[parent] && parent.length > root.length) parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
    if (nodes[parent] && parent !== p) nodes[parent].c.push(nodes[p]);
  });
  return nodes[root];
}

/*
 * The tree as sent: each folder's name, size in KiB and group, its larger
 * folders, then what is left as its own files and the folders too small to
 * show, together.
 */
function shape(node, root, kind, minKb, appIds, inherited) {
  var rel = node.p.slice(root.length) || '/';
  var name = rel === '/' ? '' : rel.slice(rel.lastIndexOf('/') + 1);
  var app = appIds && Object.prototype.hasOwnProperty.call(appIds, name) ? appIds[name] : null;
  var g = inherited || groupOf(rel, kind);
  // Anywhere an app you can remove keeps its files is that app's.
  if (app && app.removable) g = 'app';
  var out = { n: name, s: node.s, g: g };
  if (app) out.a = name;
  var pass = inherited || (app && app.removable ? 'app' : null);
  var kids = node.c.slice().sort(function (a, b) { return b.s - a.s; });
  var shown = [];
  var folded = 0;
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].s >= minKb) shown.push(shape(kids[i], root, kind, minKb, appIds, pass));
    else folded++;
  }
  if (shown.length) {
    out.c = shown;
    var other = node.s - shown.reduce(function (t, k) { return t + k.s; }, 0);
    if (other >= minKb) out.c.push({ n: '', s: other, g: out.g, f: folded ? folded : 0 });
  }
  // A folder that is only another folder (apps/usr/palm/applications) is one
  // step, so zooming in does not take four clicks.
  if (name && !out.a && out.c && out.c.length === 1 && out.c[0].n) {
    var only = out.c[0];
    only.n = name + '/' + only.n;
    return only;
  }
  return out;
}

/*
 * Every folder named after an installed app, totalled per app: its bundle,
 * its cache, its sandbox and its saved images. A folder inside one already
 * counted for the same app is not counted again.
 */
function perApp(nodesByVolume, apps) {
  var ids = {};
  apps.forEach(function (a) { if (a && a.id) ids[a.id] = a; });
  var totals = {};
  nodesByVolume.forEach(function (v) {
    (function walk(node, counted) {
      var name = node.p.slice(node.p.lastIndexOf('/') + 1);
      var here = counted;
      // Glasshouse's own data: its history, icons, wallpapers and logs.
      if (/\/var\/lib\/tvweb$/.test(node.p) && !totals.glasshouse) {
        totals.glasshouse = { id: 'glasshouse', kb: node.s, parts: [{ path: node.p, kb: node.s, volume: v.kind }] };
      }
      if (Object.prototype.hasOwnProperty.call(ids, name) && !counted[name]) {
        var t = totals[name] || (totals[name] = { id: name, kb: 0, parts: [] });
        t.kb += node.s;
        t.parts.push({ path: node.p, kb: node.s, volume: v.kind });
        here = {};
        for (var k in counted) here[k] = true;
        here[name] = true;
      }
      for (var i = 0; i < node.c.length; i++) walk(node.c[i], here);
    })(v.tree, {});
  });
  return Object.keys(totals).map(function (id) {
    var a = ids[id] || { title: 'Glasshouse', removable: true, own: true }, t = totals[id];
    t.parts.sort(function (x, y) { return y.kb - x.kb; });
    return {
      id: id,
      title: a.title || id,
      kb: t.kb,
      removable: !!a.removable,
      systemApp: !!a.systemApp,
      own: !!a.own,
      parts: t.parts.slice(0, 6)
    };
  }).sort(function (x, y) { return y.kb - x.kb; });
}

// ---- Scanning ----------------------------------------------------------------

function run(file, args, timeout, cb) {
  deps.execFile(file, args, { timeout: timeout, maxBuffer: 16 * 1024 * 1024 }, function (err, stdout) {
    // du exits non-zero when one folder cannot be read, with the rest intact;
    // only a timeout leaves the walk unfinished.
    cb(err && (err.killed || err.signal) ? err : null, String(stdout || ''));
  });
}

function scanVolumes(vols, i, raw, cb) {
  if (i >= vols.length) return cb();
  var v = vols[i];
  run('du', ['-kx', v.mount], DU_TIMEOUT_MS, function (err, out) {
    if (err) v.partial = true;
    else {
      var tree = parseDu(out, v.mount);
      if (tree) raw.push({ kind: v.kind, mount: v.mount, vol: v, tree: tree });
      else v.partial = true;
    }
    scanVolumes(vols, i + 1, raw, cb);
  });
}

function scan(cb) {
  if (cb) waiting.push(cb);
  if (scanning) return;
  scanning = true;
  var started = deps.now();
  run('df', ['-k'], 8000, function (err, dfOut) {
    var vols = volumes(dfOut, deps.read('/proc/mounts'));
    var raw = [];
    scanVolumes(vols, 0, raw, function () {
      var finish = function (apps) {
        var ids = {};
        apps.forEach(function (a) { if (a && a.id) ids[a.id] = a; });
        raw.forEach(function (r) {
          var minKb = Math.max(FOLD_MIN_KB, Math.round(r.vol.usedKb * FOLD_SHARE));
          r.vol.tree = shape(r.tree, r.mount, r.kind, minKb, ids);
        });
        cache = {
          ok: true,
          at: deps.now(),
          tookMs: deps.now() - started,
          volumes: vols,
          apps: perApp(raw, apps)
        };
        scanning = false;
        var w = waiting;
        waiting = [];
        w.forEach(function (fn) { fn(cache); });
      };
      if (!deps.listApps) return finish([]);
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; finish([]); } }, 8000);
      deps.listApps(function (list) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        finish(Array.isArray(list) ? list : []);
      });
    });
  });
}

/*
 * The last scan, and a new one when it is older than ten minutes or asked
 * for. A view that opens with nothing yet waits for the first.
 */
function query(force, cb) {
  var fresh = cache && deps.now() - cache.at < MAX_AGE_MS;
  if (cache && !force) {
    if (!fresh) scan();
    return cb(withState(cache));
  }
  scan(function (c) { cb(withState(c)); });
}

function withState(c) {
  var out = {};
  for (var k in c) out[k] = c[k];
  out.now = deps.now();
  out.scanning = scanning;
  return out;
}

module.exports = {
  init: init,
  reset: reset,
  query: query,
  scan: scan,
  volumes: volumes,
  parseDu: parseDu,
  shape: shape,
  perApp: perApp,
  groupOf: groupOf
};
