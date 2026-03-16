import { execFile, execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import type { CiProvider } from './ci-provider'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiJobStep, CiSetupStatus, LogSection } from '../../../../shared/ci-types'
import { getServices } from '../services'

const execFileAsync = promisify(execFile)

let ghPath: string | null = null

export function resolveGh(): string {
  if (ghPath) return ghPath

  // Try PATH first
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(cmd, ['gh'], { timeout: 5000, encoding: 'utf-8' }).trim().split('\n')[0].trim()
    if (result) {
      ghPath = result
      getServices().log('[ci-github] found gh at:', ghPath)
      return ghPath
    }
  } catch { /* not in PATH */ }

  // Try common install locations
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        'C:\\Program Files (x86)\\GitHub CLI\\gh.exe'
      ]
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
      : ['/usr/bin/gh', '/usr/local/bin/gh', '/snap/bin/gh']

  for (const p of candidates) {
    if (existsSync(p)) {
      ghPath = p
      getServices().log('[ci-github] found gh at:', ghPath)
      return ghPath
    }
  }

  // Fallback — let the OS resolve it
  ghPath = 'gh'
  return ghPath
}

function gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolveGh(), args, { cwd, timeout: 30_000 })
}

function parseMatrixJobName(name: string): { matrixKey: string | null; matrixValues: Record<string, string> | null } {
  const match = name.match(/^(.+?)\s*\((.+)\)$/)
  if (!match) return { matrixKey: null, matrixValues: null }

  const key = match[1].trim()
  const vals = match[2].split(',').map((v) => v.trim())
  const matrixValues: Record<string, string> = {}
  for (let i = 0; i < vals.length; i++) {
    matrixValues[String(i)] = vals[i]
  }
  return { matrixKey: key, matrixValues }
}

export class GitHubActionsProvider implements CiProvider {
  readonly name = 'GitHub Actions'
  readonly providerKey = 'github'

  async getSetupStatus(projectDir: string): Promise<CiSetupStatus> {
    const steps: CiSetupStatus['steps'] = []

    // Step 1: CLI installed
    let cliInstalled = false
    try {
      const ghBin = resolveGh()
      await execFileAsync(ghBin, ['--version'], { timeout: 5000 })
      cliInstalled = true
    } catch { /* not installed */ }
    steps.push({
      id: 'cli-installed',
      label: 'GitHub CLI (gh) installed',
      status: cliInstalled ? 'ok' : 'missing',
      helpText: 'The gh CLI is required to access GitHub Actions.',
      helpUrl: 'https://cli.github.com',
      actionLabel: 'Download CLI'
    })

    // Step 2: CLI authenticated
    let cliAuthenticated = false
    if (cliInstalled) {
      try {
        await execFileAsync(resolveGh(), ['auth', 'status'], { timeout: 10_000 })
        cliAuthenticated = true
      } catch { /* not authed */ }
    }
    steps.push({
      id: 'cli-authenticated',
      label: 'Authenticated with GitHub',
      status: !cliInstalled ? 'missing' : cliAuthenticated ? 'ok' : 'missing',
      helpText: 'Sign in to your GitHub account via the CLI.',
      actionId: 'auth-login',
      actionLabel: 'Run gh auth login'
    })

    // Step 3: GitHub remote
    let hasRemote = false
    if (cliAuthenticated) {
      try {
        const { stdout } = await execFileAsync(resolveGh(), ['repo', 'view', '--json', 'name', '-q', '.name'], { cwd: projectDir, timeout: 10_000 })
        hasRemote = stdout.trim().length > 0
      } catch { /* no remote */ }
    }
    steps.push({
      id: 'remote-configured',
      label: 'GitHub remote configured',
      status: !cliAuthenticated ? 'missing' : hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a GitHub remote. Add one with git remote add origin <url>.'
    })

    return {
      ready: cliInstalled && cliAuthenticated && hasRemote,
      providerName: this.name,
      steps
    }
  }

