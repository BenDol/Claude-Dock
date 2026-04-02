/**
 * EditorOverlay — Monaco Editor with tab bar, rendered over the terminal grid.
 * Lazy-loaded via React.lazy() from DockPanelLayout.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type * as MonacoNS from 'monaco-editor'
import { useEditorStore, isBinaryFile } from '../stores/editor-store'
import { getDockApi } from '../lib/ipc-bridge'
import { useDockStore } from '../stores/dock-store'

// Configure Monaco to use bundled workers instead of CDN.
// In Electron with contextIsolation, we can't use require('path')/require('fs').
// Instead, import monaco-editor directly and pass it to the loader — this
// makes @monaco-editor/react use the already-bundled monaco instead of
// trying to load it from CDN.
import * as monacoEditor from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

// Configure Monaco workers to use bundled files (not CDN)
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    return new editorWorker()
  }
}

loader.config({ monaco: monacoEditor })

// Safety net: suppress Monaco "Model not found" errors from crashing the renderer.
// This happens when "Peek References" tries to resolve models for files that aren't
// loaded as editor models (e.g., files in node_modules or outside the workspace).
window.addEventListener('error', (event) => {
  if (event.error?.message === 'Model not found') {
    event.preventDefault()
    console.warn('[EditorOverlay] Suppressed "Model not found" error — file not available for reference resolution')
  }
})

const FONT_SIZE_KEY = 'editor-font-size'
const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
/** Minimum pixels of drag movement before we consider it a real drag (prevents accidental detach on click) */
const MIN_DRAG_DISTANCE = 20

