import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { DockManager } from './dock-manager'
import { log, logError } from './logger'

// Bump this when CLAUDE.md block or MCP server script changes.
// Migration will auto-update existing installs on startup.
const MCP_VERSION = 4

const CLAUDE_MD_START = '<!-- claude-dock-start -->'
const CLAUDE_MD_END = '<!-- claude-dock-end -->'

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
# Dock Link
If the file \`.linked\` exists in the project root, call the \`dock_status\` MCP tool
(pass \`project_dir\` with the absolute path to the project root, and \`session_id\` with
your session ID) before starting your task to see what other terminals are working on and
check for messages. This helps coordinate work and avoid conflicts.

If the \`dock_send_message\` tool is available, you can send messages to other terminals
to coordinate work (e.g., warn about file conflicts, request information, or share status).
Use \`dock_check_messages\` with your session ID to explicitly check for new messages.

If any tool is unavailable or errors, proceed normally — do not retry.
${CLAUDE_MD_END}`

function getUserClaudeDir(): string {
  return path.join(require('os').homedir(), '.claude')
}

function getMcpJsonPath(projectDir: string): string {
  return path.join(projectDir, '.mcp.json')
}

function getClaudeMdPath(): string {
  return path.join(getUserClaudeDir(), 'CLAUDE.md')
}

/** Runtime data directory (AppData) — for config, messages, activity, version */
function getDataDir(): string {
  return path.join(app.getPath('userData').replace(/claude-dock$/, ''), 'claude-dock')
}

/** Project-local MCP script path (shareable via git) */
function getProjectMcpScriptPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'claude-dock-mcp.cjs')
}

/** Legacy absolute path (AppData) — used for migration cleanup */
function getLegacyMcpServerPath(): string {
  return path.join(getDataDir(), 'claude-dock-mcp.js')
}

function getMcpServerSourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'claude-dock-mcp.cjs')
  }
  return path.join(app.getAppPath(), 'resources', 'claude-dock-mcp.cjs')
}

function getDockConfigPath(): string {
  return path.join(getDataDir(), 'dock-config.json')
}

function getVersionPath(): string {
  return path.join(getDataDir(), 'mcp-version')
}

// ---------- .mcp.json manipulation ----------

function readMcpJson(projectDir: string): Record<string, any> {
  const mcpPath = getMcpJsonPath(projectDir)
  try {
    if (fs.existsSync(mcpPath)) {
      return JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    }
  } catch (err) {
    logError('linked-mode: failed to read .mcp.json', err)
  }
  return {}
}

function writeMcpJson(projectDir: string, data: Record<string, any>): void {
  const mcpPath = getMcpJsonPath(projectDir)
  fs.writeFileSync(mcpPath, JSON.stringify(data, null, 2))
}

// ---------- dock-config.json ----------

function syncDockConfig(overrides?: Partial<{ messagingEnabled: boolean }>): void {
  try {
    const configPath = getDockConfigPath()
    let config: Record<string, any> = {}
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      }
    } catch { /* start fresh */ }

    if (overrides) {
      Object.assign(config, overrides)
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch (err) {
    logError('linked-mode: failed to sync dock-config.json', err)
  }
}

// ---------- CLAUDE.md manipulation ----------

function appendClaudeMd(): void {
  const mdPath = getClaudeMdPath()
  try {
    let content = ''
    if (fs.existsSync(mdPath)) {
      content = fs.readFileSync(mdPath, 'utf8')
    }
    if (content.includes(CLAUDE_MD_START)) return

    const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : ''
    fs.mkdirSync(path.dirname(mdPath), { recursive: true })
    fs.writeFileSync(mdPath, content + separator + CLAUDE_MD_BLOCK + '\n')
    log('linked-mode: appended CLAUDE.md instructions')
  } catch (err) {
    logError('linked-mode: failed to update CLAUDE.md', err)
  }
}

/** Replace existing CLAUDE.md block with the latest version */
function updateClaudeMd(): void {
  const mdPath = getClaudeMdPath()
  try {
    if (!fs.existsSync(mdPath)) {
      appendClaudeMd()
      return
    }
    let content = fs.readFileSync(mdPath, 'utf8')
    if (!content.includes(CLAUDE_MD_START)) {
      appendClaudeMd()
      return
    }
    // Replace existing block
    const regex = new RegExp(`${escapeRegex(CLAUDE_MD_START)}[\\s\\S]*?${escapeRegex(CLAUDE_MD_END)}`, 'g')
    content = content.replace(regex, CLAUDE_MD_BLOCK)
    fs.writeFileSync(mdPath, content)
    log('linked-mode: updated CLAUDE.md instructions')
  } catch (err) {
    logError('linked-mode: failed to update CLAUDE.md', err)
  }
}

