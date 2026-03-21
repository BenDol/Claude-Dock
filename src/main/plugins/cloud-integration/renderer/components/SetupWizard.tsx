import React, { useState, useEffect, useCallback } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { CloudSetupStatus, CloudSetupStep, CloudProviderId } from '../../../../../shared/cloud-types'

interface Props {
  projectDir: string
  providerId: CloudProviderId
  onComplete: () => void
}

export default function SetupWizard({ projectDir, providerId, onComplete }: Props) {
  const [status, setStatus] = useState<CloudSetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const s = await getDockApi().cloudIntegration.getSetupStatus(projectDir, providerId)
      setStatus(s)
      if (s?.complete) {
        onComplete()
      }
    } catch (err: any) {
      setError(err.message || 'Failed to check setup status')
    }
    setLoading(false)
  }, [projectDir, providerId, onComplete])

  useEffect(() => {
    setLoading(true)
    setError(null)
    loadStatus()
  }, [loadStatus])

  const verify = useCallback(async () => {
    setVerifying(true)
    setError(null)
    try {
      const s = await getDockApi().cloudIntegration.getSetupStatus(projectDir, providerId)
      setStatus(s)
      if (s?.complete) {
        onComplete()
      } else if (s && s.currentStep === status?.currentStep) {
        setError('This step does not appear to be complete yet. Please follow the instructions above and try again.')
      }
    } catch (err: any) {
      setError(err.message || 'Verification failed')
    }
    setVerifying(false)
  }, [projectDir, providerId, onComplete, status?.currentStep])

  const copyCommand = useCallback((stepId: string, command: string) => {
    navigator.clipboard.writeText(command)
    setCopiedId(stepId)
    setTimeout(() => setCopiedId(null), 2000)
  }, [])

  const openUrl = useCallback((url: string) => {
    getDockApi().app.openExternal(url)
  }, [])

  if (loading) {
    return <div className="cloud-page"><div className="cloud-loading-indicator">Checking setup status...</div></div>
  }

  if (!status) {
    return (
      <div className="cloud-page">
        <div className="cloud-error">
          <h3>Setup Unavailable</h3>
          <p>Could not load setup information for this provider.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cloud-page">
      <div className="cloud-page-header">
        <h2>
          <span className="cloud-setup-provider-icon" dangerouslySetInnerHTML={{ __html: status.icon }} />
          {status.providerName} Setup
        </h2>
      </div>

      <p className="cloud-setup-intro">
        Complete these steps to connect to {status.providerName}. Each step is verified automatically.
      </p>

      <div className="cloud-setup-steps">
        {status.steps.map((step, idx) => (
          <SetupStepCard
            key={step.id}
            step={step}
            index={idx}
            currentStep={status.currentStep}
            isLast={idx === status.steps.length - 1}
            copiedId={copiedId}
            onCopy={copyCommand}
            onOpenUrl={openUrl}
          />
        ))}
      </div>

      {error && (
        <div className="cloud-setup-error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {error}
        </div>
      )}

      <div className="cloud-setup-actions">
        <button
          className="cloud-btn cloud-btn-primary"
          onClick={verify}
          disabled={verifying || status.complete}
        >
          {verifying ? 'Verifying...' : status.complete ? 'Setup Complete' : 'Verify & Continue'}
        </button>
        {status.complete && (
          <button className="cloud-btn cloud-btn-secondary" onClick={onComplete}>
            Go to Dashboard
          </button>
        )}
      </div>
    </div>
  )
}

function SetupStepCard({ step, index, currentStep, isLast, copiedId, onCopy, onOpenUrl }: {
  step: CloudSetupStep
  index: number
  currentStep: number
  isLast: boolean
  copiedId: string | null
  onCopy: (id: string, cmd: string) => void
  onOpenUrl: (url: string) => void
}) {
  const isDone = index < currentStep
  const isCurrent = index === currentStep
  const isPending = index > currentStep

  return (
    <div className={`cloud-setup-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''} ${isPending ? 'pending' : ''}`}>
      {/* Connector line */}
      {!isLast && <div className={`cloud-setup-connector ${isDone ? 'done' : ''}`} />}

      {/* Step number / check */}
      <div className="cloud-setup-step-indicator">
        {isDone ? (
          <div className="cloud-setup-check">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        ) : (
          <div className={`cloud-setup-number ${isCurrent ? 'active' : ''}`}>
            {index + 1}
          </div>
        )}
      </div>

      {/* Step content */}
      <div className="cloud-setup-step-body">
        <div className="cloud-setup-step-title">{step.title}</div>
        <div className="cloud-setup-step-desc">{step.description}</div>

        {isCurrent && step.command && (
          <div className="cloud-setup-command">
            <code>{step.command}</code>
            {!step.command.startsWith('http') && (
              <button
                className="cloud-setup-copy-btn"
                onClick={() => onCopy(step.id, step.command!)}
                title="Copy to clipboard"
              >
                {copiedId === step.id ? 'Copied!' : 'Copy'}
              </button>
            )}
          </div>
        )}

        {isCurrent && step.helpUrl && (
          <button className="cloud-setup-help-link" onClick={() => onOpenUrl(step.helpUrl!)}>
            {step.helpLabel || 'Documentation'}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
