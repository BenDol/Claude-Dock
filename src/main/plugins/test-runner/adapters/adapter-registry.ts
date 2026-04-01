import type { RunnerAdapter, DetectionResult } from './runner-adapter'
import { VitestAdapter } from './vitest-adapter'
import { JUnitMavenAdapter, JUnitGradleAdapter } from './junit-adapter'

const adapters = new Map<string, RunnerAdapter>()

function register(adapter: RunnerAdapter): void {
  adapters.set(adapter.id, adapter)
}

// Built-in adapters
register(new VitestAdapter())
register(new JUnitMavenAdapter())
register(new JUnitGradleAdapter())

export function getAdapter(id: string): RunnerAdapter | undefined {
  return adapters.get(id)
}

export function getAllAdapters(): RunnerAdapter[] {
  return [...adapters.values()]
}

/** Detect all available test frameworks in a project directory. */
export async function detectAdapters(projectDir: string): Promise<DetectionResult[]> {
  const results: DetectionResult[] = []
  await Promise.all(
    [...adapters.values()].map(async (adapter) => {
      try {
        const result = await adapter.detect(projectDir)
        if (result) results.push(result)
      } catch { /* skip failed detections */ }
    })
  )
  return results.sort((a, b) => b.confidence - a.confidence)
}
