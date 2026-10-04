// Formatting and escaping helpers, and the toggle pill.

const api = p => p + (K ? (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K) : '');
const mb = k => (k / 1024).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = s => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
/*
 * For a value landing in a single-quoted JS string inside an attribute -
 * onclick="c('launchApp','<id>')". Both escapes are needed, in this order: the
 * browser HTML-decodes the attribute before the JS in it is parsed, so &#39;
 * would arrive back as a quote that ends the string early. A backslash escape
 * survives that decode; esc() then keeps the value inside the attribute.
 */
const jsq = s => esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
const hrs = h => h == null ? '—' : (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1));
/* Binary steps labelled kB/MB/GB, matching mb() above and the rest of the
   dashboard. Three significant figures at most: a lifetime byte counter is
   read for its order of magnitude, not its last digit. */
const bytes = n => {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
};

/* Standardized interactive toggle pill component helpers */
function renderToggle(opts) {
  const cls = 'pill ' + (opts.cls || 'idle');
  const id = opts.id ? ' id="' + esc(opts.id) + '"' : '';
  const on = opts.on !== undefined ? ' data-on="' + (opts.on ? '1' : '') + '"' : '';
  const next = opts.next !== undefined ? ' data-next="' + esc(opts.next) + '"' : '';
  const dis = opts.disabled ? ' disabled' : '';
  const onclick = opts.onclick ? ' onclick="' + opts.onclick + '"' : '';
  const extra = opts.attrs ? ' ' + opts.attrs : '';
  return '<button type="button" class="' + cls + '"' + id + on + next + dis + onclick + extra + '>' +
         esc(opts.label) + '</button>';
}

function updateToggle(btnOrId, opts) {
  const b = typeof btnOrId === 'string' ? q(btnOrId) : btnOrId;
  if (!b) return;
  if (opts.cls !== undefined) b.className = 'pill ' + opts.cls;
  if (opts.label !== undefined) b.textContent = opts.label;
  if (opts.on !== undefined) b.dataset.on = opts.on ? '1' : '';
  if (opts.disabled !== undefined) b.disabled = !!opts.disabled;
}
