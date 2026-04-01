/**
 * Registry for dockable panels. Plugins call registerPanel() from their
 * renderer index.ts to add panels to the dock edge panel system.
 *
 * Similar pattern to toolbar-actions.ts and plugin-views.ts.
 */
import type { LazyExoticComponent, ComponentType, ReactNode } from 'react'

export interface PanelProps {
  projectDir: string
}

export interface PanelRegistration {
  id: string
  pluginId: string
  title: string
  icon: ReactNode
  component: LazyExoticComponent<ComponentType<PanelProps>>
  headerActions?: LazyExoticComponent<ComponentType<PanelProps>>
  defaultPosition: 'left' | 'right' | 'top' | 'bottom'
  defaultSize: number
  minSize?: number
  maxSize?: number
}

const panels: PanelRegistration[] = []

export function registerPanel(panel: PanelRegistration): void {
  if (!panels.find((p) => p.id === panel.id)) {
    panels.push(panel)
  }
}

export function getPanels(): readonly PanelRegistration[] {
  return panels
}

export function getPanel(id: string): PanelRegistration | undefined {
  return panels.find((p) => p.id === id)
}
