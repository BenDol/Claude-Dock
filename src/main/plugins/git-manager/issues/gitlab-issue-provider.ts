import { execFile, execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import type { IssueProvider } from './issue-provider'
import type {
  Issue,
  IssueState,
  IssueCreateRequest,
  IssueUpdateRequest,
  IssueActionResult,
  IssueComment,
  IssueLabel,
  IssueUser,
  IssueMilestone,
  IssueStateReason
} from '../../../../shared/issue-types'
import type { CiSetupStatus } from '../../../../shared/ci-types'
import { getServices } from '../services'

const execFileAsync = promisify(execFile)

let glabPath: string | null = null

function resolveGlab(): string {
  if (glabPath) return glabPath
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(cmd, ['glab'], { timeout: 5000, encoding: 'utf-8' }).trim().split('\n')[0].trim()
    if (result) { glabPath = result; return glabPath }
  } catch { /* not in PATH */ }

  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\glab\\glab.exe', 'C:\\Program Files (x86)\\glab\\glab.exe']
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/glab', '/usr/local/bin/glab']
      : ['/usr/bin/glab', '/usr/local/bin/glab', '/snap/bin/glab']
  for (const p of candidates) {
    if (existsSync(p)) { glabPath = p; return glabPath }
  }
  glabPath = 'glab'
  return glabPath
}

function glab(args: string[], cwd: string, opts?: { input?: string }): Promise<{ stdout: string; stderr: string }> {
  const child = execFileAsync(resolveGlab(), args, { cwd, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 })
  if (opts?.input !== undefined) {
    // @ts-ignore — child exposes stdin at runtime
    child.child.stdin?.end(opts.input)
  }
  return child
}

// --- Long-body temp-file helpers ---------------------------------------------

const BODY_TMP_DIR = path.join(os.tmpdir(), 'claude-dock-issue-bodies')

function ensureTmpDir(): void {
  try { mkdirSync(BODY_TMP_DIR, { recursive: true }) } catch (err) {
    getServices().logError('[issue-gitlab] ensureTmpDir failed:', err)
  }
}

function writeBodyFile(key: string | number, body: string): string {
  ensureTmpDir()
  const file = path.join(BODY_TMP_DIR, `gl-issue-${key}-${Date.now()}.md`)
  writeFileSync(file, body, 'utf-8')
  return file
}

function deleteBodyFile(file: string): void {
  try { unlinkSync(file) } catch { /* best-effort */ }
}

// --- Normalized mappers -------------------------------------------------------

function mapUser(raw: unknown): IssueUser {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    login: (r.username as string) || (r.name as string) || '',
    name: (r.name as string) || undefined,
    avatarUrl: (r.avatar_url as string) || (r.avatarUrl as string) || undefined
  }
}

function mapLabelFromString(name: string): IssueLabel {
  return { name }
}

function mapLabelDetail(raw: unknown): IssueLabel {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    name: (r.name as string) || '',
    color: (r.color as string)?.replace(/^#/, '') || undefined,
    description: (r.description as string) || undefined
  }
}

function mapMilestone(raw: unknown): IssueMilestone | null {
  if (!raw) return null
  const r = raw as Record<string, unknown>
  if (!r.title && !r.id && !r.iid) return null
  return {
    id: (r.iid as number) ?? (r.id as number) ?? '',
    title: (r.title as string) || '',
    state: (r.state as string) === 'closed' ? 'closed' : 'open',
    dueOn: (r.due_date as string) || (r.dueOn as string) || null
  }
}

function mapIssue(raw: Record<string, unknown>): Issue {
  const stateRaw = ((raw.state as string) || '').toLowerCase()
  const labelsRaw = (raw.labels as unknown[]) || []
  const labels: IssueLabel[] = labelsRaw.map((l) => {
    if (typeof l === 'string') return mapLabelFromString(l)
    return mapLabelDetail(l)
  })
  return {
    id: (raw.iid as number) || 0,
    title: (raw.title as string) || '',
    body: (raw.description as string) || '',
    state: stateRaw === 'closed' ? 'closed' : 'open',
    stateReason: null,
    author: mapUser(raw.author),
    assignees: ((raw.assignees as unknown[]) || []).map(mapUser),
    labels,
    milestone: mapMilestone(raw.milestone),
    commentsCount: (raw.user_notes_count as number) || 0,
    createdAt: (raw.created_at as string) || '',
    updatedAt: (raw.updated_at as string) || '',
    closedAt: (raw.closed_at as string) || null,
    url: (raw.web_url as string) || '',
    locked: !!(raw.discussion_locked)
  }
}

