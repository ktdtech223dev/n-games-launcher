/**
 * N Games Launcher — main.js
 * Electron main process
 */

'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path         = require('path');
const fs           = require('fs');
const https        = require('https');
const os           = require('os');
const { spawn }    = require('child_process');

// ── Persistent store ──────────────────────────────────────────────────────────
let Store;
try { Store = require('electron-store'); } catch (e) { Store = null; }
const store = Store ? new Store() : { get: () => null, set: () => {} };

// ── Game install directory ────────────────────────────────────────────────────
const GAMES_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'NGames', 'games'
);
if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

// ── Window refs ───────────────────────────────────────────────────────────────
let mainWindow;
const gameProcesses = new Map(); // game_id → child process

// ── Create launcher window ────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1100, minHeight: 680,
    frame: false, transparent: false, backgroundColor: '#111111',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

// Paths for a game's exe and version sidecar
function gameExePath(game_id)      { return path.join(GAMES_DIR, `${game_id}.exe`); }
function gameVersionPath(game_id)  { return path.join(GAMES_DIR, `${game_id}.version.json`); }

function readInstalledVersion(game_id) {
  try {
    const data = JSON.parse(fs.readFileSync(gameVersionPath(game_id), 'utf8'));
    return data.version || null;
  } catch(e) { return null; }
}

function writeInstalledVersion(game_id, version) {
  fs.writeFileSync(gameVersionPath(game_id), JSON.stringify({ version, installed_at: Date.now() }));
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NGames-Launcher' } }, res => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) return follow(res.headers.location);
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject).setTimeout(10000, function() { this.destroy(); });
    };
    follow(url);
  });
}

function httpsDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'NGames-Launcher' } }, res => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const tmp = destPath + '.downloading';
        const out = fs.createWriteStream(tmp);

        res.on('data', chunk => {
          downloaded += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.round((downloaded / total) * 100));
          }
        });
        res.pipe(out);
        out.on('finish', () => { fs.renameSync(tmp, destPath); resolve(); });
        out.on('error', e => { try { fs.unlinkSync(tmp); } catch(_) {} reject(e); });
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
ipcMain.handle('window:close',    () => mainWindow.close());

// ── IPC: store ────────────────────────────────────────────────────────────────
ipcMain.handle('store:get', (_, key)      => store.get(key));
ipcMain.handle('store:set', (_, key, val) => store.set(key, val));

// ── IPC: shell ────────────────────────────────────────────────────────────────
ipcMain.handle('shell:open', (_, url) => shell.openExternal(url));

// ── IPC: install info ─────────────────────────────────────────────────────────
ipcMain.handle('game:install-info', (_, game_id) => {
  const exePath   = gameExePath(game_id);
  const installed = fs.existsSync(exePath);
  return {
    installed,
    file_path:         installed ? exePath : null,
    installed_version: installed ? readInstalledVersion(game_id) : null,
    installed_at:      installed ? fs.statSync(exePath).mtimeMs : null,
  };
});

// ── IPC: check GitHub for latest release ─────────────────────────────────────
ipcMain.handle('game:check-update', async (_, { releases_url }) => {
  if (!releases_url) return null;
  try {
    const { body, status } = await httpsGet(releases_url);
    if (status !== 200) return null;
    const data = JSON.parse(body);
    const remote_version = (data.tag_name || '').replace(/^v/, '');
    // Look for .exe asset
    const asset = (data.assets || []).find(a => a.name.endsWith('.exe'));
    return {
      remote_version,
      notes:      data.body   || '',
      asset_url:  asset?.browser_download_url || null,
      asset_name: asset?.name || null,
    };
  } catch(e) { return null; }
});

// ── IPC: install / update (download portable .exe from GitHub release) ────────
ipcMain.handle('game:install', async (event, { game_id, asset_url, remote_version }) => {
  const dest = gameExePath(game_id);
  try {
    await httpsDownload(asset_url, dest, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game:download-progress', { game_id, pct });
      }
    });
    const version = remote_version || 'unknown';
    writeInstalledVersion(game_id, version);
    return { ok: true, file_path: dest, installed_version: version };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});



