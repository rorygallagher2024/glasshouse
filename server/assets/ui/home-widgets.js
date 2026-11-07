let homeWidgetLocations = [];
let homeWidgetSearchBusy = false;
let homeWidgetQuery = '';
let homeWidgetNote = '';

function homeWidgetSettings() {
  return JSON.parse(JSON.stringify(homeLayout.widgets));
}

function renderHomeWidgets() {
  const host = q('home-widgets');
  if (!host || !homeLayout || !homeLayout.widgets) return;
  const settings = homeLayout.widgets;
  const busy = !homeWritable();
  const off = busy ? 'disabled' : '';
  const title = id => id === 'clock' ? t('home.showClock', 'Clock and date') : id === 'weather'
    ? t('home.widgets.weather', 'Weather') : (() => { const widget = settings.custom.find(w => w.id === id); return (widget.resolved || widget).name; })();
  const enabled = id => id === 'clock' ? homeLayout.showClock !== false : id === 'weather'
    ? settings.weather.enabled : settings.custom.find(w => w.id === id).enabled;
  host.innerHTML = settings.order.map((id, i) => `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(title(id))}</div></div>
    <div class="prot-status home-widget-actions">
      <button type="button" class="pill idle" ${busy || i === 0 ? 'disabled' : ''} onclick="homeWidgetMove('${id}', -1)">${esc(t('home.widgets.left', 'Move left'))}</button>
      <button type="button" class="pill idle" ${busy || i === settings.order.length - 1 ? 'disabled' : ''} onclick="homeWidgetMove('${id}', 1)">${esc(t('home.widgets.right', 'Move right'))}</button>
      <button type="button" class="pill ${enabled(id) ? 'good' : 'idle'}" ${id === 'clock' ? 'id="home-show-clock"' : ''}
        ${off} aria-pressed="${enabled(id)}" aria-label="${esc(title(id))}" onclick="homeWidgetToggle('${id}')">${esc(enabled(id) ? t('common.on', 'On') : t('common.off', 'Off'))}</button>
      ${id !== 'clock' && id !== 'weather' ? `<button type="button" class="pill idle" onclick="homeWidgetExport('${id}')">${esc(t('home.store.export', 'Export widget'))}</button><button type="button" class="pill bad" ${off} onclick="homeWidgetRemove('${id}')">${esc(t('home.ch.remove', 'Remove'))}</button>` : ''}
    </div>
  </div>${homeWidgetPositionFields(id, settings.positions && settings.positions[id] || 'auto', off, title(id))}${id === 'clock' ? homeWidgetClockFields(settings.clock, off) : id === 'weather' ? homeWidgetWeatherFields(settings.weather, off) : settings.custom.find(w => w.id === id).version === 3 ? homeWidgetStoreFields(settings.custom.find(w => w.id === id), off) : settings.custom.find(w => w.id === id).version === 2 ? homeWidgetComponentFields(settings.custom.find(w => w.id === id), off) : homeWidgetTextFields(settings.custom.find(w => w.id === id), off)}`).join('') +
    `<label class="home-widget-import">${esc(t('home.widgets.import', 'Import a widget (.json)'))}
      <input type="file" accept=".json,application/json" ${off} onchange="homeWidgetImport(this.files[0]); this.value = ''">
    </label><div class="prot-desc">${esc(t('home.widgets.importHint', 'Import text widgets or component widgets with icons, charts and data. Imported widgets stay off until enabled.'))}
      <a href="https://rorygallagher2024.github.io/glasshouse/development/WRITING-WIDGETS/" target="_blank" rel="noopener">${esc(t('home.widgets.guide', 'Widget format'))}</a></div>`;
  renderHomeWidgetStore();
}

function homeWidgetPositionFields(id, position, off, name) {
  const topPreview = homeLayout.livePreview && !homeLayout.previewInTile;
  const previewDetails = topPreview && homeLayout.picture;
  const blocked = value => value === 'center' && (homeLayout.showLastOn !== false || previewDetails) || value === 'right' && (homeLayout.picture || topPreview);
  return `<div class="home-widget-fields"><label>${esc(t('home.widgets.positionLabel', 'Position'))}
    <select class="pill-sel" aria-label="${esc(t('home.widgets.positionFor', 'Position of {name}', {name}))}" ${off} onchange="homeWidgetPosition('${id}', this.value)">
    ${[['auto', t('home.widgets.positionAuto', 'Automatic')], ['left', t('home.widgets.positionLeft', 'Left')], ['center', t('home.widgets.positionCenter', 'Centre')], ['right', t('home.widgets.positionRight', 'Right')]].map(([value, label]) => `<option value="${value}" ${position === value ? 'selected' : ''} ${blocked(value) ? 'disabled' : ''}>${esc(label)}</option>`).join('')}
    </select></label><div class="prot-desc">${esc(t('home.widgets.positionRules', 'Centre needs Last watched off. Right needs Picture details and the top live preview off.'))}</div>
    ${previewDetails ? `<div class="prot-desc">${esc(t('home.widgets.previewSpace', 'Picture details beside a top live preview also reserve the centre. Switch either one off to free it.'))}</div>` : ''}</div>`;
}

