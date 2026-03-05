import Store from 'electron-store'

interface SessionData {
  [normalizedPath: string]: {
    terminals: string[]
  }
}

let store: Store<SessionData> | null = null

function getStore(): Store<SessionData> {
  if (!store) {
    store = new Store<SessionData>({
      name: 'sessions'
    })
  }
  return store
}

function normalizePath(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase()
}

export function getSessions(projectDir: string): string[] {
  const key = normalizePath(projectDir)
  const entry = getStore().get(key)
  return entry?.terminals ?? []
}

export function saveSessions(projectDir: string, resumeIds: string[]): void {
  const key = normalizePath(projectDir)
  getStore().set(key, { terminals: resumeIds })
}

export function clearSessions(projectDir: string): void {
  const key = normalizePath(projectDir)
  getStore().delete(key as any)
}
