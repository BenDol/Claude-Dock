import { execFile, execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import type { CiProvider } from './ci-provider'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiSetupStatus, LogSection } from '../../../../shared/ci-types'
import { getServices } from '../services'

const execFileAsync = promisify(execFile)

let glabPath: string | null = null

function resolveGlab(): string {
  if (glabPath) return glabPath

  // Try PATH first
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execFileSync(cmd, ['glab'], { timeout: 5000, encoding: 'utf-8' }).trim().split('\n')[0].trim()
    if (result) {
      glabPath = result
      getServices().log('[ci-gitlab] found glab at:', glabPath)
      return glabPath
    }
  } catch { /* not in PATH */ }

  // Try common install locations
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\glab\\glab.exe',
        'C:\\Program Files (x86)\\glab\\glab.exe'
      ]
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/glab', '/usr/local/bin/glab']
      : ['/usr/bin/glab', '/usr/local/bin/glab', '/snap/bin/glab']

  for (const p of candidates) {
    if (existsSync(p)) {
      glabPath = p
      getServices().log('[ci-gitlab] found glab at:', glabPath)
      return glabPath
    }
  }

  // Fallback — let the OS resolve it
  glabPath = 'glab'
  return glabPath
}

function glab(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolveGlab(), args, { cwd, timeout: 30_000 })
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

function mapGitLabStatus(status: string): CiWorkflowRun['status'] {
  switch (status.toLowerCase()) {
    case 'running': return 'in_progress'
    case 'pending': case 'waiting_for_resource': case 'created': return 'queued'
    case 'success': case 'failed': case 'canceled': case 'skipped': case 'manual': return 'completed'
    default: return 'queued'
  }
}

function mapGitLabConclusion(status: string): CiWorkflowRun['conclusion'] {
  switch (status.toLowerCase()) {
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'canceled': return 'cancelled'
    case 'skipped': return 'skipped'
    default: return null
  }
}

function mapGitLabJobStatus(status: string): CiJob['status'] {
  switch (status.toLowerCase()) {
    case 'running': return 'in_progress'
    case 'pending': case 'waiting_for_resource': case 'created': return 'queued'
    case 'success': case 'failed': case 'canceled': case 'skipped': case 'manual': return 'completed'
    default: return 'queued'
  }
}

function mapGitLabJobConclusion(status: string): CiJob['conclusion'] {
  switch (status.toLowerCase()) {
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'canceled': return 'cancelled'
    case 'skipped': return 'skipped'
    default: return null
  }
}

// Cache project ID per projectDir so we don't fetch it on every API call
const projectIdCache = new Map<string, number>()

async function getProjectId(cwd: string): Promise<number> {
  const cached = projectIdCache.get(cwd)
  if (cached) return cached
  const { stdout } = await glab(['repo', 'view', '--output', 'json'], cwd)
  const repo = JSON.parse(stdout) as Record<string, unknown>
  const id = repo.id as number
  if (!id) throw new Error('Could not determine GitLab project ID')
  projectIdCache.set(cwd, id)
  return id
}

export class GitLabCiProvider implements CiProvider {
  readonly name = 'GitLab CI'
  readonly providerKey = 'gitlab'

