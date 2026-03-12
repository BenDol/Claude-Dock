import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CiProvider } from './ci-provider'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiJobStep } from '../../../../shared/ci-types'
import { log, logError } from '../../../logger'

const execFileAsync = promisify(execFile)

function gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('gh', args, { cwd, timeout: 30_000 })
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

  async isAvailable(projectDir: string): Promise<boolean> {
    try {
      await gh(['auth', 'status'], projectDir)
      // Also check there's a GitHub remote
      const { stdout } = await gh(['repo', 'view', '--json', 'name', '-q', '.name'], projectDir)
      return stdout.trim().length > 0
    } catch (err) {
      log('[ci-github] not available:', err instanceof Error ? err.message : err)
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
      logError('[ci-github] getWorkflows failed:', err)
      return []
    }
  }

  async getWorkflowRuns(projectDir: string, workflowId: number, page: number, perPage: number): Promise<CiWorkflowRun[]> {
    try {
      const fields = 'databaseId,name,workflowDatabaseId,headBranch,headSha,status,conclusion,createdAt,updatedAt,url,event,number,attempt,actor'
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
      logError('[ci-github] getWorkflowRuns failed:', err)
      return []
    }
  }

  async getActiveRuns(projectDir: string): Promise<CiWorkflowRun[]> {
    try {
      const fields = 'databaseId,name,workflowDatabaseId,headBranch,headSha,status,conclusion,createdAt,updatedAt,url,event,number,attempt,actor'
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
      logError('[ci-github] getActiveRuns failed:', err)
      return []
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
      logError('[ci-github] getRunJobs failed:', err)
      return []
    }
  }

  async cancelRun(projectDir: string, runId: number): Promise<void> {
    await gh(['run', 'cancel', String(runId)], projectDir)
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
  const actor = r.actor as { login?: string } | string | undefined
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
    actor: typeof actor === 'object' ? (actor?.login || '') : (actor || '')
  }
}
