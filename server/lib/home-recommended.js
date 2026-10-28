/*
 * lib/home-recommended.js - the Recommended row on Glasshouse Home: the cards
 * the TV's apps publish for LG's Home (lib/home)
 *
 * Netflix, Prime Video, Disney+, HBO Max and YouTube each hand the TV's
 * application manager a list of titles - Netflix's Continue watching and Top
 * picks, Prime Video's own row - which LG's Home on webOS 10 shows as cards.
 * applicationmanager/getAllContents answers with every app's list, read on
 * the TV: { allContents: [{ launchPointId, contents: [{ type: 'content',
 * titleText, category, image: { url }, onClick: { targetAppId, contentId } }] }] }.
 * A 'title' entry heads each list and carries nothing. The pictures are the
 * apps' own, on their servers.
 *
 * A card opens its app at the title the way LG's Home does: contentId is the
 * app's contentTarget launch parameter. Only a card on the list now can be
 * opened, so this is not a way to launch anything at all. LG's Home also calls
 * each card's onShow to tell the app it was seen; Glasshouse does not.
 *
 * Strict ES5: runs on node 0.12.
 */
var crypto = require('crypto');
var msg = require('./say').msg;

var SERVICE = 'com.webos.service.applicationmanager/getAllContents';
var MAX_PER_APP = 12;
var MAX_TEXT = 200;
// No quote, bracket or backslash: the view puts the address in a CSS url('…').
var IMAGE_RE = /^https?:\/\/[^\s"'<>\\]+$/i;

var lunaFn = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
}

function text(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
}

// The same title from the same app keeps its id as the lists are refreshed.
function cardId(app, contentId) {
  return crypto.createHash('md5').update(app + '\n' + contentId).digest('hex').slice(0, 16);
}

/*
 * Every app's cards, in the order each app gave them: [{ id, app, title,
 * category, image }], at most MAX_PER_APP an app. cb(null) when the TV did not
 * answer, as on webOS versions without the call.
 */
function cards(cb) {
  read(function (list) {
    cb(list && list.map(function (c) {
      return { id: c.id, app: c.app, title: c.title, category: c.category, image: c.image };
    }));
  });
}

function read(cb) {
  if (!lunaFn) return cb(null);
  lunaFn(SERVICE, {}, function (r) {
    if (!r || r.returnValue === false || Object.prototype.toString.call(r.allContents) !== '[object Array]') return cb(null);
    var out = [], seen = {}, count = {};
    r.allContents.forEach(function (lp) {
      var contents = lp && Object.prototype.toString.call(lp.contents) === '[object Array]' ? lp.contents : [];
      contents.forEach(function (c) {
        if (!c || c.type !== 'content' || !c.onClick) return;
        var app = text(c.onClick.targetAppId), contentId = typeof c.onClick.contentId === 'string' ? c.onClick.contentId : '';
        var title = text(c.titleText);
        if (!app || !contentId || !title || (count[app] || 0) >= MAX_PER_APP) return;
        var id = cardId(app, contentId);
        if (seen[id]) return;
        seen[id] = true;
        count[app] = (count[app] || 0) + 1;
        var url = c.image && typeof c.image.url === 'string' ? c.image.url : '';
        out.push({ id: id, app: app, title: title, category: text(c.category),
          image: IMAGE_RE.test(url) ? url : null, contentId: contentId });
      });
    });
    cb(out);
  });
}

function open(id, cb) {
  read(function (list) {
    if (!list) return cb({ ok: false, error: msg('srv.home.recommendedUnavailable', 'the TV did not list its apps’ recommendations') });
    /** @type {any} */
    var hit = null;
    list.forEach(function (c) { if (c.id === id) hit = c; });
    if (!hit) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
    lunaFn('com.webos.applicationManager/launch', { id: hit.app, params: { contentTarget: hit.contentId } }, function (r) {
      cb({ ok: !!(r && r.returnValue), app: hit.app,
        error: r && r.returnValue ? undefined : msg('srv.home.launchRefused', 'the TV would not open it') });
    });
  });
}

module.exports = {
  init: init,
  cards: cards,
  open: open
};
