/**
 * EditorOverlay — Monaco Editor with tab bar, rendered over the terminal grid.
 * Lazy-loaded via React.lazy() from DockPanelLayout.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import Editor, { loader } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type * as MonacoNS from 'monaco-editor'
import { marked } from 'marked'
import hljs from 'highlight.js'
import { useEditorStore, isBinaryFile } from '../stores/editor-store'
import { getDockApi } from '../lib/ipc-bridge'
import { useDockStore } from '../stores/dock-store'
import { routeOpenFile } from '../lib/route-open-file'

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
// Separate from FONT_SIZE because the preview is rendered HTML (CSS zoom),
// not Monaco text (options.fontSize). Persisted so rereads of the same file
// restore the user's last-chosen scale.
const MARKDOWN_ZOOM_KEY = 'editor-markdown-zoom'
const DEFAULT_MARKDOWN_ZOOM = 1
const MIN_MARKDOWN_ZOOM = 0.5
const MAX_MARKDOWN_ZOOM = 3
const MARKDOWN_ZOOM_STEP = 0.1
/** Minimum pixels of drag movement before we consider it a real drag (prevents accidental detach on click) */
const MIN_DRAG_DISTANCE = 20
/** Cap workspace models to prevent Monaco listener leak (each model adds listeners to shared emitters) */
const MAX_WORKSPACE_MODELS = 80

// Module-level flag: language services persist across EditorOverlay mount/unmount cycles
// because Monaco's global state (models, extraLibs, providers) is never torn down.
let langServicesInited = false

// ── Markdown Preview ─────────────────────────────────────────────────────────

