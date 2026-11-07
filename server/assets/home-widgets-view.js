/* Fixed-size, non-interactive widgets leave the remote's focus on Home's rows. */
(function () {
  var I18N = /** @type {any} */ (window).I18N;
  var config = null, signature = '', timer = null, request = null, revision = 0, paused = false;
  function el(id) { return document.getElementById(id); }
  function line(parent, cls, value) {
    var node = document.createElement('div');
    node.className = cls;
    node.textContent = value;
    parent.appendChild(node);
    return node;
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
  function stop() {
    clearTimeout(timer);
    timer = null;
    if (request) { request.abort(); request = null; }
  }
  function updateWeather() {
    if (paused || document.hidden || !config || !config.weather.enabled || !el('widget-weather')) return;
    var version = revision;
    var x = new XMLHttpRequest();
    request = x;
    x.open('GET', '/api/home/widgets/weather', true);
    x.timeout = 15000;
    var finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      if (version !== revision || paused || document.hidden) return;
      request = null;
      var box = el('widget-weather');
      if (!box) return;
      var available = result && result.available;
      box.querySelector('.widget-value').textContent = available ? Math.round(result.temperature) +
        (config.weather.units === 'fahrenheit' ? '°F' : '°C') : '–';
      box.querySelector('.widget-detail').textContent = available ? condition(result.code) : I18N.t('home.widgets.unavailable', 'Weather unavailable');
      box.querySelector('.widget-status').textContent = available && result.stale ? I18N.t('home.widgets.outdated', 'Last available weather') : '';
      timer = setTimeout(updateWeather, available && !result.stale ? 15 * 60000 : 5 * 60000);
    }
    x.onload = function () {
      var result = null;
      try { result = JSON.parse(x.responseText); } catch (e) {}
      finish(x.status === 200 ? result : null);
    };
    x.onerror = x.ontimeout = function () { finish(null); };
    x.send(null);
  }
  function render(layout) {
    var settings = layout && layout.widgets || { order: ['clock', 'weather'], weather: { enabled: false }, custom: [] };
    var next = JSON.stringify([settings, !layout || layout.showClock !== false]);
    if (next === signature) return;
    signature = next;
    revision++;
    stop();
    config = settings;
    var host = el('widgets'), clock = el('when');
    // Keep the clock nodes: Home's own time and date formatting updates them.
    host.removeChild(clock);
    host.innerHTML = '';
    var count = 0, custom = settings.custom || [];
    (settings.order || ['clock', 'weather']).forEach(function (id) {
      if (count >= 2) return;
      if (id === 'clock') {
        if (!layout || layout.showClock !== false) { host.appendChild(clock); count++; }
        return;
      }
      var w = null;
      for (var i = 0; i < custom.length; i++) if (custom[i].id === id) w = custom[i];
      if (id === 'weather' && settings.weather.enabled) w = { name: settings.weather.location && settings.weather.location.name,
        value: '–', detail: I18N.t('home.widgets.loading', 'Loading weather…') };
      else if (!w || !w.enabled) return;
      var box = document.createElement('div');
      box.className = 'home-widget';
      box.id = 'widget-' + id;
      line(box, 'widget-name', w.name || I18N.t('home.widgets.weather', 'Weather'));
      line(box, 'widget-value', w.value);
      line(box, 'widget-detail', w.detail || '');
      if (id === 'weather') line(box, 'widget-status', '');
      host.appendChild(box);
      count++;
    });
    if (!clock.parentNode) { clock.style.display = 'none'; host.appendChild(clock); }
    else clock.style.display = '';
    el('now').classList.toggle('widgets-two', count === 2);
    updateWeather();
  }
  /** @type {any} */ (window).GlasshouseWidgets = {
    render: render,
    covered: function (on) {
      if (paused === on) return;
      paused = on;
      revision++;
      stop();
      if (!on) updateWeather();
    }
  };
  document.addEventListener('visibilitychange', function () {
    revision++;
    stop();
    if (!document.hidden) updateWeather();
  });
  window.addEventListener('pagehide', stop);
})();
