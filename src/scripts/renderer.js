/* renderer.js — UI logic */

// ── App metadata ─────────────────────────────────────────────────────────────
import pkg from "../../package.json" with { type: "json" };
const appName = pkg.packageName;

const MAX_BYTES = 720;
let currentTab = 'editor';

// ── Scan state ────────────────────────────────────────────────────────────────
/** Whether a Slint component window is currently open. */
let _slintRunning = false;

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
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${now()}</span><span class="log-msg ${type}">${msg}</span>`;
  _logPanel.appendChild(entry);
  _logPanel.scrollTop = _logPanel.scrollHeight;
  // Keep last 120 lines
  while (_logPanel.children.length > 120) _logPanel.removeChild(_logPanel.firstChild);
}

function toast(msg, type = 'info', ms = 2800) {
  _toast.textContent = msg;
  _toast.className = `show ${type}`;
  clearTimeout(_toast._t);
  _toast._t = setTimeout(() => _toast.className = '', ms);
}

function setOverlay(visible, msg = 'Working...') {
  _overlayMsg.textContent = msg;
  _overlay.classList.toggle('visible', visible);
}

function setStatus(state, text) {
  if (_statusDot) _statusDot.className = `dot ${state}`;
  if (_statusText) _statusText.textContent = text;
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

// ─── Slint content detection ──────────────────────────────────────────────────

/**
 * Heuristically determine if a string looks like Slint source code.
 * Matches both `component Foo { }` and `export component Foo { }` at the
 * start of a line (ignoring leading whitespace), which is the standard form
 * for Slint top-level component declarations.
 *
 * @param {string} content
 * @returns {boolean}
 */
function looksLikeSlint(content) {
  if (!content || typeof content !== 'string') return false;
  return /^\s*(?:export\s+)?component\s+\w/m.test(content);
}

// ─── Slint overlay ────────────────────────────────────────────────────────────

/**
 * Show or hide the Slint component overlay panel.
 * @param {boolean} visible
 */
function setSlintOverlay(visible) {
  if (!_slintOverlay) return;
  _slintOverlay.classList.toggle('visible', visible);
  _slintOverlay.setAttribute('aria-hidden', String(!visible));
}

/**
 * Update the status message shown inside the Slint overlay.
 * @param {string} msg
 * @param {'running'|'error'|''} type
 */
function setSlintStatus(msg, type = '') {
  if (!_slintStatusMsg) return;
  _slintStatusMsg.textContent = msg;
  _slintStatusMsg.className = 'slint-status-msg' + (type ? ` ${type}` : '');
}

/**
 * Compile and display a Slint component from the given source code.
 * Shows the Slint overlay and delegates rendering to the main process.
 *
 * @param {string} code  Slint source read from the NFC card.
 */
async function launchSlintFromContent(code) {
  if (!window.slint) {
    log('✗ Slint runtime not available in this build.', 'error');
    return;
  }

  _slintRunning = true;
  setSlintOverlay(true);
  setSlintStatus('Compiling and launching Slint component…', '');

  const res = await window.slint.run(code);
  if (!res || !res.ok) {
    setSlintStatus('Failed to start Slint runner: ' + (res && res.error ? res.error : 'unknown error'), 'error');
    log('✗ Slint launch failed: ' + (res && res.error || 'unknown'), 'error');
    _slintRunning = false;
  }
  // Further status updates come via the slint:status event (see init section)
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
  _tabs.forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  _paneEditor.style.display = name === 'editor' ? 'flex' : 'none';
  _paneHex.style.display    = name === 'hex'    ? 'flex' : 'none';
  if (name === 'hex') renderHex(_editor.value);
}

// ─── Storage bar & byte counter ───────────────────────────────────────────────

function updateByteCount(str) {
  const n = byteLen(str);
  const pct = Math.min((n / MAX_BYTES) * 100, 100);
  _storageFill.style.width = pct + '%';
  _storageFill.classList.toggle('full', n >= MAX_BYTES);

  _byteCount.textContent = `${n} / ${MAX_BYTES} B`;
  _byteCount.className = 'byte-count' + (n > MAX_BYTES ? ' over' : n > MAX_BYTES * 0.8 ? ' warn' : '');

  _usedBytes.textContent = n;
  _totalBytes.textContent = MAX_BYTES;
  _pctText.textContent = Math.round(pct) + '%';

  updateLineNumbers(str);
}

function updateLineNumbers(str) {
  const total = Math.max(1, String(str).split('\n').length);
  const numbers = Array.from({ length: total }, (_, i) => String(i + 1)).join('\n');
  if (_editorLines.textContent !== numbers) {
    _editorLines.textContent = numbers;
  }
}

function syncEditorLineScroll() {
  _editorLines.style.transform = `translateY(${-_editor.scrollTop}px)`;
}

// ─── Hex renderer ─────────────────────────────────────────────────────────────

function renderHex(str) {
  if (!str) {
    _hexView.innerHTML = '<span class="hex-empty">No content — write something in the Editor tab.</span>';
    return;
  }
  const bytes = _enc.encode(str);
  let html = '';
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    const addr = i.toString(16).padStart(4, '0');
    let hexPart = '';
    let asciiPart = '';
    for (let j = 0; j < row.length; j++) {
      const b = row[j];
      if (j > 0) hexPart += ' ';
      hexPart += b.toString(16).padStart(2, '0');
      asciiPart += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '·';
    }
    hexPart = hexPart.padEnd(47, ' ');
    html += `<div class="hex-row">
      <span class="hex-addr">${addr}</span>
      <span class="hex-bytes">${hexPart}</span>
      <span class="hex-ascii">${asciiPart}</span>
    </div>`;
  }
  _hexView.innerHTML = html;
}

// ─── Card info panel ──────────────────────────────────────────────────────────

function updateCardInfo(data) {
  _infoPort.textContent   = data.port   || '—';
  _infoUid.textContent    = data.uid    || '—';
  _infoStatus.textContent = data.hasData ? 'has data' : 'empty';
  _infoStatus.className   = 'info-val ' + (data.hasData ? 'amber' : 'green');

  if (data.meta) {
    const ci = data.meta.chunkIndex;
    const ct = data.meta.totalChunks;
    _infoChunk.textContent = `${ci + 1} / ${ct}`;
  } else {
    _infoChunk.textContent = '—';
  }

  // Update storage bar from card data
  const used = data.usedBytes || 0;
  const pct  = Math.min((used / MAX_BYTES) * 100, 100);
  _storageFill.style.width = pct + '%';
  _storageFill.classList.toggle('full', used >= MAX_BYTES);
  _usedBytes.textContent = used;
  _pctText.textContent = Math.round(pct) + '%';
}

function runtimePlatformLabel() {
  const p = String(navigator.platform || '').toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac')) return 'macOS';
  if (p.includes('linux')) return 'Linux';
  return navigator.platform || 'Unknown OS';
}

function updateRuntimeLabels(data) {
  const cardType = data && data.cardType ? data.cardType : 'Waiting for card...';
  const device = data && data.deviceLabel ? data.deviceLabel : 'Proxmark3';
  const port = data && data.port ? data.port : 'no-port';
  const osLabel = runtimePlatformLabel();

  if (_cardTypeEl) _cardTypeEl.textContent = cardType;
  if (_envEl) {
    const lowerDevice = String(device).toLowerCase();
    const lowerPort = String(port).toLowerCase();
    const hasPortInDevice = lowerPort !== 'no-port' && lowerDevice.includes(lowerPort);

    const parts = [`${MAX_BYTES} B/card`, device];
    if (!hasPortInDevice && lowerPort !== 'no-port') parts.push(port);
    parts.push(osLabel);
    _envEl.textContent = parts.join(' · ');
  }
}

function bindUiActions() {
  const btnRead  = document.getElementById('btn-read');
  const btnWrite = document.getElementById('btn-write');
  const btnWipe  = document.getElementById('btn-wipe');
  const btnSplit = document.getElementById('btn-split');
  const btnSlintClose = document.getElementById('btn-slint-close');
  const tabEditor = document.getElementById('tab-editor');
  const tabHex    = document.getElementById('tab-hex');

  if (btnRead)  btnRead.addEventListener('click', doRead);
  if (btnWrite) btnWrite.addEventListener('click', doWrite);
  if (btnWipe)  btnWipe.addEventListener('click', doWipe);
  if (btnSplit) btnSplit.addEventListener('click', doSplit);

  // Close the Slint window
  if (btnSlintClose) btnSlintClose.addEventListener('click', async () => {
    if (window.slint) await window.slint.close();
    setSlintOverlay(false);
    setSlintStatus('');
    _slintRunning = false;
    log('[slint] Component closed.', 'info');
  });

  if (tabEditor) tabEditor.addEventListener('click', () => setTab('editor', tabEditor));
  if (tabHex)    tabHex.addEventListener('click',    () => setTab('hex',    tabHex));
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
  _editor.value = content;
  _chunkIndex.value = chunkIndex;
  _chunkTotal.value = totalChunks;
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

  // Check for Slint code and execute it
  if (looksLikeSlint(content)) {
    log('[slint] Slint code detected on card — launching component…', 'action');
    await launchSlintFromContent(content);
  }
}

async function doWrite() {
  const content = _editor.value;
  if (!content.trim()) { toast('Nothing to write.', 'error'); return; }
  const n = byteLen(content);
  if (n > MAX_BYTES) {
    toast(`Too large: ${n}B. Use Split for multi-card.`, 'error');
    log(`✗ Content too large: ${n}B > ${MAX_BYTES}B`, 'error');
    return;
  }
  const chunkIndex = parseInt(_chunkIndex.value) || 0;
  const chunkTotal = parseInt(_chunkTotal.value) || 1;
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
  _infoStatus.textContent = 'empty';
  _infoChunk.textContent = '—';
  _storageFill.style.width = '0%';
  _usedBytes.textContent = '0';
  _pctText.textContent = '0%';
  _editor.value = '';
  _chunkIndex.value = 0;
  _chunkTotal.value = 1;
  updateByteCount('');
  if (currentTab === 'hex') renderHex('');
  setStatus('ok', 'wiped');
  log('✓ Card metadata wiped', 'ok');
  toast('Card wiped', 'ok');
}

async function doSplit() {
  const content = _editor.value;
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
  _editor.value = chunks[0];
  _chunkIndex.value = 0;
  _chunkTotal.value = chunks.length;
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

const _logPanel    = document.getElementById('log-panel');
const _toast       = document.getElementById('toast');
const _overlay     = document.getElementById('overlay');
const _overlayMsg  = document.getElementById('overlay-msg');
const _statusDot   = document.getElementById('status-dot');
const _statusText  = document.getElementById('status-text');
const _storageFill = document.getElementById('storage-fill');
const _byteCount   = document.getElementById('byte-count');
const _usedBytes   = document.getElementById('used-bytes');
const _totalBytes  = document.getElementById('total-bytes');
const _pctText     = document.getElementById('pct-text');
const _editorLines = document.getElementById('editor-lines');
const _editor      = document.getElementById('editor');
const _hexView     = document.getElementById('hex-view');
const _paneEditor  = document.getElementById('pane-editor');
const _paneHex     = document.getElementById('pane-hex');
const _infoPort    = document.getElementById('info-port');
const _infoUid     = document.getElementById('info-uid');
const _infoStatus  = document.getElementById('info-status');
const _infoChunk   = document.getElementById('info-chunk');
const _chunkIndex  = document.getElementById('chunk-index');
const _chunkTotal  = document.getElementById('chunk-total');
const _cardTypeEl  = document.getElementById('runtime-card-type');
const _envEl       = document.getElementById('runtime-env-label');
const _appName     = document.getElementById('appName');
const _tabs        = document.querySelectorAll('.tab');
const _btns        = document.querySelectorAll('.btn');

// Slint overlay elements
const _slintOverlay   = document.getElementById('slint-overlay');
const _slintStatusMsg = document.getElementById('slint-status-msg');

_editor.addEventListener('input', e => {
  updateByteCount(e.target.value);
  if (currentTab === 'hex') renderHex(e.target.value);
});

_editor.addEventListener('scroll', () => {
  syncEditorLineScroll();
});

updateByteCount('');
_appName.textContent = appName;
log(`${appName} ready.`, 'info');
updateRuntimeLabels(null);
log('Ctrl+D = Read · Ctrl+R = Read · Ctrl+S = Write', 'info');
bindUiActions();
syncEditorLineScroll();

// ── Subscribe to events ───────────────────────────────────────────────────────
const cleanupFns = [];

if (window.pm3) {
  if (typeof window.pm3.onLog === 'function') {
    cleanupFns.push(window.pm3.onLog((msg) => {
      if (typeof msg === 'string' && msg.trim()) log(msg, 'info');
    }));
  }
}

// ── Subscribe to Slint status events ─────────────────────────────────────────
if (window.slint && typeof window.slint.onStatus === 'function') {
  cleanupFns.push(window.slint.onStatus((status) => {
    if (status.state === 'running') {
      setSlintStatus('Slint component is running in a separate window.\nClose that window or click the button below to dismiss this panel.', 'running');
    } else if (status.state === 'error') {
      setSlintStatus('Error: ' + (status.message || 'unknown Slint error'), 'error');
      log('✗ [slint] ' + (status.message || 'unknown error'), 'error');
      toast('Slint error — see overlay for details.', 'error');
      _slintRunning = false;
    } else if (status.state === 'closed') {
      setSlintOverlay(false);
      setSlintStatus('');
      _slintRunning = false;
      log('[slint] Component window closed.', 'info');
    }
  }));
}

window.addEventListener('beforeunload', () => {
  cleanupFns.forEach(fn => { if (typeof fn === 'function') fn(); });
});
