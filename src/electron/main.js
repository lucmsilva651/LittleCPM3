const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const pm3 = require('../utils/pm3.js');

let win;
const winWidth = 950;
const winHeight = 650;

function createWindow() {
  const titleBarOverlay = {
  };

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
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function wrap(fn) {
  return async (...args) => {
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
    }
  };
}

ipcMain.handle('pm3:read',   wrap(() => pm3.readCard()));
ipcMain.handle('pm3:wipe',   wrap(() => pm3.wipeCard()));
ipcMain.handle('pm3:split',  wrap((_, content) => pm3.splitIntoChunks(content)));
ipcMain.handle('pm3:write',  wrap((_, content, idx = 0, total = 1) =>
  pm3.writeCard(content, idx, total)
));
