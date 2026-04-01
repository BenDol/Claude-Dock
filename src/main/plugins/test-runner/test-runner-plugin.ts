import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerTestRunnerIpc, disposeTestRunnerIpc } from './test-runner-ipc'
import { TestRunnerWindowManager } from './test-runner-window'
import { getServices } from './services'

export { setServices } from './services'

export class TestRunnerPlugin implements DockPlugin {
  readonly id = 'test-runner'
  readonly name = 'Test Runner'
  readonly description = 'Generic test runner supporting multiple frameworks (Vitest, JUnit, etc.)'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true
  readonly settingsSchema: PluginSettingDef[] = [
    {
      key: 'autoDetectOnOpen',
      label: 'Auto-detect frameworks',
      description: 'Scan for test frameworks when opening a project',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'runTimeoutMinutes',
      label: 'Timeout (min)',
      description: 'Test run timeout in minutes. Set to 0 to disable.',
      type: 'number',
      placeholder: '10',
      defaultValue: 10
    },
    {
      key: 'verboseOutput',
      label: 'Verbose output',
      description: 'Show verbose output from test runners',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'mavenProfiles',
      label: 'Maven profiles',
      description: 'Comma-separated -P profiles applied to all Maven test runs',
      type: 'string',
      placeholder: 'local,test',
      defaultValue: ''
    },
    {
      key: 'mavenExtraArgs',
      label: 'Maven args',
      description: 'Extra arguments appended to mvn test commands',
      type: 'string',
      placeholder: '-Dskip.integration=true',
      defaultValue: ''
    },
    {
      key: 'gradleExtraArgs',
      label: 'Gradle args',
      description: 'Extra arguments appended to gradle test commands',
      type: 'string',
      placeholder: '--no-daemon',
      defaultValue: ''
    },
    {
      key: 'vitestExtraArgs',
      label: 'Vitest args',
      description: 'Extra arguments appended to vitest run commands',
      type: 'string',
      placeholder: '--reporter=verbose',
      defaultValue: ''
    }
  ]

  register(bus: PluginEventBus): void {
    try {
      registerTestRunnerIpc()
    } catch (err) {
      getServices().logError('[test-runner] IPC registration failed (non-fatal):', err)
    }

    bus.on('project:postClose', this.id, ({ projectDir }) => {
      try { TestRunnerWindowManager.getInstance().close(projectDir) } catch { /* non-fatal */ }
    })

    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        try { TestRunnerWindowManager.getInstance().close(projectDir) } catch { /* non-fatal */ }
      }
    })

    getServices().log('[test-runner] plugin registered')
  }

  dispose(): void {
    try { disposeTestRunnerIpc() } catch { /* ignore */ }
    try { TestRunnerWindowManager.getInstance().closeAll() } catch { /* ignore */ }
    getServices().log('[test-runner] plugin disposed')
  }
}
