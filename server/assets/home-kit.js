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
  var covered = false;
  var coveredSince = 0;
  var coveredFns = [];

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
      if (r.standalone && r.enabled === false) return window.close();
      setCovered(!!r.covered);
      coveredSince = r.covered && !r.saver ? (coveredSince || new Date().getTime()) : 0;
      if (r.standalone && coveredSince && new Date().getTime() - coveredSince > CLOSE_BEHIND_MS) window.close();
    });
  }

  var KINDS = { app: 'app', input: 'dev', channel: 'ch' };

  /** @type {any} */ (window).Glasshouse = {
    version: 1,

    // cb(err, { apps: [{ id, title, icon, hidden }], inputs: [{ id, title, port, tuner }] })
    catalogue: function (cb) {
      cb = done(cb);
      request('GET', '/api/home/catalogue', null, function (err, c) {
        if (err) return cb(err);
        var hidden = (c.layout && c.layout.hidden && c.layout.hidden.app) || [];
        var apps = [], inputs = [], i;
        for (i = 0; i < (c.apps || []).length; i++) {
          var a = c.apps[i];
          apps.push({ id: a.id, title: a.title, icon: a.icon || null, hidden: hidden.indexOf(a.id) !== -1 });
        }
        for (i = 0; i < (c.devices || []).length; i++) {
          var d = c.devices[i];
          inputs.push({ id: d.id, title: d.name, port: d.port || 0, tuner: d.tuner === true, unused: d.unused === true });
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

    isCovered: function () { return covered; }
  };

  beat();
})();
