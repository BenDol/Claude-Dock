import { useEffect, useRef, useCallback } from 'react'

export function useResizeObserver(
  callback: (entry: ResizeObserverEntry) => void,
  debounceMs = 100
): React.RefCallback<HTMLElement> {
  const observerRef = useRef<ResizeObserver | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elementRef = useRef<HTMLElement | null>(null)

  const debouncedCallback = useCallback(
    (entry: ResizeObserverEntry) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => callback(entry), debounceMs)
    },
    [callback, debounceMs]
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (observerRef.current) observerRef.current.disconnect()
    }
  }, [])

  const refCallback = useCallback(
    (node: HTMLElement | null) => {
      // Cleanup previous
      if (observerRef.current) {
        observerRef.current.disconnect()
      }

      elementRef.current = node

      if (node) {
        observerRef.current = new ResizeObserver((entries) => {
          for (const entry of entries) {
            debouncedCallback(entry)
          }
        })
        observerRef.current.observe(node)
      }
    },
    [debouncedCallback]
  )

  return refCallback
}
