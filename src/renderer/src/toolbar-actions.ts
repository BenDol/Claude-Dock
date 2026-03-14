import type { ReactNode } from 'react'

export interface ToolbarAction {
  id: string
  title: string
  icon: ReactNode
  onClick: (projectDir: string) => void
  order?: number // lower = further left, default 100
  /** Optional async badge provider — return a number/string to show, or null to hide */
  getBadge?: (projectDir: string) => Promise<string | number | null>
  /** Optional async warning indicator — return true to show a small warning icon overlay */
  getWarning?: (projectDir: string) => Promise<boolean>
  /** Optional async status dot — return a color status or null to hide */
  getStatusDot?: (projectDir: string) => Promise<'success' | 'failure' | 'in_progress' | null>
}

const actions: ToolbarAction[] = []

export function registerToolbarAction(action: ToolbarAction): void {
  actions.push(action)
  actions.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function getToolbarActions(): readonly ToolbarAction[] {
  return actions
}
