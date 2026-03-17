import type { CiProvider } from './ci-provider'
import type { CiWorkflowRun } from '../../../../shared/ci-types'
import type { NotificationType } from '../../../../shared/ci-types'
import { CiProviderRegistry } from './ci-provider-registry'
import { getServices } from '../services'

const ACTIVE_POLL_MS = 10_000
const IDLE_POLL_MS = 60_000

const DEFAULT_NOTIFICATION_CATEGORIES = ['started', 'success', 'failure']

/** Short display name for "View on X" labels */
function shortProviderName(providerKey: string): string {
  switch (providerKey) {
    case 'github': return 'GitHub'
    case 'gitlab': return 'GitLab'
    case 'bitbucket': return 'Bitbucket'
    default: return providerKey.charAt(0).toUpperCase() + providerKey.slice(1)
  }
}

interface ProjectPolling {
  provider: CiProvider
  projectDir: string
  timer: ReturnType<typeof setTimeout> | null
  cachedRuns: Map<number, CiWorkflowRun>
  ticking: boolean
  initialized: boolean
}

export class CiManager {
  private projects = new Map<string, ProjectPolling>()

  async startPolling(projectDir: string): Promise<void> {
    if (this.projects.has(projectDir)) return
    getServices().log('[ci-manager] start polling', projectDir)

    const provider = await CiProviderRegistry.getInstance().resolve(projectDir)
    if (!provider) {
      getServices().log('[ci-manager] no provider for', projectDir)
      return
    }

    const entry: ProjectPolling = {
      provider,
      projectDir,
      timer: null,
      cachedRuns: new Map(),
      ticking: false,
      initialized: false
    }
    this.projects.set(projectDir, entry)
    this.tick(entry)
  }

  stopPolling(projectDir: string): void {
    const entry = this.projects.get(projectDir)
    if (!entry) return
    getServices().log('[ci-manager] stop polling', projectDir)
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

      // Detect transitions: previously active -> now completed.
      // A run may temporarily vanish from the active list between jobs
      // (e.g. "detect" finishes, "build" hasn't started yet). Verify the
      // run is actually completed before notifying.
      for (const [runId, prev] of entry.cachedRuns) {
        if (prev.status !== 'completed') {
          const stillActive = runs.find((r) => r.id === runId)
          if (!stillActive) {
            try {
              const actual = await entry.provider.getRun(entry.projectDir, runId)
              if (actual && actual.status === 'completed') {
                this.emitCompletionNotification(entry, actual)
              } else if (actual) {
                // Not actually done — keep it in the cache for the next tick
                runs.push(actual)
                hasActive = true
              }
            } catch {
              // Can't verify — assume completed to avoid stuck entries
              this.emitCompletionNotification(entry, prev)
            }
          }
        }
      }

      // Detect new runs (not in previous cache) — skip first poll to avoid
      // notifying about already-running jobs on startup
      if (entry.initialized) {
        for (const run of runs) {
          if (!entry.cachedRuns.has(run.id)) {
            this.emitStartedNotification(entry, run)
          }
        }
      }

      // Update cache: current active runs
      entry.cachedRuns.clear()
      for (const run of runs) {
        entry.cachedRuns.set(run.id, run)
      }
      entry.initialized = true
    } catch (err) {
      getServices().log('[ci-manager] tick error:', err)
    }

    entry.ticking = false

