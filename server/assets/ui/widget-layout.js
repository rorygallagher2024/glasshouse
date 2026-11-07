let homeWidgetLayoutSelected = '';
let homeWidgetLayoutDragging = '';

function homeWidgetLayoutName(id) {
  if (id === 'clock') return t('home.showClock', 'Clock and date');
  if (id === 'weather') return t('home.widgets.weather', 'Weather');
  if (id === 'football') return t('home.football.title', 'Football scores');
  const widget = homeLayout.widgets.custom.find(item => item.id === id);
  return widget ? (widget.resolved || widget).name : '';
}

function homeWidgetZoneName(zone) {
  return zone === 'left' ? t('home.widgets.positionLeft', 'Left') : zone === 'center'
    ? t('home.widgets.positionCenter', 'Centre') : t('home.widgets.positionRight', 'Right');
}

function homeWidgetLayoutReason(reason) {
  if (reason === 'lastWatched') return t('home.widgets.needLast', 'Switch off Last watched in Shown on Home.');
  if (reason === 'picture') return t('home.widgets.needPicture', 'Switch off Picture details.');
  if (reason === 'topPreview') return t('home.widgets.needPreview', 'Switch off the top live preview, or use Preview in the tile.');
  if (reason === 'previewDetails') return t('home.widgets.previewSpace', 'Picture details beside a top live preview also reserve the centre. Switch either one off to free it.');
  if (reason === 'off') return t('home.widgets.needOn', 'Turn this widget on before placing it.');
  if (reason === 'weatherLocation') return t('home.widgets.chooseCity', 'Choose a city before switching weather on.');
  if (reason === 'footballLeagues') return t('home.football.chooseLeagues', 'Choose at least one league before switching football scores on.');
  if (reason === 'tooMany') return t('home.widgets.needLimit', 'Switch widgets off until no more than three are enabled.');
  if (reason === 'capacity') return t('home.widgets.needSpace', 'Free another zone or switch another widget off. Every enabled widget needs a free position.');
  return t('home.widgets.chooseWidget', 'Select a widget to choose its position.');
}

function homeWidgetLayoutCard(id, reorder) {
  const on = WidgetLayout.enabled(homeLayout, id), busy = !homeWritable();
  return `<button type="button" class="hwl-card" draggable="${!busy}" data-widget-id="${id}" aria-pressed="${id === homeWidgetLayoutSelected}"
    ${busy ? 'disabled' : ''} onclick="homeWidgetLayoutSelect('${id}')" ondragstart="homeWidgetLayoutStart(event, '${id}')" ondragend="homeWidgetLayoutEnd()"
    ${reorder ? `onkeydown="homeWidgetOrderKey(event, '${id}')" ondragover="homeWidgetOrderOver(event)" ondragleave="homeWidgetOrderLeave(event)" ondrop="homeWidgetOrderDrop(event, '${id}')"` : ''}>
    <span>${esc(homeWidgetLayoutName(id))}</span><small>${esc(on ? t('common.on', 'On') : t('common.off', 'Off'))}</small></button>`;
}