let markedConfigured = false
function ensureMarkedConfigured(): void {
  if (markedConfigured) return
  markedConfigured = true
  marked.setOptions({
    gfm: true,
    breaks: true
  })
  // Use marked.use() for the highlight extension (v14+ API)
  marked.use({
    renderer: {
      code(token: any) {
        const code = typeof token === 'string' ? token : (token?.text ?? '')
        const lang = typeof token === 'string' ? '' : (token?.lang ?? '')
        let highlighted = code
        if (lang && hljs.getLanguage(lang)) {
          try { highlighted = hljs.highlight(code, { language: lang }).value } catch { /* fallback */ }
        } else {
          try { highlighted = hljs.highlightAuto(code).value } catch { /* fallback */ }
        }
        return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlighted}</code></pre>`
      }
    }
  })
}

const MarkdownPreview: React.FC<{ content: string; zoom: number }> = React.memo(({ content, zoom }) => {
  const html = useMemo(() => {
    try {
      ensureMarkedConfigured()
      return marked.parse(content) as string
    } catch {
      return '<p>Failed to render markdown</p>'
    }
  }, [content])

  return (
    <div className="editor-preview-panel" style={{ zoom }}>
      <div className="editor-preview-content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
})

// ── Tab context menu ─────────────────────────────────────────────────────────

interface TabContextMenuProps {
  x: number
  y: number
  tabId: string
  tabIndex: number
  tabCount: number
  absPath: string
  relativePath: string
  onClose: () => void
  onCloseTab: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseToLeft: (id: string) => void
  onCloseToRight: (id: string) => void
  onCloseAll: () => void
  onRevealInExplorer: (absPath: string) => void
}

const TabContextMenu: React.FC<TabContextMenuProps> = ({
  x, y, tabId, tabIndex, tabCount, absPath, relativePath,
  onClose, onCloseTab, onCloseOthers, onCloseToLeft, onCloseToRight, onCloseAll, onRevealInExplorer
}) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  // Clamp to viewport so the menu never renders off-screen — accounts for
  // global dock zoom the same way the workspace context menu does.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    if (parseFloat(el.style.left) + el.offsetWidth > vw) el.style.left = `${vw - el.offsetWidth - 4}px`
    if (parseFloat(el.style.top) + el.offsetHeight > vh) el.style.top = `${vh - el.offsetHeight - 4}px`
  }, [])

  const hasOthers = tabCount > 1
  const hasLeft = tabIndex > 0
  const hasRight = tabIndex < tabCount - 1

  const Item: React.FC<{ disabled?: boolean; onClick: () => void; children: React.ReactNode }> =
    ({ disabled, onClick, children }) => (
      <div
        className={`editor-ctx-item${disabled ? ' editor-ctx-item-disabled' : ''}`}
        onClick={() => { if (!disabled) { onClick(); onClose() } }}
      >
        {children}
      </div>
    )

  return (
    <div className="editor-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <Item onClick={() => onCloseTab(tabId)}>Close</Item>
      <Item disabled={!hasOthers} onClick={() => onCloseOthers(tabId)}>Close Others</Item>
      <Item disabled={!hasLeft} onClick={() => onCloseToLeft(tabId)}>Close Tabs to the Left</Item>
      <Item disabled={!hasRight} onClick={() => onCloseToRight(tabId)}>Close Tabs to the Right</Item>
      <Item onClick={onCloseAll}>Close All</Item>
      <div className="editor-ctx-separator" />
      <Item onClick={() => { void navigator.clipboard.writeText(absPath) }}>Copy Path</Item>
      <Item onClick={() => { void navigator.clipboard.writeText(relativePath) }}>Copy Relative Path</Item>
      <div className="editor-ctx-separator" />
      <Item onClick={() => onRevealInExplorer(absPath)}>Reveal in Explorer</Item>
    </div>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────

const EditorOverlay: React.FC = () => {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs)
  const closeOtherTabs = useEditorStore((s) => s.closeOtherTabs)
  const closeTabsToLeft = useEditorStore((s) => s.closeTabsToLeft)
  const closeTabsToRight = useEditorStore((s) => s.closeTabsToRight)
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
  const extraLibsRef = useRef<Map<string, { dispose: () => void }>>(new Map())
  // Track which tab paths have Monaco models so we can dispose them on close
  const tabModelPathsRef = useRef(new Set<string>())
  const saveRef = useRef<() => void>(() => {})
  const tabBarRef = useRef<HTMLDivElement>(null)
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const activeTabElRef = useRef<HTMLDivElement>(null)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number; y: number; tabId: string; tabIndex: number
  } | null>(null)
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
  const [markdownZoom, setMarkdownZoom] = useState(() => {
    try {
      const saved = localStorage.getItem(MARKDOWN_ZOOM_KEY)
      if (saved) {
        const z = parseFloat(saved)
        if (!isNaN(z) && z >= MIN_MARKDOWN_ZOOM && z <= MAX_MARKDOWN_ZOOM) return z
      }
    } catch { /* ignore */ }
    return DEFAULT_MARKDOWN_ZOOM
  })

  const applyFontSize = useCallback((size: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
    setFontSize(clamped)
    try { localStorage.setItem(FONT_SIZE_KEY, String(clamped)) } catch { /* ignore */ }
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize: clamped })
    }
  }, [])

  const applyMarkdownZoom = useCallback((zoom: number) => {
    const clamped = Math.round(Math.max(MIN_MARKDOWN_ZOOM, Math.min(MAX_MARKDOWN_ZOOM, zoom)) * 100) / 100
    setMarkdownZoom(clamped)
    try { localStorage.setItem(MARKDOWN_ZOOM_KEY, String(clamped)) } catch { /* ignore */ }
  }, [])

  // Ctrl+MouseWheel and Ctrl++/- zoom for the editor. When markdown preview
  // is the active view, route zoom to the preview's CSS scale instead of
  // Monaco's fontSize — those are independent scales with their own
  // persisted values.
  useEffect(() => {
    const overlayEl = document.querySelector('.editor-overlay')
    if (!overlayEl) return

    // Preview mode only applies when the active tab is markdown and the
    // user has toggled preview on.
    const isMarkdownPreview = previewMode && activeTab?.language === 'markdown'

    const onWheel = (e: Event) => {
      const we = e as WheelEvent
      if (!(we.ctrlKey || we.metaKey)) return
      we.preventDefault()
      we.stopPropagation()
      if (isMarkdownPreview) {
        applyMarkdownZoom(markdownZoom + (we.deltaY < 0 ? MARKDOWN_ZOOM_STEP : -MARKDOWN_ZOOM_STEP))
      } else {
        applyFontSize(fontSize + (we.deltaY < 0 ? 1 : -1))
      }
    }

    const onKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent
      if (!(ke.ctrlKey || ke.metaKey)) return
      if (isMarkdownPreview) {
        if (ke.key === '=' || ke.key === '+') { ke.preventDefault(); ke.stopPropagation(); applyMarkdownZoom(markdownZoom + MARKDOWN_ZOOM_STEP) }
        else if (ke.key === '-') { ke.preventDefault(); ke.stopPropagation(); applyMarkdownZoom(markdownZoom - MARKDOWN_ZOOM_STEP) }
        else if (ke.key === '0') { ke.preventDefault(); ke.stopPropagation(); applyMarkdownZoom(DEFAULT_MARKDOWN_ZOOM) }
      } else {
        if (ke.key === '=' || ke.key === '+') { ke.preventDefault(); ke.stopPropagation(); applyFontSize(fontSize + 1) }
        else if (ke.key === '-') { ke.preventDefault(); ke.stopPropagation(); applyFontSize(fontSize - 1) }
        else if (ke.key === '0') { ke.preventDefault(); ke.stopPropagation(); applyFontSize(DEFAULT_FONT_SIZE) }
      }
    }

    overlayEl.addEventListener('wheel', onWheel, { passive: false, capture: true })
    overlayEl.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      overlayEl.removeEventListener('wheel', onWheel, { capture: true } as any)
      overlayEl.removeEventListener('keydown', onKeyDown, { capture: true } as any)
    }
  }, [fontSize, markdownZoom, previewMode, activeTab?.language, applyFontSize, applyMarkdownZoom])

  // Translate vertical mouse wheel to horizontal scroll on the tab list.
  // Passive: false because we preventDefault when we actually consume the scroll.
  // Skips ctrl/meta (zoom) and shift (native horizontal scroll) so other
  // behaviors keep working. Tied to the tabsScrollRef element directly so it
  // doesn't intercept wheel events outside the scroll area.
  useEffect(() => {
    const el = tabsScrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return
      // Nothing to scroll — let the event fall through (no-op).
      if (el.scrollWidth <= el.clientWidth) return
      // Use the dominant axis. Some mice/trackpads already emit deltaX.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0) return
      e.preventDefault()
      // deltaMode 1 = line, 2 = page — normalize to pixels.
      const mult = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1
      el.scrollLeft += delta * mult
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keep the active tab visible when it changes (e.g. via keyboard, nav back/forward,
  // or file open from outside). Click-to-activate already implies visibility.
  useEffect(() => {
    const el = activeTabElRef.current
    const scroll = tabsScrollRef.current
    if (!el || !scroll) return
    const elLeft = el.offsetLeft
    const elRight = elLeft + el.offsetWidth
    const viewLeft = scroll.scrollLeft
    const viewRight = viewLeft + scroll.clientWidth
    if (elLeft < viewLeft) {
      scroll.scrollLeft = elLeft
    } else if (elRight > viewRight) {
      scroll.scrollLeft = elRight - scroll.clientWidth
    }
  }, [activeTabId])

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

  // Switch to the previous/next open tab, preserving cursor-position history
  // (same push semantics as clicking a tab). Wraps around at the ends.
  const switchTabByOffset = useCallback((offset: number) => {
    const { tabs: currentTabs, activeTabId: curId } = useEditorStore.getState()
    if (currentTabs.length < 2 || !curId) return
    const curIdx = currentTabs.findIndex((t) => t.id === curId)
    if (curIdx < 0) return
    const nextIdx = (curIdx + offset + currentTabs.length) % currentTabs.length
    const nextTab = currentTabs[nextIdx]
    if (!nextTab || nextTab.id === curId) return
    const pos = editorRef.current?.getPosition()
    if (pos) useEditorStore.getState().pushNavPosition(curId, pos.lineNumber, pos.column)
    setActiveTab(nextTab.id)
  }, [setActiveTab])

  // Keyboard shortcuts — Ctrl+S, Ctrl+W, Ctrl+Shift+V, Alt+Left/Right (tab switch)
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
      // Ctrl+Shift+V = toggle markdown preview
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
        e.preventDefault()
        const tab = useEditorStore.getState().tabs.find((t) => t.id === useEditorStore.getState().activeTabId)
        if (tab?.language === 'markdown') setPreviewMode((p) => !p)
      }
      // Alt+Left / Alt+Right = switch to previous / next open tab.
      // Cursor-position history stays on Mouse4/Mouse5 and the toolbar buttons.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        switchTabByOffset(e.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleCloseTab, switchTabByOffset])

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

    // Initialize language services once (module-level guard survives unmount/remount)
    if (!langServicesInited && projectDir) {
      langServicesInited = true
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
      // Capped to prevent hitting Monaco's 200-listener limit on shared emitters
      // (each TextModel adds listeners to LanguageSelection.onDidChange, etc.).
      let modelCount = 0
      for (const f of files) {
        if (modelCount >= MAX_WORKSPACE_MODELS) break
        try {
          const fileUri = monaco.Uri.parse(`file:///${f.filePath.replace(/\\/g, '/')}`)
          if (!monaco.editor.getModel(fileUri)) {
            monaco.editor.createModel(f.content, undefined, fileUri)
            modelCount++
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

            // Read file and route to dock or detached editor
            api.workspace.readFile(projDir, relativePath).then((result) => {
              if (result.content != null) {
                routeOpenFile({ projectDir: projDir, relativePath, content: result.content, line, column })
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

  // Track active tab's path for model management
  useEffect(() => {
    if (activeTab) {
      tabModelPathsRef.current.add(activeTab.relativePath)
    }
  }, [activeTab])

  // Dispose Monaco models when tabs are closed — prevents orphaned models from
  // accumulating listeners on shared emitters (LanguageSelection.onDidChange etc.)
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return
    const currentPaths = new Set(tabs.map((t) => t.relativePath))
    for (const path of tabModelPathsRef.current) {
      if (!currentPaths.has(path)) {
        try {
          const uri = monaco.Uri.parse(path)
          monaco.editor.getModel(uri)?.dispose()
        } catch { /* ignore */ }
      }
    }
    tabModelPathsRef.current = currentPaths
  }, [tabs])

  if (tabs.length === 0) return null

  return (
    <div className="editor-overlay">
      {/* Tab bar — tabs scroll horizontally beneath sticky right-side action buttons */}
      <div className="editor-tab-bar" ref={tabBarRef} onDragLeave={() => setDragOverIdx(null)}>
        <div className="editor-tabs-scroll" ref={tabsScrollRef}>
          {tabs.map((tab, idx) => {
            const isDirty = tab.content !== tab.savedContent
            const isActive = tab.id === activeTabId
            const isDropTarget = dragOverIdx === idx
            return (
              <div
                key={tab.id}
                ref={isActive ? activeTabElRef : undefined}
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
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setTabCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id, tabIndex: idx })
                }}
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
        </div>
        <div className="editor-tab-actions">
          {activeTab?.language === 'markdown' && (
            <button
              className={`editor-nav-btn editor-preview-btn${previewMode ? ' editor-preview-btn-active' : ''}`}
              onClick={() => setPreviewMode((p) => !p)}
              title={previewMode ? 'Show source (Ctrl+Shift+V)' : 'Preview markdown (Ctrl+Shift+V)'}
            >
              {previewMode ? '\u{2328}' : '\u{1F441}'}
            </button>
          )}
          <button className="editor-nav-btn" onClick={handleNavBack} disabled={navBackCount === 0} title="Go Back (Mouse4)">&#8592;</button>
          <button className="editor-nav-btn" onClick={handleNavForward} disabled={navForwardCount === 0} title="Go Forward (Mouse5)">&#8594;</button>
          {saving && <span className="editor-saving">Saving...</span>}
          {saveError && <span className="editor-save-error">{saveError}</span>}
          <button className="editor-close-all" onClick={handleCloseAll} title="Close all tabs">×</button>
        </div>
      </div>

      {/* Editor body */}
      <div className="editor-body">
        {activeTab ? (
          previewMode && activeTab.language === 'markdown' ? (
            <MarkdownPreview content={activeTab.content} zoom={markdownZoom} />
          ) : (
            <Editor
              path={activeTab.relativePath}
              theme={theme}
              language={activeTab.language}
              defaultValue={activeTab.content}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              saveViewState={true}
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
          )
        ) : (
          <div className="editor-loading">Select a tab to edit</div>
        )}
      </div>
      {tabCtxMenu && (() => {
        const menuTab = tabs.find((t) => t.id === tabCtxMenu.tabId)
        if (!menuTab) return null
        const absPath = `${menuTab.projectDir}/${menuTab.relativePath}`.replace(/\\/g, '/').replace(/\/+/g, '/')
        return ReactDOM.createPortal(
          <TabContextMenu
            x={tabCtxMenu.x}
            y={tabCtxMenu.y}
            tabId={tabCtxMenu.tabId}
            tabIndex={tabCtxMenu.tabIndex}
            tabCount={tabs.length}
            absPath={absPath}
            relativePath={menuTab.relativePath}
            onClose={() => setTabCtxMenu(null)}
            onCloseTab={closeTab}
            onCloseOthers={closeOtherTabs}
            onCloseToLeft={closeTabsToLeft}
            onCloseToRight={closeTabsToRight}
            onCloseAll={closeAllTabs}
            onRevealInExplorer={(p) => { void getDockApi().workspace.openInExplorer(menuTab.projectDir, p) }}
          />,
          document.body
        )
      })()}
    </div>
  )
}

export default EditorOverlay
