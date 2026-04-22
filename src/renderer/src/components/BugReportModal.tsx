import React, { useCallback, useEffect, useRef, useState } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import type { BugReportCategory, BugReportInput } from '../../../shared/bug-report-types'
import './BugReportModal.css'

interface Props {
  onClose: () => void
}

const TITLE_MIN = 3
const TITLE_MAX = 200
const DESCRIPTION_MIN = 10
const DESCRIPTION_MAX = 5000
const STEPS_MAX = 2000

// Per-modal zoom — remembered across opens. Starts from whatever zoom the
// main dock document currently has (typically 1) so that if the user has
// globally scaled the dock, the modal matches on first view. CSS `zoom` on
// the modal root compounds with any ancestor zoom, so this is a *relative*
// scale on top of the main-window zoom.
const BUG_REPORT_ZOOM_KEY = 'bug-report-zoom'
const MIN_BUG_REPORT_ZOOM = 0.6
const MAX_BUG_REPORT_ZOOM = 2.2
const BUG_REPORT_ZOOM_STEP = 0.1
function readInitialBugReportZoom(): number {
  try {
    const saved = localStorage.getItem(BUG_REPORT_ZOOM_KEY)
    if (saved) {
      const n = parseFloat(saved)
      if (!isNaN(n) && n >= MIN_BUG_REPORT_ZOOM && n <= MAX_BUG_REPORT_ZOOM) return n
    }
  } catch { /* ignore */ }
  // Fall back to the main dock's current document zoom so a user who has
  // scaled the dock globally gets a matching starting point.
  const docZoom = parseFloat(document.documentElement.style.zoom) || 1
  return Math.min(MAX_BUG_REPORT_ZOOM, Math.max(MIN_BUG_REPORT_ZOOM, docZoom))
}

const CATEGORIES: { value: BugReportCategory; label: string; hint: string }[] = [
  { value: 'bug', label: 'Bug', hint: 'Something is broken or not working as expected' },
  { value: 'crash', label: 'Crash / freeze', hint: 'The app crashed, froze, or became unresponsive' },
  { value: 'feature-request', label: 'Feature request', hint: 'Suggest a new feature or improvement' },
  { value: 'question', label: 'Question', hint: 'Ask a question or request help' }
]

