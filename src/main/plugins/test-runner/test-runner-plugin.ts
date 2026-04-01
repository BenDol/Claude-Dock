import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
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

  register(bus: PluginEventBus): void {
    registerTestRunnerIpc()

    bus.on('project:postClose', this.id, ({ projectDir }) => {
      TestRunnerWindowManager.getInstance().close(projectDir)
    })

    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        TestRunnerWindowManager.getInstance().close(projectDir)
      }
    })

    getServices().log('[test-runner] plugin registered')
  }

  dispose(): void {
    disposeTestRunnerIpc()
    TestRunnerWindowManager.getInstance().closeAll()
    getServices().log('[test-runner] plugin disposed')
  }
}
