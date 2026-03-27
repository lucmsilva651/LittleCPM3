const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const pm3 = require('../utils/pm3.js');

let win;
const winWidth = 950;
const winHeight = 650;

// ─── Slint child-process management ──────────────────────────────────────────

/** Currently running Slint child process, or null. */
let slintProc = null;

/**
 * Spawn a new slint-runner child process that will compile and display
 * a Slint component from `code`.  Messages are exchanged over stdin/stdout
 * as newline-delimited JSON.
 *
 * @param {string} code  Slint source code read from the NFC card.
 */
function launchSlintComponent(code) {
  // Kill any previously running Slint window first
  closeSlintComponent();

  const runnerPath = path.join(__dirname, 'slint-runner.js');
  slintProc = spawn(process.execPath, [runnerPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  slintProc.stdout.setEncoding('utf8');
  let buf = '';
  slintProc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }

      if (msg.type === 'ready') {
        // Runner is up — send the code to compile and run
        slintProc.stdin.write(JSON.stringify({ type: 'run', code }) + '\n');
        if (win && !win.isDestroyed()) {
          win.webContents.send('slint:status', { state: 'running' });
        }
      } else if (msg.type === 'error') {
        if (win && !win.isDestroyed()) {
          win.webContents.send('slint:status', { state: 'error', message: msg.message });
        }
      } else if (msg.type === 'closed') {
        if (win && !win.isDestroyed()) {
          win.webContents.send('slint:status', { state: 'closed' });
        }
        slintProc = null;
      }
    }
  });

  slintProc.stderr.on('data', (chunk) => {
    const msg = chunk.toString('utf8').trim();
    if (msg && win && !win.isDestroyed()) {
      win.webContents.send('slint:status', { state: 'error', message: msg });
    }
  });

  slintProc.on('close', () => {
    slintProc = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('slint:status', { state: 'closed' });
    }
  });
}

/**
 * Send a close message to the running Slint child process (if any).
 */
function closeSlintComponent() {
  if (!slintProc) return;
  try {
    slintProc.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
  } catch (_) {}
  // Force-kill after a short grace period
  const proc = slintProc;
  setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }, 2000);
  slintProc = null;
}

// ─── Scan helpers (shared between lifecycle hooks and IPC) ────────────────────

/**
 * Start the continuous NFC scan loop and notify the renderer.
 * Safe to call even if a scan is already running (restarts cleanly).
 */
function activateScan() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('scan:status', { scanning: true });
  }
  pm3.startContinuousScan(
    (result) => {
      if (win && !win.isDestroyed()) win.webContents.send('scan:result', { ok: true, data: result });
    },
    (err) => {
      if (win && !win.isDestroyed()) win.webContents.send('scan:result', {
        ok: false,
        error: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : undefined
      });
    }
  );
}

/**
 * Stop the continuous NFC scan loop and notify the renderer.
 */
function deactivateScan() {
  pm3.stopContinuousScan();
  if (win && !win.isDestroyed()) {
    win.webContents.send('scan:status', { scanning: false });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: winWidth,
    minHeight: winHeight,
    backgroundColor: '#111111',
    titleBarStyle: "hidden",
    titleBarOverlay: {
      symbolColor: "#ffffff",
      color: "#111111",
      height: (48 - 1)
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools();
  }

  pm3.setLogger((msg) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('pm3:log', msg);
  });

  // ── Continuous scan lifecycle ────────────────────────────────────────────
  // Start scanning when the window gains focus; pause when it loses focus
  // to preserve battery and release serial-port resources.

  win.on('focus', activateScan);
  win.on('blur',  deactivateScan);

  // Auto-start scan once the page is loaded
  win.webContents.on('did-finish-load', activateScan);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  pm3.stopContinuousScan();
  closeSlintComponent();
  app.quit();
});

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function wrap(fn) {
  return async (...args) => {
    // Pause the auto-scan loop and wait for any in-flight scan tick to
    // finish before the manual operation touches the serial port.
    // This prevents "serial port is claimed by another process" errors.
    await pm3.beginManualOp();
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      const payload = {
        ok: false,
        error: e && e.message ? e.message : String(e)
      };

      if (typeof e?.code !== 'undefined') payload.code = e.code;
      if (process.argv.includes('--dev') && e?.stack) payload.stack = e.stack;
      return payload;
    } finally {
      pm3.endManualOp();
    }
  };
}

ipcMain.handle('pm3:read',   wrap(() => pm3.readCard()));
ipcMain.handle('pm3:wipe',   wrap(() => pm3.wipeCard()));
ipcMain.handle('pm3:split',  wrap((_, content) => pm3.splitIntoChunks(content)));
ipcMain.handle('pm3:write',  wrap((_, content, idx = 0, total = 1) =>
  pm3.writeCard(content, idx, total)
));

// Manual scan control from renderer
ipcMain.handle('pm3:startScan', () => {
  activateScan();
  return { ok: true };
});

ipcMain.handle('pm3:stopScan', () => {
  deactivateScan();
  return { ok: true };
});

// Slint component control
ipcMain.handle('slint:run', (_, code) => {
  launchSlintComponent(code);
  return { ok: true };
});

ipcMain.handle('slint:close', () => {
  closeSlintComponent();
  return { ok: true };
});
