/**
 * OS-level context menu integration for Claude Dock.
 *
 * - Windows: Registry entries under HKCU\Software\Classes\Directory\...
 *   (appears in Explorer right-click menu: "Open with Claude Dock")
 * - macOS: Finder Quick Action (Automator .workflow bundle) in ~/Library/Services/
 * - Linux: .desktop file with actions in ~/.local/share/nemo/actions/ and
 *   ~/.local/share/nautilus/scripts/, plus KDE service menu.
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import { log, logError } from './logger'

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WIN_REG_DIR = 'HKCU\\Software\\Classes\\Directory\\shell\\ClaudeDock'
const WIN_REG_BG = 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\ClaudeDock'

function windowsRegister(): { success: boolean; error?: string } {
  try {
    const exePath = app.getPath('exe')
    const iconPath = exePath // Use the exe itself as the icon source

    // Directory right-click: "Open with Claude Dock"
    execSync(`reg add "${WIN_REG_DIR}" /ve /d "Open with Claude Dock" /f`, { encoding: 'utf8' })
    execSync(`reg add "${WIN_REG_DIR}" /v "Icon" /d "${iconPath}" /f`, { encoding: 'utf8' })
    execSync(`reg add "${WIN_REG_DIR}\\command" /ve /d "\\"${exePath}\\" \\"%V\\"" /f`, { encoding: 'utf8' })

    // Background right-click (inside a folder): "Open with Claude Dock"
    execSync(`reg add "${WIN_REG_BG}" /ve /d "Open with Claude Dock" /f`, { encoding: 'utf8' })
    execSync(`reg add "${WIN_REG_BG}" /v "Icon" /d "${iconPath}" /f`, { encoding: 'utf8' })
    execSync(`reg add "${WIN_REG_BG}\\command" /ve /d "\\"${exePath}\\" \\"%V\\"" /f`, { encoding: 'utf8' })

    log('[context-menu] Windows: registered context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Windows register failed:', msg)
    return { success: false, error: msg }
  }
}

function windowsUnregister(): { success: boolean; error?: string } {
  try {
    try { execSync(`reg delete "${WIN_REG_DIR}" /f`, { encoding: 'utf8' }) } catch { /* may not exist */ }
    try { execSync(`reg delete "${WIN_REG_BG}" /f`, { encoding: 'utf8' }) } catch { /* may not exist */ }
    log('[context-menu] Windows: removed context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Windows unregister failed:', msg)
    return { success: false, error: msg }
  }
}

