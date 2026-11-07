// Store templates are immutable snapshots; only settings belong to an instance.
var format = require('./home-widget-format');
var own = Object.prototype.hasOwnProperty;
var ID = /^[a-z][a-z0-9-]{0,39}$/;
var KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function validTarget(target, definition) {
  if (typeof target !== 'string') return false;
  if (/^(name|value|detail)$/.test(target)) return target === 'name' || definition.version === 1;
  if (/^data\.values\.[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(target)) {
    return definition.version === 2 && definition.data.source === 'static' && definition.data.values &&
      typeof definition.data.values === 'object' && !Array.isArray(definition.data.values) && !!format.field(target.slice(12));
  }
  var match = /^(components|expanded)\.([0-7])\.(text|label|field|unit|precision|style|icon)$/.exec(target);
  return !!(match && definition[match[1]] && definition[match[1]][Number(match[2])]);
}
function setTarget(definition, target, value) {
  var parts = target.split('.'), object = definition;
  for (var i = 0; i < parts.length - 1; i++) object = object[parts[i]];
  object[parts[parts.length - 1]] = value;
}
function settingValue(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : null;
  if (field.type === 'number') return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= field.min && value <= field.max ? value : null;
  if (typeof value !== 'string' || value.length > field.maxLength) return null;
  if (field.type === 'select' && !field.options.some(function (o) { return o.value === value; })) return null;
  return format.text(value, field.maxLength);
}
function setting(raw, definition) {
  if (!raw || typeof raw.key !== 'string' || !KEY.test(raw.key) || !validTarget(raw.target, definition) ||
      ['text', 'select', 'number', 'boolean'].indexOf(raw.type) === -1) return null;
  var result = { key: raw.key, label: format.text(raw.label, 60), type: raw.type, target: raw.target,
    maxLength: typeof raw.maxLength === 'number' ? Math.min(100, Math.max(1, Math.floor(raw.maxLength))) : 40 };
  if (!result.label || !isFinite(result.maxLength)) return null;
  if (raw.type === 'number') {
    result.min = typeof raw.min === 'number' && isFinite(raw.min) ? raw.min : -1000000;
    result.max = typeof raw.max === 'number' && isFinite(raw.max) ? raw.max : 1000000;
    if (result.min > result.max) return null;
  }
  if (raw.type === 'select') {
    if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 16) return null;
    result.options = raw.options.map(function (o) {
      return o && typeof o.value === 'string' && o.value.length <= result.maxLength && format.text(o.label, 60) ?
        { value: format.text(o.value, result.maxLength), label: format.text(o.label, 60) } : null;
    });
    if (result.options.some(function (o) { return !o; })) return null;
  }
  var value = settingValue(result, raw.default);
  if (value === null) return null;
  result.default = value;
  return result;
}
function resolve(template, settings, id, enabled) {
  var definition = copy(template.definition);
  template.fields.forEach(function (field) { setTarget(definition, field.target, settings[field.key]); });
  definition.id = id || template.id;
  definition.enabled = enabled === true;
  return format.custom(definition);
}
function template(raw) {
  if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.revision !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(raw.revision) ||
      !raw.definition || [1, 2].indexOf(raw.definition.version) === -1 || Buffer.byteLength(JSON.stringify(raw), 'utf8') > 12288) return null;
  var definition = format.custom(raw.definition);
  if (!definition || definition.id !== raw.id || !Array.isArray(raw.fields) || raw.fields.length > 10) return null;
  var result = { id: raw.id, revision: raw.revision, name: format.text(raw.name, 40),
    description: format.text(raw.description, 240), author: format.text(raw.author, 60),
    category: raw.category, definition: definition, fields: [], preview: format.values(raw.preview || {}, 0) };
  if (!result.name || !result.description || !result.author || ['weather', 'tv', 'personal'].indexOf(result.category) === -1) return null;
  var keys = [], targets = [], defaults = {};
  for (var i = 0; i < raw.fields.length; i++) {
    var field = setting(raw.fields[i], definition);
    if (!field || keys.indexOf(field.key) !== -1 || targets.indexOf(field.target) !== -1) return null;
    keys.push(field.key); targets.push(field.target); defaults[field.key] = field.default; result.fields.push(field);
  }
  result.definition.enabled = false;
  return resolve(result, defaults) ? result : null;
}
function instance(raw) {
  if (!raw || raw.version !== 3 || raw.type !== 'store' || typeof raw.id !== 'string' || !ID.test(raw.id) || raw.id === 'clock' || raw.id === 'weather') return null;
  var item = template(raw.template), settings = {};
  if (!item || !raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) return null;
  for (var i = 0; i < item.fields.length; i++) {
    var field = item.fields[i];
    var value = settingValue(field, own.call(raw.settings, field.key) ? raw.settings[field.key] : field.default);
    if (value === null) return null;
    settings[field.key] = value;
  }
  if (!resolve(item, settings, raw.id, raw.enabled)) return null;
  return { version: 3, type: 'store', id: raw.id, template: item, settings: settings, enabled: raw.enabled === true };
}
function display(widget) {
  return widget.version === 3 ? resolve(widget.template, widget.settings, widget.id, widget.enabled) : widget;
}
module.exports = { template: template, instance: instance, display: display };
