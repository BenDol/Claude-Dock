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

let ghPath: string | null = null

function resolveGh(): string {
  if (ghPath) return ghPath
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(cmd, ['gh'], { timeout: 5000, encoding: 'utf-8' }).trim().split('\n')[0].trim()
    if (result) { ghPath = result; return ghPath }
  } catch { /* not in PATH */ }

  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\GitHub CLI\\gh.exe', 'C:\\Program Files (x86)\\GitHub CLI\\gh.exe']
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
      : ['/usr/bin/gh', '/usr/local/bin/gh', '/snap/bin/gh']
  for (const p of candidates) {
    if (existsSync(p)) { ghPath = p; return ghPath }
  }
  ghPath = 'gh'
  return ghPath
}

function gh(args: string[], cwd: string, opts?: { input?: string }): Promise<{ stdout: string; stderr: string }> {
  const child = execFileAsync(resolveGh(), args, { cwd, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 })
  if (opts?.input !== undefined) {
    // @ts-ignore — child exposes stdin at runtime
    child.child.stdin?.end(opts.input)
  }
  return child
}

const ISSUE_JSON_FIELDS = 'number,title,state,stateReason,author,assignees,labels,milestone,comments,createdAt,updatedAt,url,body,closedAt'

// --- Long-body temp-file helpers (avoid Windows argv length limits) -----------

const BODY_TMP_DIR = path.join(os.tmpdir(), 'claude-dock-issue-bodies')

function ensureTmpDir(): void {
  try {
    mkdirSync(BODY_TMP_DIR, { recursive: true })
  } catch (err) {
    getServices().logError('[issue-github] ensureTmpDir failed:', err)
  }
}

function writeBodyFile(issueId: number | string, body: string): string {
  ensureTmpDir()
  const file = path.join(BODY_TMP_DIR, `gh-issue-${issueId}-${Date.now()}.md`)
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
    login: (r.login as string) || (r.name as string) || '',
    name: (r.name as string) || undefined,
    avatarUrl: (r.avatarUrl as string) || (r.avatar_url as string) || undefined
  }
}

function mapLabel(raw: unknown): IssueLabel {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    name: (r.name as string) || '',
    color: (r.color as string) || undefined,
    description: (r.description as string) || undefined
  }
}

function mapMilestone(raw: unknown): IssueMilestone | null {
  if (!raw) return null
  const r = raw as Record<string, unknown>
  if (!r.title && !r.number) return null
  return {
    id: (r.number as number) ?? (r.id as number) ?? (r.title as string) ?? '',
    title: (r.title as string) || '',
    state: (r.state as string) === 'closed' ? 'closed' : 'open',
    dueOn: (r.dueOn as string) || (r.due_on as string) || null
  }
}

function mapIssue(raw: Record<string, unknown>): Issue {
  const stateRaw = ((raw.state as string) || '').toLowerCase()
  const comments = (raw.comments as unknown[]) || []
  return {
    id: (raw.number as number) || 0,
    title: (raw.title as string) || '',
    body: (raw.body as string) || '',
    state: stateRaw === 'closed' ? 'closed' : 'open',
    stateReason: (raw.stateReason as IssueStateReason) || null,
    author: mapUser(raw.author),
    assignees: ((raw.assignees as unknown[]) || []).map(mapUser),
    labels: ((raw.labels as unknown[]) || []).map(mapLabel),
    milestone: mapMilestone(raw.milestone),
    commentsCount: Array.isArray(comments) ? comments.length : Number(comments) || 0,
    createdAt: (raw.createdAt as string) || '',
    updatedAt: (raw.updatedAt as string) || '',
    closedAt: (raw.closedAt as string) || null,
    url: (raw.url as string) || '',
    locked: false
  }
}

function mapRestComment(raw: Record<string, unknown>, currentUserLogin: string | null): IssueComment {
  const user = (raw.user as Record<string, unknown>) || {}
  const login = (user.login as string) || ''
  return {
    id: (raw.id as number) || 0,
    author: {
      login,
      avatarUrl: (user.avatar_url as string) || undefined
    },
    body: (raw.body as string) || '',
    createdAt: (raw.created_at as string) || '',
    updatedAt: (raw.updated_at as string) || '',
    isAuthor: !!currentUserLogin && currentUserLogin === login,
    isSystem: false
  }
}

// --- Metadata cache (5-min TTL) ----------------------------------------------

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

// --- Provider implementation --------------------------------------------------

export class GitHubIssueProvider implements IssueProvider {
  readonly name = 'GitHub Issues'
  readonly providerKey = 'github' as const
  readonly cli = 'gh' as const

