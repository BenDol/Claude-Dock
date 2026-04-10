export type BugReportCategory = 'bug' | 'crash' | 'feature-request' | 'question'

export interface BugReportInput {
  title: string
  description: string
  category: BugReportCategory
  stepsToReproduce?: string
  githubHandle?: string
  includeLogs: boolean
  includeSystemInfo: boolean
}

export type BugReportResult =
  | { success: true; issueUrl: string; issueNumber: number }
  | { success: false; error: string }
