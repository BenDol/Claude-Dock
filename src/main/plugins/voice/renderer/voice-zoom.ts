/**
 * Page-zoom helpers for the Voice plugin window.
 *
 * `document.documentElement.style.zoom` is a non-standard CSS property but is
 * stable in Chromium (and therefore Electron). It scales pixel values for
 * descendants — including `position: fixed` overlays — so the setup-overlay
 * `top: 38px` offset stays aligned with the titlebar at any zoom level.
 *
 * Split out so the entry can apply the saved zoom *before* React mounts,
 * which avoids a flash of unzoomed content on every window open.
 */

const ZOOM_KEY = 'voice-zoom'
export const MIN_ZOOM = 0.6
export const MAX_ZOOM = 1.6
export const ZOOM_STEP = 0.1

export function readSavedZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY)
    if (!raw) return 1
    const v = parseFloat(raw)
    if (isNaN(v) || v < MIN_ZOOM || v > MAX_ZOOM) return 1
    return v
  } catch {
    return 1
  }
}

/** Apply a zoom value to the document, clamped + rounded to 2dp. */
export function applyZoom(z: number): number {
  const clamped = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100
  if (typeof document !== 'undefined' && document.documentElement) {
    // The DOM property is `zoom` despite the type defs not always exposing it.
    ;(document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(clamped)
  }
  try { localStorage.setItem(ZOOM_KEY, String(clamped)) } catch { /* ignore */ }
  return clamped
}

/** Apply whatever zoom is in storage right now. Safe to call before React mounts. */
export function applySavedZoom(): number {
  return applyZoom(readSavedZoom())
}

/** Return true when the user is currently typing into something we should not steal keys from. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  return false
}
