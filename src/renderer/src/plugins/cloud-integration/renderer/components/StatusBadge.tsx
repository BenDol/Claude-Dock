import React from 'react'

interface Props {
  status: string
}

const STATUS_CLASSES: Record<string, string> = {
  RUNNING: 'success',
  Active: 'success',
  Completed: 'success',
  Ready: 'success',
  Running: 'success',
  Succeeded: 'success',

  PROVISIONING: 'info',
  Progressing: 'info',
  Pending: 'info',

  DEGRADED: 'warning',
  Degraded: 'warning',
  Suspended: 'warning',
  NotReady: 'warning',

  ERROR: 'error',
  Failed: 'error',
  CrashLoopBackOff: 'error',
  STOPPING: 'error',
  Terminating: 'error'
}

export default function StatusBadge({ status }: Props) {
  const cls = STATUS_CLASSES[status] || 'neutral'
  return (
    <span className={`cloud-status-badge cloud-status-${cls}`}>
      {status}
    </span>
  )
}
