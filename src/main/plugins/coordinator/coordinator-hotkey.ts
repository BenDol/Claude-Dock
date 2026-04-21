/**
 * Global Shift+Shift hotkey for the Coordinator.
 *
 * Primary implementation uses uiohook-napi (a native library that hooks
 * OS-level key events — works even when Electron is not focused). The native
 * module is a soft dependency: if it fails to load (missing prebuilt,
 * antivirus block, sandbox restriction, missing macOS Accessibility perm),
 * we fall back to Electron's built-in `globalShortcut` — still global but
 * requires a chord like Ctrl+Shift+K instead of a pure double-tap.
 *
 * The detector tracks the time of the last Shift keyup. If the next Shift
 * keydown arrives within `doubleTapMs` AND no other key was pressed in the
 * gap, we fire. Holding Shift with another key (e.g. Shift+A, Shift+Tab)
 * cancels the armed state so typing capital letters never triggers the
 * hotkey.
 */
import { BrowserWindow, globalShortcut } from 'electron'
import { DockManager } from '../../dock-manager'
import { CoordinatorWindowManager } from './coordinator-window'
import { getCoordinatorConfig } from './coordinator-settings-store'
import { getServices } from './services'
import { loadUiohookModule, type UiohookKeyboardEvent, type UiohookModule } from './uiohook-loader'
import type { CoordinatorHotkeyStatus } from '../../../shared/coordinator-types'

type UiohookMode = 'uiohook' | 'globalShortcut' | 'none'

const svc = () => getServices()

export class CoordinatorHotkeyService {
  private static instance: CoordinatorHotkeyService

  private mode: UiohookMode = 'none'
  private error: string | undefined
  private enabled = false

  // uiohook state
  private uiohook: UiohookModule | null = null
  private keyDownListener: ((e: UiohookKeyboardEvent) => void) | null = null
  private keyUpListener: ((e: UiohookKeyboardEvent) => void) | null = null
  private shiftKeycodes = new Set<number>()
  private lastShiftUp = 0
  /** Set to true on any non-Shift keydown between the armed keyup and the next Shift keydown. */
  private interrupted = false

  // globalShortcut fallback state
  private registeredAccelerator: string | null = null

  static getInstance(): CoordinatorHotkeyService {
    if (!CoordinatorHotkeyService.instance) {
      CoordinatorHotkeyService.instance = new CoordinatorHotkeyService()
    }
    return CoordinatorHotkeyService.instance
  }

  getStatus(): CoordinatorHotkeyStatus {
    return {
      ready: this.enabled && this.mode !== 'none',
      using: this.mode,
      error: this.error
    }
  }

  /** Enable the hotkey per current config. Idempotent. */
  start(): void {
    const cfg = getCoordinatorConfig()
    if (!cfg.hotkeyEnabled) {
      this.stop()
      svc().log('[coordinator-hotkey] disabled by config')
      return
    }
    if (this.enabled) return
    this.enabled = true
    this.error = undefined

    if (this.tryStartUiohook()) {
      this.mode = 'uiohook'
      svc().log('[coordinator-hotkey] started using uiohook-napi')
      return
    }
    if (this.tryStartGlobalShortcut(cfg.fallbackGlobalShortcut)) {
      this.mode = 'globalShortcut'
      svc().log(`[coordinator-hotkey] started using globalShortcut (${cfg.fallbackGlobalShortcut})`)
      return
    }
    this.mode = 'none'
    svc().logError('[coordinator-hotkey] failed to register any hotkey backend', this.error)
  }

  /** Disable the hotkey and release OS resources. Idempotent. */
  stop(): void {
    this.stopUiohook()
    this.stopGlobalShortcut()
    this.enabled = false
    this.mode = 'none'
  }

  /** Re-apply current config (e.g. after settings change). */
  restart(): void {
    this.stop()
    this.start()
  }

  // --- uiohook backend -----------------------------------------------------

  private tryStartUiohook(): boolean {
    let mod: UiohookModule
    try {
      mod = loadUiohookModule()
    } catch (err) {
      this.error = `uiohook-napi load failed: ${(err as Error).message}`
      svc().log('[coordinator-hotkey]', this.error)
      return false
    }
    this.uiohook = mod

    const { UiohookKey } = mod
    // UiohookKey has Shift, ShiftLeft, ShiftRight depending on platform/build.
    // Grab whichever codes are defined — all of them mean "the user pressed shift".
    this.shiftKeycodes.clear()
    for (const key of ['Shift', 'ShiftLeft', 'ShiftRight'] as const) {
      const code = UiohookKey?.[key]
      if (typeof code === 'number') this.shiftKeycodes.add(code)
    }
    if (this.shiftKeycodes.size === 0) {
      this.error = 'uiohook-napi loaded but no Shift keycode found in UiohookKey map'
      svc().logError('[coordinator-hotkey]', this.error)
      this.uiohook = null
      return false
    }

    this.lastShiftUp = 0
    this.interrupted = false

    this.keyDownListener = (e) => this.onUiohookKeyDown(e)
    this.keyUpListener = (e) => this.onUiohookKeyUp(e)

    try {
      mod.uIOhook.on('keydown', this.keyDownListener)
      mod.uIOhook.on('keyup', this.keyUpListener)
      mod.uIOhook.start()
      return true
    } catch (err) {
      this.error = `uiohook-napi start failed: ${(err as Error).message}`
      svc().logError('[coordinator-hotkey]', this.error)
      this.stopUiohook()
      return false
    }
  }

