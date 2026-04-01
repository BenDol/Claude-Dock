import './workspace-viewer.css'
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { PanelProps } from '@dock-renderer/panel-registry'

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

// --- Tree Node ---

const WorkspaceTreeNode: React.FC<{
  entry: FileEntry
  depth: number
  projectDir: string
  selectedPath: string | null
  expandedPaths: Set<string>
  filter: string
  onSelect: (path: string) => void
  onToggleExpand: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  onDoubleClick: (entry: FileEntry) => void
}> = ({ entry, depth, projectDir, selectedPath, expandedPaths, filter, onSelect, onToggleExpand, onContextMenu, onDoubleClick }) => {
  const expanded = expandedPaths.has(entry.path)
  const isSelected = selectedPath === entry.path

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
        onClick={() => entry.isDirectory ? onToggleExpand(entry.path) : onSelect(entry.path)}
        onDoubleClick={() => onDoubleClick(entry)}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, entry) }}
        draggable={!entry.isDirectory}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', entry.path); e.dataTransfer.effectAllowed = 'move' }}
        onDragOver={(e) => { if (entry.isDirectory) { e.preventDefault(); e.currentTarget.classList.add('ws-tree-item-drop-target') } }}
        onDragLeave={(e) => { e.currentTarget.classList.remove('ws-tree-item-drop-target') }}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('ws-tree-item-drop-target')
          if (!entry.isDirectory) return
          const sourcePath = e.dataTransfer.getData('text/plain')
          if (sourcePath && sourcePath !== entry.path) {
            getDockApi().workspaceViewer.moveClaude(projectDir, sourcePath, entry.path)
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
          selectedPath={selectedPath}
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

  return (
    <div className="ws-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {!entry.isDirectory && (
        <div className="ws-ctx-item" onClick={() => { api.workspaceViewer.openFile(projectDir, entry.path); onClose() }}>
          Open
        </div>
      )}
      <div className="ws-ctx-item" onClick={() => { api.workspaceViewer.openInExplorer(projectDir, entry.path); onClose() }}>
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
            if (name) { await api.workspaceViewer.createFile(projectDir, `${entry.path}/${name}`); onRefresh() }
            onClose()
          }}>New File</div>
          <div className="ws-ctx-item" onClick={async () => {
            const name = prompt('Folder name:')
            if (name) { await api.workspaceViewer.createFolder(projectDir, `${entry.path}/${name}`); onRefresh() }
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
          await api.workspaceViewer.delete(projectDir, entry.path)
          onRefresh()
        }
        onClose()
      }}>Delete</div>
      {!entry.isDirectory && (
        <>
          <div className="ws-ctx-separator" />
          <div className="ws-ctx-item ws-ctx-claude" onClick={() => {
            api.workspaceViewer.moveClaude(projectDir, entry.path, '')
            onClose()
          }}>Claude: Explain this file</div>
        </>
      )}
    </div>
  )
}

// --- Main Panel ---

const WorkspaceViewerPanel: React.FC<PanelProps> = ({ projectDir }) => {
  const api = getDockApi()
  const [tree, setTree] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)

  const loadGenRef = useRef(0)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadTree = useCallback(async () => {
    if (!projectDir) return
    const gen = ++loadGenRef.current
    setLoading(true)
    try {
      const result = await api.workspaceViewer.readTree(projectDir, 2)
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
  }, [projectDir])

  useEffect(() => { loadTree() }, [loadTree])

  // Watch for filesystem changes — debounce to avoid hammering on rapid edits
  useEffect(() => {
    if (!projectDir) return
    const cleanup = api.workspaceViewer.onChanged(() => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; loadTree() }, 500)
    })
    return () => { cleanup(); if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }
  }, [projectDir, loadTree])

  const handleToggleExpand = useCallback(async (entryPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(entryPath)) {
        next.delete(entryPath)
      } else {
        next.add(entryPath)
        // Lazy load children if not already loaded
        const findEntry = (items: FileEntry[]): FileEntry | null => {
          for (const item of items) {
            if (item.path === entryPath) return item
            if (item.children) { const found = findEntry(item.children); if (found) return found }
          }
          return null
        }
        const entry = findEntry(tree)
        if (entry && entry.isDirectory && !entry.children) {
          api.workspaceViewer.readDir(projectDir, entryPath).then((children) => {
            setTree((prev) => {
              const update = (items: FileEntry[]): FileEntry[] =>
                items.map((item) =>
                  item.path === entryPath ? { ...item, children } :
                  item.children ? { ...item, children: update(item.children) } : item
                )
              return update(prev)
            })
          })
        }
      }
      return next
    })
  }, [tree, projectDir])

  const handleDoubleClick = useCallback((entry: FileEntry) => {
    if (!entry.isDirectory) api.workspaceViewer.openFile(projectDir, entry.path)
  }, [projectDir])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, entry })
  }, [])

  const handleRename = useCallback(async (entryPath: string) => {
    const name = entryPath.split('/').pop() || ''
    const newName = prompt('New name:', name)
    if (newName && newName !== name) {
      await api.workspaceViewer.rename(projectDir, entryPath, newName)
      loadTree()
    }
  }, [projectDir, loadTree])

  if (loading) {
    return <div className="ws-panel"><div className="ws-panel-loading">Loading...</div></div>
  }

  return (
    <div className="ws-panel">
      <div className="ws-panel-toolbar">
        <input
          className="ws-panel-filter"
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="ws-panel-btn" onClick={loadTree} title="Refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
        </button>
      </div>
      <div className="ws-panel-tree">
        {tree.map((entry) => (
          <WorkspaceTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            projectDir={projectDir}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            filter={filter}
            onSelect={setSelectedPath}
            onToggleExpand={handleToggleExpand}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
          />
        ))}
        {tree.length === 0 && <div className="ws-panel-empty">No files found</div>}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entry={ctxMenu.entry}
          projectDir={projectDir}
          onClose={() => setCtxMenu(null)}
          onRefresh={loadTree}
          onRename={handleRename}
        />
      )}
    </div>
  )
}

export default WorkspaceViewerPanel
