export interface ClaudeTaskBase {
  context?: string // optional user instructions
  /** The directory the task was triggered from (may differ from dock projectDir for submodules). */
  sourceDir?: string
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
  selectedDiff?: string
}

export interface ReferenceThisTask extends ClaudeTaskBase {
  type: 'reference-this'
  files: string[]
  commitHash?: string
  commitSubject?: string
  selectedDiff?: string
}

export interface MergeResolveTask extends ClaudeTaskBase {
  type: 'merge-resolve'
  filePath: string
  instructions: string
}

export type ClaudeTaskRequest = CiFixTask | WriteTestsTask | ReferenceThisTask | MergeResolveTask

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export interface TaskPermissions {
  allowedTools: string[]
  permissionMode: PermissionMode
}

export interface TaskMeta {
  label: string
  /** If false, the task terminal uses a persistent session (--session-id) instead of ephemeral mode */
  ephemeral?: boolean
  completionMarker?: string
  defaultPermissions: TaskPermissions
}

const CI_FIX_PERMISSIONS: TaskPermissions = {
  allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
  permissionMode: 'acceptEdits'
}

const WRITE_TESTS_PERMISSIONS: TaskPermissions = {
  allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
  permissionMode: 'acceptEdits'
}

const REFERENCE_THIS_PERMISSIONS: TaskPermissions = {
  allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
  permissionMode: 'default'
}

const MERGE_RESOLVE_PERMISSIONS: TaskPermissions = {
  allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
  permissionMode: 'acceptEdits'
}

export function getTaskMeta(task: ClaudeTaskRequest): TaskMeta {
  switch (task.type) {
    case 'ci-fix':
      return { label: 'Fix CI Failure', completionMarker: 'CI_FIX_COMPLETE', defaultPermissions: CI_FIX_PERMISSIONS }
    case 'write-tests':
      return { label: 'Write Tests', defaultPermissions: WRITE_TESTS_PERMISSIONS }
    case 'reference-this':
      return { label: 'Reference This', ephemeral: false, defaultPermissions: REFERENCE_THIS_PERMISSIONS }
    case 'merge-resolve':
      return { label: 'Resolve Merge Conflict', defaultPermissions: MERGE_RESOLVE_PERMISSIONS }
  }
}

export function buildClaudeFlags(perms: TaskPermissions): string {
  const parts: string[] = []
  if (perms.allowedTools.length > 0) {
    parts.push(`--allowedTools ${perms.allowedTools.join(',')}`)
  }
  if (perms.permissionMode !== 'default') {
    parts.push(`--permission-mode ${perms.permissionMode}`)
  }
  return parts.join(' ')
}
