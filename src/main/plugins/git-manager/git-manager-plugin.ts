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
      key: 'commitMsgBackend',
      label: 'Commit message backend',
      description: 'Which engine generates commit messages. Local LLM runs entirely on-device with a tiny bundled model. Anthropic API uses Claude Haiku 4.5 over HTTPS — set ANTHROPIC_API_KEY in your environment.',
      type: 'select',
      options: [
        { value: 'local-llm',     label: 'Local LLM (on-device)' },
        { value: 'anthropic-api', label: 'Anthropic API (requires ANTHROPIC_API_KEY)' }
      ],
      defaultValue: 'local-llm'
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
    },
    {
      key: 'workingChangesIssuesEnabled',
      label: 'Issues panel in Working Changes',
      description: 'Show an Issues panel below the commit message so you can mark issues complete with a commit',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'inProgressStatusNames',
      label: 'In-progress status names',
      description: 'Comma-separated status names treated as "in progress" for the Working Changes issues filter',
      type: 'string',
      defaultValue: 'In Progress,Doing,In Review'
    },
    {
      key: 'completedStatusName',
      label: 'Completed status name',
      description: 'Status name to set on selected issues after a successful Commit & Push (GitLab native status / GitHub Projects v2). Falls back to closing the issue if no match.',
      type: 'string',
      defaultValue: 'Done'
    },
    {
      key: 'githubProjectNumber',
      label: 'GitHub Projects v2 number',
      description: 'Project number (visible in the project URL) used to resolve the Status field for issues. Leave empty to disable native status on GitHub.',
      type: 'number',
      placeholder: '0',
      defaultValue: 0
    },
    {
      key: 'githubProjectOwner',
      label: 'GitHub Projects v2 owner override',
      description: 'User or organization login that owns the project. Leave empty to infer from the repo remote.',
      type: 'string',
      defaultValue: ''
    },
    {
      key: 'commitCommentTemplate',
      label: 'Commit comment template',
      description: 'Posted on each selected issue after Commit & Push. Placeholders: {commitUrl}, {commitHash}, {commitSubject}, {branch}.',
      type: 'string',
      defaultValue: 'Addressed in {commitUrl}'
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
