import './workspace.css'
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import ReactDOM from 'react-dom'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { PanelProps } from '@dock-renderer/panel-registry'
import { useEditorStore, isBinaryFile } from '@dock-renderer/stores/editor-store'
import SearchPanel from './SearchPanel'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  children?: FileEntry[]
}

// File type colors (shared with git-manager's file tree)
const FILE_TYPE_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#f1e05a', jsx: '#f1e05a', mjs: '#f1e05a', cjs: '#f1e05a',
  html: '#e34c26', htm: '#e34c26', css: '#563d7c', scss: '#c6538c', less: '#1d365d',
  svelte: '#ff3e00', vue: '#41b883', astro: '#ff5d01',
  json: '#a8b577', yaml: '#cb171e', yml: '#cb171e', toml: '#9c4221', xml: '#f26522', svg: '#ffb13b',
  py: '#3572a5', rb: '#701516', rs: '#dea584', go: '#00add8',
  java: '#b07219', kt: '#a97bff', scala: '#c22d40', groovy: '#4298b8',
  cs: '#178600', fs: '#b845fc', c: '#555555', h: '#555555', cpp: '#f34b7d',
  swift: '#f05138', php: '#4f5d95',
  sh: '#89e051', bash: '#89e051', ps1: '#012456',
  md: '#083fa1', mdx: '#083fa1', lua: '#000080', dart: '#00b4ab',
  sql: '#e38c00', proto: '#c6c6c6', graphql: '#e10098',
}

function getFileColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return FILE_TYPE_COLORS[ext] || '#9aa5ce'
}

const FILE_TYPE_LABELS: Record<string, string> = {
  ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX', json: '{}', yaml: 'Y', yml: 'Y',
  html: '<>', css: '#', py: 'Py', rs: 'Rs', go: 'Go', java: 'Ja', cs: 'C#',
  c: 'C', cpp: '++', sh: '$', md: 'Md', sql: 'Sq', svelte: 'Sv', vue: 'V',
  rb: 'Rb', php: 'Hp', kt: 'Kt', swift: 'Sw', dart: 'Da', lua: 'Lu',
}

const FileIcon: React.FC<{ name: string }> = React.memo(({ name }) => {
  const color = getFileColor(name)
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const label = FILE_TYPE_LABELS[ext] || ''
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" style={{ flexShrink: 0 }}>
      <path d="M11.5 1H5a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V6.5L11.5 1z" fill="var(--bg-tertiary)" stroke={label ? color : '#565f89'} strokeWidth="1" strokeLinejoin="round" />
      <path d="M11.5 1v4a1.5 1.5 0 001.5 1.5h4" fill="none" stroke={label ? color : '#565f89'} strokeWidth="1" strokeLinejoin="round" />
      {label && <text x="10" y="14.5" textAnchor="middle" fill={color} fontSize={label.length > 2 ? '5.5' : '6.5'} fontWeight="700" fontFamily="system-ui, sans-serif" style={{ userSelect: 'none' }}>{label}</text>}
    </svg>
  )
})

