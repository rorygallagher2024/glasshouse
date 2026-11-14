'use strict';
/*
 * lib/compat.js - which webOS versions each feature has been tried on
 *
 * One table for the features whose support depends on the TV's webOS
 * version, read by the modules that offer them and by the docs' compatibility
 * table (test-compat.js keeps the two the same). Each version is one of:
 *
 *   tried        reported working: offered with no warning
 *   untried     no report either way: offered, with a warning and links to
 *               report that it works or that it does not
 *   unsupported known not to work, for the reason given: not offered
 *
 * A test report moves a version into `tried` here; docs/tested-tvs.md says
 * why each `from` and `upTo` is where it is, with what was found on the TV. Features whose failure can
 * need the TV unplugged (custom screen savers on webOS 12 and later, tile
 * hiding) are not in this table: they keep their own confirmation.
 *
 * Strict ES5: runs on node 0.12 (0.10 on webOS 2).
 */
var msg = require('./say').msg;

var REPO = 'https://github.com/rorygallagher2024/glasshouse';

var FEATURES = {
  // Glasshouse Home, and the launchers that take its place: Glasshouse
  // Minimal and a custom launcher. No version is known not to run it.
  home: {
    title: 'Glasshouse Home',
    tried: [4, 5, 6, 7, 9, 10, 11]
  },
  // The input bar and Glasshouse Bar: overlay apps opened by the remote key
  // filter, which webOS 3 does not have and which, from webOS 11, cannot hand
  // a key to an app of Glasshouse's own. One entry, as both open the same way;
  // a report names the one it came from.
  inputBar: {
    title: 'Glasshouse Bar and the input bar',
    parts: ['The input bar', 'Glasshouse Bar'],
    tried: [4, 6, 9],
    from: 4,
    upTo: 10,
    tooOld: function () {
      return msg('srv.compat.bar.old', 'webOS 3 has no remote key filters, which open the input bar and Glasshouse Bar.');
    },
    tooNew: function () {
      return msg('srv.compat.bar.new', 'From webOS 11 the remote\'s keys are LG\'s own, and cannot open an app of Glasshouse\'s.');
    }
  }
};

function major(version) {
  var m = parseInt(String(version || ''), 10);
  return isNaN(m) ? null : m;
}

// 'tried', 'untried' or 'unsupported'. A version not known yet is untried.
function standing(id, version) {
  var f = FEATURES[id];
  var m = major(version);
  if (!f || m === null) return 'untried';
  if (m < f.from || (f.upTo !== undefined && m > f.upTo)) return 'unsupported';
  return f.tried.indexOf(m) !== -1 ? 'tried' : 'untried';
}

/*
 * A new GitHub issue with what the person sees filled in: the feature, the
 * webOS version, the model and firmware, and Glasshouse's version. Nothing is
 * sent unless they submit it. `part` names which of a feature's parts the
 * report is about (one of its `parts`), where it has several.
 */
function issueUrl(id, works, tv, part) {
  var f = FEATURES[id];
  tv = tv || {};
  var name = part || f.title;
  var where = 'webOS ' + (tv.webos || '?') + (tv.model ? ' (' + tv.model + ')' : '');
  // A report about one part names it alone; the whole of a feature with parts is plural.
  var plural = !part && !!f.parts;
  var title = name + (works ? (plural ? ' work on ' : ' works on ') : (plural ? ' do not work on ' : ' does not work on ')) + where;
  var body = details(id, tv, part) + '\n\n' + (works ? 'What I tried, and it worked:' : 'What happened:') + '\n';
  return REPO + '/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
}

// What a report says about the TV, as the issue's body opens with it and as
// the dashboard copies it for someone without a GitHub account.
function details(id, tv, part) {
  tv = tv || {};
  return [
    'Feature: ' + (part || FEATURES[id].title),
    'webOS: ' + (tv.webos || '?'),
    'Model: ' + (tv.model || '?'),
    'Firmware: ' + (tv.firmware || '?'),
    'Glasshouse: ' + (tv.glasshouse || '?')
  ].join('\n');
}

/*
 * What a dashboard needs to offer a feature on this TV: its standing, the
 * reason where it is not offered, and the links to report it where it is
 * untried. tv: { webos, model, firmware, glasshouse }; part as for issueUrl.
 */
function info(id, tv, part) {
  tv = tv || {};
  var f = FEATURES[id];
  var s = standing(id, tv.webos);
  var out = { standing: s, webos: tv.webos || null };
  if (s === 'unsupported') {
    var m = major(tv.webos);
    out.reason = f.from !== undefined && m < f.from ? f.tooOld() : f.tooNew();
  }
  if (s === 'untried') out.report = { problem: issueUrl(id, false, tv, part), works: issueUrl(id, true, tv, part), details: details(id, tv, part) };
  return out;
}

module.exports = { FEATURES: FEATURES, standing: standing, info: info, issueUrl: issueUrl, details: details, REPO: REPO };
