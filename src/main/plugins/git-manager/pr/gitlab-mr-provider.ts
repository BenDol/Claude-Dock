import { execFile, execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import type { PrProvider } from './pr-provider'
import type { PullRequest, PrState, PrCreateRequest, PrCreateResult } from '../../../../shared/pr-types'
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

function glab(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolveGlab(), args, { cwd, timeout: 30_000 })
}

function mapMr(raw: Record<string, unknown>): PullRequest {
  const state = (raw.state as string || '').toLowerCase()
  return {
    id: (raw.iid as number) || 0,
    title: (raw.title as string) || '',
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
    sourceBranch: (raw.source_branch as string) || '',
    targetBranch: (raw.target_branch as string) || '',
    author: ((raw.author as Record<string, unknown>)?.username as string) || '',
    url: (raw.web_url as string) || '',
    createdAt: (raw.created_at as string) || '',
    updatedAt: (raw.updated_at as string) || '',
    isDraft: !!(raw.draft) || (raw.title as string || '').startsWith('Draft:'),
    labels: (raw.labels as string[]) || [],
    reviewDecision: null,
    description: ((raw.description as string) || '').slice(0, 500)
  }
}

export class GitLabMrProvider implements PrProvider {
  readonly name = 'GitLab Merge Requests'
  readonly providerKey = 'gitlab'

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
      id: 'cli-installed', label: 'GitLab CLI (glab) installed',
      status: cliInstalled ? 'ok' : 'missing',
      helpText: 'The glab CLI is required for merge request support.',
      helpUrl: 'https://gitlab.com/gitlab-org/cli#installation'
    })

    let authenticated = false
    if (cliInstalled) {
      try { await execFileAsync(resolveGlab(), ['auth', 'status'], { timeout: 10_000 }); authenticated = true } catch { /* */ }
    }
    steps.push({
      id: 'cli-authenticated', label: 'Authenticated with GitLab',
      status: !cliInstalled ? 'missing' : authenticated ? 'ok' : 'missing',
      helpText: 'Sign in via: glab auth login',
      actionId: 'auth-login', actionLabel: 'Run glab auth login'
    })

    let hasRemote = false
    if (authenticated) {
      try { await glab(['repo', 'view'], projectDir); hasRemote = true } catch { /* */ }
    }
    steps.push({
      id: 'remote-configured', label: 'GitLab remote configured',
      status: !authenticated ? 'missing' : hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a GitLab remote.'
    })

    return { ready: cliInstalled && authenticated && hasRemote, providerName: this.name, steps }
  }

  async runSetupAction(_projectDir: string, actionId: string): Promise<{ success: boolean; error?: string }> {
    if (actionId !== 'auth-login') return { success: false, error: 'Unknown action' }
    try {
      const bin = resolveGlab()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${bin}" auth login`], { stdio: 'ignore', detached: true, windowsHide: false }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', `${bin} auth login`], { stdio: 'ignore', detached: true }).unref()
      } else {
        spawn('x-terminal-emulator', ['-e', bin, 'auth', 'login'], { stdio: 'ignore', detached: true }).unref()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    }
  }

  async listPrs(projectDir: string, state?: PrState): Promise<PullRequest[]> {
    try {
      const args = ['mr', 'list', '--output', 'json', '--per-page', '50']
      if (state === 'closed') args.push('--closed')
      else if (state === 'merged') args.push('--merged')
      else if (state !== 'open') args.push('--all')
      // 'open' is the default — no flag needed

      const { stdout } = await glab(args, projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      return (raw || []).map(mapMr)
    } catch (err) {
      getServices().logError('[pr-gitlab] listPrs failed:', err)
      return []
    }
  }

  async getPr(projectDir: string, id: number): Promise<PullRequest | null> {
    try {
      const { stdout } = await glab(['mr', 'view', String(id), '--output', 'json'], projectDir)
      return mapMr(JSON.parse(stdout))
    } catch (err) {
      getServices().logError('[pr-gitlab] getPr failed:', err)
      return null
    }
  }

  async createPr(projectDir: string, req: PrCreateRequest): Promise<PrCreateResult> {
    try {
      const args = ['mr', 'create', '--title', req.title, '--description', req.body,
        '--source-branch', req.sourceBranch, '--target-branch', req.targetBranch, '--yes']
      if (req.isDraft) args.push('--draft')
      const { stdout } = await glab(args, projectDir)
      // glab mr create outputs the MR URL
      const url = stdout.trim().split('\n').pop() || ''
      return { success: true, url }
    } catch (err) {
      const url = await this.getNewPrUrl(projectDir, req.sourceBranch, req.targetBranch)
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create merge request',
        url: url || undefined
      }
    }
  }

  async getDefaultBranch(projectDir: string): Promise<string> {
    try {
      const { stdout } = await glab(['repo', 'view', '--output', 'json'], projectDir)
      const repo = JSON.parse(stdout)
      return (repo.default_branch as string) || 'main'
    } catch {
      return 'main'
    }
  }

  async getNewPrUrl(projectDir: string, sourceBranch: string, targetBranch: string): Promise<string | null> {
    try {
      const { stdout } = await glab(['repo', 'view', '--output', 'json'], projectDir)
      const repo = JSON.parse(stdout)
      const webUrl = (repo.web_url as string) || ''
      if (webUrl) {
        return `${webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(sourceBranch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(targetBranch)}`
      }
    } catch { /* fall through */ }
    return null
  }
}
