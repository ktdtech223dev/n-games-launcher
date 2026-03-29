const { contextBridge, ipcRenderer } = require('electron');

// Register IPC listeners once only
let _launchFn          = null;
let _closeFn           = null;
let _progressFn        = null;
let _launcherProgressFn = null;
ipcRenderer.on('game:launched',            (_, id)      => { if (_launchFn)           _launchFn(id); });
ipcRenderer.on('game:closed',              (_, id)      => { if (_closeFn)            _closeFn(id); });
ipcRenderer.on('game:download-progress',   (_, payload) => { if (_progressFn)         _progressFn(payload); });
ipcRenderer.on('launcher:update-progress', (_, pct)     => { if (_launcherProgressFn) _launcherProgressFn(pct); });

contextBridge.exposeInMainWorld('electron', {
  minimize:        () => ipcRenderer.invoke('window:minimize'),
  maximize:        () => ipcRenderer.invoke('window:maximize'),
  close:           () => ipcRenderer.invoke('window:close'),
  storeGet:        (key)      => ipcRenderer.invoke('store:get', key),
  storeSet:        (key, val) => ipcRenderer.invoke('store:set', key, val),
  openExternal:    (url)      => ipcRenderer.invoke('shell:open', url),
  // Game management
  installInfo:     (game_id)  => ipcRenderer.invoke('game:install-info', game_id),
  checkUpdate:     (opts)     => ipcRenderer.invoke('game:check-update', opts),
  installGame:     (opts)     => ipcRenderer.invoke('game:install', opts),
  browseGame:      (game_id)  => ipcRenderer.invoke('game:browse', game_id),
  launchGame:      (game)     => ipcRenderer.invoke('game:launch', game),
  isGameRunning:   (game_id)  => ipcRenderer.invoke('game:is-running', game_id),
  // Events
  onGameLaunched:          (fn) => { _launchFn           = fn; },
  onGameClosed:            (fn) => { _closeFn            = fn; },
  onDownloadProgress:      (fn) => { _progressFn         = fn; },
  // Launcher self-update
  checkLauncherUpdate: (opts) => ipcRenderer.invoke('launcher:check-update', opts),
  doLauncherUpdate:    (opts) => ipcRenderer.invoke('launcher:do-update', opts),
  onLauncherProgress:  (fn)  => { _launcherProgressFn = fn; },
});
