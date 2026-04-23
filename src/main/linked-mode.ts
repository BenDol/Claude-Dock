import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { DockManager } from './dock-manager'
import { log, logError } from './logger'
import {
  ENV_PROFILE,
  getLinkedFileName,
  getMcpEntryName
} from '../shared/env-profile'

// Bump this when CLAUDE.md block or MCP server script changes.
// Migration will auto-update existing installs on startup.
// v6: install PostToolUse hook (`dock-worktree-hook.cjs`) into the project
// so the Dock auto-detects worktree switches from Bash/Task tool calls —
// no more relying on Claude to remember to call dock_notify_worktree.
const MCP_VERSION = 6

const LEGACY_LINKED_FILE = '.linked'
const LEGACY_MCP_ENTRY = 'claude-dock'
const LINKED_FILE = getLinkedFileName()
const MCP_ENTRY = getMcpEntryName()

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

**Worktree awareness:** When you \`cd\` into (or out of) a git worktree, the Dock auto-detects
the change via a PostToolUse hook and updates the terminal's worktree actions. The hook is
the primary mechanism — but as a backstop, if you know you've switched worktrees you can
call \`dock_notify_worktree\` explicitly with your \`session_id\` and the absolute
\`worktree_path\` (or \`null\` to clear). Invalid paths are silently dropped.

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

/**
 * Runtime data directory for MCP-shared state (activity, messages, shells, config,
 * version). Lives inside the per-profile userData so separate profiles don't
 * share — or corrupt — each other's dock state.
 */
export function getDataDir(): string {
  return path.join(app.getPath('userData'), 'dock-link')
}

/** Project-local MCP script path (shareable via git) */
function getProjectMcpScriptPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'claude-dock-mcp.cjs')
}

/** Project-local PostToolUse hook script path */
function getProjectHookScriptPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'dock-worktree-hook.cjs')
}

/** Project-local Claude Code settings file the hook registers into */
function getProjectClaudeSettingsPath(projectDir: string): string {
  // settings.local.json is user/machine-specific (not committed); hook paths
  // and absolute DOCK_DATA_DIR values are machine-local, so this is the
  // right bucket. settings.json would drag them into version control.
  return path.join(projectDir, '.claude', 'settings.local.json')
}

/** Legacy absolute path (AppData) — used for migration cleanup */
function getLegacyMcpServerPath(): string {
  return path.join(getDataDir(), 'claude-dock-mcp.js')
}

/**
 * Path that external processes (coordinator subprocess, user's Claude Code
 * terminals via project `.mcp.json`) spawn for the dock MCP server.
 *
 * In packaged builds, the primary location is `<install>/resources/
 * claude-dock-mcp.cjs` (shipped via electron-builder `extraResources`).
 * But NSIS upgrades have been observed to silently skip replacing
 * individual extraResources files — the user's installed copy can stay
 * frozen at the original install version while app.asar gets refreshed.
 *
 * Self-heal in the same shape as `ensureFallbackExtracted()` in the voice
 * plugin: electron-vite also copies the script into `out/main/bundled/`
 * (inside app.asar, which IS replaced atomically by NSIS), and this
 * function extracts it to a writable userData location whenever the
 * on-disk extraResources copy differs. Callers then run the fresh copy
 * regardless of what NSIS did.
 */
export function getMcpServerSourcePath(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'resources', 'claude-dock-mcp.cjs')
  }
  return ensureMcpScriptFresh()
}

/**
 * Extract `out/main/bundled/claude-dock-mcp.cjs` from inside app.asar to
 * `<userData>/mcp/claude-dock-mcp.cjs` when the extracted copy is missing
 * or doesn't match the asar-bundled bytes. Returns the userData path on
 * success, or falls back to the extraResources copy if extraction fails.
 *
 * Idempotent: the userData copy is fingerprinted against the asar-bundled
 * version via its byte length (cheaper than hashing and sufficient because
 * we control both sides of the comparison).
 */
function ensureMcpScriptFresh(): string {
  const packagedPath = path.join(process.resourcesPath, 'claude-dock-mcp.cjs')
  // `__dirname` in the main bundle is `<asar>/main`. The asar-bundled copy
  // lives at `<asar>/main/bundled/claude-dock-mcp.cjs` — see
  // copyMcpScriptPlugin in electron.vite.config.ts.
  const asarBundledPath = path.join(__dirname, 'bundled', 'claude-dock-mcp.cjs')
  const userDataPath = path.join(app.getPath('userData'), 'mcp', 'claude-dock-mcp.cjs')

  let asarStat: fs.Stats | null = null
  try { asarStat = fs.statSync(asarBundledPath) } catch { /* absent */ }
  if (!asarStat) {
    // Older builds without the copy plugin — fall back to the packaged path.
    // This also covers `electron-vite dev` runs when app.isPackaged is true
    // but the bundled/ dir wasn't produced.
    return packagedPath
  }

  try {
    const current = fs.existsSync(userDataPath) ? fs.statSync(userDataPath) : null
    if (!current || current.size !== asarStat.size) {
      fs.mkdirSync(path.dirname(userDataPath), { recursive: true })
      // `fs.copyFileSync` works transparently on asar-source paths — the
      // Electron fs shim intercepts the read. Avoids loading the whole
      // script into a JS buffer just to write it back out.
      fs.copyFileSync(asarBundledPath, userDataPath)
      log(
        `[linked-mode] self-healed MCP script: extracted ${asarStat.size}B ` +
        `from app.asar to ${userDataPath} (previous size: ${current?.size ?? 'missing'})`
      )
    }
    return userDataPath
  } catch (err) {
    logError('[linked-mode] MCP script self-heal extraction failed', err)
    return packagedPath
  }
}

/** Bundled hook source — ships alongside the MCP server via extraResources. */
export function getHookScriptSourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dock-worktree-hook.cjs')
  }
  return path.join(app.getAppPath(), 'resources', 'dock-worktree-hook.cjs')
}

/**
 * When the linked project IS the dock source repo itself, its own
 * `resources/claude-dock-mcp.cjs` is the authoritative copy — typically
 * newer than whatever the installed (stable) dock binary ships with.
 * Prefer it so opening the dock from a stable build doesn't revert the
 * in-progress MCP server edits back to the packaged version.
 */
function getProjectOwnMcpSourcePath(projectDir: string): string | null {
  const candidate = path.join(projectDir, 'resources', 'claude-dock-mcp.cjs')
  return fs.existsSync(candidate) ? candidate : null
}

/** Same self-hosting shortcut for the hook script. */
function getProjectOwnHookSourcePath(projectDir: string): string | null {
  const candidate = path.join(projectDir, 'resources', 'dock-worktree-hook.cjs')
  return fs.existsSync(candidate) ? candidate : null
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
    const linkedPath = path.join(projectDir, LINKED_FILE)
    fs.writeFileSync(linkedPath, `Claude Dock (${ENV_PROFILE}) linked mode active\n`)
    log(`linked-mode: created ${LINKED_FILE} in ${projectDir}`)
    // UAT also maintains the legacy unsuffixed .linked so any existing tools
    // or prompts that look for it keep working. Drop this once the legacy name
    // is fully retired.
    if (ENV_PROFILE === 'uat') {
      const legacyPath = path.join(projectDir, LEGACY_LINKED_FILE)
      try { fs.writeFileSync(legacyPath, 'Claude Dock linked mode active\n') } catch { /* non-fatal */ }
    }
  } catch (err) {
    logError(`linked-mode: failed to create ${LINKED_FILE}`, err)
  }
}

function removeLinkedFile(projectDir: string): void {
  const candidates = [path.join(projectDir, LINKED_FILE)]
  if (ENV_PROFILE === 'uat') candidates.push(path.join(projectDir, LEGACY_LINKED_FILE))
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p)
        log(`linked-mode: removed ${path.basename(p)} from ${projectDir}`)
      }
    } catch (err) {
      logError(`linked-mode: failed to remove ${path.basename(p)}`, err)
    }
  }
}

// ---------- Legacy cleanup ----------

/**
 * Claude Code remembers approved MCP servers in `.claude/settings.local.json`
 * under `enabledMcpjsonServers`. When we rename the legacy `claude-dock` entry
 * to the profile-suffixed `claude-dock-<profile>` we must rename the approval
 * too, otherwise Claude Code treats it as a brand-new MCP and re-prompts the
 * user. UAT only — prod/dev never inherit the legacy approval.
 */
function renameLegacyMcpApproval(projectDir: string): void {
  if (ENV_PROFILE !== 'uat') return
  try {
    const settingsPath = path.join(projectDir, '.claude', 'settings.local.json')
    if (!fs.existsSync(settingsPath)) return
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const list = raw.enabledMcpjsonServers
    if (!Array.isArray(list)) return
    const idx = list.indexOf(LEGACY_MCP_ENTRY)
    if (idx < 0) return
    if (list.includes(MCP_ENTRY)) {
      list.splice(idx, 1) // already approved under new name; just drop legacy
    } else {
      list[idx] = MCP_ENTRY
    }
    fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2))
    log(`linked-mode: renamed '${LEGACY_MCP_ENTRY}' → '${MCP_ENTRY}' in ${projectDir}/.claude/settings.local.json`)
  } catch (err) {
    log(`linked-mode: renameLegacyMcpApproval warning: ${err}`)
  }
}

function cleanLegacySettings(projectDir: string): void {
  const userDir = getUserClaudeDir()
  const staleKeys = [MCP_ENTRY, LEGACY_MCP_ENTRY]
  for (const file of ['settings.json', 'settings.local.json']) {
    try {
      const legacyPath = path.join(userDir, file)
      if (!fs.existsSync(legacyPath)) continue
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
      let changed = false
      for (const key of staleKeys) {
        if (raw.mcpServers?.[key]) {
          delete raw.mcpServers[key]
          changed = true
        }
      }
      if (changed) {
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
    let changed = false
    for (const key of staleKeys) {
      if (raw.mcpServers?.[key]) {
        delete raw.mcpServers[key]
        changed = true
      }
    }
    if (changed) {
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

// ---------- PostToolUse hook (worktree auto-detection) ----------

/**
 * The hook command we register into `.claude/settings.local.json`. Baking
 * DOCK_DATA_DIR in as argv[2] means the hook writes to the right profile's
 * inbox even when uat + prod are both linked to the same project.
 *
 * Use `node` on PATH rather than a fully-resolved binary: Claude Code users
 * already have node installed (the MCP server needs it), and baking an
 * absolute node path would break sharing the same project across machines.
 */
function buildHookCommand(dataDir: string): string {
  // Forward slashes work in both cmd.exe and bash; escape `"` via JSON quoting.
  const scriptArg = `.claude/dock-worktree-hook.cjs`
  const dataArg = dataDir.replace(/\\/g, '/')
  return `node ${JSON.stringify(scriptArg)} ${JSON.stringify(dataArg)}`
}