  async getSetupStatus(projectDir: string): Promise<CiSetupStatus> {
    const steps: CiSetupStatus['steps'] = []

    // Step 1: CLI installed
    let cliInstalled = false
    try {
      const glabBin = resolveGlab()
      await execFileAsync(glabBin, ['--version'], { timeout: 5000 })
      cliInstalled = true
    } catch { /* not installed */ }
    steps.push({
      id: 'cli-installed',
      label: 'GitLab CLI (glab) installed',
      status: cliInstalled ? 'ok' : 'missing',
      helpText: 'The glab CLI is required to access GitLab CI.',
      helpUrl: 'https://gitlab.com/gitlab-org/cli#installation',
      actionLabel: 'Download CLI'
    })

    // Step 2: CLI authenticated
    let cliAuthenticated = false
    if (cliInstalled) {
      try {
        await execFileAsync(resolveGlab(), ['auth', 'status'], { timeout: 10_000 })
        cliAuthenticated = true
      } catch { /* not authed */ }
    }
    steps.push({
      id: 'cli-authenticated',
      label: 'Authenticated with GitLab',
      status: !cliInstalled ? 'missing' : cliAuthenticated ? 'ok' : 'missing',
      helpText: 'Sign in to your GitLab account via the CLI.',
      actionId: 'auth-login',
      actionLabel: 'Run glab auth login'
    })

    // Step 3: GitLab remote
    let hasRemote = false
    if (cliAuthenticated) {
      try {
        // glab repo view will fail if no GitLab remote
        await glab(['repo', 'view'], projectDir)
        hasRemote = true
      } catch { /* no remote */ }
    }
    steps.push({
      id: 'remote-configured',
      label: 'GitLab remote configured',
      status: !cliAuthenticated ? 'missing' : hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a GitLab remote. Add one with git remote add origin <url>.'
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
      const glabBin = resolveGlab()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${glabBin}" auth login`], {
          stdio: 'ignore', detached: true, windowsHide: false
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', `${glabBin} auth login`], {
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
            spawn(t.cmd, [...t.args, glabBin, 'auth', 'login'], {
              stdio: 'ignore', detached: true
            }).unref()
            return { success: true }
          } catch { /* try next */ }
        }
        return { success: false, error: 'No terminal emulator found' }
      }
      return { success: true }
    } catch (err) {
      getServices().logError('[ci-gitlab] auth login failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to open terminal' }
    }
  }

  async isAvailable(projectDir: string): Promise<boolean> {
    try {
      await execFileAsync(resolveGlab(), ['auth', 'status'], { timeout: 10_000 })
      await glab(['repo', 'view'], projectDir)
      return true
    } catch (err) {
      getServices().log('[ci-gitlab] not available:', err instanceof Error ? err.message : err)
      return false
    }
  }

  async getWorkflows(_projectDir: string): Promise<CiWorkflow[]> {
    // GitLab has no workflow concept — return a single synthetic workflow
    return [{
      id: 0,
      name: 'All Pipelines',
      path: '',
      state: 'active'
    }]
  }

  async getWorkflowRuns(projectDir: string, _workflowId: number, page: number, perPage: number): Promise<CiWorkflowRun[]> {
    try {
      const { stdout } = await glab(
        ['ci', 'list', '--output', 'json', '--per-page', String(perPage), '--page', String(page)],
        projectDir
      )
      const raw = JSON.parse(stdout) as Array<Record<string, unknown>>
      return (raw || []).map(mapPipeline)
    } catch (err) {
      getServices().logError('[ci-gitlab] getWorkflowRuns failed:', err)
      return []
    }
  }

  async getActiveRuns(projectDir: string): Promise<CiWorkflowRun[]> {
    try {
      const { stdout: runningOut } = await glab(
        ['ci', 'list', '--status', 'running', '--output', 'json', '--per-page', '50'],
        projectDir
      )
      const running = JSON.parse(runningOut) as Array<Record<string, unknown>>

      const { stdout: pendingOut } = await glab(
        ['ci', 'list', '--status', 'pending', '--output', 'json', '--per-page', '50'],
        projectDir
      )
      const pending = JSON.parse(pendingOut) as Array<Record<string, unknown>>

      return [...(running || []), ...(pending || [])].map(mapPipeline)
    } catch (err) {
      getServices().logError('[ci-gitlab] getActiveRuns failed:', err)
      return []
    }
  }

  async getRun(projectDir: string, runId: number): Promise<CiWorkflowRun | null> {
    try {
      const { stdout } = await glab(
        ['ci', 'view', String(runId), '--output', 'json'],
        projectDir
      )
      const raw = JSON.parse(stdout) as Record<string, unknown>
      return mapPipeline(raw)
    } catch (err) {
      getServices().logError('[ci-gitlab] getRun failed:', err)
      return null
    }
  }

  async getRunJobs(projectDir: string, runId: number): Promise<CiJob[]> {
    try {
      const projectId = await getProjectId(projectDir)
      const { stdout } = await glab(
        ['api', `/projects/${projectId}/pipelines/${runId}/jobs?per_page=100`],
        projectDir
      )
      const jobs = JSON.parse(stdout) as Array<Record<string, unknown>>
      getServices().log('[ci-gitlab] getRunJobs: got', jobs.length, 'jobs for pipeline', runId)
      return (jobs || []).map((j) => {
        const name = (j.name as string) || ''
        const { matrixKey, matrixValues } = parseMatrixJobName(name)
        const status = (j.status as string) || 'created'
        const stage = (j.stage as string) || ''
        return {
          id: (j.id as number) || 0,
          name: stage ? `${stage} / ${name}` : name,
          status: mapGitLabJobStatus(status),
          conclusion: mapGitLabJobConclusion(status),
          startedAt: (j.started_at as string) || null,
          completedAt: (j.finished_at as string) || null,
          steps: [], // GitLab doesn't expose step-level data via API
          matrixKey,
          matrixValues
        }
      })
    } catch (err) {
      getServices().logError('[ci-gitlab] getRunJobs failed:', err)
      return []
    }
  }

  async cancelRun(projectDir: string, runId: number): Promise<void> {
    const projectId = await getProjectId(projectDir)
    await glab(['api', '--method', 'POST', `/projects/${projectId}/pipelines/${runId}/cancel`], projectDir)
  }

  async rerunFailedJobs(projectDir: string, runId: number): Promise<void> {
    const projectId = await getProjectId(projectDir)
    await glab(['api', '--method', 'POST', `/projects/${projectId}/pipelines/${runId}/retry`], projectDir)
  }

  async getJobLog(projectDir: string, jobId: number): Promise<string> {
    try {
      const projectId = await getProjectId(projectDir)
      const { stdout } = await execFileAsync(resolveGlab(), [
        'api', `/projects/${projectId}/jobs/${jobId}/trace`
      ], { cwd: projectDir, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 })
      return stdout
    } catch (err) {
      getServices().logError('[ci-gitlab] getJobLog failed:', err)
      return ''
    }
  }

  async getRunUrl(projectDir: string, runId: number): Promise<string> {
    try {
      const { stdout } = await glab(['ci', 'view', String(runId), '--output', 'json'], projectDir)
      const raw = JSON.parse(stdout) as Record<string, unknown>
      return (raw.web_url as string) || ''
    } catch {
      return ''
    }
  }

  parseLogSections(rawLog: string): LogSection[] {
    const lines = rawLog.split('\n')
    const sections: LogSection[] = []
    let currentSection: LogSection | null = null

    for (const line of lines) {
      // GitLab uses ANSI section markers: section_start:<timestamp>:<name>\r\e[0K<title>
      const startMatch = line.match(/section_start:\d+:([^\r]*)/)
      if (startMatch) {
        if (currentSection) sections.push(currentSection)
        // Extract section name, stripping ANSI escape codes
        const name = startMatch[1].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim()
        currentSection = { name: name || 'Section', lines: [], collapsed: true }
        continue
      }

      const endMatch = line.match(/section_end:\d+:/)
      if (endMatch) {
        if (currentSection) {
          sections.push(currentSection)
          currentSection = null
        }
        continue
      }

      // Fallback: detect `$ <command>` lines as section boundaries
      const cmdMatch = line.match(/^\$ (.+)/)
      if (cmdMatch && !currentSection) {
        if (sections.length > 0 && sections[sections.length - 1].lines.length === 0) {
          // Reuse empty trailing section
          sections[sections.length - 1].name = cmdMatch[1]
        } else {
          sections.push({ name: cmdMatch[1], lines: [], collapsed: true })
        }
        continue
      }

      if (currentSection) {
        // Strip ANSI escape codes for cleaner output
        currentSection.lines.push(line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''))
      } else {
        if (sections.length === 0) {
          sections.push({ name: '', lines: [], collapsed: false })
        }
        sections[sections.length - 1].lines.push(line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''))
      }
    }
    if (currentSection) sections.push(currentSection)
    return sections
  }
}

function mapPipeline(p: Record<string, unknown>): CiWorkflowRun {
  const status = (p.status as string) || 'created'
  const ref = (p.ref as string) || ''
  const sha = (p.sha as string) || ''
  return {
    id: (p.id as number) || 0,
    name: ref ? `Pipeline #${p.id}` : 'Pipeline',
    workflowId: 0, // synthetic
    headBranch: ref,
    headSha: sha,
    status: mapGitLabStatus(status),
    conclusion: mapGitLabConclusion(status),
    createdAt: (p.created_at as string) || '',
    updatedAt: (p.updated_at as string) || '',
    url: (p.web_url as string) || '',
    event: (p.source as string) || 'push',
    runNumber: (p.id as number) || 0,
    runAttempt: 1,
    actor: ((p.user as Record<string, unknown>)?.username as string) || ''
  }
}
