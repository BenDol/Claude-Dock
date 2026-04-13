import React, { useState, useRef, useEffect } from 'react'

interface FilePasteComposeProps {
  data: {
    files: { name: string; path: string }[]
    image?: { tempPath: string }
  }
  onSubmit: (contextText: string) => void
  onCancel: () => void
  onRemoveFile?: (index: number) => void
}

const FilePasteCompose: React.FC<FilePasteComposeProps> = ({ data, onSubmit, onCancel, onRemoveFile }) => {
  const [contextText, setContextText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onSubmit(contextText)
    }
  }

  const totalItems = data.files.length + (data.image ? 1 : 0)

  return (
    <div className="file-paste-compose" onKeyDown={handleKeyDown}>
      <div className="file-paste-header">
        <span className="file-paste-title">
          {totalItems} file{totalItems !== 1 ? 's' : ''} attached
        </span>
        <button className="file-paste-close" onClick={onCancel} title="Cancel (Esc)">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </div>
      <div className="file-paste-files">
        {data.files.map((f, i) => (
          <div key={i} className="file-paste-chip">
            <svg className="file-paste-chip-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 1h5.586L13 4.414V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm5 1H4v12h8V5H9V2z" />
            </svg>
            <span className="file-paste-chip-name" title={f.path}>{f.name}</span>
            {onRemoveFile && (
              <button className="file-paste-chip-remove" onClick={() => onRemoveFile(i)} title="Remove">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                </svg>
              </button>
            )}
          </div>
        ))}
        {data.image && (
          <div className="file-paste-chip file-paste-chip-image">
            <svg className="file-paste-chip-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm1 0v7l2.5-2.5L8 10l2-2 3 3V3H3z" />
            </svg>
            <span className="file-paste-chip-name">Screenshot</span>
          </div>
        )}
      </div>
      <textarea
        ref={textareaRef}
        className="file-paste-context"
        value={contextText}
        onChange={(e) => setContextText(e.target.value)}
        placeholder="Add context (optional)... Ctrl+Enter to send"
        rows={2}
        spellCheck={false}
      />
      <div className="file-paste-actions">
        <button className="file-paste-cancel" onClick={onCancel}>Cancel</button>
        <button className="file-paste-submit" onClick={() => onSubmit(contextText)}>
          Send to Claude
        </button>
      </div>
    </div>
  )
}

export default FilePasteCompose
