/**
 * SearchPanel — advanced file content search for the workspace plugin.
 * Slides in below the filter bar when activated via Ctrl+F or Ctrl+Shift+F.
 */
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { useEditorStore, isBinaryFile } from '@dock-renderer/stores/editor-store'

interface SearchMatch {
  filePath: string
  line: number
  column: number
  text: string
  matchStart: number
  matchEnd: number
}

interface SearchResult {
  matches: SearchMatch[]
  totalMatches: number
  truncated: boolean
  durationMs: number
}

interface SearchPanelProps {
  projectDir: string
  visible: boolean
  onClose: () => void
}

const MATCHES_PER_FILE_INITIAL = 20
const MATCHES_PER_FILE_INCREMENT = 50

const SearchPanel: React.FC<SearchPanelProps> = ({ projectDir, visible, onClose }) => {
  const api = getDockApi()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [filePattern, setFilePattern] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [visibleMatchLimits, setVisibleMatchLimits] = useState<Map<string, number>>(new Map())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchGenRef = useRef(0)

  // Focus input when panel opens
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [visible])

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (!q || q.length < 2) { setResult(null); setSearching(false); return }
    const gen = ++searchGenRef.current
    setSearching(true)
    try {
      const r = await api.workspace.search(projectDir, {
        query: q,
        caseSensitive,
        wholeWord,
        regex,
        filePattern: filePattern || undefined
      })
      if (gen !== searchGenRef.current) return // stale
      setResult(r)
      // Auto-expand first 5 files
      const first5 = [...new Set(r.matches.map((m: SearchMatch) => m.filePath))].slice(0, 5)
      setExpandedFiles(new Set(first5))
      setVisibleMatchLimits(new Map())
    } catch { if (gen === searchGenRef.current) setResult(null) }
    if (gen === searchGenRef.current) setSearching(false)
  }, [projectDir, caseSensitive, wholeWord, regex, filePattern])

  const triggerSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(q), 300)
  }, [doSearch])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  // Re-search when toggles change
  useEffect(() => {
    if (query.length >= 2) triggerSearch(query)
  }, [caseSensitive, wholeWord, regex, filePattern])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      doSearch(query)
    }
  }, [query, doSearch, onClose])

  // Group matches by file
  const groupedMatches = useMemo(() => {
    if (!result) return []
    const map = new Map<string, SearchMatch[]>()
    for (const m of result.matches) {
      if (!map.has(m.filePath)) map.set(m.filePath, [])
      map.get(m.filePath)!.push(m)
    }
    return [...map.entries()].map(([filePath, matches]) => ({ filePath, matches }))
  }, [result])

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }, [])

  const showMoreMatches = useCallback((filePath: string, total: number) => {
    setVisibleMatchLimits((prev) => {
      const next = new Map(prev)
      const current = prev.get(filePath) ?? MATCHES_PER_FILE_INITIAL
      next.set(filePath, Math.min(current + MATCHES_PER_FILE_INCREMENT, total))
      return next
    })
  }, [])

  const openMatch = useCallback(async (match: SearchMatch) => {
    if (isBinaryFile(match.filePath.split('/').pop() || '')) return
    const r = await api.workspace.readFile(projectDir, match.filePath)
    if (r.content != null) {
      useEditorStore.getState().openFile(projectDir, match.filePath, r.content)
    }
  }, [projectDir])

  const handleReplaceInFile = useCallback(async (filePath: string) => {
    if (!query) return
    setReplacing(true)
    const r = await api.workspace.replace(projectDir, { query, replacement, filePath, caseSensitive, wholeWord, regex })
    setReplacing(false)
    if (r.replacements > 0) {
      setReplaceMsg(`Replaced ${r.replacements} in ${filePath.split('/').pop()}`)
      setTimeout(() => setReplaceMsg(null), 3000)
      doSearch(query) // re-search to update results
    }
  }, [query, replacement, projectDir, caseSensitive, wholeWord, regex, doSearch])

  const handleReplaceAll = useCallback(async () => {
    if (!query) return
    const count = result?.totalMatches ?? 0
    if (count > 0 && !confirm(`Replace ${count} occurrence${count > 1 ? 's' : ''} across ${groupedMatches.length} file${groupedMatches.length > 1 ? 's' : ''}?`)) return
    setReplacing(true)
    const r = await api.workspace.replace(projectDir, { query, replacement, caseSensitive, wholeWord, regex })
    setReplacing(false)
    setReplaceMsg(`Replaced ${r.replacements} in ${r.filesChanged} file${r.filesChanged > 1 ? 's' : ''}`)
    setTimeout(() => setReplaceMsg(null), 3000)
    if (r.errors.length > 0) setReplaceMsg(`${r.replacements} replaced, ${r.errors.length} error(s)`)
    doSearch(query) // re-search
  }, [query, replacement, projectDir, caseSensitive, wholeWord, regex, result, groupedMatches, doSearch])

  // Undo/redo for replace operations (Ctrl+Z/Y when search panel is visible with replace open)
  useEffect(() => {
    if (!visible || !showReplace) return
    const handler = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // Only handle when focus is inside the search panel
      const panel = document.querySelector('.ws-search-panel')
      if (!panel?.contains(document.activeElement) && !panel?.matches(':hover')) return

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        const r = await api.workspace.undoReplace()
        if (r.success) {
          setReplaceMsg(`Undo: restored ${r.filesRestored} file${r.filesRestored > 1 ? 's' : ''}`)
          setTimeout(() => setReplaceMsg(null), 3000)
          if (query.length >= 2) doSearch(query)
        }
      } else if (e.key === 'y' || (e.key === 'Z' && e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        const r = await api.workspace.redoReplace()
        if (r.success) {
          setReplaceMsg(`Redo: re-applied to ${r.filesRestored} file${r.filesRestored > 1 ? 's' : ''}`)
          setTimeout(() => setReplaceMsg(null), 3000)
          if (query.length >= 2) doSearch(query)
        }
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true } as any)
  }, [visible, showReplace, query, doSearch])

  if (!visible) return null

  return (
    <div className="ws-search-panel">
      <div className="ws-search-input-row">
        <input
          ref={inputRef}
          className="ws-search-input"
          type="text"
          placeholder="Search in files..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); triggerSearch(e.target.value) }}
          onKeyDown={handleKeyDown}
        />
        <button
          className={`ws-search-toggle${caseSensitive ? ' ws-search-toggle-active' : ''}`}
          onClick={() => setCaseSensitive(!caseSensitive)}
          title="Match Case"
        >Aa</button>
        <button
          className={`ws-search-toggle${wholeWord ? ' ws-search-toggle-active' : ''}`}
          onClick={() => setWholeWord(!wholeWord)}
          title="Match Whole Word"
        >ab</button>
        <button
          className={`ws-search-toggle${regex ? ' ws-search-toggle-active' : ''}`}
          onClick={() => setRegex(!regex)}
          title="Use Regular Expression"
        >.*</button>
        <button className={`ws-search-toggle${showReplace ? ' ws-search-toggle-active' : ''}`} onClick={() => setShowReplace(!showReplace)} title="Toggle Replace">&#8644;</button>
        <button className="ws-search-close" onClick={onClose} title="Close search">×</button>
      </div>
      {showReplace && (
        <div className="ws-search-input-row ws-search-replace-row">
          <input
            className="ws-search-input"
            type="text"
            placeholder="Replace with..."
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleReplaceAll() }}
          />
          <button className="ws-search-replace-all-btn" onClick={handleReplaceAll} disabled={replacing || !query || !result?.totalMatches} title="Replace All">
            {replacing ? '...' : 'All'}
          </button>
          <button className="ws-search-undo-btn" onClick={async () => {
            const r = await api.workspace.undoReplace()
            if (r.success) { setReplaceMsg(`Undo: restored ${r.filesRestored} file${r.filesRestored > 1 ? 's' : ''}`); setTimeout(() => setReplaceMsg(null), 3000); if (query.length >= 2) doSearch(query) }
          }} title="Undo last replace (Ctrl+Z)">&#x21A9;</button>
          <button className="ws-search-undo-btn" onClick={async () => {
            const r = await api.workspace.redoReplace()
            if (r.success) { setReplaceMsg(`Redo: ${r.filesRestored} file${r.filesRestored > 1 ? 's' : ''}`); setTimeout(() => setReplaceMsg(null), 3000); if (query.length >= 2) doSearch(query) }
          }} title="Redo last replace (Ctrl+Y)">&#x21AA;</button>
        </div>
      )}
      {replaceMsg && <div className="ws-search-replace-msg">{replaceMsg}</div>}
      <div className="ws-search-filter-row">
        <input
          className="ws-search-file-filter"
          type="text"
          placeholder="Files to include (e.g. *.ts, src/**)"
          value={filePattern}
          onChange={(e) => setFilePattern(e.target.value)}
        />
      </div>
      <div className="ws-search-results">
        {searching && <div className="ws-search-status">Searching...</div>}
        {!searching && result && (
          <div className="ws-search-status">
            {result.totalMatches} result{result.totalMatches !== 1 ? 's' : ''} in {groupedMatches.length} file{groupedMatches.length !== 1 ? 's' : ''}
            {result.truncated && ' (truncated)'}
            <span className="ws-search-duration">{result.durationMs}ms</span>
          </div>
        )}
        {groupedMatches.map(({ filePath, matches }) => {
          const expanded = expandedFiles.has(filePath)
          const visibleLimit = visibleMatchLimits.get(filePath) ?? MATCHES_PER_FILE_INITIAL
          const visibleMatches = expanded ? matches.slice(0, visibleLimit) : []
          const hasMore = expanded && matches.length > visibleLimit
          return (
            <div key={filePath} className="ws-search-file-group">
              <div className="ws-search-file-header" onClick={() => toggleFile(filePath)}>
                <span className={`ws-tree-arrow${expanded ? ' ws-tree-arrow-open' : ''}`}>&#9656;</span>
                <span className="ws-search-file-name">{filePath}</span>
                <span className="ws-search-file-count">{matches.length}</span>
                {showReplace && (
                  <button className="ws-search-replace-file-btn" onClick={(e) => { e.stopPropagation(); handleReplaceInFile(filePath) }} title={`Replace all in ${filePath.split('/').pop()}`}>
                    &#8644;
                  </button>
                )}
              </div>
              {visibleMatches.map((m, i) => (
                <div key={i} className="ws-search-match" onClick={() => openMatch(m)}>
                  <span className="ws-search-match-line">L{m.line}</span>
                  <span className="ws-search-match-text" dangerouslySetInnerHTML={{
                    __html: highlightMatch(m.text, query, caseSensitive, regex)
                  }} />
                </div>
              ))}
              {hasMore && (
                <div className="ws-search-show-more" onClick={() => showMoreMatches(filePath, matches.length)}>
                  Show {Math.min(MATCHES_PER_FILE_INCREMENT, matches.length - visibleLimit)} more ({matches.length - visibleLimit} remaining)
                </div>
              )}
            </div>
          )
        })}
        {!searching && result && result.totalMatches === 0 && query.length >= 2 && (
          <div className="ws-search-empty">No results found</div>
        )}
      </div>
    </div>
  )
}

/** Highlight the query match within the text line (XSS-safe) */
function highlightMatch(text: string, query: string, caseSensitive: boolean, isRegex: boolean): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  try {
    const escaped = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const flags = caseSensitive ? 'g' : 'gi'
    const re = new RegExp(escaped, flags)
    const parts: string[] = []
    let lastIndex = 0
    let m: RegExpExecArray | null
    let safety = 0
    while ((m = re.exec(text)) !== null) {
      // Guard against zero-length matches causing infinite loops
      if (m[0].length === 0) { re.lastIndex++; continue }
      if (++safety > 1000) break
      if (m.index > lastIndex) parts.push(esc(text.slice(lastIndex, m.index)))
      parts.push(`<mark class="ws-search-highlight">${esc(m[0])}</mark>`)
      lastIndex = re.lastIndex
      if (!re.global) break
    }
    if (lastIndex < text.length) parts.push(esc(text.slice(lastIndex)))
    return parts.join('')
  } catch {
    return esc(text)
  }
}

export default SearchPanel
