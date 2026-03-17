# Plugin Development Guide

Claude Dock supports external plugins that can add toolbar buttons, open windows, handle IPC, listen to lifecycle events, and expose settings. This guide covers everything you need to build one.

## Quick Start

Create a directory in the plugins folder with three files:

| Platform | Plugins directory |
|----------|------------------|
| Windows  | `%APPDATA%/claude-dock/plugins/` |
| macOS    | `~/Library/Application Support/claude-dock/plugins/` |
| Linux    | `~/.config/claude-dock/plugins/` |

```
plugins/my-plugin/
  plugin.json      # Manifest (required)
  main.js          # Main-process code (CommonJS)
  index.html       # Window UI (if using a window)
```

Restart Claude Dock. A consent dialog will appear the first time a new plugin is detected. After approval, the plugin loads automatically on every launch.

## Manifest (`plugin.json`)

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "defaultEnabled": true,
  "main": "./main.js",

  "toolbar": {
    "title": "My Plugin",
    "icon": "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/></svg>",
    "action": "my-plugin:open",
    "order": 90
  },

  "window": {
    "entry": "./index.html",
    "width": 800,
    "height": 600,
    "minWidth": 400,
    "minHeight": 300
  },

  "settingsSchema": [
    {
      "key": "myOption",
      "label": "Enable feature X",
      "type": "boolean",
      "defaultValue": true
    }
  ]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (e.g. `my-plugin`). Must not conflict with other plugins. |
