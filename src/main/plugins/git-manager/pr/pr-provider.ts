import type { PullRequest, PrState, PrCreateRequest, PrCreateResult } from '../../../../shared/pr-types'
import type { CiSetupStatus } from '../../../../shared/ci-types'

export interface PrProvider {
  readonly name: string
  readonly providerKey: string

  isAvailable(projectDir: string): Promise<boolean>
  getSetupStatus(projectDir: string): Promise<CiSetupStatus>
  runSetupAction(projectDir: string, actionId: string, data?: Record<string, string>): Promise<{ success: boolean; error?: string }>

  listPrs(projectDir: string, state?: PrState): Promise<PullRequest[]>
  getPr(projectDir: string, id: number): Promise<PullRequest | null>
  createPr(projectDir: string, request: PrCreateRequest): Promise<PrCreateResult>
  getDefaultBranch(projectDir: string): Promise<string>
  /** Construct a web URL for creating a new PR in the browser (fallback). */
  getNewPrUrl(projectDir: string, sourceBranch: string, targetBranch: string): Promise<string | null>
}
