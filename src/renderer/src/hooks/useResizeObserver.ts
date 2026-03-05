import { useEffect, useRef, useCallback } from 'react'

export function useResizeObserver(
  callback: (entry: ResizeObserverEntry) => void,
  debounceMs = 100
): React.RefCallback<HTMLElement> {
  const observerRef = useRef<ResizeObserver | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elementRef = useRef<HTMLElement | null>(null)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (observerRef.current) observerRef.current.disconnect()
    }
  }, [])

  const refCallback = useCallback(
    (node: HTMLElement | null) => {
      // Skip if same element — avoids observer recreation from unstable ref callbacks
      if (node === elementRef.current) return

      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }

      elementRef.current = node

      if (node) {
        observerRef.current = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => callbackRef.current(entry), debounceMs)
          }
        })
        observerRef.current.observe(node)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounceMs]
  )

  return refCallback
}