function windowsIsRegistered(): boolean {
  try {
    execSync(`reg query "${WIN_REG_DIR}" /ve`, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

/**
 * Read the exe path currently stored in the registry command entry.
 * Returns null if not registered or unreadable.
 */
function windowsGetRegisteredExe(): string | null {
  try {
    const output = execSync(`reg query "${WIN_REG_DIR}\\command" /ve`, { encoding: 'utf8' })
    // Output looks like:  (Default)    REG_SZ    "C:\...\Claude Dock.exe" "%V"
    const match = output.match(/"([^"]+)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * If the context menu is registered but points to a different exe path
 * (e.g. after an auto-update changed install location), re-register
 * to update the path. If the registered exe no longer exists on disk,
 * remove the stale entries entirely.
 */
function windowsRefreshIfNeeded(): void {
  if (!windowsIsRegistered()) return

  const registeredExe = windowsGetRegisteredExe()
  if (!registeredExe) return

  const currentExe = app.getPath('exe')

  if (registeredExe.toLowerCase() === currentExe.toLowerCase()) return

  // The registered exe differs from the current one
  if (fs.existsSync(registeredExe)) {
    // Old exe still exists (different install?) — don't touch it
    return
  }

  // Old exe is gone — the app was moved or the old install was removed.
  // Re-register with the current exe path.
  log(`[context-menu] Windows: refreshing stale registry (old: ${registeredExe}, new: ${currentExe})`)
  windowsRegister()
}

// ---------------------------------------------------------------------------
// macOS — Finder Quick Action (Automator .workflow bundle)
// ---------------------------------------------------------------------------

function macRegister(): { success: boolean; error?: string } {
  try {
    const exePath = app.getPath('exe')
    // For a .app bundle the executable is inside Contents/MacOS/
    // We want the .app bundle path for `open`
    const appPath = exePath.includes('.app/Contents/')
      ? exePath.substring(0, exePath.indexOf('.app/') + 4)
      : exePath

    const servicesDir = path.join(app.getPath('home'), 'Library', 'Services')
    const workflowDir = path.join(servicesDir, 'Open with Claude Dock.workflow')
    const contentsDir = path.join(workflowDir, 'Contents')

    fs.mkdirSync(contentsDir, { recursive: true })

    // Info.plist — declares a Quick Action that accepts folders in Finder
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>Open with Claude Dock</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`

    // document.wflow — Automator workflow that runs a shell script
    const wflow = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<integer>2</integer>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<false/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>1.0.2</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMLargeIconName</key>
				<string>RunShellScript</string>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>for f in "$@"; do
	open -a "${appPath}" --args "$f"
done</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>1.0.2</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>A1A1A1A1-B2B2-C3C3-D4D4-E5E5E5E5E5E5</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
				</array>
				<key>OutputUUID</key>
				<string>F6F6F6F6-A7A7-B8B8-C9C9-D0D0D0D0D0D0</string>
				<key>UUID</key>
				<string>12345678-1234-1234-1234-123456789ABC</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<true/>
				<key>location</key>
				<string>529.000000:620.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>`

    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist)
    fs.writeFileSync(path.join(contentsDir, 'document.wflow'), wflow)

    // Refresh Services menu
    try {
      execSync('/System/Library/CoreServices/pbs -flush', { encoding: 'utf8', timeout: 5000 })
    } catch { /* best effort */ }

    log('[context-menu] macOS: registered Finder Quick Action')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] macOS register failed:', msg)
    return { success: false, error: msg }
  }
}

function macUnregister(): { success: boolean; error?: string } {
  try {
    const workflowDir = path.join(
      app.getPath('home'), 'Library', 'Services', 'Open with Claude Dock.workflow'
    )
    if (fs.existsSync(workflowDir)) {
      fs.rmSync(workflowDir, { recursive: true, force: true })
    }
    try {
      execSync('/System/Library/CoreServices/pbs -flush', { encoding: 'utf8', timeout: 5000 })
    } catch { /* best effort */ }

    log('[context-menu] macOS: removed Finder Quick Action')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] macOS unregister failed:', msg)
    return { success: false, error: msg }
  }
}

function macIsRegistered(): boolean {
  const workflowDir = path.join(
    app.getPath('home'), 'Library', 'Services', 'Open with Claude Dock.workflow'
  )
  return fs.existsSync(workflowDir)
}

/**
 * If the workflow exists but references an app path that no longer exists,
 * re-register to update it. If the current app path changed (e.g. moved),
 * this ensures the Quick Action still works.
 */
function macRefreshIfNeeded(): void {
  if (!macIsRegistered()) return

  try {
    const wflowPath = path.join(
      app.getPath('home'), 'Library', 'Services',
      'Open with Claude Dock.workflow', 'Contents', 'document.wflow'
    )
    const content = fs.readFileSync(wflowPath, 'utf8')

    const exePath = app.getPath('exe')
    const currentAppPath = exePath.includes('.app/Contents/')
      ? exePath.substring(0, exePath.indexOf('.app/') + 4)
      : exePath

    // Check if the workflow already references the current app path
    if (content.includes(currentAppPath)) return

    // Extract the old app path from the workflow
    const match = content.match(/open -a "([^"]+)"/)
    if (match && !fs.existsSync(match[1])) {
      // Old app path is gone — re-register with updated path
      log(`[context-menu] macOS: refreshing stale workflow (old: ${match[1]}, new: ${currentAppPath})`)
      macRegister()
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Linux — .desktop file actions + Nautilus scripts + KDE/Dolphin service menu
// ---------------------------------------------------------------------------

function linuxGetExePath(): string {
  const exePath = app.getPath('exe')
  // For AppImage, the exe is inside the mounted image — use APPIMAGE env var
  return process.env.APPIMAGE || exePath
}

function linuxRegister(): { success: boolean; error?: string } {
  try {
    const exePath = linuxGetExePath()

    // 1. Nemo actions (Cinnamon file manager)
    const nemoDir = path.join(app.getPath('home'), '.local', 'share', 'nemo', 'actions')
    fs.mkdirSync(nemoDir, { recursive: true })
    fs.writeFileSync(path.join(nemoDir, 'claude-dock.nemo_action'), [
      '[Nemo Action]',
      'Name=Open with Claude Dock',
      'Comment=Open this folder in Claude Dock',
      `Exec="${exePath}" "%F"`,
      'Icon-Name=utilities-terminal',
      'Selection=any',
      'Extensions=dir;',
      ''
    ].join('\n'))

    // 2. Nautilus scripts (GNOME Files)
    const nautilusDir = path.join(app.getPath('home'), '.local', 'share', 'nautilus', 'scripts')
    fs.mkdirSync(nautilusDir, { recursive: true })
    const nautilusScript = path.join(nautilusDir, 'Open with Claude Dock')
    fs.writeFileSync(nautilusScript, [
      '#!/bin/sh',
      `exec "${exePath}" "$NAUTILUS_SCRIPT_CURRENT_URI" "$@"`,
      ''
    ].join('\n'))
    fs.chmodSync(nautilusScript, 0o755)

    // 3. KDE/Dolphin service menu
    const kdeDir = path.join(app.getPath('home'), '.local', 'share', 'kio', 'servicemenus')
    fs.mkdirSync(kdeDir, { recursive: true })
    fs.writeFileSync(path.join(kdeDir, 'claude-dock.desktop'), [
      '[Desktop Entry]',
      'Type=Service',
      'ServiceTypes=KonqPopupMenu/Plugin',
      'MimeType=inode/directory;',
      'Actions=openClaudeDock',
      '',
      '[Desktop Action openClaudeDock]',
      'Name=Open with Claude Dock',
      'Icon=utilities-terminal',
      `Exec="${exePath}" "%f"`,
      ''
    ].join('\n'))

    log('[context-menu] Linux: registered context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Linux register failed:', msg)
    return { success: false, error: msg }
  }
}

function linuxUnregister(): { success: boolean; error?: string } {
  try {
    const files = [
      path.join(app.getPath('home'), '.local', 'share', 'nemo', 'actions', 'claude-dock.nemo_action'),
      path.join(app.getPath('home'), '.local', 'share', 'nautilus', 'scripts', 'Open with Claude Dock'),
      path.join(app.getPath('home'), '.local', 'share', 'kio', 'servicemenus', 'claude-dock.desktop')
    ]
    for (const f of files) {
      try { fs.unlinkSync(f) } catch { /* may not exist */ }
    }
    log('[context-menu] Linux: removed context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Linux unregister failed:', msg)
    return { success: false, error: msg }
  }
}

function linuxIsRegistered(): boolean {
  const nemoAction = path.join(
    app.getPath('home'), '.local', 'share', 'nemo', 'actions', 'claude-dock.nemo_action'
  )
  const nautilusScript = path.join(
    app.getPath('home'), '.local', 'share', 'nautilus', 'scripts', 'Open with Claude Dock'
  )
  const kdeMenu = path.join(
    app.getPath('home'), '.local', 'share', 'kio', 'servicemenus', 'claude-dock.desktop'
  )
  return fs.existsSync(nemoAction) || fs.existsSync(nautilusScript) || fs.existsSync(kdeMenu)
}

/**
 * If any of the registered Linux file manager entries reference an exe
 * that no longer exists, re-register to update the path.
 */
function linuxRefreshIfNeeded(): void {
  if (!linuxIsRegistered()) return

  const currentExe = linuxGetExePath()

  // Check the Nemo action for a stale exe path
  try {
    const nemoPath = path.join(
      app.getPath('home'), '.local', 'share', 'nemo', 'actions', 'claude-dock.nemo_action'
    )
    if (fs.existsSync(nemoPath)) {
      const content = fs.readFileSync(nemoPath, 'utf8')
      const match = content.match(/Exec="([^"]+)"/)
      if (match && match[1] !== currentExe && !fs.existsSync(match[1])) {
        log(`[context-menu] Linux: refreshing stale entries (old: ${match[1]}, new: ${currentExe})`)
        linuxRegister()
        return
      }
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerContextMenu(): { success: boolean; error?: string } {
  switch (process.platform) {
    case 'win32': return windowsRegister()
    case 'darwin': return macRegister()
    case 'linux': return linuxRegister()
    default: return { success: false, error: `Unsupported platform: ${process.platform}` }
  }
}

export function unregisterContextMenu(): { success: boolean; error?: string } {
  switch (process.platform) {
    case 'win32': return windowsUnregister()
    case 'darwin': return macUnregister()
    case 'linux': return linuxUnregister()
    default: return { success: false, error: `Unsupported platform: ${process.platform}` }
  }
}

export function isContextMenuRegistered(): boolean {
  switch (process.platform) {
    case 'win32': return windowsIsRegistered()
    case 'darwin': return macIsRegistered()
    case 'linux': return linuxIsRegistered()
    default: return false
  }
}

/**
 * Called on app startup. If context menu entries are registered but point to
 * a stale exe path (e.g. after auto-update changed install location or user
 * moved the app), re-register with the current exe path.
 * Safe to call every launch — no-ops if entries are current or absent.
 */
export function refreshContextMenuIfNeeded(): void {
  try {
    switch (process.platform) {
      case 'win32': windowsRefreshIfNeeded(); break
      case 'darwin': macRefreshIfNeeded(); break
      case 'linux': linuxRefreshIfNeeded(); break
    }
  } catch (e) {
    logError('[context-menu] refresh failed:', e)
  }
}
