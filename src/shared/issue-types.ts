/**
 * Normalized issue types shared between main and renderer processes.
 * Each git provider (GitHub, GitLab) maps its raw API response into these shapes
 * so the renderer only has to handle one model.
 */

export type IssueState = 'open' | 'closed'
export type IssueStateReason = 'completed' | 'not_planned' | 'reopened'

export interface IssueUser {
  login: string
  name?: string
  avatarUrl?: string
}

export interface IssueLabel {
  name: string
  /** Hex color without the leading '#'. */
  color?: string
  description?: string
}

export interface IssueMilestone {
  /** GitHub uses number; GitLab uses number; keep widest to be safe. */
  id: number | string
  title: string
  state: 'open' | 'closed'
  dueOn?: string | null
}

export interface IssueComment {
  /** GitHub comment id / GitLab note id. */
  id: number | string
  author: IssueUser
  body: string
  createdAt: string
  updatedAt: string
  /** True if the current authenticated user wrote this comment — drives edit/delete UI. */
  isAuthor: boolean
  /** GitLab system notes (e.g. "assigned to @foo") — display-only, cannot be edited. */
  isSystem?: boolean
}

export interface Issue {
  /** GitHub issue number / GitLab iid. */
  id: number
  title: string
  /** Full issue body (not truncated — the detail view needs it). */
  body: string
  state: IssueState
  stateReason?: IssueStateReason | null
  author: IssueUser
  assignees: IssueUser[]
  labels: IssueLabel[]
  milestone: IssueMilestone | null
  commentsCount: number
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  url: string
  locked?: boolean
}

export interface IssueCreateRequest {
  title: string
  body: string
  labels?: string[]
  assignees?: string[]
  milestone?: number | string | null
}

export interface IssueUpdateRequest {
  title?: string
  body?: string
  state?: IssueState
  stateReason?: IssueStateReason
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
  /** null = clear milestone. */
  milestone?: number | string | null
}

export interface IssueActionResult {
  success: boolean
  issue?: Issue
  error?: string
}

/** Claude behavior classification derived from issue labels. */
export type IssueBehavior =
  | 'fix'
  | 'investigate'
  | 'design'
  | 'improve'
  | 'cleanup'
  | 'collaborate'
  | 'generic'

export interface IssueTypeProfile {
  /** Case-insensitive label patterns. Trailing '*' acts as wildcard. */
  labelPatterns: string[]
  behavior: IssueBehavior
  /** Optional user-authored text spliced into the Claude prompt when this profile matches. */
  promptAddendum?: string
}

export interface IssueTypeProfiles {
  profiles: IssueTypeProfile[]
  /** Fallback when no label pattern matches. */
  defaultBehavior: IssueBehavior
}

export interface IssueClassification {
  behavior: IssueBehavior
  /** 'label' when a profile matched, 'default' when the defaultBehavior was used. */
  source: 'label' | 'default'
  /** The matched profile's addendum, if any. */
  promptAddendum?: string
}

/** Lightweight comment shape included in IssueFixTask so Claude has conversational context. */
export interface IssueCommentPreview {
  author: string
  body: string
  createdAt: string
}
