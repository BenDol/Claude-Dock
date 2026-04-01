export interface WorkspaceViewerServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void
  sendTaskToDock: (projectDir: string, channel: string, data: unknown) => boolean
}

let _services: WorkspaceViewerServices | null = null

export function setServices(s: WorkspaceViewerServices): void { _services = s }

export function getServices(): WorkspaceViewerServices {
  if (!_services) throw new Error('WorkspaceViewerServices not initialized')
  return _services
}
