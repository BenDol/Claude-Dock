import { exec, execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { log, logInfo, logError, getLogDir } from './logger'

export interface ClaudeCliStatus {
  installed: boolean
  path?: string
  version?: string
}

export interface ClaudeInstallResult {
  success: boolean
  error?: string
}

export interface GitStatus {
  installed: boolean
}

export interface GitInstallResult {
  success: boolean
  error?: string
}

const QUICKSTART_URL = 'https://code.claude.com/docs/en/overview'

export function getQuickstartUrl(): string {
  return QUICKSTART_URL
}

// ─── Git Detection & Installation ───

/**
 * Detect whether Git is installed.
 * Never throws — on unexpected error, assumes installed.
 */
export async function detectGit(): Promise<GitStatus> {
  try {
    // Method 1: which/where
    const found = await new Promise<boolean>((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      execFile(cmd, ['git'], { timeout: 5000 }, (err) => resolve(!err))
    })
    if (found) {
      log('Git found via which/where')
      return { installed: true }
    }

    // Method 2: Check known locations
    if (process.platform === 'win32') {
      const locations = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
      for (const loc of locations) {
        try {
          if (fs.existsSync(loc)) {
            log(`Git found at known location: ${loc}`)
            return { installed: true }
          }
        } catch { /* skip */ }
      }
    }

    // Method 3: Try running git --version
    const hasVersion = await new Promise<boolean>((resolve) => {
      exec('git --version', { timeout: 5000 }, (err) => resolve(!err))
    })
    if (hasVersion) {
      log('Git found via --version fallback')
      return { installed: true }
    }

    log('Git not found by any detection method')
    return { installed: false }
  } catch (err) {
    logError('Git detection failed unexpectedly — assuming installed:', err)
    return { installed: true }
  }
}

/**
 * Install Git by opening a visible terminal with the appropriate install command.
 * - Windows: winget install Git.Git in a visible CMD
 * - macOS: xcode-select --install (system dialog) + polling
 * - Linux: detect package manager, open terminal with sudo apt/dnf/pacman install
 */
export async function installGit(): Promise<GitInstallResult> {
  try {
    log('Opening Git installer...')
    if (process.platform === 'win32') {
      return await installGitWindows()
    } else if (process.platform === 'darwin') {
      return await installGitMacOS()
    } else {
      return await installGitLinux()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('Git install failed:', msg)
    return { success: false, error: msg }
  }
}

function installGitWindows(): Promise<GitInstallResult> {
  const scriptPath = path.join(os.tmpdir(), 'git-install.cmd')

  fs.writeFileSync(scriptPath, [
    '@echo off',
    'echo Installing Git for Windows via winget...',
    'echo.',
    'winget install Git.Git --accept-source-agreements --accept-package-agreements',
    'if errorlevel 1 (',
    '  echo.',
    '  echo winget failed. Trying manual download...',
    '  echo Opening Git download page in your browser...',
    '  start https://git-scm.com/downloads/win',
    '  echo.',
    '  echo Please download and install Git, then close this window.',
    '  pause',
    '  goto :eof',
    ')',
    'echo.',
    'echo Git installation complete!',
    'pause',
  ].join('\r\n'))

  return new Promise((resolve) => {
    const child = spawn('cmd.exe', [
      '/c', 'start', '/wait', 'cmd.exe', '/c', scriptPath
    ], { stdio: 'ignore', windowsHide: false })

    child.on('close', async () => {
      cleanup(scriptPath)
      refreshWindowsPath()
      const status = await detectGit()
      resolve(status.installed
        ? { success: true }
        : { success: false, error: 'Git was not detected after installation. You may need to restart Claude Dock.' })
    })

    child.on('error', (err) => {
      cleanup(scriptPath)
      resolve({ success: false, error: `Failed to open installer: ${err.message}` })
    })
  })
}

function installGitMacOS(): Promise<GitInstallResult> {
  // xcode-select --install shows a system dialog
  spawn('xcode-select', ['--install'], { stdio: 'ignore' })

  // Poll for git to become available
  return new Promise((resolve) => {
    const maxAttempts = 120 // 10 minutes
    let attempts = 0

    const check = async (): Promise<void> => {
      attempts++
      const status = await detectGit()
      if (status.installed) {
        resolve({ success: true })
        return
      }
      if (attempts >= maxAttempts) {
        resolve({ success: false, error: 'Timed out waiting for Xcode Command Line Tools. Check the installer dialog.' })
        return
      }
      setTimeout(check, 5000)
    }

    // Give the dialog time to appear and user to click install
    setTimeout(check, 10000)
  })
}

async function installGitLinux(): Promise<GitInstallResult> {
  // Detect package manager and build install command
  const pmCmd = await detectLinuxPackageManager()
  if (!pmCmd) {
    return { success: false, error: 'No supported package manager found (apt, dnf, pacman). Please install git manually.' }
  }

  const terminal = await findLinuxTerminal()
  if (!terminal) {
    return { success: false, error: `No supported terminal emulator found. Please run: ${pmCmd}` }
  }

  return new Promise((resolve) => {
    const installCmd = `${pmCmd}; echo ""; read -p "Press Enter to close..."`
    const args = [...terminal.args, installCmd]
    log(`Linux git install: ${terminal.cmd} ${args.join(' ')}`)
    const child = spawn(terminal.cmd, args, { stdio: 'ignore' })

    child.on('close', async () => {
      const status = await detectGit()
      resolve(status.installed
        ? { success: true }
        : { success: false, error: 'Git was not detected after installation.' })
    })

    child.on('error', (err) => {
      resolve({ success: false, error: `Failed to open terminal: ${err.message}` })
    })
  })
}

async function detectLinuxPackageManager(): Promise<string | null> {
  const managers = [
    { check: 'apt-get', cmd: 'sudo apt-get install -y git' },
    { check: 'dnf', cmd: 'sudo dnf install -y git' },
    { check: 'pacman', cmd: 'sudo pacman -S --noconfirm git' },
    { check: 'zypper', cmd: 'sudo zypper install -y git' },
  ]

  for (const pm of managers) {
    const found = await commandExists(pm.check)
    if (found) return pm.cmd
  }
  return null
}

// ─── Claude Detection & Installation ───

/**
 * Detect whether the Claude CLI is installed.
 * Uses multiple methods for robustness — never throws, never kills the app.
 * On any unexpected error, assumes installed to avoid false positives.
 */
export async function detectClaudeCli(): Promise<ClaudeCliStatus> {
  try {
    // Method 1: which/where — most reliable, checks live PATH
    const whichPath = await findViaWhich()
    if (whichPath) {
      log(`Claude CLI found via which/where: ${whichPath}`)
      return { installed: true, path: whichPath }
    }

    // Method 2: Manually scan PATH env var for claude executable
    const pathScanResult = scanPathForClaude()
    if (pathScanResult) {
      log(`Claude CLI found via PATH scan: ${pathScanResult}`)
      return { installed: true, path: pathScanResult }
    }

    // Method 3: Check well-known installation directories per-OS
    const knownPath = checkKnownLocations()
    if (knownPath) {
      log(`Claude CLI found at known location: ${knownPath}`)
      // Found at known location but not in PATH — fix it
      ensureClaudeInWindowsPath()
      return { installed: true, path: knownPath }
    }

    // Method 4: Try running claude --version directly as a last resort
    // (covers cases where claude is in PATH but where/which failed)
    const version = await getClaudeVersion()
    if (version) {
      log(`Claude CLI found via --version fallback: ${version}`)
      return { installed: true, version }
    }

    log('Claude CLI not found by any detection method')
    return { installed: false }
  } catch (err) {
    // On ANY unexpected error, assume installed to avoid blocking the user
    logError('Claude CLI detection failed unexpectedly — assuming installed:', err)
    return { installed: true }
  }
}

/** Use `where` (Windows) or `which` (Unix) to find claude in PATH */
function findViaWhich(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('where', ['claude'], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
          return
        }
        // `where` on Windows may return multiple lines — take the first
        resolve(stdout.trim().split(/\r?\n/)[0])
      })
    } else {
      // Use a login shell so freshly-installed PATH entries (e.g. from ~/.zshrc) are picked up
      exec('bash -l -c "which claude"', { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
          return
        }
        resolve(stdout.trim().split(/\r?\n/)[0])
      })
    }
  })
}

