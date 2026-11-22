/*
 * lib/clock.js - whether the clocks Glasshouse draws use 12-hour time
 *
 * Reads and sets systemservice's timeFormat preference, HH12 or HH24 (seeded
 * as HH12 in /etc/palm/defaultPreferences.txt on webOS 4 and 9, with no switch
 * in LG's own Settings menu, #934). A TV that gives none keeps 24-hour time.
 *
 * Read at start and again at most once a minute while something asks, so the
 * answer to hour12() is always at hand and never waits on the TV.
 *
 * The TV's menu language too (settingsservice localeInfo.locales.UI, such as
 * sv-SE), for the clock screen savers' dates: they run in LG's screen saver
 * app, whose QML locale stays en_US whatever the TV's language, so
 * Qt.formatDate gave "Sunday 22 November" on a TV set to Swedish (webOS 11.1).
 *
 * Strict ES5: runs on node 0.12.
 */
var STALE_MS = 60000;

var lunaFn = null;
/** @type {function(boolean): void} */
var onChangeFn = function () {};
var is12 = false;
var readAt = 0;
var reading = false;
var uiLocale = '';

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna || null;
  onChangeFn = opts.onChange || function () {};
  is12 = false;
  readAt = 0;
  reading = false;
  uiLocale = '';
}

// Reads the TV's setting; cb(hour12) once it has answered, or at once without luna.
function refresh(cb) {
  cb = cb || function () {};
  if (!lunaFn || reading) return cb(is12);
  reading = true;
  // A C6 (webOS 11.1) answers category "option" without localeInfo, and
  // without a category with it.
  readLocale({ category: 'option', keys: ['localeInfo'] }, function (found) {
    if (!found) readLocale({ keys: ['localeInfo'] }, function () {});
  });
  lunaFn('com.webos.service.systemservice/getPreferences', { keys: ['timeFormat'] }, function (r) {
    reading = false;
    readAt = Date.now();
    var format = r && typeof r.timeFormat === 'string' ? r.timeFormat : null;
    if (format) {
      var next = format === 'HH12';
      if (next !== is12) {
        is12 = next;
        onChangeFn(is12);
      }
    }
    cb(is12);
  });
}

/*
 * Writes the TV's timeFormat preference (HH12 or HH24), updates the cached
 * answer at once and notifies onChangeFn when it changed.
 */
function set(on, cb, fallbackLuna) {
  cb = cb || function () {};
  var call = lunaFn || fallbackLuna;
  if (!call) return cb({ ok: false });
  var next = on === true || on === 'on' || on === 'ON' || on === 'true' || on === '12' || on === 'HH12';
  call('com.webos.service.systemservice/setPreferences',
    { timeFormat: next ? 'HH12' : 'HH24' },
    function (r) {
      if (!r || !r.returnValue) return cb({ ok: false });
      readAt = Date.now();
      if (next !== is12) {
        is12 = next;
        onChangeFn(is12);
      }
      cb({ ok: true, clockHour12: is12 });
    });
}

// The last answer; one older than a minute is read again for next time.
function hour12() {
  if (Date.now() - readAt > STALE_MS) refresh();
  return is12;
}

// The TV's menu language as Qt names a locale, sv_SE, or '' before it is known.
// cb(true) once localeInfo.locales.UI has been read from this payload.
function readLocale(payload, cb) {
  lunaFn('com.webos.settingsservice/getSystemSettings', payload, function (l) {
    var locales = l && l.settings && l.settings.localeInfo && l.settings.localeInfo.locales;
    var ui = locales && typeof locales.UI === 'string' ? locales.UI : '';
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})*$/.test(ui)) return cb(false);
    if (ui !== uiLocale) {
      uiLocale = ui;
      onChangeFn(is12);
    }
    cb(true);
  });
}

function qtLocale() {
  if (Date.now() - readAt > STALE_MS) refresh();
  return uiLocale.replace(/-/g, '_');
}

module.exports = {
  init: init,
  refresh: refresh,
  set: set,
  hour12: hour12,
  qtLocale: qtLocale
};
