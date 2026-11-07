(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var I18N = /** @type {any} */ (window).I18N;
  var paths = {
    sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    moon: 'M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5',
    cloud: 'M6 18a4 4 0 0 1-1-7.9A6 6 0 0 1 17 9a4.5 4.5 0 0 1 1 9H6',
    rain: 'M5 14a3 3 0 0 1-1-5.8A5 5 0 0 1 14 7a4 4 0 0 1 4 7H5m2 3-1 3m6-3-1 3m6-3-1 3',
    snow: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 3 3-3M9 19l3-3 3 3',
    storm: 'M5 13a3 3 0 0 1-1-5.8A5 5 0 0 1 14 5a4 4 0 0 1 4 8h-2m-4-2-4 6h4l-2 5 7-8h-4l2-3',
    wind: 'M3 8h12a3 3 0 1 0-3-3M3 12h16a2 2 0 1 0-2-2M3 16h9a3 3 0 1 1-3 3',
    thermometer: 'M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0m3-8v12',
    drop: 'M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13',
    home: 'M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l4 2',
    chart: 'M3 3v18h18M6 16l4-6 5 3 5-8'
  };
  function node(tag, cls, value) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (value !== undefined) el.textContent = String(value);
    return el;
  }
  function svgNode(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (key) { el.setAttribute(key, String(attrs[key])); });
    return el;
  }
  function field(data, key) {
    if (!data || typeof key !== 'string' || !key) return null;
    var parts = key.split('.'), value = data;
    for (var i = 0; i < parts.length; i++) {
      if (!value || typeof value !== 'object' || /^(constructor|prototype|__proto__)$/.test(parts[i]) ||
          !Object.prototype.hasOwnProperty.call(value, parts[i])) return null;
      value = value[parts[i]];
    }
    return value;
  }
  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function unit(key, data) {
    return data && data.units && typeof data.units[key] === 'string' ? data.units[key] : key || '';
  }
  function value(raw, precision, suffix) {
    var v = finite(raw) ? raw.toFixed(precision || 0) : typeof raw === 'string' || typeof raw === 'boolean' ? String(raw) : '–';
    return v + (v !== '–' && suffix ? ' ' + suffix : '');
  }
  function weatherIcon(code, day) {
    if (code === 0) return day === false ? 'moon' : 'sun';
    if (code >= 95) return 'storm';
    if (code >= 71 && code <= 77 || code === 85 || code === 86) return 'snow';
    if (code >= 51 && code <= 67 || code >= 80 && code <= 82) return 'rain';
    return 'cloud';
  }
  function icon(name, data) {
    if (name === 'weather') name = weatherIcon(data && data.current && data.current.code, data && data.current && data.current.isDay);
    var svg = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(svgNode('path', { d: paths[name] || paths.chart, fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return svg;
  }
  function chart(raw, labels, options) {
    options = options || {};
    var list = Array.isArray(raw) ? raw.slice(0, 240) : [], valid = list.filter(finite);
    var box = node('div', 'wk-chart');
    var caption = options.label || '', suffix = options.unit || '';
    var top = node('div', 'wk-chart-caption', caption);
    box.appendChild(top);
    if (!valid.length) {
      box.appendChild(node('div', 'wk-empty', I18N.t('home.widgets.noData', 'No data available')));
      return box;
    }
    var minimum = Math.min.apply(Math, valid), maximum = Math.max.apply(Math, valid);
    top.appendChild(node('span', 'wk-range', value(minimum, options.precision, suffix) + ' · ' + value(maximum, options.precision, suffix)));
    var small = options.compact, width = small ? 320 : 800, height = small ? 34 : 166;
    var left = small ? 2 : 52, right = width - 8, base = small ? 32 : 132, upper = 8;
    var low = options.style === 'bar' ? Math.min(0, minimum) : minimum;
    var high = options.style === 'bar' ? Math.max(0, maximum) : maximum;
    var span = high - low || 1;
    function y(v) { return high === low ? (upper + base) / 2 : base - (v - low) / span * (base - upper); }
    function x(i) {
      if (options.style === 'bar') return left + (i + .5) / list.length * (right - left);
      return list.length <= 1 ? (left + right) / 2 : left + i / (list.length - 1) * (right - left);
    }
    var svg = svgNode('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': caption + ': ' + top.textContent });
    if (!small) [upper, (upper + base) / 2, base].forEach(function (line) {
      svg.appendChild(svgNode('line', { x1: left, x2: right, y1: line, y2: line, stroke: 'currentColor', opacity: .15 }));
    });
    var segment = [];
    function flush() {
      if (!segment.length) return;
      svg.appendChild(svgNode('polyline', { points: segment.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': small ? 2 : 3 }));
      segment = [];
    }
    list.forEach(function (v, i) {
      if (!finite(v)) { flush(); return; }
      if (options.style === 'bar') {
        var zero = y(0), size = Math.max(1, (right - left) / Math.max(1, list.length) * .6);
        svg.appendChild(svgNode('rect', { x: x(i) - size / 2, y: Math.min(zero, y(v)), width: size, height: Math.max(1, Math.abs(y(v) - zero)), fill: 'currentColor' }));
      } else {
        segment.push(x(i).toFixed(2) + ',' + y(v).toFixed(2));
        svg.appendChild(svgNode('circle', { cx: x(i), cy: y(v), r: small ? 1.3 : 2.5, fill: 'currentColor' }));
      }
    });
    flush();
    if (!small) {
      [[high, upper], [low, base]].forEach(function (pair) {
        var label = svgNode('text', { x: left - 8, y: pair[1] + 5, 'text-anchor': 'end', fill: 'currentColor' });
        label.textContent = Number(pair[0]).toFixed(options.precision || 0); svg.appendChild(label);
      });
      if (Array.isArray(labels)) [0, Math.floor((list.length - 1) / 2), list.length - 1].filter(function (i, n, a) { return a.indexOf(i) === n; }).forEach(function (i) {
        var label = svgNode('text', { x: x(i), y: 158, 'text-anchor': i === 0 ? 'start' : i === list.length - 1 ? 'end' : 'middle', fill: 'currentColor' });
        label.textContent = typeof labels[i] === 'string' ? labels[i] : ''; svg.appendChild(label);
      });
    }
    box.appendChild(svg);
    return box;
  }
  function component(c, data, compact) {
    var box = node('div', 'wk-component wk-' + c.type);
    if (c.type === 'text') { box.textContent = c.text; return box; }
    if (c.type === 'chart') return chart(field(data, c.field), field(data, c.labels), {
      label: c.label, unit: unit(c.unit, data), precision: c.precision, style: c.style, compact: compact });
    if (c.icon) box.appendChild(icon(c.icon, data));
    if (c.type === 'icon') { box.appendChild(node('span', '', c.label)); return box; }
    var words = node('div', 'wk-data-text');
    if (c.label) words.appendChild(node('span', 'wk-data-label', c.label));
    words.appendChild(node('strong', 'wk-data-value', value(field(data, c.field), c.precision, unit(c.unit, data))));
    box.appendChild(words);
    return box;
  }
  function render(host, components, data, compact) {
    host.innerHTML = '';
    (components || []).forEach(function (c) { host.appendChild(component(c, data, compact)); });
  }
  /** @type {any} */ (window).WidgetKit = { node: node, icon: icon, chart: chart, render: render, field: field, value: value };
})();