/** Manually scan each directory in PATH for the claude executable */
function scanPathForClaude(): string | null {
  const envPath = process.env.PATH || process.env.Path || ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const dirs = envPath.split(separator).filter(Boolean)

  const candidates = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude.ps1', 'claude']
    : ['claude']

  for (const dir of dirs) {
    for (const name of candidates) {
      const fullPath = path.join(dir, name)
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  }
  return null
}

/** Check well-known installation locations per-OS */
function checkKnownLocations(): string | null {
  const home = os.homedir()

  const locations: string[] = process.platform === 'win32'
    ? [
        // Official installer location
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude.cmd'),
        path.join(home, '.local', 'bin', 'claude'),
        // npm global
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(process.env.APPDATA || '', 'npm', 'claude'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'claude.cmd'),
        path.join(process.env.NVM_SYMLINK || '', 'claude.cmd'),
        path.join(home, 'AppData', 'Local', 'pnpm', 'claude.cmd'),
      ]
    : process.platform === 'darwin'
    ? [
        // Official installer location
        path.join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.nvm', 'versions', 'node'),  // checked as prefix below
        path.join(home, '.local', 'share', 'pnpm', 'claude'),
      ]
    : [
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.local', 'share', 'pnpm', 'claude'),
        path.join(home, '.local', 'bin', 'claude'),
      ]

  for (const loc of locations) {
    if (!loc) continue
    try {
      if (fs.existsSync(loc) && fs.statSync(loc).isFile()) {
        return loc
      }
    } catch {
      // Skip
    }
  }

  // macOS/Linux: check nvm versions directories for any node version containing claude
  if (process.platform !== 'win32') {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node')
    try {
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir)
        for (const ver of versions) {
          const candidate = path.join(nvmDir, ver, 'bin', 'claude')
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate
          }
        }
      }
    } catch {
      // Skip
    }
  }

  return null
}

