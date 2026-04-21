/**
 * Page-zoom helpers for the Voice plugin window.
 *
 * `zoom` is a non-standard CSS property but is stable in Chromium/Electron.
 * We expose it as a CSS custom property (`--voice-zoom`) on the document
 * root and apply it only to the scrollable body (`.voice-content`) and the
 * setup overlay — NOT to the whole document. Scoping it this way means:
 *   - chrome (titlebar / status header / tab bar) stays at natural size
 *     so `position: fixed` offsets like the setup card's `top: 38px` still
 *     line up with the unzoomed titlebar;
 *   - the scrollable region's children scale up with zoom while the region
 *     itself keeps its flex-computed size, so `overflow: auto` correctly
 *     triggers a scrollbar when zoomed content exceeds the viewport.
 *
 * Using a custom property (instead of writing `zoom` on a specific element)
 * lets us apply the saved zoom *before* React mounts — no flash of unzoomed
 * content on every window open.
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
    document.documentElement.style.setProperty('--voice-zoom', String(clamped))
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
