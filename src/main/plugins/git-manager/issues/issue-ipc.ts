import { ipcMain } from 'electron'
import { IPC } from '../../../../shared/ipc-channels'
import { IssueProviderRegistry } from './issue-provider-registry'
import { IssueManager } from './issue-manager'
import { getServices } from '../services'
import {
  classifyIssue,
  describeBehavior,
  parseIssueProfiles,
  serializeIssueProfiles,
  getDefaultIssueProfiles
} from './issue-type-profiles'
import type {
  Issue,
  IssueState,
  IssueStateReason,
  IssueStatus,
  IssueCreateRequest,
  IssueUpdateRequest,
  IssueCommentPreview,
  IssueTypeProfiles
} from '../../../../shared/issue-types'
import type { IssueProvider } from './issue-provider'
import type { IssueFixTask, ClaudeTaskRequest } from '../../../../shared/claude-task-types'

const registry = IssueProviderRegistry.getInstance()

/**
 * Enrich raw issues from the provider with two pieces of metadata that
 * provider-native list/get calls don't always populate:
 *
 *   1. **Label colors** — GitLab returns labels as bare name strings on
 *      issues. We look them up in the repo-wide labels list (cached) so
 *      chips render with their configured color.
 *   2. **Native status** — GitLab work-item status / GitHub Projects v2
 *      Status field. Stored on a separate widget that requires a second
 *      round-trip; if the provider supports it, batch-fetch and merge.
 *
 * Both enrichments are best-effort: failures log and pass the issues
 * through unchanged so the UI never breaks because of a slow or
 * missing secondary call.
 */
async function enrichIssues(
  provider: IssueProvider,
  projectDir: string,
  issues: Issue[]
): Promise<Issue[]> {
  if (issues.length === 0) return issues

  const [labelColorMap, statusMap] = await Promise.all([
    enrichLabelColors(provider, projectDir, issues),
    enrichStatuses(provider, projectDir, issues)
  ])

  return issues.map((issue) => {
    let next = issue
    if (statusMap && statusMap.has(issue.id)) {
      next = { ...next, status: statusMap.get(issue.id) ?? null }
    }
    if (labelColorMap && next.labels.some((l) => !l.color)) {
      next = {
        ...next,
        labels: next.labels.map((l) =>
          l.color ? l : (labelColorMap.has(l.name) ? { ...l, color: labelColorMap.get(l.name) } : l)
        )
      }
    }
    return next
  })
}

