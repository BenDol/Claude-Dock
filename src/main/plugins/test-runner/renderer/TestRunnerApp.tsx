import './test-runner.css'
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { useSettingsStore } from '@dock-renderer/stores/settings-store'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'

interface DetectionResult {
  adapterId: string
  configFile: string
  configDir: string
  confidence: number
}

interface TestRunResult {
  status: 'passed' | 'failed' | 'error' | 'running'
  summary: { total: number; passed: number; failed: number; skipped: number; duration?: number }
  tests: TestResult[]
}

interface TestResult {
  id: string
  name: string
  suite?: string
  status: 'passed' | 'failed' | 'skipped' | 'error'
  duration?: number
  error?: { message: string; stack?: string }
}

interface TestItem {
  id: string
  label: string
  type: 'suite' | 'file' | 'test' | 'describe'
  filePath?: string
  line?: number
  children?: TestItem[]
}

/** Collect all test IDs from a tree item (recursive) */
function collectTestIds(item: TestItem): string[] {
  if (item.type === 'test') return [item.id]
  const ids: string[] = []
  if (item.children) {
    for (const child of item.children) ids.push(...collectTestIds(child))
  }
  // If no individual tests found, use the item's own ID (file/suite level)
  return ids.length > 0 ? ids : [item.id]
}

/** Count all leaf tests in a tree */
function countTests(items: TestItem[]): number {
  let count = 0
  for (const item of items) {
    if (item.type === 'test') count++
    else if (item.children) count += countTests(item.children)
    else count++ // file/suite without children counts as 1
  }
  return count
}