function removeClaudeMd(): void {
  const mdPath = getClaudeMdPath()
  try {
    if (!fs.existsSync(mdPath)) return
    let content = fs.readFileSync(mdPath, 'utf8')
    if (!content.includes(CLAUDE_MD_START)) return

    const regex = new RegExp(`\\n?${escapeRegex(CLAUDE_MD_START)}[\\s\\S]*?${escapeRegex(CLAUDE_MD_END)}\\n?`, 'g')
    content = content.replace(regex, '\n').replace(/\n{3,}/g, '\n\n').trim()

    if (content.length === 0) {
      fs.unlinkSync(mdPath)
    } else {
      fs.writeFileSync(mdPath, content + '\n')
    }
    log('linked-mode: removed CLAUDE.md instructions')
  } catch (err) {
    logError('linked-mode: failed to clean CLAUDE.md', err)
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------- .linked file ----------

function createLinkedFile(projectDir: string): void {
  try {
    const linkedPath = path.join(projectDir, '.linked')
    fs.writeFileSync(linkedPath, 'Claude Dock linked mode active\n')
    log(`linked-mode: created .linked in ${projectDir}`)
  } catch (err) {
    logError('linked-mode: failed to create .linked', err)
  }
}

function removeLinkedFile(projectDir: string): void {
  try {
    const linkedPath = path.join(projectDir, '.linked')
    if (fs.existsSync(linkedPath)) {
      fs.unlinkSync(linkedPath)
      log(`linked-mode: removed .linked from ${projectDir}`)
    }
  } catch (err) {
    logError('linked-mode: failed to remove .linked', err)
  }
}

// ---------- Legacy cleanup ----------

function cleanLegacySettings(projectDir: string): void {
  const userDir = getUserClaudeDir()
  for (const file of ['settings.json', 'settings.local.json']) {
    try {
      const legacyPath = path.join(userDir, file)
      if (!fs.existsSync(legacyPath)) continue
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
      if (raw.mcpServers?.['claude-dock']) {
        delete raw.mcpServers['claude-dock']
        fs.writeFileSync(legacyPath, JSON.stringify(raw, null, 2))
        log(`linked-mode: cleaned stale entry from ~/${file}`)
      }
    } catch (err) {
      log(`linked-mode: cleanLegacySettings warning (${file}): ${err}`)
    }
  }
  try {
    const projSettings = path.join(projectDir, '.claude', 'settings.local.json')
    if (!fs.existsSync(projSettings)) return
    const raw = JSON.parse(fs.readFileSync(projSettings, 'utf8'))
    if (raw.mcpServers?.['claude-dock']) {
      delete raw.mcpServers['claude-dock']
      fs.writeFileSync(projSettings, JSON.stringify(raw, null, 2))
      log(`linked-mode: cleaned stale entry from project settings.local.json`)
    }
  } catch (err) {
    log(`linked-mode: cleanLegacySettings warning (project): ${err}`)
  }
}

// ---------- Version tracking ----------

function getInstalledVersion(): number {
  try {
    const vPath = getVersionPath()
    if (fs.existsSync(vPath)) {
      return parseInt(fs.readFileSync(vPath, 'utf8').trim(), 10) || 0
    }
  } catch { /* no version file */ }
  return 0
}

function setInstalledVersion(version: number): void {
  try {
    const vPath = getVersionPath()
    fs.mkdirSync(path.dirname(vPath), { recursive: true })
    fs.writeFileSync(vPath, String(version))
  } catch (err) {
    log(`linked-mode: failed to write version: ${err}`)
  }
}

// ---------- Public API ----------

export function isMcpInstalled(projectDir: string): boolean {
  const mcpJson = readMcpJson(projectDir)
  return !!mcpJson.mcpServers?.['claude-dock']
}

export function installMcp(projectDir: string): { success: boolean; error?: string } {
  try {
    // 1. Copy MCP server script into project (.claude/ directory)
    const src = getMcpServerSourcePath()
    const dest = getProjectMcpScriptPath(projectDir)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (!fs.existsSync(src)) {
      return { success: false, error: `MCP server source not found at ${src}` }
    }
    fs.copyFileSync(src, dest)
    log(`linked-mode: copied MCP server to ${dest}`)

    // 2. Add to project-level .mcp.json with relative path
    const mcpJson = readMcpJson(projectDir)
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {}
    mcpJson.mcpServers['claude-dock'] = {
      command: 'node',
      args: ['.claude/claude-dock-mcp.cjs']
    }
    writeMcpJson(projectDir, mcpJson)
    log(`linked-mode: added claude-dock to ${projectDir}/.mcp.json`)

    // 3. Clean stale entries from old install locations
    cleanLegacySettings(projectDir)

    // 4. Add CLAUDE.md instructions
    appendClaudeMd()

    // 5. Write dock config and version
    syncDockConfig({ messagingEnabled: false })
    setInstalledVersion(MCP_VERSION)

    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logError('linked-mode: install failed', err)
    return { success: false, error: msg }
  }
}

export function uninstallMcp(projectDir: string): { success: boolean; error?: string } {
  try {
    // 1. Remove from project-level .mcp.json
    const mcpJson = readMcpJson(projectDir)
    if (mcpJson.mcpServers?.['claude-dock']) {
      delete mcpJson.mcpServers['claude-dock']
      writeMcpJson(projectDir, mcpJson)
      log(`linked-mode: removed claude-dock from ${projectDir}/.mcp.json`)
    }

    // 1b. Clean legacy entries
    cleanLegacySettings(projectDir)

    // 2. Remove CLAUDE.md instructions
    removeClaudeMd()

    // 3. Delete project-local MCP server script (both .cjs and legacy .js)
    const projectScript = getProjectMcpScriptPath(projectDir)
    try { if (fs.existsSync(projectScript)) fs.unlinkSync(projectScript) } catch { /* ignore */ }
    const legacyProjectScript = path.join(projectDir, '.claude', 'claude-dock-mcp.js')
    try { if (fs.existsSync(legacyProjectScript)) fs.unlinkSync(legacyProjectScript) } catch { /* ignore */ }

    // 4. Delete runtime data files from AppData
    for (const file of [getLegacyMcpServerPath(), getDockConfigPath(), getVersionPath()]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* ignore */ }
    }
    // Clean messages file too
    try {
      const msgFile = path.join(getDataDir(), 'dock-messages.json')
      if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile)
    } catch { /* ignore */ }

    log(`linked-mode: deleted MCP files`)

    // 4. Disable linked mode for all open docks
    setLinkedEnabled(false)

    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    logError('linked-mode: uninstall failed', err)
    return { success: false, error: msg }
  }
}

