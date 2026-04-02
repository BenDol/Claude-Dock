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
  // Max-wait cap: during CSS transitions the observer fires every frame, resetting
  // the debounce timer indefinitely. The cap ensures a fit runs within a bounded
  // time even while resize events keep arriving.
  const maxWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (maxWaitRef.current) clearTimeout(maxWaitRef.current)
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
            timerRef.current = setTimeout(() => {
              if (maxWaitRef.current) { clearTimeout(maxWaitRef.current); maxWaitRef.current = null }
              callbackRef.current(entry)
            }, debounceMs)
            // Start max-wait timer on the first event in a burst — guarantees the
            // callback fires within debounceMs * 3 even if resize events keep arriving
            if (!maxWaitRef.current) {
              maxWaitRef.current = setTimeout(() => {
                maxWaitRef.current = null
                if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
                callbackRef.current(entry)
              }, debounceMs * 3)
            }
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
