import { useEffect, useRef, useCallback } from 'react'

interface MenuState {
  x: number
  y: number
  target: HTMLInputElement | HTMLTextAreaElement
}

/**
 * Global hook that shows a Cut / Copy / Paste / Select All context menu
 * on right-click for any <input> (text/number/url/search) or <textarea>.
 *
 * Mount once at the app root — it covers all current and future inputs.
 */
export function useInputContextMenu(): void {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<MenuState | null>(null)

  const close = useCallback(() => {
    if (menuRef.current) {
      menuRef.current.remove()
      menuRef.current = null
    }
    stateRef.current = null
  }, [])

  useEffect(() => {
    const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'number', 'password', ''])

    function isTextInput(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
      if (!el || !(el instanceof HTMLElement)) return false
      if (el instanceof HTMLTextAreaElement) return true
      if (el instanceof HTMLInputElement) {
        return TEXT_TYPES.has(el.type.toLowerCase())
      }
      return false
    }

    function handleContextMenu(e: MouseEvent) {
      const target = e.target
      if (!isTextInput(target)) return

      e.preventDefault()
      close()

      const hasSelection = (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0)
      const hasValue = target.value.length > 0
      const isReadOnly = target.readOnly || target.disabled

      // Build menu element
      const menu = document.createElement('div')
      menu.className = 'input-ctx-menu'

      const items: { label: string; shortcut: string; disabled: boolean; action: () => void }[] = []

      if (!isReadOnly) {
        items.push({
          label: 'Cut',
          shortcut: 'Ctrl+X',
          disabled: !hasSelection,
          action: () => { document.execCommand('cut'); close() }
        })
      }

      items.push({
        label: 'Copy',
        shortcut: 'Ctrl+C',
        disabled: !hasSelection,
        action: () => { document.execCommand('copy'); close() }
      })

      if (!isReadOnly) {
        items.push({
          label: 'Paste',
          shortcut: 'Ctrl+V',
          disabled: false,
          action: () => {
            target.focus()
            document.execCommand('paste')
            close()
          }
        })
      }

      // Separator
      items.push({ label: '---', shortcut: '', disabled: false, action: () => {} })

      items.push({
        label: 'Select All',
        shortcut: 'Ctrl+A',
        disabled: !hasValue,
        action: () => {
          target.focus()
          target.select()
          close()
        }
      })

      for (const item of items) {
        if (item.label === '---') {
          const sep = document.createElement('div')
          sep.className = 'input-ctx-separator'
          menu.appendChild(sep)
          continue
        }

        const row = document.createElement('div')
        row.className = 'input-ctx-item' + (item.disabled ? ' disabled' : '')
        row.innerHTML = `<span>${item.label}</span><span class="input-ctx-shortcut">${item.shortcut}</span>`

        if (!item.disabled) {
          row.addEventListener('mousedown', (ev) => {
            ev.preventDefault()
            item.action()
          })
        }

        menu.appendChild(row)
      }

      document.body.appendChild(menu)
      menuRef.current = menu

      // Position, accounting for zoom and viewport bounds
      const zoom = parseFloat(document.documentElement.style.zoom) || 1
      let x = e.clientX / zoom
      let y = e.clientY / zoom
      const vw = window.innerWidth / zoom
      const vh = window.innerHeight / zoom

      // Clamp to viewport
      const rect = menu.getBoundingClientRect()
      const mw = rect.width / zoom
      const mh = rect.height / zoom
      if (x + mw > vw) x = vw - mw - 4
      if (y + mh > vh) y = vh - mh - 4
      if (x < 0) x = 4
      if (y < 0) y = 4

      menu.style.left = `${x}px`
      menu.style.top = `${y}px`

      stateRef.current = { x, y, target }
    }

    function handleDismiss(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close()
      }
    }

    function handleKeyDismiss(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }

    function handleScroll() {
      close()
    }

    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('mousedown', handleDismiss, true)
    document.addEventListener('keydown', handleKeyDismiss, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('blur', close)

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu, true)
      document.removeEventListener('mousedown', handleDismiss, true)
      document.removeEventListener('keydown', handleKeyDismiss, true)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('blur', close)
      close()
    }
  }, [close])
}
