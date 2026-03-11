import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerGitManagerIpc } from './git-manager-ipc'
import { GitManagerWindowManager } from './git-manager-window'
import { log } from '../../logger'

export class GitManagerPlugin implements DockPlugin {
  readonly id = 'git-manager'
  readonly name = 'Git Manager'
  readonly description = 'Visual git repository manager with commit log, branches, and diff viewer'
  readonly defaultEnabled = false
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
    }
  ]

  register(bus: PluginEventBus): void {
    registerGitManagerIpc()

    // Close git manager window when the dock for that project closes
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      GitManagerWindowManager.getInstance().close(projectDir)
    })

    // Close git manager window when this plugin is disabled for a project
    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        GitManagerWindowManager.getInstance().close(projectDir)
      }
    })

    log('[git-manager] plugin registered')
  }

  dispose(): void {
    GitManagerWindowManager.getInstance().closeAll()
  }
}