function homeWidgetPosition(id, position) {
  const widgets = homeWidgetSettings();
  widgets.positions = widgets.positions || {};
  widgets.positions[id] = position;
  homeSaveLayout({ widgets });
}

function homeWidgetComponentFields(widget, off) {
  return `<form class="home-widget-fields" onsubmit="event.preventDefault(); homeWidgetComponentsSave('${widget.id}', this)">
    <div class="prot-desc">${esc(t('home.widgets.componentsHelp', 'Edit the component JSON. Data sources are static values, local TV statistics or weather for the selected city. Enabling a weather data widget permits weather requests.'))}</div>
    <label class="home-widget-json">${esc(t('home.widgets.componentJSON', 'Widget JSON'))}<textarea name="widgetJSON" aria-label="${esc(t('home.widgets.componentJSON', 'Widget JSON'))}" rows="12" maxlength="16384" ${off}>${esc(JSON.stringify(widget, null, 2))}</textarea></label>
    <button type="submit" class="pill idle" ${off}>${esc(t('home.widgets.save', 'Save widget'))}</button>
  </form>`;
}

function homeWidgetComponentsSave(id, form) {
  if (!homeWritable()) return;
  try {
    const widgets = homeWidgetSettings();
    const previous = widgets.custom.find(w => w.id === id);
    let next;
    try { next = JSON.parse(form.elements.widgetJSON.value); }
    catch (e) { throw new Error(t('home.widgets.invalidJSON', 'Enter valid widget JSON.')); }
    if (!next || next.id !== id) throw new Error(t('home.widgets.keepId', 'Keep the widget id unchanged when editing.'));
    next.enabled = previous.enabled;
    widgets.custom = widgets.custom.map(w => w.id === id ? next : w);
    homeSaveLayout({ widgets });
  } catch (e) { showErr(e.message); }
}

