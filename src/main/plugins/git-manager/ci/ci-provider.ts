import type { CiWorkflow, CiWorkflowRun, CiJob } from '../../../../shared/ci-types'

export interface CiProvider {
  readonly name: string
  isAvailable(projectDir: string): Promise<boolean>
  getWorkflows(projectDir: string): Promise<CiWorkflow[]>
  getWorkflowRuns(projectDir: string, workflowId: number, page: number, perPage: number): Promise<CiWorkflowRun[]>
  getActiveRuns(projectDir: string): Promise<CiWorkflowRun[]>
  getRun(projectDir: string, runId: number): Promise<CiWorkflowRun | null>
  getRunJobs(projectDir: string, runId: number): Promise<CiJob[]>
  cancelRun(projectDir: string, runId: number): Promise<void>
  rerunFailedJobs(projectDir: string, runId: number): Promise<void>
  getRunUrl(projectDir: string, runId: number): Promise<string>
}
