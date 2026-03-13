import React, { useState, useRef, useCallback } from 'react'
import { useDockStore } from '../stores/dock-store'

interface TerminalTitleProps {
  terminalId: string
  title: string
}

const RepairIcon: React.FC = () => (
  <svg className="terminal-title-task-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
)

const BeakerIcon: React.FC = () => (
  <svg className="terminal-title-task-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2v6.5L20 22H4L9.5 8.5V2" />
    <line x1="8" y1="2" x2="16" y2="2" />
    <line x1="6" y1="18" x2="18" y2="18" />
  </svg>
)

const taskInfo: Record<string, { icon: React.FC; label: string }> = {
  'ci-fix': { icon: RepairIcon, label: 'CI Fix' },
  'write-tests': { icon: BeakerIcon, label: 'Write Tests' }
}

const TerminalTitle: React.FC<TerminalTitleProps> = ({ terminalId, title }) => {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const setTerminalTitle = useDockStore((s) => s.setTerminalTitle)
  const taskType = useDockStore((s) => s.claudeTaskTerminals.get(terminalId))
  const flags = useDockStore((s) => s.claudeTaskFlags.get(terminalId))

  const startEditing = useCallback(() => {
    setEditValue(title)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [title])

  const commitEdit = useCallback(() => {
    setEditing(false)
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== title) {
      setTerminalTitle(terminalId, trimmed)
    }
  }, [editValue, title, terminalId, setTerminalTitle])

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="terminal-title-input"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitEdit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  const task = taskType ? taskInfo[taskType] : null

  // Extract permission mode from flags string for display
  let permSuffix = ''
  if (task && flags) {
    const modeMatch = flags.match(/--permission-mode\s+(\S+)/)
    if (modeMatch) {
      const modeLabels: Record<string, string> = { acceptEdits: 'auto-edit', bypassPermissions: 'auto-all' }
      permSuffix = modeLabels[modeMatch[1]] || modeMatch[1]
    }
  }

  return (
    <span className="terminal-title" onDoubleClick={startEditing} title="Double-click to edit">
      {task && <task.icon />}
      {title}
      {task && <span className="terminal-title-task-label">{task.label}{permSuffix && ` (${permSuffix})`}</span>}
    </span>
  )
}

export default React.memo(TerminalTitle)
