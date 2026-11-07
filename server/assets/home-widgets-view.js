(function () {
  var kit = /** @type {any} */ (window).WidgetKit, I18N = /** @type {any} */ (window).I18N;
  var createPanel = /** @type {any} */ (window).CreateWidgetPanel;
  var layout = null, config = null, signature = '', revision = 0, paused = false, list = [];
  var sources = { weather: null, tv: null }, requests = {}, timers = {};
  var onSaved = function (_reply) {}, onOpen = function (_open) {};
  var canInteract = function () { return true; };
  function el(id) { return document.getElementById(id); }
  function json(method, url, body, cb) {
    var x = new XMLHttpRequest(), finished = false;
    x.open(method, url, true); x.timeout = 20000;
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    function done(result) { if (finished) return; finished = true; cb(result); }
    x.onload = function () {
      var result = null; try { result = JSON.parse(x.responseText); } catch (e) {}
      done(x.status >= 200 && x.status < 300 ? result : { ok: false, error: result && result.error });
    };
    x.onerror = x.ontimeout = function () { done(null); };
    x.send(body ? JSON.stringify(body) : null); return x;
  }
  function stop() {
    Object.keys(timers).forEach(function (source) { clearTimeout(timers[source]); }); timers = {};
    Object.keys(requests).forEach(function (source) { requests[source].abort(); }); requests = {};
  }
  function used(source) { return list.some(function (w) { return w.source === source; }); }
  function read(source) {
    if (paused || document.hidden || !config || !used(source) || requests[source]) return;
    var version = revision;
    requests[source] = json('GET', source === 'weather' ? '/api/home/widgets/weather' : '/api/stats', null, function (data) {
      if (version !== revision || paused || document.hidden) return;
      delete requests[source];
      sources[source] = data && data.ok !== false ? data : source === 'weather' ? { available: false } : null;
      paintData();
      var wait = source === 'tv' ? 60000 : data && data.available && !data.stale ? 15 * 60000 : 5 * 60000;
      timers[source] = setTimeout(function () { read(source); }, wait);
    });
  }
  function condition(code) {
    if (code === 0) return I18N.t('home.widgets.clear', 'Clear');
    if (code <= 3) return I18N.t('home.widgets.cloudy', 'Cloudy');
    if (code === 45 || code === 48) return I18N.t('home.widgets.fog', 'Fog');
    if (code >= 71 && code <= 77 || code === 85 || code === 86) return I18N.t('home.widgets.snow', 'Snow');
    if (code >= 95) return I18N.t('home.widgets.storm', 'Thunderstorm');
    if (code >= 51 && code <= 67 || code >= 80 && code <= 82) return I18N.t('home.widgets.rain', 'Rain');
    return I18N.t('home.widgets.weather', 'Weather');
  }
  function dataFor(w) {
    return w.source === 'static' ? w.values : w.source === 'weather' ? sources.weather && sources.weather.available ? sources.weather : null : sources.tv;
  }
  function paintWeather(w) {
    var data = sources.weather, available = data && data.available, current = available ? data.current || { temperature: data.temperature, code: data.code } : {};
    var units = data && data.units || { temperature: config.weather.units === 'fahrenheit' ? '°F' : '°C', wind: config.weather.windUnits === 'mph' ? 'mph' : 'km/h' };
    var body = w.element.querySelector('.widget-body'); body.innerHTML = '';
    var summary = kit.node('div', 'widget-weather-summary');
    if (available) summary.appendChild(kit.icon('weather', { current: current }));
    summary.appendChild(kit.node('div', 'widget-value', available ? Math.round(current.temperature) + units.temperature : '–'));
    summary.appendChild(kit.node('div', 'widget-detail', available ? condition(current.code) : data === null ? I18N.t('home.widgets.loading', 'Loading weather…') : I18N.t('home.widgets.unavailable', 'Weather unavailable')));
    body.appendChild(summary);
    var today = available && data.today || {};
    body.appendChild(kit.chart(today.temperature, today.labels, { label: I18N.t('home.widgets.todayTemperature', 'Today’s temperature'), unit: units.temperature, compact: true }));
    body.appendChild(kit.chart(today.wind, today.labels, { label: I18N.t('home.widgets.todayWind', 'Today’s wind'), unit: units.wind, compact: true, style: 'bar' }));
    var status = w.element.querySelector('.widget-status');
    status.textContent = available && data.stale ? I18N.t('home.widgets.outdated', 'Last available weather') : '';
    w.data = data;
  }
  function paintData() {
    list.forEach(function (w) {
      if (w.weather) paintWeather(w);
      else if (w.components) {
        w.data = dataFor(w);
        kit.render(w.element.querySelector('.widget-body'), w.components, w.data, true);
        w.element.querySelector('.widget-status').textContent = w.data && w.data.stale ? I18N.t('home.widgets.outdated', 'Last available weather') : '';
      }
    });
    panel.refresh();
  }
  function move(id, direction, done) {
    var settings = JSON.parse(JSON.stringify(config)), positions = settings.positions || {}, names = ['left', 'center', 'right'];
    list.forEach(function (w, i) { positions[w.id] = layout.widgetPlacement && layout.widgetPlacement.positions[w.id] || (positions[w.id] !== 'auto' && positions[w.id]) || names[i]; });
    var from = names.indexOf(positions[id]), to = Math.max(0, Math.min(2, from + direction));
    list.forEach(function (w) { if (w.id !== id && positions[w.id] === names[to]) positions[w.id] = names[from]; });
    positions[id] = names[to]; settings.positions = positions;
    json('POST', '/api/home/layout', { widgets: settings }, function (reply) {
      if (!reply || !reply.ok) return done(reply && reply.error || I18N.t('home.widgets.saveFailed', 'The widget could not be saved.'));
      onSaved(reply); done(null);
    });
  }
  var panel = createPanel({ items: function () { return list; }, move: move, changed: function (open) { onOpen(open); } });
  function addWidget(w, host) {
    var box = kit.node('div', 'home-widget' + (w.weather || w.components ? ' widget-rich' : ''));
    box.id = 'widget-' + w.id;
    box.appendChild(kit.node('div', 'widget-name', w.title));
    var body = kit.node('div', 'widget-body'); box.appendChild(body);
    if (!w.weather && !w.components) { body.appendChild(kit.node('div', 'widget-value', w.value)); body.appendChild(kit.node('div', 'widget-detail', w.detail || '')); }
    box.appendChild(kit.node('div', 'widget-status'));
    host.appendChild(box); w.element = box; list.push(w);
  }
  function render(nextLayout) {
    var settings = nextLayout && nextLayout.widgets || { order: ['clock', 'weather'], positions: {}, weather: { enabled: false }, custom: [] };
    var next = JSON.stringify([settings, !nextLayout || nextLayout.showClock !== false, nextLayout && nextLayout.widgetPlacement]);
    layout = nextLayout;
    if (signature === next) return;
    signature = next; revision++; stop();
    if (!config || JSON.stringify(config.weather) !== JSON.stringify(settings.weather)) sources.weather = null;
    config = settings;
    var host = el('widgets'), clock = el('when'); host.removeChild(clock); host.innerHTML = ''; list = [];
    (settings.order || ['clock', 'weather']).forEach(function (id) {
      if (list.length >= 3) return;
      if (id === 'clock') {
        if (!nextLayout || nextLayout.showClock !== false) { clock.style.display = ''; host.appendChild(clock); list.push({ id: id, title: I18N.t('home.showClock', 'Clock and date'), element: clock }); }
        return;
      }
      if (id === 'weather' && settings.weather.enabled) return addWidget({ id: id, title: settings.weather.location && settings.weather.location.name || I18N.t('home.widgets.weather', 'Weather'), weather: true, source: 'weather' }, host);
      var custom = settings.custom || [];
      for (var i = 0; i < custom.length; i++) {
        var w = custom[i]; if (w.id !== id || !w.enabled) continue;
        addWidget({ id: id, title: w.name, value: w.value, detail: w.detail, components: w.components, expanded: w.expanded,
          source: w.data && w.data.source, values: w.data && w.data.values }, host);
      }
    });
    if (!clock.parentNode) { clock.style.display = 'none'; host.appendChild(clock); }
    var placement = nextLayout && nextLayout.widgetPlacement;
    el('now').classList.toggle('widgets-two', list.length >= 2);
    el('now').classList.toggle('widget-positioned', !!(placement && placement.manual));
    list.forEach(function (w) {
      var pos = placement && placement.manual && placement.positions[w.id] || 'auto';
      w.element.setAttribute('data-position', pos); w.element.setAttribute('role', 'button'); w.element.setAttribute('aria-label', w.title); w.element.tabIndex = 0;
      w.element.onfocus = function () { if (canInteract()) panel.focus(w.id); };
      w.element.onmouseenter = function () { if (canInteract()) panel.focus(w.id); };
      w.element.onclick = function (e) { e.stopPropagation(); if (canInteract()) panel.open(w.id); };
    });
    if (placement && placement.manual) list.sort(function (a, b) { return a.element.offsetLeft - b.element.offsetLeft; });
    paintData(); read('weather'); read('tv');
  }
  /** @type {any} */ (window).GlasshouseWidgets = {
    render: render, key: panel.key, focus: panel.focus, blur: panel.blur, isOpen: panel.isOpen,
    configure: function (options) { onSaved = options.saved; onOpen = options.opened; canInteract = options.canInteract; },
    scroll: panel.scroll,
    reset: panel.reset,
    covered: function (on) { if (paused === on) return; paused = on; revision++; stop(); if (on) panel.reset(); else { read('weather'); read('tv'); } }
  };
  document.addEventListener('visibilitychange', function () {
    revision++; stop(); if (document.hidden) panel.reset(); else { read('weather'); read('tv'); }
  });
  window.addEventListener('pagehide', function () { revision++; stop(); panel.reset(); });
})();