    // Schedule next tick if still registered
    if (this.projects.has(entry.projectDir)) {
      const interval = hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS
      entry.timer = setTimeout(() => this.tick(entry), interval)
    }
  }

  private emitStartedNotification(entry: ProjectPolling, run: CiWorkflowRun): void {
    const categories = getServices().getPluginSetting(entry.projectDir, 'git-manager', 'ciNotificationTypes') as string[] | undefined
    const enabledCategories = categories ?? DEFAULT_NOTIFICATION_CATEGORIES
    if (!enabledCategories.includes('started')) return

    getServices().notify({
      title: 'CI Run Started',
      message: `${run.name} #${run.runNumber} on ${run.headBranch}`,
      type: 'info',
      source: 'git-manager',
      projectDir: entry.projectDir,
      action: run.url ? { label: `View on ${shortProviderName(entry.provider.providerKey)}`, url: run.url } : undefined,
      data: { runId: run.id, providerKey: entry.provider.providerKey }
    })
  }

  private async emitCompletionNotification(entry: ProjectPolling, run: CiWorkflowRun): Promise<void> {
    const categories = getServices().getPluginSetting(entry.projectDir, 'git-manager', 'ciNotificationTypes') as string[] | undefined
    const enabledCategories = categories ?? DEFAULT_NOTIFICATION_CATEGORIES
    if (enabledCategories.length === 0) return

    // Fetch actual conclusion
    let conclusion: string | null = run.conclusion
    if (!conclusion) {
      try {
        const updated = await entry.provider.getRun(entry.projectDir, run.id)
        if (updated) conclusion = updated.conclusion
      } catch {
        getServices().log('[ci-manager] failed to fetch run conclusion for', run.id)
      }
    }

    // Map conclusion to category
    let category: string
    if (conclusion === 'success') category = 'success'
    else if (conclusion === 'failure') category = 'failure'
    else if (conclusion === 'cancelled') category = 'cancelled'
    else category = 'failure' // timed_out, action_required etc.

    if (!enabledCategories.includes(category)) return

    // Map to notification type
    let notifType: NotificationType
    let statusLabel: string
    if (conclusion === 'success') {
      notifType = 'success'
      statusLabel = 'succeeded'
    } else if (conclusion === 'failure') {
      notifType = 'error'
      statusLabel = 'failed'
    } else if (conclusion === 'cancelled') {
      notifType = 'warning'
      statusLabel = 'was cancelled'
    } else {
      notifType = 'error'
      statusLabel = conclusion ? conclusion : 'completed'
    }

    // For failures, fetch job details to include failure context
    let failureContext: Record<string, unknown> | undefined
    if (conclusion === 'failure') {
      try {
        const jobs = await entry.provider.getRunJobs(entry.projectDir, run.id)
        const failedJobs = jobs.filter((j) => j.conclusion === 'failure')
        const failedJobSummaries = failedJobs.map((j) => {
          const failedSteps = j.steps.filter((s) => s.conclusion === 'failure')
          return {
            id: j.id,
            name: j.name,
            failedSteps: failedSteps.map((s) => s.name)
          }
        })
        if (failedJobSummaries.length > 0) {
          failureContext = {
            failedJobs: failedJobSummaries,
            // Store the first failed job ID for log fetching
            primaryFailedJobId: failedJobSummaries[0].id
          }
        }
      } catch (err) {
        getServices().log('[ci-manager] failed to fetch job details for failure context:', err)
      }
    }

    const viewAction = run.url ? { label: `View on ${shortProviderName(entry.provider.providerKey)}`, url: run.url } : undefined
    const actions = conclusion === 'failure' && failureContext
      ? [
          ...(viewAction ? [viewAction] : []),
          { label: 'Fix with Claude', event: 'ci-fix-with-claude' }
        ]
      : undefined

    getServices().notify({
      title: `CI Run ${conclusion === 'success' ? 'Passed' : conclusion === 'failure' ? 'Failed' : conclusion === 'cancelled' ? 'Cancelled' : 'Completed'}`,
      message: `${run.name} #${run.runNumber} on ${run.headBranch} ${statusLabel}`,
      type: notifType,
      source: 'git-manager',
      projectDir: entry.projectDir,
      action: actions ? undefined : viewAction,
      actions,
      data: {
        runId: run.id,
        runName: run.name,
        runNumber: run.runNumber,
        headBranch: run.headBranch,
        providerKey: entry.provider.providerKey,
        ...(failureContext || {})
      }
    })
  }
}