const TestRunnerApp: React.FC = () => {
  const projectDir = new URLSearchParams(window.location.search).get('projectDir') || ''
  const api = getDockApi()
  const loadSettings = useSettingsStore((s) => s.load)

  // Theme — must load settings first, then apply
  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  // Block Ctrl+A from selecting all page text
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !e.shiftKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Zoom: Ctrl+MouseWheel and Ctrl++/- with persistence
  useEffect(() => {
    const ZOOM_KEY = 'testrunner-zoom'
    const MIN_ZOOM = 0.5
    const MAX_ZOOM = 2.0
    const STEP = 0.1

    const saved = localStorage.getItem(ZOOM_KEY)
    let zoom = saved ? parseFloat(saved) : 1
    if (isNaN(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) zoom = 1
    document.documentElement.style.zoom = String(zoom)

    const applyZoom = (z: number) => {
      zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100
      document.documentElement.style.zoom = String(zoom)
      localStorage.setItem(ZOOM_KEY, String(zoom))
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      applyZoom(zoom + (e.deltaY < 0 ? STEP : -STEP))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + STEP) }
      else if (e.key === '-') { e.preventDefault(); applyZoom(zoom - STEP) }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1) }
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // State
  const [frameworks, setFrameworks] = useState<DetectionResult[]>([])
  const [activeFramework, setActiveFramework] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [testTree, setTestTree] = useState<TestItem[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set())
  const [testFilter, setTestFilter] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [runningTests, setRunningTests] = useState<Set<string>>(new Set())
  const [output, setOutput] = useState('')
  const [results, setResults] = useState<TestRunResult | null>(null)
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null)
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())
  const outputRef = useRef<HTMLPreElement>(null)

  // Detect frameworks on mount
  useEffect(() => {
    if (!projectDir) return
    setDetecting(true)
    api.testRunner.detect(projectDir)
      .then((detected) => {
        setFrameworks(detected)
        if (detected.length > 0) setActiveFramework(detected[0].adapterId)
      })
      .catch(() => setFrameworks([]))
      .finally(() => setDetecting(false))
  }, [projectDir])

  // Discover tests when framework changes
  useEffect(() => {
    if (!activeFramework || !projectDir) { setTestTree([]); return }
    setDiscovering(true)
    setTestTree([])
    setSelectedTests(new Set())
    api.testRunner.discover(projectDir, activeFramework)
      .then((items) => {
        setTestTree(items)
        // Auto-expand top-level items
        setExpandedNodes(new Set(items.map((i) => i.id)))
      })
      .catch(() => setTestTree([]))
      .finally(() => setDiscovering(false))
  }, [activeFramework, projectDir])

  // Listen for output, results, status updates
  useEffect(() => {
    const cleanupOutput = api.testRunner.onOutput((data) => {
      setOutput((prev) => prev + data)
      requestAnimationFrame(() => {
        if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
      })
    })
    const cleanupResults = api.testRunner.onResults((r) => {
      setResults(r)
      setRunningTests(new Set())
    })
    const cleanupStatus = api.testRunner.onStatus((s) => {
      if (s.status !== 'running') setRunningTests(new Set())
      setRunning(s.status === 'running')
    })
    return () => { cleanupOutput(); cleanupResults(); cleanupStatus() }
  }, [])

  // Collect all test IDs from the tree for marking as running
  const allTestIds = useCallback(() => {
    const ids = new Set<string>()
    const walk = (items: TestItem[]) => {
      for (const item of items) {
        ids.add(item.id)
        if (item.children) walk(item.children)
      }
    }
    walk(testTree)
    return ids
  }, [testTree])

  const handleRunAll = useCallback(async () => {
    if (!activeFramework || running) return
    setOutput('')
    setResults(null)
    setSelectedDetailId(null)
    setExpandedErrors(new Set())
    setRunningTests(allTestIds())
    setRunning(true)
    await api.testRunner.run(projectDir, activeFramework, [])
  }, [projectDir, activeFramework, running, allTestIds])

  const handleRunSelected = useCallback(async () => {
    if (!activeFramework || running || selectedTests.size === 0) return
    setOutput('')
    setResults(null)
    setSelectedDetailId(null)
    setExpandedErrors(new Set())
    setRunningTests(new Set(selectedTests))
    setRunning(true)
    await api.testRunner.run(projectDir, activeFramework, [...selectedTests])
  }, [projectDir, activeFramework, running, selectedTests])

  const handleStop = useCallback(async () => {
    await api.testRunner.stop(projectDir)
    setRunning(false)
  }, [projectDir])

  const handleRescan = useCallback(async () => {
    setDetecting(true)
    const detected = await api.testRunner.detect(projectDir)
    setFrameworks(detected)
    if (detected.length > 0 && !detected.find((d) => d.adapterId === activeFramework)) {
      setActiveFramework(detected[0].adapterId)
    }
    setDetecting(false)
  }, [projectDir, activeFramework])

  const toggleError = (id: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTestSelection = useCallback((item: TestItem) => {
    setSelectedTests((prev) => {
      const next = new Set(prev)
      const ids = collectTestIds(item)
      const allSelected = ids.every((id) => next.has(id))
      if (allSelected) {
        for (const id of ids) next.delete(id)
      } else {
        for (const id of ids) next.add(id)
      }
      return next
    })
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    const allIds = new Set<string>()
    const collect = (items: TestItem[]) => {
      for (const item of items) {
        for (const id of collectTestIds(item)) allIds.add(id)
        if (item.children) collect(item.children)
      }
    }
    collect(testTree)
    setSelectedTests(allIds)
  }, [testTree])

  const deselectAll = useCallback(() => setSelectedTests(new Set()), [])

  // Filter test tree
  const filterTree = useCallback((items: TestItem[], q: string): TestItem[] => {
    if (!q) return items
    const lower = q.toLowerCase()
    const filtered: TestItem[] = []
    for (const item of items) {
      if (item.label.toLowerCase().includes(lower) || item.filePath?.toLowerCase().includes(lower)) {
        filtered.push(item)
      } else if (item.children) {
        const childFiltered = filterTree(item.children, q)
        if (childFiltered.length > 0) {
          filtered.push({ ...item, children: childFiltered })
        }
      }
    }
    return filtered
  }, [])

  const visibleTree = testFilter ? filterTree(testTree, testFilter) : testTree
  const totalTestCount = countTests(testTree)

  // Window controls
  const handleMinimize = () => api.win.minimize()
  const handleMaximize = () => api.win.maximize()
  const handleClose = () => api.win.close()

  return (
    <div className="tr-app">
      {/* Titlebar */}
      <div className="tr-titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="tr-titlebar-left" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <TestIcon />
          <span>Test Runner</span>
          <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>{projectDir.split(/[/\\]/).pop()}</span>
        </div>
        <div className="tr-titlebar-right" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button className="tr-titlebar-btn" onClick={handleMinimize}>&#x2015;</button>
          <button className="tr-titlebar-btn" onClick={handleMaximize}>&#9744;</button>
          <button className="tr-titlebar-btn tr-titlebar-close" onClick={handleClose}>&#10005;</button>
        </div>
      </div>

      {/* Body */}
      <div className="tr-body">
        {detecting ? (
          <div className="tr-loading">
            <span className="gm-toolbar-spinner" style={{ width: 14, height: 14 }} />
            Scanning for test frameworks...
          </div>
        ) : frameworks.length === 0 ? (
          <div className="tr-empty">
            <TestIcon size={32} />
            <span>No test frameworks detected</span>
            <span className="tr-empty-sub">Supported: Vitest, JUnit (Maven), JUnit (Gradle)</span>
            <button className="tr-run-btn tr-run-btn-secondary" onClick={handleRescan}>Scan Again</button>
          </div>
        ) : (
          <>
            {/* Framework tabs */}
            <div className="tr-framework-tabs">
              {frameworks.map((fw) => (
                <button
                  key={fw.adapterId}
                  className={`tr-framework-tab${activeFramework === fw.adapterId ? ' tr-framework-tab-active' : ''}`}
                  onClick={() => setActiveFramework(fw.adapterId)}
                >
                  {fw.adapterId === 'vitest' ? 'Vitest' : fw.adapterId === 'junit-maven' ? 'JUnit (Maven)' : fw.adapterId === 'junit-gradle' ? 'JUnit (Gradle)' : fw.adapterId}
                </button>
              ))}
            </div>

            {/* Main content */}
            <div className="tr-content">
              {/* Test Explorer — left panel */}
              <div className="tr-explorer">
                <div className="tr-explorer-header">
                  <input
                    className="tr-explorer-filter"
                    type="text"
                    placeholder="Filter tests..."
                    value={testFilter}
                    onChange={(e) => setTestFilter(e.target.value)}
                  />
                </div>
                {discovering ? (
                  <div className="tr-loading">
                    <span className="gm-toolbar-spinner" style={{ width: 12, height: 12 }} /> Discovering...
                  </div>
                ) : (
                  <>
                    <div className="tr-explorer-actions">
                      <button className="tr-explorer-action-btn" onClick={selectAll} title="Select all">All</button>
                      <button className="tr-explorer-action-btn" onClick={deselectAll} title="Deselect all">None</button>
                      <span className="tr-explorer-count">{selectedTests.size}/{totalTestCount}</span>
                    </div>
                    <div className="tr-explorer-list">
                      {visibleTree.map((item) => (
                        <TestTreeNode
                          key={item.id}
                          item={item}
                          depth={0}
                          selectedTests={selectedTests}
                          expandedNodes={expandedNodes}
                          runningTests={runningTests}
                          lastResults={results}
                          selectedDetailId={selectedDetailId}
                          onToggleSelect={toggleTestSelection}
                          onToggleExpand={toggleExpand}
                          onSelectDetail={setSelectedDetailId}
                        />
                      ))}
                      {visibleTree.length === 0 && <div className="tr-empty-small">{testFilter ? 'No matches' : 'No tests found'}</div>}
                    </div>
                  </>
                )}
              </div>

              {/* Right panel */}
              <div className="tr-right">
                {/* Run controls */}
                <div className="tr-run-controls">
                  {selectedTests.size > 0 ? (
                    <button className="tr-run-btn tr-run-btn-primary" onClick={handleRunSelected} disabled={running}>
                      {running ? 'Running...' : `Run Selected (${selectedTests.size})`}
                    </button>
                  ) : (
                    <button className="tr-run-btn tr-run-btn-primary" onClick={handleRunAll} disabled={running || !activeFramework}>
                      {running ? 'Running...' : 'Run All'}
                    </button>
                  )}
                  {running && (
                    <button className="tr-run-btn tr-run-btn-danger" onClick={handleStop}>
                      Stop
                    </button>
                  )}
                  {results && results.summary.failed > 0 && !running && (
                    <button className="tr-run-btn tr-run-btn-secondary" onClick={handleRunAll}>
                      Re-run Failed
                    </button>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className="tr-run-btn tr-run-btn-secondary" onClick={handleRescan} disabled={running} title="Re-scan for frameworks">
                    Refresh
                  </button>
                </div>

                {/* Summary bar */}
                {results && (
                  <div className="tr-results-summary">
                    {results.summary.passed > 0 && <span className="tr-results-passed">{results.summary.passed} passed</span>}
                    {results.summary.failed > 0 && <span className="tr-results-failed">{results.summary.failed} failed</span>}
                    {results.summary.skipped > 0 && <span className="tr-results-skipped">{results.summary.skipped} skipped</span>}
                    <span>{results.summary.total} total</span>
                    {results.summary.duration != null && <span>{(results.summary.duration / 1000).toFixed(1)}s</span>}
                  </div>
                )}

                {/* Test detail or output */}
                {selectedDetailId && results ? (
                  <TestDetailPanel
                    testResult={results.tests.find((t) => t.id === selectedDetailId || t.name === selectedDetailId)}
                    output={output}
                    onClose={() => setSelectedDetailId(null)}
                    onShowOutput={() => setSelectedDetailId(null)}
                  />
                ) : (
                  <pre className="tr-output" ref={outputRef}>
                    {output || (running ? 'Starting test run...\n' : 'Click "Run All Tests" to start.\n')}
                  </pre>
                )}

                {/* Legacy results list removed — status now shown inline in tree */}
                {false && results && (
                  <div className="tr-results">
                    <div className="tr-results-list"></div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="tr-status-bar">
        <span>{running ? 'Running...' : results ? (results.status === 'passed' ? 'All tests passed' : results.status === 'failed' ? 'Some tests failed' : results.status) : 'Idle'}</span>
        <span style={{ flex: 1 }} />
        {activeFramework && <span>{activeFramework}</span>}
      </div>
    </div>
  )
}

// --- Test tree node ---

const TestTreeNode: React.FC<{
  item: TestItem
  depth: number
  selectedTests: Set<string>
  expandedNodes: Set<string>
  runningTests: Set<string>
  lastResults: TestRunResult | null
  selectedDetailId: string | null
  onToggleSelect: (item: TestItem) => void
  onToggleExpand: (id: string) => void
  onSelectDetail: (id: string) => void
}> = ({ item, depth, selectedTests, expandedNodes, runningTests, lastResults, selectedDetailId, onToggleSelect, onToggleExpand, onSelectDetail }) => {
  const hasChildren = item.children && item.children.length > 0
  const expanded = expandedNodes.has(item.id)
  const testIds = collectTestIds(item)
  const allSelected = testIds.every((id) => selectedTests.has(id))
  const someSelected = !allSelected && testIds.some((id) => selectedTests.has(id))

  // Determine state: running, passed, failed, or idle
  const isRunning = runningTests.has(item.id) || testIds.some((id) => runningTests.has(id))
  const resultEntry = lastResults?.tests.find((t) => t.id === item.id || t.name === item.label)
  const resultStatus = resultEntry?.status
  const isDetailSelected = selectedDetailId === item.id

  // For suites/describes: aggregate child results
  const hasFailedChild = hasChildren && lastResults?.tests.some((t) => {
    return testIds.includes(t.id) && t.status === 'failed'
  })
  const allChildrenPassed = hasChildren && !isRunning && lastResults && testIds.length > 0 &&
    testIds.every((id) => lastResults.tests.some((t) => t.id === id && t.status === 'passed'))

  // Determine what icon to show in place of the checkbox
  const showStatusIcon = isRunning || resultStatus || hasFailedChild || allChildrenPassed

  const handleClick = () => {
    if (resultEntry && !hasChildren) {
      onSelectDetail(item.id)
    } else if (hasChildren) {
      onToggleExpand(item.id)
    } else {
      onToggleSelect(item)
    }
  }

  return (
    <>
      <div
        className={`tr-tree-item${isDetailSelected ? ' tr-tree-item-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={handleClick}
      >
        {hasChildren && (
          <span className={`tr-tree-arrow${expanded ? ' tr-tree-arrow-open' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleExpand(item.id) }}>&#9656;</span>
        )}
        {!hasChildren && <span className="tr-tree-arrow-spacer" />}
        {showStatusIcon ? (
          <span className="tr-tree-status-icon">
            {isRunning ? (
              <span className="tr-tree-spinner" />
            ) : resultStatus === 'passed' || allChildrenPassed ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ece6a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            ) : resultStatus === 'failed' || hasFailedChild ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f7768e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            ) : resultStatus === 'skipped' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e0af68" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            ) : (
              <input type="checkbox" className="tr-tree-checkbox" checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected }}
                onChange={() => onToggleSelect(item)} onClick={(e) => e.stopPropagation()} />
            )}
          </span>
        ) : (
          <input type="checkbox" className="tr-tree-checkbox" checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = someSelected }}
            onChange={() => onToggleSelect(item)} onClick={(e) => e.stopPropagation()} />
        )}
        <span className="tr-tree-label">{item.label}</span>
        {resultEntry?.duration != null && <span className="tr-tree-duration">{resultEntry.duration}ms</span>}
      </div>
      {hasChildren && expanded && item.children!.map((child) => (
        <TestTreeNode
          key={child.id}
          item={child}
          depth={depth + 1}
          selectedTests={selectedTests}
          expandedNodes={expandedNodes}
          runningTests={runningTests}
          lastResults={lastResults}
          selectedDetailId={selectedDetailId}
          onToggleSelect={onToggleSelect}
          onToggleExpand={onToggleExpand}
          onSelectDetail={onSelectDetail}
        />
      ))}
    </>
  )
}