  private stopUiohook(): void {
    if (!this.uiohook) return
    try {
      if (this.keyDownListener) {
        this.uiohook.uIOhook.off?.('keydown', this.keyDownListener)
      }
      if (this.keyUpListener) {
        this.uiohook.uIOhook.off?.('keyup', this.keyUpListener)
      }
      // Defensive — some versions lack `off`; removeAllListeners covers us
      // even at the cost of dropping any future hotkeys from other plugins.
      // Since we're the only uiohook consumer today, this is safe.
      if (!this.uiohook.uIOhook.off) this.uiohook.uIOhook.removeAllListeners()
      this.uiohook.uIOhook.stop()
    } catch (err) {
      svc().logError('[coordinator-hotkey] uiohook stop failed', err)
    }
    this.uiohook = null
    this.keyDownListener = null
    this.keyUpListener = null
    this.shiftKeycodes.clear()
  }

  private onUiohookKeyDown(e: UiohookKeyboardEvent): void {
    if (this.shiftKeycodes.has(e.keycode)) {
      // If this Shift-down lands within doubleTapMs of the last Shift-up
      // (and no other key was pressed in between), fire.
      if (!this.interrupted && this.lastShiftUp > 0) {
        const gap = Date.now() - this.lastShiftUp
        const cfg = getCoordinatorConfig()
        if (gap <= cfg.hotkeyDoubleTapMs) {
          this.lastShiftUp = 0
          this.interrupted = false
          this.fire()
          return
        }
      }
      // Fresh first press — wait for its keyup to arm.
      return
    }
    // Any non-Shift keydown disarms the double-tap window. This prevents
    // Shift+Letter (typing capitals) or Shift+Tab from counting as the gesture.
    this.interrupted = true
    this.lastShiftUp = 0
  }

  private onUiohookKeyUp(e: UiohookKeyboardEvent): void {
    if (!this.shiftKeycodes.has(e.keycode)) return
    if (this.interrupted) {
      // A non-Shift key was pressed between the Shift-down and Shift-up —
      // this was part of a chord (e.g. Shift+A). Reset.
      this.interrupted = false
      this.lastShiftUp = 0
      return
    }
    this.lastShiftUp = Date.now()
  }

  // --- globalShortcut fallback --------------------------------------------

  private tryStartGlobalShortcut(accelerator: string): boolean {
    if (!accelerator) {
      this.error = 'no fallbackGlobalShortcut accelerator configured'
      return false
    }
    try {
      if (globalShortcut.isRegistered(accelerator)) {
        this.error = `accelerator ${accelerator} is already registered by another process`
        svc().logError('[coordinator-hotkey]', this.error)
        return false
      }
      const ok = globalShortcut.register(accelerator, () => this.fire())
      if (!ok) {
        this.error = `globalShortcut.register returned false for ${accelerator}`
        svc().logError('[coordinator-hotkey]', this.error)
        return false
      }
      this.registeredAccelerator = accelerator
      return true
    } catch (err) {
      this.error = `globalShortcut register failed: ${(err as Error).message}`
      svc().logError('[coordinator-hotkey]', this.error)
      return false
    }
  }

  private stopGlobalShortcut(): void {
    if (!this.registeredAccelerator) return
    try {
      globalShortcut.unregister(this.registeredAccelerator)
    } catch (err) {
      svc().logError('[coordinator-hotkey] globalShortcut unregister failed', err)
    }
    this.registeredAccelerator = null
  }

  // --- fire dispatch -------------------------------------------------------

  /**
   * Pick the project to target and route through the standard OPEN flow.
   * Priority: focused dock → floating coordinator with a dock match →
   * most-recently-created dock → nothing.
   */
  private fire(): void {
    const projectDir = this.pickTargetProject()
    if (!projectDir) {
      svc().log('[coordinator-hotkey] fired but no dock is open — ignoring')
      return
    }
    const cfg = getCoordinatorConfig()
    if (cfg.floatingWindowByDefault) {
      CoordinatorWindowManager.getInstance()
        .open(projectDir)
        .catch((err) => svc().logError('[coordinator-hotkey] open (floating) failed', err))
      return
    }
    const win = svc().focusMainWindow(projectDir)
    if (!win) {
      svc().logError('[coordinator-hotkey] no dock window for', projectDir)
      return
    }
    // Reuse the same renderer request the IPC OPEN handler fires — the dock
    // renderer activates the coordinator panel and focuses its input.
    try {
      // Lazy-require to avoid a circular: coordinator-hotkey → ipc-channels is fine,
      // but keeping the require inline mirrors how coordinator-ipc broadcasts it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IPC } = require('../../../shared/ipc-channels') as typeof import('../../../shared/ipc-channels')
      win.webContents.send(IPC.COORDINATOR_OPEN_REQUEST, projectDir)
    } catch (err) {
      svc().logError('[coordinator-hotkey] failed to notify renderer', err)
    }
  }

  private pickTargetProject(): string | null {
    const docks = DockManager.getInstance().getAllDocks()
    if (docks.length === 0) return null

    // 1. Focused dock window.
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) {
      const match = docks.find((d) => !d.window.isDestroyed() && d.window.id === focused.id)
      if (match) return match.projectDir
    }

    // 2. If a floating coordinator is focused, prefer its project.
    if (focused) {
      const floatingDirs = docks
        .map((d) => d.projectDir)
        .filter((dir) => {
          const w = CoordinatorWindowManager.getInstance().getWindow(dir)
          return !!w && !w.isDestroyed() && w.id === focused.id
        })
      if (floatingDirs.length > 0) return floatingDirs[0]
    }

    // 3. Most-recently created dock (last in insertion order).
    for (let i = docks.length - 1; i >= 0; i--) {
      if (!docks[i].window.isDestroyed()) return docks[i].projectDir
    }
    return null
  }
}
