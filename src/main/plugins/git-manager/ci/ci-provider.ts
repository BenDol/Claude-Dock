import type { CiWorkflow, CiWorkflowRun, CiJob, CiSetupStatus, LogSection } from '../../../../shared/ci-types'

export interface CiProvider {
  readonly name: string
  readonly providerKey: string
  isAvailable(projectDir: string): Promise<boolean>
  getSetupStatus(projectDir: string): Promise<CiSetupStatus>
  runSetupAction(projectDir: string, actionId: string, data?: Record<string, string>): Promise<{ success: boolean; error?: string }>
  getWorkflows(projectDir: string): Promise<CiWorkflow[]>
  getWorkflowRuns(projectDir: string, workflowId: number, page: number, perPage: number): Promise<CiWorkflowRun[]>
  getActiveRuns(projectDir: string): Promise<CiWorkflowRun[]>
  getRun(projectDir: string, runId: number): Promise<CiWorkflowRun | null>
  getRunJobs(projectDir: string, runId: number): Promise<CiJob[]>
  cancelRun(projectDir: string, runId: number): Promise<void>
  rerunFailedJobs(projectDir: string, runId: number): Promise<void>
  dispatchWorkflow(projectDir: string, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void>
  getJobLog(projectDir: string, jobId: number): Promise<string>
  getRunUrl(projectDir: string, runId: number): Promise<string>
  parseLogSections(rawLog: string): LogSection[]
}
