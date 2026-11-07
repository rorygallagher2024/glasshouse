(function () {
  var kit = /** @type {any} */ (window).WidgetKit;
  var I18N = /** @type {any} */ (window).I18N;
  function create(options) {
    var selected = '', opened = '', arranging = false, timer = null, longPress = false, held = {}, panel = null, busy = false;
    function items() { return options.items(); }
    function item(id) { var all = items(); for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i]; return null; }
    function paintFocus() {
      items().forEach(function (w) { w.element.classList.toggle('widget-focus', w.id === selected); });
      document.body.classList.toggle('widget-focused', !!selected);
    }
    function message(text) {
      var el = document.getElementById('widget-message');
      if (!el) { el = kit.node('div', 'widget-message'); el.id = 'widget-message'; document.getElementById('stage').appendChild(el); }
      el.textContent = text;
    }
    function arrange() {
      arranging = true;
      message(I18N.t('home.widgets.arrangeHelp', 'Left/right move. OK finishes. Centre needs Last watched off; right needs Picture details and the top live preview off.'));
    }
    function focus(id) {
      if (opened) return true;
      var target = item(id) || items()[0];
      if (!target) return false;
      selected = target.id; paintFocus();
      if (!arranging) message(I18N.t('home.widgets.focusHelp', 'OK selects. Hold OK to move. Down returns to the rows.'));
      return true;
    }
    function blur() {
      if (opened) return;
      selected = ''; arranging = false; clearTimeout(timer); message(''); paintFocus();
    }
    function close() {
      if (panel) { panel.parentNode.removeChild(panel); panel = null; }
      opened = ''; document.body.classList.remove('widget-expanded');
      options.changed(false); paintFocus();
      var w = item(selected); if (w) w.element.focus();
    }
    function dayLabel(day) {
      try {
        var p = day.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
        return new Intl.DateTimeFormat(I18N.lang(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
      } catch (e) { return day; }
    }
    function weather(host, data) {
      if (!data || !data.available) { host.appendChild(kit.node('p', 'wk-empty', I18N.t('home.widgets.unavailable', 'Weather unavailable'))); return; }
      var units = data.units || { temperature: '°C', wind: 'km/h' }, today = data.today || {};
      if (data.stale) host.appendChild(kit.node('p', 'wp-status', I18N.t('home.widgets.outdated', 'Last available weather')));
      var charts = kit.node('div', 'wp-charts');
      charts.appendChild(kit.chart(today.temperature, today.labels, { label: I18N.t('home.widgets.todayTemperature', 'Today’s temperature'), unit: units.temperature }));
      charts.appendChild(kit.chart(today.wind, today.labels, { label: I18N.t('home.widgets.todayWind', 'Today’s wind'), unit: units.wind, style: 'bar' }));
      host.appendChild(charts);
      host.appendChild(kit.node('h2', '', I18N.t('home.widgets.forecast', '10-day forecast')));
      var days = kit.node('div', 'wp-days');
      (data.daily || []).forEach(function (day) {
        var card = kit.node('div', 'wp-day');
        card.appendChild(kit.node('div', 'wp-day-date', dayLabel(day.date)));
        card.appendChild(kit.icon('weather', { current: { code: day.code, isDay: true } }));
        card.appendChild(kit.node('div', 'wp-high', kit.value(day.high, 0, units.temperature)));
        card.appendChild(kit.node('div', 'wp-low', kit.value(day.low, 0, units.temperature)));
        var wind = kit.node('div', 'wp-day-metric'); wind.appendChild(kit.icon('wind')); wind.appendChild(kit.node('span', '', kit.value(day.wind, 0, units.wind))); card.appendChild(wind);
        var rain = kit.node('div', 'wp-day-metric'); rain.appendChild(kit.icon('drop')); rain.appendChild(kit.node('span', '', kit.value(day.rain, 0, '%'))); card.appendChild(rain);
        days.appendChild(card);
      });
      if (!days.childNodes.length) days.appendChild(kit.node('p', 'wk-empty', I18N.t('home.widgets.noForecast', 'Forecast unavailable')));
      host.appendChild(days);
      host.appendChild(kit.node('p', 'wp-foot', I18N.t('home.widgets.forecastLegend', 'Daily high / low · Maximum wind · Rain probability. Forecasts use the selected city’s local day.')));
    }
    function refresh() {
      if (selected && !item(selected) && !opened) blur();
      paintFocus();
      if (!opened) return;
      var w = item(opened);
      if (!w) return close();
      var host = panel.querySelector('.wp-content'), scroll = host.scrollTop;
      host.innerHTML = '';
      if (w.weather) weather(host, w.data);
      else {
        if (w.data && w.data.stale) host.appendChild(kit.node('p', 'wp-status', I18N.t('home.widgets.outdated', 'Last available weather')));
        var content = kit.node('div', 'wp-components');
        kit.render(content, w.expanded.length ? w.expanded : w.components, w.data || {}, false);
        host.appendChild(content);
      }
      host.scrollTop = scroll;
    }
    function open(id) {
      var w = item(id);
      if (!w) return;
      focus(id);
      if (!w.weather && !w.components) return arrange();
      opened = id;
      message('');
      panel = kit.node('section', 'widget-panel'); panel.id = 'widget-panel';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'widget-panel-title');
      var header = kit.node('div', 'wp-header');
      var title = kit.node('h1', '', w.title); title.id = 'widget-panel-title'; header.appendChild(title);
      var button = kit.node('button', 'wp-close', I18N.t('home.widgets.close', 'Close'));
      button.type = 'button'; button.onclick = function (e) { e.stopPropagation(); close(); };
      header.appendChild(button); panel.appendChild(header); panel.appendChild(kit.node('div', 'wp-content'));
      panel.onclick = function (e) { e.stopPropagation(); };
      document.getElementById('stage').appendChild(panel);
      document.body.classList.add('widget-expanded'); options.changed(true); refresh(); button.focus();
    }
    function key(e, up) {
      var code = e.keyCode;
      if (up && held[code]) {
        var panelPress = held[code] === 'panel';
        delete held[code]; e.preventDefault();
        if (code === 13 && !panelPress) { clearTimeout(timer); if (!longPress && !opened) { if (arranging) { arranging = false; message(''); } else open(selected); } }
        return true;
      }
      if (!selected && !opened) return false;
      if (up) return false;
      if (code === 9 && !opened) return false;
      e.preventDefault();
      if (held[code]) return true;
      held[code] = opened ? 'panel' : true;
      if (code === 461 || code === 27) { if (opened) close(); else if (arranging) { arranging = false; message(''); } else blur(); return true; }
      if (opened) {
        var content = panel.querySelector('.wp-content');
        if (code === 38 || code === 40) content.scrollTop += code === 38 ? -180 : 180;
        if (code === 13) close();
        return true;
      }
      if (code === 13) {
        longPress = false;
        timer = setTimeout(function () { longPress = true; arrange(); }, 800);
      } else if (code === 40) blur();
      else if (code === 37 || code === 39) {
        var direction = code === 37 ? -1 : 1;
        if (arranging) {
          if (!busy) {
            busy = true;
            options.move(selected, direction, function (error) {
              busy = false;
              if (error) message(error);
              else message(I18N.t('home.widgets.arrangeHelp', 'Left/right move. OK finishes. Centre needs Last watched off; right needs Picture details and the top live preview off.'));
            });
          }
        } else {
          var all = items(), index = 0;
          for (var i = 0; i < all.length; i++) if (all[i].id === selected) index = i;
          focus(all[Math.max(0, Math.min(all.length - 1, index + direction))].id);
        }
      }
      return true;
    }
    return { focus: focus, blur: blur, open: open, close: close, refresh: refresh, key: key, isOpen: function () { return !!opened; },
      scroll: function (delta) { if (!opened) return false; panel.querySelector('.wp-content').scrollTop += delta > 0 ? 180 : -180; return true; },
      reset: function () { clearTimeout(timer); held = {}; close(); blur(); } };
  }
  /** @type {any} */ (window).CreateWidgetPanel = create;
})();
