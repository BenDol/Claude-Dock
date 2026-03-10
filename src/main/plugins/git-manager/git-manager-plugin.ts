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
    }
  ]

  register(bus: PluginEventBus): void {
    registerGitManagerIpc()

    // Close git manager window when the dock for that project closes
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      GitManagerWindowManager.getInstance().close(projectDir)
    })

    log('[git-manager] plugin registered')
  }

  dispose(): void {
    GitManagerWindowManager.getInstance().closeAll()
  }
}
