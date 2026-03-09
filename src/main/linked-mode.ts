import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { DockManager } from './dock-manager'
import { log, logError } from './logger'

const CLAUDE_MD_START = '<!-- claude-dock-start -->'
const CLAUDE_MD_END = '<!-- claude-dock-end -->'

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
# Dock Link
If the file \`.linked\` exists in the project root, call the \`dock_status\` MCP tool
(pass \`project_dir\` with the absolute path to the project root) before starting your
task to see what other terminals are working on. This helps coordinate work and avoid
conflicts. If the tool is unavailable or errors, proceed normally — do not retry.
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

function getMcpServerDestDir(): string {
  return path.join(app.getPath('userData').replace(/claude-dock$/, ''), 'claude-dock')
}

function getMcpServerDestPath(): string {
  return path.join(getMcpServerDestDir(), 'claude-dock-mcp.js')
}

function getMcpServerSourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'claude-dock-mcp.js')
  }
  return path.join(app.getAppPath(), 'resources', 'claude-dock-mcp.js')
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

/** Remove claude-dock entries from old install locations */
function cleanLegacySettings(projectDir: string): void {
  // Clean user-level ~/.claude/ files
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
  // Clean project-level .claude/settings.local.json
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

// ---------- Public API ----------

export function isMcpInstalled(projectDir: string): boolean {
  const mcpJson = readMcpJson(projectDir)
  return !!mcpJson.mcpServers?.['claude-dock']
}

export function installMcp(projectDir: string): { success: boolean; error?: string } {
  try {
    // 1. Copy MCP server script
    const src = getMcpServerSourcePath()
    const dest = getMcpServerDestPath()
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (!fs.existsSync(src)) {
      return { success: false, error: `MCP server source not found at ${src}` }
    }
    fs.copyFileSync(src, dest)
    log(`linked-mode: copied MCP server to ${dest}`)

    // 2. Add to project-level .mcp.json
    const mcpJson = readMcpJson(projectDir)
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {}
    mcpJson.mcpServers['claude-dock'] = {
      command: 'node',
      args: [dest.replace(/\\/g, '/')]
    }
    writeMcpJson(projectDir, mcpJson)
    log(`linked-mode: added claude-dock to ${projectDir}/.mcp.json`)

    // 3. Clean stale entries from old install locations
    cleanLegacySettings(projectDir)

    // 4. Add CLAUDE.md instructions
    appendClaudeMd()

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

    // 3. Delete MCP server file
    const dest = getMcpServerDestPath()
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest)
      log(`linked-mode: deleted ${dest}`)
    }

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