export function setLinkedEnabled(enabled: boolean): void {
  const manager = DockManager.getInstance()
  for (const dock of manager.getAllDocks()) {
    if (enabled) {
      createLinkedFile(dock.projectDir)
    } else {
      removeLinkedFile(dock.projectDir)
    }
  }
  log(`linked-mode: ${enabled ? 'enabled' : 'disabled'} for ${manager.size} dock(s)`)
}

export function setMessagingEnabled(enabled: boolean): void {
  syncDockConfig({ messagingEnabled: enabled })
  log(`linked-mode: messaging ${enabled ? 'enabled' : 'disabled'}`)
}

/**
 * Run on app startup. Handles global migrations (CLAUDE.md, version tracking).
 */
export function migrateIfNeeded(): void {
  try {
    const installed = getInstalledVersion()
    if (installed === 0) return // MCP never installed
    if (installed >= MCP_VERSION) return // already up-to-date

    log(`linked-mode: global migration from v${installed} to v${MCP_VERSION}`)

    // Update CLAUDE.md block
    updateClaudeMd()

    // Ensure dock-config.json exists
    syncDockConfig()

    // Clean up legacy MCP script from AppData (moved to project in v3)
    const legacyScript = getLegacyMcpServerPath()
    try { if (fs.existsSync(legacyScript)) fs.unlinkSync(legacyScript) } catch { /* ignore */ }

    setInstalledVersion(MCP_VERSION)
    log('linked-mode: global migration complete')
  } catch (err) {
    logError('linked-mode: migration failed (non-fatal)', err)
  }
}

/**
 * Run when a dock opens. Migrates the project's .mcp.json from absolute paths
 * to relative paths, and ensures the MCP script is in the project directory.
 */
export function migrateProjectIfNeeded(projectDir: string): void {
  try {
    const mcpJson = readMcpJson(projectDir)
    const entry = mcpJson.mcpServers?.['claude-dock']
    if (!entry) return // MCP not installed for this project

    const args: string[] = entry.args || []
    const currentPath = args[0] || ''

    const isAlreadyCjs = currentPath === '.claude/claude-dock-mcp.cjs'

    if (isAlreadyCjs) {
      // Just ensure the script file is up-to-date
      const dest = getProjectMcpScriptPath(projectDir)
      const src = getMcpServerSourcePath()
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
      return
    }

    // Migrate from old .js path (relative or absolute) to .cjs
    log(`linked-mode: migrating project MCP to .cjs in ${projectDir}`)

    // Copy new .cjs script into project
    const src = getMcpServerSourcePath()
    const dest = getProjectMcpScriptPath(projectDir)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
    }

    // Clean up old .js script if it exists
    const oldScript = path.join(projectDir, '.claude', 'claude-dock-mcp.js')
    try { if (fs.existsSync(oldScript)) fs.unlinkSync(oldScript) } catch { /* ignore */ }

    // Update .mcp.json to use .cjs
    mcpJson.mcpServers['claude-dock'] = {
      command: 'node',
      args: ['.claude/claude-dock-mcp.cjs']
    }
    writeMcpJson(projectDir, mcpJson)
    log(`linked-mode: project migration complete for ${projectDir}`)
  } catch (err) {
    logError(`linked-mode: project migration failed for ${projectDir} (non-fatal)`, err)
  }
}