// ── IPC: browse for existing install ─────────────────────────────────────────
ipcMain.handle('game:browse', async (_, game_id) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Locate ${game_id} executable`,
    defaultPath: GAMES_DIR,
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const src  = result.filePaths[0];
  const dest = gameExePath(game_id);
  if (src !== dest) fs.copyFileSync(src, dest);
  // Version unknown for manually browsed installs
  return { file_path: dest, installed_version: readInstalledVersion(game_id) };
});

// ── IPC: launch game exe ──────────────────────────────────────────────────────
ipcMain.handle('game:launch', (_, game) => {
  // If already running, just notify
  if (gameProcesses.has(game.id)) {
    const proc = gameProcesses.get(game.id);
    if (proc && !proc.killed) return { ok: true, already_open: true };
  }

  const exePath = gameExePath(game.id);
  if (!fs.existsSync(exePath)) return { ok: false, error: 'not_installed' };

  try {
    const proc = spawn(exePath, [], {
      detached: true,   // game runs independently of launcher
      stdio:    'ignore',
    });
    proc.unref(); // don't keep launcher alive for the game's sake

    proc.on('error', (err) => {
      gameProcesses.delete(game.id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game:closed', game.id);
      }
    });

    proc.on('exit', () => {
      gameProcesses.delete(game.id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game:closed', game.id);
      }
    });

    gameProcesses.set(game.id, proc);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game:launched', game.id);
    }

    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: check if a game exe is running externally (launched outside launcher) ─
const { execFile } = require('child_process');

function isExeRunning(exeName) {
  return new Promise(resolve => {
    // Windows: use tasklist to check by filename
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH', '/FO', 'CSV'], (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.toLowerCase().includes(exeName.toLowerCase()));
    });
  });
}

ipcMain.handle('game:is-running', async (_, game_id) => {
  // First check our own process map
  if (gameProcesses.has(game_id)) {
    const proc = gameProcesses.get(game_id);
    if (proc && !proc.killed) return { running: true };
  }
  // Then check OS process list (catches externally launched instances)
  try {
    const running = await isExeRunning(`${game_id}.exe`);
    return { running };
  } catch(e) {
    return { running: false };
  }
});

// ── IPC: check for launcher update ───────────────────────────────────────────
ipcMain.handle('launcher:check-update', async (_, { releases_url }) => {
  try {
    console.log('[Update] Checking:', releases_url);
    const { body, status } = await httpsGet(releases_url);
    console.log('[Update] HTTP status:', status);
    if (status !== 200) return { error: `HTTP ${status}`, remote_version: null, asset_url: null };
    const data = JSON.parse(body);
    console.log('[Update] Tag:', data.tag_name, 'Assets:', (data.assets||[]).map(a=>a.name));
    const remote_version = (data.tag_name || '').replace(/^v/, '');
    // Find any .exe asset
    const asset = (data.assets || []).find(a => a.name.endsWith('.exe'));
    console.log('[Update] Asset found:', asset?.name || 'none');
    return {
      remote_version,
      notes:      data.body || '',
      asset_url:  asset?.browser_download_url || null,
      asset_name: asset?.name || null,
      error:      null,
    };
  } catch(e) {
    console.error('[Update] Error:', e.message);
    return { error: e.message, remote_version: null, asset_url: null };
  }
});

// ── IPC: download launcher installer and open it ──────────────────────────────
ipcMain.handle('launcher:do-update', async (_, { asset_url }) => {
  const dest = path.join(os.tmpdir(), 'NGamesSetup.exe');
  try {
    await httpsDownload(asset_url, dest, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launcher:update-progress', pct);
      }
    });

    // VBScript launches installer silently after we quit — no CMD windows
    const vbsPath = path.join(os.tmpdir(), 'ngames_update.vbs');
    const escapedDest = dest.split('\\').join('\\\\');
    const vbs = [
      'Dim pid',
      'pid = ' + process.pid,
      'Do While IsProcessRunning(pid)',
      '  WScript.Sleep 500',
      'Loop',
      'Dim sh',
      'Set sh = CreateObject("WScript.Shell")',
      'sh.Run Chr(34) & "' + escapedDest + '" & Chr(34), 1, False',
      '',
      'Function IsProcessRunning(id)',
      '  Dim oWMI, oProcs',
      '  Set oWMI = GetObject("winmgmts:")',
      '  Set oProcs = oWMI.ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId=" & id)',
      '  IsProcessRunning = (oProcs.Count > 0)',
      'End Function',
    ].join('\r\n');

    fs.writeFileSync(vbsPath, vbs);

    const { spawn: sp } = require('child_process');
    sp('wscript.exe', [vbsPath], {
      detached:    true,
      stdio:       'ignore',
      windowsHide: true,
    }).unref();

    setTimeout(() => app.quit(), 600);
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

