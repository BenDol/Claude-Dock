/**
 * EditorOverlay — Monaco Editor with tab bar, rendered over the terminal grid.
 * Lazy-loaded via React.lazy() from DockPanelLayout.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useEditorStore } from '../stores/editor-store'
import { getDockApi } from '../lib/ipc-bridge'

// Configure Monaco loader — use local workers in both dev and production.
// In production the app is at resources/app.asar, but monaco-editor is in
// node_modules which gets extracted to app.asar.unpacked or stays in place.
// The @monaco-editor/react loader handles this automatically when we don't
// override paths — it fetches from CDN as fallback. For offline/Electron,
// we try the local path first.
try {
  const monacoPath = require('path').join(__dirname, '../node_modules/monaco-editor/min/vs')
  const fs = require('fs')
  if (fs.existsSync(monacoPath)) {
    loader.config({ paths: { vs: monacoPath } })
  }
  // If local path doesn't exist, @monaco-editor/react falls back to CDN
} catch {
  // In renderer context path/fs may not be available — CDN fallback is fine
}

const EditorOverlay: React.FC = () => {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs)
  const updateContent = useEditorStore((s) => s.updateContent)
  const markSaved = useEditorStore((s) => s.markSaved)

  const activeTab = tabs.find((t) => t.id === activeTabId) || null
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef<() => void>(() => {})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Editor font size (zoom) — persisted to localStorage
  const FONT_SIZE_KEY = 'editor-font-size'
  const DEFAULT_FONT_SIZE = 13
  const MIN_FONT_SIZE = 8
  const MAX_FONT_SIZE = 32
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = localStorage.getItem(FONT_SIZE_KEY)
      if (saved) {
        const n = parseInt(saved, 10)
        if (!isNaN(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n
      }
    } catch { /* ignore */ }
    return DEFAULT_FONT_SIZE
  })

  const applyFontSize = useCallback((size: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
    setFontSize(clamped)
    try { localStorage.setItem(FONT_SIZE_KEY, String(clamped)) } catch { /* ignore */ }
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize: clamped })
    }
  }, [])

  // Ctrl+MouseWheel and Ctrl++/- zoom for the editor
  useEffect(() => {
    const overlayEl = document.querySelector('.editor-overlay')
    if (!overlayEl) return

    const onWheel = (e: Event) => {
      const we = e as WheelEvent
      if (!(we.ctrlKey || we.metaKey)) return
      we.preventDefault()
      we.stopPropagation()
      applyFontSize(fontSize + (we.deltaY < 0 ? 1 : -1))
    }

    const onKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent
      if (!(ke.ctrlKey || ke.metaKey)) return
      if (ke.key === '=' || ke.key === '+') { ke.preventDefault(); ke.stopPropagation(); applyFontSize(fontSize + 1) }
      else if (ke.key === '-') { ke.preventDefault(); ke.stopPropagation(); applyFontSize(fontSize - 1) }
      else if (ke.key === '0') { ke.preventDefault(); ke.stopPropagation(); applyFontSize(DEFAULT_FONT_SIZE) }
    }

    overlayEl.addEventListener('wheel', onWheel, { passive: false, capture: true })
    overlayEl.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      overlayEl.removeEventListener('wheel', onWheel, { capture: true } as any)
      overlayEl.removeEventListener('keydown', onKeyDown, { capture: true } as any)
    }
  }, [fontSize, applyFontSize])

  // Theme — observe data-theme attribute for live changes
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') !== 'light' ? 'vs-dark' : 'vs'
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') !== 'light' ? 'vs-dark' : 'vs')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // Keep save ref current so Monaco's addAction always calls latest
  const handleSave = useCallback(async () => {
    if (!activeTab) return
    setSaving(true)
    setSaveError(null)
    try {
      const api = getDockApi()
      const result = await api.workspaceViewer.writeFile(activeTab.projectDir, activeTab.relativePath, activeTab.content)
      if (result.success) {
        markSaved(activeTab.id, activeTab.content)
      } else {
        setSaveError(result.error || 'Save failed')
        setTimeout(() => setSaveError(null), 4000)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
      setTimeout(() => setSaveError(null), 4000)
    }
    setSaving(false)
  }, [activeTab, markSaved])

  useEffect(() => { saveRef.current = handleSave }, [handleSave])

  // Handle tab close with dirty check
  const handleCloseTab = useCallback((id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const tab = useEditorStore.getState().tabs.find((t) => t.id === id)
    if (tab && tab.content !== tab.savedContent) {
      if (!confirm(`Unsaved changes in "${tab.fileName}". Close anyway?`)) return
    }
    closeTab(id)
  }, [closeTab])

  const handleCloseAll = useCallback(() => {
    const { tabs: currentTabs } = useEditorStore.getState()
    const dirty = currentTabs.some((t) => t.content !== t.savedContent)
    if (dirty && !confirm('Some files have unsaved changes. Close all?')) return
    closeAllTabs()
  }, [closeAllTabs])

  // Keyboard shortcuts — Ctrl+S and Ctrl+W
  // Don't handle Escape here — let Monaco use it for its own UI (search close, etc.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveRef.current()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault()
        const { activeTabId: id } = useEditorStore.getState()
        if (id) handleCloseTab(id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleCloseTab])

  // When active tab changes, focus the editor
  useEffect(() => {
    if (editorRef.current) {
      try { editorRef.current.focus() } catch { /* may fail during dispose */ }
    }
  }, [activeTabId])

  const handleEditorMount = useCallback((editor: MonacoEditor.IStandaloneCodeEditor) => {
    editorRef.current = editor
  }, [])

  const handleEditorChange = useCallback((value: string | undefined) => {
    const { activeTabId: id } = useEditorStore.getState()
    if (id && value !== undefined) {
      updateContent(id, value)
    }
  }, [updateContent])

  if (tabs.length === 0) return null

  return (
    <div className="editor-overlay">
      {/* Tab bar */}
      <div className="editor-tab-bar">
        {tabs.map((tab) => {
          const isDirty = tab.content !== tab.savedContent
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={`editor-tab${isActive ? ' editor-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) handleCloseTab(tab.id) }} // middle-click close
              title={tab.relativePath}
            >
              <span className="editor-tab-name">{tab.fileName}</span>
              {isDirty && <span className="editor-tab-dirty">●</span>}
              <button className="editor-tab-close" onClick={(e) => handleCloseTab(tab.id, e)}>×</button>
            </div>
          )
        })}
        <div className="editor-tab-spacer" />
        {saving && <span className="editor-saving">Saving...</span>}
        {saveError && <span className="editor-save-error">{saveError}</span>}
        <button className="editor-close-all" onClick={handleCloseAll} title="Close all tabs">×</button>
      </div>

      {/* Editor body */}
      <div className="editor-body">
        {activeTab ? (
          <Editor
            key={activeTab.id}
            theme={theme}
            language={activeTab.language}
            defaultValue={activeTab.content}
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            loading={<div className="editor-loading">Loading editor...</div>}
            options={{
              fontSize,
              fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              tabSize: 2,
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              autoIndent: 'full',
              formatOnPaste: false,
              formatOnType: false,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              padding: { top: 8 }
            }}
          />
        ) : (
          <div className="editor-loading">Select a tab to edit</div>
        )}
      </div>
    </div>
  )
}

export default EditorOverlay