function renderHomeWidgetLayout() {
  const host = q('home-widget-layout');
  if (!host || !homeLayout?.widgets) return;
  if (homeWidgetLayoutDragging) return refreshHomeWidgetTargets();
  if (!homeLayout.widgets.order.includes(homeWidgetLayoutSelected)) homeWidgetLayoutSelected = '';
  const placed = WidgetLayout.placement(homeLayout), manual = placed.ok && placed.manual;
  host.innerHTML = `<div class="hwl-heading"><h3>${esc(t('home.widgets.layoutTitle', 'Widget layout'))}</h3>
    <button type="button" class="pill idle" ${!homeWritable() || !manual ? 'disabled' : ''} onclick="homeWidgetAutomatic()">${esc(t('home.widgets.automaticLayout', 'Use Automatic layout'))}</button></div>
    <p class="prot-desc">${esc(t('home.widgets.dragHelp', 'Drag widgets into a zone, or select a widget and then select a zone. Dropping on an occupied zone swaps the widgets.'))}</p>
    <p class="prot-desc">${esc(manual ? t('home.widgets.manualHelp', 'The zones show the saved positions. Widget order affects Automatic placement only.') :
      t('home.widgets.autoHelp', 'Automatic layout groups widgets using the order below. Dropping into a zone changes to fixed positions.'))}</p>
    <h4>${esc(t('home.widgets.orderTitle', 'Widget order'))}</h4>
    <p class="prot-desc">${esc(t('home.widgets.orderHelp', 'Drag before or after another widget to change Automatic order. Alt + Left/Right also reorders a focused widget. Switch a widget on before placing it in a zone.'))}</p>
    <div class="hwl-order" dir="ltr">${homeLayout.widgets.order.map(id => homeWidgetLayoutCard(id, true)).join('')}</div>
    <p class="hwl-status prot-desc" role="status" aria-live="polite"></p>
    <div class="hwl-zones" dir="ltr">${['left', 'center', 'right'].map(zone => {
      const occupant = manual && Object.keys(placed.positions).find(id => placed.positions[id] === zone);
      return `<section class="hwl-zone" data-widget-zone="${zone}" aria-label="${esc(homeWidgetZoneName(zone))}"
        ondragover="homeWidgetZoneOver(event, '${zone}')" ondragleave="homeWidgetZoneLeave(event)" ondrop="homeWidgetZoneDrop(event, '${zone}')">
        <h4 dir="auto">${esc(homeWidgetZoneName(zone))}</h4>
        <div class="hwl-occupant" dir="auto">${occupant ? homeWidgetLayoutCard(occupant, false) : `<span class="prot-desc">${esc(t('home.widgets.noFixedWidget', 'No widget fixed here'))}</span>`}</div>
        <button type="button" class="hwl-target" aria-disabled="true" aria-describedby="home-widget-${zone}-requirements" onclick="homeWidgetPlace('${zone}')">${esc(t('home.widgets.placeIn', 'Place in {zone}', { zone: homeWidgetZoneName(zone) }))}</button>
        <p class="hwl-reasons prot-desc" id="home-widget-${zone}-requirements" dir="auto"></p>
        <button type="button" class="pill idle hwl-review" onclick="homeWidgetReview('${zone}')">${esc(t('home.widgets.reviewSettings', 'Review settings'))}</button>
      </section>`;
    }).join('')}</div>`;
  refreshHomeWidgetTargets();
}

function homeWidgetDropPlan(zone) {
  if (!homeWritable()) return { ok: false, reasons: [], message: t('home.store.readOnly', 'Widget changes are unavailable while controls are disabled or a save is in progress.') };
  if (!homeWidgetLayoutSelected) return { ok: false, reasons: WidgetLayout.requirements(homeLayout, zone).concat('missing') };
  return WidgetLayout.plan(homeLayout, homeWidgetLayoutSelected, zone);
}

function refreshHomeWidgetTargets() {
  const host = q('home-widget-layout');
  if (!host) return;
  const placed = WidgetLayout.placement(homeLayout);
  host.querySelectorAll('[data-widget-id]').forEach(card => card.setAttribute('aria-pressed', String(card.dataset.widgetId === homeWidgetLayoutSelected)));
  host.querySelectorAll('[data-widget-zone]').forEach(target => {
    const zone = target.dataset.widgetZone, plan = homeWidgetDropPlan(zone);
    const occupant = placed.ok && placed.manual && Object.keys(placed.positions).find(id => placed.positions[id] === zone && id !== homeWidgetLayoutSelected);
    const message = plan.ok ? occupant ? t('home.widgets.dropSwap', 'Drop here to swap with {name}.', { name: homeWidgetLayoutName(occupant) }) : t('home.widgets.dropReady', 'Drop here to place the widget.') :
      plan.message || plan.reasons.map(homeWidgetLayoutReason).join(' ');
    target.querySelector('.hwl-reasons').textContent = message;
    target.querySelector('.hwl-target').setAttribute('aria-disabled', String(!plan.ok));
    target.classList.toggle('hwl-blocked', !plan.ok && (homeWidgetLayoutSelected !== '' || !homeWritable() || WidgetLayout.requirements(homeLayout, zone).length > 0));
    const review = target.querySelector('.hwl-review');
    review.hidden = plan.ok || !plan.reasons.length || plan.reasons[0] === 'missing' || !homeWritable();
  });
  const status = host.querySelector('.hwl-status');
  if (status) status.textContent = !homeWritable() ? t('home.store.readOnly', 'Widget changes are unavailable while controls are disabled or a save is in progress.') : homeWidgetLayoutSelected
    ? t('home.widgets.selectedWidget', 'Selected: {name}. Choose a zone or drag to reorder.', { name: homeWidgetLayoutName(homeWidgetLayoutSelected) }) : homeWidgetLayoutReason('missing');
}

function homeWidgetLayoutSelect(id) {
  if (!homeWritable()) return;
  homeWidgetLayoutSelected = homeWidgetLayoutSelected === id ? '' : id;
  refreshHomeWidgetTargets();
}

