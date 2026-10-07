// The Tools tab: System logs and diagnostic tools.

let toolsSources = { system: true, glasshouse: true, kernel: false };
let toolsLimit = 100;
let toolsLevel = 'all';
let toolsQuery = '';
let toolsLive = true;
let toolsAutoScroll = true;
let toolsRedact = false;
let toolsEntries = [];
let toolsExpandedIdx = null;
let toolsPollTimer = null;
let toolsInFlight = false;
let toolsMeta = null;

function redactToolsText(str) {
  if (!str) return str;
  return String(str)
    .replace(/(:\/\/[^:]+:)[^@\s]+(@)/g, '$1<REDACTED>$2')
    .replace(/((\?|&)(?:k|token|key|api_key|auth)=)[^&\s"'`>]+/gi, '$1<REDACTED>')
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1<REDACTED>')
    .replace(/(["']?(?:password|passwd|secret|client_secret|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^"',\s}]+(["']?)/gi, '$1<REDACTED>$2')
    .replace(/(["']?(?:serial(?:_?number)?|device_?id|esn)["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{6,}(["']?)/gi, '$1<SERIAL>$2')
    .replace(/(ssid["':=\s]+["'])[^\r\n"']*(["'])/gi, '$1<SSID>$2')
    .replace(/\b([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})\b/g, '<MAC>')
    .replace(/(?:\bfe80:[0-9a-fA-F:]+\b|\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b|\b[0-9a-fA-F]{1,4}::[0-9a-fA-F:]*\b)/gi, '<IPV6>')
    .replace(/\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '<IP>');
}

function toggleToolsRedact() {
  toolsRedact = !toolsRedact;
  const btn = q('tools-redact-btn');
  if (btn) {
    btn.classList.toggle('active', toolsRedact);
    btn.classList.toggle('on', toolsRedact);
  }
  renderToolsLogs();
}

function formatLogTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.substring(11, 23) || isoStr;
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  } catch (e) {
    return isoStr;
  }
}

function formatUptimeStr(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function levelShort(lvl) {
  if (!lvl) return 'INFO';
  const l = lvl.toLowerCase();
  if (l === 'error' || l === 'err') return 'ERR';
  if (l === 'warning' || l === 'warn') return 'WARN';
  if (l === 'debug') return 'DBG';
  return 'INFO';
}

function highlightText(text, qry) {
  const safe = esc(text || '');
  if (!qry) return safe;
  const escapedQry = qry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escapedQry})`, 'gi');
  return safe.replace(re, '<mark class="log-hl">$1</mark>');
}

function extractJsonPayload(text) {
  if (!text) return null;
  const idx = text.indexOf('{');
  if (idx === -1) return null;
  const candidate = text.substring(idx).trim();
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

function colorizeJson(obj) {
  const jsonStr = JSON.stringify(obj, null, 2);
  return esc(jsonStr).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\\-]?\d+)?)/g, match => {
    let cls = 'json-num';
    if (/^"/.test(match)) {
      cls = /:$/.test(match) ? 'json-key' : 'json-str';
    } else if (/true|false/.test(match)) {
      cls = 'json-bool';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
}

async function loadLogs(silent = false) {
  if (toolsInFlight) return;
  toolsInFlight = true;
  if (!silent) {
    const list = q('tools-log-entries');
    if (list && !toolsEntries.length) {
      list.innerHTML = `<div class="tools-term-empty">${esc(t('tools.loading', 'Loading system logs...'))}</div>`;
    }
  }

  const activeSrcs = Object.keys(toolsSources).filter(k => toolsSources[k]);
  const srcParam = activeSrcs.length ? activeSrcs.join(',') : 'none';
  const url = `/api/logs?sources=${encodeURIComponent(srcParam)}&limit=${toolsLimit}`;

  try {
    const res = await (await fetch(api(url), { cache: 'no-store' })).json();
    if (!res || !res.ok) {
      throw new Error((res && res.error) || 'Failed to fetch logs');
    }
    toolsMeta = res;
    toolsEntries = res.entries || [];
    updateToolsStats();
    renderToolsLogs();
  } catch (e) {
    if (!silent) {
      const list = q('tools-log-entries');
      if (list) {
        list.innerHTML = `<div class="tools-term-empty text-err">${esc(e.message)}</div>`;
      }
    }
  } finally {
    toolsInFlight = false;
  }
}

function updateToolsStats() {
  if (!toolsMeta) return;
  const total = toolsEntries.length;
  const errCount = toolsEntries.filter(e => e.level === 'error').length;
  const warnCount = toolsEntries.filter(e => e.level === 'warning').length;

  if (q('tools-cnt-total')) q('tools-cnt-total').textContent = String(total);
  if (q('tools-cnt-errors')) q('tools-cnt-errors').textContent = String(errCount);
  if (q('tools-cnt-warnings')) q('tools-cnt-warnings').textContent = String(warnCount);

  if (q('tools-uptime')) {
    q('tools-uptime').textContent = formatUptimeStr(toolsMeta.uptime);
  }
  if (q('tools-boottime') && toolsMeta.bootTime) {
    try {
      const bDate = new Date(toolsMeta.bootTime);
      q('tools-boottime').textContent = bDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      q('tools-boottime').textContent = '—';
    }
  }

  const activeSrcs = Object.keys(toolsSources).filter(k => toolsSources[k]);
  if (q('tools-cnt-sources')) {
    q('tools-cnt-sources').textContent = t('tools.activeSources', '{active} active sources', { active: activeSrcs.length });
  }

  // Update error/warning stat card highlights and active filter
  const errCard = q('tools-card-errors');
  if (errCard) {
    errCard.classList.toggle('has-err', errCount > 0);
    errCard.classList.toggle('active-filter', toolsLevel === 'error');
  }
  const warnCard = q('tools-card-warnings');
  if (warnCard) {
    warnCard.classList.toggle('has-warn', warnCount > 0);
    warnCard.classList.toggle('active-filter', toolsLevel === 'warning');
  }

  // Synchronize refresh button visibility with live mode
  const refBtn = q('tools-refresh-btn');
  if (refBtn) refBtn.hidden = toolsLive;
}

function getFilteredEntries() {
  const qry = toolsQuery.toLowerCase().trim();
  return toolsEntries.filter(e => {
    if (toolsLevel === 'error' && e.level !== 'error') return false;
    if (toolsLevel === 'warning' && e.level !== 'warning') return false;
    if (toolsLevel === 'info' && e.level !== 'info') return false;

    if (qry) {
      const matchMsg = e.msg && e.msg.toLowerCase().includes(qry);
      const matchProc = e.proc && e.proc.toLowerCase().includes(qry);
      const matchSrc = e.source && e.source.toLowerCase().includes(qry);
      const matchRaw = e.raw && e.raw.toLowerCase().includes(qry);
      if (!matchMsg && !matchProc && !matchSrc && !matchRaw) return false;
    }
    return true;
  });
}

function renderToolsLogs() {
  const container = q('tools-log-entries');
  if (!container) return;

  const filtered = getFilteredEntries();
  const countEl = q('tools-search-count');
  if (countEl) {
    countEl.textContent = t('tools.showingCount', 'Showing {visible} of {total} entries', {
      visible: filtered.length,
      total: toolsEntries.length
    });
  }

  if (!filtered.length) {
    container.innerHTML = `
      <div class="tools-term-empty">
        <div>${esc(t('tools.empty', 'No log entries found matching the filter.'))}</div>
        ${toolsQuery || toolsLevel !== 'all' ? `<button type="button" class="pill" style="margin-top:12px" onclick="resetToolsFilters()">${esc(t('tools.clearFilter', 'Clear filter'))}</button>` : ''}
      </div>`;
    return;
  }

  let html = '';
  for (let i = 0; i < filtered.length; i++) {
    const e = filtered[i];
    const isExpanded = toolsExpandedIdx === i;
    const timeFormatted = formatLogTime(e.ts);
    const monoTip = e.mono != null ? ' (' + t('tools.uptimeOffset', '+{sec}s uptime', { sec: e.mono.toFixed(1) }) + ')' : '';
    const fullTimeTip = esc(e.ts + monoTip);
    const lvl = levelShort(e.level);
    const displayMsg = toolsRedact ? redactToolsText(e.msg) : e.msg;
    const displayRaw = toolsRedact ? redactToolsText(e.raw) : e.raw;
    const displayProc = toolsRedact ? redactToolsText(e.proc) : e.proc;

    let detailHtml = '';
    if (isExpanded) {
      const jsonPayload = extractJsonPayload(displayMsg);
      detailHtml = `
        <div class="log-detail" onclick="event.stopPropagation()">
          <div class="log-detail-meta">
            <div><span class="lbl">${esc(t('tools.col.time', 'Time'))}:</span> <code>${esc(e.ts)}</code> (${monoTip.trim()})</div>
            <div><span class="lbl">${esc(t('tools.col.source', 'Source'))}:</span> <code>${esc(e.source)}</code></div>
            <div><span class="lbl">${esc(t('tools.col.process', 'Process'))}:</span> <code>${esc(displayProc)}</code></div>
            <div><span class="lbl">${esc(t('tools.col.level', 'Level'))}:</span> <span class="log-lvl lvl-${lvl}">${lvl}</span></div>
          </div>
          <div class="log-detail-sec">
            <div class="log-detail-head">
              <span>${esc(t('tools.rawLine', 'Raw log line'))}</span>
              <button type="button" class="pill" onclick="copyToolsRaw(${i}, this)">${esc(t('tools.copyRaw', 'Copy raw'))}</button>
            </div>
            <pre class="log-raw-box"><code>${esc(displayRaw)}</code></pre>
          </div>
          ${jsonPayload ? `
          <div class="log-detail-sec">
            <div class="log-detail-head">
              <span>${esc(t('tools.structuredJson', 'Structured event payload'))}</span>
            </div>
            <pre class="log-json-box"><code>${colorizeJson(jsonPayload)}</code></pre>
          </div>` : ''}
        </div>`;
    }

    html += `
      <div class="log-row lvl-${e.level}${isExpanded ? ' expanded' : ''}" data-idx="${i}" onclick="toggleToolsLogDetail(${i})">
        <div class="term-col term-col-time" title="${fullTimeTip}">${timeFormatted}</div>
        <div class="term-col term-col-src"><span class="log-src src-${esc(e.source)}">${esc(e.source)}</span></div>
        <div class="term-col term-col-lvl"><span class="log-lvl lvl-${lvl}">${lvl}</span></div>
        <div class="term-col term-col-proc" title="${esc(displayProc)}">${highlightText(displayProc, toolsQuery)}</div>
        <div class="term-col term-col-msg">${highlightText(displayMsg, toolsQuery)}</div>
      </div>
      ${detailHtml}`;
  }

  container.innerHTML = html;

  if (toolsAutoScroll) {
    container.scrollTop = container.scrollHeight;
  }
  setupToolsScrollListener();
}

function toggleToolsSource(src) {
  toolsSources[src] = !toolsSources[src];
  const btn = document.querySelector(`.tools-src-btn[data-src="${src}"]`);
  if (btn) {
    btn.classList.toggle('active', toolsSources[src]);
    btn.classList.toggle('on', toolsSources[src]);
  }
  toolsExpandedIdx = null;
  loadLogs(false);
}

function setToolsLimit(lim) {
  toolsLimit = lim;
  document.querySelectorAll('.tools-lim-btn').forEach(b => {
    const isAct = parseInt(b.dataset.limit, 10) === lim;
    b.classList.toggle('active', isAct);
    b.classList.toggle('on', isAct);
  });
  toolsExpandedIdx = null;
  loadLogs(false);
}

function setToolsLevelFilter(lvl) {
  if (toolsLevel === lvl && (lvl === 'error' || lvl === 'warning')) {
    toolsLevel = 'all';
  } else {
    toolsLevel = lvl;
  }
  document.querySelectorAll('.tools-lvl-btn').forEach(b => {
    const isAct = b.dataset.level === toolsLevel;
    b.classList.toggle('active', isAct);
    b.classList.toggle('on', isAct);
  });
  toolsExpandedIdx = null;
  updateToolsStats();
  renderToolsLogs();
}

function onToolsSearchInput(val) {
  toolsQuery = val || '';
  const clearBtn = q('tools-search-clear');
  if (clearBtn) clearBtn.hidden = !toolsQuery;
  toolsExpandedIdx = null;
  renderToolsLogs();
}

function clearToolsSearch() {
  const inp = q('tools-search-input');
  if (inp) {
    inp.value = '';
    inp.focus();
  }
  toolsQuery = '';
  const clearBtn = q('tools-search-clear');
  if (clearBtn) clearBtn.hidden = true;
  renderToolsLogs();
}

function resetToolsFilters() {
  clearToolsSearch();
  setToolsLevelFilter('all');
}

function toggleToolsLive() {
  toolsLive = !toolsLive;
  const btn = q('tools-live-btn');
  const dot = q('tools-live-dot');
  const txt = q('tools-live-text');
  const refBtn = q('tools-refresh-btn');
  if (btn) btn.classList.toggle('paused', !toolsLive);
  if (dot) dot.classList.toggle('paused', !toolsLive);
  if (txt) txt.textContent = toolsLive ? t('tools.live', 'Live') : t('tools.paused', 'Paused');
  if (refBtn) refBtn.hidden = toolsLive;
  scheduleToolsPoll();
}

function scrollToolsToBottom() {
  const container = q('tools-log-entries');
  if (container) {
    toolsAutoScroll = true;
    try {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    } catch (_) {
      container.scrollTop = container.scrollHeight;
    }
  }
}

function toggleToolsLogDetail(idx) {
  toolsExpandedIdx = toolsExpandedIdx === idx ? null : idx;
  renderToolsLogs();
}

function copyToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error('Copy failed'));
    } catch (err) {
      reject(err);
    }
  });
}

async function copyToolsLogs() {
  const filtered = getFilteredEntries();
  if (!filtered.length) return;
  const lines = filtered.map(e => {
    const msg = toolsRedact ? redactToolsText(e.msg) : e.msg;
    const proc = toolsRedact ? redactToolsText(e.proc) : e.proc;
    return `[${e.ts}] [${e.source.toUpperCase()}] [${levelShort(e.level)}] [${proc}] ${msg}`;
  });
  const text = lines.join('\n');
  try {
    await copyToClipboard(text);
    const btn = q('tools-copy-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = t('tools.copied', 'Copied!');
      btn.classList.add('good');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('good');
      }, 2000);
    }
  } catch (e) {
    showErr(e.message || 'Copy failed');
  }
}

async function copyToolsRaw(idx, btn) {
  const filtered = getFilteredEntries();
  const e = filtered[idx];
  if (!e) return;
  const raw = toolsRedact ? redactToolsText(e.raw) : e.raw;
  try {
    await copyToClipboard(raw);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = t('tools.copied', 'Copied!');
      btn.classList.add('good');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('good');
      }, 1500);
    }
  } catch (err) {
    showErr(err.message || 'Copy failed');
  }
}

function downloadToolsLogs() {
  const filtered = getFilteredEntries();
  if (!filtered.length) return;
  const header = `# Glasshouse & webOS System Logs\n# Exported: ${new Date().toISOString()}\n# Entries: ${filtered.length}\n# Redacted: ${toolsRedact ? 'true' : 'false'}\n\n`;
  const lines = filtered.map(e => {
    const raw = toolsRedact ? redactToolsText(e.raw) : e.raw;
    const proc = toolsRedact ? redactToolsText(e.proc) : e.proc;
    return `[${e.ts}] [${e.source.toUpperCase()}] [${levelShort(e.level)}] [${proc}] ${raw}`;
  });
  const content = header + lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  const nowStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = URL.createObjectURL(blob);
  a.download = `glasshouse-logs-${nowStr}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function scheduleToolsPoll() {
  if (toolsPollTimer) clearTimeout(toolsPollTimer);
  if (!toolsLive || activeTab !== 'tools') return;
  toolsPollTimer = setTimeout(async () => {
    if (activeTab === 'tools' && toolsLive) {
      await loadLogs(true);
    }
    scheduleToolsPoll();
  }, 2500);
}

// Track user scroll on terminal to decouple auto-scroll if scrolled up
function setupToolsScrollListener() {
  const container = q('tools-log-entries');
  if (container && !container._toolsScrollBound) {
    container._toolsScrollBound = true;
    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 35;
      toolsAutoScroll = atBottom;
    });
  }
}

document.addEventListener('DOMContentLoaded', setupToolsScrollListener);