function mapNote(raw: Record<string, unknown>, currentUserLogin: string | null): IssueComment {
  const author = (raw.author as Record<string, unknown>) || {}
  const login = (author.username as string) || ''
  return {
    id: (raw.id as number) || 0,
    author: {
      login,
      name: (author.name as string) || undefined,
      avatarUrl: (author.avatar_url as string) || undefined
    },
    body: (raw.body as string) || '',
    createdAt: (raw.created_at as string) || '',
    updatedAt: (raw.updated_at as string) || '',
    isAuthor: !!currentUserLogin && currentUserLogin === login,
    isSystem: !!(raw.system)
  }
}

// --- Cache --------------------------------------------------------------------

interface CacheEntry<T> { at: number; data: T }
const META_TTL_MS = 5 * 60 * 1000

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > META_TTL_MS) {
    map.delete(key)
    return null
  }
  return hit.data
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, data: T): void {
  map.set(key, { at: Date.now(), data })
}

// --- Provider -----------------------------------------------------------------

export class GitLabIssueProvider implements IssueProvider {
  readonly name = 'GitLab Issues'
  readonly providerKey = 'gitlab' as const
  readonly cli = 'glab' as const

  private labelsCache = new Map<string, CacheEntry<IssueLabel[]>>()
  private assigneesCache = new Map<string, CacheEntry<IssueUser[]>>()
  private milestonesCache = new Map<string, CacheEntry<IssueMilestone[]>>()
  private currentUserCache = new Map<string, CacheEntry<IssueUser | null>>()
  private projectPathCache = new Map<string, CacheEntry<string>>()

  async isAvailable(projectDir: string): Promise<boolean> {
    try {
      await execFileAsync(resolveGlab(), ['auth', 'status'], { timeout: 10_000 })
      await glab(['repo', 'view'], projectDir)
      return true
    } catch {
      return false
    }
  }

  async getSetupStatus(projectDir: string): Promise<CiSetupStatus> {
    const steps: CiSetupStatus['steps'] = []

    let cliInstalled = false
    try { await execFileAsync(resolveGlab(), ['--version'], { timeout: 5000 }); cliInstalled = true } catch { /* */ }
    steps.push({
      id: 'cli-installed',
      label: 'GitLab CLI (glab) installed',
      status: cliInstalled ? 'ok' : 'missing',
      helpText: 'The glab CLI is required for issue support.',
      helpUrl: 'https://gitlab.com/gitlab-org/cli#installation'
    })

    let authenticated = false
    if (cliInstalled) {
      try { await execFileAsync(resolveGlab(), ['auth', 'status'], { timeout: 10_000 }); authenticated = true } catch { /* */ }
    }
    steps.push({
      id: 'cli-authenticated',
      label: 'Authenticated with GitLab',
      status: !cliInstalled ? 'missing' : authenticated ? 'ok' : 'missing',
      helpText: 'Sign in via: glab auth login',
      actionId: 'auth-login',
      actionLabel: 'Run glab auth login'
    })

    let hasRemote = false
    if (authenticated) {
      try { await glab(['repo', 'view'], projectDir); hasRemote = true } catch { /* */ }
    }
    steps.push({
      id: 'remote-configured',
      label: 'GitLab remote configured',
      status: !authenticated ? 'missing' : hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a GitLab remote.'
    })

    return { ready: cliInstalled && authenticated && hasRemote, providerName: this.name, steps }
  }