| `name` | string | Display name shown in settings and consent dialog. |
| `version` | string | Semantic version (e.g. `1.0.0`). |
| `description` | string | Short description shown in consent dialog. |
| `defaultEnabled` | boolean | Whether the plugin is enabled by default for new projects. |
| `main` | string | Relative path to the main-process CommonJS module. |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `toolbar` | object | Adds a button to the dock toolbar. See [Toolbar](#toolbar). |
| `window` | object | Enables a plugin window. See [Windows](#windows). |
| `settingsSchema` | array | Per-project settings shown in the settings UI. See [Settings](#settings). |
| `updateUrl` | string | URL to a JSON manifest for plugin auto-updates. |
| `buildSha` | string | Git SHA for version tracking. |

## Main Module (`main.js`)

Your main module must export an `activate` function. It receives a [context](#context-api) object with logging, IPC, window management, and event bus access.

```js
function activate(context) {
  context.log('Plugin activated!')

  // Register IPC handler for the toolbar action
  context.ipc.handle('my-plugin:open', async (projectDir) => {
    await context.openPluginWindow(projectDir)
  })

  // Listen to lifecycle events
  context.bus.on('project:postOpen', 'my-plugin', ({ projectDir }) => {
    context.log(`Project opened: ${projectDir}`)
  })
}

function deactivate() {
  // Called when plugin is disabled or app quits.
  // Clean up timers, close connections, etc.
}

module.exports = { activate, deactivate }
```

### Auto-Wiring (No Code Required)

If your manifest has both `toolbar` and `window` fields but your module does **not** export `activate`, the plugin system auto-wires them: clicking the toolbar button opens the window. No `main.js` code needed for this simple case.

## Context API

The `context` object passed to `activate(context)` provides:

### Logging

```js
context.log('informational message')
context.logError('something went wrong', error)
```

All messages are prefixed with `[my-plugin]` in the app logs.

### IPC Handlers

Register handlers that the renderer (your plugin window or the dock) can call via `window.dockApi.plugins.invoke(channel, ...args)`.

```js
context.ipc.handle('my-plugin:getData', async (projectDir, options) => {
  // Return data to the renderer
  return { items: ['a', 'b', 'c'] }
})

context.ipc.removeHandler('my-plugin:getData')
```

**Reserved channel prefixes** (cannot be registered):
`terminal:`, `dock:`, `settings:`, `app:`, `win:`, `updater:`, `git:`, `claude:`, `linked:`, `plugin:`, `debug:`

### Window Management

```js
await context.openPluginWindow(projectDir)  // Opens one window per project
context.closePluginWindow(projectDir)
```

Windows auto-close when the project closes or the plugin is disabled.

### Shell & Dialog

```js
await context.shell.openExternal('https://example.com')  // HTTP(S) only
await context.shell.openPath('/path/to/directory')
const result = await context.dialog.showMessageBox({ message: 'Hello' })
```

### Plugin Directory

```js
const assetPath = require('path').join(context.pluginDir, 'assets', 'data.json')
```

## Event Bus

Listen to app lifecycle events via `context.bus.on(event, pluginId, handler)`.

| Event | Data | Description |
|-------|------|-------------|
| `project:preOpen` | `{ projectDir, dock }` | Before a project window opens. Handler is awaited (can block). |
| `project:postOpen` | `{ projectDir, dock }` | After a project window opens. Fire-and-forget. |
| `project:preClose` | `{ projectDir }` | Before a project window closes. Handler is awaited. |
| `project:postClose` | `{ projectDir }` | After a project window closes. Fire-and-forget. |
| `terminal:preSpawn` | `{ projectDir, terminalId }` | Before a terminal spawns. |
| `terminal:postSpawn` | `{ projectDir, terminalId, sessionId }` | After a terminal spawns. |
| `terminal:preKill` | `{ projectDir, terminalId }` | Before a terminal is killed. |
| `terminal:postKill` | `{ projectDir, terminalId }` | After a terminal is killed. |
| `settings:changed` | `{ settings }` | When global settings change. |
| `plugin:enabled` | `{ projectDir, pluginId }` | When a plugin is enabled for a project. |
| `plugin:disabled` | `{ projectDir, pluginId }` | When a plugin is disabled for a project. |

**`pre` events** are awaited sequentially and can block the operation.
**`post` events** are fire-and-forget; errors are logged but don't affect the app.

```js
context.bus.on('terminal:postSpawn', 'my-plugin', ({ projectDir, terminalId }) => {
  context.log(`Terminal ${terminalId} spawned in ${projectDir}`)
})
```

## Toolbar

Add a button to the dock's toolbar bar by including a `toolbar` field in your manifest.

```json
"toolbar": {
  "title": "My Plugin",
  "icon": "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' stroke='currentColor' fill='none' stroke-width='2'><rect x='3' y='3' width='18' height='18' rx='2'/></svg>",
  "action": "my-plugin:open",
  "order": 90
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Tooltip text on hover. |
| `icon` | Yes | SVG markup string. Must include `xmlns`, `width="14"`, `height="14"`. |
| `action` | Yes | IPC channel invoked with `(projectDir)` when clicked. |
| `order` | No | Sort order (default 100). Lower values appear further left. |

### Icon Format

The `icon` field can be either **inline SVG markup** or a **file path** to an `.svg` file in your plugin directory:

```json
"icon": "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/></svg>"
```

```json
"icon": "./assets/icon.svg"
```

If a file path is used, the file is read at load time and its contents replace the path — the renderer always receives inline SVG. The file path must resolve within the plugin directory (path traversal is blocked).

### SVG Requirements

Whether inline or from a file:

- **Must include** `xmlns='http://www.w3.org/2000/svg'`
- **Must include** `width='14' height='14'` (the toolbar icon size)
- **Must use** `stroke='currentColor'` or `fill='currentColor'` to match the theme
- **Cannot contain** `<script>`, `on*=` event handlers, `javascript:` URLs, or `data:text/html`
- Only safe SVG elements and presentation attributes are allowed (shapes, paths, text, gradients)

## Windows

Plugin windows are separate `BrowserWindow` instances with a frameless frame, context isolation, and the same preload script as the dock. Your HTML file receives query parameters and has access to `window.dockApi`.

### Query Parameters

Your window's URL includes:

| Parameter | Description |
|-----------|-------------|
| `pluginId` | Your plugin's ID |
| `projectDir` | The project directory (URL-encoded) |

```js
const params = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(params.get('projectDir') || '')
```

### Available APIs (`window.dockApi`)

Your plugin window has access to the full preload API:

```js
const api = window.dockApi

// Window controls (windows are frameless — you must provide your own)
api.win.minimize()
api.win.maximize()
api.win.close()

// Settings (for theming)
const settings = await api.settings.get()
api.settings.onChange((newSettings) => { /* re-apply theme */ })

// Call your plugin's IPC handlers
const result = await api.plugins.invoke('my-plugin:getData', projectDir)

// Plugin settings
const value = await api.plugins.getSetting(projectDir, 'my-plugin', 'myOption')
await api.plugins.setSetting(projectDir, 'my-plugin', 'myOption', false)

// Open external URLs
api.app.openExternal('https://example.com')
```

### Theming

The app uses CSS variables for theming. Read the current theme from settings and apply it:

```js
async function applyTheme() {
  const settings = await window.dockApi.settings.get()
  const mode = settings.theme.mode
  const isDark = mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  if (settings.theme.accentColor) {
    document.documentElement.style.setProperty('--accent-color', settings.theme.accentColor)
  }
}
applyTheme()
window.dockApi.settings.onChange(applyTheme)
```

Standard CSS variables:

```css
:root {
  --bg-primary: #0f0f14;
  --bg-secondary: #1a1b26;
  --bg-tertiary: #24283b;
  --text-primary: #c0caf5;
  --text-secondary: #565f89;
  --border-color: #292e42;
  --hover-color: #33467c;
  --accent-color: #da7756;
}
[data-theme='light'] {
  --bg-primary: #f5f5f5;
  --bg-secondary: #ffffff;
  --bg-tertiary: #e8e8e8;
  --text-primary: #1a1b26;
  --text-secondary: #6b7280;
  --border-color: #d1d5db;
  --hover-color: #e5e7eb;
}
```

### Titlebar

Windows are frameless. Provide your own titlebar with drag region and window controls:

```html
<div style="-webkit-app-region: drag; height: 32px; display: flex; align-items: center;">
  <span style="flex: 1;">My Plugin</span>
  <div style="-webkit-app-region: no-drag;">
    <button onclick="dockApi.win.minimize()">&#x2500;</button>
    <button onclick="dockApi.win.maximize()">&#x25A1;</button>
    <button onclick="dockApi.win.close()">&#x2715;</button>
  </div>
</div>
```

## Settings

Declare settings in your manifest's `settingsSchema` array. They appear automatically in the Settings UI under your plugin's name, per project.

```json
"settingsSchema": [
  { "key": "apiKey",    "label": "API Key",           "type": "string",  "defaultValue": "" },
  { "key": "enabled",   "label": "Enable feature",    "type": "boolean", "defaultValue": true },
  { "key": "interval",  "label": "Check interval (s)","type": "number",  "defaultValue": 30 }
]
```

Supported types: `boolean`, `string`, `number`.

Read settings from the main process via events:

```js
context.bus.on('settings:changed', 'my-plugin', ({ settings }) => {
  // React to global settings changes
})
```

Read plugin-specific settings from the renderer:

```js
const val = await dockApi.plugins.getSetting(projectDir, 'my-plugin', 'apiKey')
```

## Security

Plugins run in the main Electron process and have access to Node.js APIs through the context object. Claude Dock enforces several security measures:

**Trust & Consent**
- First-time plugins show a blocking consent dialog listing capabilities
- Approval is stored as a SHA-256 hash of `plugin.json` — any manifest change triggers re-approval
- Users can revoke trust by disabling the plugin in settings

**IPC Sandboxing**
- Plugins cannot register handlers on reserved channel prefixes
- Window renderers run with `contextIsolation: true` and `nodeIntegration: false`

**SVG Sanitization**
- Toolbar icons are parsed and sanitized with a whitelist of safe elements and attributes
- Scripts, event handlers, and dangerous URI schemes are stripped

**Path Traversal Prevention**
- `main` and `window.entry` paths must resolve within the plugin directory
- Paths like `../../etc/passwd` are rejected at load time

## Complete Example

A working test plugin is included with the project at:

```
%APPDATA%/claude-dock/plugins/dock-test/
```

It demonstrates all major features: toolbar button, window with theming, IPC round-trip, event bus listeners, and settings. Use it as a starting template for your own plugins.

### Minimal plugin (window only, no code)

```
my-viewer/
  plugin.json
  index.html
```

```json
{
  "id": "my-viewer",
  "name": "My Viewer",
  "version": "1.0.0",
  "description": "Simple viewer window",
  "defaultEnabled": true,
  "main": "./main.js",
  "toolbar": {
    "title": "Open Viewer",
    "icon": "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='12' y1='8' x2='12' y2='16'/><line x1='8' y1='12' x2='16' y2='12'/></svg>",
    "action": "my-viewer:open"
  },
  "window": {
    "entry": "./index.html"
  }
}
```

If you omit `main.js` (or don't export `activate`), the toolbar button automatically opens the window with no code required.

## Directory Structure Reference

```
~/.claude-dock/plugins/my-plugin/
  plugin.json          # Manifest (required)
  main.js              # Main-process module (required if main field set)
  index.html           # Window renderer (required if window.entry set)
  assets/              # Static files (optional, access via context.pluginDir)
    styles.css
    icon.png
```
