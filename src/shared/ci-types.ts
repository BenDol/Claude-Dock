export interface CiWorkflowInput {
  name: string
  description: string
  required: boolean
  default?: string
  type: 'string' | 'boolean' | 'choice' | 'environment'
  options?: string[]
}

export interface CiWorkflow {
  id: number
  name: string
  path: string
  state: 'active' | 'disabled_manually' | 'disabled_inactivity'
  /** Whether this workflow supports manual dispatch (workflow_dispatch trigger) */
  canDispatch?: boolean
  /** Input definitions for workflow_dispatch */
  inputs?: CiWorkflowInput[]
}

export interface CiWorkflowRun {
  id: number
  name: string
  workflowId: number
  headBranch: string
  headSha: string
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
  createdAt: string
  updatedAt: string
  url: string
  event: string
  runNumber: number
  runAttempt: number
  actor: string
}

export interface CiJob {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'waiting'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  startedAt: string | null
  completedAt: string | null
  steps: CiJobStep[]
  matrixKey: string | null
  matrixValues: Record<string, string> | null
}

export interface CiJobStep {
  name: string
  number: number
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'skipped' | null
}

export interface CiJobGroup {
  key: string
  isMatrix: boolean
  jobs: CiJob[]
  overallStatus: CiJob['status']
  overallConclusion: CiJob['conclusion']
}

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface NotificationAction {
  label: string
  url?: string
  event?: string // dispatches a CustomEvent with notification data as detail
}

export interface DockNotification {
  id: string
  title: string
  message: string
  type: NotificationType
  timeout?: number
  action?: NotificationAction
  actions?: NotificationAction[]
  source?: string
  projectDir?: string
  data?: Record<string, unknown>
  /** Auto-mark this notification as read after N milliseconds if still unread */
  autoReadMs?: number
}

export interface CiSetupStep {
  id: string
  label: string
  status: 'ok' | 'missing' | 'checking'
  helpText?: string
  helpUrl?: string
  actionId?: string
  actionLabel?: string
  /** Hint shown after the action button is clicked (e.g. "Complete the login..."). If omitted, a generic hint is shown. */
  actionHint?: string
  /** When set, the renderer shows inline input fields instead of (or alongside) the action button. */
  credentialFields?: { id: string; label: string; type: 'text' | 'password'; placeholder?: string }[]
}

export interface CiSetupStatus {
  ready: boolean
  providerName: string
  steps: CiSetupStep[]
}

export interface LogSection {
  name: string
  lines: string[]
  collapsed: boolean
}

/** Group jobs by their matrix key for UI rendering */
export function groupJobsByMatrix(jobs: CiJob[]): CiJobGroup[] {
  const groups = new Map<string, CiJob[]>()

  for (const job of jobs) {
    const key = job.matrixKey ?? job.name
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(job)
  }

  const result: CiJobGroup[] = []
  for (const [key, groupJobs] of groups) {
    const isMatrix = groupJobs.length > 1 || groupJobs[0].matrixKey !== null
    const overallStatus = computeOverallStatus(groupJobs)
    const overallConclusion = computeOverallConclusion(groupJobs)
    result.push({ key, isMatrix, jobs: groupJobs, overallStatus, overallConclusion })
  }
  return result
}

function computeOverallStatus(jobs: CiJob[]): CiJob['status'] {
  if (jobs.some((j) => j.status === 'in_progress')) return 'in_progress'
  if (jobs.some((j) => j.status === 'queued')) return 'queued'
  if (jobs.some((j) => j.status === 'waiting')) return 'waiting'
  return 'completed'
}

function computeOverallConclusion(jobs: CiJob[]): CiJob['conclusion'] {
  if (jobs.some((j) => j.status !== 'completed')) return null
  if (jobs.some((j) => j.conclusion === 'failure')) return 'failure'
  if (jobs.some((j) => j.conclusion === 'cancelled')) return 'cancelled'
  if (jobs.some((j) => j.conclusion === 'timed_out')) return 'timed_out'
  if (jobs.some((j) => j.conclusion === 'action_required')) return 'action_required'
  if (jobs.every((j) => j.conclusion === 'skipped')) return 'skipped'
  return 'success'
}
