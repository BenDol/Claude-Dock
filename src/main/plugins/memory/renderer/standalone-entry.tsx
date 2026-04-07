/**
 * Self-contained renderer entry point for the memory plugin.
 *
 * Bundled by esbuild into a standalone IIFE for plugin-only updates.
 * Used when a renderer override exists in plugin-overrides/memory/renderer/.
 */

import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '@dock-renderer/global.css'
import './memory.css'
import MemoryApp from './MemoryApp'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'

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

  return <MemoryApp />
}

const root = createRoot(document.getElementById('root')!)
root.render(<StandaloneApp />)
