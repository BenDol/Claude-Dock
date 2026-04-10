import type { IssueProvider } from './issue-provider'
import type { Issue } from '../../../../shared/issue-types'
import { IssueProviderRegistry } from './issue-provider-registry'
import { getServices } from '../services'

/**
 * Poll each project's open issues every 2 minutes. Emits notifications for:
 *   - issues newly assigned to the current user
 *   - comment-count deltas on issues the current user authored or is assigned to
 *
 * Note: issues change less frequently than CI runs, so we use a single 2-min
 * cadence — no active/idle distinction like CiManager.
 */

const POLL_MS = 2 * 60 * 1000

interface ProjectPolling {
  provider: IssueProvider
  projectDir: string
  timer: ReturnType<typeof setTimeout> | null
  cachedIssues: Map<number, Issue>
  ticking: boolean
  initialized: boolean
  currentUserLogin: string | null
}

function shortProviderName(providerKey: string): string {
  switch (providerKey) {
    case 'github': return 'GitHub'
    case 'gitlab': return 'GitLab'
    default: return providerKey.charAt(0).toUpperCase() + providerKey.slice(1)
  }
}

export class IssueManager {
  private projects = new Map<string, ProjectPolling>()

  async startPolling(projectDir: string): Promise<void> {
    if (this.projects.has(projectDir)) return
    getServices().log('[issue-manager] start polling', projectDir)

    const provider = await IssueProviderRegistry.getInstance().resolve(projectDir)
    if (!provider) {
      getServices().log('[issue-manager] no provider for', projectDir)
      return
    }

    let currentUserLogin: string | null = null
    try {
      const me = await provider.getCurrentUser(projectDir)
      currentUserLogin = me?.login ?? null
    } catch (err) {
      getServices().logError('[issue-manager] getCurrentUser failed:', err)
    }

    const entry: ProjectPolling = {
      provider,
      projectDir,
      timer: null,
      cachedIssues: new Map(),
      ticking: false,
      initialized: false,
      currentUserLogin
    }
    this.projects.set(projectDir, entry)
    this.tick(entry)
  }

  stopPolling(projectDir: string): void {
    const entry = this.projects.get(projectDir)
    if (!entry) return
    getServices().log('[issue-manager] stop polling', projectDir)
    if (entry.timer) clearTimeout(entry.timer)
    this.projects.delete(projectDir)
  }

  stopAll(): void {
    for (const dir of Array.from(this.projects.keys())) {
      this.stopPolling(dir)
    }
  }

  /** Called by IPC mutation handlers so the next tick refetches the specified issue. */
  invalidateIssue(projectDir: string, issueId: number): void {
    const entry = this.projects.get(projectDir)
    if (!entry) return
    entry.cachedIssues.delete(issueId)
  }

  private async tick(entry: ProjectPolling): Promise<void> {
    if (entry.ticking) return
    entry.ticking = true

    try {
      const issues = await entry.provider.listIssues(entry.projectDir, 'open')

      if (entry.initialized && this.notificationsEnabled(entry.projectDir)) {
        this.diffAndNotify(entry, issues)
      }

      entry.cachedIssues.clear()
      for (const issue of issues) entry.cachedIssues.set(issue.id, issue)
      entry.initialized = true
    } catch (err) {
      getServices().logError('[issue-manager] tick error:', err)
    }

    entry.ticking = false

    // Schedule next tick if still registered
    if (this.projects.has(entry.projectDir)) {
      entry.timer = setTimeout(() => this.tick(entry), POLL_MS)
    }
  }

  private notificationsEnabled(projectDir: string): boolean {
    const raw = getServices().getPluginSetting(projectDir, 'git-manager', 'enableIssueNotifications')
    // default true when unset
    return raw !== false
  }

  private diffAndNotify(entry: ProjectPolling, latest: Issue[]): void {
    const me = entry.currentUserLogin
    if (!me) return

    for (const issue of latest) {
      const prev = entry.cachedIssues.get(issue.id)

      const wasAssigned = prev ? prev.assignees.some((a) => a.login === me) : false
      const isAssigned = issue.assignees.some((a) => a.login === me)

      // New assignment to me
      if (!wasAssigned && isAssigned) {
        getServices().notify({
          title: 'Issue Assigned',
          message: `#${issue.id}: ${issue.title}`,
          type: 'info',
          source: 'git-manager',
          projectDir: entry.projectDir,
          action: issue.url
            ? { label: `View on ${shortProviderName(entry.provider.providerKey)}`, url: issue.url }
            : undefined,
          data: { issueId: issue.id, providerKey: entry.provider.providerKey },
          autoReadMs: 10 * 60 * 1000
        })
      }

      // Comment-count delta on issues I author or am assigned to
      if (prev && issue.commentsCount > prev.commentsCount) {
        const relevant = isAssigned || issue.author.login === me
        if (relevant) {
          const delta = issue.commentsCount - prev.commentsCount
          getServices().notify({
            title: 'New Issue Comment',
            message: `#${issue.id}: ${issue.title} (${delta} new comment${delta === 1 ? '' : 's'})`,
            type: 'info',
            source: 'git-manager',
            projectDir: entry.projectDir,
            action: issue.url
              ? { label: `View on ${shortProviderName(entry.provider.providerKey)}`, url: issue.url }
              : undefined,
            data: { issueId: issue.id, providerKey: entry.provider.providerKey },
            autoReadMs: 10 * 60 * 1000
          })
        }
      }
    }
  }
}
