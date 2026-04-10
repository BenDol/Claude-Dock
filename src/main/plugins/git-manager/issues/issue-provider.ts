import type {
  Issue,
  IssueState,
  IssueCreateRequest,
  IssueUpdateRequest,
  IssueActionResult,
  IssueComment,
  IssueLabel,
  IssueUser,
  IssueMilestone,
  IssueStateReason
} from '../../../../shared/issue-types'
import type { CiSetupStatus } from '../../../../shared/ci-types'

/**
 * Provider-agnostic interface for issue tracker operations.
 * Both the GitHub (`gh` CLI) and GitLab (`glab` CLI) providers implement this
 * contract so the IPC layer can treat them interchangeably.
 *
 * Mutation methods return IssueActionResult with success=false on failure rather
 * than throwing, matching the PR/CI provider pattern.
 */
export interface IssueProvider {
  readonly name: string
  readonly providerKey: 'github' | 'gitlab'
  readonly cli: 'gh' | 'glab'

  // ---------- Setup (mirrors PrProvider / CiProvider) ----------
  isAvailable(projectDir: string): Promise<boolean>
  getSetupStatus(projectDir: string): Promise<CiSetupStatus>
  runSetupAction(
    projectDir: string,
    actionId: string,
    data?: Record<string, string>
  ): Promise<{ success: boolean; error?: string }>

  // ---------- Read ----------
  listIssues(projectDir: string, state?: IssueState | 'all'): Promise<Issue[]>
  getIssue(projectDir: string, id: number): Promise<Issue | null>
  listComments(projectDir: string, issueId: number): Promise<IssueComment[]>
  listLabels(projectDir: string): Promise<IssueLabel[]>
  listAssignableUsers(projectDir: string): Promise<IssueUser[]>
  listMilestones(projectDir: string): Promise<IssueMilestone[]>
  getCurrentUser(projectDir: string): Promise<IssueUser | null>
  getDefaultBranch(projectDir: string): Promise<string>

  // ---------- Create + batched update ----------
  createIssue(projectDir: string, req: IssueCreateRequest): Promise<IssueActionResult>
  /** Single round-trip mutation — used by the detail view's Save button. */
  updateIssue(
    projectDir: string,
    id: number,
    req: IssueUpdateRequest
  ): Promise<IssueActionResult>

  // ---------- Granular mutations (for live chip edits) ----------
  setState(
    projectDir: string,
    id: number,
    state: IssueState,
    reason?: IssueStateReason
  ): Promise<IssueActionResult>
  addLabel(projectDir: string, id: number, labels: string[]): Promise<IssueActionResult>
  removeLabel(projectDir: string, id: number, labels: string[]): Promise<IssueActionResult>
  addAssignee(projectDir: string, id: number, logins: string[]): Promise<IssueActionResult>
  removeAssignee(projectDir: string, id: number, logins: string[]): Promise<IssueActionResult>
  setMilestone(
    projectDir: string,
    id: number,
    milestone: number | string | null
  ): Promise<IssueActionResult>

  // ---------- Comments ----------
  addComment(projectDir: string, id: number, body: string): Promise<IssueComment | null>
  updateComment(
    projectDir: string,
    issueId: number,
    commentId: number | string,
    body: string
  ): Promise<IssueComment | null>
  deleteComment(
    projectDir: string,
    issueId: number,
    commentId: number | string
  ): Promise<boolean>
}
