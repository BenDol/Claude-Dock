/**
 * Editor store — manages open file tabs for the in-dock Monaco editor overlay.
 * Transient state (not persisted across sessions).
 */
import { create } from 'zustand'

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif', 'tif', 'tiff',
  'pdf', 'zip', 'tar', 'gz', '7z', 'rar', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg',
  'webm', 'mov', 'avi', 'class', 'pyc', 'o', 'obj', 'lock'
])

const MONACO_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  mjs: 'javascript', cjs: 'javascript', json: 'json',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  svelte: 'html', vue: 'html', astro: 'html',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', scala: 'scala', groovy: 'groovy',
  cs: 'csharp', fs: 'fsharp', vb: 'vb',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  swift: 'swift', m: 'objective-c',
  php: 'php', lua: 'lua', dart: 'dart', r: 'r',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'bat',
  sql: 'sql', graphql: 'graphql',
  md: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile',
  tf: 'hcl', proto: 'protobuf',
}

export function getMonacoLanguage(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return MONACO_LANG_MAP[ext] || 'plaintext'
}

export function isBinaryFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return BINARY_EXTENSIONS.has(ext)
}

export interface EditorTab {
  id: string
  projectDir: string
  relativePath: string
  fileName: string
  content: string
  savedContent: string
  language: string
  pendingReveal?: { line: number; column: number } | null
}

/** Navigation history entry — records a cursor position in a specific tab */
export interface NavHistoryEntry {
  tabId: string
  line: number
  column: number
}

const MAX_NAV_HISTORY = 100

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string | null

  // Navigation history (back/forward)
  navBack: NavHistoryEntry[]
  navForward: NavHistoryEntry[]
  /** Push current position to back stack. Call before navigating away. */
  pushNavPosition: (tabId: string, line: number, column: number) => void
  /** Navigate back (mouse button 4 / Alt+Left). Pass current cursor position for forward stack. */
  navigateBack: (currentLine?: number, currentColumn?: number) => NavHistoryEntry | null
  /** Navigate forward (mouse button 5 / Alt+Right). Pass current cursor position for back stack. */
  navigateForward: (currentLine?: number, currentColumn?: number) => NavHistoryEntry | null

  openFile: (projectDir: string, relativePath: string, content: string) => void
  openFileAtPosition: (projectDir: string, relativePath: string, content: string, line: number, column: number) => void
  clearPendingReveal: (id: string) => void
  closeTab: (id: string) => void
  closeAllTabs: () => void
  setActiveTab: (id: string) => void
  updateContent: (id: string, content: string) => void
  markSaved: (id: string, content: string) => void
  moveTab: (fromIndex: number, toIndex: number) => void
  removeTab: (id: string) => EditorTab | null
}

function makeId(projectDir: string, relativePath: string): string {
  return `${projectDir}::${relativePath}`
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  navBack: [],
  navForward: [],

  pushNavPosition: (tabId, line, column) => {
    const { navBack } = get()
    // Don't push duplicate consecutive entries (same tab + same line)
    const last = navBack[navBack.length - 1]
    if (last && last.tabId === tabId && last.line === line) return
    const newBack = [...navBack, { tabId, line, column }]
    if (newBack.length > MAX_NAV_HISTORY) newBack.shift()
    set({ navBack: newBack, navForward: [] }) // clear forward on new navigation
  },

  navigateBack: (currentLine?: number, currentColumn?: number) => {
    const { navBack, navForward, activeTabId } = get()
    if (navBack.length === 0) return null
    const newBack = [...navBack]
    const entry = newBack.pop()!
    const newForward = [...navForward]
    if (activeTabId) {
      newForward.push({ tabId: activeTabId, line: currentLine ?? 1, column: currentColumn ?? 1 })
    }
    if (newForward.length > MAX_NAV_HISTORY) newForward.shift()
    set({ navBack: newBack, navForward: newForward, activeTabId: entry.tabId })
    return entry
  },

  navigateForward: (currentLine?: number, currentColumn?: number) => {
    const { navBack, navForward, activeTabId } = get()
    if (navForward.length === 0) return null
    const newForward = [...navForward]
    const entry = newForward.pop()!
    const newBack = [...navBack]
    if (activeTabId) {
      newBack.push({ tabId: activeTabId, line: currentLine ?? 1, column: currentColumn ?? 1 })
    }
    if (newBack.length > MAX_NAV_HISTORY) newBack.shift()
    set({ navBack: newBack, navForward: newForward, activeTabId: entry.tabId })
    return entry
  },


  openFile: (projectDir, relativePath, content) => {
    const id = makeId(projectDir, relativePath)
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const fileName = relativePath.split('/').pop() || relativePath
    const tab: EditorTab = {
      id,
      projectDir,
      relativePath,
      fileName,
      content,
      savedContent: content,
      language: getMonacoLanguage(fileName)
    }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  openFileAtPosition: (projectDir, relativePath, content, line, column) => {
    const id = makeId(projectDir, relativePath)
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (existing) {
      // Tab exists — just set pending reveal and activate
      set({
        tabs: tabs.map((t) => t.id === id ? { ...t, pendingReveal: { line, column } } : t),
        activeTabId: id
      })
      return
    }
    const fileName = relativePath.split('/').pop() || relativePath
    const tab: EditorTab = {
      id, projectDir, relativePath, fileName, content,
      savedContent: content,
      language: getMonacoLanguage(fileName),
      pendingReveal: { line, column }
    }
    set({ tabs: [...tabs, tab], activeTabId: id })
  },

  clearPendingReveal: (id) => {
    set({
      tabs: get().tabs.map((t) => t.id === id ? { ...t, pendingReveal: null } : t)
    })
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const newTabs = tabs.filter((t) => t.id !== id)
    let newActive = activeTabId
    if (activeTabId === id) {
      // Activate adjacent tab
      newActive = newTabs.length > 0
        ? (newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null)
        : null
    }
    set({ tabs: newTabs, activeTabId: newActive })
  },

  closeAllTabs: () => set({ tabs: [], activeTabId: null }),

  setActiveTab: (id) => set({ activeTabId: id }),

  updateContent: (id, content) => {
    set({
      tabs: get().tabs.map((t) => t.id === id ? { ...t, content } : t)
    })
  },

  markSaved: (id, content) => {
    set({
      tabs: get().tabs.map((t) => t.id === id ? { ...t, content, savedContent: content } : t)
    })
  },

  moveTab: (fromIndex, toIndex) => {
    const { tabs } = get()
    if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) return
    if (fromIndex === toIndex) return
    const newTabs = [...tabs]
    const [moved] = newTabs.splice(fromIndex, 1)
    newTabs.splice(toIndex, 0, moved)
    set({ tabs: newTabs })
  },

  removeTab: (id) => {
    const { tabs, activeTabId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return null
    const tab = tabs[idx]
    const newTabs = tabs.filter((t) => t.id !== id)
    let newActive = activeTabId
    if (activeTabId === id) {
      newActive = newTabs.length > 0
        ? (newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null)
        : null
    }
    set({ tabs: newTabs, activeTabId: newActive })
    return tab
  }
}))
