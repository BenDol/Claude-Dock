import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerGitManagerIpc, disposeGitManagerIpc } from './git-manager-ipc'
import { GitManagerWindowManager } from './git-manager-window'
import { disposeCi, stopCiPollingForProject } from './ci/ci-ipc'
import { registerIssueIpc, disposeIssueIpc, stopIssuePollingForProject } from './issues/issue-ipc'
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
      label: 'Auto-generate commit messages',
      description: 'Automatically generate a commit message when files are staged',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'autoFetchAll',
      label: 'Auto fetch all',
      description: 'Run git fetch --all when opening and on a recurring interval',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'autoRecheckMinutes',
      label: 'Fetch interval (min)',
      description: 'Minutes between automatic fetches. Set to 0 to disable.',
      type: 'number',
      placeholder: '15',
      defaultValue: 15
    },
    {
      key: 'syntaxHighlighting',
      label: 'Syntax highlighting',
      description: 'Enable syntax highlighting in diff views',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'enableCiTab',
      label: 'CI tab',
      description: 'Show the CI/CD tab for viewing pipeline runs',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'enableIssuesTab',
      label: 'Issues tab',
      description: 'Show the Issues tab for viewing and editing GitHub/GitLab issues',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'enableIssueNotifications',
      label: 'Issue notifications',
      description: 'Notify when issues are assigned to you or receive new comments',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'forceParentIssueTracker',
      label: 'Submodules use parent issue tracker',
      description: 'When viewing a submodule, default the Issues tab to this (parent) repository\'s issue tracker. You can still toggle to the submodule\'s own tracker from the banner at the top of the tab.',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'issueTypeProfilesJson',
      label: 'Issue type profiles (JSON)',
      description: 'Advanced: JSON overrides for label→behavior mapping used by Solve with Claude. Leave empty for defaults.',
      type: 'string',
      defaultValue: ''
    },
    {
      key: 'showActionNotifications',
      label: 'CI notifications',
      description: 'Show desktop notifications when CI runs complete',
      type: 'boolean',
      defaultValue: true
    }
  ]

  register(bus: PluginEventBus): void {
    registerGitManagerIpc()
    registerIssueIpc()

    // Close git manager window and stop polling when the dock for that project closes
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      stopCiPollingForProject(projectDir)
      stopIssuePollingForProject(projectDir)
      GitManagerWindowManager.getInstance().close(projectDir)
    })

    // Close git manager window and stop polling when this plugin is disabled for a project
    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        stopCiPollingForProject(projectDir)
        stopIssuePollingForProject(projectDir)
        GitManagerWindowManager.getInstance().close(projectDir)
      }
    })

    getServices().log('[git-manager] plugin registered (hot-reload v3)')
  }

  dispose(): void {
    disposeCi()
    disposeIssueIpc()
    disposeGitManagerIpc()
    GitManagerWindowManager.getInstance().closeAll()
  }
}
