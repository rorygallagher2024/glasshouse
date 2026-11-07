var templates = require('./home-widget-template');
var msg = require('./say').msg;
var bundled = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../assets/widget-store/catalogue.json'), 'utf8'));
var SOURCES = [
  'https://raw.githubusercontent.com/rsm23/glasshouse/main/server/assets/widget-store/catalogue.json',
  'https://cdn.jsdelivr.net/gh/rsm23/glasshouse@main/server/assets/widget-store/catalogue.json'
];
var fetchJson, now, cached, fetchedAt, attemptedAt, loading, source, failed;
var CACHE_MS = 60 * 60000;
var RETRY_MS = 60000;

function catalogue(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.widgets) || !raw.widgets.length || raw.widgets.length > 64 ||
      Buffer.byteLength(JSON.stringify(raw), 'utf8') > 524288) return null;
  var ids = [], result = [];
  for (var i = 0; i < raw.widgets.length; i++) {
    var item = templates.template(raw.widgets[i]);
    if (!item || ids.indexOf(item.id) !== -1) return null;
    ids.push(item.id); result.push(item);
  }
  return result;
}
function reply(stale) {
  return { ok: true, widgets: cached, source: source, stale: stale, fetchedAt: fetchedAt };
}
function read(cb, refresh) {
  if (loading) { loading.push(cb); return; }
  if (!refresh && fetchedAt !== null && now() - fetchedAt < CACHE_MS) return cb(reply(false));
  if (attemptedAt !== null && now() - attemptedAt < RETRY_MS) return cb(reply(failed));
  loading = [cb]; attemptedAt = now();
  function finish(stale) {
    failed = stale;
    var callbacks = loading; loading = null;
    callbacks.forEach(function (done) { done(reply(stale)); });
  }
  function attempt(index) {
    fetchJson(SOURCES[index], function (error, raw) {
      var parsed = error ? null : catalogue(raw);
      if (!parsed) return index + 1 < SOURCES.length ? attempt(index + 1) : finish(true);
      cached = parsed; source = index === 0 ? 'github' : 'jsdelivr'; fetchedAt = now();
      finish(false);
    }, { maxBuffer: 524288 });
  }
  attempt(0);
}
function find(id) {
  for (var i = 0; i < cached.length; i++) if (cached[i].id === id) return cached[i];
  return null;
}
function nextId(widgets, packageId) {
  var base = packageId.slice(0, 34);
  for (var i = 1; i <= 9; i++) {
    var id = base + '-' + i;
    if (!widgets.custom.some(function (w) { return w.id === id; })) return id;
  }
  return null;
}
function newer(candidate, previous) {
  var next = candidate.split('.').map(Number), old = previous.split('.').map(Number);
  for (var i = 0; i < 3; i++) if (next[i] !== old[i]) return next[i] > old[i];
  return false;
}
function change(widgets, body) {
  if (!body || ['install', 'configure', 'update'].indexOf(body.action) === -1) return { error: 'invalid widget action' };
  var next = JSON.parse(JSON.stringify(widgets)), widget, item;
  if (body.action === 'install') {
    if (next.custom.length >= 8) return { error: msg('srv.widgetStore.limit', 'Remove a widget before installing another. Eight widgets can be saved.') };
    item = find(body.packageId);
    if (!item) return { error: msg('srv.widgetStore.missing', 'This widget is unavailable. Refresh the store and try again.') };
    widget = templates.instance({ version: 3, type: 'store', id: nextId(next, item.id), template: item, settings: body.settings || {}, enabled: false });
    if (!widget) return { error: 'invalid store template' };
    next.custom.push(widget); next.order.push(widget.id); next.positions[widget.id] = 'auto';
  } else {
    for (var i = 0; i < next.custom.length; i++) if (next.custom[i].id === body.id) widget = next.custom[i];
    if (!widget || widget.version !== 3) return { error: 'store widget expected' };
    if (body.action === 'update') {
      item = find(widget.template.id);
      if (!item) return { error: msg('srv.widgetStore.missing', 'This widget is unavailable. Refresh the store and try again.') };
      if (!newer(item.revision, widget.template.revision)) return { error: msg('srv.widgetStore.current', 'This widget is already up to date.') };
      if (widget.template.fields.some(function (previous) {
        return !item.fields.some(function (field) { return field.key === previous.key; });
      })) return { error: msg('srv.widgetStore.settings', 'Check the widget settings. The saved widget has not changed.') };
      var previousSource = widget.template.definition.data ? widget.template.definition.data.source : 'static';
      var nextSource = item.definition.data ? item.definition.data.source : 'static';
      if (widget.enabled && previousSource !== nextSource) return { error: msg('srv.widgetStore.permission', 'This update changes the data source. Switch the widget off before updating it.') };
      widget.template = item;
    } else widget.settings = body.settings;
    var normal = templates.instance(widget);
    if (!normal) return { error: msg('srv.widgetStore.settings', 'Check the widget settings. The saved widget has not changed.') };
    next.custom = next.custom.map(function (w) { return w.id === normal.id ? normal : w; });
  }
  return { widgets: next };
}
function init(opts) {
  opts = opts || {};
  fetchJson = opts.fetchJson || require('./fetch').getJson;
  now = opts.now || Date.now;
  cached = catalogue(bundled); source = 'bundled'; fetchedAt = null; attemptedAt = null; loading = null; failed = true;
}
init();
module.exports = { init: init, read: read, change: change, catalogue: catalogue, sources: SOURCES };