/** Recognizable substring so uninstall can find our hook entries. */
const HOOK_COMMAND_SIGNATURE = 'dock-worktree-hook.cjs'

/**
 * Merge our PostToolUse hook into the project's settings.local.json. Safe to
 * call repeatedly — duplicate entries (same command) are skipped. Preserves
 * all other hooks and settings.
 */
function installWorktreeHook(projectDir: string): void {
  const dest = getProjectHookScriptPath(projectDir)
  const src = getProjectOwnHookSourcePath(projectDir) ?? getHookScriptSourcePath()
  try {
    if (!fs.existsSync(src)) {
      log(`linked-mode: hook source missing at ${src} — skipping hook install`)
      return
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    log(`linked-mode: copied worktree hook to ${dest}`)
  } catch (err) {
    logError('linked-mode: failed to copy hook script', err)
    return
  }

  const settingsPath = getProjectClaudeSettingsPath(projectDir)
  let settings: Record<string, any> = {}
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8')
      settings = JSON.parse(raw) || {}
      if (typeof settings !== 'object' || Array.isArray(settings)) settings = {}
    }
  } catch (err) {
    logError(`linked-mode: failed to read ${settingsPath} (will overwrite with fresh hooks)`, err)
    settings = {}
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = []

  const desiredCommand = buildHookCommand(getDataDir())
  const desiredMatcher = 'Bash|Task'

  // Find (or create) the matcher block that owns our hook. We only manage
  // entries whose command string contains `dock-worktree-hook.cjs`, leaving
  // unrelated hooks alone.
  let block = settings.hooks.PostToolUse.find(
    (b: any) =>
      b &&
      b.matcher === desiredMatcher &&
      Array.isArray(b.hooks) &&
      b.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_COMMAND_SIGNATURE))
  )

  if (!block) {
    block = { matcher: desiredMatcher, hooks: [] }
    settings.hooks.PostToolUse.push(block)
  }
  if (!Array.isArray(block.hooks)) block.hooks = []

  // Replace any stale version of our hook (earlier data dir, etc.) with the
  // current command. Keeps the list exactly one entry per profile data dir.
  block.hooks = block.hooks.filter(
    (h: any) => !(typeof h?.command === 'string' && h.command.includes(HOOK_COMMAND_SIGNATURE) && h.command.includes(getDataDir().replace(/\\/g, '/')))
  )
  block.hooks.push({ type: 'command', command: desiredCommand })

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    log(`linked-mode: registered PostToolUse hook in ${settingsPath}`)
  } catch (err) {
    logError(`linked-mode: failed to write ${settingsPath}`, err)
  }
}