  async runSetupAction(
    _projectDir: string,
    actionId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (actionId !== 'auth-login') return { success: false, error: 'Unknown action' }
    try {
      const bin = resolveGlab()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${bin}" auth login`], {
          stdio: 'ignore', detached: true, windowsHide: false
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', `${bin} auth login`], {
          stdio: 'ignore', detached: true
        }).unref()
      } else {
        spawn('x-terminal-emulator', ['-e', bin, 'auth', 'login'], {
          stdio: 'ignore', detached: true
        }).unref()
      }
      return { success: true }
    } catch (err) {
      getServices().logError('[issue-gitlab] runSetupAction failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  }

  /** Resolve the URL-encoded project path (e.g. group%2Fsub%2Fproject) used in glab api calls. */
  private async getProjectPath(projectDir: string): Promise<string | null> {
    const cached = cacheGet(this.projectPathCache, projectDir)
    if (cached) return cached
    try {
      const { stdout } = await glab(['repo', 'view', '--output', 'json'], projectDir)
      const repo = JSON.parse(stdout) as Record<string, unknown>
      // glab repo view exposes path_with_namespace (e.g. "group/subgroup/project")
      const path = (repo.path_with_namespace as string) || (repo.fullPath as string) || ''
      if (!path) return null
      const encoded = encodeURIComponent(path)
      cacheSet(this.projectPathCache, projectDir, encoded)
      return encoded
    } catch (err) {
      getServices().logError('[issue-gitlab] getProjectPath failed:', err)
      return null
    }
  }

  async listIssues(projectDir: string, state?: IssueState | 'all'): Promise<Issue[]> {
    getServices().log('[issue-gitlab] listIssues', projectDir, state)
    try {
      const args = ['issue', 'list', '--output', 'json', '--per-page', '100']
      if (state === 'closed') args.push('--closed')
      else if (state === 'all') args.push('--all')
      // glab defaults to open issues when --closed is not used, so no flag needed for 'open'
      const { stdout } = await glab(args, projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      return (raw || []).map(mapIssue)
    } catch (err) {
      getServices().logError('[issue-gitlab] listIssues failed:', err)
      return []
    }
  }

  async getIssue(projectDir: string, id: number): Promise<Issue | null> {
    getServices().log('[issue-gitlab] getIssue', projectDir, id)
    try {
      const { stdout } = await glab(['issue', 'view', String(id), '--output', 'json'], projectDir)
      return mapIssue(JSON.parse(stdout))
    } catch (err) {
      getServices().logError('[issue-gitlab] getIssue failed:', err)
      return null
    }
  }

  async listComments(projectDir: string, issueId: number): Promise<IssueComment[]> {
    getServices().log('[issue-gitlab] listComments', projectDir, issueId)
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return []
      const { stdout } = await glab(
        ['api', `projects/${pp}/issues/${issueId}/notes?per_page=100&sort=asc`],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const me = await this.getCurrentUser(projectDir)
      return (raw || []).map((n) => mapNote(n, me?.login ?? null))
    } catch (err) {
      getServices().logError('[issue-gitlab] listComments failed:', err)
      return []
    }
  }

  async listLabels(projectDir: string): Promise<IssueLabel[]> {
    const cached = cacheGet(this.labelsCache, projectDir)
    if (cached) return cached
    try {
      const { stdout } = await glab(['label', 'list', '--output', 'json'], projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const labels = (raw || []).map(mapLabelDetail)
      cacheSet(this.labelsCache, projectDir, labels)
      return labels
    } catch (err) {
      getServices().logError('[issue-gitlab] listLabels failed:', err)
      return []
    }
  }

  async listAssignableUsers(projectDir: string): Promise<IssueUser[]> {
    const cached = cacheGet(this.assigneesCache, projectDir)
    if (cached) return cached
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return []
      const { stdout } = await glab(['api', `projects/${pp}/users?per_page=100`], projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const users = (raw || []).map((u) => mapUser(u))
      cacheSet(this.assigneesCache, projectDir, users)
      return users
    } catch (err) {
      getServices().logError('[issue-gitlab] listAssignableUsers failed:', err)
      return []
    }
  }

  async listMilestones(projectDir: string): Promise<IssueMilestone[]> {
    const cached = cacheGet(this.milestonesCache, projectDir)
    if (cached) return cached
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return []
      const { stdout } = await glab(
        ['api', `projects/${pp}/milestones?state=active&per_page=100`],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const milestones = (raw || []).map((m) => mapMilestone(m)).filter((m): m is IssueMilestone => m !== null)
      cacheSet(this.milestonesCache, projectDir, milestones)
      return milestones
    } catch (err) {
      getServices().logError('[issue-gitlab] listMilestones failed:', err)
      return []
    }
  }

  async getCurrentUser(projectDir: string): Promise<IssueUser | null> {
    const cached = cacheGet(this.currentUserCache, projectDir)
    if (cached !== null) return cached
    try {
      const { stdout } = await glab(['api', 'user'], projectDir)
      const raw = JSON.parse(stdout) as Record<string, unknown>
      const user: IssueUser = {
        login: (raw.username as string) || '',
        name: (raw.name as string) || undefined,
        avatarUrl: (raw.avatar_url as string) || undefined
      }
      cacheSet(this.currentUserCache, projectDir, user)
      return user
    } catch (err) {
      getServices().logError('[issue-gitlab] getCurrentUser failed:', err)
      return null
    }
  }

  async getDefaultBranch(projectDir: string): Promise<string> {
    try {
      const { stdout } = await glab(['repo', 'view', '--output', 'json'], projectDir)
      const repo = JSON.parse(stdout) as Record<string, unknown>
      return (repo.default_branch as string) || 'main'
    } catch (err) {
      getServices().logError('[issue-gitlab] getDefaultBranch failed:', err)
      return 'main'
    }
  }

  async createIssue(projectDir: string, req: IssueCreateRequest): Promise<IssueActionResult> {
    getServices().log('[issue-gitlab] createIssue', projectDir, req.title)
    const bodyFile = writeBodyFile('new', req.body ?? '')
    try {
      // Use REST API via `glab api` so we can submit long descriptions as JSON.
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return { success: false, error: 'Could not resolve project path' }

      const payload: Record<string, unknown> = {
        title: req.title,
        description: req.body ?? ''
      }
      if (req.labels?.length) payload.labels = req.labels.join(',')
      if (req.assignees?.length) {
        // GitLab REST requires assignee_ids (numeric), so resolve each login via users endpoint.
        const ids: number[] = []
        for (const login of req.assignees) {
          try {
            const { stdout } = await glab(['api', `users?username=${encodeURIComponent(login)}`], projectDir)
            const arr = JSON.parse(stdout) as Array<Record<string, unknown>>
            if (arr?.[0]?.id) ids.push(arr[0].id as number)
          } catch { /* skip unresolvable login */ }
        }
        if (ids.length) payload.assignee_ids = ids
      }
      if (req.milestone != null && req.milestone !== '') {
        payload.milestone_id = typeof req.milestone === 'string' ? parseInt(req.milestone, 10) : req.milestone
      }

      const { stdout } = await glab(
        ['api', '-X', 'POST', `projects/${pp}/issues`, '--input', '-'],
        projectDir,
        { input: JSON.stringify(payload) }
      )
      const created = JSON.parse(stdout) as Record<string, unknown>
      const issue = mapIssue(created)
      return { success: true, issue }
    } catch (err) {
      getServices().logError('[issue-gitlab] createIssue failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create issue' }
    } finally {
      deleteBodyFile(bodyFile)
    }
  }

  async updateIssue(
    projectDir: string,
    id: number,
    req: IssueUpdateRequest
  ): Promise<IssueActionResult> {
    getServices().log('[issue-gitlab] updateIssue', projectDir, id, Object.keys(req))
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return { success: false, error: 'Could not resolve project path' }

      // Build PUT payload for GitLab REST API.
      const payload: Record<string, unknown> = {}
      if (req.title !== undefined) payload.title = req.title
      if (req.body !== undefined) payload.description = req.body
      if (req.addLabels?.length) payload.add_labels = req.addLabels.join(',')
      if (req.removeLabels?.length) payload.remove_labels = req.removeLabels.join(',')

      // Assignees: GitLab REST requires a complete assignee_ids array.
      if (req.addAssignees?.length || req.removeAssignees?.length) {
        const current = await this.getIssue(projectDir, id)
        const currentLogins = new Set((current?.assignees || []).map((a) => a.login))
        for (const l of req.addAssignees || []) currentLogins.add(l)
        for (const l of req.removeAssignees || []) currentLogins.delete(l)

        // Resolve logins -> ids
        const ids: number[] = []
        for (const login of currentLogins) {
          try {
            const { stdout } = await glab(['api', `users?username=${encodeURIComponent(login)}`], projectDir)
            const arr = JSON.parse(stdout) as Array<Record<string, unknown>>
            if (arr?.[0]?.id) ids.push(arr[0].id as number)
          } catch { /* skip */ }
        }
        payload.assignee_ids = ids.length > 0 ? ids : [0] // [0] clears all
      }

      if (req.milestone !== undefined) {
        if (req.milestone === null || req.milestone === '') {
          payload.milestone_id = 0 // GitLab uses 0 to clear
        } else {
          payload.milestone_id = typeof req.milestone === 'string' ? parseInt(req.milestone, 10) : req.milestone
        }
      }

      if (req.state === 'closed') payload.state_event = 'close'
      else if (req.state === 'open') payload.state_event = 'reopen'

      if (Object.keys(payload).length > 0) {
        await glab(
          ['api', '-X', 'PUT', `projects/${pp}/issues/${id}`, '--input', '-'],
          projectDir,
          { input: JSON.stringify(payload) }
        )
      }

      const issue = await this.getIssue(projectDir, id)
      return { success: true, issue: issue ?? undefined }
    } catch (err) {
      getServices().logError('[issue-gitlab] updateIssue failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to update issue' }
    }
  }

  async setState(
    projectDir: string,
    id: number,
    state: IssueState,
    reason?: IssueStateReason
  ): Promise<IssueActionResult> {
    return this.updateIssue(projectDir, id, { state, stateReason: reason })
  }

  async addLabel(projectDir: string, id: number, labels: string[]): Promise<IssueActionResult> {
    return this.updateIssue(projectDir, id, { addLabels: labels })
  }

  async removeLabel(projectDir: string, id: number, labels: string[]): Promise<IssueActionResult> {
    return this.updateIssue(projectDir, id, { removeLabels: labels })
  }

  async addAssignee(projectDir: string, id: number, logins: string[]): Promise<IssueActionResult> {
    return this.updateIssue(projectDir, id, { addAssignees: logins })
  }

  async removeAssignee(projectDir: string, id: number, logins: string[]): Promise<IssueActionResult> {
    return this.updateIssue(projectDir, id, { removeAssignees: logins })
  }

  async setMilestone(
    projectDir: string,
    id: number,
    milestone: number | string | null
  ): Promise<IssueActionResult> {
    return this.updateIssue(projectDir, id, { milestone })
  }

  async addComment(projectDir: string, id: number, body: string): Promise<IssueComment | null> {
    getServices().log('[issue-gitlab] addComment', projectDir, id)
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return null
      const { stdout } = await glab(
        ['api', '-X', 'POST', `projects/${pp}/issues/${id}/notes`, '--input', '-'],
        projectDir,
        { input: JSON.stringify({ body }) }
      )
      const note = JSON.parse(stdout) as Record<string, unknown>
      const me = await this.getCurrentUser(projectDir)
      return mapNote(note, me?.login ?? null)
    } catch (err) {
      getServices().logError('[issue-gitlab] addComment failed:', err)
      return null
    }
  }

  async updateComment(
    projectDir: string,
    issueId: number,
    commentId: number | string,
    body: string
  ): Promise<IssueComment | null> {
    getServices().log('[issue-gitlab] updateComment', projectDir, issueId, commentId)
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return null
      const { stdout } = await glab(
        [
          'api', '-X', 'PUT',
          `projects/${pp}/issues/${issueId}/notes/${commentId}`,
          '--input', '-'
        ],
        projectDir,
        { input: JSON.stringify({ body }) }
      )
      const note = JSON.parse(stdout) as Record<string, unknown>
      const me = await this.getCurrentUser(projectDir)
      return mapNote(note, me?.login ?? null)
    } catch (err) {
      getServices().logError('[issue-gitlab] updateComment failed:', err)
      return null
    }
  }

  async deleteComment(
    projectDir: string,
    issueId: number,
    commentId: number | string
  ): Promise<boolean> {
    getServices().log('[issue-gitlab] deleteComment', projectDir, issueId, commentId)
    try {
      const pp = await this.getProjectPath(projectDir)
      if (!pp) return false
      await glab(
        ['api', '-X', 'DELETE', `projects/${pp}/issues/${issueId}/notes/${commentId}`],
        projectDir
      )
      return true
    } catch (err) {
      getServices().logError('[issue-gitlab] deleteComment failed:', err)
      return false
    }
  }
}
