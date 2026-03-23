import { useEffect, useRef, useCallback } from 'react'
import { useDockStore } from '../stores/dock-store'

/**
 * Roving tabindex keyboard navigation for the toolbar.
 * When focusRegion is 'toolbar', arrow keys move between buttons,
 * Enter/Space activates them, Escape returns focus to the grid.
 *
 * Toolbar buttons are discovered via `[data-toolbar-btn]` attributes
 * so dynamic buttons (plugins, runtime actions) are automatically included.
 */
export function useToolbarNavigation(containerRef: React.RefObject<HTMLElement | null>) {
  const activeIdx = useRef(0)
  const focusRegion = useDockStore((s) => s.focusRegion)
  const setFocusRegion = useDockStore((s) => s.setFocusRegion)

  const getButtons = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return []
    return Array.from(containerRef.current.querySelectorAll<HTMLElement>('[data-toolbar-btn]'))
  }, [containerRef])

  const focusButton = useCallback((idx: number) => {
    const btns = getButtons()
    if (btns.length === 0) return
    const clamped = Math.max(0, Math.min(btns.length - 1, idx))
    activeIdx.current = clamped
    btns.forEach((b, i) => {
      b.tabIndex = i === clamped ? 0 : -1
    })
    btns[clamped].focus()
  }, [getButtons])

  // When focusRegion becomes 'toolbar', focus the active button
  useEffect(() => {
    if (focusRegion !== 'toolbar') return
    // Short delay to let React render the toolbar before querying DOM
    const timer = setTimeout(() => focusButton(activeIdx.current), 0)
    return () => clearTimeout(timer)
  }, [focusRegion, focusButton])

  // Reset tabindexes when leaving the toolbar
  useEffect(() => {
    if (focusRegion === 'toolbar') return
    const btns = getButtons()
    btns.forEach((b) => { b.tabIndex = -1 })
  }, [focusRegion, getButtons])

  // Keyboard handler for arrow keys, Enter/Space, Escape
  useEffect(() => {
    if (focusRegion !== 'toolbar') return

    const handler = (e: KeyboardEvent) => {
      const btns = getButtons()
      if (btns.length === 0) return

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          const next = (activeIdx.current + 1) % btns.length
          focusButton(next)
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          const prev = (activeIdx.current - 1 + btns.length) % btns.length
          focusButton(prev)
          break
        }
        case 'Enter':
        case ' ': {
          e.preventDefault()
          btns[activeIdx.current]?.click()
          break
        }
        case 'Escape': {
          e.preventDefault()
          setFocusRegion('grid')
          // Dispatch refocus event so TerminalView re-focuses the active terminal
          window.dispatchEvent(new CustomEvent('refocus-terminal'))
          break
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusRegion, getButtons, focusButton, setFocusRegion])
}
