import React, { useState, useRef, useCallback } from 'react'
import { useDockStore } from '../stores/dock-store'

interface TerminalTitleProps {
  terminalId: string
  title: string
}

const RepairIcon: React.FC = () => (
  <svg className="terminal-title-fix-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
)

const TerminalTitle: React.FC<TerminalTitleProps> = ({ terminalId, title }) => {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const setTerminalTitle = useDockStore((s) => s.setTerminalTitle)
  const isCiFix = useDockStore((s) => s.ciFixTerminals.has(terminalId))

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

  return (
    <span className="terminal-title" onDoubleClick={startEditing} title="Double-click to edit">
      {isCiFix && <RepairIcon />}
      {title}
    </span>
  )
}

export default React.memo(TerminalTitle)
