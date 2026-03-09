/**
 * Tracks printable text sent to a PTY and provides undo/redo via backspaces.
 *
 * Design:
 * - Only printable characters are tracked (safe to erase with backspace)
 * - Consecutive keystrokes within GROUP_DELAY are grouped into one undo unit
 * - Paste operations (multi-char onData) are a single undo unit
 * - Enter, Ctrl+C, and other control chars are "barriers" that clear the stack
 *   (you can't undo an already-executed command)
 * - Escape sequences (arrows, etc.) finalize the current group but don't clear history
 */

const GROUP_DELAY = 300

interface UndoEntry {
  text: string
}

export class InputUndoManager {
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private currentGroup = ''
  private groupTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Call for every chunk sent to the PTY through user input.
   * Returns the data unchanged (pass-through) so it can be chained.
   */
  onInput(data: string): void {
    if (!this.isPrintable(data)) {
      this.finalizeGroup()
      // Barriers: clear all undo history (command was submitted or interrupted)
      if (data === '\r' || data === '\x03' || data === '\x04') {
        this.clear()
      }
      return
    }

    this.redoStack = []

    // Multi-char data (paste) → immediate standalone entry
    if (data.length > 1) {
      this.finalizeGroup()
      this.undoStack.push({ text: data })
      return
    }

    // Word-boundary characters finalize the current group first
    if (data === '.') {
      this.finalizeGroup()
      this.undoStack.push({ text: data })
      return
    }

    // Single char → group with recent keystrokes
    this.currentGroup += data
    if (this.groupTimer) clearTimeout(this.groupTimer)
    this.groupTimer = setTimeout(() => this.finalizeGroup(), GROUP_DELAY)
  }

  /**
   * Undo the last input group. Returns backspace string to send to PTY,
   * or null if nothing to undo.
   */
  undo(): string | null {
    this.finalizeGroup()
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push(entry)
    return '\x7f'.repeat(entry.text.length)
  }

  /**
   * Redo the last undone input. Returns text to re-send to PTY,
   * or null if nothing to redo.
   */
  redo(): string | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push(entry)
    return entry.text
  }

  /** Number of user-typed characters currently on the input line. */
  get inputLength(): number {
    let len = this.currentGroup.length
    for (const entry of this.undoStack) len += entry.text.length
    return len
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.currentGroup.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.currentGroup = ''
    if (this.groupTimer) {
      clearTimeout(this.groupTimer)
      this.groupTimer = null
    }
  }

  private finalizeGroup(): void {
    if (this.currentGroup.length > 0) {
      this.undoStack.push({ text: this.currentGroup })
      this.currentGroup = ''
    }
    if (this.groupTimer) {
      clearTimeout(this.groupTimer)
      this.groupTimer = null
    }
  }

  private isPrintable(data: string): boolean {
    if (data.length === 0) return false
    if (data.charCodeAt(0) === 0x1b) return false // escape sequences
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i)
      if (code < 32 || code === 127) return false
    }
    return true
  }
}
