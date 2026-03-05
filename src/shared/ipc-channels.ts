export const IPC = {
  // Renderer -> Main (invoke/handle)
  TERMINAL_SPAWN: 'terminal:spawn',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  DOCK_GET_INFO: 'dock:getInfo',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  APP_NEW_DOCK: 'app:newDock',
  APP_PICK_DIRECTORY: 'app:pickDirectory',
  APP_GET_RECENT_PATHS: 'app:getRecentPaths',
  APP_REMOVE_RECENT_PATH: 'app:removeRecentPath',
  APP_OPEN_DOCK_PATH: 'app:openDockPath',
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE: 'win:close',
  APP_OPEN_EXTERNAL: 'app:openExternal',
  UPDATER_CHECK: 'updater:check',
  UPDATER_DOWNLOAD: 'updater:download',
  UPDATER_INSTALL: 'updater:install',
  DEBUG_WRITE: 'debug:write',
  DEBUG_OPEN_DEVTOOLS: 'debug:openDevTools',

  // Main -> Renderer (send)
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  SETTINGS_CHANGED: 'settings:changed',
  UPDATER_PROGRESS: 'updater:progress'
} as const