/** Get the Claude CLI version string via shell — called separately to avoid slowing detection */
export function getClaudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    // Use login shell on Unix so freshly-installed PATH entries are picked up
    const cmd = process.platform === 'win32'
      ? 'claude --version'
      : 'bash -l -c "claude --version"'
    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null)
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * Install Claude CLI by opening a visible terminal with the official quickstart command.
 * - Windows: PowerShell with `irm https://claude.ai/install.ps1 | iex`
 * - macOS: Terminal with `curl -fsSL https://claude.ai/install.sh | sh`
 * - Linux: Detects terminal emulator, runs `curl -fsSL https://claude.ai/install.sh | sh`
 *
 * Detects completion by waiting for the spawned terminal to close (Windows/Linux)
 * or polling (macOS), then re-runs the install check.
 */
export async function installClaudeCli(): Promise<ClaudeInstallResult> {
  try {
    log('Opening Claude CLI installer...')
    if (process.platform === 'win32') {
      return await installWindows()
    } else if (process.platform === 'darwin') {
      return await installMacOS()
    } else {
      return await installLinux()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('Claude CLI install failed:', msg)
    return { success: false, error: msg }
  }
}

function installWindows(): Promise<ClaudeInstallResult> {
  const logPath = getInstallLogPath()
  const scriptPath = path.join(os.tmpdir(), 'claude-install.cmd')

  // CMD batch script using the official CMD install method from the docs.
  // Logs all output to a file while displaying it in the visible window.
  const logPathEscaped = logPath.replace(/\//g, '\\')
  fs.writeFileSync(scriptPath, [
    '@echo off',
    `set "LOG_FILE=${logPathEscaped}"`,
    'echo Installing Claude Code... > "%LOG_FILE%"',
    'echo Installing Claude Code...',
    'echo.',
    '',
    ':: Use the official CMD install method from the quickstart docs',
    'curl -fsSL https://claude.ai/install.cmd -o "%TEMP%\\claude-code-install.cmd" 2>> "%LOG_FILE%"',
    'if errorlevel 1 (',
    '  echo Failed to download installer. >> "%LOG_FILE%"',
    '  echo Failed to download installer. Check your internet connection.',
    '  goto :diagnostics',
    ')',
    'call "%TEMP%\\claude-code-install.cmd" >> "%LOG_FILE%" 2>&1',
    'del "%TEMP%\\claude-code-install.cmd" 2>nul',
    '',
    ':diagnostics',
    'echo. >> "%LOG_FILE%"',
    'echo --- Post-install diagnostics --- >> "%LOG_FILE%"',
    'echo PATH: %PATH% >> "%LOG_FILE%"',
    'echo USERPROFILE: %USERPROFILE% >> "%LOG_FILE%"',
    'if exist "%USERPROFILE%\\.local\\bin" (',
    '  echo ~/.local/bin exists: true >> "%LOG_FILE%"',
    '  dir "%USERPROFILE%\\.local\\bin" >> "%LOG_FILE%" 2>&1',
    ') else (',
    '  echo ~/.local/bin exists: false >> "%LOG_FILE%"',
    ')',
    'where claude >> "%LOG_FILE%" 2>&1',
    'echo.',
    'pause',
  ].join('\r\n'))

  return new Promise((resolve) => {
    const child = spawn('cmd.exe', [
      '/c', 'start', '/wait', 'cmd.exe', '/c', scriptPath
    ], { stdio: 'ignore', windowsHide: false })

    child.on('close', async () => {
      cleanup(scriptPath)
      logInstallResult(logPath)
      refreshWindowsPath()
      ensureClaudeInWindowsPath()
      const status = await detectClaudeCli()
      resolve(status.installed
        ? { success: true }
        : { success: false, error: `Claude CLI was not detected. Check the install log:\n${logPath}` })
    })

    child.on('error', (err) => {
      cleanup(scriptPath)
      resolve({ success: false, error: `Failed to open installer: ${err.message}` })
    })
  })
}

function installMacOS(): Promise<ClaudeInstallResult> {
  const logPath = getInstallLogPath()
  const scriptPath = path.join(os.tmpdir(), 'claude-install.command')

  fs.writeFileSync(scriptPath, [
    '#!/bin/bash',
    `LOG_FILE="${logPath}"`,
    'echo "Installing Claude Code..." | tee "$LOG_FILE"',
    'echo "" | tee -a "$LOG_FILE"',
    'curl -fsSL https://claude.ai/install.sh | sh 2>&1 | tee -a "$LOG_FILE"',
    'echo "" | tee -a "$LOG_FILE"',
    'echo "--- Post-install diagnostics ---" >> "$LOG_FILE"',
    'echo "PATH: $PATH" >> "$LOG_FILE"',
    'echo "~/.local/bin exists: $([ -d ~/.local/bin ] && echo true || echo false)" >> "$LOG_FILE"',
    '[ -d ~/.local/bin ] && ls -la ~/.local/bin >> "$LOG_FILE"',
    'echo ""',
    'echo "Installation complete. This window will close shortly."',
    'sleep 2',
    'osascript -e \'tell application "Terminal" to close front window\' 2>/dev/null &',
    ''
  ].join('\n'), { mode: 0o755 })

  spawn('open', [scriptPath], { stdio: 'ignore' })

  return pollForClaude(() => {
    cleanup(scriptPath)
    logInstallResult(logPath)
  })
}

async function installLinux(): Promise<ClaudeInstallResult> {
  const logPath = getInstallLogPath()
  const installCmd = `curl -fsSL https://claude.ai/install.sh | sh 2>&1 | tee "${logPath}"; echo ""; echo "--- Post-install diagnostics ---" >> "${logPath}"; echo "PATH: $PATH" >> "${logPath}"; [ -d ~/.local/bin ] && ls -la ~/.local/bin >> "${logPath}"; echo ""; read -p "Press Enter to close..."`
  const terminal = await findLinuxTerminal()

  if (!terminal) {
    return { success: false, error: 'No supported terminal emulator found. Please run: curl -fsSL https://claude.ai/install.sh | sh' }
  }

  return new Promise((resolve) => {
    const args = [...terminal.args, installCmd]
    log(`Linux install: ${terminal.cmd} ${args.join(' ')}`)
    const child = spawn(terminal.cmd, args, { stdio: 'ignore' })

    child.on('close', async () => {
      logInstallResult(logPath)
      const status = await detectClaudeCli()
      resolve(status.installed
        ? { success: true }
        : { success: false, error: `Claude CLI was not detected. Check the install log:\n${logPath}` })
    })

    child.on('error', (err) => {
      resolve({ success: false, error: `Failed to open terminal: ${err.message}` })
    })
  })
}

async function findLinuxTerminal(): Promise<{ cmd: string; args: string[] } | null> {
  const terminals = [
    { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-c'] },
    { cmd: 'gnome-terminal', args: ['--', 'bash', '-c'] },
    { cmd: 'konsole', args: ['-e', 'bash', '-c'] },
    { cmd: 'xfce4-terminal', args: ['-e', 'bash', '-c'] },
    { cmd: 'xterm', args: ['-e', 'bash', '-c'] },
  ]

  for (const t of terminals) {
    const found = await commandExists(t.cmd)
    if (found) return t
  }
  return null
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`which ${cmd}`, { timeout: 3000 }, (err) => resolve(!err))
  })
}

