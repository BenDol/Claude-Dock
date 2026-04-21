/**
 * Thin shim around `require('uiohook-napi')` so tests can mock the native
 * module without pulling in its real .node binary. Vitest's `vi.mock`
 * intercepts ESM `import` but not Node's CJS `require`, so the loader has
 * to be importable as an ES module to be stubbable.
 */

export interface UiohookKeyboardEvent {
  keycode: number
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

export interface UiohookModule {
  uIOhook: {
    on(event: 'keydown' | 'keyup', listener: (e: UiohookKeyboardEvent) => void): void
    off?(event: 'keydown' | 'keyup', listener: (e: UiohookKeyboardEvent) => void): void
    removeAllListeners(): void
    start(): void
    stop(): void
  }
  UiohookKey: Record<string, number>
}

export function loadUiohookModule(): UiohookModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('uiohook-napi') as UiohookModule
}