function homeWidgetClockFields(clock, off) {
  return `<div class="home-widget-fields">
    <label>${esc(t('home.widgets.timeFormat', 'Time format'))}<select aria-label="${esc(t('home.widgets.timeFormat', 'Time format'))}" class="pill-sel" ${off} onchange="homeWidgetClock('format', this.value)">
      ${[['tv', t('home.widgets.followTv', 'Follow the TV')], ['12', t('adv.clock12', '12-hour clock')], ['24', t('home.widgets.hour24', '24-hour clock')]].map(([value, name]) => `<option value="${value}" ${clock.format === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}
    </select></label>
    <label><input type="checkbox" ${clock.date ? 'checked' : ''} ${off} onchange="homeWidgetClock('date', this.checked)"> ${esc(t('home.widgets.date', 'Show date'))}</label>
  </div>`;
}

function homeWidgetWeatherFields(weather, off) {
  const searchOff = off || homeWidgetSearchBusy ? 'disabled' : '';
  return `<div class="home-widget-fields">
    <div class="prot-desc">${esc(t('home.widgets.privacy', 'Weather is off by default. Searching sends the city name to Open-Meteo; enabling Weather or a custom weather data widget sends its coordinates and the TV’s public IP address.'))}
      <a href="https://open-meteo.com/" target="_blank" rel="noopener">${esc(t('home.widgets.credit', 'Weather data by Open-Meteo (CC BY 4.0)'))}</a></div>
    <div class="prot-desc">${esc(weather.location ? weather.location.name : t('home.widgets.chooseCity', 'Choose a city before switching weather on.'))}</div>
    <form onsubmit="event.preventDefault(); homeWidgetSearch()" class="home-widget-search">
      <label>${esc(t('home.widgets.city', 'City'))}<input id="home-widget-city" type="search" maxlength="80" minlength="2" required value="${esc(homeWidgetQuery)}" ${searchOff} oninput="homeWidgetQuery = this.value; homeWidgetLocations = []; homeWidgetNote = ''; q('home-widget-results').innerHTML = ''"></label>
      <button type="submit" class="pill idle" ${searchOff}>${esc(homeWidgetSearchBusy ? t('home.widgets.searching', 'Searching…') : t('home.widgets.searchButton', 'Find city'))}</button>
    </form>
    <div id="home-widget-results" aria-live="polite">${homeWidgetLocations.map((loc, i) => `<button type="button" class="pill idle" ${off} onclick="homeWidgetChoose(${i})">${esc(loc.name)}</button>`).join('')}${esc(homeWidgetNote)}</div>
    <label>${esc(t('home.widgets.units', 'Temperature units'))}<select aria-label="${esc(t('home.widgets.units', 'Temperature units'))}" class="pill-sel" ${off} onchange="homeWidgetUnits(this.value)">
      <option value="celsius" ${weather.units === 'celsius' ? 'selected' : ''}>${esc(t('home.widgets.celsius', 'Celsius (°C)'))}</option>
      <option value="fahrenheit" ${weather.units === 'fahrenheit' ? 'selected' : ''}>${esc(t('home.widgets.fahrenheit', 'Fahrenheit (°F)'))}</option>
    </select></label>
    <label>${esc(t('home.widgets.windUnits', 'Wind units'))}<select class="pill-sel" aria-label="${esc(t('home.widgets.windUnits', 'Wind units'))}" ${off} onchange="homeWidgetWindUnits(this.value)">
      ${[['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s'], ['kn', 'kn']].map(([value, label]) => `<option value="${value}" ${weather.windUnits === value ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label>
  </div>`;
}

function homeWidgetTextFields(widget, off) {
  return `<form class="home-widget-fields" onsubmit="event.preventDefault(); homeWidgetTextSave('${widget.id}', this)">
    <label>${esc(t('home.widgets.name', 'Title'))}<input name="widgetName" maxlength="40" required value="${esc(widget.name)}" ${off}></label>
    <label>${esc(t('home.widgets.value', 'Value'))}<input name="widgetValue" maxlength="40" required value="${esc(widget.value)}" ${off}></label>
    <label>${esc(t('home.widgets.detail', 'Detail'))}<input name="widgetDetail" maxlength="100" value="${esc(widget.detail)}" ${off}></label>
    <button type="submit" class="pill idle" ${off}>${esc(t('home.widgets.save', 'Save widget'))}</button>
  </form>`;
}

function homeWidgetToggle(id) {
  if (!homeWritable()) return;
  if (id === 'clock') return homeSaveLayout({ showClock: homeLayout.showClock === false });
  const widgets = homeWidgetSettings();
  const widget = id === 'weather' ? widgets.weather : widgets.custom.find(w => w.id === id);
  widget.enabled = !widget.enabled;
  homeSaveLayout({ widgets });
}

function homeWidgetMove(id, direction) {
  if (!homeWritable()) return;
  const widgets = homeWidgetSettings(), i = widgets.order.indexOf(id), next = i + direction;
  if (i < 0 || next < 0 || next >= widgets.order.length) return;
  [widgets.order[i], widgets.order[next]] = [widgets.order[next], widgets.order[i]];
  homeSaveLayout({ widgets });
}

function homeWidgetClock(key, value) {
  const widgets = homeWidgetSettings();
  widgets.clock[key] = value;
  homeSaveLayout({ widgets });
}

function homeWidgetUnits(units) {
  const widgets = homeWidgetSettings();
  widgets.weather.units = units;
  homeSaveLayout({ widgets });
}

function homeWidgetWindUnits(units) {
  const widgets = homeWidgetSettings();
  widgets.weather.windUnits = units;
  homeSaveLayout({ widgets });
}

async function homeWidgetSearch() {
  if (!homeWritable() || homeWidgetSearchBusy) return;
  const query = homeWidgetQuery.trim();
  if (query.length < 2) return;
  homeWidgetLocations = [];
  homeWidgetNote = '';
  homeWidgetSearchBusy = true;
  renderHomeWidgets();
  try {
    const result = await homePost('/api/home/widgets/locations', { query });
    homeWidgetLocations = result.locations;
    if (!result.locations.length) homeWidgetNote = t('home.widgets.noCities', 'No cities found. Try another name.');
  } catch (e) { homeWidgetNote = e.message; }
  homeWidgetSearchBusy = false;
  renderHomeWidgets();
}

function homeWidgetChoose(index) {
  if (!homeWritable() || !homeWidgetLocations[index]) return;
  const widgets = homeWidgetSettings();
  widgets.weather.location = homeWidgetLocations[index];
  homeWidgetLocations = [];
  homeWidgetNote = '';
  homeSaveLayout({ widgets });
}

async function homeWidgetImport(file) {
  if (!file || !homeWritable()) return;
  try {
    if (file.size > 16384) throw new Error(t('home.widgets.componentSize', 'A component widget file can be at most 16 KB.'));
    let widget;
    try { widget = JSON.parse(await file.text()); }
    catch (e) { throw new Error(t('home.widgets.invalidFile', 'Choose a valid widget JSON file.')); }
    if (!widget || typeof widget !== 'object') throw new Error(t('home.widgets.invalidFile', 'Choose a valid widget JSON file.'));
    if (widget.revision && widget.definition && widget.fields) {
      widget = { version: 3, type: 'store', id: widget.id, template: widget, settings: {}, enabled: false };
    }
    if (widget.version === 1 && file.size > 4096) throw new Error(t('home.widgets.fileSize', 'A text widget file can be at most 4 KB.'));
    widget.enabled = false;
    const widgets = homeWidgetSettings();
    widgets.custom = widgets.custom.filter(w => w.id !== widget.id).concat([widget]);
    await homeSaveLayout({ widgets });
  } catch (e) { showErr(e.message); }
}

function homeWidgetRemove(id) {
  const widgets = homeWidgetSettings();
  widgets.custom = widgets.custom.filter(w => w.id !== id);
  widgets.order = widgets.order.filter(key => key !== id);
  homeSaveLayout({ widgets });
}

function homeWidgetTextSave(id, form) {
  const widgets = homeWidgetSettings();
  const widget = widgets.custom.find(w => w.id === id);
  widget.name = form.elements.widgetName.value;
  widget.value = form.elements.widgetValue.value;
  widget.detail = form.elements.widgetDetail.value;
  homeSaveLayout({ widgets });
}