/**
 * Remove our hook command(s) from settings.local.json and delete the script.
 * Only affects entries whose command string contains `dock-worktree-hook.cjs`
 * — user-authored hooks are preserved.
 */
function uninstallWorktreeHook(projectDir: string): void {
  const settingsPath = getProjectClaudeSettingsPath(projectDir)
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8')
      const settings = JSON.parse(raw)
      const posts = settings?.hooks?.PostToolUse
      if (Array.isArray(posts)) {
        const dataDir = getDataDir().replace(/\\/g, '/')
        let changed = false
        for (const block of posts) {
          if (!block || !Array.isArray(block.hooks)) continue
          const before = block.hooks.length
          block.hooks = block.hooks.filter(
            (h: any) => !(
              typeof h?.command === 'string' &&
              h.command.includes(HOOK_COMMAND_SIGNATURE) &&
              // Only remove the entry for THIS profile's data dir. Sibling
              // profiles (prod when uat uninstalls) keep working.
              h.command.includes(dataDir)
            )
          )
          if (block.hooks.length !== before) changed = true
        }
        // Drop empty matcher blocks we own; leave user blocks intact even if empty.
        settings.hooks.PostToolUse = posts.filter(
          (b: any) => b && Array.isArray(b.hooks) && b.hooks.length > 0
        )
        // Prune empty containers.
        if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse
        if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks
        if (changed) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
          log(`linked-mode: removed PostToolUse hook from ${settingsPath}`)
        }
      }
    }
  } catch (err) {
    logError(`linked-mode: failed to clean hook from ${settingsPath}`, err)
  }

  // Delete the script itself only if no other profile still references it.
  // Simplest heuristic: if settings.local.json no longer mentions our hook,
  // remove the file. Other profiles re-install it on their next pass.
  try {
    const dest = getProjectHookScriptPath(projectDir)
    if (fs.existsSync(dest)) {
      let stillReferenced = false
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8')
        if (raw.includes(HOOK_COMMAND_SIGNATURE)) stillReferenced = true
      } catch { /* no settings file — safe to delete */ }
      if (!stillReferenced) {
        fs.unlinkSync(dest)
        log(`linked-mode: deleted hook script ${dest}`)
      }
    }
  } catch (err) {
    logError('linked-mode: failed to delete hook script', err)
  }
}