export default function BugReportModal({ onClose }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [zoom, setZoom] = useState<number>(() => readInitialBugReportZoom())

  const applyZoom = useCallback((z: number) => {
    const clamped = Math.round(Math.min(MAX_BUG_REPORT_ZOOM, Math.max(MIN_BUG_REPORT_ZOOM, z)) * 100) / 100
    setZoom(clamped)
    try { localStorage.setItem(BUG_REPORT_ZOOM_KEY, String(clamped)) } catch { /* ignore */ }
  }, [])

  // Ctrl+Wheel and Ctrl +/-/0 zoom while the modal is open. Capture-phase so
  // we intercept before any global zoom handler; scoped to events inside the
  // modal root so the rest of the dock is unaffected.
  useEffect(() => {
    const root = modalRef.current
    if (!root) return

    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (!root.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
      applyZoom(zoom + (e.deltaY < 0 ? BUG_REPORT_ZOOM_STEP : -BUG_REPORT_ZOOM_STEP))
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopPropagation(); applyZoom(zoom + BUG_REPORT_ZOOM_STEP) }
      else if (e.key === '-') { e.preventDefault(); e.stopPropagation(); applyZoom(zoom - BUG_REPORT_ZOOM_STEP) }
      else if (e.key === '0') { e.preventDefault(); e.stopPropagation(); applyZoom(1) }
    }

    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
    }
  }, [zoom, applyZoom])

  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<BugReportCategory>('bug')
  const [description, setDescription] = useState('')
  const [stepsToReproduce, setStepsToReproduce] = useState('')
  const [githubHandle, setGithubHandle] = useState('')
  const [includeLogs, setIncludeLogs] = useState(true)
  const [includeSystemInfo, setIncludeSystemInfo] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{ issueUrl: string; issueNumber: number } | null>(null)

  useEffect(() => {
    const t = setTimeout(() => titleInputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  const trimmedTitle = title.trim()
  const trimmedDescription = description.trim()
  const titleValid = trimmedTitle.length >= TITLE_MIN && trimmedTitle.length <= TITLE_MAX
  const descriptionValid = trimmedDescription.length >= DESCRIPTION_MIN && trimmedDescription.length <= DESCRIPTION_MAX
  const canSubmit = titleValid && descriptionValid && !submitting

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return

    setSubmitting(true)
    setError(null)

    const input: BugReportInput = {
      title: trimmedTitle,
      description: trimmedDescription,
      category,
      stepsToReproduce: stepsToReproduce.trim() || undefined,
      githubHandle: githubHandle.trim() || undefined,
      includeLogs,
      includeSystemInfo
    }

    try {
      const api = getDockApi()
      const result = await api.bugReport.submit(input)

      if (result.success) {
        setSubmitted({ issueUrl: result.issueUrl, issueNumber: result.issueNumber })
        try {
          api.notifications.emit({
            id: `bug-report-success-${result.issueNumber}`,
            title: 'Bug report submitted',
            message: `Issue #${result.issueNumber} created on GitHub`,
            type: 'success',
            timeout: 8000,
            action: { label: 'View on GitHub', url: result.issueUrl }
          } as any)
        } catch { /* notifications are best-effort */ }
      } else {
        setError(result.error || 'Failed to submit bug report')
        setSubmitting(false)
      }
    } catch (err: any) {
      setError(err?.message || 'Unexpected error submitting bug report')
      setSubmitting(false)
    }
  }, [canSubmit, trimmedTitle, trimmedDescription, category, stepsToReproduce, githubHandle, includeLogs, includeSystemInfo])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current && !submitting) onClose()
    },
    [onClose, submitting]
  )

  const openIssue = useCallback(() => {
    if (!submitted) return
    try {
      getDockApi().app?.openExternal?.(submitted.issueUrl)
    } catch {
      // Fallback: copy to clipboard is handled by OS if openExternal fails
      try { window.open(submitted.issueUrl, '_blank') } catch { /* ok */ }
    }
  }, [submitted])

  return (
    <div className="modal-overlay bug-report-overlay" ref={backdropRef} onClick={handleBackdropClick}>
      <div
        className="modal bug-report-modal"
        role="dialog"
        aria-labelledby="bug-report-title"
        ref={modalRef}
        style={{ zoom }}
      >
        <div className="modal-header">
          <h2 id="bug-report-title">Report a Bug</h2>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            title="Close"
          >
            {'\u2715'}
          </button>
        </div>

        <div className="modal-body bug-report-body">
          {submitted ? (
            <div className="bug-report-success">
              <div className="bug-report-success-icon" aria-hidden>{'\u2713'}</div>
              <div className="bug-report-success-title">Thanks for the report!</div>
              <div className="bug-report-success-message">
                Your bug report was submitted as{' '}
                <button className="bug-report-issue-link" onClick={openIssue}>
                  issue #{submitted.issueNumber}
                </button>
                . We'll look into it.
              </div>
            </div>
          ) : (
            <>
              {error && (
                <div className="bug-report-error" role="alert">
                  <span className="bug-report-error-icon" aria-hidden>!</span>
                  <span>{error}</span>
                </div>
              )}

              <div className="bug-report-intro">
                Found a bug or have a suggestion? Let us know below. Your report will be posted as a GitHub issue on{' '}
                <span className="bug-report-repo">BenDol/Claude-Dock</span>.
              </div>

              <div className="bug-report-field">
                <label htmlFor="bug-report-title-input">Title *</label>
                <input
                  id="bug-report-title-input"
                  ref={titleInputRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short summary of the issue"
                  maxLength={TITLE_MAX + 10}
                  disabled={submitting}
                />
                <div className="bug-report-field-hint">
                  {trimmedTitle.length}/{TITLE_MAX}
                  {!titleValid && trimmedTitle.length > 0 && (
                    <span className="bug-report-field-error">
                      {trimmedTitle.length < TITLE_MIN
                        ? ` — at least ${TITLE_MIN} characters`
                        : ` — max ${TITLE_MAX} characters`}
                    </span>
                  )}
                </div>
              </div>

              <div className="bug-report-field">
                <label htmlFor="bug-report-category-input">Category</label>
                <select
                  id="bug-report-category-input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as BugReportCategory)}
                  disabled={submitting}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <div className="bug-report-field-hint">
                  {CATEGORIES.find((c) => c.value === category)?.hint}
                </div>
              </div>

              <div className="bug-report-field">
                <label htmlFor="bug-report-description-input">Description *</label>
                <textarea
                  id="bug-report-description-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What happened? What did you expect?"
                  rows={5}
                  maxLength={DESCRIPTION_MAX + 100}
                  disabled={submitting}
                />
                <div className="bug-report-field-hint">
                  {trimmedDescription.length}/{DESCRIPTION_MAX}
                  {!descriptionValid && trimmedDescription.length > 0 && (
                    <span className="bug-report-field-error">
                      {trimmedDescription.length < DESCRIPTION_MIN
                        ? ` — at least ${DESCRIPTION_MIN} characters`
                        : ` — max ${DESCRIPTION_MAX} characters`}
                    </span>
                  )}
                </div>
              </div>

              <div className="bug-report-field">
                <label htmlFor="bug-report-steps-input">Steps to reproduce (optional)</label>
                <textarea
                  id="bug-report-steps-input"
                  value={stepsToReproduce}
                  onChange={(e) => setStepsToReproduce(e.target.value)}
                  placeholder={'1. Open a terminal\n2. Run ...\n3. See error'}
                  rows={4}
                  maxLength={STEPS_MAX + 100}
                  disabled={submitting}
                />
              </div>

              <div className="bug-report-field">
                <label htmlFor="bug-report-handle-input">Your GitHub handle (optional)</label>
                <input
                  id="bug-report-handle-input"
                  type="text"
                  value={githubHandle}
                  onChange={(e) => setGithubHandle(e.target.value)}
                  placeholder="@yourname"
                  maxLength={40}
                  disabled={submitting}
                />
                <div className="bug-report-field-hint">
                  Provide your handle if you'd like a mention when we follow up on this issue.
                </div>
              </div>

              <div className="bug-report-attachments">
                <div className="bug-report-attachments-title">Attachments</div>
                <label className="bug-report-checkbox">
                  <input
                    type="checkbox"
                    checked={includeLogs}
                    onChange={(e) => setIncludeLogs(e.target.checked)}
                    disabled={submitting}
                  />
                  <span>
                    <span className="bug-report-checkbox-label">Include debug logs</span>
                    <span className="bug-report-checkbox-hint">
                      Latest ~40KB from your most recent log file. May contain file paths and terminal output.
                    </span>
                  </span>
                </label>
                <label className="bug-report-checkbox">
                  <input
                    type="checkbox"
                    checked={includeSystemInfo}
                    onChange={(e) => setIncludeSystemInfo(e.target.checked)}
                    disabled={submitting}
                  />
                  <span>
                    <span className="bug-report-checkbox-label">Include system info</span>
                    <span className="bug-report-checkbox-hint">
                      OS, architecture, app version, memory usage, uptime.
                    </span>
                  </span>
                </label>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer bug-report-footer">
          {submitted ? (
            <>
              <span className="bug-report-footer-note">Submitted successfully</span>
              <button className="bug-report-btn bug-report-btn-primary" onClick={onClose}>
                Close
              </button>
            </>
          ) : (
            <>
              <span className="bug-report-footer-note">
                {submitting ? 'Submitting report…' : '* Required fields'}
              </span>
              <div className="bug-report-footer-actions">
                <button
                  className="bug-report-btn bug-report-btn-secondary"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  className="bug-report-btn bug-report-btn-primary"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                >
                  {submitting ? (
                    <>
                      <span className="bug-report-spinner" aria-hidden />
                      Submitting…
                    </>
                  ) : (
                    'Submit Report'
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
