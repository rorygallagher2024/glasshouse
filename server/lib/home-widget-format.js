// The format admits data and drawing instructions, never uploaded code or URLs.
var ICONS = ['sun', 'moon', 'cloud', 'rain', 'snow', 'storm', 'wind', 'thermometer', 'drop', 'home', 'clock', 'chart', 'weather'];
var layout = require('../assets/widget-layout');
function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}
function number(value) { return typeof value === 'number' && isFinite(value) ? value : null; }
function field(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){0,3}$/.test(value)) return '';
  return value.split('.').some(function (part) { return /^(constructor|prototype|__proto__)$/.test(part); }) ? '' : value;
}
function values(raw, depth) {
  if (depth > 3) return null;
  if (raw === null || typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return text(raw, 100);
  if (typeof raw === 'number') return number(raw);
  if (Array.isArray(raw)) return raw.slice(0, 240).map(function (v) { return typeof v === 'number' ? number(v) : typeof v === 'string' ? text(v, 40) : null; });
  if (!raw || typeof raw !== 'object') return null;
  var out = {};
  Object.keys(raw).slice(0, 24).forEach(function (key) {
    if (field(key) && key.indexOf('.') === -1) out[key] = values(raw[key], depth + 1);
  });
  return out;
}
function component(raw) {
  if (!raw || ['text', 'icon', 'data', 'chart'].indexOf(raw.type) === -1) return null;
  var c = { type: raw.type, label: text(raw.label, 40) };
  if (raw.type === 'text') { c.text = text(raw.text, 100); return c.text ? c : null; }
  if (ICONS.indexOf(raw.icon) !== -1) c.icon = raw.icon;
  if (raw.type === 'icon') return c.icon ? c : null;
  c.field = field(raw.field);
  if (!c.field) return null;
  c.unit = text(raw.unit, 16);
  c.precision = raw.precision === 1 || raw.precision === 2 ? raw.precision : 0;
  if (raw.type === 'chart') {
    c.labels = field(raw.labels);
    c.style = raw.style === 'bar' ? 'bar' : 'line';
  }
  return c;
}
function components(raw, limit) {
  if (!Array.isArray(raw) || !raw.length || raw.length > limit) return null;
  var list = raw.map(component);
  return list.every(function (c) { return c !== null; }) ? list : null;
}
function custom(raw) {
  if (raw && raw.version === 3) return require('./home-widget-template').instance(raw);
  if (!raw || typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(raw.id) ||
      raw.id === 'clock' || raw.id === 'weather') return null;
  var name = text(raw.name, 40);
  if (!name) return null;
  if (raw.version === 1 && raw.type === 'text') {
    var value = text(raw.value, 40);
    return value ? { version: 1, type: 'text', id: raw.id, name: name, value: value,
      detail: text(raw.detail, 100), enabled: raw.enabled === true } : null;
  }
  if (raw.version !== 2 || raw.type !== 'components' || !raw.data ||
      ['static', 'weather', 'tv'].indexOf(raw.data.source) === -1 || Buffer.byteLength(JSON.stringify(raw), 'utf8') > 16384) return null;
  var compact = components(raw.components, 3), expanded = raw.expanded === undefined || Array.isArray(raw.expanded) && !raw.expanded.length ? [] : components(raw.expanded, 8);
  if (!compact || !expanded) return null;
  return { version: 2, type: 'components', id: raw.id, name: name, enabled: raw.enabled === true,
    data: { source: raw.data.source, values: raw.data.source === 'static' ? values(raw.data.values || {}, 0) : {} },
    components: compact, expanded: expanded };
}
function weatherActive(widgets) {
  return widgets.weather.enabled || widgets.custom.some(function (w) {
    w = require('./home-widget-template').display(w);
    return w.enabled && w.version === 2 && w.data.source === 'weather';
  });
}
module.exports = { text: text, field: field, values: values, custom: custom, weatherActive: weatherActive, placement: layout.placement };
