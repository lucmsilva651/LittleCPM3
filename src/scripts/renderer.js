/* renderer.js — UI logic */

// ── App metadata ─────────────────────────────────────────────────────────────
import pkg from "../../package.json" with { type: "json" };
const appName = pkg.packageName;

const MAX_BYTES = 720;
let currentTab = 'editor';

// ─── Utility ─────────────────────────────────────────────────────────────────

const _enc = new TextEncoder();

function byteLen(str) {
  return _enc.encode(str).length;
}

function now() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function log(msg, type = 'info') {
  const panel = document.getElementById('log-panel');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${now()}</span><span class="log-msg ${type}">${msg}</span>`;
  panel.appendChild(entry);
  panel.scrollTop = panel.scrollHeight;
  // Keep last 120 lines
  while (panel.children.length > 120) panel.removeChild(panel.firstChild);
}

function toast(msg, type = 'info', ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', ms);
}

function setOverlay(visible, msg = 'Working...') {
  const el = document.getElementById('overlay');
  document.getElementById('overlay-msg').textContent = msg;
  el.classList.toggle('visible', visible);
}

function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const textEl = document.getElementById('status-text');
  if (dot) dot.className = `dot ${state}`;
  if (textEl) textEl.textContent = text;
}

function setBusy(msg) {
  setStatus('busy', msg);
  setOverlay(true, msg);
  _btns.forEach(b => b.disabled = true);
}

function setIdle() {
  setOverlay(false);
  _btns.forEach(b => b.disabled = false);
}

function explainPm3Error(errText) {
  const raw = String(errText || 'Unknown error');
  const lower = raw.toLowerCase();

  if (lower.includes('multiple tags') || lower.includes('collision')) {
    return 'Multiple cards/tags detected near the antenna. Keep only one card in the RF field and retry.';
  }
  if (lower.includes("can't find") || lower.includes('wrong key') || lower.includes('auth')) {
    return 'Authentication failed. Run card operation again to trigger autopwn key discovery.';
  }
  if (lower.includes('permission') || lower.includes('accessrights')) {
    return 'Serial port permission issue. Ensure your user has read/write access to /dev/ttyACM*.';
  }
  if (lower.includes('no json file')) {
    return 'Card dump failed before JSON generation. Common causes: tag collision or key mismatch.';
  }
  return raw;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function setTab(name, btn) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('pane-editor').style.display = name === 'editor' ? 'flex' : 'none';
  document.getElementById('pane-hex').style.display    = name === 'hex'    ? 'flex' : 'none';
  if (name === 'hex') renderHex(document.getElementById('editor').value);
}

// ─── Storage bar & byte counter ───────────────────────────────────────────────

function updateByteCount(str) {
  const n = byteLen(str);
  const pct = Math.min((n / MAX_BYTES) * 100, 100);
  const fill = document.getElementById('storage-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('full', n >= MAX_BYTES);

  const el = document.getElementById('byte-count');
  el.textContent = `${n} / ${MAX_BYTES} B`;
  el.className = 'byte-count' + (n > MAX_BYTES ? ' over' : n > MAX_BYTES * 0.8 ? ' warn' : '');

  document.getElementById('used-bytes').textContent = n;
  document.getElementById('total-bytes').textContent = MAX_BYTES;
  document.getElementById('pct-text').textContent = Math.round(pct) + '%';

  updateLineNumbers(str);
}

function updateLineNumbers(str) {
  const lines = document.getElementById('editor-lines');
  const total = Math.max(1, String(str).split('\n').length);
  const numbers = Array.from({ length: total }, (_, i) => String(i + 1)).join('\n');
  if (lines.textContent !== numbers) {
    lines.textContent = numbers;
  }
}

function syncEditorLineScroll() {
  const editor = document.getElementById('editor');
  const lines = document.getElementById('editor-lines');
  lines.style.transform = `translateY(${-editor.scrollTop}px)`;
}

document.getElementById('editor').addEventListener('input', e => {
  updateByteCount(e.target.value);
  if (currentTab === 'hex') renderHex(e.target.value);
});

document.getElementById('editor').addEventListener('scroll', () => {
  syncEditorLineScroll();
});

// ─── Hex renderer ─────────────────────────────────────────────────────────────

function renderHex(str) {
  const view = document.getElementById('hex-view');
  if (!str) {
    view.innerHTML = '<span class="hex-empty">No content — write something in the Editor tab.</span>';
    return;
  }
  const bytes = _enc.encode(str);
  let html = '';
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    const addr = i.toString(16).padStart(4, '0');
    const hexPart = Array.from(row).map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const asciiPart = Array.from(row).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '·').join('');
    html += `<div class="hex-row">
      <span class="hex-addr">${addr}</span>
      <span class="hex-bytes">${hexPart}</span>
      <span class="hex-ascii">${asciiPart}</span>
    </div>`;
  }
  view.innerHTML = html;
}

// ─── Card info panel ──────────────────────────────────────────────────────────

function updateCardInfo(data) {
  document.getElementById('info-port').textContent   = data.port   || '—';
  document.getElementById('info-uid').textContent    = data.uid    || '—';
  document.getElementById('info-status').textContent = data.hasData ? 'has data' : 'empty';
  document.getElementById('info-status').className   = 'info-val ' + (data.hasData ? 'amber' : 'green');

  if (data.meta) {
    const ci = data.meta.chunkIndex;
    const ct = data.meta.totalChunks;
    document.getElementById('info-chunk').textContent = `${ci + 1} / ${ct}`;
  } else {
    document.getElementById('info-chunk').textContent = '—';
  }

  // Update storage bar from card data
  const used = data.usedBytes || 0;
  const pct  = Math.min((used / MAX_BYTES) * 100, 100);
  const fill = document.getElementById('storage-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('full', used >= MAX_BYTES);
  document.getElementById('used-bytes').textContent = used;
  document.getElementById('pct-text').textContent = Math.round(pct) + '%';
}

function runtimePlatformLabel() {
  const p = String(navigator.platform || '').toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac')) return 'macOS';
  if (p.includes('linux')) return 'Linux';
  return navigator.platform || 'Unknown OS';
}

function updateRuntimeLabels(data) {
  const cardTypeEl = document.getElementById('runtime-card-type');
  const envEl = document.getElementById('runtime-env-label');
  const cardType = data && data.cardType ? data.cardType : 'Waiting for card...';
  const device = data && data.deviceLabel ? data.deviceLabel : 'Proxmark3';
  const port = data && data.port ? data.port : 'no-port';
  const osLabel = runtimePlatformLabel();

  if (cardTypeEl) cardTypeEl.textContent = cardType;
  if (envEl) {
    const lowerDevice = String(device).toLowerCase();
    const lowerPort = String(port).toLowerCase();
    const hasPortInDevice = lowerPort !== 'no-port' && lowerDevice.includes(lowerPort);

    const parts = [`${MAX_BYTES} B/card`, device];
    if (!hasPortInDevice && lowerPort !== 'no-port') parts.push(port);
    parts.push(osLabel);
    envEl.textContent = parts.join(' · ');
  }
}

function bindUiActions() {
  const btnRead = document.getElementById('btn-read');
  const btnWrite = document.getElementById('btn-write');
  const btnWipe = document.getElementById('btn-wipe');
  const btnSplit = document.getElementById('btn-split');
  const tabEditor = document.getElementById('tab-editor');
  const tabHex = document.getElementById('tab-hex');

  if (btnRead) btnRead.addEventListener('click', doRead);
  if (btnWrite) btnWrite.addEventListener('click', doWrite);
  if (btnWipe) btnWipe.addEventListener('click', doWipe);
  if (btnSplit) btnSplit.addEventListener('click', doSplit);

  if (tabEditor) tabEditor.addEventListener('click', () => setTab('editor', tabEditor));
  if (tabHex) tabHex.addEventListener('click', () => setTab('hex', tabHex));
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function doRead() {
  setBusy('Reading from card...');
  log('Reading card...', 'action');
  const res = await window.pm3.read();
  setIdle();
  if (!res.ok) {
    setStatus('error', 'read failed');
    const msg = explainPm3Error(res.error);
    log('✗ ' + msg, 'error');
    toast(msg, 'error');
    return;
  }
  const { content, chunkIndex, totalChunks, payloadSize, blank } = res.data;
  updateCardInfo(res.data);
  updateRuntimeLabels(res.data);
  document.getElementById('editor').value = content;
  document.getElementById('chunk-index').value = chunkIndex;
  document.getElementById('chunk-total').value = totalChunks;
  updateByteCount(content);
  if (currentTab === 'hex') renderHex(content);

  if (blank) {
    setStatus('ok', 'blank card');
    log('✓ Card read OK, but no PM3C metadata found (blank card)', 'info');
    toast('Card is blank for PM3C. Write content to initialize it.', 'info');
    return;
  }

  setStatus('ok', 'read ok');
  log(`✓ Read ${payloadSize}B — chunk ${chunkIndex + 1}/${totalChunks}`, 'ok');
  toast(`Read ${payloadSize} bytes`, 'ok');
}

async function doWrite() {
  const content = document.getElementById('editor').value;
  if (!content.trim()) { toast('Nothing to write.', 'error'); return; }
  const n = byteLen(content);
  if (n > MAX_BYTES) {
    toast(`Too large: ${n}B. Use Split for multi-card.`, 'error');
    log(`✗ Content too large: ${n}B > ${MAX_BYTES}B`, 'error');
    return;
  }
  const chunkIndex = parseInt(document.getElementById('chunk-index').value) || 0;
  const chunkTotal = parseInt(document.getElementById('chunk-total').value) || 1;
  setBusy('Writing to card... This may take long depending on the card.');
  log(`Writing ${n}B (chunk ${chunkIndex + 1}/${chunkTotal})...`, 'action');
  const res = await window.pm3.write(content, chunkIndex, chunkTotal);
  setIdle();
  if (!res.ok) {
    setStatus('error', 'write failed');
    const msg = explainPm3Error(res.error);
    log('✗ ' + msg, 'error');
    toast(msg, 'error');
    return;
  }
  setStatus('ok', 'write ok');
  log(`✓ Wrote ${res.data.bytesWritten}B across ${res.data.blocksUsed} blocks`, 'ok');
  toast(`Wrote ${res.data.bytesWritten} bytes`, 'ok');
}

async function doWipe() {
  if (!confirm('Wipe PM3C metadata from card? (raw data blocks are not zeroed)')) return;
  setBusy('Wiping card...');
  log('Wiping card metadata...', 'action');
  const res = await window.pm3.wipe();
  setIdle();
  if (!res.ok) {
    setStatus('error', 'wipe failed');
    const msg = explainPm3Error(res.error);
    log('✗ ' + msg, 'error');
    toast(msg, 'error');
    return;
  }
  document.getElementById('info-status').textContent = 'empty';
  document.getElementById('info-chunk').textContent = '—';
  document.getElementById('storage-fill').style.width = '0%';
  document.getElementById('used-bytes').textContent = '0';
  document.getElementById('pct-text').textContent = '0%';
  document.getElementById('editor').value = '';
  document.getElementById('chunk-index').value = 0;
  document.getElementById('chunk-total').value = 1;
  updateByteCount('');
  if (currentTab === 'hex') renderHex('');
  setStatus('ok', 'wiped');
  log('✓ Card metadata wiped', 'ok');
  toast('Card wiped', 'ok');
}

async function doSplit() {
  const content = document.getElementById('editor').value;
  if (!content.trim()) { toast('Nothing to split.', 'error'); return; }
  const n = byteLen(content);
  if (n <= MAX_BYTES) {
    toast('Content fits in one card — no split needed.', 'info');
    return;
  }
  const res = await window.pm3.split(content);
  if (!res.ok) {
    toast(explainPm3Error(res.error), 'error');
    return;
  }
  const chunks = res.data;
  log(`Split into ${chunks.length} chunks of ~${MAX_BYTES}B each`, 'action');
  log('Load each chunk into the editor, set Card index, and write one card at a time.', 'info');
  // Load first chunk, set totals
  document.getElementById('editor').value = chunks[0];
  document.getElementById('chunk-index').value = 0;
  document.getElementById('chunk-total').value = chunks.length;
  updateByteCount(chunks[0]);
  toast(`Split into ${chunks.length} cards. Card 1 loaded.`, 'ok');
  // Store chunks for navigation
  window._chunks = chunks;
  window._chunkTotal = chunks.length;
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'r') { e.preventDefault(); doRead(); }
  if (ctrl && e.key === 's') { e.preventDefault(); doWrite(); }
  if (ctrl && e.key === 'd') { e.preventDefault(); doRead(); }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
// Module scripts are deferred — DOM is fully parsed before this runs.

const _btns = document.querySelectorAll('.btn');

updateByteCount('');
document.getElementById("appName").textContent = appName;
log(`${appName} ready.`, 'info');
updateRuntimeLabels(null);
log('Ctrl+D = Read · Ctrl+R = Read · Ctrl+S = Write', 'info');
bindUiActions();
syncEditorLineScroll();

let removeLogListener = null;
if (window.pm3 && typeof window.pm3.onLog === 'function') {
  removeLogListener = window.pm3.onLog((msg) => {
    if (typeof msg === 'string' && msg.trim()) {
      log(msg, 'info');
    }
  });
}

window.addEventListener('beforeunload', () => {
  if (typeof removeLogListener === 'function') {
    removeLogListener();
    removeLogListener = null;
  }
});

