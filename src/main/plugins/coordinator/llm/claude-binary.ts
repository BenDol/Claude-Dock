/**
 * Resolves the bundled `claude` native binary that ships with the
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` optional-dependency.
 *
 * Shared between the `claude-sdk` provider (passes via `pathToClaudeCodeExecutable`
 * to bypass the SDK's broken-in-asar internal resolver) and the `claude-cli`
 * provider (spawns the binary directly via child_process.spawn). Both need the
 * same lookup logic — keep it in one place so a layout change only fixes once.
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { log, logError } from '../../../logger'

/**
 * Resolve the bundled `claude` binary path.
 *
 * The SDK's internal resolver fails inside packaged Electron apps because its
 * computed path assumes the platform package is nested beneath
 * `@anthropic-ai/claude-agent-sdk/node_modules/...`, while npm actually hoists
 * it to the top-level `node_modules`. Inside `app.asar` Node's resolution
 * doesn't fall through the way it does on disk, so the SDK throws "Claude Code
 * native binary not found at <nested-asar-path>".
 *
 * We pre-compute the correct absolute path (mirroring the better-sqlite3
 * binding resolver in `plugins/memory/adapters/claudest-adapter.ts`).
 *
 * Exported (uncached) for tests. Production callers go through
 * `getClaudeBinaryPath` which memoizes the result and logs success/failure once.
 */
export function resolveClaudeBinaryPath(): string | undefined {
  const exeSuffix = process.platform === 'win32' ? '.exe' : ''
  const archKey = `${process.platform}-${process.arch}`
  // Linux musl sibling is the first hop on that platform — match the SDK's
  // own lookup order (see sdk.mjs / assistant.mjs LV function).
  const pkgNames = process.platform === 'linux'
    ? [`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
       `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`]
    : [`@anthropic-ai/claude-agent-sdk-${archKey}`]

  for (const pkg of pkgNames) {
    const binRel = `${pkg}/claude${exeSuffix}`
    // Layout A (hoisted): top-level `node_modules/<pkg>/claude.exe`. This is
    //   what modern npm produces when optionalDependencies can be hoisted.
    // Layout B (nested): `node_modules/@anthropic-ai/claude-agent-sdk/node_modules/<pkg>/claude.exe`.
    //   electron-builder's `install-app-deps` runs npm in production mode
    //   which often installs platform-specific optional-deps NESTED inside
    //   the parent package. Must check both.
    const relLayouts = [
      path.join('node_modules', pkg, `claude${exeSuffix}`),
      path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', pkg, `claude${exeSuffix}`)
    ]
    const candidates: string[] = []

    // 1) Packaged build: asarUnpack extracts the platform package under
    //    `resources/app.asar.unpacked/`. This MUST come before any
    //    require.resolve result, because Electron may return a virtual
    //    `app.asar/...` path that child_process.spawn can't execute.
    if (app.isPackaged && process.resourcesPath) {
      for (const rel of relLayouts) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', rel))
      }
    }

    // 2) Normal Node resolution — works in `electron-vite dev`.
    try {
      const resolved = require.resolve(binRel)
      // Rewrite asar virtual paths to their unpacked counterpart. Spawning
      // a binary from inside app.asar always fails — Electron transparently
      // redirects reads but not exec.
      const unpacked = resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
      candidates.push(unpacked)
      if (unpacked !== resolved) candidates.push(resolved)
    } catch { /* not resolvable from here */ }

    // 3) Dev fallback — app source tree, both layouts.
    try {
      const appPath = app.getAppPath()
      for (const rel of relLayouts) {
        candidates.push(path.join(appPath, rel))
      }
    } catch { /* app not ready — ignore */ }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch { /* ignore */ }
    }
  }
  return undefined
}

let cachedBinaryPath: string | undefined | null = null

/**
 * Memoized resolver. Logs success/failure on the first lookup so we don't spam
 * the log on every turn. Returns the path or undefined; callers fall back to
 * letting the SDK do its own lookup, or fail the spawn outright.
 */
export function getClaudeBinaryPath(): string | undefined {
  if (cachedBinaryPath === null) {
    cachedBinaryPath = resolveClaudeBinaryPath()
    if (cachedBinaryPath) {
      log('[claude-binary] resolved native binary', cachedBinaryPath)
    } else {
      logError('[claude-binary] could not locate bundled claude binary')
    }
  }
  return cachedBinaryPath
}

/** Test-only: drop the cache so tests that mutate `process.platform` see fresh lookups. */
export function __resetClaudeBinaryCacheForTests(): void {
  cachedBinaryPath = null
}
