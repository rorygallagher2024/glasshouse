/*
 * lib/home-recent-apps.js - the recent apps panel Back opens on Glasshouse
 * Home, in place of the one inside LG's Home (lib/home)
 *
 * LG's panel is a view of its own Home app with no way in from outside, so
 * Glasshouse draws its own from the same source: the surface manager's
 * com.webos.service.recent, newest first, with each app's snapshot. Its
 * removeRecent closes the apps it removes on a G3 (webOS 9.2.2) but only
 * takes them off the list on a G5 (webOS 10.3.1). Stop the listed apps first,
 * verifying they have left running before removing their cards, so a refused
 * close keeps its card for retry. Web apps need WebAppMgr's killApp.
 * Apps kept running in the background without a card (YouTube, the browser)
 * are not on the list.
 *
 * Strict ES5: runs on node 0.12.
 */
var msg = require('./say').msg;

var SERVICE = 'com.webos.service.recent/';
// The view and the app it runs as are never offered.
var LEFT_OUT = ['com.webos.app.home', 'com.tvweb.home'];
var IMAGE_RE = /\.(jpe?g|png)$/i;

var lunaFn = null;
var excludedFn = function () { return []; };
// appId to image path, from the last list: only those are served.
var images = {};

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  excludedFn = opts.excluded || function () { return []; };
  images = {};
}

function luna(uri, payload, cb) {
  if (!lunaFn) return cb(null);
  lunaFn(uri, payload, function (r) { cb(r || null); });
}

function excluded(id) {
  return LEFT_OUT.indexOf(id) !== -1 || excludedFn().indexOf(id) !== -1;
}

function list(cb) {
  luna(SERVICE + 'listRecents', {}, function (r) {
    if (!r || r.returnValue === false || Object.prototype.toString.call(r.recentsAppList) !== '[object Array]') {
      return cb({ ok: false, error: msg('srv.home.recentsUnavailable', 'the TV did not list its recent apps') });
    }
    var apps = [], seen = {};
    images = {};
    r.recentsAppList.forEach(function (a) {
      var id = a && typeof a.appId === 'string' ? a.appId : '';
      if (!id || seen[id] || excluded(id)) return;
      seen[id] = true;
      // Netflix names a picture of its own; the others have the snapshot taken
      // as they were left. Snapshots are in /tmp, so an app left before the TV
      // restarted has none, and shows its splash.
      var image = [a.customImageFilePath, a.cardSnapShotFilePath, a.splashBackground].filter(function (p) {
        return typeof p === 'string' && p.charAt(0) === '/' && IMAGE_RE.test(p);
      })[0];
      if (image) images[id] = image;
      apps.push({ id: id, title: String(a.title || id), image: !!image });
    });
    cb({ ok: true, apps: apps });
  });
}

function imagePath(id) {
  return typeof id === 'string' && !excluded(id) && images.hasOwnProperty(id) ? images[id] : null;
}

// Only an app on the list now can be opened or closed through it.
function listed(id, cb) {
  list(function (r) {
    if (!r.ok) return cb(r);
    var known = r.apps.some(function (a) { return a.id === id; });
    cb(known ? { ok: true } : { ok: false, error: msg('srv.home.notRecent', 'that app is not in recent apps') });
  });
}

function open(id, cb) {
  listed(id, function (r) {
    if (!r.ok) return cb(r);
    luna('com.webos.applicationManager/launch', { id: id }, function (l) {
      cb(l && l.returnValue ? { ok: true } : { ok: false, error: msg('srv.home.launchRefused', 'the TV would not open it') });
    });
  });
}

function close(id, cb) {
  listed(id, function (r) {
    if (!r.ok) return cb(r);
    closeListed([id], cb);
  });
}

function closeAll(cb) {
  list(function (r) {
    if (!r.ok) return cb(r);
    var ids = r.apps.map(function (a) { return a.id; });
    closeListed(ids, cb);
  });
}

function closeRefused(cb) {
  cb({ ok: false, error: msg('srv.home.closeRefused', 'the TV would not close it') });
}

function running(cb) {
  luna('com.webos.applicationManager/running', {}, function (r) {
    cb(r && r.returnValue !== false && Object.prototype.toString.call(r.running) === '[object Array]' ? r.running : null);
  });
}

function closeListed(ids, cb) {
  if (!ids.length) return list(cb);
  running(function (apps) {
    if (!apps) return closeRefused(cb);
    var left = apps.filter(function (a) { return a && ids.indexOf(a.id) !== -1; });
    var pending = left.length;
    if (!pending) return removeCards();
    left.forEach(function (a) {
      // closeByAppId can merely background a web app, leaving its process alive.
      var web = a.appType === 'web';
      luna(web ? 'com.palm.webappmanager/killApp' : 'com.webos.applicationManager/closeByAppId',
        web ? { appId: a.id } : { id: a.id }, function () {
          if (--pending === 0) verifyStopped(10);
        });
    });
  });

  function verifyStopped(tries) {
    running(function (apps) {
      if (!apps) return closeRefused(cb);
      if (!apps.some(function (a) { return a && ids.indexOf(a.id) !== -1; })) return removeCards();
      if (!tries) return closeRefused(cb);
      setTimeout(function () { verifyStopped(tries - 1); }, 200);
    });
  }

  function removeCards() {
    list(function (r) {
      if (!r.ok) return cb(r);
      var left = r.apps.filter(function (a) { return ids.indexOf(a.id) !== -1; });
      // A stop may already remove its card. Remove only the original selection;
      // removeAllRecents would also remove excluded Home apps or newer cards.
      (function next() {
        if (!left.length) return list(cb);
        luna(SERVICE + 'removeRecent', { appId: left.shift().id }, function (removed) {
          if (!removed || !removed.returnValue) return closeRefused(cb);
          next();
        });
      })();
    });
  }
}

module.exports = {
  init: init,
  list: list,
  imagePath: imagePath,
  open: open,
  close: close,
  closeAll: closeAll
};
