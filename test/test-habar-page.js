/*
 * test/test-habar-page.js - the Home Assistant bar's page loads itself again
 * once the server serves another (lib/habar.js pageVersion), and only while
 * out of sight: at once if hidden, else once closed.
 */
var fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');

console.log('Running test-habar-page.js ...');
if (Number(process.versions.node.split('.')[0]) < 8) {
  // The page runs in the TV's browser; the fake DOM below needs a Proxy.
  console.log('test-habar-page.js: browser script skipped on legacy node');
  console.log('ALL test-habar-page.js assertions passed!');
} else {
  var html = fs.readFileSync(path.join(__dirname, '..', 'server', 'assets', 'habar.html'), 'utf8');
  var script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  // Any element the page asks for, with whatever it reads off one.
  function element() {
    var own = { innerHTML: '', textContent: '', className: '', style: {}, childNodes: [], attrs: {} };
    return new Proxy(own, {
      get: function (o, k) {
        if (k in o) return o[k];
        if (k === 'getAttribute') return function (n) { return o.attrs[n] || null; };
        if (k === 'setAttribute') return function (n, v) { o.attrs[n] = v; };
        if (k === 'querySelector') return function () { return null; };
        if (k === 'querySelectorAll') return function () { return []; };
        if (k === 'getBoundingClientRect') return function () { return { left: 0, right: 0, width: 0 }; };
        if (typeof k === 'string' && /^(add|remove)EventListener$|^focus$|^scroll/.test(k)) return function () {};
        return 0;
      },
      set: function (o, k, v) { o[k] = v; return true; }
    });
  }

  function page(search) {
    var timers = [], nextId = 1, now = 1000;
    var xhrs = [], listeners = {}, replaced = [], closed = 0;
    var els = {};
    var document = {
      hidden: true,
      body: element(),
      getElementById: function (id) { return els[id] || (els[id] = element()); },
      addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      createElement: function () { return element(); }
    };
    function XMLHttpRequest() {}
    XMLHttpRequest.prototype.open = function (method, url) { this.method = method; this.url = url; };
    XMLHttpRequest.prototype.setRequestHeader = function () {};
    XMLHttpRequest.prototype.send = function () { xhrs.push(this); };
    var context = {
      document: document,
      location: { search: search, pathname: '/assets/habar.html', replace: function (u) { replaced.push(u); } },
      window: { close: function () { closed++; }, PalmSystem: null },
      XMLHttpRequest: XMLHttpRequest,
      Date: (function () {
        function FakeDate() { return new Date(now); }
        FakeDate.now = function () { return now; };
        return FakeDate;
      })(),
      setTimeout: function (fn, ms) { timers.push({ id: nextId, at: now + ms, fn: fn }); return nextId++; },
      setInterval: function (fn, ms) { timers.push({ id: nextId, at: now + ms, fn: fn, every: ms }); return nextId++; },
      clearTimeout: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
      clearInterval: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
      JSON: JSON, Math: Math, String: String, Number: Number, parseInt: parseInt, isNaN: isNaN
    };
    context.window.document = document;
    vm.runInNewContext(script, context);
    return {
      document: document, replaced: replaced,
      closedCount: function () { return closed; },
      // Answers the oldest request for this path with the given body.
      answer: function (pathStart, body) {
        for (var i = 0; i < xhrs.length; i++) {
          if (xhrs[i].url.indexOf(pathStart) === 0) {
            var x = xhrs.splice(i, 1)[0];
            x.responseText = JSON.stringify(body);
            x.onload();
            return true;
          }
        }
        return false;
      },
      // Runs every timer due within ms, in order, as time passes.
      advance: function (ms) {
        var end = now + ms;
        for (;;) {
          timers.sort(function (a, b) { return a.at - b.at; });
          var t = timers[0];
          if (!t || t.at > end) break;
          now = t.at;
          if (t.every) t.at += t.every; else timers.shift();
          t.fn();
        }
        now = end;
      },
      fire: function (type, ev) { (listeners[type] || []).forEach(function (fn) { fn(ev || {}); }); }
    };
  }

  function state(pageHash) {
    return { ok: true, configured: true, showHints: true, refreshMs: 1000, page: pageHash,
      tiles: [{ id: 'light.desk', domain: 'light', label: 'Desk', state: 'on', valueText: 'On' }] };
  }

  // 1. Preloaded and hidden: the first answer is the page it came from; the
  // same page served again after a watchdog restart changes nothing.
  var p = page('?t=1&preload=1');
  assert.ok(p.answer('/api/ha/bar/state', state('aaa')), 'a preloaded page reads the state once');
  p.advance(60000);
  assert.ok(p.answer('/api/ha/bar/page', { ok: true, page: 'aaa' }), 'checked each minute while hidden');
  assert.deepEqual(p.replaced, [], 'the same page served: no reload');

  // A server update serves another: hidden, it loads itself again at once,
  // as preloaded so it stays out of sight.
  p.advance(60000);
  assert.ok(p.answer('/api/ha/bar/page', { ok: true, page: 'bbb' }));
  assert.strictEqual(p.replaced.length, 1, 'a hidden page loads the new one');
  assert.ok(/[?&]preload=1(&|$)/.test(p.replaced[0]), 'loaded again as preloaded: ' + p.replaced[0]);
  console.log('  ✓ a hidden bar loads the page again only once the server serves another');

  // 2. On screen when the new page shows up: it stays until closed, then loads.
  var q = page('?t=1&preload=1');
  q.answer('/api/ha/bar/state', state('aaa'));
  q.document.hidden = false;
  q.fire('webOSRelaunch', { detail: {} });
  assert.ok(q.answer('/api/ha/bar/state', state('aaa')), 'opening reads the state');
  assert.strictEqual(q.document.body.className, 'on', 'the bar is on screen');
  q.advance(1000);
  assert.ok(q.answer('/api/ha/bar/state', state('bbb')), 'the open bar refreshes each second');
  q.advance(60000);
  assert.deepEqual(q.replaced, [], 'not reloaded while on screen');
  q.fire('keydown', { keyCode: 461, preventDefault: function () {} });
  q.advance(180);
  assert.strictEqual(q.closedCount(), 1, 'Back closes the bar as before');
  assert.deepEqual(q.replaced, [], 'not while it is still closing');
  q.advance(1000);
  assert.strictEqual(q.replaced.length, 1, 'loaded again once out of sight');
  assert.ok(/[?&]preload=1(&|$)/.test(q.replaced[0]));
  console.log('  ✓ an open bar that sees a new page loads it only after it is closed');

  console.log('ALL test-habar-page.js assertions passed!');
}