function homeWidgetLayoutStart(event, id) {
  if (!homeWritable()) { event.preventDefault(); return; }
  homeWidgetLayoutDragging = id; homeWidgetLayoutSelected = id;
  event.dataTransfer.setData('application/x-glasshouse-widget', id);
  event.dataTransfer.effectAllowed = 'move';
  refreshHomeWidgetTargets();
}

function homeWidgetLayoutEnd() {
  homeWidgetLayoutDragging = '';
  q('home-widget-layout')?.querySelectorAll('.hwl-over').forEach(zone => zone.classList.remove('hwl-over'));
  renderHomeWidgetLayout();
}

function homeWidgetZoneOver(event, zone) {
  if (!homeWidgetLayoutDragging) return;
  const plan = homeWidgetDropPlan(zone);
  event.currentTarget.classList.add('hwl-over');
  event.dataTransfer.dropEffect = plan.ok ? 'move' : 'none';
  if (plan.ok) event.preventDefault();
}

function homeWidgetZoneLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('hwl-over');
}

function homeWidgetZoneDrop(event, zone) {
  if (!homeWidgetLayoutDragging) return;
  event.preventDefault(); event.stopPropagation();
  homeWidgetPlace(zone);
}

async function homeWidgetPlace(zone) {
  const plan = homeWidgetDropPlan(zone);
  if (!plan.ok) {
    const status = q('home-widget-layout')?.querySelector('.hwl-status');
    if (status) status.textContent = plan.message || plan.reasons.map(homeWidgetLayoutReason).join(' ');
    return;
  }
  homeWidgetLayoutDragging = '';
  await homeSaveLayout({ widgets: plan.widgets });
  q('home-widget-layout')?.querySelector(`[data-widget-zone="${zone}"] .hwl-target`)?.focus({ preventScroll: true });
}

function homeWidgetOrderOver(event) {
  if (!homeWidgetLayoutDragging || !homeWritable()) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  q('home-widget-layout')?.querySelectorAll('.hwl-before,.hwl-after').forEach(card => card.classList.remove('hwl-before', 'hwl-after'));
  if (event.currentTarget.dataset.widgetId === homeWidgetLayoutDragging) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  event.currentTarget.classList.add(event.clientX < bounds.left + bounds.width / 2 ? 'hwl-before' : 'hwl-after');
}

function homeWidgetOrderLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('hwl-before', 'hwl-after');
}

async function homeWidgetOrderDrop(event, target) {
  if (!homeWidgetLayoutDragging || !homeWritable()) return;
  event.preventDefault(); event.stopPropagation();
  const id = homeWidgetLayoutDragging;
  const bounds = event.currentTarget.getBoundingClientRect();
  const widgets = WidgetLayout.reorder(homeLayout, id, target, event.clientX >= bounds.left + bounds.width / 2);
  homeWidgetLayoutDragging = '';
  if (widgets.order.join() !== homeLayout.widgets.order.join()) await homeSaveLayout({ widgets });
}

async function homeWidgetOrderKey(event, id) {
  if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || !homeWritable()) return;
  event.preventDefault();
  const direction = event.key === 'ArrowLeft' ? -1 : 1, order = homeLayout.widgets.order;
  const next = order.indexOf(id) + direction;
  if (next < 0 || next >= order.length) return;
  homeWidgetLayoutSelected = id;
  await homeSaveLayout({ widgets: WidgetLayout.reorder(homeLayout, id, order[next], direction > 0) });
  q('home-widget-layout')?.querySelector(`.hwl-order [data-widget-id="${id}"]`)?.focus({ preventScroll: true });
}

async function homeWidgetAutomatic() {
  if (!homeWritable()) return;
  const widgets = homeWidgetSettings();
  Object.keys(widgets.positions).forEach(id => { widgets.positions[id] = 'auto'; });
  await homeSaveLayout({ widgets });
  q('home-widget-layout')?.querySelector('.hwl-order .hwl-card')?.focus({ preventScroll: true });
}

function homeWidgetReview(zone) {
  const reason = homeWidgetDropPlan(zone).reasons[0];
  const controls = { lastWatched: 'home-show-last', picture: 'home-picture', topPreview: 'home-preview', previewDetails: 'home-picture', weatherLocation: 'home-widget-city' };
  let control = q(controls[reason]);
  if (reason === 'off') control = q('home-widgets').querySelector(`[data-widget-toggle="${homeWidgetLayoutSelected}"]`);
  if (!control) control = q('home-widgets').querySelector('button[aria-pressed]');
  control?.scrollIntoView({ block: 'center' });
  control?.focus();
}
