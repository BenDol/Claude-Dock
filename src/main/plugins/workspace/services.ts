export interface WorkspaceServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void
  sendTaskToDock: (projectDir: string, channel: string, data: unknown) => boolean
}

let _services: WorkspaceServices | null = null

export function setServices(s: WorkspaceServices): void { _services = s }

export function getServices(): WorkspaceServices {
  if (!_services) throw new Error('WorkspaceServices not initialized')
  return _services
}
