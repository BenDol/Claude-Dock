import { execFile } from 'child_process'
import { dialog } from 'electron'
import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { getPluginSetting, setPluginSetting } from '../plugin-store'
import { log, logError } from '../../logger'

interface ChangesInfo {
  hasChanges: boolean
  behindCount: number
  branch: string
  submoduleChanges: string[]
}

function gitExec(cwd: string, args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    await gitExec(projectDir, ['rev-parse', '--is-inside-work-tree'], 5000)
    return true
  } catch {
    return false
  }
}

async function detectChanges(projectDir: string): Promise<ChangesInfo> {
  const result: ChangesInfo = {
    hasChanges: false,
    behindCount: 0,
    branch: 'unknown',
    submoduleChanges: []
  }

  try {
    // Get current branch
    const { stdout: branchOut } = await gitExec(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
    result.branch = branchOut.trim() || 'unknown'

    // Fetch all remotes
    await gitExec(projectDir, ['fetch', '--all', '--quiet'], 15000)

    // Check if behind upstream
    try {
      const { stdout: countOut } = await gitExec(
        projectDir,
        ['rev-list', 'HEAD..@{upstream}', '--count'],
        5000
      )
      result.behindCount = parseInt(countOut.trim(), 10) || 0
    } catch {
      // No upstream configured — not behind
    }

    // Check submodule status
    try {
      const { stdout: subOut } = await gitExec(
        projectDir,
        ['submodule', 'status', '--recursive'],
        10000
      )
      for (const line of subOut.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Lines starting with + or - indicate changes
        if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
          // Extract submodule name (format: "+<hash> <path> (<desc>)" or "-<hash> <path>")
          const parts = trimmed.slice(1).trim().split(/\s+/)
          if (parts[1]) {
            result.submoduleChanges.push(parts[1])
          }
        }
      }
    } catch {
      // No submodules or error — that's fine
    }

    result.hasChanges = result.behindCount > 0 || result.submoduleChanges.length > 0
  } catch (err) {
    logError('[git-sync] detectChanges failed:', err)
  }

  return result
}

export class GitSyncPlugin implements DockPlugin {
  readonly id = 'git-sync'
  readonly name = 'Git Sync'
  readonly description = 'Pull remote changes when opening a project'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly settingsSchema: PluginSettingDef[] = [
    {
      key: 'syncSubmodules',
      label: 'Sync submodules',
      description: 'Also pull and update submodules when syncing',
      type: 'boolean',
      defaultValue: false
    }
  ]

  register(bus: PluginEventBus): void {
    bus.on('project:preOpen', this.id, async ({ projectDir, dock }) => {
      await this.handleProjectOpen(projectDir, dock)
    })
  }

  private async handleProjectOpen(projectDir: string, dock: import('../../dock-window').DockWindow): Promise<void> {
    // 1. Check if git repo
    if (!await isGitRepo(projectDir)) return

    // 2. Detect changes
    log(`[git-sync] checking for remote changes in ${projectDir}`)
    const changes = await detectChanges(projectDir)
    if (!changes.hasChanges) {
      log('[git-sync] no remote changes detected')
      return
    }

    // 3. Load saved submodule preference
    const savedSyncSub = getPluginSetting(projectDir, this.id, 'syncSubmodules') as boolean ?? false

    // 4. Build dialog message
    const details: string[] = []
    if (changes.behindCount > 0) {
      details.push(`${changes.behindCount} new commit(s) on ${changes.branch}`)
    }
    if (changes.submoduleChanges.length > 0) {
      details.push(`${changes.submoduleChanges.length} submodule(s) have updates: ${changes.submoduleChanges.join(', ')}`)
    }

    // 5. Show confirmation dialog
    log(`[git-sync] changes detected: ${details.join('; ')}`)
    const { response, checkboxChecked } = await dialog.showMessageBox(dock.window, {
      type: 'question',
      title: 'Git Sync',
      message: 'Remote changes detected',
      detail: details.join('\n'),
      checkboxLabel: 'Also sync and update submodules',
      checkboxChecked: savedSyncSub,
      buttons: ['Pull & Rebase', 'Skip'],
      defaultId: 0,
      cancelId: 1
    })

    if (response !== 0) {
      log('[git-sync] user skipped sync')
      return
    }

    // 6. Save checkbox preference
    if (checkboxChecked !== savedSyncSub) {
      setPluginSetting(projectDir, this.id, 'syncSubmodules', checkboxChecked)
    }

    // 7. Pull with rebase and autostash
    try {
      log('[git-sync] running git pull --rebase --autostash')
      const { stdout, stderr } = await gitExec(projectDir, ['pull', '--rebase', '--autostash'], 60000)
      if (stdout.trim()) log(`[git-sync] pull output: ${stdout.trim()}`)
      if (stderr.trim()) log(`[git-sync] pull stderr: ${stderr.trim()}`)
    } catch (err) {
      logError('[git-sync] git pull failed:', err)
      dialog.showMessageBox(dock.window, {
        type: 'error',
        title: 'Git Sync',
        message: 'Pull failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
        buttons: ['OK']
      })
      return
    }

    // 8. Sync submodules if requested
    if (checkboxChecked) {
      try {
        log('[git-sync] running git submodule update --init --recursive')
        await gitExec(projectDir, ['submodule', 'update', '--init', '--recursive'], 120000)
        log('[git-sync] submodule update complete')
      } catch (err) {
        logError('[git-sync] submodule update failed:', err)
        dialog.showMessageBox(dock.window, {
          type: 'warning',
          title: 'Git Sync',
          message: 'Submodule update failed',
          detail: err instanceof Error ? err.message : 'Unknown error',
          buttons: ['OK']
        })
      }
    }

    log('[git-sync] sync complete')
  }
}
