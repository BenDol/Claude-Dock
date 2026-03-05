<p align="center">
  <img src="assets/logo.png" alt="Claude Dock" width="256" />
</p>

<h1 align="center">Claude Dock</h1>

<p align="center">
  A terminal dock for managing multiple Claude Code CLI instances side by side.
</p>

<p align="center">
  <a href="https://github.com/BenDol/Claude-Dock/releases/download/bleeding-edge/Claude.Dock.Setup.1.0.0.exe">Windows</a> |
  <a href="https://github.com/BenDol/Claude-Dock/releases/download/bleeding-edge/Claude.Dock-1.0.0.AppImage">Linux</a> |
  <a href="https://github.com/BenDol/Claude-Dock/releases/download/bleeding-edge/Claude.Dock-1.0.0-arm64.dmg">MacOS</a>
</p>

---

Claude Dock is an Electron app that lets you run multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions in a tiled grid layout. It handles PTY management, session persistence, and automatic resumption so you can close and reopen your workspace without losing context.

## Features

- **Multi-terminal grid** - Run multiple Claude Code instances in an auto-tiling or freeform grid layout
- **Session persistence** - Sessions are saved automatically and resumed when you reopen a project
- **Configurable grid** - Adjust columns, gap size, and switch between auto and freeform layout modes
- **Dark and light themes** - Full theme support including terminal color schemes
- **Customizable terminal** - Font family, font size, line height, cursor style, scrollback, and full 16-color palette
- **Serialized launches** - Claude instances are launched sequentially to prevent config file race conditions
- **Copy/paste support** - Ctrl+C/V, Ctrl+Shift+C/V, and right-click context menu
- **Window controls** - Custom frameless window with minimize, maximize, and close

<img width="800" alt="image" src="https://github.com/user-attachments/assets/0448aafb-1a6b-44a0-8aca-b28a3d49d38f" />

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Windows: Visual Studio Build Tools (for node-pty native compilation)

### Install

```bash
git clone https://github.com/BenDol/Claude-Dock.git
cd claude-dock
npm install
```

The `postinstall` script automatically patches node-pty build files for Windows compatibility.

### Development

```bash
npm run dev
```

### Build

```bash
# Windows
npm run package:win

# macOS
npm run package:mac

# Linux
npm run package:linux
```

Build output is in the `dist/` directory.

## CLI Usage

After launching Claude Dock once, the `claude-dock` command is automatically registered and available from any terminal (you may need to restart your terminal for PATH changes to take effect).

```bash
# Open a dock in the current directory
claude-dock

# Open a dock in a specific project directory
claude-dock /path/to/project
```

If Claude Dock is already running, the command opens a new dock window in the existing instance instead of launching a second process.

**How it works:**
- **Windows** — A `claude-dock.cmd` shim is created next to the app executable and its directory is added to the user `PATH` via the registry.
- **macOS / Linux** — A wrapper script is placed in the app's user data directory and symlinked to `/usr/local/bin/claude-dock`. If `/usr/local/bin` isn't writable, you can manually add the wrapper directory to your `PATH`.

## Architecture

```
src/
  main/           # Electron main process
    index.ts        # App entry point
    dock-window.ts  # Window + PTY lifecycle
    dock-manager.ts # Multi-window management
    pty-manager.ts  # PTY spawn queue + session tracking
    session-store.ts # Session persistence (electron-store)
    settings-store.ts
  preload/        # Context bridge (dockApi)
  renderer/       # React UI
    components/     # DockGrid, TerminalCard, TerminalView, Toolbar, SettingsModal
    hooks/          # useTerminal (xterm.js), useGridLayout, useResizeObserver
    stores/         # Zustand stores (dock-store, settings-store)
    lib/            # Theme, IPC bridge
  shared/         # Shared types (IPC channels, settings schema)
```


## License

MIT
