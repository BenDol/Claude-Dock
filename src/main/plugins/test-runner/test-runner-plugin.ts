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
      label: 'Auto-detect test frameworks when opening a project',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'runTimeoutMinutes',
      label: 'Test run timeout (minutes) — 0 to disable',
      type: 'number',
      defaultValue: 10
    },
    {
      key: 'verboseOutput',
      label: 'Show verbose output from test runners',
      type: 'boolean',
      defaultValue: true
    },
    {
      key: 'mavenProfiles',
      label: 'Maven profiles (-P) — comma-separated, applied to all Maven test runs',
      type: 'string',
      defaultValue: ''
    },
    {
      key: 'mavenExtraArgs',
      label: 'Maven extra arguments — appended to mvn test commands',
      type: 'string',
      defaultValue: ''
    },
    {
      key: 'gradleExtraArgs',
      label: 'Gradle extra arguments — appended to gradle test commands',
      type: 'string',
      defaultValue: ''
    },
    {
      key: 'vitestExtraArgs',
      label: 'Vitest extra arguments — appended to vitest run commands',
      type: 'string',
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
