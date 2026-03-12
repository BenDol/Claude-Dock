import type { CiProvider } from './ci-provider'
import type { CiWorkflowRun } from '../../../../shared/ci-types'
import { NotificationManager } from '../../../notification-manager'
import { getPluginSetting } from '../../plugin-store'
import { log } from '../../../logger'

const ACTIVE_POLL_MS = 10_000
const IDLE_POLL_MS = 60_000

interface ProjectPolling {
  provider: CiProvider
  projectDir: string
  timer: ReturnType<typeof setTimeout> | null
  cachedRuns: Map<number, CiWorkflowRun>
  ticking: boolean
}

export class CiManager {
  private projects = new Map<string, ProjectPolling>()

  constructor(private provider: CiProvider) {}

  startPolling(projectDir: string): void {
    if (this.projects.has(projectDir)) return
    log('[ci-manager] start polling', projectDir)

    const entry: ProjectPolling = {
      provider: this.provider,
      projectDir,
      timer: null,
      cachedRuns: new Map(),
      ticking: false
    }
    this.projects.set(projectDir, entry)
    this.tick(entry)
  }

  stopPolling(projectDir: string): void {
    const entry = this.projects.get(projectDir)
    if (!entry) return
    log('[ci-manager] stop polling', projectDir)
    if (entry.timer) clearTimeout(entry.timer)
    this.projects.delete(projectDir)
  }

  stopAll(): void {
    for (const [dir] of this.projects) {
      this.stopPolling(dir)
    }
  }

  private async tick(entry: ProjectPolling): Promise<void> {
    if (entry.ticking) return
    entry.ticking = true

    let hasActive = false
    try {
      const runs = await entry.provider.getActiveRuns(entry.projectDir)
      hasActive = runs.length > 0

      // Detect transitions: previously active -> now completed
      for (const [runId, prev] of entry.cachedRuns) {
        if (prev.status !== 'completed') {
          // See if this run is no longer in active list
          const stillActive = runs.find((r) => r.id === runId)
          if (!stillActive) {
            // Run completed — notify
            this.emitCompletionNotification(entry.projectDir, prev)
          }
        }
      }

      // Update cache: current active runs
      entry.cachedRuns.clear()
      for (const run of runs) {
        entry.cachedRuns.set(run.id, run)
      }
    } catch (err) {
      log('[ci-manager] tick error:', err)
    }

    entry.ticking = false

    // Schedule next tick if still registered
    if (this.projects.has(entry.projectDir)) {
      const interval = hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS
      entry.timer = setTimeout(() => this.tick(entry), interval)
    }
  }

  private emitCompletionNotification(projectDir: string, run: CiWorkflowRun): void {
    const showNotifications = getPluginSetting(projectDir, 'git-manager', 'showActionNotifications')
    if (showNotifications === false) return

    // We don't have the final conclusion from the active runs list since it disappeared.
    // We know it completed. Default to info; if we had cached conclusion we'd use it.
    const nm = NotificationManager.getInstance()
    nm.notify({
      title: 'CI Run Completed',
      message: `${run.name} #${run.runNumber} on ${run.headBranch} finished`,
      type: 'info',
      source: 'ci',
      action: run.url ? { label: 'View on GitHub', url: run.url } : undefined
    })
  }
}
