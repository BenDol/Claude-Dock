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
  IssueState,
  IssueStateReason,
  IssueCreateRequest,
  IssueUpdateRequest,
  IssueCommentPreview,
  IssueTypeProfiles
} from '../../../../shared/issue-types'
import type { IssueFixTask, ClaudeTaskRequest } from '../../../../shared/claude-task-types'

const registry = IssueProviderRegistry.getInstance()

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
      return await provider.listIssues(projectDir, state)
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
      return await provider.getIssue(projectDir, id)
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