/** Poll for Claude CLI every 3s for up to 5 minutes */
function pollForClaude(onDone?: () => void): Promise<ClaudeInstallResult> {
  return new Promise((resolve) => {
    const maxAttempts = 100
    let attempts = 0

    const check = async (): Promise<void> => {
      attempts++
      log(`pollForClaude: attempt ${attempts}/${maxAttempts}`)
      const status = await detectClaudeCli()
      if (status.installed) {
        log(`pollForClaude: detected after ${attempts} attempts`)
        onDone?.()
        resolve({ success: true })
        return
      }
      if (attempts >= maxAttempts) {
        log('pollForClaude: timed out')
        onDone?.()
        resolve({ success: false, error: 'Timed out waiting for installation. Check the installer window.' })
        return
      }
      setTimeout(check, 3000)
    }

    // Give the install script a head start before first check
    setTimeout(check, 5000)
  })
}

function cleanup(filePath: string): void {
  try { fs.unlinkSync(filePath) } catch { /* ignore */ }
}

/** Get path for the install log file, stored alongside app logs */
function getInstallLogPath(): string {
  const logDir = getLogDir()
  fs.mkdirSync(logDir, { recursive: true })
  return path.join(logDir, 'claude-install.log')
}

/** Read the install log and write it to the app's debug log */
function logInstallResult(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) {
      logInfo('Claude install log: file not found (installer may not have written output)')
      return
    }
    const content = fs.readFileSync(logPath, 'utf8')
    logInfo(`Claude install log (${logPath}):\n${content}`)
  } catch (err) {
    logError('Failed to read install log:', err)
  }
}

