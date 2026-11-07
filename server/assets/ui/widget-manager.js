let homeWidgetSelected = 'clock';
let homeWidgetTab = 'widgets';
let homeWidgetMobileDetail = false;
let homeWidgetPendingFocus = null;

function homeWidgetEditorFocus() {
  const element = document.activeElement;
  if (!q('home-widget-editors').contains(element)) return null;
  const selector = element.id ? '#' + CSS.escape(element.id) : element.name ? '[name="' + CSS.escape(element.name) + '"]'
    : element.hasAttribute('data-widget-pick') ? '[data-widget-pick="' + element.dataset.widgetPick + '"]'
    : element.hasAttribute('data-widget-toggle') ? '[data-widget-toggle="' + element.dataset.widgetToggle + '"]'
    : element.getAttribute('onchange') ? '[onchange="' + CSS.escape(element.getAttribute('onchange')) + '"]'
    : element.getAttribute('onclick') ? '[onclick="' + CSS.escape(element.getAttribute('onclick')) + '"]' : '';
  return selector ? { selector, start: element.selectionStart, end: element.selectionEnd, id: homeWidgetSelected } : null;
}

function homeWidgetRestoreFocus(focus) {
  if (focus) homeWidgetPendingFocus = focus;
  const pending = homeWidgetPendingFocus;
  if (!pending || !homeWritable()) return;
  homeWidgetPendingFocus = null;
  if (!focus && document.activeElement !== document.body && document.activeElement !== q('home-widget-manager')) return;
  if (pending.id !== homeWidgetSelected || !q('home-widget-manager').open || homeWidgetTab !== 'widgets') return;
  const element = q('home-widget-editors').querySelector(pending.selector);
  element?.focus({ preventScroll: true });
  if (element && pending.start != null && typeof element.setSelectionRange === 'function') element.setSelectionRange(pending.start, pending.end);
}

function homeWidgetManage() {
  if (!homeLayout?.widgets) return;
  homeWidgetMobileDetail = false;
  homeWidgetShowTab('widgets');
  q('home-widget-manager').showModal();
  q('home-widget-tab-widgets').focus();
}

function homeWidgetClose() {
  if (homeWidgetDrafts.size && !confirm(t('home.widgets.discard', 'Close without saving widget edits? Unsaved edits will be discarded.'))) return false;
  homeWidgetDrafts.clear();
  q('home-widget-manager').close();
  q('home-widget-manage').focus();
  return true;
}

function homeWidgetShowTab(tab) {
  homeWidgetTab = tab;
  ['widgets', 'layout', 'store'].forEach(name => {
    const button = q('home-widget-tab-' + name);
    button.setAttribute('aria-selected', String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    q(name === 'widgets' ? 'home-widget-editors' : name === 'layout' ? 'home-widget-layout' : 'home-widget-store').hidden = name !== tab;
  });
  renderHomeWidgets();
  if (tab === 'store' && !homeStore && !homeStoreLoading) homeStoreBrowse();
}

function homeWidgetTabKey(event) {
  const tabs = ['widgets', 'layout', 'store'];
  let index = tabs.indexOf(homeWidgetTab);
  const rtl = getComputedStyle(q('home-widget-manager')).direction === 'rtl';
  if (event.key === 'ArrowRight') index += rtl ? -1 : 1;
  else if (event.key === 'ArrowLeft') index += rtl ? 1 : -1;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = 2;
  else return;
  event.preventDefault();
  homeWidgetShowTab(tabs[(index + tabs.length) % tabs.length]);
  q('home-widget-tab-' + homeWidgetTab).focus();
}

function homeWidgetSelect(id) {
  homeWidgetSelected = id;
  homeWidgetMobileDetail = true;
  homeWidgetShowTab('widgets');
  q('home-widget-editor-title').focus();
}

function homeWidgetBack() {
  homeWidgetMobileDetail = false;
  q('home-widget-editors').classList.remove('home-widget-detail-open');
  q('home-widget-list').querySelector('[aria-current=true]')?.focus();
}

function homeWidgetSummary(id) {
  const settings = homeLayout.widgets;
  if (id === 'weather') return settings.weather.location
    ? settings.weather.location.name + ' · ' + (settings.weather.units === 'fahrenheit' ? '°F' : '°C')
    : t('home.widgets.chooseCity', 'Choose a city before switching weather on.');
  if (id === 'football') return (settings.football.teams.length ? settings.football.teams : settings.football.leagues).map(item => item.name).join(', ')
    || t('home.football.chooseLeagues', 'Choose at least one league or team before switching football scores on.');
  if (id === 'clock') return settings.clock.format === '12' ? t('adv.clock12', '12-hour clock') : settings.clock.format === '24'
    ? t('home.widgets.hour24', '24-hour clock') : t('home.widgets.followTv', 'Follow the TV');
  const widget = settings.custom.find(item => item.id === id);
  return widget.version === 3 ? widget.template.name : (widget.resolved || widget).detail || '';
}

function renderHomeWidgetSummary() {
  const placed = WidgetLayout.placement(homeLayout);
  const active = WidgetLayout.active(homeLayout);
  q('home-widget-summary').textContent = placed.ok && placed.manual
    ? ['left', 'center', 'right'].map(zone => {
      const id = Object.keys(placed.positions).find(key => placed.positions[key] === zone);
      const name = id ? homeWidgetLayoutName(id) : WidgetLayout.requirements(homeLayout, zone).length
        ? t('home.widgets.reserved', 'Reserved') : t('home.widgets.available', 'Available');
      return t('home.widgets.zoneSummary', '{zone}: {name}', { zone: homeWidgetZoneName(zone), name });
    }).join(' · ')
    : t('home.widgets.autoSummary', 'Automatic layout · {widgets}', { widgets: active.length ? active.map(homeWidgetLayoutName).join(', ') : t('common.off', 'Off') });
}

function renderHomeWidgetList() {
  const busy = !homeWritable();
  q('home-widget-editors').classList.toggle('home-widget-detail-open', homeWidgetMobileDetail);
  q('home-widget-list').innerHTML = homeLayout.widgets.order.map(id => {
    const on = WidgetLayout.enabled(homeLayout, id), name = homeWidgetLayoutName(id);
    return `<div class="home-widget-list-row"><button type="button" class="home-widget-pick" data-widget-pick="${id}" aria-current="${id === homeWidgetSelected}" onclick="homeWidgetSelect('${id}')">
      <span class="prot-title">${esc(name)}</span><span class="prot-desc">${esc(homeWidgetSummary(id))}</span></button>
      <button type="button" class="pill ${on ? 'good' : 'idle'}" ${id === 'clock' ? 'id="home-show-clock"' : ''} ${busy ? 'disabled' : ''}
        data-widget-toggle="${id}" aria-pressed="${on}" aria-label="${esc(name)}" onclick="homeWidgetToggle('${id}')">${esc(on ? t('common.on', 'On') : t('common.off', 'Off'))}</button></div>`;
  }).join('');
  q('home-widget-manager-note').textContent = busy ? t('home.store.readOnly', 'Widget changes are unavailable while controls are disabled or a save is in progress.') : '';
}

window.addEventListener('beforeunload', event => {
  if (!homeWidgetDrafts.size) return;
  event.preventDefault();
  event.returnValue = '';
});
