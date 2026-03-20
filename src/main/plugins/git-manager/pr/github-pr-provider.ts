import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import type { PrProvider } from './pr-provider'
import type { PullRequest, PrState, PrCreateRequest, PrCreateResult } from '../../../../shared/pr-types'
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

function gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolveGh(), args, { cwd, timeout: 30_000 })
}

const PR_FIELDS = 'number,title,state,headRefName,baseRefName,url,createdAt,updatedAt,isDraft,body'
const PR_FIELDS_FULL = `${PR_FIELDS},labels,reviewDecision`

function mapPr(raw: Record<string, unknown>): PullRequest {
  const state = (raw.state as string || '').toUpperCase()
  return {
    id: (raw.number as number) || 0,
    title: (raw.title as string) || '',
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    sourceBranch: (raw.headRefName as string) || '',
    targetBranch: (raw.baseRefName as string) || '',
    author: ((raw.author as Record<string, unknown>)?.login as string) || '',
    url: (raw.url as string) || '',
    createdAt: (raw.createdAt as string) || '',
    updatedAt: (raw.updatedAt as string) || '',
    isDraft: !!(raw.isDraft),
    labels: ((raw.labels as Array<Record<string, unknown>>) || []).map((l) => (l.name as string) || ''),
    reviewDecision: (raw.reviewDecision as PullRequest['reviewDecision']) || null,
    description: ((raw.body as string) || '').slice(0, 500)
  }
}

export class GitHubPrProvider implements PrProvider {
  readonly name = 'GitHub Pull Requests'
  readonly providerKey = 'github'

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
      id: 'cli-installed', label: 'GitHub CLI (gh) installed',
      status: cliInstalled ? 'ok' : 'missing',
      helpText: 'The gh CLI is required for pull request support.',
      helpUrl: 'https://cli.github.com'
    })

    let authenticated = false
    if (cliInstalled) {
      try { await gh(['auth', 'status'], projectDir); authenticated = true } catch { /* not authed */ }
    }
    steps.push({
      id: 'cli-authenticated', label: 'Authenticated with GitHub',
      status: !cliInstalled ? 'missing' : authenticated ? 'ok' : 'missing',
      helpText: 'Sign in via: gh auth login',
      actionId: 'auth-login', actionLabel: 'Run gh auth login'
    })

    let hasRemote = false
    if (authenticated) {
      try {
        const { stdout } = await gh(['repo', 'view', '--json', 'name', '-q', '.name'], projectDir)
        hasRemote = stdout.trim().length > 0
      } catch { /* no remote */ }
    }
    steps.push({
      id: 'remote-configured', label: 'GitHub remote configured',
      status: !authenticated ? 'missing' : hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a GitHub remote.'
    })

    return { ready: cliInstalled && authenticated && hasRemote, providerName: this.name, steps }
  }

  async runSetupAction(_projectDir: string, actionId: string): Promise<{ success: boolean; error?: string }> {
    if (actionId !== 'auth-login') return { success: false, error: 'Unknown action' }
    const { spawn } = require('child_process') as typeof import('child_process')
    try {
      const bin = resolveGh()
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
      const args = ['pr', 'list', '--json', PR_FIELDS_FULL, '--limit', '50']
      if (state === 'open') args.push('--state', 'open')
      else if (state === 'closed') args.push('--state', 'closed')
      else if (state === 'merged') args.push('--state', 'merged')
      else args.push('--state', 'all')

      const { stdout } = await gh(args, projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      return (raw || []).map(mapPr)
    } catch (err) {
      getServices().logError('[pr-github] listPrs failed:', err)
      return []
    }
  }

  async getPr(projectDir: string, id: number): Promise<PullRequest | null> {
    try {
      const { stdout } = await gh(['pr', 'view', String(id), '--json', PR_FIELDS_FULL], projectDir)
      return mapPr(JSON.parse(stdout))
    } catch (err) {
      getServices().logError('[pr-github] getPr failed:', err)
      return null
    }
  }

  async createPr(projectDir: string, req: PrCreateRequest): Promise<PrCreateResult> {
    try {
      const args = ['pr', 'create', '--title', req.title, '--body', req.body, '--base', req.targetBranch, '--head', req.sourceBranch]
      if (req.isDraft) args.push('--draft')
      const { stdout } = await gh(args, projectDir)
      // gh pr create outputs the PR URL on success
      const url = stdout.trim()
      // Fetch the created PR details
      try {
        const { stdout: viewOut } = await gh(['pr', 'view', '--json', PR_FIELDS_FULL], projectDir)
        return { success: true, pr: mapPr(JSON.parse(viewOut)), url }
      } catch {
        return { success: true, url }
      }
    } catch (err) {
      const url = await this.getNewPrUrl(projectDir, req.sourceBranch, req.targetBranch)
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create pull request',
        url: url || undefined
      }
    }
  }

  async getDefaultBranch(projectDir: string): Promise<string> {
    try {
      const { stdout } = await gh(['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], projectDir)
      return stdout.trim() || 'main'
    } catch {
      return 'main'
    }
  }

  async getNewPrUrl(projectDir: string, sourceBranch: string, targetBranch: string): Promise<string | null> {
    try {
      const { stdout } = await gh(['repo', 'view', '--json', 'url', '-q', '.url'], projectDir)
      const repoUrl = stdout.trim()
      if (repoUrl) return `${repoUrl}/compare/${encodeURIComponent(targetBranch)}...${encodeURIComponent(sourceBranch)}?expand=1`
    } catch { /* fall through */ }
    return null
  }
}
