import React, { useState, useRef, useCallback } from 'react'
import { useDockStore } from '../stores/dock-store'

interface TerminalTitleProps {
  terminalId: string
  title: string
}

const TerminalTitle: React.FC<TerminalTitleProps> = ({ terminalId, title }) => {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const setTerminalTitle = useDockStore((s) => s.setTerminalTitle)

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
      {title}
    </span>
  )
}

export default React.memo(TerminalTitle)