// --- Test detail panel ---

const TestDetailPanel: React.FC<{
  testResult?: TestResult
  output: string
  onClose: () => void
  onShowOutput: () => void
}> = ({ testResult, output, onClose, onShowOutput }) => {
  if (!testResult) {
    return (
      <div className="tr-detail">
        <div className="tr-detail-header">
          <span>Test not found in results</span>
          <button className="tr-detail-close" onClick={onClose}>&#10005;</button>
        </div>
      </div>
    )
  }

  const statusLabel = testResult.status === 'passed' ? 'PASSED' : testResult.status === 'failed' ? 'FAILED' : testResult.status === 'skipped' ? 'SKIPPED' : 'ERROR'

  return (
    <div className="tr-detail">
      <div className="tr-detail-header">
        <span className={`tr-detail-status tr-detail-status-${testResult.status}`}>
          {testResult.status === 'passed' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          ) : testResult.status === 'failed' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          )}
          {statusLabel}
        </span>
        <span className="tr-detail-name">{testResult.suite ? `${testResult.suite} > ` : ''}{testResult.name}</span>
        <span style={{ flex: 1 }} />
        {testResult.duration != null && <span className="tr-detail-duration">{testResult.duration}ms</span>}
        <button className="tr-detail-btn" onClick={onShowOutput} title="Show raw output">Output</button>
        <button className="tr-detail-close" onClick={onClose}>&#10005;</button>
      </div>

      <div className="tr-detail-body">
        {testResult.status === 'passed' && !testResult.error && (
          <div className="tr-detail-pass-msg">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ece6a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            <span>Test passed successfully</span>
            {testResult.duration != null && <span className="tr-detail-duration-large">in {testResult.duration}ms</span>}
          </div>
        )}

        {testResult.status === 'skipped' && (
          <div className="tr-detail-skip-msg">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e0af68" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span>Test was skipped</span>
          </div>
        )}

        {testResult.error && (
          <div className="tr-detail-error">
            <div className="tr-detail-error-header">Error</div>
            <div className="tr-detail-error-message">{testResult.error.message}</div>
            {testResult.error.expected != null && testResult.error.actual != null && (
              <div className="tr-detail-diff">
                <div className="tr-detail-diff-row">
                  <span className="tr-detail-diff-label">Expected:</span>
                  <code className="tr-detail-diff-value tr-detail-diff-expected">{testResult.error.expected}</code>
                </div>
                <div className="tr-detail-diff-row">
                  <span className="tr-detail-diff-label">Actual:</span>
                  <code className="tr-detail-diff-value tr-detail-diff-actual">{testResult.error.actual}</code>
                </div>
              </div>
            )}
            {testResult.error.stack && (
              <pre className="tr-detail-stack">{testResult.error.stack}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const TestIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 2v6l-2 4v6a2 2 0 002 2h6a2 2 0 002-2v-6l-2-4V2" />
    <line x1="8" y1="2" x2="16" y2="2" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </svg>
)

export default TestRunnerApp
