let homeStore = null;
let homeStoreLoading = false;
let homeStoreError = '';
let homeStoreSelected = null;

function homeStoreCategory(category) {
  if (category === 'weather') return t('home.widgets.weather', 'Weather');
  if (category === 'tv') return t('home.store.tv', 'TV statistics');
  return t('home.store.personal', 'Personal');
}

async function homeStoreBrowse() {
  q('home-widget-store').hidden = false;
  if (homeStoreLoading) return;
  homeStoreLoading = true;
  homeStoreError = '';
  renderHomeWidgetStore();
  try { homeStore = await homeGet('/api/home/widgets/store' + (homeStore ? '?refresh=1' : '')); }
  catch (error) { homeStoreError = error.message; }
  homeStoreLoading = false;
  renderHomeWidgets();
}

function renderHomeWidgetStore() {
  const host = q('home-store-results');
  if (!host || q('home-widget-store').hidden) return;
  const submission = '## Widget name\n\n## Description\n\n## Category\nPersonal / TV statistics / Weather\n\n## Author and licence\n\n## Widget JSON\n```json\n\n```\n\n## Preview and testing\n\nRemove private messages, locations and credentials before submitting. Submissions need maintainer review.';
  q('home-store-submit').href = 'https://github.com/rsm23/glasshouse/issues/new?title=' + encodeURIComponent('[Widget] ') + '&body=' + encodeURIComponent(submission);
  q('home-store-refresh').disabled = homeStoreLoading;
  q('home-store-note').textContent = homeStoreLoading ? t('home.store.loading', 'Loading widgets…') : homeStoreError ||
    (homeStore && (homeStore.source === 'bundled' ? t('home.store.bundled', 'Showing the included catalogue. Online sources are unavailable; try again later.') :
      homeStore.stale ? t('home.store.cached', 'Showing the last available catalogue. Online sources are unavailable; try again later.') :
        t('home.store.source', 'Catalogue from {source}.', { source: homeStore.source === 'github' ? 'GitHub' : 'jsDelivr' })));
  if (!homeStore) { host.textContent = ''; return; }
  const query = q('home-store-search').value.trim().toLowerCase();
  const category = q('home-store-category').value;
  const installed = q('home-store-installed').checked;
  const saved = homeLayout && homeLayout.widgets ? homeLayout.widgets.custom : [];
  const items = homeStore.widgets.filter(item => {
    const matches = `${item.name} ${item.description} ${item.author} ${homeStoreCategory(item.category)}`.toLowerCase().includes(query);
    return matches && (!category || category === item.category) &&
      (!installed || saved.some(widget => widget.version === 3 && widget.template.id === item.id));
  });
  q('home-store-count').textContent = t('home.store.count', 'Widgets: {count}', { count: items.length });
  host.innerHTML = items.length ? items.map(item => {
    const count = saved.filter(widget => widget.version === 3 && widget.template.id === item.id).length;
    return `<div class="prot-row"><div class="prot-main"><div class="prot-title">${esc(item.name)}</div>
      <div class="prot-desc">${esc(item.description)}</div>
      <div class="prot-desc">${esc(homeStoreCategory(item.category))} · ${esc(item.author)} · ${esc(item.revision)}</div>
      ${count ? `<div class="prot-desc">${esc(t('home.store.installedCount', '{count} installed', { count }))}</div>` : ''}</div>
      <div class="prot-status home-widget-actions"><button type="button" class="pill idle" onclick="homeStorePreview('${item.id}')">${esc(t('home.store.preview', 'Preview and install'))}</button></div></div>`;
  }).join('') : `<div class="prot-desc">${esc(t('home.store.empty', 'No widgets match these filters.'))}</div>`;
}

