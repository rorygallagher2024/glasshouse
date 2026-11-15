let screenshotWritable = false, screenshotBusy = false;
let screenshotTimer = null, screenshotListController = null, screenshotImageController = null;
let screenshotVersion = '', screenshotUrls = new Map();
let screenshotDeleteId = '', screenshotDeleteUntil = 0, screenshotDeleteTimer = null;
let screenshotViewerOpener = null;

function screenshotsVisible() {
  return activeTab === 'tools' && q('disc-screenshots').open && !document.hidden;
}

function clearScreenshotGallery() {
  closeScreenshotViewer(false);
  if (screenshotImageController) screenshotImageController.abort();
  screenshotImageController = null;
  screenshotVersion = '';
  q('screenshots-gallery').innerHTML = '';
}

function updateScreenshots() {
  clearTimeout(screenshotTimer);
  if (!screenshotsVisible()) {
    clearScreenshotDelete();
    if (screenshotListController) screenshotListController.abort();
    screenshotListController = null;
    clearScreenshotGallery();
  } else if (!screenshotBusy && q('screenshot-viewer').hidden) loadScreenshots();
}

function screenshotControls() {
  ['screenshots-take', 'screenshots-method', 'screenshots-resolution'].forEach(id => {
    q(id).disabled = !screenshotWritable || screenshotBusy;
  });
  q('screenshots-take').classList.toggle('busy', screenshotBusy);
  q('screenshots-refresh').disabled = screenshotBusy;
  q('screenshots-readonly').hidden = screenshotWritable;
  const deletes = Array.from(q('screenshots-gallery').querySelectorAll('.screenshot-delete'));
  [q('screenshots-clear')].concat(deletes).forEach(button => {
    const all = button.dataset.id === '*';
    const armed = button.dataset.id === screenshotDeleteId;
    const label = all ? t('tools.screenshots.clearAll', 'Clear all') : t('tools.screenshots.delete', 'Delete');
    button.hidden = !screenshotWritable;
    button.disabled = screenshotBusy || (all && !deletes.length);
    button.className = 'pill screenshot-delete ' + (armed ? 'warn' : 'bad');
    button.textContent = armed ? t('tools.screenshots.pressAgain', 'Press again') : label;
    button.setAttribute('aria-label', all
      ? (armed ? t('tools.screenshots.confirmClear', 'Press again to delete all screenshots') : label)
      : armed
      ? t('tools.screenshots.confirmDeleteImage', 'Press again to delete {name}', { name: button.dataset.id })
      : t('tools.screenshots.deleteImage', 'Delete {name}', { name: button.dataset.id }));
  });
}

function clearScreenshotDelete() {
  clearTimeout(screenshotDeleteTimer);
  screenshotDeleteId = '';
  screenshotDeleteUntil = 0;
}

function openScreenshotViewer(button) {
  const image = button.querySelector('img');
  if (!screenshotsVisible() || !button.isConnected || button.disabled || !image.complete || !image.naturalWidth) return;
  clearScreenshotDelete();
  screenshotControls();
  clearTimeout(screenshotTimer);
  if (screenshotListController) screenshotListController.abort();
  screenshotListController = null;
  screenshotViewerOpener = button;
  q('screenshot-viewer-image').src = image.src;
  q('screenshot-viewer-image').alt = image.alt;
  q('screenshot-viewer').hidden = false;
  document.addEventListener('keydown', screenshotViewerKeys);
  q('screenshot-viewer-close').focus();
}

function closeScreenshotViewer(resume = true) {
  if (q('screenshot-viewer').hidden) return;
  q('screenshot-viewer').hidden = true;
  q('screenshot-viewer-image').removeAttribute('src');
  document.removeEventListener('keydown', screenshotViewerKeys);
  if (screenshotViewerOpener && screenshotViewerOpener.isConnected && screenshotsVisible()) screenshotViewerOpener.focus({ preventScroll: true });
  screenshotViewerOpener = null;
  if (resume) updateScreenshots();
}

function screenshotViewerKeys(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeScreenshotViewer(); }
  else if (event.key === 'Tab') { event.preventDefault(); q('screenshot-viewer-close').focus(); }
}

