/* Screenshot gallery, viewer, deletion and downloads against the complete UI script. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
try { vm.runInNewContext('(async function () {})'); }
catch (e) { console.log('test-screenshots-ui.js skipped: browser JavaScript needs Node 8+'); process.exit(0); }
var assets = path.join(__dirname, '../server/assets');
var source = fs.readFileSync(path.join(assets, 'ui/screenshots.js'), 'utf8');
var viewerClick = fs.readFileSync(path.join(assets, 'ui.html'), 'utf8').match(/id="screenshot-viewer"[^\n]*onclick="([^"]+)"/)[1];
var png = { type: 'image/png', size: 1234 };
var guard = setTimeout(function () { throw new Error('screenshot UI test timed out'); }, 5000);
function reply(ok, value) {
  return { ok: ok, json: function () { return Promise.resolve(value); }, blob: function () { return Promise.resolve(value); } };
}
function flush() { return new Promise(setImmediate); }
function button(ui, action, index) {
  return ui.buttons.filter(function (b) { return b.dataset.action === action; })[index || 0];
}
function load(ui) { return ui.context.loadScreenshots(true).then(flush); }
function loaded(ui) {
  ui.images.forEach(function (image) { image.complete = true; image.naturalWidth = 1920; image.naturalHeight = 1080; image.onload(); });
}
function createUI() {
  var ui = { listed: [{ id: 'capture_a.png', size: 1048576, modified: '2026-11-01T00:00:00Z' },
    { id: 'capture_b.png', size: 524288, modified: '2026-11-01T00:01:00Z' }], writable: true,
    images: [], buttons: [], requests: [], writes: [], pending: [], timers: [], links: [], created: [], revoked: [],
    listeners: {}, renders: 0, imageRequests: 0, aborted: 0 };
  var nodes = {}, now = 1000;
  var document = { hidden: false, body: { appendChild: function (link) { ui.links.push(link); } },
    addEventListener: function (name, fn) { ui.listeners[name] = fn; },
    removeEventListener: function (name) { delete ui.listeners[name]; },
    createElement: function () { return { click: function () { ui.clicked = this.href; }, remove: function () { this.removed = true; } }; } };
  document.activeElement = document.body;
  function element() {
    return { dataset: {}, options: [], listeners: {}, open: true, hidden: false, disabled: false, isConnected: true,
      classList: { toggle: function () {} }, setAttribute: function (name, value) { this[name] = value; },
      removeAttribute: function (name) { delete this[name]; }, focus: function () { document.activeElement = this; },
      addEventListener: function (name, fn) { this.listeners[name] = fn; } };
  }
  ui.q = function (id) { return nodes[id] || (nodes[id] = element()); };
  ui.q('screenshot-viewer').hidden = true;
  ui.q('screenshots-clear').dataset.id = '*';
  ui.q('screenshots-method').value = 'DISPLAY';
  ui.q('screenshots-resolution').value = '1920x1080';
  var gallery = ui.q('screenshots-gallery');
  gallery.contains = function (target) { return ui.buttons.indexOf(target) !== -1; };
  gallery.querySelectorAll = function (selector) {
    return selector === 'img' ? ui.images : selector === 'button' ? ui.buttons
      : ui.buttons.filter(function (b) { return b.dataset.action === 'delete'; });
  };
  Object.defineProperty(gallery, 'innerHTML', { set: function (html) {
    if (gallery.contains(document.activeElement)) document.activeElement = document.body;
    ui.buttons.forEach(function (b) { b.isConnected = false; });
    ui.images = []; ui.buttons = [];
    if (!html) return;
    ui.renders++;
    var match, pattern = /<img data-id="([^"]+)" alt="([^"]*)"/g;
    while ((match = pattern.exec(html))) {
      var image = { dataset: { id: match[1] }, alt: match[2], complete: false, naturalWidth: 0 };
      var card = { resolution: {}, querySelector: function () { return this.resolution; } };
      ['view', 'download', 'delete'].forEach(function (action) {
        var b = element();
        b.dataset = { id: image.dataset.id, action: action }; ui.buttons.push(b);
        if (action === 'view') { b.disabled = true; b.image = image; b.parentElement = card; b.querySelector = function () { return this.image; }; image.parentElement = b; }
      });
      ui.images.push(image);
    }
  } });
  function ClockDate(value) { return new Date(value); }
  ClockDate.now = function () { return now; };
  ui.tick = function (ms) {
    now += ms;
    ui.timers.slice().forEach(function (timer) {
      if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.fn(); }
    });
  };
  ui.imageReply = function () { return Promise.resolve(reply(true, png)); };
  ui.listReply = function () { return Promise.resolve(reply(true, { ok: true, writable: ui.writable, screenshots: ui.listed })); };
  ui.context = vm.createContext({
    document: document, activeTab: 'tools', q: ui.q, token: '', Date: ClockDate,
    t: function (key, english, vars) { return english.replace(/\{(\w+)\}/g, function (_, name) { return vars[name]; }); },
    AbortController: function () { this.signal = {}; this.abort = function () { this.signal.aborted = true; ui.aborted++; }; },
    setTimeout: function (fn, ms) { var timer = { fn: fn, ms: ms, at: now + ms }; ui.timers.push(timer); return timer; },
    clearTimeout: function (timer) { if (timer) timer.cancelled = true; },
    URL: { createObjectURL: function (blob) { var url = 'blob:' + ui.created.length; ui.created.push({ url: url, blob: blob }); return url; },
      revokeObjectURL: function (url) {
        assert.strictEqual(ui.q('screenshot-viewer').hidden, true);
        assert.strictEqual(ui.q('screenshot-viewer-image').src, undefined, 'detach the viewer before URL cleanup');
        ui.revoked.push(url);
      } },
    fetch: function (url, options) {
      ui.requests.push({ url: url, options: options });
      if (options.method === 'POST') {
        ui.writes.push({ url: url, options: options, body: JSON.parse(options.body) });
        return new Promise(function (resolve, reject) { ui.pending.push({ resolve: resolve, reject: reject }); });
      }
      if (url.indexOf('/image?') !== -1) { ui.imageRequests++; return ui.imageReply(); }
      return ui.listReply();
    }
  });
  vm.runInContext(fs.readFileSync(path.join(assets, 'ui/format.js'), 'utf8'), ui.context);
  vm.runInContext(source, ui.context);
  return ui;
}
function checkGallery() {
  var ui = createUI(), original, originalUrl;
  ui.listed = [ui.listed[0]];
  ui.imageReply = function () { return Promise.reject(new Error('image unavailable')); };
  return load(ui).then(function () {
    assert.strictEqual(ui.images[0].alt, 'image unavailable');
    original = button(ui, 'view');
    return ui.context.loadScreenshots().then(flush);
  }).then(function () {
    assert.strictEqual(button(ui, 'view'), original, 'unchanged polling preserves the card');
    assert.strictEqual(ui.imageRequests, 1);
    ui.imageReply = function () { return Promise.resolve(reply(true, png)); };
    return load(ui);
  }).then(function () {
    assert.strictEqual(ui.imageRequests, 2, 'Refresh retries an unchanged failed preview');
    originalUrl = ui.images[0].src;
    loaded(ui); button(ui, 'view').focus();
    ui.listed.push({ id: 'capture_new.png', size: 2097152, modified: '2026-11-01T00:02:00Z' });
    return ui.context.loadScreenshots().then(flush);
  }).then(function () {
    assert.strictEqual(ui.imageRequests, 3, 'adding a capture only fetches the new PNG');
    assert.strictEqual(ui.images[0].src, originalUrl, 'a retained capture keeps its blob URL');
    assert.strictEqual(ui.context.document.activeElement, ui.context.document.body);
    loaded(ui);
    assert.strictEqual(ui.context.document.activeElement, button(ui, 'view'), 'loaded replacement restores focus');
    return load(ui);
  }).then(function () {
    assert.strictEqual(ui.imageRequests, 3, 'Refresh reuses successful previews');
    var other = ui.q('screenshots-refresh'); other.focus(); loaded(ui);
    assert.strictEqual(ui.context.document.activeElement, other, 'late image load never steals focus');
    ui.context.document.hidden = true; ui.listeners.visibilitychange();
    ui.context.document.hidden = false; ui.listeners.visibilitychange();
    return flush();
  }).then(function () {
    assert.strictEqual(ui.imageRequests, 3, 'returning to the page reuses downloaded PNGs');
    assert.strictEqual(ui.images[0].src, originalUrl);
    ui.listed = [ui.listed[1]];
    return ui.context.loadScreenshots().then(flush);
  }).then(function () {
    assert.deepEqual(ui.revoked, [originalUrl], 'a removed capture releases its blob URL');
    assert.strictEqual(ui.imageRequests, 3);
    ui.listed[0] = Object.assign({}, ui.listed[0], { size: 123 });
    return ui.context.loadScreenshots().then(flush);
  }).then(function () {
    assert.strictEqual(ui.imageRequests, 4, 'changed file metadata fetches a fresh PNG');
    assert.strictEqual(ui.revoked.length, 2, 'a changed capture releases its previous URL');
    ui.images[0].onerror();
    return load(ui);
  }).then(function () {
    assert.strictEqual(ui.imageRequests, 5, 'Refresh retries a PNG that failed to decode');
    assert.strictEqual(ui.revoked.length, 3, 'a failed PNG releases its URL');
  });
}
function checkViewer() {
  var ui = createUI(), preview, image, before, renderCount, resolveList, loading, listReply;
  ui.listed = [ui.listed[0]];
  return load(ui).then(function () {
    preview = button(ui, 'view'); image = ui.images[0];
    ui.context.openScreenshotViewer(preview);
    assert.strictEqual(ui.q('screenshot-viewer').hidden, true, 'disabled preview cannot open');
    preview.disabled = false;
    ui.context.openScreenshotViewer(preview);
    assert.strictEqual(ui.q('screenshot-viewer').hidden, true, 'incomplete image cannot open');
    image.complete = true;
    ui.context.openScreenshotViewer(preview);
    assert.strictEqual(ui.q('screenshot-viewer').hidden, true, 'empty image cannot open');
    loaded(ui); ui.context.deleteScreenshot(button(ui, 'delete'));
    before = ui.requests.length;
    ui.context.openScreenshotViewer(preview);
    assert.strictEqual(ui.q('screenshot-viewer-image').src, image.src);
    assert.strictEqual(ui.q('screenshot-viewer-image').alt, image.alt);
    assert.strictEqual(ui.context.document.activeElement, ui.q('screenshot-viewer-close'));
    assert.strictEqual(button(ui, 'delete').textContent, 'Delete', 'opening cancels deletion confirmation');
    assert.ok(ui.timers.filter(function (t) { return t.ms === 3000; }).every(function (t) { return t.cancelled; }));
    ui.context.loadScreenshots(); ui.context.updateScreenshots();
    assert.strictEqual(ui.requests.length, before, 'viewer opening and polling reuse the loaded image');
    [false, true].forEach(function (shift) {
      var prevented = false;
      ui.listeners.keydown({ key: 'Tab', shiftKey: shift, preventDefault: function () { prevented = true; } });
      assert.strictEqual(prevented, true);
      assert.strictEqual(ui.context.document.activeElement, ui.q('screenshot-viewer-close'));
    });
    ui.listeners.keydown({ key: 'Escape', preventDefault: function () {} });
    assert.strictEqual(ui.q('screenshot-viewer').hidden, true);
    assert.strictEqual(ui.context.document.activeElement, preview);
    assert.strictEqual(ui.listeners.keydown, undefined);
    assert.strictEqual(ui.requests.length, before + 1, 'closing resumes polling');
    ui.context.closeScreenshotViewer();
    assert.strictEqual(ui.requests.length, before + 1, 'closing twice does not refresh twice');
    assert.deepEqual(ui.revoked, [], 'closing keeps the gallery URL alive');
    return flush();
  }).then(function () {
    listReply = ui.listReply;
    ui.listReply = function () { return new Promise(function (resolve) { resolveList = resolve; }); };
    loading = ui.context.loadScreenshots(); renderCount = ui.renders; before = ui.aborted;
    ui.context.openScreenshotViewer(preview);
    assert.strictEqual(ui.aborted, before + 1, 'opening aborts a pending list request');
    resolveList(reply(true, { ok: true, screenshots: [] }));
    return loading.then(flush);
  }).then(function () {
    assert.strictEqual(ui.renders, renderCount, 'a late list reply cannot replace an open image');
    ui.listReply = listReply;
    ui.context.event = { target: ui.q('screenshot-viewer-image') }; vm.runInContext(viewerClick, ui.context);
    assert.strictEqual(ui.q('screenshot-viewer').hidden, false, 'clicking the image keeps it open');
    [ui.q('screenshot-viewer-close'), ui.q('screenshot-viewer'), {}].forEach(function (target) {
      ui.context.event = { target: target }; vm.runInContext(viewerClick, ui.context);
      assert.strictEqual(ui.q('screenshot-viewer').hidden, true);
      assert.strictEqual(ui.context.document.activeElement, preview);
      ui.context.openScreenshotViewer(preview);
    });
    before = ui.requests.length; ui.context.document.hidden = true; ui.listeners.visibilitychange();
    assert.strictEqual(ui.q('screenshot-viewer').hidden, true);
    assert.strictEqual(ui.requests.length, before, 'hiding closes without starting requests');
    assert.deepEqual(ui.revoked, [], 'hiding retains the downloaded PNG');
    ui.context.document.hidden = false; preview.isConnected = false; ui.context.openScreenshotViewer(preview);
    assert.strictEqual(ui.q('screenshot-viewer').hidden, true, 'a detached preview cannot reopen');
  });
}
function checkDeletion() {
  var ui = createUI(), images = ui.listed, deleting, count;
  function press(index) { return ui.context.deleteScreenshot(button(ui, 'delete', index)); }
  function clear() { return ui.context.deleteScreenshot(ui.q('screenshots-clear')); }
  return load(ui).then(function () {
    press(); assert.strictEqual(button(ui, 'delete').textContent, 'Press again');
    assert.strictEqual(ui.writes.length, 0, 'first press never writes');
    ui.tick(4999); deleting = press();
    assert.deepEqual(ui.writes[0].body, { action: 'delete', id: images[0].id });
    assert.strictEqual(ui.writes[0].url, '/api/screenshots');
    assert.strictEqual(ui.writes[0].options.headers['Content-Type'], 'application/json');
    press(); press(1); clear(); ui.context.takeScreenshot();
    assert.strictEqual(ui.writes.length, 1, 'pending delete blocks other writes');
    assert.strictEqual(button(ui, 'delete').disabled, true);
    ui.listed = [images[1]]; ui.pending.shift().resolve(reply(true, { ok: true }));
    return deleting.then(flush);
  }).then(function () {
    assert.strictEqual(ui.q('screenshots-message').textContent, 'Screenshot deleted.');
    assert.strictEqual(button(ui, 'delete').dataset.id, images[1].id, 'success refreshes the real gallery');
    ui.listed = images; return load(ui);
  }).then(function () {
    press(); ui.tick(5000); assert.strictEqual(button(ui, 'delete').textContent, 'Delete');
    press(); assert.strictEqual(ui.writes.length, 1, 'expiry needs a fresh second press');
    press(1); assert.strictEqual(button(ui, 'delete').textContent, 'Delete');
    assert.strictEqual(button(ui, 'delete', 1).textContent, 'Press again');
    press(); assert.strictEqual(ui.writes.length, 1, 'switching targets needs confirmation');
    return ['section', 'tab', 'document'].reduce(function (chain, hidden) { return chain.then(function () {
      ui.q('disc-screenshots').open = hidden !== 'section';
      ui.context.activeTab = hidden === 'tab' ? 'other' : 'tools'; ui.context.document.hidden = hidden === 'document';
      if (hidden === 'section') ui.q('disc-screenshots').listeners.toggle();
      else if (hidden === 'document') ui.listeners.visibilitychange();
      else ui.context.updateScreenshots();
      ui.q('disc-screenshots').open = true; ui.context.activeTab = 'tools'; ui.context.document.hidden = false;
      return load(ui).then(function () { press(); assert.strictEqual(ui.writes.length, 1, hidden + ' cancels confirmation'); });
    }); }, Promise.resolve());
  }).then(function () {
    ui.writable = false; return load(ui);
  }).then(function () {
    assert.strictEqual(button(ui, 'delete').hidden, true);
    assert.strictEqual(ui.q('screenshots-clear').hidden, true);
    assert.strictEqual(ui.q('screenshots-take').disabled, true);
    press(); ui.context.takeScreenshot(); assert.strictEqual(ui.writes.length, 1);
    ui.writable = true; return load(ui);
  }).then(function () {
    press(); assert.strictEqual(ui.writes.length, 1, 'restored write access needs fresh confirmation');
    ui.listed = [images[1]]; return load(ui);
  }).then(function () {
    ui.listed = images; return load(ui);
  }).then(function () {
    press(); assert.strictEqual(ui.writes.length, 1, 'a reappearing target needs fresh confirmation');
    deleting = press(); ui.pending.shift().resolve(reply(false, { ok: false, error: 'delete refused' }));
    return deleting.then(flush);
  }).then(function () {
    assert.strictEqual(ui.q('screenshots-message').textContent, 'delete refused');
    assert.strictEqual(ui.images.length, 2, 'failed deletion retains the images');
    press(); assert.strictEqual(ui.writes.length, 2, 'a failed write needs new confirmation');
    var capturing = ui.context.takeScreenshot();
    press(); clear(); ui.context.takeScreenshot(); assert.strictEqual(ui.writes.length, 3, 'capture blocks other writes');
    assert.deepEqual(ui.writes[2].body, { action: 'capture', method: 'DISPLAY', resolution: '1920x1080' });
    assert.strictEqual(button(ui, 'delete').textContent, 'Delete', 'capture cancels confirmation');
    ui.pending.shift().reject(new Error('capture offline')); return capturing.then(flush);
  }).then(function () {
    assert.strictEqual(ui.q('screenshots-take').disabled, false);
    assert.strictEqual(ui.q('screenshots-message').textContent, 'capture offline');
    clear(); ui.tick(5000); assert.strictEqual(ui.q('screenshots-clear').textContent, 'Clear all');
    clear(); press(); assert.strictEqual(ui.q('screenshots-clear').textContent, 'Clear all');
    clear(); return ui.context.loadScreenshots().then(flush);
  }).then(function () {
    assert.strictEqual(ui.q('screenshots-clear').textContent, 'Press again', 'polling keeps clear confirmation');
    deleting = clear(); assert.deepEqual(ui.writes[3].body, { action: 'clear' });
    press(); clear(); ui.context.takeScreenshot(); assert.strictEqual(ui.writes.length, 4);
    ui.pending.shift().resolve(reply(false, { ok: false, error: 'clear refused' })); return deleting.then(flush);
  }).then(function () {
    assert.strictEqual(ui.q('screenshots-message').textContent, 'clear refused');
    clear(); assert.strictEqual(ui.writes.length, 4, 'failed clear needs fresh confirmation');
    deleting = clear(); ui.listed = []; ui.pending.shift().resolve(reply(true, { ok: true }));
    return deleting.then(flush);
  }).then(function () {
    assert.strictEqual(ui.q('screenshots-message').textContent, 'Screenshots cleared.');
    assert.strictEqual(ui.q('screenshots-clear').disabled, true);
    count = ui.writes.length; clear(); assert.strictEqual(ui.writes.length, count, 'empty gallery cannot be cleared');
  });
}
function checkDownloads() {
  var ui = createUI(), download = { dataset: { id: 'capture_download.png' }, isConnected: true };
  ui.context.token = 'private-key';
  return ui.context.downloadScreenshot(download).then(function () {
    assert.strictEqual(ui.requests[0].url, '/api/screenshots/image?id=capture_download.png');
    assert.strictEqual(ui.requests[0].options.headers.Authorization, 'Bearer private-key');
    assert.strictEqual(ui.created[0].blob, png);
    assert.strictEqual(ui.links[0].download, download.dataset.id);
    assert.strictEqual(ui.clicked, ui.created[0].url);
    assert.strictEqual(ui.links[0].removed, true);
    assert.strictEqual(download.disabled, false);
    assert.deepEqual(ui.revoked, []);
    ui.tick(60000); assert.deepEqual(ui.revoked, [ui.created[0].url]);
    ui.context.token = ''; ui.clicked = null; return ui.context.downloadScreenshot(download);
  }).then(function () {
    assert.strictEqual(ui.requests[1].options.headers.Authorization, undefined);
    assert.strictEqual(ui.links.length, 2);
    assert.strictEqual(ui.clicked, ui.created[1].url);
    assert.strictEqual(ui.links[1].download, download.dataset.id);
    return [reply(false, png), reply(true, { type: 'text/html', size: 10 }), reply(true, { type: 'image/png', size: 0 }), new Error('offline')]
      .reduce(function (chain, response) { return chain.then(function () {
        var links = ui.links.length; ui.clicked = null; ui.q('screenshots-message').textContent = '';
        ui.imageReply = function () { return response instanceof Error ? Promise.reject(response) : Promise.resolve(response); };
        return ui.context.downloadScreenshot(download).then(function () {
          assert.strictEqual(ui.clicked, null);
          assert.strictEqual(ui.links.length, links);
          assert.strictEqual(download.disabled, false);
          assert.ok(ui.q('screenshots-message').textContent);
        });
      }); }, Promise.resolve());
  });
}
checkGallery().then(checkViewer).then(checkDeletion).then(checkDownloads).then(function () {
  clearTimeout(guard); console.log('test-screenshots-ui.js passed');
}).catch(function (error) { console.error(error.stack || error); process.exit(1); });