  async runSetupAction(_projectDir: string, actionId: string): Promise<{ success: boolean; error?: string }> {
    if (actionId !== 'auth-login') return { success: false, error: 'Unknown action' }

    try {
      const ghBin = resolveGh()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${ghBin}" auth login`], {
          stdio: 'ignore', detached: true, windowsHide: false
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', `${ghBin} auth login`], {
          stdio: 'ignore', detached: true
        }).unref()
      } else {
        const terminals = [
          { cmd: 'x-terminal-emulator', args: ['-e'] },
          { cmd: 'gnome-terminal', args: ['--'] },
          { cmd: 'konsole', args: ['-e'] },
          { cmd: 'xfce4-terminal', args: ['-e'] },
          { cmd: 'xterm', args: ['-e'] }
        ]
        for (const t of terminals) {
          try {
            await execFileAsync('which', [t.cmd], { timeout: 3000 })
            spawn(t.cmd, [...t.args, ghBin, 'auth', 'login'], {
              stdio: 'ignore', detached: true
            }).unref()
            return { success: true }
          } catch { /* try next */ }
        }
        return { success: false, error: 'No terminal emulator found' }
      }
      return { success: true }
    } catch (err) {
      getServices().logError('[ci-github] auth login failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to open terminal' }
    }
  }

  parseLogSections(rawLog: string): LogSection[] {
    const lines = rawLog.split('\n')
    const sections: LogSection[] = []
    let currentSection: LogSection | null = null

    for (const line of lines) {
      const groupMatch = line.match(/##\[group\](.*)/)
      if (groupMatch) {
        if (currentSection) sections.push(currentSection)
        currentSection = { name: groupMatch[1], lines: [], collapsed: true }
        continue
      }
      if (line.includes('##[endgroup]')) {
        if (currentSection) {
          sections.push(currentSection)
          currentSection = null
        }
        continue
      }
      if (currentSection) {
        currentSection.lines.push(line)
      } else {
        // Lines outside any group go into a default section
        if (sections.length === 0 || sections[sections.length - 1].name !== '') {
          sections.push({ name: '', lines: [], collapsed: false })
        }
        sections[sections.length - 1].lines.push(line)
      }
    }
    if (currentSection) sections.push(currentSection)
    return sections
  }

  async isAvailable(projectDir: string): Promise<boolean> {
    try {
      await gh(['auth', 'status'], projectDir)
      // Also check there's a GitHub remote
      const { stdout } = await gh(['repo', 'view', '--json', 'name', '-q', '.name'], projectDir)
      return stdout.trim().length > 0
    } catch (err) {
      getServices().log('[ci-github] not available:', err instanceof Error ? err.message : err)
      return false
    }
  }

  async getWorkflows(projectDir: string): Promise<CiWorkflow[]> {
    try {
      const { stdout } = await gh(
        ['workflow', 'list', '--json', 'id,name,path,state'],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<{
        id: number; name: string; path: string; state: string
      }>
      return raw.map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state as CiWorkflow['state']
      }))
    } catch (err) {
      getServices().logError('[ci-github] getWorkflows failed:', err)
      return []
    }
  }

  async getWorkflowRuns(projectDir: string, workflowId: number, page: number, perPage: number): Promise<CiWorkflowRun[]> {
    try {
      const fields = 'databaseId,name,workflowDatabaseId,headBranch,headSha,status,conclusion,createdAt,updatedAt,url,event,number,attempt,displayTitle'
      const args = [
        'run', 'list',
        '--workflow', String(workflowId),
        '--json', fields,
        '--limit', String(perPage)
      ]
      // gh run list doesn't have --page, so we use --limit with offset via skip
      // Unfortunately gh doesn't support skip natively, so we fetch page*perPage and slice
      // For simplicity, fetch all up to page*perPage and return last page
      if (page > 1) {
        args[args.indexOf(String(perPage))] = String(page * perPage)
      }
      const { stdout } = await gh(args, projectDir)
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      const all = raw.map(mapRun)
      if (page > 1) {
        return all.slice((page - 1) * perPage)
      }
      return all
    } catch (err) {
      getServices().logError('[ci-github] getWorkflowRuns failed:', err)
      return []
    }
  }

  async getActiveRuns(projectDir: string): Promise<CiWorkflowRun[]> {
    try {
      const fields = 'databaseId,name,workflowDatabaseId,headBranch,headSha,status,conclusion,createdAt,updatedAt,url,event,number,attempt,displayTitle'
      const { stdout } = await gh(
        ['run', 'list', '--status', 'in_progress', '--json', fields, '--limit', '50'],
        projectDir
      )
      const inProgress = JSON.parse(stdout) as Array<Record<string, unknown>>

      const { stdout: stdout2 } = await gh(
        ['run', 'list', '--status', 'queued', '--json', fields, '--limit', '50'],
        projectDir
      )
      const queued = JSON.parse(stdout2) as Array<Record<string, unknown>>

      return [...inProgress, ...queued].map(mapRun)
    } catch (err) {
      getServices().logError('[ci-github] getActiveRuns failed:', err)
      return []
    }
  }

  async getRun(projectDir: string, runId: number): Promise<CiWorkflowRun | null> {
    try {
      const fields = 'databaseId,name,workflowDatabaseId,headBranch,headSha,status,conclusion,createdAt,updatedAt,url,event,number,attempt,displayTitle'
      const { stdout } = await gh(
        ['run', 'view', String(runId), '--json', fields],
        projectDir
      )
      const raw = JSON.parse(stdout) as Record<string, unknown>
      return mapRun(raw)
    } catch (err) {
      getServices().logError('[ci-github] getRun failed:', err)
      return null
    }
  }

  async getRunJobs(projectDir: string, runId: number): Promise<CiJob[]> {
    try {
      const { stdout } = await gh(
        ['run', 'view', String(runId), '--json', 'jobs'],
        projectDir
      )
      const data = JSON.parse(stdout) as {
        jobs: Array<{
          databaseId: number; name: string; status: string; conclusion: string
          startedAt: string; completedAt: string
          steps: Array<{ name: string; number: number; status: string; conclusion: string }>
        }>
      }
      getServices().log('[ci-github] getRunJobs: got', data.jobs.length, 'jobs for run', runId)
      return data.jobs.map((j) => {
        const { matrixKey, matrixValues } = parseMatrixJobName(j.name)
        return {
          id: j.databaseId,
          name: j.name,
          status: j.status.toLowerCase() as CiJob['status'],
          conclusion: (j.conclusion?.toLowerCase() || null) as CiJob['conclusion'],
          startedAt: j.startedAt || null,
          completedAt: j.completedAt || null,
          steps: (j.steps || []).map((s): CiJobStep => ({
            name: s.name,
            number: s.number,
            status: s.status.toLowerCase() as CiJobStep['status'],
            conclusion: (s.conclusion?.toLowerCase() || null) as CiJobStep['conclusion']
          })),
          matrixKey,
          matrixValues
        }
      })
    } catch (err) {
      getServices().logError('[ci-github] getRunJobs failed:', err)
      return []
    }
  }

  async cancelRun(projectDir: string, runId: number): Promise<void> {
    await gh(['run', 'cancel', String(runId)], projectDir)
  }

  async rerunFailedJobs(projectDir: string, runId: number): Promise<void> {
    await gh(['run', 'rerun', String(runId), '--failed'], projectDir)
  }

  async getJobLog(projectDir: string, jobId: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync(resolveGh(), [
        'api',
        `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`,
      ], { cwd: projectDir, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 })
      return stdout
    } catch (err) {
      getServices().logError('[ci-github] getJobLog failed:', err)
      return ''
    }
  }

  async getRunUrl(projectDir: string, runId: number): Promise<string> {
    const { stdout } = await gh(
      ['run', 'view', String(runId), '--json', 'url', '-q', '.url'],
      projectDir
    )
    return stdout.trim()
  }
}

function mapRun(r: Record<string, unknown>): CiWorkflowRun {
  return {
    id: (r.databaseId as number) || 0,
    name: (r.name as string) || '',
    workflowId: (r.workflowDatabaseId as number) || 0,
    headBranch: (r.headBranch as string) || '',
    headSha: (r.headSha as string) || '',
    status: ((r.status as string) || 'queued').toLowerCase() as CiWorkflowRun['status'],
    conclusion: r.conclusion ? (r.conclusion as string).toLowerCase() as CiWorkflowRun['conclusion'] : null,
    createdAt: (r.createdAt as string) || '',
    updatedAt: (r.updatedAt as string) || '',
    url: (r.url as string) || '',
    event: (r.event as string) || '',
    runNumber: (r.number as number) || 0,
    runAttempt: (r.attempt as number) || 1,
    actor: (r.displayTitle as string) || ''
  }
}
