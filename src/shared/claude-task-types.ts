export interface ClaudeTaskBase {
  context?: string // optional user instructions
}

export interface CiFixTask extends ClaudeTaskBase {
  type: 'ci-fix'
  runId: number
  runName: string
  runNumber: number
  headBranch: string
  failedJobs: Array<{ id: number; name: string; failedSteps: string[] }>
  primaryFailedJobId?: number
}

export interface WriteTestsTask extends ClaudeTaskBase {
  type: 'write-tests'
  files: string[]
  commitHash?: string
  commitSubject?: string
}

export type ClaudeTaskRequest = CiFixTask | WriteTestsTask

export interface TaskMeta {
  label: string
  completionMarker?: string
}

export function getTaskMeta(task: ClaudeTaskRequest): TaskMeta {
  switch (task.type) {
    case 'ci-fix':
      return { label: 'Fix CI Failure', completionMarker: 'CI_FIX_COMPLETE' }
    case 'write-tests':
      return { label: 'Write Tests' }
  }
}
