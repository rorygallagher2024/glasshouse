(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).WidgetLayout = api;
})(typeof window === 'undefined' ? null : window, function () {
  var positions = ['left', 'center', 'right'];
  function custom(layout, id) {
    var list = layout.widgets.custom;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function enabled(layout, id) {
    if (id === 'clock') return layout.showClock !== false;
    if (id === 'weather') return layout.widgets.weather.enabled;
    var item = custom(layout, id);
    return !!(item && item.enabled);
  }
  function active(layout) { return layout.widgets.order.filter(function (id) { return enabled(layout, id); }); }
  function weather(layout, id) {
    if (id === 'weather') return true;
    var item = custom(layout, id);
    if (item && item.version === 3) item = item.template.definition;
    return !!(item && item.data && item.data.source === 'weather');
  }
  function requirements(layout, position) {
    var reasons = [], topPreview = layout.livePreview && !layout.previewInTile;
    if (position === 'center' && layout.showLastOn !== false) reasons.push('lastWatched');
    if (position === 'center' && layout.picture && topPreview) reasons.push('previewDetails');
    if (position === 'right' && layout.picture) reasons.push('picture');
    if (position === 'right' && topPreview) reasons.push('topPreview');
    return reasons;
  }
  function placement(layout) {
    var ids = active(layout), placed = {}, occupied = [], saved = layout.widgets.positions || {};
    var manual = ids.some(function (id) { return saved[id] && saved[id] !== 'auto'; });
    if (!manual) return { ok: true, manual: false, positions: {} };
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], position = saved[id] || 'auto';
      if (position === 'auto') continue;
      if (requirements(layout, position).length || occupied.indexOf(position) !== -1 || positions.indexOf(position) === -1) return { ok: false };
      occupied.push(position); placed[id] = position;
    }
    for (var j = 0; j < ids.length; j++) {
      var next = ids[j];
      if (placed[next]) continue;
      var free = positions.filter(function (p) { return !requirements(layout, p).length && occupied.indexOf(p) === -1; })[0];
      if (!free) return { ok: false };
      placed[next] = free; occupied.push(free);
    }
    return { ok: true, manual: true, positions: placed };
  }
  function unique(list) { return list.filter(function (value, i) { return list.indexOf(value) === i; }); }
  function validate(layout) {
    var ids = active(layout), reasons = [];
    if (ids.length > 3) reasons.push('tooMany');
    if (ids.length > 2) positions.forEach(function (p) { reasons = reasons.concat(requirements(layout, p)); });
    ids.forEach(function (id) { reasons = reasons.concat(requirements(layout, (layout.widgets.positions || {})[id])); });
    if (ids.some(function (id) { return weather(layout, id); }) && !layout.widgets.weather.location) reasons.push('weatherLocation');
    if (!placement(layout).ok && !reasons.length) reasons.push('capacity');
    return unique(reasons);
  }
  function plan(layout, id, position) {
    if (layout.widgets.order.indexOf(id) === -1 || positions.indexOf(position) === -1) return { ok: false, reasons: ['missing'] };
    var reasons = requirements(layout, position);
    if (!enabled(layout, id)) reasons.push('off');
    if (weather(layout, id) && !layout.widgets.weather.location) reasons.push('weatherLocation');
    var next = JSON.parse(JSON.stringify(layout)), previous = placement(layout);
    next.widgets.positions = next.widgets.positions || {};
    if (previous.ok && previous.manual) {
      Object.keys(previous.positions).forEach(function (key) {
        next.widgets.positions[key] = previous.positions[key];
        if (key !== id && previous.positions[key] === position) next.widgets.positions[key] = previous.positions[id];
      });
    }
    next.widgets.positions[id] = position;
    reasons = unique(reasons.concat(validate(next)));
    return reasons.length ? { ok: false, reasons: reasons } :
      { ok: true, reasons: [], widgets: next.widgets, positions: placement(next).positions };
  }
  function reorder(layout, id, target, after) {
    var next = JSON.parse(JSON.stringify(layout.widgets)), order = next.order;
    if (id === target || order.indexOf(id) === -1 || order.indexOf(target) === -1) return next;
    order.splice(order.indexOf(id), 1);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
    return next;
  }
  return { enabled: enabled, active: active, requirements: requirements, placement: placement, validate: validate, plan: plan, reorder: reorder };
});