async function enrichLabelColors(
  provider: IssueProvider,
  projectDir: string,
  issues: Issue[]
): Promise<Map<string, string | undefined> | null> {
  const needsColors = issues.some((i) => i.labels.some((l) => !l.color))
  if (!needsColors) return null
  try {
    const labels = await provider.listLabels(projectDir)
    const map = new Map<string, string | undefined>()
    for (const l of labels) map.set(l.name, l.color)
    return map
  } catch (err) {
    getServices().log('[issue-ipc] enrichLabelColors failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function enrichStatuses(
  provider: IssueProvider,
  projectDir: string,
  issues: Issue[]
): Promise<Map<number, IssueStatus | null> | null> {
  try {
    const cap = await provider.getStatusCapability(projectDir)
    if (!cap.supported) return null
    return await provider.fetchIssueStatuses(projectDir, issues.map((i) => i.id))
  } catch (err) {
    getServices().log('[issue-ipc] enrichStatuses failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

let issueManager: IssueManager | null = null
function getManager(): IssueManager {
  if (!issueManager) issueManager = new IssueManager()
  return issueManager
}

function sendTaskToDock(projectDir: string, task: ClaudeTaskRequest): boolean {
  return getServices().sendTaskToDock(projectDir, 'claude:task', task)
}

/** In-memory concurrent-run guard keyed by `${projectDir}:${issueId}`. */
const activeClaudeRuns = new Map<string, { startedAt: number }>()
const RUN_COOLDOWN_MS = 30 * 60 * 1000

function runKey(projectDir: string, issueId: number): string {
  return `${projectDir}:${issueId}`
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function hasAgentResolution(body: string): boolean {
  return /^##\s+Agent Resolution\b/m.test(body || '')
}

export function registerIssueIpc(): void {
  ipcMain.handle(IPC.ISSUE_CHECK_AVAILABLE, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] checkAvailable', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) return false
    try {
      const available = await provider.isAvailable(projectDir)
      return available ? provider.providerKey : false
    } catch (err) {
      getServices().logError('[issue-ipc] checkAvailable failed:', err)
      return false
    }
  })

  ipcMain.handle(IPC.ISSUE_GET_SETUP_STATUS, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] getSetupStatus', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) {
      return {
        ready: false,
        providerName: 'Unknown',
        steps: [{
          id: 'unsupported',
          label: 'Issue provider not supported',
          status: 'missing' as const,
          helpText: 'Issues are not available for this repository. Only GitHub and GitLab are supported.'
        }]
      }
    }
    try {
      return await provider.getSetupStatus(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] getSetupStatus failed:', err)
      return { ready: false, providerName: provider.name, steps: [] }
    }
  })

  ipcMain.handle(IPC.ISSUE_RUN_SETUP_ACTION, async (
    _event,
    projectDir: string,
    actionId: string,
    data?: Record<string, string>
  ) => {
    getServices().log('[issue-ipc] runSetupAction', projectDir, actionId)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider for this project' }
    try {
      return await provider.runSetupAction(projectDir, actionId, data)
    } catch (err) {
      getServices().logError('[issue-ipc] runSetupAction failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_LIST, async (_event, projectDir: string, state?: IssueState | 'all') => {
    getServices().log('[issue-ipc] list', projectDir, state)
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      const issues = await provider.listIssues(projectDir, state)
      return await enrichIssues(provider, projectDir, issues)
    } catch (err) {
      getServices().logError('[issue-ipc] list failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.ISSUE_GET, async (_event, projectDir: string, id: number) => {
    getServices().log('[issue-ipc] get', projectDir, id)
    const provider = await registry.resolve(projectDir)
    if (!provider) return null
    try {
      const issue = await provider.getIssue(projectDir, id)
      if (!issue) return null
      const [enriched] = await enrichIssues(provider, projectDir, [issue])
      return enriched
    } catch (err) {
      getServices().logError('[issue-ipc] get failed:', err)
      return null
    }
  })

  ipcMain.handle(IPC.ISSUE_CREATE, async (_event, projectDir: string, request: IssueCreateRequest) => {
    getServices().log('[issue-ipc] create', projectDir, request.title)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider for this project' }
    try {
      return await provider.createIssue(projectDir, request)
    } catch (err) {
      getServices().logError('[issue-ipc] create failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create issue' }
    }
  })

  ipcMain.handle(IPC.ISSUE_UPDATE, async (
    _event,
    projectDir: string,
    id: number,
    request: IssueUpdateRequest
  ) => {
    getServices().log('[issue-ipc] update', projectDir, id, Object.keys(request))
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider for this project' }
    try {
      const result = await provider.updateIssue(projectDir, id, request)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] update failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to update issue' }
    }
  })

  ipcMain.handle(IPC.ISSUE_SET_STATE, async (
    _event,
    projectDir: string,
    id: number,
    state: IssueState,
    reason?: IssueStateReason
  ) => {
    getServices().log('[issue-ipc] setState', projectDir, id, state, reason)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider for this project' }
    try {
      const result = await provider.setState(projectDir, id, state, reason)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] setState failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_ADD_LABEL, async (_event, projectDir: string, id: number, labels: string[]) => {
    getServices().log('[issue-ipc] addLabel', projectDir, id, labels)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider' }
    try {
      const result = await provider.addLabel(projectDir, id, labels)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] addLabel failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_REMOVE_LABEL, async (_event, projectDir: string, id: number, labels: string[]) => {
    getServices().log('[issue-ipc] removeLabel', projectDir, id, labels)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider' }
    try {
      const result = await provider.removeLabel(projectDir, id, labels)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] removeLabel failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_LIST_LABELS, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] listLabels', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      return await provider.listLabels(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] listLabels failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.ISSUE_ADD_ASSIGNEE, async (_event, projectDir: string, id: number, logins: string[]) => {
    getServices().log('[issue-ipc] addAssignee', projectDir, id, logins)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider' }
    try {
      const result = await provider.addAssignee(projectDir, id, logins)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] addAssignee failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_REMOVE_ASSIGNEE, async (_event, projectDir: string, id: number, logins: string[]) => {
    getServices().log('[issue-ipc] removeAssignee', projectDir, id, logins)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider' }
    try {
      const result = await provider.removeAssignee(projectDir, id, logins)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] removeAssignee failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_LIST_ASSIGNEES, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] listAssignees', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      return await provider.listAssignableUsers(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] listAssignees failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.ISSUE_LIST_MILESTONES, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] listMilestones', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      return await provider.listMilestones(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] listMilestones failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.ISSUE_SET_MILESTONE, async (
    _event,
    projectDir: string,
    id: number,
    milestone: number | string | null
  ) => {
    getServices().log('[issue-ipc] setMilestone', projectDir, id, milestone)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider' }
    try {
      const result = await provider.setMilestone(projectDir, id, milestone)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] setMilestone failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_LIST_COMMENTS, async (_event, projectDir: string, issueId: number) => {
    getServices().log('[issue-ipc] listComments', projectDir, issueId)
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      return await provider.listComments(projectDir, issueId)
    } catch (err) {
      getServices().logError('[issue-ipc] listComments failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.ISSUE_ADD_COMMENT, async (_event, projectDir: string, issueId: number, body: string) => {
    getServices().log('[issue-ipc] addComment', projectDir, issueId)
    const provider = await registry.resolve(projectDir)
    if (!provider) return null
    try {
      const result = await provider.addComment(projectDir, issueId, body)
      if (result) getManager().invalidateIssue(projectDir, issueId)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] addComment failed:', err)
      return null
    }
  })

  ipcMain.handle(IPC.ISSUE_UPDATE_COMMENT, async (
    _event,
    projectDir: string,
    issueId: number,
    commentId: number | string,
    body: string
  ) => {
    getServices().log('[issue-ipc] updateComment', projectDir, issueId, commentId)
    const provider = await registry.resolve(projectDir)
    if (!provider) return null
    try {
      return await provider.updateComment(projectDir, issueId, commentId, body)
    } catch (err) {
      getServices().logError('[issue-ipc] updateComment failed:', err)
      return null
    }
  })

  ipcMain.handle(IPC.ISSUE_DELETE_COMMENT, async (
    _event,
    projectDir: string,
    issueId: number,
    commentId: number | string
  ) => {
    getServices().log('[issue-ipc] deleteComment', projectDir, issueId, commentId)
    const provider = await registry.resolve(projectDir)
    if (!provider) return false
    try {
      return await provider.deleteComment(projectDir, issueId, commentId)
    } catch (err) {
      getServices().logError('[issue-ipc] deleteComment failed:', err)
      return false
    }
  })

  ipcMain.handle(IPC.ISSUE_STATUS_CAPABILITY, async (_event, projectDir: string, force?: boolean) => {
    getServices().log('[issue-ipc] statusCapability', projectDir, 'force=', !!force)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { supported: false, reason: 'No issue provider for this project' }
    try {
      return await provider.getStatusCapability(projectDir, !!force)
    } catch (err) {
      getServices().logError('[issue-ipc] statusCapability failed:', err)
      return { supported: false, reason: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_LIST_STATUSES, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] listStatuses', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      return await provider.listStatuses(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] listStatuses failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.ISSUE_FETCH_STATUSES, async (_event, projectDir: string, issueIds: number[]) => {
    getServices().log('[issue-ipc] fetchStatuses', projectDir, issueIds.length)
    const provider = await registry.resolve(projectDir)
    if (!provider) return {}
    try {
      const map = await provider.fetchIssueStatuses(projectDir, issueIds || [])
      // Serialize Map to plain object for IPC transport.
      const out: Record<string, unknown> = {}
      for (const [k, v] of map.entries()) out[String(k)] = v
      return out
    } catch (err) {
      getServices().logError('[issue-ipc] fetchStatuses failed:', err)
      return {}
    }
  })

  ipcMain.handle(IPC.ISSUE_SET_STATUS, async (
    _event,
    projectDir: string,
    id: number,
    statusId: string
  ) => {
    getServices().log('[issue-ipc] setStatus', projectDir, id, statusId)
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No issue provider for this project' }
    try {
      const result = await provider.setIssueStatus(projectDir, id, statusId)
      if (result.success) getManager().invalidateIssue(projectDir, id)
      return result
    } catch (err) {
      getServices().logError('[issue-ipc] setStatus failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  ipcMain.handle(IPC.ISSUE_GET_CURRENT_USER, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] getCurrentUser', projectDir)
    const provider = await registry.resolve(projectDir)
    if (!provider) return null
    try {
      return await provider.getCurrentUser(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] getCurrentUser failed:', err)
      return null
    }
  })

  ipcMain.handle(IPC.ISSUE_START_POLLING, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] startPolling', projectDir)
    try {
      await getManager().startPolling(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] startPolling failed:', err)
    }
  })

  ipcMain.handle(IPC.ISSUE_STOP_POLLING, async (_event, projectDir: string) => {
    getServices().log('[issue-ipc] stopPolling', projectDir)
    try {
      getManager().stopPolling(projectDir)
    } catch (err) {
      getServices().logError('[issue-ipc] stopPolling failed:', err)
    }
  })

  ipcMain.handle(IPC.ISSUE_GET_TYPE_PROFILES, async (_event, projectDir: string) => {
    try {
      const raw = getServices().getPluginSetting(projectDir, 'git-manager', 'issueTypeProfilesJson')
      return parseIssueProfiles(raw)
    } catch (err) {
      getServices().logError('[issue-ipc] getTypeProfiles failed:', err)
      return getDefaultIssueProfiles()
    }
  })

  ipcMain.handle(IPC.ISSUE_SET_TYPE_PROFILES, async (
    _event,
    _projectDir: string,
    profiles: IssueTypeProfiles
  ) => {
    // The renderer persists via the generic plugin:setSetting IPC — this handler
    // is here so a future feature could validate + persist server-side. For now
    // it just serializes to validate round-trip and returns the cleaned value.
    try {
      const str = serializeIssueProfiles(profiles)
      return { success: true, json: str }
    } catch (err) {
      getServices().logError('[issue-ipc] setTypeProfiles failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Invalid profiles' }
    }
  })

  ipcMain.handle(IPC.ISSUE_FIX_WITH_CLAUDE, async (
    _event,
    projectDir: string,
    data: { issueId: number; force?: boolean }
  ) => {
    getServices().log('[issue-ipc] fixWithClaude', projectDir, data.issueId, 'force=', !!data.force)
    const provider = await registry.resolve(projectDir)
    if (!provider) {
      return { success: false, error: 'No issue provider for this project' }
    }

    // Concurrent-run guard: within cooldown window unless explicitly forced.
    const key = runKey(projectDir, data.issueId)
    const existing = activeClaudeRuns.get(key)
    if (existing && !data.force) {
      const age = Date.now() - existing.startedAt
      if (age < RUN_COOLDOWN_MS) {
        return {
          success: false,
          alreadyRunning: true,
          startedAt: existing.startedAt,
          error: 'A Solve with Claude run is already in progress for this issue.'
        }
      }
      // Older than cooldown — allow reuse
      activeClaudeRuns.delete(key)
    }

    try {
      // Always re-fetch the canonical issue — don't trust renderer-supplied data.
      const issue = await provider.getIssue(projectDir, data.issueId)
      if (!issue) {
        return { success: false, error: 'Issue not found' }
      }

      // Load behavior profile
      const profilesJson = getServices().getPluginSetting(projectDir, 'git-manager', 'issueTypeProfilesJson')
      const profiles = parseIssueProfiles(profilesJson)
      const classification = classifyIssue(issue.labels, profiles)

      // Fetch up to 10 recent comments to give Claude conversational context
      let comments: IssueCommentPreview[] = []
      try {
        const all = await provider.listComments(projectDir, issue.id)
        const filtered = all.filter((c) => !c.isSystem).slice(-10)
        comments = filtered.map((c) => ({
          author: c.author.login,
          body: c.body.length > 1000 ? c.body.slice(0, 1000) + '…' : c.body,
          createdAt: c.createdAt
        }))
      } catch (err) {
        getServices().logError('[issue-ipc] fetch comments for fix failed:', err)
      }

      const defaultBranch = await provider.getDefaultBranch(projectDir)

      const task: IssueFixTask = {
        type: 'issue-fix',
        issueId: issue.id,
        issueTitle: issue.title,
        issueUrl: issue.url,
        issueBody: issue.body,
        issueState: issue.state,
        labels: issue.labels.map((l) => l.name),
        assignees: issue.assignees.map((a) => a.login),
        author: issue.author.login,
        commentsPreview: comments,
        provider: provider.providerKey,
        providerCli: provider.cli,
        selectedBehavior: classification.behavior,
        behaviorSource: classification.source,
        behaviorDescription: describeBehavior(classification.behavior),
        promptAddendum: classification.promptAddendum,
        defaultBranch,
        hasExistingAgentResolution: hasAgentResolution(issue.body),
        runId: cryptoRandomId()
      }

      getServices().log(
        '[issue-ipc] dispatching issue-fix',
        `issue=${issue.id}`,
        `behavior=${classification.behavior}`,
        `source=${classification.source}`,
        `runId=${task.runId}`
      )

      activeClaudeRuns.set(key, { startedAt: Date.now() })

      // Schedule automatic cleanup of the guard after cooldown
      setTimeout(() => {
        const entry = activeClaudeRuns.get(key)
        if (entry && Date.now() - entry.startedAt >= RUN_COOLDOWN_MS) {
          activeClaudeRuns.delete(key)
        }
      }, RUN_COOLDOWN_MS + 1000).unref?.()

      const sent = sendTaskToDock(projectDir, task)
      return { success: sent, runId: task.runId, behavior: classification.behavior, behaviorSource: classification.source }
    } catch (err) {
      getServices().logError('[issue-ipc] fixWithClaude failed:', err)
      activeClaudeRuns.delete(key)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to dispatch task' }
    }
  })

  getServices().log('[issue-ipc] IPC handlers registered')
}

export function disposeIssueIpc(): void {
  issueManager?.stopAll()
  issueManager = null
  activeClaudeRuns.clear()

  for (const [key, channel] of Object.entries(IPC)) {
    if (key.startsWith('ISSUE_')) {
      try { ipcMain.removeHandler(channel as string) } catch { /* ok */ }
    }
  }
}

export function stopIssuePollingForProject(projectDir: string): void {
  issueManager?.stopPolling(projectDir)
}
