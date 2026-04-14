/**
 * Normalized issue types shared between main and renderer processes.
 * Each git provider (GitHub, GitLab) maps its raw API response into these shapes
 * so the renderer only has to handle one model.
 */

export type IssueState = 'open' | 'closed'
export type IssueStateReason = 'completed' | 'not_planned' | 'reopened'

/**
 * Provider-native status (e.g. GitHub Projects v2 single-select option,
 * or GitLab work-item status widget value). This is orthogonal to `state`:
 * an issue can be `open` with status "In Progress", or `closed` with
 * status "Done". Providers that don't support a native status concept
 * return a `supported: false` capability and never populate this field.
 */
export interface IssueStatus {
  /** Provider-opaque identifier (GraphQL ID for single-select option / work-item status). */
  id: string
  /** Display name (e.g. "In Progress", "Done"). */
  name: string
  /** Normalized category hint for badge coloring when `color` is absent. */
  category?: 'todo' | 'in_progress' | 'done' | 'triage' | 'canceled'
  /** Hex color without leading '#' when the provider supplies one. */
  color?: string
}

/** Capability probe result for native status support. */
export interface IssueStatusCapability {
  supported: boolean
  /** Human-readable explanation when unsupported (shown inline in UI). */
  reason?: string
}

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
  /**
   * Provider-native status, populated only when the provider supports it
   * (GitHub Projects v2 Status field, GitLab work-item status widget).
   * Null/undefined when the issue isn't linked to a project or the
   * provider capability is unavailable.
   */
  status?: IssueStatus | null
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