/**
 * If ~/.local/bin contains any claude binary but isn't in the user's PATH, add it.
 * This fixes the case where the official installer puts the binary there
 * but doesn't update PATH (or the update didn't stick).
 *
 * Uses a temp .ps1 file to avoid all cmd.exe quoting/escaping issues.
 * The PowerShell [Environment] API reads/writes REG_EXPAND_SZ safely
 * (preserving %VAR% references in the existing PATH).
 */
function ensureClaudeInWindowsPath(): void {
  if (process.platform !== 'win32') return
  try {
    const localBin = path.join(os.homedir(), '.local', 'bin')

    // Check if ANY claude binary exists in ~/.local/bin
    const candidates = ['claude.exe', 'claude.cmd', 'claude']
    const hasClaude = candidates.some((name) => {
      try { return fs.existsSync(path.join(localBin, name)) } catch { return false }
    })
    if (!hasClaude) {
      log(`ensureClaudeInWindowsPath: no claude binary found in ${localBin}`)
      return
    }

    const { execSync } = require('child_process')

    // Write a temp .ps1 script file to avoid all cmd.exe quoting issues.
    // This is the safest way to run multi-line PowerShell from Node.
    const psPath = path.join(os.tmpdir(), 'claude-dock-pathfix.ps1')
    // Semicolons after every statement so this is valid even if the
    // bundler collapses newlines into a single line.
    fs.writeFileSync(psPath, [
      `$dir = '${localBin.replace(/'/g, "''")}';`,
      `$current = [Environment]::GetEnvironmentVariable('Path', 'User');`,
      `if ($null -eq $current) { $current = '' };`,
      `$entries = $current -split ';' | ForEach-Object { $_.Trim().ToLower() };`,
      `if ($entries -contains $dir.ToLower()) {`,
      `  Write-Output 'ALREADY';`,
      `} else {`,
      `  $newPath = if ($current) { "$current;$dir" } else { $dir };`,
      `  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User');`,
      `  Write-Output 'ADDED';`,
      `}`,
    ].join('\r\n'))

    log(`ensureClaudeInWindowsPath: running ${psPath}`)

    const result: string = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim()

    log(`ensureClaudeInWindowsPath: PowerShell returned: "${result}"`)

    // Clean up temp file
    try { fs.unlinkSync(psPath) } catch { /* ignore */ }

    if (result === 'ADDED') {
      logInfo(`ensureClaudeInWindowsPath: added ${localBin} to user PATH`)
      // Update our own process.env so subsequent detection works
      process.env.PATH = (process.env.PATH || '') + ';' + localBin
      process.env.Path = process.env.PATH
    } else if (result === 'ALREADY') {
      log(`ensureClaudeInWindowsPath: ${localBin} already in user PATH`)
    } else {
      logError(`ensureClaudeInWindowsPath: unexpected output: "${result}"`)
    }
  } catch (err) {
    logError('ensureClaudeInWindowsPath failed:', err)
  }
}

