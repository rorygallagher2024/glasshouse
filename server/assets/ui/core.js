// The token, q(), the activity pips, write leases and the fetch wrapper.

/* The token arrives once in the link (a bookmark, or the TV's QR codes) and
   is kept in the browser, so it can come out of the address bar and stay out
   of history and copied URLs. Where storage is blocked it stays in the URL,
   or a reload would lose it. */
const K = (() => {
  const s = new URLSearchParams(location.search);
  const k = s.get('k');
  if (k === null) {
    try { return localStorage.getItem('tvweb_k') || ''; } catch (e) { return ''; }
  }
  try { localStorage.setItem('tvweb_k', k); } catch (e) { return k; }
  s.delete('k');
  history.replaceState(history.state, '', location.pathname + (s.toString() ? '?' + s : '') + location.hash);
  return k;
})();
const q = id => document.getElementById(id);

let inFlight = 0;
let rxTimer = null;
function setBusy(on, stage) {
  const tx = q('act-tx');
  const rx = q('act-rx');
  if (on) {
    inFlight++;
    if (stage === 'rx') {
      if (tx) tx.classList.remove('lit');
      if (rx) rx.classList.add('lit');
      if (rxTimer) clearTimeout(rxTimer);
      rxTimer = setTimeout(() => {
        if (rx) rx.classList.remove('lit');
      }, 200);
    } else {
      if (tx) tx.classList.add('lit');
    }
  } else {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0 && tx) {
      tx.classList.remove('lit');
    }
  }
}

const leases = {};
function setLease(key, val, ttl = 3000) {
  leases[key] = { val: val, exp: Date.now() + ttl };
}
function getLease(key, currentVal) {
  const l = leases[key];
  if (!l) return undefined;
  if (Date.now() > l.exp) {
    delete leases[key];
    return undefined;
  }
  if (currentVal !== undefined && currentVal !== null && currentVal === l.val) {
    delete leases[key];
    return undefined;
  }
  return l.val;
}
function clearLease(key) {
  delete leases[key];
}
let lastArOff = null;

// A request that never reaches the TV rejects with the browser's own wording
// ("Failed to fetch" in Chrome, "Load failed" in Safari), which reads as a
// fault in the page rather than a TV that is off.
const netFetch = window.fetch.bind(window);
window.fetch = (...a) => netFetch(...a).catch(e => {
  if (e && e.name === 'AbortError') throw e;
  const x = new Error(t('common.unreachable', 'Can’t reach the TV'));
  x.offline = true;
  throw x;
});
