import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerGitManagerIpc, disposeGitManagerIpc } from './git-manager-ipc'
import { GitManagerWindowManager } from './git-manager-window'
import { disposeCi, stopCiPollingForProject } from './ci/ci-ipc'
import { getServices } from './services'

// Re-export setServices so standalone builds can receive service injection from the host app
export { setServices } from './services'

export class GitManagerPlugin implements DockPlugin {
  readonly id = 'git-manager'
  readonly name = 'Git Manager'
  readonly description = 'Visual git repository manager with commit log, branches, and diff viewer'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true
  readonly settingsSchema: PluginSettingDef[] = [
    {
      key: 'autoGenerateCommitMsg',
      label: 'Auto-generate commit message when staging files',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'autoFetchAll',
      label: 'Auto Fetch All — automatically run git fetch --all on open and on interval',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'autoRecheckMinutes',
      label: 'Auto recheck time (minutes) — 0 to disable recurring fetch',
      type: 'number',
      defaultValue: 15
    },
    {
      key: 'syntaxHighlighting',
      label: 'Syntax highlighting in diff views',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'enableCiTab',
      label: 'Show CI tab',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'showActionNotifications',
      label: 'Show notifications when CI runs complete',
      type: 'boolean',
      defaultValue: true
    }
  ]

  register(bus: PluginEventBus): void {
    registerGitManagerIpc()

    // Close git manager window and stop CI polling when the dock for that project closes
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      stopCiPollingForProject(projectDir)
      GitManagerWindowManager.getInstance().close(projectDir)
    })

    // Close git manager window and stop CI polling when this plugin is disabled for a project
    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        stopCiPollingForProject(projectDir)
        GitManagerWindowManager.getInstance().close(projectDir)
      }
    })

    getServices().log('[git-manager] plugin registered (hot-reload v3)')
  }

  dispose(): void {
    disposeCi()
    disposeGitManagerIpc()
    GitManagerWindowManager.getInstance().closeAll()
  }
}
