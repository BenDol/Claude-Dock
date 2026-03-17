import { type LazyExoticComponent, type ComponentType } from 'react'

export interface PluginView {
  pluginId: string
  queryParam: string
  component: LazyExoticComponent<ComponentType>
}

const pluginViews: PluginView[] = []

export function registerPluginView(view: PluginView): void {
  pluginViews.push(view)
}

export function getPluginViews(): readonly PluginView[] {
  return pluginViews
}
