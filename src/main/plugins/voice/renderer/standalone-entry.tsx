/**
 * Self-contained renderer entry point for the voice plugin.
 *
 * Bundled by esbuild into a standalone IIFE for plugin-only updates.
 * Used when a renderer override exists in plugin-overrides/voice/renderer/.
 */

import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '@dock-renderer/global.css'
import './voice.css'
import VoiceApp from './VoiceApp'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'
import { applySavedZoom } from './voice-zoom'

// Apply persisted zoom synchronously, before React mounts, so the user does
// not see an un-zoomed flash on every reopen.
applySavedZoom()

function StandaloneApp() {
  useEffect(() => {
    const api = getDockApi()
    api.settings.get().then((settings) => {
      applyThemeToDocument(settings)
    })
    api.settings.onChange((settings) => {
      applyThemeToDocument(settings)
    })
  }, [])

  return <VoiceApp />
}

const root = createRoot(document.getElementById('root')!)
root.render(<StandaloneApp />)