  private labelsCache = new Map<string, CacheEntry<IssueLabel[]>>()
  private assigneesCache = new Map<string, CacheEntry<IssueUser[]>>()
  private milestonesCache = new Map<string, CacheEntry<IssueMilestone[]>>()
  private currentUserCache = new Map<string, CacheEntry<IssueUser | null>>()
  private repoCache = new Map<string, CacheEntry<{ owner: string; name: string }>>()

  async isAvailable(projectDir: string): Promise<boolean> {
    try {
      await gh(['auth', 'status'], projectDir)
      const { stdout } = await gh(['repo', 'view', '--json', 'name', '-q', '.name'], projectDir)
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }

  async getSetupStatus(projectDir: string): Promise<CiSetupStatus> {
    const steps: CiSetupStatus['steps'] = []

    let cliInstalled = false
    try {
      await execFileAsync(resolveGh(), ['--version'], { timeout: 5000 })
      cliInstalled = true
    } catch { /* not installed */ }
    steps.push({
      id: 'cli-installed',
      label: 'GitHub CLI (gh) installed',
      status: cliInstalled ? 'ok' : 'missing',
      helpText: 'The gh CLI is required for issue support.',
      helpUrl: 'https://cli.github.com'
    })

    let authenticated = false
    if (cliInstalled) {
      try { await gh(['auth', 'status'], projectDir); authenticated = true } catch { /* not authed */ }
    }
    steps.push({
      id: 'cli-authenticated',
      label: 'Authenticated with GitHub',
      status: !cliInstalled ? 'missing' : authenticated ? 'ok' : 'missing',
      helpText: 'Sign in via: gh auth login',
      actionId: 'auth-login',
      actionLabel: 'Run gh auth login'
    })

    let hasRemote = false
    if (authenticated) {
      try {
        const { stdout } = await gh(['repo', 'view', '--json', 'name', '-q', '.name'], projectDir)
        hasRemote = stdout.trim().length > 0
      } catch { /* no remote */ }
    }
    steps.push({
      id: 'remote-configured',
      label: 'GitHub remote configured',
      status: !authenticated ? 'missing' : hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a GitHub remote.'
    })

    return {
      ready: cliInstalled && authenticated && hasRemote,
      providerName: this.name,
      steps
    }
  }

  async runSetupAction(
    _projectDir: string,
    actionId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (actionId !== 'auth-login') return { success: false, error: 'Unknown action' }
    try {
      const bin = resolveGh()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${bin}" auth login`], {
          stdio: 'ignore',
          detached: true,
          windowsHide: false
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', `${bin} auth login`], {
          stdio: 'ignore',
          detached: true
        }).unref()
      } else {
        spawn('x-terminal-emulator', ['-e', bin, 'auth', 'login'], {
          stdio: 'ignore',
          detached: true
        }).unref()
      }
      return { success: true }
    } catch (err) {
      getServices().logError('[issue-github] runSetupAction failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  }

  private async getRepo(projectDir: string): Promise<{ owner: string; name: string } | null> {
    const cached = cacheGet(this.repoCache, projectDir)
    if (cached) return cached
    try {
      const { stdout } = await gh(
        ['repo', 'view', '--json', 'owner,name', '-q', '{owner: .owner.login, name: .name}'],
        projectDir
      )
      const parsed = JSON.parse(stdout) as { owner: string; name: string }
      if (parsed?.owner && parsed?.name) {
        cacheSet(this.repoCache, projectDir, parsed)
        return parsed
      }
    } catch (err) {
      getServices().logError('[issue-github] getRepo failed:', err)
    }
    return null
  }

  async listIssues(projectDir: string, state?: IssueState | 'all'): Promise<Issue[]> {
    getServices().log('[issue-github] listIssues', projectDir, state)
    try {
      const args = ['issue', 'list', '--json', ISSUE_JSON_FIELDS, '--limit', '100']
      if (state === 'open') args.push('--state', 'open')
      else if (state === 'closed') args.push('--state', 'closed')
      else args.push('--state', 'all')
      const { stdout } = await gh(args, projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      return (raw || []).map(mapIssue)
    } catch (err) {
      getServices().logError('[issue-github] listIssues failed:', err)
      return []
    }
  }

  async getIssue(projectDir: string, id: number): Promise<Issue | null> {
    getServices().log('[issue-github] getIssue', projectDir, id)
    try {
      const { stdout } = await gh(
        ['issue', 'view', String(id), '--json', ISSUE_JSON_FIELDS],
        projectDir
      )
      return mapIssue(JSON.parse(stdout))
    } catch (err) {
      getServices().logError('[issue-github] getIssue failed:', err)
      return null
    }
  }

  async listComments(projectDir: string, issueId: number): Promise<IssueComment[]> {
    getServices().log('[issue-github] listComments', projectDir, issueId)
    try {
      const repo = await this.getRepo(projectDir)
      if (!repo) return []
      const endpoint = `repos/${repo.owner}/${repo.name}/issues/${issueId}/comments`
      const { stdout } = await gh(['api', '--paginate', endpoint], projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const me = await this.getCurrentUser(projectDir)
      return (raw || []).map((c) => mapRestComment(c, me?.login ?? null))
    } catch (err) {
      getServices().logError('[issue-github] listComments failed:', err)
      return []
    }
  }

  async listLabels(projectDir: string): Promise<IssueLabel[]> {
    const cached = cacheGet(this.labelsCache, projectDir)
    if (cached) return cached
    try {
      const { stdout } = await gh(
        ['label', 'list', '--json', 'name,color,description', '--limit', '200'],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const labels = (raw || []).map(mapLabel)
      cacheSet(this.labelsCache, projectDir, labels)
      return labels
    } catch (err) {
      getServices().logError('[issue-github] listLabels failed:', err)
      return []
    }
  }

  async listAssignableUsers(projectDir: string): Promise<IssueUser[]> {
    const cached = cacheGet(this.assigneesCache, projectDir)
    if (cached) return cached
    try {
      const repo = await this.getRepo(projectDir)
      if (!repo) return []
      const { stdout } = await gh(
        ['api', `repos/${repo.owner}/${repo.name}/assignees?per_page=100`],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const users = (raw || []).map((u) => ({
        login: (u.login as string) || '',
        avatarUrl: (u.avatar_url as string) || undefined
      }))
      cacheSet(this.assigneesCache, projectDir, users)
      return users
    } catch (err) {
      getServices().logError('[issue-github] listAssignableUsers failed:', err)
      return []
    }
  }

  async listMilestones(projectDir: string): Promise<IssueMilestone[]> {
    const cached = cacheGet(this.milestonesCache, projectDir)
    if (cached) return cached
    try {
      const repo = await this.getRepo(projectDir)
      if (!repo) return []
      const { stdout } = await gh(
        ['api', `repos/${repo.owner}/${repo.name}/milestones?state=open&per_page=100`],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const milestones = (raw || []).map((m) => ({
        id: (m.number as number) || 0,
        title: (m.title as string) || '',
        state: ((m.state as string) === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
        dueOn: (m.due_on as string) || null
      }))
      cacheSet(this.milestonesCache, projectDir, milestones)
      return milestones
    } catch (err) {
      getServices().logError('[issue-github] listMilestones failed:', err)
      return []
    }
  }

  async getCurrentUser(projectDir: string): Promise<IssueUser | null> {
    const cached = cacheGet(this.currentUserCache, projectDir)
    if (cached !== null) return cached
    try {
      const { stdout } = await gh(['api', 'user'], projectDir)
      const raw = JSON.parse(stdout) as Record<string, unknown>
      const user: IssueUser = {
        login: (raw.login as string) || '',
        name: (raw.name as string) || undefined,
        avatarUrl: (raw.avatar_url as string) || undefined
      }
      cacheSet(this.currentUserCache, projectDir, user)
      return user
    } catch (err) {
      getServices().logError('[issue-github] getCurrentUser failed:', err)
      return null
    }
  }

  async getDefaultBranch(projectDir: string): Promise<string> {
    try {
      const { stdout } = await gh(
        ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
        projectDir
      )
      return stdout.trim() || 'main'
    } catch (err) {
      getServices().logError('[issue-github] getDefaultBranch failed:', err)
      return 'main'
    }
  }

  async createIssue(projectDir: string, req: IssueCreateRequest): Promise<IssueActionResult> {
    getServices().log('[issue-github] createIssue', projectDir, req.title)
    const bodyFile = writeBodyFile('new', req.body ?? '')
    try {
      const args = ['issue', 'create', '--title', req.title, '--body-file', bodyFile]
      if (req.labels?.length) args.push('--label', req.labels.join(','))
      if (req.assignees?.length) args.push('--assignee', req.assignees.join(','))
      if (req.milestone != null && req.milestone !== '') args.push('--milestone', String(req.milestone))

      const { stdout } = await gh(args, projectDir)
      const url = stdout.trim().split('\n').pop() || ''
      // Extract the number from the URL to refetch the canonical object
      const match = url.match(/\/issues\/(\d+)/)
      if (match) {
        const id = parseInt(match[1], 10)
        const issue = await this.getIssue(projectDir, id)
        return { success: true, issue: issue ?? undefined }
      }
      return { success: true }
    } catch (err) {
      getServices().logError('[issue-github] createIssue failed:', err)
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
    getServices().log('[issue-github] updateIssue', projectDir, id, Object.keys(req))
    let bodyFile: string | null = null
    try {
      // Title / body / labels / assignees / milestone via `gh issue edit`.
      const args = ['issue', 'edit', String(id)]
      if (req.title !== undefined) args.push('--title', req.title)
      if (req.body !== undefined) {
        bodyFile = writeBodyFile(id, req.body)
        args.push('--body-file', bodyFile)
      }
      if (req.addLabels?.length) args.push('--add-label', req.addLabels.join(','))
      if (req.removeLabels?.length) args.push('--remove-label', req.removeLabels.join(','))
      if (req.addAssignees?.length) args.push('--add-assignee', req.addAssignees.join(','))
      if (req.removeAssignees?.length) args.push('--remove-assignee', req.removeAssignees.join(','))
      if (req.milestone !== undefined) {
        if (req.milestone === null || req.milestone === '') {
          // gh issue edit cannot clear — use REST PATCH below
        } else {
          args.push('--milestone', String(req.milestone))
        }
      }

      // Only run issue edit if there's actually something for it to do
      const hasEdit = args.length > 3
      if (hasEdit) {
        await gh(args, projectDir)
      }

      // Clear milestone separately via REST (null milestone)
      if (req.milestone === null || req.milestone === '') {
        const repo = await this.getRepo(projectDir)
        if (repo) {
          await gh(
            ['api', '-X', 'PATCH', `repos/${repo.owner}/${repo.name}/issues/${id}`, '-f', 'milestone='],
            projectDir
          )
        }
      }

      // State changes via close/reopen subcommands
      if (req.state === 'closed') {
        const closeArgs = ['issue', 'close', String(id)]
        if (req.stateReason === 'not_planned') closeArgs.push('--reason', 'not planned')
        else if (req.stateReason === 'completed') closeArgs.push('--reason', 'completed')
        await gh(closeArgs, projectDir)
      } else if (req.state === 'open') {
        await gh(['issue', 'reopen', String(id)], projectDir)
      }

      const issue = await this.getIssue(projectDir, id)
      return { success: true, issue: issue ?? undefined }
    } catch (err) {
      getServices().logError('[issue-github] updateIssue failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to update issue' }
    } finally {
      if (bodyFile) deleteBodyFile(bodyFile)
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
    getServices().log('[issue-github] addComment', projectDir, id)
    const bodyFile = writeBodyFile(id, body)
    try {
      await gh(['issue', 'comment', String(id), '--body-file', bodyFile], projectDir)
      // Re-fetch and return the most recent comment matching the body we just wrote
      const comments = await this.listComments(projectDir, id)
      const me = await this.getCurrentUser(projectDir)
      for (let i = comments.length - 1; i >= 0; i--) {
        const c = comments[i]
        if (c.body === body && (!me || c.author.login === me.login)) return c
      }
      return comments.length > 0 ? comments[comments.length - 1] : null
    } catch (err) {
      getServices().logError('[issue-github] addComment failed:', err)
      return null
    } finally {
      deleteBodyFile(bodyFile)
    }
  }

  async updateComment(
    projectDir: string,
    issueId: number,
    commentId: number | string,
    body: string
  ): Promise<IssueComment | null> {
    getServices().log('[issue-github] updateComment', projectDir, issueId, commentId)
    try {
      const repo = await this.getRepo(projectDir)
      if (!repo) return null
      // `gh api --input -` reads a JSON payload from stdin, so large bodies are safe.
      await gh(
        ['api', '-X', 'PATCH', `repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`, '--input', '-'],
        projectDir,
        { input: JSON.stringify({ body }) }
      )
      const comments = await this.listComments(projectDir, issueId)
      return comments.find((c) => String(c.id) === String(commentId)) || null
    } catch (err) {
      getServices().logError('[issue-github] updateComment failed:', err)
      return null
    }
  }

  async deleteComment(
    projectDir: string,
    _issueId: number,
    commentId: number | string
  ): Promise<boolean> {
    getServices().log('[issue-github] deleteComment', projectDir, commentId)
    try {
      const repo = await this.getRepo(projectDir)
      if (!repo) return false
      await gh(
        ['api', '-X', 'DELETE', `repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`],
        projectDir
      )
      return true
    } catch (err) {
      getServices().logError('[issue-github] deleteComment failed:', err)
      return false
    }
  }
}