const EditorOverlay: React.FC = () => {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs)
  const updateContent = useEditorStore((s) => s.updateContent)
  const markSaved = useEditorStore((s) => s.markSaved)
  const navBackCount = useEditorStore((s) => s.navBack.length)
  const navForwardCount = useEditorStore((s) => s.navForward.length)

  const moveTab = useEditorStore((s) => s.moveTab)
  const removeTab = useEditorStore((s) => s.removeTab)

  const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal)
  const projectDir = useDockStore((s) => s.projectDir)

  const activeTab = tabs.find((t) => t.id === activeTabId) || null
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof MonacoNS | null>(null)
  const langServicesInitRef = useRef(false)
  const extraLibsRef = useRef<Map<string, { dispose: () => void }>>(new Map())
  const saveRef = useRef<() => void>(() => {})
  const tabBarRef = useRef<HTMLDivElement>(null)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
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
      const result = await api.workspace.writeFile(activeTab.projectDir, activeTab.relativePath, activeTab.content)
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

  // Tab reorder via drag
  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string, idx: number) => {
    e.dataTransfer.setData('application/x-editor-tab', JSON.stringify({ tabId, idx }))
    e.dataTransfer.effectAllowed = 'move'
    dragStartPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleTabDragOver = useCallback((e: React.DragEvent, idx: number) => {
    if (!e.dataTransfer.types.includes('application/x-editor-tab')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIdx(idx)
  }, [])

  const handleTabDrop = useCallback((e: React.DragEvent, toIdx: number) => {
    setDragOverIdx(null)
    dragStartPos.current = null
    const raw = e.dataTransfer.getData('application/x-editor-tab')
    if (!raw) return
    e.preventDefault()
    try {
      const { idx: fromIdx } = JSON.parse(raw)
      if (typeof fromIdx === 'number') moveTab(fromIdx, toIdx)
    } catch { /* ignore */ }
  }, [moveTab])

  // Detach tab to standalone window — fires when tab drag ends outside the tab bar.
  // Only detaches if the user dragged a meaningful distance (prevents accidental detach on click).
  const handleTabDragEnd = useCallback((e: React.DragEvent, tabId: string) => {
    setDragOverIdx(null)
    const startPos = dragStartPos.current
    dragStartPos.current = null

    // Only consider detach if the drop didn't land on a valid target
    if (e.dataTransfer.dropEffect !== 'none') return

    // Check minimum drag distance to prevent accidental detach
    if (startPos) {
      const dx = e.clientX - startPos.x
      const dy = e.clientY - startPos.y
      if (Math.sqrt(dx * dx + dy * dy) < MIN_DRAG_DISTANCE) return
    }

    const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId)
    if (!tab) return

    // Warn about unsaved changes
    if (tab.content !== tab.savedContent) {
      if (!confirm(`"${tab.fileName}" has unsaved changes. Detach anyway?`)) return
    }

    const removed = removeTab(tabId)
    if (!removed) return

    const tabData = JSON.stringify([removed])
    getDockApi().workspace.detachEditor(removed.projectDir, tabData).catch(() => {
      // If detach fails, restore the tab
      useEditorStore.getState().openFile(removed.projectDir, removed.relativePath, removed.content)
    })
  }, [removeTab])

  // Navigation back/forward helpers
  const revealNavEntry = useCallback((entry: { tabId: string; line: number; column: number } | null) => {
    if (!entry) return
    // If the entry's tab exists, switch to it and reveal position
    const { tabs: currentTabs } = useEditorStore.getState()
    const tab = currentTabs.find((t) => t.id === entry.tabId)
    if (!tab) return
    // Set pending reveal so the tab switch effect positions the cursor
    useEditorStore.getState().clearPendingReveal(entry.tabId) // clear any existing
    useEditorStore.setState({
      tabs: currentTabs.map((t) =>
        t.id === entry.tabId ? { ...t, pendingReveal: { line: entry.line, column: entry.column } } : t
      ),
      activeTabId: entry.tabId
    })
  }, [])

  const handleNavBack = useCallback(() => {
    const pos = editorRef.current?.getPosition()
    const entry = useEditorStore.getState().navigateBack(pos?.lineNumber, pos?.column)
    revealNavEntry(entry)
  }, [revealNavEntry])

  const handleNavForward = useCallback(() => {
    const pos = editorRef.current?.getPosition()
    const entry = useEditorStore.getState().navigateForward(pos?.lineNumber, pos?.column)
    revealNavEntry(entry)
  }, [revealNavEntry])

  // Mouse button 4 (back) and 5 (forward) for navigation
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // button 3 = mouse button 4 (back), button 4 = mouse button 5 (forward)
      if (e.button === 3) {
        e.preventDefault()
        handleNavBack()
      } else if (e.button === 4) {
        e.preventDefault()
        handleNavForward()
      }
    }
    const overlayEl = document.querySelector('.editor-overlay')
    if (overlayEl) {
      overlayEl.addEventListener('mouseup', handler as EventListener)
      return () => overlayEl.removeEventListener('mouseup', handler as EventListener)
    }
  }, [handleNavBack, handleNavForward])

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
      // Alt+Left = navigate back, Alt+Right = navigate forward
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        handleNavBack()
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        handleNavForward()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleCloseTab])

  // When active tab changes, focus the editor and reveal pending position
  useEffect(() => {
    if (!editorRef.current) return
    try {
      editorRef.current.focus()
      // Consume pendingReveal if set
      if (activeTab?.pendingReveal) {
        const { line, column } = activeTab.pendingReveal
        editorRef.current.revealLineInCenter(line)
        editorRef.current.setPosition({ lineNumber: line, column })
        clearPendingReveal(activeTab.id)
      }
    } catch { /* may fail during dispose */ }
  }, [activeTabId, activeTab?.pendingReveal, clearPendingReveal])

  const handleEditorMount = useCallback((editor: MonacoEditor.IStandaloneCodeEditor, monaco: typeof MonacoNS) => {
    editorRef.current = editor
    monacoRef.current = monaco

    // Track mouse clicks in the editor — push nav position before cursor moves
    editor.onMouseDown((e) => {
      if (e.event.leftButton) {
        const pos = editor.getPosition()
        const { activeTabId: tabId } = useEditorStore.getState()
        if (pos && tabId) {
          useEditorStore.getState().pushNavPosition(tabId, pos.lineNumber, pos.column)
        }
      }
    })

    // Initialize language services once
    if (!langServicesInitRef.current && projectDir) {
      langServicesInitRef.current = true
      initLanguageServices(monaco, projectDir)
    }
  }, [projectDir])

  /** Set up Monaco TypeScript language service with workspace files + custom providers */
  const initLanguageServices = useCallback(async (monaco: typeof MonacoNS, projDir: string) => {
    const api = getDockApi()

    try {
      // 1. Configure TypeScript compiler options
      const ts = monaco.languages.typescript
      ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        jsx: ts.JsxEmit.React,
        allowJs: true,
        esModuleInterop: true,
        strict: false, // Don't show type errors in all files
        noEmit: true,
        allowNonTsExtensions: true
      })
      ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true, // Don't show red squiggles for missing types
        noSyntaxValidation: false
      })
      ts.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false
      })

      // 2. Register workspace TS/JS files as extra libs (async, background)
      const files = await api.workspace.scanTsFiles(projDir)
      for (const f of files) {
        const uri = `file:///${f.filePath.replace(/\\/g, '/')}`
        const disposable = ts.typescriptDefaults.addExtraLib(f.content, uri)
        extraLibsRef.current.set(f.filePath, disposable)
      }

      // 2b. Create editor models so "Peek References" / "Find All References" can
      // resolve file content. Standalone Monaco's text model service only resolves
      // models that already exist — extraLib entries are invisible to it.
      for (const f of files) {
        try {
          const fileUri = monaco.Uri.parse(`file:///${f.filePath.replace(/\\/g, '/')}`)
          if (!monaco.editor.getModel(fileUri)) {
            monaco.editor.createModel(f.content, undefined, fileUri)
          }
        } catch { /* skip files that fail */ }
      }

      // 3. Register editor opener for cross-file Ctrl+click navigation
      if (monaco.editor.registerEditorOpener) {
      monaco.editor.registerEditorOpener({
        openCodeEditor(_source: any, resource: any, selectionOrPosition: any) {
          try {
            const uri = resource.toString()
            // Extract file path from URI — format: file:///C:/path/to/file.ts
            let absPath = resource.path || ''
            if (absPath.startsWith('/') && /^\/[A-Za-z]:/.test(absPath)) absPath = absPath.slice(1)
            // Convert to relative path
            const normProject = projDir.replace(/\\/g, '/')
            const normAbs = absPath.replace(/\\/g, '/')
            let relativePath = normAbs
            if (normAbs.startsWith(normProject + '/')) {
              relativePath = normAbs.slice(normProject.length + 1)
            } else if (normAbs.startsWith(normProject)) {
              relativePath = normAbs.slice(normProject.length)
              if (relativePath.startsWith('/')) relativePath = relativePath.slice(1)
            }
            if (!relativePath || relativePath.includes('..')) return false

            let line = 1, column = 1
            if (selectionOrPosition) {
              if ('lineNumber' in selectionOrPosition) {
                line = selectionOrPosition.lineNumber
                column = selectionOrPosition.column || 1
              } else if ('startLineNumber' in selectionOrPosition) {
                line = selectionOrPosition.startLineNumber
                column = selectionOrPosition.startColumn || 1
              }
            }

            // Read file and open at position
            api.workspace.readFile(projDir, relativePath).then((result) => {
              if (result.content != null) {
                useEditorStore.getState().openFileAtPosition(projDir, relativePath, result.content, line, column)
              }
            }).catch(() => { /* ignore */ })

            return true
          } catch { return false }
        }
      })
      }

      // 4. Build regex symbol index for non-TS languages (background)
      api.workspace.buildSymbolIndex(projDir).then((symbols) => {
        if (symbols.length === 0) return
        // Register custom DefinitionProvider for non-TS languages
        const langIds = ['java', 'python', 'go', 'rust', 'csharp', 'kotlin', 'ruby', 'php', 'swift']
        for (const langId of langIds) {
          monaco.languages.registerDefinitionProvider(langId, {
            provideDefinition: async (model, position) => {
              const word = model.getWordAtPosition(position)
              if (!word) return null
              const results = await api.workspace.querySymbol(projDir, word.word)
              if (results.length === 0) return null
              return results.map((s: any) => ({
                uri: monaco.Uri.file(`${projDir}/${s.filePath}`),
                range: new monaco.Range(s.line, s.column, s.line, s.column + s.name.length)
              }))
            }
          })
        }
      }).catch(() => { /* non-critical */ })

    } catch (err) {
      console.error('[EditorOverlay] language service init failed:', err)
    }
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
      <div className="editor-tab-bar" ref={tabBarRef} onDragLeave={() => setDragOverIdx(null)}>
        {tabs.map((tab, idx) => {
          const isDirty = tab.content !== tab.savedContent
          const isActive = tab.id === activeTabId
          const isDropTarget = dragOverIdx === idx
          return (
            <div
              key={tab.id}
              className={`editor-tab${isActive ? ' editor-tab-active' : ''}${isDropTarget ? ' editor-tab-drop-target' : ''}`}
              onClick={() => {
                // Push current position before switching tabs
                const pos = editorRef.current?.getPosition()
                const { activeTabId: curId } = useEditorStore.getState()
                if (curId && curId !== tab.id && pos) {
                  useEditorStore.getState().pushNavPosition(curId, pos.lineNumber, pos.column)
                }
                setActiveTab(tab.id)
              }}
              onAuxClick={(e) => { if (e.button === 1) handleCloseTab(tab.id) }}
              title={tab.relativePath}
              draggable
              onDragStart={(e) => handleTabDragStart(e, tab.id, idx)}
              onDragOver={(e) => handleTabDragOver(e, idx)}
              onDrop={(e) => handleTabDrop(e, idx)}
              onDragEnd={(e) => handleTabDragEnd(e, tab.id)}
            >
              <span className="editor-tab-name">{tab.fileName}</span>
              {isDirty && <span className="editor-tab-dirty">●</span>}
              <button className="editor-tab-close" draggable={false} onClick={(e) => handleCloseTab(tab.id, e)}>×</button>
            </div>
          )
        })}
        <div className="editor-tab-spacer" />
        <button className="editor-nav-btn" onClick={handleNavBack} disabled={navBackCount === 0} title="Go Back (Alt+Left / Mouse4)">&#8592;</button>
        <button className="editor-nav-btn" onClick={handleNavForward} disabled={navForwardCount === 0} title="Go Forward (Alt+Right / Mouse5)">&#8594;</button>
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
