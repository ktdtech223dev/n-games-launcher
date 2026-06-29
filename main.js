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
let activeProfileId = null;      // current crew profile, passed to launched games via env

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

// Paths for a game's files
function gameExePath(game_id)      { return path.join(GAMES_DIR, `${game_id}.exe`); }
function gameDir(game_id)          { return path.join(GAMES_DIR, game_id); }
function gameVersionPath(game_id)  { return path.join(GAMES_DIR, `${game_id}.version.json`); }

// Resolve the actual EXE to launch — folder-extracted games store the path in version file
function gameExePathResolved(game_id) {
  try {
    const data = JSON.parse(fs.readFileSync(gameVersionPath(game_id), 'utf8'));
    if (data.exe_path && fs.existsSync(data.exe_path)) return data.exe_path;
  } catch {}
  return gameExePath(game_id); // fallback: portable single-exe style
}

// Extract a ZIP to destDir using PowerShell's built-in Expand-Archive (Windows 10+)
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const { spawn: sp } = require('child_process');
    // Remove dest first so we get a clean extract
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    const ps = sp('powershell.exe', [
      '-NonInteractive', '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { stdio: 'pipe' });
    ps.on('close', code => code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`)));
    ps.on('error', reject);
  });
}

// Find the main game EXE inside an extracted folder (biggest .exe = the app, not helper stubs)
function findMainExe(dir, game_id) {
  const allExes = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.exe')) allExes.push(full);
    }
  }
  walk(dir);
  if (!allExes.length) return null;
  // Prefer EXE whose name matches the game id (loose), then fall back to largest file
  const nameLower = game_id.replace(/-/g, '').toLowerCase();
  const byName = allExes.find(p => path.basename(p, '.exe').toLowerCase().replace(/[-_\s]/g, '') === nameLower);
  if (byName) return byName;
  return allExes.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

function readInstalledVersion(game_id) {
  try {
    const data = JSON.parse(fs.readFileSync(gameVersionPath(game_id), 'utf8'));
    return data.version || null;
  } catch(e) { return null; }
}

function writeInstalledVersion(game_id, version, exe_path = null) {
  fs.writeFileSync(gameVersionPath(game_id), JSON.stringify({ version, exe_path, installed_at: Date.now() }));
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
    // Track whether we've already resolved/rejected to prevent double-calls
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    const follow = (u, redirects = 0) => {
      if (redirects > 10) return done(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'NGames-Launcher' } }, res => {
        // Follow ALL redirect codes including 303 (GitHub uses this for release assets)
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // consume the redirect body so the socket can be reused
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return done(new Error(`HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const tmp = destPath + '.downloading';

        // Remove any leftover temp file from a previous failed attempt
        try { fs.unlinkSync(tmp); } catch (_) {}

        const out = fs.createWriteStream(tmp);

        res.on('data', chunk => {
          downloaded += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.round((downloaded / total) * 100));
          }
        });

        res.pipe(out);

        out.on('finish', () => {
          // Verify the file was actually written before renaming
          if (!fs.existsSync(tmp)) {
            return done(new Error('Download incomplete: temp file missing after write'));
          }
          try {
            // Remove stale destination if it exists, then rename
            try { fs.unlinkSync(destPath); } catch (_) {}
            fs.renameSync(tmp, destPath);
            done();
          } catch (renameErr) {
            // Fallback: copy then delete (handles cross-device or locked-file edge cases)
            try {
              fs.copyFileSync(tmp, destPath);
              try { fs.unlinkSync(tmp); } catch (_) {}
              done();
            } catch (copyErr) {
              done(new Error(`Failed to save download: ${renameErr.message}`));
            }
          }
        });

        out.on('error', e => {
          try { fs.unlinkSync(tmp); } catch (_) {}
          done(e);
        });

        res.on('error', e => {
          try { fs.unlinkSync(tmp); } catch (_) {}
          done(e);
        });

      }).on('error', done);
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
  const exePath   = gameExePathResolved(game_id);
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
    // Pick the Windows desktop build. Releases can also carry Android (.apk),
    // Linux (.AppImage), macOS (.dmg) and Kodi addon zips (plugin.*/repository.*) —
    // none of those are installable by this launcher, so ignore them. A real
    // Windows .exe wins; a non-addon .zip is only a fallback for zip-packaged apps.
    const isWindowsAsset = (a) => {
      const n = (a.name || '').toLowerCase();
      if (/\.(apk|appimage|dmg|deb|rpm|tar\.gz)$/.test(n)) return false;          // other platforms
      if (n.endsWith('.zip') && /^(plugin|repository)[.\-]/i.test(a.name)) return false; // Kodi addon zips
      return n.endsWith('.exe') || n.endsWith('.zip');
    };
    const assets   = (data.assets || []).filter(isWindowsAsset);
    const exeAsset = assets.find(a => a.name.toLowerCase().endsWith('.exe'));
    const zipAsset = assets.find(a => a.name.toLowerCase().endsWith('.zip'));
    const asset    = exeAsset || zipAsset;
    return {
      remote_version,
      notes:      data.body   || '',
      asset_url:  asset?.browser_download_url || null,
      asset_name: asset?.name || null,
    };
  } catch(e) { return null; }
});

// ── IPC: install / update ─────────────────────────────────────────────────────
// Handles both portable single .exe and full ZIP packages (Electron apps etc.)
ipcMain.handle('game:install', async (event, { game_id, asset_url, remote_version }) => {
  const isZip = asset_url && asset_url.toLowerCase().endsWith('.zip');
  const tmpDest = isZip
    ? path.join(os.tmpdir(), `${game_id}.zip`)
    : gameExePath(game_id);

  try {
    await httpsDownload(asset_url, tmpDest, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('game:download-progress', { game_id, pct });
      }
    });

    let exePath;
    if (isZip) {
      const dest = gameDir(game_id);
      await extractZip(tmpDest, dest);
      fs.unlinkSync(tmpDest); // clean up zip
      exePath = findMainExe(dest, game_id);
      if (!exePath) throw new Error('No executable found in ZIP');
    } else {
      exePath = tmpDest;
    }

    const version = remote_version || 'unknown';
    writeInstalledVersion(game_id, version, isZip ? exePath : null);
    return { ok: true, file_path: exePath, installed_version: version };
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

// ── IPC: remember the active crew profile (passed to launched games via env) ──
ipcMain.handle('set-active-profile', (_, id) => { activeProfileId = id || null; return { ok: true }; });

// ── IPC: launch game exe ──────────────────────────────────────────────────────
ipcMain.handle('game:launch', (_, game) => {
  // If already running, just notify
  if (gameProcesses.has(game.id)) {
    const proc = gameProcesses.get(game.id);
    if (proc && !proc.killed) return { ok: true, already_open: true };
  }

  const exePath = gameExePathResolved(game.id);
  if (!fs.existsSync(exePath)) return { ok: false, error: 'not_installed' };

  try {
    const proc = spawn(exePath, [], {
      detached: true,   // game runs independently of launcher
      stdio:    'ignore',
      cwd:      path.dirname(exePath), // launch from game's own directory
      // Hand the active crew identity + game id to SDK-aware games so they can
      // attribute presence/achievements without their own login.
      env: { ...process.env, NGAMES_PROFILE: activeProfileId || '', NGAMES_GAME_ID: game.id },
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