async function fetchScreenshotImage(id, signal) {
  const response = await fetch('/api/screenshots/image?id=' + encodeURIComponent(id), {
    cache: 'no-store', headers: token ? { Authorization: 'Bearer ' + token } : {}, signal
  });
  if (!response.ok) throw new Error(t('tools.screenshots.imageFailed', 'Could not load screenshot.'));
  const blob = await response.blob();
  if (blob.type !== 'image/png' || !blob.size) throw new Error(t('tools.screenshots.imageFailed', 'Could not load screenshot.'));
  return blob;
}

async function renderScreenshots(images) {
  const focused = q('screenshots-gallery').contains(document.activeElement) ? document.activeElement : null;
  clearScreenshotGallery();
  screenshotVersion = JSON.stringify(images);
  const versions = new Map(images.map(image => [image.id, JSON.stringify([image.size, image.modified])]));
  screenshotUrls.forEach((cached, id) => {
    if (cached.version !== versions.get(id)) {
      URL.revokeObjectURL(cached.url);
      screenshotUrls.delete(id);
    }
  });
  const gallery = q('screenshots-gallery');
  gallery.innerHTML = images.length ? images.map(image => {
    const date = new Date(image.modified).toLocaleString();
    return `<article class="screenshot-card">
      <button type="button" class="screenshot-preview" data-id="${esc(image.id)}" data-action="view" onclick="openScreenshotViewer(this)" disabled
        aria-label="${esc(t('tools.screenshots.viewImage', 'Enlarge {name}', { name: image.id }))}">
        <img data-id="${esc(image.id)}" alt="${esc(t('tools.screenshots.image', 'Screenshot from {date}', { date }))}" title="${esc(image.id)}">
      </button>
      <div class="screenshot-meta">
        <time datetime="${esc(image.modified)}">${esc(date)}</time>
        <span class="sub screenshot-resolution" dir="ltr"></span>
      </div>
      <button type="button" class="pill" data-id="${esc(image.id)}" data-action="download" onclick="downloadScreenshot(this)">${esc(t('tools.screenshots.download', 'Download'))} (${esc(fmtSize(image.size))})</button>
      <button type="button" class="pill screenshot-delete" data-id="${esc(image.id)}" data-action="delete" onclick="deleteScreenshot(this)" hidden></button>
    </article>`;
  }).join('') : `<p class="sub">${esc(t('tools.screenshots.empty', 'No screenshots yet. Take one here or press a remote key assigned to screenshots.'))}</p>`;
  screenshotControls();
  let replacement = null;
  if (focused) {
    replacement = Array.from(gallery.querySelectorAll('button')).find(button =>
      button.dataset.id === focused.dataset.id && button.dataset.action === focused.dataset.action);
    if (replacement && !replacement.hidden && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
  const controller = screenshotImageController = new AbortController();
  for (const image of gallery.querySelectorAll('img')) {
    try {
      let cached = screenshotUrls.get(image.dataset.id);
      if (!cached) {
        const blob = await fetchScreenshotImage(image.dataset.id, controller.signal);
        if (screenshotImageController !== controller || !screenshotsVisible()) return;
        cached = { url: URL.createObjectURL(blob), version: versions.get(image.dataset.id) };
        screenshotUrls.set(image.dataset.id, cached);
      }
      image.onload = () => {
        const preview = image.parentElement;
        preview.parentElement.querySelector('.screenshot-resolution').textContent = image.naturalWidth + '×' + image.naturalHeight;
        preview.disabled = false;
        if (preview === replacement && document.activeElement === document.body) preview.focus({ preventScroll: true });
      };
      image.onerror = () => {
        if (screenshotUrls.get(image.dataset.id) !== cached) return;
        screenshotUrls.delete(image.dataset.id);
        URL.revokeObjectURL(cached.url);
      };
      image.src = cached.url;
    } catch (error) {
      if (error.name === 'AbortError' || screenshotImageController !== controller) return;
      image.alt = error.message;
    }
  }
}

async function loadScreenshots(clearMessage = false) {
  if (!screenshotsVisible() || screenshotBusy || !q('screenshot-viewer').hidden) return;
  clearTimeout(screenshotTimer);
  if (screenshotListController) screenshotListController.abort();
  const controller = screenshotListController = new AbortController();
  if (clearMessage) q('screenshots-message').textContent = '';
  try {
    const response = await fetch(api('/api/screenshots'), { cache: 'no-store', signal: controller.signal });
    const result = await response.json();
    if (screenshotListController !== controller || !screenshotsVisible()) return;
    if (!response.ok || !result.ok) throw new Error(result.error || t('tools.screenshots.loadFailed', 'Could not load screenshots'));
    screenshotWritable = !!result.writable;
    const images = result.screenshots || [];
    if (!screenshotWritable || (screenshotDeleteId === '*' ? !images.length : !images.some(image => image.id === screenshotDeleteId))) clearScreenshotDelete();
    screenshotControls();
    q('screenshots-summary').textContent = t('tools.screenshots.count', '{n} saved', { n: images.length });
    const total = images.reduce((sum, image) => sum + image.size, 0);
    q('screenshots-storage').textContent = (fmtSize(total) || t('apps.install.kb', '{n} KB', { n: 0 })) + ' / ' + fmtSize(result.maxBytes);
    if (clearMessage || JSON.stringify(images) !== screenshotVersion) renderScreenshots(images);
  } catch (error) {
    if (screenshotListController === controller && error.name !== 'AbortError') q('screenshots-message').textContent = error.message;
  } finally {
    if (screenshotListController === controller) {
      screenshotListController = null;
      if (screenshotsVisible() && !screenshotBusy) screenshotTimer = setTimeout(loadScreenshots, 3000);
    }
  }
}

async function changeScreenshot(body, success, failure) {
  if (!screenshotWritable || screenshotBusy) return;
  clearScreenshotDelete();
  screenshotBusy = true;
  clearTimeout(screenshotTimer);
  if (screenshotListController) screenshotListController.abort();
  screenshotListController = null;
  screenshotControls();
  q('screenshots-message').textContent = '';
  try {
    const response = await fetch(api('/api/screenshots'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || failure);
    if (screenshotsVisible()) q('screenshots-message').textContent = success;
  } catch (error) {
    if (screenshotsVisible()) q('screenshots-message').textContent = error.message;
  } finally {
    screenshotBusy = false;
    screenshotControls();
    updateScreenshots();
  }
}

function takeScreenshot() {
  return changeScreenshot({ action: 'capture', method: q('screenshots-method').value, resolution: q('screenshots-resolution').value },
    t('tools.screenshots.saved', 'Screenshot saved.'), t('tools.screenshots.captureFailed', 'Could not take screenshot'));
}

function deleteScreenshot(button) {
  if (!screenshotWritable || screenshotBusy || !screenshotsVisible() || !button.isConnected || button.disabled) return;
  const id = button.dataset.id;
  if (screenshotDeleteId !== id || Date.now() >= screenshotDeleteUntil) {
    clearScreenshotDelete();
    screenshotDeleteId = id;
    screenshotDeleteUntil = Date.now() + 5000;
    screenshotDeleteTimer = setTimeout(() => { clearScreenshotDelete(); screenshotControls(); }, 5000);
    screenshotControls();
    return;
  }
  if (id === '*') return changeScreenshot({ action: 'clear' }, t('tools.screenshots.cleared', 'Screenshots cleared.'),
    t('tools.screenshots.clearFailed', 'Could not clear screenshots'));
  return changeScreenshot({ action: 'delete', id }, t('tools.screenshots.deleted', 'Screenshot deleted.'),
    t('tools.screenshots.deleteFailed', 'Could not delete screenshot'));
}

async function downloadScreenshot(button) {
  button.disabled = true;
  try {
    const blob = await fetchScreenshotImage(button.dataset.id);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = button.dataset.id;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Safari may read the download after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch (error) {
    if (screenshotsVisible() && button.isConnected) q('screenshots-message').textContent = error.message;
  } finally { button.disabled = false; }
}

['screenshots-method', 'screenshots-resolution'].forEach(id => {
  const select = q(id);
  try {
    const stored = localStorage.getItem(id);
    if (Array.from(select.options).some(option => option.value === stored)) select.value = stored;
  } catch (e) { /* storage may be disabled */ }
  select.addEventListener('change', () => {
    try { localStorage.setItem(id, select.value); } catch (e) { /* storage may be disabled */ }
  });
});
q('disc-screenshots').addEventListener('toggle', updateScreenshots);
document.addEventListener('visibilitychange', updateScreenshots);
