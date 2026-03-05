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
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE: 'win:close',

  // Main -> Renderer (send)
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  SETTINGS_CHANGED: 'settings:changed'
} as const