const DirIcon: React.FC<{ open?: boolean }> = React.memo(({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={open ? '#e0af6833' : 'none'} stroke="#e0af68" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/** Flatten single-child directory chains: a/b/c → "a/b/c"
 *  Also collects paths of intermediate dirs that need lazy-loading. */
function flattenEntries(entries: FileEntry[], needsLoad?: Set<string>): FileEntry[] {
  return entries.map((entry) => {
    if (!entry.isDirectory || !entry.children) return entry
    let current = entry
    let compactName = current.name
    while (current.isDirectory && current.children && current.children.length === 1 && current.children[0].isDirectory) {
      current = current.children[0]
      compactName += '/' + current.name
    }
    // If the deepest flattened dir has no children loaded, mark it for lazy loading
    if (current.isDirectory && !current.children && needsLoad) {
      needsLoad.add(current.path)
    }
    return {
      ...current,
      name: compactName,
      children: current.children ? flattenEntries(current.children, needsLoad) : undefined
    }
  })
}

// --- Tree Node ---

const WorkspaceTreeNode: React.FC<{
  entry: FileEntry
  depth: number
  projectDir: string
  selectedPaths: Set<string>
  expandedPaths: Set<string>
  filter: string
  onSelect: (path: string, e: React.MouseEvent) => void
  onToggleExpand: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  onDoubleClick: (entry: FileEntry) => void
}> = ({ entry, depth, projectDir, selectedPaths, expandedPaths, filter, onSelect, onToggleExpand, onContextMenu, onDoubleClick }) => {
  const expanded = expandedPaths.has(entry.path)
  const isSelected = selectedPaths.has(entry.path)

  // Filter: if filter is set, skip items that don't match
  if (filter) {
    const lower = filter.toLowerCase()
    const nameMatch = entry.name.toLowerCase().includes(lower)
    const childMatch = entry.children?.some((c) => c.name.toLowerCase().includes(lower) || c.isDirectory)
    if (!nameMatch && !childMatch && !entry.isDirectory) return null
  }

  return (
    <>
      <div
        className={`ws-tree-item${isSelected ? ' ws-tree-item-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => entry.isDirectory ? onToggleExpand(entry.path) : onSelect(entry.path, e)}
        onDoubleClick={() => onDoubleClick(entry)}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, entry) }}
        draggable
        onDragStart={(e) => {
          // Include all selected files in drag (or just this one if not selected)
          const paths = isSelected && selectedPaths.size > 1 ? [...selectedPaths] : [entry.path]
          e.dataTransfer.setData('text/plain', paths.join('\n'))
          e.dataTransfer.setData('application/x-ws-files', JSON.stringify(paths))
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onDragOver={(e) => { if (entry.isDirectory) { e.preventDefault(); e.currentTarget.classList.add('ws-tree-item-drop-target') } }}
        onDragLeave={(e) => { e.currentTarget.classList.remove('ws-tree-item-drop-target') }}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('ws-tree-item-drop-target')
          if (!entry.isDirectory) return
          const sourcePath = e.dataTransfer.getData('text/plain')
          if (sourcePath && sourcePath !== entry.path) {
            getDockApi().workspace.moveClaude(projectDir, sourcePath, entry.path)
          }
        }}
      >
        {entry.isDirectory ? (
          <span className={`ws-tree-arrow${expanded ? ' ws-tree-arrow-open' : ''}`}>&#9656;</span>
        ) : (
          <span className="ws-tree-arrow-spacer" />
        )}
        {entry.isDirectory ? <DirIcon open={expanded} /> : <FileIcon name={entry.name} />}
        <span className="ws-tree-name">{entry.name}</span>
        {!entry.isDirectory && entry.size != null && <span className="ws-tree-size">{formatSize(entry.size)}</span>}
      </div>
      {entry.isDirectory && expanded && entry.children?.map((child) => (
        <WorkspaceTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          projectDir={projectDir}
          selectedPaths={selectedPaths}
          expandedPaths={expandedPaths}
          filter={filter}
          onSelect={onSelect}
          onToggleExpand={onToggleExpand}
          onContextMenu={onContextMenu}
          onDoubleClick={onDoubleClick}
        />
      ))}
    </>
  )
}

// --- Context Menu ---

const ContextMenu: React.FC<{
  x: number; y: number
  entry: FileEntry
  projectDir: string
  onClose: () => void
  onRefresh: () => void
  onRename: (path: string) => void
}> = ({ x, y, entry, projectDir, onClose, onRefresh, onRename }) => {
  const ref = useRef<HTMLDivElement>(null)
  const api = getDockApi()

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Clamp to viewport
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    if (parseFloat(el.style.left) + el.offsetWidth > vw) el.style.left = `${vw - el.offsetWidth - 4}px`
    if (parseFloat(el.style.top) + el.offsetHeight > vh) el.style.top = `${vh - el.offsetHeight - 4}px`
  }, [])

  const [claudeSub, setClaudeSub] = useState(false)

  return (
    <div className="ws-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {!entry.isDirectory && (
        <div className="ws-ctx-item" onClick={() => { api.workspace.openFile(projectDir, entry.path); onClose() }}>
          Open
        </div>
      )}
      <div className="ws-ctx-item" onClick={() => { api.workspace.openInExplorer(projectDir, entry.path); onClose() }}>
        {entry.isDirectory ? 'Open in Explorer' : 'Reveal in Explorer'}
      </div>
      <div className="ws-ctx-separator" />
      <div className="ws-ctx-item" onClick={() => { navigator.clipboard.writeText(entry.path); onClose() }}>
        Copy Relative Path
      </div>
      <div className="ws-ctx-separator" />
      {entry.isDirectory && (
        <>
          <div className="ws-ctx-item" onClick={async () => {
            const name = prompt('File name:')
            if (name) { await api.workspace.createFile(projectDir, `${entry.path}/${name}`); onRefresh() }
            onClose()
          }}>New File</div>
          <div className="ws-ctx-item" onClick={async () => {
            const name = prompt('Folder name:')
            if (name) { await api.workspace.createFolder(projectDir, `${entry.path}/${name}`); onRefresh() }
            onClose()
          }}>New Folder</div>
          <div className="ws-ctx-separator" />
        </>
      )}
      <div className="ws-ctx-item" onClick={() => { onRename(entry.path); onClose() }}>
        Rename
      </div>
      <div className="ws-ctx-item ws-ctx-danger" onClick={async () => {
        if (confirm(`Delete "${entry.name}"? It will be moved to the recycle bin.`)) {
          await api.workspace.delete(projectDir, entry.path)
          onRefresh()
        }
        onClose()
      }}>Delete</div>
      <div className="ws-ctx-separator" />
      <div
        className="ws-ctx-item ws-ctx-submenu-trigger"
        onMouseEnter={() => setClaudeSub(true)}
        onMouseLeave={() => setClaudeSub(false)}
      >
        <span className="ws-ctx-claude">Claude Actions</span>
        <span className="ws-ctx-arrow">&#9656;</span>
        {claudeSub && (
          <div className="ws-ctx-submenu">
            {!entry.isDirectory && (
              <div className="ws-ctx-item" onClick={() => {
                api.workspace.moveClaude(projectDir, entry.path, '__explain__')
                onClose()
              }}>Explain this file</div>
            )}
            {!entry.isDirectory && (
              <div className="ws-ctx-item" onClick={() => {
                api.workspace.moveClaude(projectDir, entry.path, '__tests__')
                onClose()
              }}>Write tests</div>
            )}
            <div className="ws-ctx-item" onClick={() => {
              api.workspace.moveClaude(projectDir, entry.path, '__reference__')
              onClose()
            }}>Reference this</div>
            {entry.isDirectory && (
              <div className="ws-ctx-item" onClick={() => {
                api.workspace.moveClaude(projectDir, entry.path, '__explain_module__')
                onClose()
              }}>Explain this module</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Main Panel ---

const ZOOM_KEY = 'ws-viewer-zoom'
const MIN_ZOOM = 0.6
const MAX_ZOOM = 1.8
const ZOOM_STEP = 0.05

const WorkspacePanel: React.FC<PanelProps> = ({ projectDir }) => {
  const api = getDockApi()
  const [tree, setTree] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null)
  const expandStorageKey = `ws-expanded:${projectDir.replace(/\\/g, '/').toLowerCase()}`
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(expandStorageKey)
      if (saved) return new Set(JSON.parse(saved))
    } catch { /* ignore */ }
    return new Set()
  })
  const allFilePaths = useRef<string[]>([])

  // Persist expanded paths to localStorage
  useEffect(() => {
    try { localStorage.setItem(expandStorageKey, JSON.stringify([...expandedPaths])) } catch { /* ignore */ }
  }, [expandedPaths, expandStorageKey])

  // Build flat path list for shift-click range selection
  useEffect(() => {
    const paths: string[] = []
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        if (!e.isDirectory) paths.push(e.path)
        if (e.children) walk(e.children)
      }
    }
    walk(tree)
    allFilePaths.current = paths
  }, [tree])
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [compact, setCompact] = useState(() => localStorage.getItem('ws-viewer-compact') !== 'false')
  const [searchOpen, setSearchOpen] = useState(false)
  const [hideIgnored, setHideIgnored] = useState(() => localStorage.getItem('ws-viewer-hide-ignored') === 'true')
  const panelRootRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(1)

  // Zoom: Ctrl+MouseWheel and Ctrl++/- with persistence, defaults to dock's zoom
  useEffect(() => {
    const saved = localStorage.getItem(ZOOM_KEY)
    if (saved) {
      const z = parseFloat(saved)
      zoomRef.current = (isNaN(z) || z < MIN_ZOOM || z > MAX_ZOOM) ? 1 : z
    } else {
      // Default to the dock's current CSS zoom (if set), otherwise 1
      const dockZoom = parseFloat(document.documentElement.style.zoom) || 1
      zoomRef.current = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, dockZoom))
    }
    if (panelRootRef.current) panelRootRef.current.style.zoom = String(zoomRef.current)

    const applyZoom = (z: number) => {
      zoomRef.current = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100
      if (panelRootRef.current) panelRootRef.current.style.zoom = String(zoomRef.current)
      localStorage.setItem(ZOOM_KEY, String(zoomRef.current))
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      // Only handle if the event is inside our panel
      if (!panelRootRef.current?.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
      applyZoom(zoomRef.current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // Only handle if focus is inside our panel
      if (!panelRootRef.current?.contains(document.activeElement) && !panelRootRef.current?.matches(':hover')) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopPropagation(); applyZoom(zoomRef.current + ZOOM_STEP) }
      else if (e.key === '-') { e.preventDefault(); e.stopPropagation(); applyZoom(zoomRef.current - ZOOM_STEP) }
      else if (e.key === '0') { e.preventDefault(); e.stopPropagation(); applyZoom(1) }
    }

    // Use capture phase so we intercept before the dock's zoom handler
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true } as any)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  const loadGenRef = useRef(0)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadTree = useCallback(async () => {
    if (!projectDir) return
    const gen = ++loadGenRef.current
    setLoading(true)
    try {
      const result = await api.workspace.readTree(projectDir, 4, hideIgnored)
      if (gen !== loadGenRef.current) return // stale
      setTree(result)
      // Auto-expand top-level directories on first load only
      setExpandedPaths((prev) => prev.size === 0
        ? new Set(result.filter((e: FileEntry) => e.isDirectory).map((e: FileEntry) => e.path))
        : prev
      )
    } catch {
      if (gen === loadGenRef.current) setTree([])
    }
    if (gen === loadGenRef.current) setLoading(false)
  }, [projectDir, hideIgnored])

  useEffect(() => { loadTree() }, [loadTree])

  // Watch for filesystem changes — debounce to avoid hammering on rapid edits
  useEffect(() => {
    if (!projectDir) return
    const cleanup = api.workspace.onChanged(() => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; loadTree() }, 500)
    })
    return () => { cleanup(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }
  }, [projectDir, loadTree])

  const handleToggleExpand = useCallback(async (entryPath: string) => {
    // If collapsing, just remove from expanded set
    if (expandedPaths.has(entryPath)) {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        next.delete(entryPath)
        return next
      })
      return
    }

    // Expanding — check if children need to be loaded first
    const findEntry = (items: FileEntry[]): FileEntry | null => {
      for (const item of items) {
        if (item.path === entryPath) return item
        if (item.children) { const found = findEntry(item.children); if (found) return found }
      }
      return null
    }
    const entry = findEntry(tree)
    const needsLoad = !entry || (entry.isDirectory && !entry.children)

    if (needsLoad) {
      // Load children FIRST, update tree, THEN expand — so the first render
      // shows the directory expanded with its children already present.
      const children = await api.workspace.readDir(projectDir, entryPath, hideIgnored)
      if (entry) {
        setTree((prev) => {
          const update = (items: FileEntry[]): FileEntry[] =>
            items.map((item) =>
              item.path === entryPath ? { ...item, children } :
              item.children ? { ...item, children: update(item.children) } : item
            )
          return update(prev)
        })
      } else {
        // Entry not found in tree (deep flattened path) — reload
        await loadTree()
      }
    }

    // Now expand (children are loaded)
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      next.add(entryPath)
      return next
    })
  }, [tree, expandedPaths, projectDir, hideIgnored, loadTree])

  const handleSelect = useCallback((filePath: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Toggle individual selection
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(filePath)) next.delete(filePath)
        else next.add(filePath)
        return next
      })
    } else if (e.shiftKey && lastClickedPath) {
      // Range selection
      const paths = allFilePaths.current
      const from = paths.indexOf(lastClickedPath)
      const to = paths.indexOf(filePath)
      if (from >= 0 && to >= 0) {
        const start = Math.min(from, to)
        const end = Math.max(from, to)
        setSelectedPaths(new Set(paths.slice(start, end + 1)))
      }
    } else {
      // Single selection
      setSelectedPaths(new Set([filePath]))
    }
    setLastClickedPath(filePath)
  }, [lastClickedPath])

  const openFileInEditor = useCallback(async (filePath: string) => {
    if (isBinaryFile(filePath.split('/').pop() || '')) {
      api.workspace.openFile(projectDir, filePath)
      return
    }
    const result = await api.workspace.readFile(projectDir, filePath)
    if (result.error) {
      // Fallback to native on error (too large, binary, etc.)
      api.workspace.openFile(projectDir, filePath)
      return
    }
    useEditorStore.getState().openFile(projectDir, filePath, result.content!)
  }, [projectDir])

  const handleDoubleClick = useCallback((entry: FileEntry) => {
    if (!entry.isDirectory) openFileInEditor(entry.path)
  }, [openFileInEditor])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    // Context menu is portaled to document.body — use clientX/clientY directly.
    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const handleRename = useCallback(async (entryPath: string) => {
    const name = entryPath.split('/').pop() || ''
    const newName = prompt('New name:', name)
    if (newName && newName !== name) {
      await api.workspace.rename(projectDir, entryPath, newName)
      loadTree()
    }
  }, [projectDir, loadTree])

  const collapseAll = useCallback(() => setExpandedPaths(new Set()), [])

  const expandAll = useCallback(() => {
    const allDirs = new Set<string>()
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        if (e.isDirectory) { allDirs.add(e.path); if (e.children) walk(e.children) }
      }
    }
    walk(tree)
    setExpandedPaths(allDirs)
  }, [tree])

  // Listen for collapse/expand all from header actions
  useEffect(() => {
    const onCollapse = () => collapseAll()
    const onExpand = () => expandAll()
    window.addEventListener('ws-viewer:collapse-all', onCollapse)
    window.addEventListener('ws-viewer:expand-all', onExpand)
    return () => {
      window.removeEventListener('ws-viewer:collapse-all', onCollapse)
      window.removeEventListener('ws-viewer:expand-all', onExpand)
    }
  }, [collapseAll, expandAll])

  // Ctrl+F in workspace panel opens search, Ctrl+Shift+F from anywhere opens it too
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Shift+F from anywhere
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      // Ctrl+F only when workspace panel is focused
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) {
        if (panelRootRef.current?.contains(document.activeElement) || panelRootRef.current?.matches(':hover')) {
          e.preventDefault()
          setSearchOpen(true)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Compute display tree (with compact mode applied)
  const displayTree = useMemo(() => {
    if (!compact) return tree
    return flattenEntries(tree)
  }, [tree, compact])

  // When compact mode is on, auto-load unloaded single-child directory chains
  // so the flatten can fully resolve (e.g. server/src/main/java/com → one row).
  // This runs as an effect that chases the chain until fully loaded.
  const loadingChainsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!compact) return
    const needsLoad = new Set<string>()
    flattenEntries(tree, needsLoad)
    // Filter out paths already being loaded to avoid duplicate requests
    const toLoad: string[] = []
    for (const p of needsLoad) {
      if (!loadingChainsRef.current.has(p)) {
        loadingChainsRef.current.add(p)
        toLoad.push(p)
      }
    }
    if (toLoad.length === 0) return
    // Load all missing dirs in parallel
    Promise.all(toLoad.map((dirPath) =>
      api.workspace.readDir(projectDir, dirPath, hideIgnored).then((children) => ({ dirPath, children }))
    )).then((results) => {
      const updates = results.filter((r) => r.children.length > 0)
      if (updates.length === 0) return
      setTree((prev) => {
        let updated = prev
        for (const { dirPath, children } of updates) {
          const apply = (items: FileEntry[]): FileEntry[] =>
            items.map((item) =>
              item.path === dirPath ? { ...item, children } :
              item.children ? { ...item, children: apply(item.children) } : item
            )
          updated = apply(updated)
        }
        return updated
      })
      // Clear loading flags so next cycle can load further
      for (const p of toLoad) loadingChainsRef.current.delete(p)
    }).catch(() => {
      for (const p of toLoad) loadingChainsRef.current.delete(p)
    })
  }, [tree, compact, projectDir, hideIgnored])

  // Build flat list of visible entries for keyboard navigation
  const visibleEntries = useMemo(() => {
    const list: FileEntry[] = []
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        list.push(e)
        if (e.isDirectory && expandedPaths.has(e.path) && e.children) walk(e.children)
      }
    }
    walk(displayTree)
    return list
  }, [displayTree, expandedPaths])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const focusedPath = lastClickedPath || (selectedPaths.size > 0 ? [...selectedPaths][0] : null)
    if (!focusedPath && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // Nothing focused — select first item
      if (visibleEntries.length > 0) {
        const first = visibleEntries[0]
        setSelectedPaths(new Set([first.path]))
        setLastClickedPath(first.path)
      }
      e.preventDefault()
      return
    }
    if (!focusedPath) return

    const idx = visibleEntries.findIndex((e) => e.path === focusedPath)
    if (idx < 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = idx + 1 < visibleEntries.length ? visibleEntries[idx + 1] : null
      if (next) {
        setSelectedPaths(new Set([next.path]))
        setLastClickedPath(next.path)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = idx - 1 >= 0 ? visibleEntries[idx - 1] : null
      if (prev) {
        setSelectedPaths(new Set([prev.path]))
        setLastClickedPath(prev.path)
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const entry = visibleEntries[idx]
      if (entry.isDirectory && !expandedPaths.has(entry.path)) {
        handleToggleExpand(entry.path)
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const entry = visibleEntries[idx]
      if (entry.isDirectory && expandedPaths.has(entry.path)) {
        handleToggleExpand(entry.path)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = visibleEntries[idx]
      if (entry.isDirectory) handleToggleExpand(entry.path)
      else openFileInEditor(entry.path)
    }
  }, [lastClickedPath, selectedPaths, visibleEntries, expandedPaths, handleToggleExpand, projectDir])

  if (loading) {
    return <div className="ws-panel" ref={panelRootRef}><div className="ws-panel-loading">Loading...</div></div>
  }

  return (
    <div className="ws-panel" ref={panelRootRef}>
      <div className="ws-panel-toolbar">
        <input
          className="ws-panel-filter"
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className={`ws-panel-btn${compact ? ' ws-panel-btn-active' : ''}`}
          onClick={() => { const next = !compact; setCompact(next); localStorage.setItem('ws-viewer-compact', String(next)) }}
          title={compact ? 'Compact paths (on)' : 'Compact paths (off)'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />
          </svg>
        </button>
        <button
          className={`ws-panel-btn${hideIgnored ? ' ws-panel-btn-active' : ''}`}
          onClick={() => { const next = !hideIgnored; setHideIgnored(next); localStorage.setItem('ws-viewer-hide-ignored', String(next)) }}
          title={hideIgnored ? 'Showing tracked files only (click to show all)' : 'Showing all files (click to hide git-ignored)'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            {hideIgnored && <line x1="2" y1="2" x2="22" y2="22" />}
          </svg>
        </button>
        <button className="ws-panel-btn" onClick={loadTree} title="Refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
        </button>
        <button className="ws-panel-btn" onClick={() => setSearchOpen(!searchOpen)} title="Search in files (Ctrl+Shift+F)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        </button>
      </div>
      <SearchPanel projectDir={projectDir} visible={searchOpen} onClose={() => setSearchOpen(false)} />
      <div className="ws-panel-tree" tabIndex={0} onKeyDown={handleKeyDown}>
        {displayTree.map((entry) => (
          <WorkspaceTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            projectDir={projectDir}
            selectedPaths={selectedPaths}
            expandedPaths={expandedPaths}
            filter={filter}
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
          />
        ))}
        {tree.length === 0 && <div className="ws-panel-empty">No files found</div>}
      </div>
      {ctxMenu && ReactDOM.createPortal(
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entry={ctxMenu.entry}
          projectDir={projectDir}
          onClose={() => setCtxMenu(null)}
          onRefresh={loadTree}
          onRename={handleRename}
        />,
        document.body
      )}
    </div>
  )
}

export default WorkspacePanel