/**
 * Refresh process.env.PATH from the Windows registry so we pick up
 * any PATH changes the installer just made (e.g. adding ~/.local/bin).
 * Our Electron process was started before the install, so its PATH is stale.
 */
function refreshWindowsPath(): void {
  if (process.platform !== 'win32') return
  try {
    const { execSync } = require('child_process')

    // Read user PATH from registry
    let userPath = ''
    try {
      const userOut: string = execSync(
        'reg query "HKCU\\Environment" /v Path',
        { encoding: 'utf8', timeout: 5000 }
      )
      const userMatch = userOut.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
      if (userMatch) userPath = userMatch[1].trim()
    } catch { /* user PATH may not exist */ }

    // Read system PATH from registry
    let sysPath = ''
    try {
      const sysOut: string = execSync(
        'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
        { encoding: 'utf8', timeout: 5000 }
      )
      const sysMatch = sysOut.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
      if (sysMatch) sysPath = sysMatch[1].trim()
    } catch { /* shouldn't fail but be safe */ }

    if (userPath || sysPath) {
      const newPath = [sysPath, userPath].filter(Boolean).join(';')
      log(`Refreshed PATH from registry (${newPath.length} chars)`)
      process.env.PATH = newPath
      process.env.Path = newPath
    }
  } catch (err) {
    logError('Failed to refresh PATH from registry:', err)
  }
}
