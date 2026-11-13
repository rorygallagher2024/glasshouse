/*
 * home-kit.js - what Glasshouse adds to a custom launcher's start page
 *
 * The heartbeat: every 5 s the page tells the server it is up. A launcher
 * that stops sending it, or never loads, gives LG's Home its place back, as
 * Glasshouse Home's own view does. The reply also says when another launcher
 * has been chosen or uploaded, and the page reloads into it.
 *
 * window.Glasshouse, for the launcher's own script. Its calls are the ones
 * docs/development/WRITING-LAUNCHERS.md describes, and stay as they are
 * across releases; the server's own routes behind them may not.
 *
 * Strict ES5: the TV's browser on webOS 3 and 4 is too old for more.
 */
(function () {
  var BEAT_MS = 5000;
  // webOS 4: two minutes behind another app, the page closes itself to give
  // its memory back, as Glasshouse Home's view does; Home opens it afresh.
  var CLOSE_BEHIND_MS = 120000;
  var launcher = null;
  var build = null;
  var covered = false;
  var coveredSince = 0;
  var coveredFns = [];
  var lists = null;
  var changedFns = [];

  function request(method, url, body, cb) {
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    x.timeout = 10000;
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300 && r && r.ok !== false) return cb(null, r);
      cb(new Error((r && r.error) || 'HTTP ' + x.status), r);
    };
    x.onerror = x.ontimeout = function () { cb(new Error('Glasshouse is not answering')); };
    x.send(body ? JSON.stringify(body) : null);
  }

  function done(cb) { return typeof cb === 'function' ? cb : function () {}; }

  // Read once, then kept in step by storage.set.
  var store = null;
  function loadStore(cb) {
    if (store) return cb(null, store);
    request('GET', '/api/home/store', null, function (err, r) {
      if (err) return cb(err);
      store = (r && r.values) || {};
      cb(null, store);
    });
  }

  function setCovered(now) {
    if (now === covered) return;
    covered = now;
    for (var i = 0; i < coveredFns.length; i++) {
      try { coveredFns[i](covered); } catch (e) {}
    }
  }

  function beat() {
    var body = { focused: document.hasFocus(), visible: document.visibilityState || '' };
    request('POST', '/api/home/beat', body, function (err, r) {
      setTimeout(beat, BEAT_MS);
      if (err || !r) return;
      if (launcher === null) launcher = r.launcher || '';
      else if ((r.launcher || '') !== launcher) {
        return location.replace(r.launcher ? '/home/launcher/' : '/assets/home.html');
      }
      // A new release of Glasshouse: loaded again, so this script is the release's own.
      if (build === null) build = r.build || '';
      else if (r.build && r.build !== build) return location.reload();
      if (r.standalone && r.enabled === false) return window.close();
      setCovered(!!r.covered);
      // Apps installed or removed, a device named over HDMI-CEC, channels retuned.
      if (lists !== null && r.layoutVersion !== lists) {
        for (var i = 0; i < changedFns.length; i++) {
          try { changedFns[i](); } catch (e) {}
        }
      }
      lists = r.layoutVersion;
      coveredSince = r.covered && !r.saver ? (coveredSince || new Date().getTime()) : 0;
      if (r.standalone && coveredSince && new Date().getTime() - coveredSince > CLOSE_BEHIND_MS) window.close();
    });
  }

  var KINDS = { app: 'app', input: 'dev', channel: 'ch' };

  /** @type {any} */ (window).Glasshouse = {
    version: 2,

    /*
     * cb(err, { apps: [{ id, title, icon, hidden, folder }],
     *           inputs: [{ id, title, port, tuner, unused, hidden }] }), in the
     * order arranged on the Home tab. hidden: hidden there, or an input with
     * nothing plugged in where the Home tab leaves those out. folder: put in
     * More apps there, for a launcher that has a place for them.
     */
    catalogue: function (cb) {
      cb = done(cb);
      request('GET', '/api/home/catalogue', null, function (err, c) {
        if (err) return cb(err);
        var layout = c.layout || {};
        var hidden = layout.hidden || {}, hiddenRows = layout.hiddenRows || [];
        var hiddenApps = hidden.app || [], hiddenInputs = hidden.dev || [], folder = layout.folder || [];
        var appsOff = hiddenRows.indexOf('app') !== -1, inputsOff = hiddenRows.indexOf('dev') !== -1;
        var order = c.order || {};
        function inOrder(list, ids) {
          if (!ids || !ids.length) return list.slice();
          var byId = {}, out = [], i;
          for (i = 0; i < list.length; i++) byId[list[i].id] = list[i];
          for (i = 0; i < ids.length; i++) if (byId[ids[i]]) { out.push(byId[ids[i]]); delete byId[ids[i]]; }
          for (i = 0; i < list.length; i++) if (byId[list[i].id]) out.push(list[i]);
          return out;
        }
        var apps = [], inputs = [], i;
        var appList = inOrder(c.apps || [], order.app);
        for (i = 0; i < appList.length; i++) {
          var a = appList[i];
          apps.push({ id: a.id, title: a.title, icon: a.icon || null,
            hidden: appsOff || hiddenApps.indexOf(a.id) !== -1, folder: folder.indexOf(a.id) !== -1 });
        }
        var devList = inOrder(c.devices || [], order.dev);
        for (i = 0; i < devList.length; i++) {
          var d = devList[i];
          var unused = d.unused === true;
          inputs.push({ id: d.id, title: d.name, port: d.port || 0, tuner: d.tuner === true, unused: unused,
            hidden: inputsOff || hiddenInputs.indexOf(d.id) !== -1 || (unused && layout.hideUnused === true) });
        }
        cb(null, { apps: apps, inputs: inputs });
      });
    },

    // cb(err, [{ id, number, title, radio }]), or an empty list where the TV has no tuner.
    channels: function (cb) {
      cb = done(cb);
      request('GET', '/api/home/channels', null, function (err, r) {
        if (err) return cb(err);
        var out = [];
        for (var i = 0; i < (r.channels || []).length; i++) {
          var ch = r.channels[i];
          out.push({ id: ch.id, number: ch.number, title: ch.name, radio: ch.radio === true });
        }
        cb(null, out);
      });
    },

    // kind: 'app', 'input' or 'channel', with an id from catalogue() or channels().
    open: function (kind, id, cb) {
      cb = done(cb);
      if (!KINDS[kind]) return cb(new Error('kind must be app, input or channel'));
      request('POST', '/api/home/open', { kind: KINDS[kind], id: String(id) }, function (err) { cb(err || null); });
    },

    // LG's Home, until something else is opened or Home is pressed again.
    lgHome: function (cb) {
      cb = done(cb);
      request('POST', '/api/home/open', { kind: 'lg' }, function (err) { cb(err || null); });
    },

    iconUrl: function (appId) { return '/api/home/icon?id=' + encodeURIComponent(appId); },

    // fn(true) while another app, an input or the screen saver is over Home; fn(false) when Home is back.
    onCovered: function (fn) { if (typeof fn === 'function') coveredFns.push(fn); },

    isCovered: function () { return covered; },

    // fn() when what catalogue() or channels() answer may have changed, to ask again.
    onChanged: function (fn) { if (typeof fn === 'function') changedFns.push(fn); },

    // fn() when Home is pressed with the launcher on screen, or it is opened again from an app.
    onHome: function (fn) { if (typeof fn === 'function') document.addEventListener('webOSRelaunch', function () { fn(); }); },

    /*
     * Values kept by Glasshouse for this launcher, which survive a power-on
     * where the page's own localStorage and IndexedDB may not (#1427). Up to
     * 256 KB of JSON in all. get(key, cb) answers cb(err, value), undefined
     * where nothing is kept; set(key, value, cb) keeps a JSON value, null
     * removing it; all(cb) answers cb(err, { key: value }).
     */
    storage: {
      get: function (key, cb) {
        cb = done(cb);
        loadStore(function (err, values) { cb(err || null, values ? values[key] : undefined); });
      },
      set: function (key, value, cb) {
        cb = done(cb);
        request('POST', '/api/home/store', { key: String(key), value: value === undefined ? null : value }, function (err) {
          if (!err && store) {
            if (value === null || value === undefined) delete store[key];
            else store[key] = JSON.parse(JSON.stringify(value));
          }
          cb(err || null);
        });
      },
      all: function (cb) {
        cb = done(cb);
        loadStore(function (err, values) { cb(err || null, values ? JSON.parse(JSON.stringify(values)) : {}); });
      }
    }
  };

  beat();
})();
