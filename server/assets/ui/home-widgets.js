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
    ? t('home.widgets.weather', 'Weather') : settings.custom.find(w => w.id === id).name;
  const enabled = id => id === 'clock' ? homeLayout.showClock !== false : id === 'weather'
    ? settings.weather.enabled : settings.custom.find(w => w.id === id).enabled;
  host.innerHTML = settings.order.map((id, i) => `<div class="prot-row">
    <div class="prot-main"><div class="prot-title">${esc(title(id))}</div></div>
    <div class="prot-status home-widget-actions">
      <button type="button" class="pill idle" ${busy || i === 0 ? 'disabled' : ''} onclick="homeWidgetMove('${id}', -1)">${esc(t('home.widgets.left', 'Move left'))}</button>
      <button type="button" class="pill idle" ${busy || i === settings.order.length - 1 ? 'disabled' : ''} onclick="homeWidgetMove('${id}', 1)">${esc(t('home.widgets.right', 'Move right'))}</button>
      <button type="button" class="pill ${enabled(id) ? 'good' : 'idle'}" ${id === 'clock' ? 'id="home-show-clock"' : ''}
        ${off} aria-pressed="${enabled(id)}" aria-label="${esc(title(id))}" onclick="homeWidgetToggle('${id}')">${esc(enabled(id) ? t('common.on', 'On') : t('common.off', 'Off'))}</button>
      ${id !== 'clock' && id !== 'weather' ? `<button type="button" class="pill bad" ${off} onclick="homeWidgetRemove('${id}')">${esc(t('home.ch.remove', 'Remove'))}</button>` : ''}
    </div>
  </div>${id === 'clock' ? homeWidgetClockFields(settings.clock, off) : id === 'weather' ? homeWidgetWeatherFields(settings.weather, off) : homeWidgetTextFields(settings.custom.find(w => w.id === id), off)}`).join('') +
    `<label class="home-widget-import">${esc(t('home.widgets.import', 'Import a text widget (.json)'))}
      <input type="file" accept=".json,application/json" ${off} onchange="homeWidgetImport(this.files[0]); this.value = ''">
    </label><div class="prot-desc">${esc(t('home.widgets.importHint', 'Text widgets contain a title, value and detail line. Importing keeps them off until enabled.'))}
      <a href="https://rorygallagher2024.github.io/glasshouse/development/WRITING-WIDGETS/" target="_blank" rel="noopener">${esc(t('home.widgets.guide', 'Widget format'))}</a></div>`;
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
    <div class="prot-desc">${esc(t('home.widgets.privacy', 'Weather is off by default. Searching sends the city name to Open-Meteo; enabling weather sends its coordinates and the TV’s public IP address.'))}
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
    if (file.size > 4096) throw new Error(t('home.widgets.fileSize', 'A text widget file can be at most 4 KB.'));
    let widget;
    try { widget = JSON.parse(await file.text()); }
    catch (e) { throw new Error(t('home.widgets.invalidFile', 'Choose a valid text widget JSON file.')); }
    if (!widget || typeof widget !== 'object') throw new Error(t('home.widgets.invalidFile', 'Choose a valid text widget JSON file.'));
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
