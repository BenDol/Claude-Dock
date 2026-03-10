import { PluginManager } from './plugin-manager'
import { GitSyncPlugin } from './git-sync/git-sync-plugin'

export function registerPlugins(): void {
  const manager = PluginManager.getInstance()
  manager.register(new GitSyncPlugin())
}

export { PluginManager } from './plugin-manager'