// ---------- Public API ----------

export function isMcpInstalled(projectDir: string): boolean {
  const mcpJson = readMcpJson(projectDir)
  // Consider installed if either the profile-suffixed entry or the legacy
  // unsuffixed entry (UAT upgrading from pre-profile build) is present.
  return !!(
    mcpJson.mcpServers?.[MCP_ENTRY] ||
    (ENV_PROFILE === 'uat' && mcpJson.mcpServers?.[LEGACY_MCP_ENTRY])
  )
}

export function installMcp(projectDir: string): { success: boolean; error?: string } {
  try {
    // 1. Copy MCP server script into project (.claude/ directory). Prefer
    //    the project's own resources/claude-dock-mcp.cjs when it exists —
    //    the dock source repo is self-hosting and its copy is authoritative.
    const src = getProjectOwnMcpSourcePath(projectDir) ?? getMcpServerSourcePath()
    const dest = getProjectMcpScriptPath(projectDir)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (!fs.existsSync(src)) {
      return { success: false, error: `MCP server source not found at ${src}` }
    }
    fs.copyFileSync(src, dest)
    log(`linked-mode: copied MCP server to ${dest}`)

    // 2. Add to project-level .mcp.json with profile-suffixed entry name.
    //    Multiple installed profiles (uat + prod) coexist as sibling entries.
    //    DOCK_DATA_DIR is an absolute path to this profile's dock-link dir so
    //    the MCP server writes/reads state in isolation from other profiles.
    const mcpJson = readMcpJson(projectDir)
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {}
    mcpJson.mcpServers[MCP_ENTRY] = {
      command: 'node',
      args: ['.claude/claude-dock-mcp.cjs'],
      env: { DOCK_DATA_DIR: getDataDir() }
    }
    // UAT upgrading from a pre-profile build: rename the old unsuffixed entry
    // so Claude Code picks up the new key on next launch without asking.
    if (ENV_PROFILE === 'uat' && mcpJson.mcpServers[LEGACY_MCP_ENTRY]) {
      delete mcpJson.mcpServers[LEGACY_MCP_ENTRY]
      log(`linked-mode: renamed legacy '${LEGACY_MCP_ENTRY}' → '${MCP_ENTRY}' in ${projectDir}/.mcp.json`)
    }
    writeMcpJson(projectDir, mcpJson)
    renameLegacyMcpApproval(projectDir)
    log(`linked-mode: added ${MCP_ENTRY} to ${projectDir}/.mcp.json`)

    // 3. Clean stale entries from old install locations
    cleanLegacySettings(projectDir)

    // 4. Add CLAUDE.md instructions
    appendClaudeMd()

    // 5. Install the PostToolUse worktree-detection hook. Copies the hook
    //    script into .claude/ and registers it in settings.local.json so
    //    cwd changes inside Claude Code auto-surface as worktree switches.
    installWorktreeHook(projectDir)

    // 6. Write dock config and version
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
    // 1. Remove from project-level .mcp.json (both profile entry + legacy name)
    const mcpJson = readMcpJson(projectDir)
    let removed = false
    for (const key of [MCP_ENTRY, LEGACY_MCP_ENTRY]) {
      if (mcpJson.mcpServers?.[key]) {
        delete mcpJson.mcpServers[key]
        removed = true
      }
    }
    if (removed) {
      writeMcpJson(projectDir, mcpJson)
      log(`linked-mode: removed ${MCP_ENTRY} from ${projectDir}/.mcp.json`)
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

    // 3b. Uninstall the PostToolUse worktree hook (removes our entry from
    //     settings.local.json and deletes the script if no profile still
    //     references it).
    uninstallWorktreeHook(projectDir)

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
    // v5: relocate dock-* state files into dock-link/ subfolder (UAT only, since
    // prod/dev never wrote to the old parent path). Run BEFORE reading the
    // installed version — the mcp-version marker itself may need relocating.
    migrateDataDirIfNeeded()

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
 * Pre-v5 the data dir was `%userData%` itself; v5 nests it under `dock-link/`.
 * Move existing dock-* state files so an upgraded UAT install doesn't lose
 * message history, shell state, or dock-config on first run.
 *
 * A separate bug between v5 and the data-dir fix meant the dock kept writing
 * these files at the legacy parent path long after the MCP moved to reading
 * from `dock-link/`. That left live data at the parent and 17-byte stale
 * placeholders inside `dock-link/`. The migration below picks the newer of the
 * two when both exist, so the fix doesn't silently drop accumulated state.
 */
function migrateDataDirIfNeeded(): void {
  if (ENV_PROFILE !== 'uat') return // only UAT could have legacy state at the parent
  const legacyParent = app.getPath('userData')
  const newDir = getDataDir()
  if (legacyParent === newDir) return
  const legacyFiles = [
    'dock-activity.json',
    'dock-config.json',
    'dock-messages.json',
    'dock-shell-commands.json',
    'dock-shell-output.json',
    'dock-pending-events.json',
    'dock-terminal-commands.json',
    'mcp-version'
  ]
  let moved = 0
  for (const name of legacyFiles) {
    const src = path.join(legacyParent, name)
    const dest = path.join(newDir, name)
    try {
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(newDir, { recursive: true })
      if (fs.existsSync(dest)) {
        // Both exist: pre-fix dock kept writing at the parent while the MCP
        // read from dock-link/. Promote the newer copy so we don't throw away
        // accumulated activity/output state on upgrade.
        const srcMtime = fs.statSync(src).mtimeMs
        const destMtime = fs.statSync(dest).mtimeMs
        if (srcMtime <= destMtime) {
          // Dock-link version is already newer or equal — remove the orphaned
          // parent copy so future writes (now going to dock-link/) don't get
          // confused by a shadow file at the old location.
          try { fs.unlinkSync(src) } catch { /* best-effort */ }
          continue
        }
        // Parent is newer — overwrite dock-link/.
        fs.copyFileSync(src, dest)
        try { fs.unlinkSync(src) } catch { /* best-effort */ }
      } else {
        fs.renameSync(src, dest)
      }
      moved++
    } catch (err) {
      logError(`linked-mode: failed to migrate ${name} into dock-link/`, err)
    }
  }
  if (moved > 0) log(`linked-mode: migrated ${moved} legacy dock-* file(s) into dock-link/`)
}

/**
 * Run when a dock opens. Migrates the project's .mcp.json from absolute paths
 * to relative paths, and ensures the MCP script is in the project directory.
 */
export function migrateProjectIfNeeded(projectDir: string): void {
  try {
    const mcpJson = readMcpJson(projectDir)
    const profileEntry = mcpJson.mcpServers?.[MCP_ENTRY]
    const legacyEntry = mcpJson.mcpServers?.[LEGACY_MCP_ENTRY]
    const entry = profileEntry || (ENV_PROFILE === 'uat' ? legacyEntry : undefined)
    if (!entry) return // MCP not installed for this project under this profile

    const args: string[] = entry.args || []
    const currentPath = args[0] || ''
    const isAlreadyCjs = currentPath === '.claude/claude-dock-mcp.cjs'
    const hasDataDirEnv = !!entry.env?.DOCK_DATA_DIR
    const correctDataDir = entry.env?.DOCK_DATA_DIR === getDataDir()
    const isOnProfileKey = !!profileEntry
    const needsRewrite =
      !isAlreadyCjs || !hasDataDirEnv || !correctDataDir || !isOnProfileKey

    // Keep the on-disk script up-to-date with the authoritative copy.
    // Dock-source-repo self-host: if the project has its own
    // resources/claude-dock-mcp.cjs, treat that as the source of truth so a
    // stable build opening this repo doesn't clobber in-progress MCP edits.
    const src = getProjectOwnMcpSourcePath(projectDir) ?? getMcpServerSourcePath()
    const dest = getProjectMcpScriptPath(projectDir)
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    }

    // Ensure the PostToolUse worktree hook is installed + up-to-date. Cheap
    // and idempotent — safe to run every dock-open migration pass.
    installWorktreeHook(projectDir)

    if (!needsRewrite) return

    log(`linked-mode: migrating project MCP entry in ${projectDir} → ${MCP_ENTRY}`)

    // Clean up old .js script if it exists
    const oldScript = path.join(projectDir, '.claude', 'claude-dock-mcp.js')
    try { if (fs.existsSync(oldScript)) fs.unlinkSync(oldScript) } catch { /* ignore */ }

    // Rewrite to canonical profile-suffixed form
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {}
    mcpJson.mcpServers[MCP_ENTRY] = {
      command: 'node',
      args: ['.claude/claude-dock-mcp.cjs'],
      env: { DOCK_DATA_DIR: getDataDir() }
    }
    // Drop the legacy unsuffixed key once we've taken ownership under the
    // profile-suffixed name. Only UAT does this — prod/dev should never touch
    // an unsuffixed entry (it belongs to UAT).
    if (ENV_PROFILE === 'uat' && legacyEntry) {
      delete mcpJson.mcpServers[LEGACY_MCP_ENTRY]
    }
    writeMcpJson(projectDir, mcpJson)
    renameLegacyMcpApproval(projectDir)
    log(`linked-mode: project migration complete for ${projectDir}`)
  } catch (err) {
    logError(`linked-mode: project migration failed for ${projectDir} (non-fatal)`, err)
  }
}