function homeStoreFields(template, settings, disabled) {
  return template.fields.map((field, index) => {
    const value = Object.prototype.hasOwnProperty.call(settings, field.key) ? settings[field.key] : field.default;
    const common = `name="setting${index}" ${disabled ? 'disabled' : ''}`;
    let control;
    if (field.type === 'select') control = `<select class="pill-sel" ${common}>${field.options.map(option =>
      `<option value="${esc(option.value)}" ${value === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`;
    else if (field.type === 'boolean') control = `<input type="checkbox" ${common} ${value ? 'checked' : ''}>`;
    else if (field.type === 'number') control = `<input type="number" ${common} value="${value}" min="${field.min}" max="${field.max}" step="1" required>`;
    else control = `<input type="text" ${common} value="${esc(value)}" maxlength="${field.maxLength}" ${field.target === 'name' || field.target === 'value' || /\.text$/.test(field.target) ? 'required' : ''}>`;
    return `<label>${esc(field.label)}${control}</label>`;
  }).join('');
}

function homeStoreReadFields(template, form, preserveInput) {
  return Object.fromEntries(template.fields.map((field, index) => {
    const control = form.elements[`setting${index}`];
    return [field.key, field.type === 'boolean' ? control.checked : field.type === 'number' && !preserveInput ? Number(control.value) : control.value];
  }));
}

function homeStorePreview(id) {
  const item = homeStore && homeStore.widgets.find(widget => widget.id === id);
  if (!item) return;
  homeStoreSelected = item;
  q('home-store-preview-title').textContent = item.name;
  q('home-store-preview-description').textContent = item.description;
  const form = q('home-store-preview-form');
  q('home-store-preview-fields').innerHTML = homeStoreFields(item, {}, false);
  q('home-store-preview-weather').hidden = item.definition.data?.source !== 'weather';
  homeStorePaintPreview();
  homeStoreInstallState();
  q('home-store-preview').showModal();
  form.elements[0]?.focus();
}

function homeStoreInstallState() {
  const full = homeLayout?.widgets.custom.length >= 8;
  q('home-store-install').disabled = !homeWritable() || full;
  q('home-store-install-note').textContent = full ? t('home.store.full', 'Eight widgets are saved. Remove one before installing another.') :
    !homeWritable() ? t('home.store.readOnly', 'Widget changes are unavailable while controls are disabled or a save is in progress.') :
      t('home.store.startsOff', 'Installed widgets start off. Choose a position and turn them on when ready.');
}

function homeStorePaintPreview() {
  if (!homeStoreSelected) return;
  const form = q('home-store-preview-form');
  if (Array.from(form.elements).some(control => control.validity && !control.validity.valid)) return;
  const item = homeStoreSelected, definition = JSON.parse(JSON.stringify(item.definition));
  const settings = homeStoreReadFields(item, form);
  item.fields.forEach(field => {
    const path = field.target.split('.');
    let object = definition;
    path.slice(0, -1).forEach(key => { object = object[key]; });
    object[path[path.length - 1]] = settings[field.key];
  });
  q('home-store-sample-title').textContent = definition.name;
  const host = q('home-store-sample-body');
  if (definition.version === 1) {
    host.replaceChildren(WidgetKit.node('strong', 'home-store-text-value', definition.value), WidgetKit.node('div', '', definition.detail));
  } else WidgetKit.render(host, definition.components, definition.data.source === 'static' ? definition.data.values : item.preview, true);
}

async function homeStoreAction(body, form) {
  if (!homeWritable()) return;
  homeSaving = true;
  homeLoadRevision++;
  renderHome();
  if (q('home-store-preview').open) homeStoreInstallState();
  try {
    const result = await homePost('/api/home/widgets/store', body);
    homeLayout = result.layout;
    homeStatus.layout = result.layout;
    if (body.action === 'configure' || body.action === 'update') homeWidgetForgetDraft(body.id);
    if (body.action === 'install') q('home-store-preview').close();
    if (form) form.dataset.saved = 'true';
  } catch (error) { showErr(error.message); }
  finally {
    await loadHome(true);
    homeSaving = false;
    renderHome();
    if (q('home-store-preview').open) homeStoreInstallState();
  }
}

function homeStoreInstall() {
  if (!homeStoreSelected) return;
  homeStoreAction({ action: 'install', packageId: homeStoreSelected.id,
    settings: homeStoreReadFields(homeStoreSelected, q('home-store-preview-form')) });
}

function homeWidgetStoreFields(widget, off) {
  const update = homeStore?.widgets.find(item => item.id === widget.template.id && homeStoreNewer(item.revision, widget.template.revision));
  return `<form class="home-widget-fields" oninput="homeWidgetRememberDraft('${widget.id}', this)" onchange="homeWidgetRememberDraft('${widget.id}', this)" onsubmit="event.preventDefault(); homeStoreConfigure('${widget.id}', this)">
    <div class="prot-desc">${esc(widget.template.name)} · ${esc(widget.template.revision)}</div>
    ${homeStoreFields(widget.template, homeWidgetDraft(widget) || widget.settings, !!off)}
    ${widget.template.definition.data?.source === 'weather' ? `<div class="prot-desc">${esc(t('home.store.weather', 'Uses the city and units selected under Weather. Turning this widget on permits weather requests.'))}</div>` : ''}
    <button type="submit" class="pill idle" ${off}>${esc(t('home.widgets.save', 'Save widget'))}</button>
    ${update ? `<button type="button" class="pill idle" ${off} onclick="homeStoreAction({action:'update',id:'${widget.id}'})">${esc(t('home.store.update', 'Update to {version}', { version: update.revision }))}</button>` : ''}
  </form>`;
}

function homeStoreNewer(candidate, current) {
  const next = candidate.split('.').map(Number), previous = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}

function homeStoreConfigure(id, form) {
  const widget = homeLayout.widgets.custom.find(item => item.id === id);
  if (widget?.version === 3) homeStoreAction({ action: 'configure', id, settings: homeStoreReadFields(widget.template, form) }, form);
}

function homeWidgetExport(id) {
  const widget = homeLayout.widgets.custom.find(item => item.id === id);
  if (!widget) return;
  // Store exports share the template's defaults, never the owner's saved values.
  const definition = widget.version === 3 ? widget.template : { ...widget, enabled: false };
  const url = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (widget.template?.id || widget.id) + '.json';
  link.click();
  URL.revokeObjectURL(url);
}
