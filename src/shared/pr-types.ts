export type PrState = 'open' | 'closed' | 'merged'
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null

export interface PullRequest {
  id: number
  title: string
  state: PrState
  sourceBranch: string
  targetBranch: string
  author: string
  url: string
  createdAt: string
  updatedAt: string
  isDraft: boolean
  labels: string[]
  reviewDecision: PrReviewDecision
  description: string
}

export interface PrCreateRequest {
  title: string
  body: string
  sourceBranch: string
  targetBranch: string
  isDraft?: boolean
}

export interface PrCreateResult {
  success: boolean
  pr?: PullRequest
  url?: string
  error?: string
}
