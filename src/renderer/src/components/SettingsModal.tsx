import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../stores/settings-store'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'
import type { Settings } from '../../../shared/settings-schema'
import { DEFAULT_SETTINGS, BUILTIN_NOTIFICATION_SOURCES } from '../../../shared/settings-schema'
import { ENV_PROFILE } from '../../../shared/env-profile'
import PluginPanel from './PluginPanel'

function formatKeybind(e: KeyboardEvent): string | null {
  // Ignore standalone modifier presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}

const KeybindInput: React.FC<{
  label: string
  value: string
  defaultValue: string
  onChange: (value: string) => void
}> = ({ label, value, defaultValue, onChange }) => {
  const [listening, setListening] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isDisabled = value.startsWith('!')
  const displayValue = isDisabled ? value.slice(1) : value

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!listening) return
      e.preventDefault()
      e.stopPropagation()
      const formatted = formatKeybind(e.nativeEvent)
      if (formatted) {
        onChange(formatted)
        setListening(false)
        inputRef.current?.blur()
      }
    },
    [listening, onChange]
  )

  const toggleEnabled = () => {
    if (isDisabled) {
      onChange(displayValue)
    } else {
      onChange('!' + displayValue)
    }
  }

  const isDefault = value === defaultValue

  return (
    <div className="settings-field">
      <div className="settings-field-row">
        <span className="settings-field-label">
          <label className="dock-toggle" title={isDisabled ? 'Enable this keybind' : 'Disable this keybind'}>
            <input type="checkbox" checked={!isDisabled} onChange={toggleEnabled} />
            <span className="dock-toggle-track" />
          </label>
          {label}
        </span>
        <span className="settings-field-control">
          <div className="keybind-row">
            <input
              ref={inputRef}
              type="text"
              readOnly
              value={listening ? 'Press a key combo…' : displayValue || 'None'}
              className={`keybind-input${listening ? ' listening' : ''}${isDisabled ? ' disabled-bind' : ''}`}
              onClick={() => { if (!isDisabled) setListening(true) }}
              onKeyDown={handleKeyDown}
              onBlur={() => setListening(false)}
              disabled={isDisabled}
            />
            <button
              className="keybind-restore"
              title="Restore default"
              disabled={isDefault}
              onClick={(e) => { e.preventDefault(); onChange(defaultValue) }}
              aria-label="Restore default keybind"
            >
              ↺
            </button>
          </div>
        </span>
      </div>
    </div>
  )
}

/** Reusable modern toggle pill (checkbox replacement). */
const DockToggle: React.FC<{
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: React.ReactNode
  ariaLabel?: string
}> = ({ checked, onChange, disabled, label, ariaLabel }) => (
  <label className={`dock-toggle${disabled ? ' disabled' : ''}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={ariaLabel}
    />
    <span className="dock-toggle-track" />
    {label !== undefined && <span className="dock-toggle-label">{label}</span>}
  </label>
)

/** Segmented control for small enum choices. */
function SegmentedControl<T extends string>({
  value, options, onChange, ariaLabel,
}: {
  value: T
  options: Array<{ value: T; label: string; title?: string }>
  onChange: (v: T) => void
  ariaLabel?: string
}): React.ReactElement {
  return (
    <div className="settings-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={`settings-seg-btn${value === o.value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Card container for a group of related settings. */
const SettingsCard: React.FC<{
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
  children: React.ReactNode
}> = ({ title, description, icon, children }) => (
  <div className="settings-card" data-settings-card={title}>
    <div className="settings-card-header">
      {icon && <span className="settings-card-header-icon">{icon}</span>}
      <div className="settings-card-header-text">
        <h4>{title}</h4>
        {description && <div className="settings-card-header-desc">{description}</div>}
      </div>
    </div>
    <div className="settings-card-body">{children}</div>
  </div>
)

/** A single field with label / control / optional description. Label + control on one row. */
const SettingsField: React.FC<{
  label: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="settings-field">
    <div className="settings-field-row">
      <span className="settings-field-label">{label}</span>
      <span className="settings-field-control">{children}</span>
    </div>
    {description && <div className="settings-field-desc">{description}</div>}
  </div>
)

/** Field variant where the control spans full width under the label (e.g. chip lists). */
const SettingsFieldStacked: React.FC<{
  label: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="settings-field">
    <span className="settings-field-label">{label}</span>
    {description && <div className="settings-field-desc">{description}</div>}
    <div style={{ marginTop: 6 }}>{children}</div>
  </div>
)

/** Accent color swatch selector. */
const ACCENT_PRESETS = [
  '#da7756', // Claude orange (default)
  '#3b82f6', // Blue
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#14b8a6', // Teal
]

const AccentPicker: React.FC<{
  value: string
  onChange: (color: string) => void
}> = ({ value, onChange }) => {
  const isCustom = !ACCENT_PRESETS.some((c) => c.toLowerCase() === value.toLowerCase())
  return (
    <div className="settings-accent-row">
      {ACCENT_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          className={`settings-accent-swatch${value.toLowerCase() === c.toLowerCase() ? ' active' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={`Accent ${c}`}
          title={c}
        />
      ))}
      <label className="settings-accent-custom">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 28, height: 28, border: 'none', borderRadius: '50%', padding: 0, background: 'none', cursor: 'pointer' }}
          aria-label="Custom accent color"
        />
        {isCustom ? 'Custom' : 'Pick custom'}
      </label>
    </div>
  )
}

/** Card-style collapsible section with a full-width click target. */
const SettingsAccordion: React.FC<{
  title: string
  defaultOpen?: boolean
  noDivider?: boolean
  children: React.ReactNode
}> = ({ title, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`settings-accordion${open ? ' open' : ''}`}>
      <button
        className="settings-accordion-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="settings-accordion-title">{title}</span>
        <svg
          className="settings-accordion-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3,4.5 6,7.5 9,4.5" />
        </svg>
      </button>
      {open && <div className="settings-accordion-body">{children}</div>}
    </div>
  )
}

/**
 * Scope indicator for individual settings.
 * Shows a small dot indicating if the setting is overridden at project/local level.
 * Clicking opens a popover to change scope or reset to global.
 *
 * Usage: <SettingScope keyPath="terminal.fontSize" value={settings.terminal.fontSize} section="terminal" sectionKey="fontSize" />
 */
type ScopeKind = 'global' | 'project' | 'local'

const SCOPE_META: Record<ScopeKind, { label: string; file: string; description: string }> = {
  global: { label: 'Global', file: 'user settings', description: 'Applies everywhere unless overridden.' },
  project: { label: 'Project', file: 'dock.json', description: 'Shared across the team — committed to the repo.' },
  local: { label: 'Local', file: 'dock.local.json', description: 'Only for this machine — not committed.' },
}

const SettingScope: React.FC<{
  keyPath: string
  value: unknown
  section: string
  sectionKey: string
}> = ({ keyPath, value, section, sectionKey }) => {
  const origins = useSettingsStore((s) => s.origins)
  const update = useSettingsStore((s) => s.update)
  const updateProject = useSettingsStore((s) => s.updateProject)
  const resetProjectKey = useSettingsStore((s) => s.resetProjectKey)
  const [open, setOpen] = useState(false)

  const origin = (origins[keyPath] as ScopeKind | undefined) ?? 'global'
  const meta = SCOPE_META[origin]

  const pillRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)

  const selectScope = async (target: ScopeKind) => {
    setOpen(false)
    // Always write the current value to the chosen tier (even if origin matches target —
    // the user may have edited the value since and expects the selection to persist it there).
    // Also clear conflicting overrides in other tiers so the value only lives in one place.
    if (target === 'global') {
      // Save at the global tier — applies to every project on this env profile.
      await update({ [section]: { [sectionKey]: value } } as any)
      if (origin === 'project') await resetProjectKey(keyPath, 'project')
      if (origin === 'local') await resetProjectKey(keyPath, 'local')
      return
    }
    await updateProject({ [section]: { [sectionKey]: value } } as any, target)
    if (target === 'project' && origin === 'local') await resetProjectKey(keyPath, 'local')
    if (target === 'local' && origin === 'project') await resetProjectKey(keyPath, 'project')
  }

  // Position the portaled menu relative to the pill
  useEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = () => {
      const r = pillRef.current?.getBoundingClientRect()
      if (!r) return
      setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t) || pillRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

  const menu = open && menuPos ? createPortal(
    <div
      className="scope-pill-menu"
      ref={popoverRef}
      role="menu"
      style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
    >
      <div className="scope-pill-menu-head">Save this setting to…</div>
      {(['global', 'project', 'local'] as ScopeKind[]).map((kind) => {
        const m = SCOPE_META[kind]
        const active = origin === kind
        return (
          <button
            key={kind}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            className={`scope-pill-menu-item scope-${kind}${active ? ' active' : ''}`}
            onClick={() => selectScope(kind)}
          >
            <span className="scope-pill-menu-dot" aria-hidden="true" />
            <span className="scope-pill-menu-text">
              <span className="scope-pill-menu-label">{m.label}</span>
              <span className="scope-pill-menu-desc">{m.description}</span>
            </span>
            <span className="scope-pill-menu-right">
              {active ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="2.5,6 5,8.5 9.5,3.5" />
                </svg>
              ) : (
                <span className="scope-pill-menu-file">{m.file}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>,
    document.body
  ) : null

  return (
    <span className="scope-pill-wrap">
      <button
        ref={pillRef}
        type="button"
        className={`scope-pill scope-${origin}`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((o) => !o) }}
        title={`Saved as ${meta.label} — ${meta.description}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="scope-pill-dot" aria-hidden="true" />
        <span className="scope-pill-label">{meta.label}</span>
        <svg className="scope-pill-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="2,3 4,5 6,3" />
        </svg>
      </button>
      {menu}
    </span>
  )
}

/** Check if a path is absolute (Unix or Windows drive letter). */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]|^\//.test(p)
}

/** Resolve a relative path against a base directory. */
function resolveRelPath(base: string, relative: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const parts = [...norm(base).split('/'), ...norm(relative).split('/')]
  const resolved: string[] = []
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') { resolved.pop(); continue }
    resolved.push(seg)
  }
  return resolved.join('/')
}

/** Editor for terminal.additionalDirs with scope selector (global/project/local) */
const AdditionalDirsEditor: React.FC = () => {
  const dirs = useSettingsStore((s) => s.settings.terminal?.additionalDirs ?? [])
  const projectDir = useDockStore((s) => s.projectDir)
  const [newDir, setNewDir] = useState('')
  const [scope, setScope] = useState<'global' | 'project' | 'local'>('project')

  const addDir = async () => {
    const dir = newDir.trim()
    if (!dir || dirs.includes(dir)) return
    const updated = [...dirs, dir]
    if (scope === 'global') {
      await getDockApi().settings.set({ terminal: { ...useSettingsStore.getState().settings.terminal, additionalDirs: updated } } as any)
    } else {
      await getDockApi().settings.setProject({ terminal: { additionalDirs: [dir] } }, scope)
    }
    setNewDir('')
  }

  const removeDir = async (dir: string) => {
    // Remove from global
    const globalDirs = useSettingsStore.getState().settings.terminal?.additionalDirs ?? []
    const filtered = globalDirs.filter((d: string) => d !== dir)
    await getDockApi().settings.set({ terminal: { ...useSettingsStore.getState().settings.terminal, additionalDirs: filtered } } as any)
    // Also try removing from project tiers
    try { await getDockApi().settings.resetProjectKey('terminal.additionalDirs', 'project') } catch {}
    try { await getDockApi().settings.resetProjectKey('terminal.additionalDirs', 'local') } catch {}
  }

  const browse = async () => {
    const dir = await getDockApi().app.pickDirectory()
    if (dir) setNewDir(dir)
  }

  return (
    <div className="settings-add-dirs">
      {dirs.length > 0 && (
        <div className="settings-add-dirs-list">
          {dirs.map((dir) => {
            const isRelative = !isAbsolutePath(dir)
            const resolved = isRelative && projectDir ? resolveRelPath(projectDir, dir) : null
            return (
              <div key={dir} className="settings-add-dirs-item">
                <div className="settings-add-dirs-path-wrap">
                  <code className="settings-add-dirs-path">{dir}</code>
                  {resolved && <span className="settings-add-dirs-resolved" title={resolved}>&rarr; {resolved}</span>}
                </div>
                <button className="settings-add-dirs-remove" onClick={() => removeDir(dir)} title="Remove">&times;</button>
              </div>
            )
          })}
        </div>
      )}
      <div className="settings-add-dirs-row">
        <input
          type="text"
          className="settings-add-dirs-input"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addDir() }}
          placeholder="Absolute or relative path (e.g. tools, ../other-project)"
        />
        <button className="settings-add-dirs-browse" onClick={browse} title="Browse...">...</button>
        <select
          className="settings-add-dirs-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as any)}
          title="Save scope"
        >
          <option value="global">Global</option>
          <option value="project">Project</option>
          <option value="local">Local</option>
        </select>
        <button className="settings-add-dirs-add" onClick={addDir} disabled={!newDir.trim()}>Add</button>
      </div>
    </div>
  )
}

interface SettingsModalProps {
  onClose: () => void
  initialTab?: SettingsTab
  initialSection?: string
}

type SettingsTab = 'appearance' | 'terminal' | 'grid' | 'keybindings' | 'plugins' | 'behavior'

const TAB_META: Record<SettingsTab, { label: string; description: string; icon: React.ReactNode }> = {
  appearance: {
    label: 'Appearance',
    description: 'Theme, colors, and header sizing.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" opacity="0.15" />
        <circle cx="7.5" cy="10.5" r="1" fill="currentColor" />
        <circle cx="12" cy="7.5" r="1" fill="currentColor" />
        <circle cx="16.5" cy="10.5" r="1" fill="currentColor" />
        <circle cx="15" cy="15.5" r="1" fill="currentColor" />
      </svg>
    ),
  },
  terminal: {
    label: 'Terminal',
    description: 'Font, cursor, scrollback, and default permissions.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="15" rx="2" />
        <polyline points="7,10 10,12.5 7,15" />
        <line x1="12" y1="15.5" x2="16.5" y2="15.5" />
      </svg>
    ),
  },
  grid: {
    label: 'Grid',
    description: 'Layout mode, columns, and viewport behavior.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
      </svg>
    ),
  },
  keybindings: {
    label: 'Keybindings',
    description: 'Keyboard shortcuts for focus and editing.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
        <line x1="6" y1="10" x2="6.01" y2="10" />
        <line x1="10" y1="10" x2="10.01" y2="10" />
        <line x1="14" y1="10" x2="14.01" y2="10" />
        <line x1="18" y1="10" x2="18.01" y2="10" />
        <line x1="7" y1="14" x2="17" y2="14" />
      </svg>
    ),
  },
  plugins: {
    label: 'Plugins',
    description: 'Enable, update, and manage plugins for this project.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3v4M15 3v4M9 17v4M15 17v4" />
        <rect x="5.5" y="7" width="13" height="10" rx="2" />
      </svg>
    ),
  },
  behavior: {
    label: 'Behavior',
    description: 'Notifications, integrations, updates, and advanced options.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    ),
  },
}

const TAB_ORDER: SettingsTab[] = ['appearance', 'terminal', 'grid', 'keybindings', 'plugins', 'behavior']

type BehaviorSection =
  | 'general' | 'notifications' | 'shell' | 'integrations'
  | 'api' | 'privacy' | 'updates' | 'advanced'

const BEHAVIOR_SECTIONS: Array<{ id: BehaviorSection; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    ),
  },
  { id: 'notifications', label: 'Notifications',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 01-3.46 0" />
      </svg>
    ),
  },
  { id: 'shell', label: 'Shell',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4,17 10,11 4,5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  { id: 'integrations', label: 'Integrations',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  { id: 'api', label: 'Anthropic API',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
  { id: 'privacy', label: 'Privacy',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  { id: 'updates', label: 'Updates',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 11-3-6.7L21 8" /><polyline points="21,3 21,8 16,8" />
      </svg>
    ),
  },
  { id: 'advanced', label: 'Advanced',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
      </svg>
    ),
  },
]

/* ============================================================================
 * Settings search index
 * Each entry is a user-searchable setting. `card` is the visible card title used
 * to locate the element in the DOM after navigation (matched via data attribute).
 * Keywords boost recall for common synonyms.
 * ========================================================================== */

interface SettingsSearchEntry {
  id: string
  label: string
  tab: SettingsTab
  section?: BehaviorSection
  card?: string
  keywords?: string[]
}

const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // Appearance
  { id: 'app-mode', label: 'Theme mode', tab: 'appearance', card: 'Theme', keywords: ['dark', 'light', 'system'] },
  { id: 'app-accent', label: 'Accent color', tab: 'appearance', card: 'Theme', keywords: ['highlight', 'color'] },
  { id: 'app-term-style', label: 'Terminal style', tab: 'appearance', card: 'Theme', keywords: ['claude code', 'console'] },
  { id: 'app-header-size', label: 'Toolbar header size', tab: 'appearance', card: 'Sizing', keywords: ['density', 'small', 'medium', 'large'] },
  { id: 'app-term-header-size', label: 'Terminal header size', tab: 'appearance', card: 'Sizing', keywords: ['density'] },

  // Terminal
  { id: 'term-font-family', label: 'Font family', tab: 'terminal', card: 'Typography', keywords: ['cascadia', 'fira', 'monospace'] },
  { id: 'term-font-size', label: 'Font size', tab: 'terminal', card: 'Typography' },
  { id: 'term-line-height', label: 'Line height', tab: 'terminal', card: 'Typography', keywords: ['spacing'] },
  { id: 'term-cursor-style', label: 'Cursor style', tab: 'terminal', card: 'Cursor', keywords: ['block', 'underline', 'bar'] },
  { id: 'term-cursor-blink', label: 'Cursor blink', tab: 'terminal', card: 'Cursor' },
  { id: 'term-scrollback', label: 'Scrollback lines', tab: 'terminal', card: 'Scrolling', keywords: ['history', 'buffer'] },
  { id: 'term-scroll-btn', label: 'Scroll-to-bottom button', tab: 'terminal', card: 'Scrolling', keywords: ['floating'] },
  { id: 'term-pin-input', label: 'Pin input box', tab: 'terminal', card: 'Scrolling', keywords: ['sticky'] },
  { id: 'term-perm-mode', label: 'Default permission mode', tab: 'terminal', card: 'Default Permissions', keywords: ['auto accept', 'bypass'] },
  { id: 'term-allowed-tools', label: 'Allowed tools', tab: 'terminal', card: 'Default Permissions', keywords: ['bash', 'read', 'edit', 'write', 'glob', 'grep', 'preapprove'] },
  { id: 'term-add-dirs', label: 'Additional directories', tab: 'terminal', card: 'Additional Directories', keywords: ['--add-dir', 'claude cli', 'paths'] },

  // Grid
  { id: 'grid-viewport', label: 'Viewport orientation', tab: 'grid', card: 'Layout', keywords: ['landscape', 'portrait'] },
  { id: 'grid-max-cols', label: 'Max columns', tab: 'grid', card: 'Spacing' },
  { id: 'grid-gap', label: 'Gap size', tab: 'grid', card: 'Spacing', keywords: ['spacing', 'padding'] },

  // Keybindings
  { id: 'key-focus-up', label: 'Focus up shortcut', tab: 'keybindings', card: 'Focus navigation', keywords: ['keybind', 'hotkey', 'shortcut'] },
  { id: 'key-focus-down', label: 'Focus down shortcut', tab: 'keybindings', card: 'Focus navigation' },
  { id: 'key-focus-left', label: 'Focus left shortcut', tab: 'keybindings', card: 'Focus navigation' },
  { id: 'key-focus-right', label: 'Focus right shortcut', tab: 'keybindings', card: 'Focus navigation' },
  { id: 'key-undo', label: 'Undo input shortcut', tab: 'keybindings', card: 'Editing' },
  { id: 'key-redo', label: 'Redo input shortcut', tab: 'keybindings', card: 'Editing' },
  { id: 'key-select-all', label: 'Select all shortcut', tab: 'keybindings', card: 'Editing' },

  // Plugins
  { id: 'plugins-hub', label: 'Manage plugins', tab: 'plugins', keywords: ['install', 'enable', 'disable', 'plugin'] },
  { id: 'plugins-auto-update', label: 'Auto-update plugins', tab: 'plugins' },

  // Behavior — General
  { id: 'beh-confirm-close', label: 'Confirm close with running terminals', tab: 'behavior', section: 'general', card: 'General', keywords: ['exit', 'quit'] },
  { id: 'beh-autospawn', label: 'Auto-spawn first terminal', tab: 'behavior', section: 'general', card: 'General', keywords: ['startup'] },

  // Behavior — Notifications
  { id: 'beh-mark-read', label: 'Mark all notifications as read', tab: 'behavior', section: 'notifications', card: 'Notifications', keywords: ['badge'] },
  { id: 'beh-idle-notify', label: 'Notify when terminal goes idle', tab: 'behavior', section: 'notifications', card: 'Notifications', keywords: ['idle', 'alert'] },
  { id: 'beh-idle-min-lines', label: 'Idle minimum activity lines', tab: 'behavior', section: 'notifications', card: 'Notifications' },
  { id: 'beh-idle-delay', label: 'Idle delay', tab: 'behavior', section: 'notifications', card: 'Notifications' },
  { id: 'beh-block-sources', label: 'Block notifications from sources', tab: 'behavior', section: 'notifications', card: 'Notifications', keywords: ['mute'] },

  // Behavior — Shell
  { id: 'beh-ctxmenu', label: 'Context menu (Open with Claude Dock)', tab: 'behavior', section: 'shell', card: 'Shell Integration', keywords: ['right-click', 'explorer', 'finder'] },
  { id: 'beh-shell-enabled', label: 'Enable shell panel in terminals', tab: 'behavior', section: 'shell', card: 'Shell Panel' },
  { id: 'beh-shell-preferred', label: 'Preferred shell', tab: 'behavior', section: 'shell', card: 'Shell Panel', keywords: ['bash', 'pwsh', 'powershell', 'cmd'] },
  { id: 'beh-shell-height', label: 'Shell panel default height', tab: 'behavior', section: 'shell', card: 'Shell Panel' },
  { id: 'beh-shell-events', label: 'Show dock event cards in terminals', tab: 'behavior', section: 'shell', card: 'Shell Panel', keywords: ['exceptions', 'errors'] },

  // Behavior — Integrations
  { id: 'beh-mcp', label: 'Dock MCP server', tab: 'behavior', section: 'integrations', card: 'Dock MCP Server', keywords: ['linked'] },
  { id: 'beh-linked', label: 'Linked mode', tab: 'behavior', section: 'integrations', card: 'Dock MCP Server', keywords: ['coordinate'] },
  { id: 'beh-linked-msg', label: 'Inter-terminal messaging', tab: 'behavior', section: 'integrations', card: 'Dock MCP Server' },

  // Behavior — Anthropic API
  { id: 'beh-usage-meter', label: 'Show usage meter', tab: 'behavior', section: 'api', card: 'Anthropic API', keywords: ['cost', 'spend'] },
  { id: 'beh-spend-limit', label: 'Spend limit', tab: 'behavior', section: 'api', card: 'Anthropic API', keywords: ['budget', 'usd'] },
  { id: 'beh-api-key', label: 'Anthropic API key', tab: 'behavior', section: 'api', card: 'Anthropic API', keywords: ['secret', 'token'] },

  // Behavior — Privacy
  { id: 'beh-telemetry', label: 'Anonymous usage telemetry', tab: 'behavior', section: 'privacy', card: 'Privacy', keywords: ['analytics', 'tracking'] },

  // Behavior — Updates
  { id: 'beh-update-profile', label: 'Update profile (Stable / Bleeding Edge)', tab: 'behavior', section: 'updates', card: 'Updates', keywords: ['channel'] },
  { id: 'beh-auto-update', label: 'Automatically update app', tab: 'behavior', section: 'updates', card: 'Updates' },
  { id: 'beh-auto-update-plugins', label: 'Automatically update plugins', tab: 'behavior', section: 'updates', card: 'Updates' },
  { id: 'beh-check-updates', label: 'Check for updates', tab: 'behavior', section: 'updates', card: 'Updates' },

  // Behavior — Advanced
  { id: 'beh-env', label: 'Environment profile', tab: 'behavior', section: 'advanced', card: 'Advanced', keywords: ['dev', 'uat', 'prod'] },
  { id: 'beh-devtools', label: 'Open DevTools', tab: 'behavior', section: 'advanced', card: 'Advanced', keywords: ['debug', 'inspect'] },
  { id: 'beh-mem-limit', label: 'Memory limit', tab: 'behavior', section: 'advanced', card: 'Advanced', keywords: ['heap', 'v8'] },
  { id: 'beh-live-plugin', label: 'Live plugin reload', tab: 'behavior', section: 'advanced', card: 'Advanced', keywords: ['watch', 'hot reload'] },
  { id: 'beh-path', label: 'Check & fix PATH', tab: 'behavior', section: 'advanced', card: 'Advanced', keywords: ['claude cli', 'shell'] },
]

function searchSettings(query: string): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const scored: Array<{ entry: SettingsSearchEntry; score: number }> = []
  for (const entry of SETTINGS_SEARCH_INDEX) {
    const label = entry.label.toLowerCase()
    const card = (entry.card || '').toLowerCase()
    const kw = (entry.keywords || []).join(' ').toLowerCase()
    const haystack = `${label} ${card} ${kw}`
    // Require every term to match somewhere (AND semantics)
    if (!terms.every((t) => haystack.includes(t))) continue
    // Score: label startswith > label contains > card contains > keyword contains
    let score = 0
    for (const t of terms) {
      if (label.startsWith(t)) score += 10
      else if (label.includes(t)) score += 6
      else if (card.includes(t)) score += 3
      else if (kw.includes(t)) score += 2
    }
    // Shorter labels tend to be more relevant
    score -= Math.min(5, Math.floor(label.length / 8))
    scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 12).map((s) => s.entry)
}

const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  terminal: 'Terminal',
  grid: 'Grid',
  keybindings: 'Keybindings',
  plugins: 'Plugins',
  behavior: 'Behavior',
}
const BEHAVIOR_SECTION_LABELS: Record<BehaviorSection, string> = {
  general: 'General',
  notifications: 'Notifications',
  shell: 'Shell',
  integrations: 'Integrations',
  api: 'Anthropic API',
  privacy: 'Privacy',
  updates: 'Updates',
  advanced: 'Advanced',
}

function entryBreadcrumb(e: SettingsSearchEntry): string {
  const parts = [TAB_LABELS[e.tab]]
  if (e.tab === 'behavior' && e.section) parts.push(BEHAVIOR_SECTION_LABELS[e.section])
  if (e.card && e.card !== TAB_LABELS[e.tab] && e.card !== BEHAVIOR_SECTION_LABELS[e.section as BehaviorSection]) parts.push(e.card)
  return parts.join(' › ')
}

const SettingsSearch: React.FC<{ onNavigate: (e: SettingsSearchEntry) => void }> = ({ onNavigate }) => {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const results = useMemo(() => searchSettings(query), [query])

  useEffect(() => { setHighlighted(0) }, [query])

  // Ctrl+F / Cmd+F focuses the search while the modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Scroll the highlighted option into view within the listbox
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlighted}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  const commit = (entry: SettingsSearchEntry) => {
    onNavigate(entry)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (query) { setQuery(''); e.preventDefault() }
      else { setOpen(false); inputRef.current?.blur() }
      return
    }
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => (h + 1) % results.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => (h - 1 + results.length) % results.length) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(results[highlighted]) }
    else if (e.key === 'Home') { e.preventDefault(); setHighlighted(0) }
    else if (e.key === 'End') { e.preventDefault(); setHighlighted(results.length - 1) }
  }

  const showResults = open && query.trim().length > 0
  const listboxId = 'settings-search-listbox'

  return (
    <div className="settings-search" role="search">
      <span className="settings-search-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="4.5" />
          <line x1="10.5" y1="10.5" x2="14" y2="14" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="text"
        className="settings-search-input"
        placeholder="Search settings…"
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showResults}
        aria-controls={listboxId}
        aria-activedescendant={showResults && results[highlighted] ? `${listboxId}-${highlighted}` : undefined}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 140)}
        onKeyDown={handleKey}
      />
      {query && (
        <button
          type="button"
          className="settings-search-clear"
          onClick={(e) => { e.preventDefault(); setQuery(''); inputRef.current?.focus() }}
          aria-label="Clear search"
          tabIndex={-1}
        >
          ×
        </button>
      )}
      <span className="settings-search-kbd" aria-hidden="true">Ctrl F</span>
      {showResults && (
        <div className="settings-search-dropdown" role="presentation">
          {results.length === 0 ? (
            <div className="settings-search-empty">
              No settings match <strong>&ldquo;{query}&rdquo;</strong>.
            </div>
          ) : (
            <ul
              id={listboxId}
              ref={listRef}
              className="settings-search-results"
              role="listbox"
            >
              {results.map((r, i) => (
                <li
                  key={r.id}
                  id={`${listboxId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === highlighted}
                  className={`settings-search-item${i === highlighted ? ' highlighted' : ''}`}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => { e.preventDefault(); commit(r) }}
                >
                  <span className="settings-search-item-label">{r.label}</span>
                  <span className="settings-search-item-crumb">{entryBreadcrumb(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const SETTINGS_ZOOM_KEY_PREFIX = 'settings-zoom:'
const SETTINGS_ZOOM_LEGACY_KEY = 'settings-zoom'
const SETTINGS_ZOOM_MIN = 0.7
const SETTINGS_ZOOM_MAX = 1.8
const SETTINGS_ZOOM_STEP = 0.1

function zoomKey(projectDir: string | null): string {
  return SETTINGS_ZOOM_KEY_PREFIX + (projectDir || '__global__')
}

function loadSettingsZoom(projectDir: string | null): number {
  try {
    const key = zoomKey(projectDir)
    // Check per-project key first; fall back to legacy single-key value for one-time migration.
    const raw = localStorage.getItem(key) ?? localStorage.getItem(SETTINGS_ZOOM_LEGACY_KEY)
    if (!raw) return 1
    const z = parseFloat(raw)
    if (isNaN(z)) return 1
    return Math.min(SETTINGS_ZOOM_MAX, Math.max(SETTINGS_ZOOM_MIN, z))
  } catch {
    return 1
  }
}

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, initialTab, initialSection }) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab || 'appearance')
  const [behaviorSection, setBehaviorSection] = useState<BehaviorSection>(
    initialSection === 'mcp' ? 'integrations' : 'general'
  )
  const projectDirForZoom = useDockStore((s) => s.projectDir)
  const [zoom, setZoom] = useState<number>(() => loadSettingsZoom(projectDirForZoom))
  const modalRef = useRef<HTMLDivElement>(null)

  // Reload persisted zoom when the project changes (e.g. opening settings in a different workspace)
  useEffect(() => {
    setZoom(loadSettingsZoom(projectDirForZoom))
  }, [projectDirForZoom])

  // Zoom: Ctrl+wheel, Ctrl+/-, Ctrl+0 reset. Scoped to the settings modal only.
  // Any Ctrl+wheel while the modal is open is blocked from reaching the dock's default
  // webFrame zoom — so changing settings zoom never affects terminals behind the modal.
  useEffect(() => {
    const storeZoom = (z: number) => {
      try { localStorage.setItem(zoomKey(projectDirForZoom), String(z)) } catch { /* ignore */ }
    }
    const clamp = (z: number) =>
      Math.round(Math.min(SETTINGS_ZOOM_MAX, Math.max(SETTINGS_ZOOM_MIN, z)) * 100) / 100

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      // Always block default page zoom while the settings modal is open so the dock
      // behind never zooms, regardless of where the wheel fired.
      e.preventDefault()
      e.stopPropagation()
      // Only update the settings zoom when the wheel is over the modal itself.
      if (!modalRef.current?.contains(e.target as Node)) return
      setZoom((z) => {
        const next = clamp(z + (e.deltaY < 0 ? SETTINGS_ZOOM_STEP : -SETTINGS_ZOOM_STEP))
        storeZoom(next)
        return next
      })
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((z) => { const n = clamp(z + SETTINGS_ZOOM_STEP); storeZoom(n); return n })
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setZoom((z) => { const n = clamp(z - SETTINGS_ZOOM_STEP); storeZoom(n); return n })
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom(1); storeZoom(1)
      }
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true } as AddEventListenerOptions)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [projectDirForZoom])
  const projectDir = useDockStore((s) => s.projectDir)
  const settings = useSettingsStore((s) => s.settings)
  const [updateCheckStatus, setUpdateCheckStatus] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState(false)
  const [pendingUpdate, setPendingUpdate] = useState<{ version: string; downloadUrl: string; assetName: string; assetSize: number; releaseNotes: string } | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [mcpInstalled, setMcpInstalled] = useState<boolean | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpStatus, setMcpStatus] = useState('')
  const [pathCheckStatus, setPathCheckStatus] = useState('')
  const [pathChecking, setPathChecking] = useState(false)
  const [ctxMenuRegistered, setCtxMenuRegistered] = useState<boolean | null>(null)
  const [ctxMenuBusy, setCtxMenuBusy] = useState(false)
  const [ctxMenuStatus, setCtxMenuStatus] = useState('')
  const [anthropicHasKey, setAnthropicHasKey] = useState<boolean | null>(null)
  const [anthropicKeyBusy, setAnthropicKeyBusy] = useState(false)
  const [anthropicKeyInput, setAnthropicKeyInput] = useState('')
  const [anthropicStatus, setAnthropicStatus] = useState('')

  const [notifSources, setNotifSources] = useState(BUILTIN_NOTIFICATION_SOURCES)

  // Fetch plugins for notification source list when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior') {
      getDockApi().plugins.getList().then((plugins) => {
        const pluginSources = plugins.map((p) => ({ id: p.id, label: p.name }))
        // Merge builtin + plugin sources, dedup by id
        const seen = new Set(BUILTIN_NOTIFICATION_SOURCES.map((s) => s.id))
        const merged = [...BUILTIN_NOTIFICATION_SOURCES]
        for (const ps of pluginSources) {
          if (!seen.has(ps.id)) {
            merged.push(ps)
            seen.add(ps.id)
          }
        }
        setNotifSources(merged)
      })
    }
  }, [tab])

  // Check MCP install status when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior' && mcpInstalled === null) {
      getDockApi().linked.checkMcp().then((r) => setMcpInstalled(r.installed))
    }
  }, [tab, mcpInstalled])

  // Check context menu registration status when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior' && ctxMenuRegistered === null) {
      getDockApi().contextMenu.check().then((r) => setCtxMenuRegistered(r.registered))
    }
  }, [tab, ctxMenuRegistered])

  // Check Anthropic API key status when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior' && anthropicHasKey === null) {
      getDockApi().usage.hasKey().then((r) => setAnthropicHasKey(r.hasKey)).catch(() => {})
    }
  }, [tab, anthropicHasKey])

  const origins = useSettingsStore((s) => s.origins)
  const updateProject = useSettingsStore((s) => s.updateProject)

  /**
   * Determine the destination tier for a plain edit.
   * - If any of the keys being written is already project-scoped, keep the write at
   *   'project' so team-shared settings remain team-shared after edits.
   * - Otherwise default to 'local' — edits should NOT silently leak to every project.
   *   Use the scope pill to promote a setting to 'global' or 'project' explicitly.
   */
  const editTier = (section: string, partial: Record<string, unknown>): 'project' | 'local' => {
    for (const k of Object.keys(partial)) {
      if (origins[`${section}.${k}`] === 'project') return 'project'
    }
    return 'local'
  }

  /** Write an edit to the appropriate tier (project if already scoped there, else local). */
  const writeEdit = (section: string, partial: Record<string, unknown>) => {
    return updateProject({ [section]: partial } as any, editTier(section, partial))
  }

  const updateTheme = (partial: Partial<Settings['theme']>) => writeEdit('theme', partial as Record<string, unknown>)
  const updateTerminal = (partial: Partial<Settings['terminal']>) => writeEdit('terminal', partial as Record<string, unknown>)
  const updateGrid = (partial: Partial<Settings['grid']>) => writeEdit('grid', partial as Record<string, unknown>)
  const updateBehavior = (partial: Partial<Settings['behavior']>) => writeEdit('behavior', partial as Record<string, unknown>)
  const updateKeybindings = (partial: Partial<Settings['keybindings']>) => writeEdit('keybindings', partial as Record<string, unknown>)
  const updateLinked = (partial: Partial<Settings['linked']>) => writeEdit('linked', partial as Record<string, unknown>)
  const updateAnthropic = (partial: Partial<Settings['anthropic']>) => writeEdit('anthropic', partial as Record<string, unknown>)
  const updateUpdater = (partial: Partial<Settings['updater']>) => writeEdit('updater', partial as Record<string, unknown>)

  // Navigate from the search dropdown: switch tab (and Behavior sub-section), then locate
  // the target card by data-settings-card and briefly highlight it so the user sees where
  // they landed. Non-fatal if the card isn't found.
  const handleSearchNavigate = useCallback((entry: SettingsSearchEntry) => {
    setTab(entry.tab)
    if (entry.tab === 'behavior' && entry.section) setBehaviorSection(entry.section)
    // Two rAFs to ensure the new tab has mounted & laid out before we scroll/highlight.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!entry.card) return
        const root = document.querySelector('.settings-modal')
        const target = root?.querySelector<HTMLElement>(
          `[data-settings-card="${CSS.escape(entry.card)}"]`
        )
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        target.classList.remove('settings-card-flash')
        // Force reflow so re-adding the class restarts the animation
        void target.offsetWidth
        target.classList.add('settings-card-flash')
        window.setTimeout(() => target.classList.remove('settings-card-flash'), 1400)
      })
    })
  }, [])

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true)
    setUpdateCheckStatus('Checking...')
    try {
      const profile = settings.updater?.profile || 'latest'
      const info = await getDockApi().updater.check(profile)
      if (info.available) {
        setUpdateCheckStatus(`Update available: ${info.version}. Restart the launcher to update.`)
      } else {
        setUpdateCheckStatus('You are up to date.')
      }
    } catch {
      setUpdateCheckStatus('Failed to check for updates.')
    }
    setCheckingUpdate(false)
  }

  const handleProfileChange = async (newProfile: string) => {
    const currentProfile = settings.updater?.profile || 'latest'
    if (newProfile === currentProfile) return

    const confirmMessage = currentProfile === 'bleeding-edge' && newProfile === 'latest'
      ? 'Switch to Latest (Stable)?\n\nThis will reset any plugin customizations you picked up from Bleeding Edge and check for the newest stable release. You may be prompted to install an update.'
      : currentProfile === 'latest' && newProfile === 'bleeding-edge'
        ? 'Switch to Bleeding Edge?\n\nBleeding Edge builds are generated from every commit and may be unstable. You will be updated to the latest development build.'
        : `Switch update profile to "${newProfile}"?`

    if (!window.confirm(confirmMessage)) return

    setSwitchingProfile(true)
    setUpdateCheckStatus('Switching profile...')
    setPendingUpdate(null)
    try {
      const info = await getDockApi().updater.switchProfile(newProfile)
      // Local store mirror — the persisted value comes from setSettings in main.
      updateUpdater({ profile: newProfile })
      if (info.available) {
        setPendingUpdate({
          version: info.version,
          downloadUrl: info.downloadUrl,
          assetName: info.assetName,
          assetSize: info.assetSize,
          releaseNotes: info.releaseNotes
        })
        setUpdateCheckStatus(`Update available: ${info.version}. Install to apply the profile change.`)
      } else {
        setUpdateCheckStatus('Profile updated. You are up to date.')
      }
    } catch (err) {
      console.warn('[updater] switchProfile failed', err)
      const msg = err instanceof Error ? err.message : 'Failed to switch profile.'
      setUpdateCheckStatus(msg)
    }
    setSwitchingProfile(false)
  }

  const handleInstallPendingUpdate = async () => {
    if (!pendingUpdate) return
    setInstallingUpdate(true)
    setUpdateCheckStatus('Downloading...')
    try {
      const api = getDockApi()
      await api.updater.download(pendingUpdate.downloadUrl, pendingUpdate.assetName)
      setUpdateCheckStatus('Installing and restarting...')
      await api.updater.install()
    } catch (err) {
      console.warn('[updater] install failed', err)
      setUpdateCheckStatus('Failed to install update.')
      setInstallingUpdate(false)
    }
  }

  const handleCheckPath = async () => {
    setPathChecking(true)
    setPathCheckStatus('Checking...')
    try {
      const api = getDockApi()
      const status = await api.claude.checkPath()
      if (status.inPath) {
        setPathCheckStatus('Claude CLI is in your shell PATH.')
        // Reset the skip preference since it's now fine
        const s = await api.settings.get()
        if (s.launcher?.skipPathPrompt) {
          await api.settings.set({ launcher: { ...s.launcher, skipPathPrompt: false } })
        }
      } else if (status.claudeDir) {
        const result = await api.claude.fixPath(status.claudeDir)
        if (result.success) {
          setPathCheckStatus(`Added ${status.claudeDir} to PATH${result.file ? ` (${result.file})` : ''}. Restart your terminal for changes to take effect.`)
          const s = await api.settings.get()
          await api.settings.set({ launcher: { ...s.launcher, skipPathPrompt: false } })
        } else {
          setPathCheckStatus(`Failed to fix PATH: ${result.error}`)
        }
      } else {
        setPathCheckStatus('Claude CLI not found. Install it first.')
      }
    } catch {
      setPathCheckStatus('Failed to check PATH.')
    }
    setPathChecking(false)
  }

  const activeMeta = TAB_META[tab]

  return (
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        ref={modalRef}
        style={{ zoom, ['--settings-zoom' as string]: String(zoom) } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header settings-modal-header">
          <h2>Settings</h2>
          <SettingsSearch onNavigate={handleSearchNavigate} />
          <button className="modal-close" onClick={onClose} aria-label="Close settings">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
        <div className="settings-shell">
          <nav
            className="settings-sidebar"
            role="tablist"
            aria-orientation="vertical"
            onKeyDown={(e) => {
              const idx = TAB_ORDER.indexOf(tab)
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault()
                setTab(TAB_ORDER[(idx + 1) % TAB_ORDER.length])
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault()
                setTab(TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length])
              }
            }}
          >
            {TAB_ORDER.map((t) => {
              const meta = TAB_META[t]
              const active = tab === t
              return (
                <button
                  key={t}
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={`settings-nav-item${active ? ' active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  <span className="settings-nav-icon">{meta.icon}</span>
                  <span className="settings-nav-label">{meta.label}</span>
                </button>
              )
            })}
          </nav>
          <div className="settings-content-area">
            <div className="settings-content-header">
              <h3>{activeMeta.label}</h3>
              <p>{activeMeta.description}</p>
            </div>
            <div className="settings-content settings-content-scroll">
            {tab === 'appearance' && (
              <div className="settings-stack">
                <SettingsCard
                  title="Theme"
                  description="Color mode and accent for the entire dock."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 3v18M3 12h18" />
                    </svg>
                  }
                >
                  <SettingsFieldStacked
                    label={<>Mode<SettingScope keyPath="theme.mode" value={settings.theme.mode} section="theme" sectionKey="mode" /></>}
                  >
                    <div className="settings-theme-picker">
                      {(['dark', 'light', 'system'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`settings-theme-tile${settings.theme.mode === m ? ' active' : ''}`}
                          onClick={() => updateTheme({ mode: m })}
                          aria-pressed={settings.theme.mode === m}
                        >
                          <div className={`settings-theme-preview ${m}`} />
                          <div className="settings-theme-tile-name">
                            {m === 'dark' ? 'Dark' : m === 'light' ? 'Light' : 'System'}
                          </div>
                        </button>
                      ))}
                    </div>
                  </SettingsFieldStacked>
                  <SettingsFieldStacked
                    label={<>Accent color<SettingScope keyPath="theme.accentColor" value={settings.theme.accentColor} section="theme" sectionKey="accentColor" /></>}
                    description="Used for focus rings, active states, and highlights."
                  >
                    <AccentPicker
                      value={settings.theme.accentColor}
                      onChange={(c) => updateTheme({ accentColor: c })}
                    />
                  </SettingsFieldStacked>
                  <SettingsField label={<>Terminal style<SettingScope keyPath="theme.terminalStyle" value={settings.theme.terminalStyle} section="theme" sectionKey="terminalStyle" /></>}>
                    <select
                      value={settings.theme.terminalStyle}
                      onChange={(e) => updateTheme({ terminalStyle: e.target.value as Settings['theme']['terminalStyle'] })}
                    >
                      <option value="default">Default</option>
                      <option value="claude-code">Claude Code</option>
                      <option value="standard">Standard Console</option>
                    </select>
                  </SettingsField>
                </SettingsCard>

                <SettingsCard
                  title="Sizing"
                  description="Density of the toolbar and terminal headers."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 9h18M3 15h18M5 5v14M19 5v14" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Toolbar header<SettingScope keyPath="theme.headerBarSize" value={settings.theme.headerBarSize} section="theme" sectionKey="headerBarSize" /></>}>
                    <SegmentedControl
                      value={(settings.theme.headerBarSize || 'small') as 'small' | 'medium' | 'large'}
                      options={[
                        { value: 'small', label: 'Small' },
                        { value: 'medium', label: 'Medium' },
                        { value: 'large', label: 'Large' },
                      ]}
                      onChange={(v) => updateTheme({ headerBarSize: v })}
                      ariaLabel="Toolbar header size"
                    />
                  </SettingsField>
                  <SettingsField label={<>Terminal header<SettingScope keyPath="theme.terminalHeaderBarSize" value={settings.theme.terminalHeaderBarSize} section="theme" sectionKey="terminalHeaderBarSize" /></>}>
                    <SegmentedControl
                      value={(settings.theme.terminalHeaderBarSize || 'small') as 'small' | 'medium' | 'large'}
                      options={[
                        { value: 'small', label: 'Small' },
                        { value: 'medium', label: 'Medium' },
                        { value: 'large', label: 'Large' },
                      ]}
                      onChange={(v) => updateTheme({ terminalHeaderBarSize: v })}
                      ariaLabel="Terminal header size"
                    />
                  </SettingsField>
                </SettingsCard>
              </div>
            )}
            {tab === 'terminal' && (
              <div className="settings-stack">
                <SettingsCard
                  title="Typography"
                  description="Font family, size, and line height in the terminal."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4,7 4,4 20,4 20,7" />
                      <line x1="9" y1="20" x2="15" y2="20" />
                      <line x1="12" y1="4" x2="12" y2="20" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Font family<SettingScope keyPath="terminal.fontFamily" value={settings.terminal.fontFamily} section="terminal" sectionKey="fontFamily" /></>}>
                    <input
                      type="text"
                      value={settings.terminal.fontFamily}
                      onChange={(e) => updateTerminal({ fontFamily: e.target.value })}
                      style={{ minWidth: 240 }}
                    />
                  </SettingsField>
                  <SettingsField label={<>Font size<SettingScope keyPath="terminal.fontSize" value={settings.terminal.fontSize} section="terminal" sectionKey="fontSize" /></>}>
                    <input
                      className="settings-num"
                      type="number"
                      min={8}
                      max={32}
                      value={settings.terminal.fontSize}
                      onChange={(e) => updateTerminal({ fontSize: parseInt(e.target.value) || 14 })}
                    />
                  </SettingsField>
                  <SettingsField label={<>Line height<SettingScope keyPath="terminal.lineHeight" value={settings.terminal.lineHeight} section="terminal" sectionKey="lineHeight" /></>}>
                    <input
                      className="settings-num"
                      type="number"
                      min={1}
                      max={2}
                      step={0.1}
                      value={settings.terminal.lineHeight}
                      onChange={(e) => updateTerminal({ lineHeight: parseFloat(e.target.value) || 1.2 })}
                    />
                  </SettingsField>
                </SettingsCard>

                <SettingsCard
                  title="Cursor"
                  description="Appearance and blinking behavior of the terminal cursor."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="4" x2="12" y2="20" />
                      <polyline points="8,4 12,4 16,4" />
                      <polyline points="8,20 12,20 16,20" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Style<SettingScope keyPath="terminal.cursorStyle" value={settings.terminal.cursorStyle} section="terminal" sectionKey="cursorStyle" /></>}>
                    <SegmentedControl
                      value={settings.terminal.cursorStyle as 'block' | 'underline' | 'bar'}
                      options={[
                        { value: 'block', label: 'Block' },
                        { value: 'underline', label: 'Underline' },
                        { value: 'bar', label: 'Bar' },
                      ]}
                      onChange={(v) => updateTerminal({ cursorStyle: v })}
                      ariaLabel="Cursor style"
                    />
                  </SettingsField>
                  <SettingsField label={<>Blink<SettingScope keyPath="terminal.cursorBlink" value={settings.terminal.cursorBlink} section="terminal" sectionKey="cursorBlink" /></>}>
                    <DockToggle
                      checked={settings.terminal.cursorBlink}
                      onChange={(v) => updateTerminal({ cursorBlink: v })}
                      ariaLabel="Cursor blink"
                    />
                  </SettingsField>
                </SettingsCard>

                <SettingsCard
                  title="Scrolling"
                  description="Scrollback history and scroll-related affordances."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="8,7 12,3 16,7" />
                      <polyline points="8,17 12,21 16,17" />
                      <line x1="12" y1="3" x2="12" y2="21" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Scrollback lines<SettingScope keyPath="terminal.scrollback" value={settings.terminal.scrollback} section="terminal" sectionKey="scrollback" /></>} description="Number of previous lines kept in memory.">
                    <input
                      className="settings-num"
                      type="number"
                      min={100}
                      max={50000}
                      step={100}
                      value={settings.terminal.scrollback}
                      onChange={(e) => updateTerminal({ scrollback: parseInt(e.target.value) || 5000 })}
                    />
                  </SettingsField>
                  <SettingsField label={<>Scroll-to-bottom button<SettingScope keyPath="terminal.scrollToBottom" value={settings.terminal.scrollToBottom} section="terminal" sectionKey="scrollToBottom" /></>} description="Show a floating button when not at the latest line.">
                    <DockToggle
                      checked={settings.terminal.scrollToBottom}
                      onChange={(v) => updateTerminal({ scrollToBottom: v })}
                      ariaLabel="Scroll to bottom button"
                    />
                  </SettingsField>
                  <SettingsField label={<>Pin input box<SettingScope keyPath="terminal.pinInputBox" value={settings.terminal.pinInputBox} section="terminal" sectionKey="pinInputBox" /></>} description="Keep the input box visible while scrolled up through history.">
                    <DockToggle
                      checked={settings.terminal.pinInputBox ?? true}
                      onChange={(v) => updateTerminal({ pinInputBox: v })}
                      ariaLabel="Pin input box while scrolled"
                    />
                  </SettingsField>
                </SettingsCard>

                <SettingsCard
                  title="Default Permissions"
                  description="Pre-approve tools and permission mode for newly spawned terminals."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5" y="10" width="14" height="10" rx="2" />
                      <path d="M8 10V7a4 4 0 118 0v3" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Permission mode<SettingScope keyPath="terminal.defaultPermissionMode" value={settings.terminal.defaultPermissionMode} section="terminal" sectionKey="defaultPermissionMode" /></>}>
                    <select
                      value={settings.terminal.defaultPermissionMode ?? 'default'}
                      onChange={(e) => updateTerminal({ defaultPermissionMode: e.target.value as Settings['terminal']['defaultPermissionMode'] })}
                    >
                      <option value="default">Ask each time</option>
                      <option value="acceptEdits">Accept edits</option>
                      <option value="bypassPermissions">Bypass all permissions</option>
                    </select>
                  </SettingsField>
                  <SettingsFieldStacked
                    label="Allowed tools"
                    description="Pre-approve specific tools. Leave all unchecked to use Claude's defaults."
                  >
                    <div className="settings-chips">
                      {['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'].map((tool) => {
                        const allowed = settings.terminal.defaultAllowedTools ?? []
                        const isChecked = allowed.includes(tool)
                        return (
                          <label key={tool} className={`settings-chip${isChecked ? ' active' : ''}`}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...allowed, tool]
                                  : allowed.filter((t: string) => t !== tool)
                                updateTerminal({ defaultAllowedTools: next })
                              }}
                            />
                            <svg className="settings-chip-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="2.5,6 5,8.5 9.5,3.5" />
                            </svg>
                            {tool}
                          </label>
                        )
                      })}
                    </div>
                  </SettingsFieldStacked>
                </SettingsCard>

                <SettingsCard
                  title="Additional Directories"
                  description={
                    <>Directories passed as <code>--add-dir</code> to the Claude CLI for referencing shared code or docs outside the project. Concatenated across all tiers (global + project + local).</>
                  }
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                    </svg>
                  }
                >
                  <AdditionalDirsEditor />
                </SettingsCard>
              </div>
            )}
            {tab === 'grid' && (
              <div className="settings-stack">
                <SettingsCard
                  title="Layout"
                  description="How terminals are arranged when the dock opens."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
                      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
                      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
                      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Viewport orientation<SettingScope keyPath="grid.viewportMode" value={settings.grid.viewportMode} section="grid" sectionKey="viewportMode" /></>} description="Auto picks landscape (side-by-side) or portrait (stacked) based on the window shape.">
                    <SegmentedControl
                      value={(settings.grid.viewportMode ?? 'auto') as 'auto' | 'landscape' | 'portrait'}
                      options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'landscape', label: 'Landscape' },
                        { value: 'portrait', label: 'Portrait' },
                      ]}
                      onChange={(v) => updateGrid({ viewportMode: v })}
                      ariaLabel="Viewport mode"
                    />
                  </SettingsField>
                </SettingsCard>

                <SettingsCard
                  title="Spacing"
                  description="Column count and gap between terminals."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="7" height="16" rx="1.2" />
                      <rect x="14" y="4" width="7" height="16" rx="1.2" />
                    </svg>
                  }
                >
                  <SettingsField label={<>Max columns<SettingScope keyPath="grid.maxColumns" value={settings.grid.maxColumns} section="grid" sectionKey="maxColumns" /></>}>
                    <input
                      className="settings-num"
                      type="number"
                      min={1}
                      max={8}
                      value={settings.grid.maxColumns}
                      onChange={(e) => updateGrid({ maxColumns: parseInt(e.target.value) || 4 })}
                    />
                  </SettingsField>
                  <SettingsField label={<>Gap size<SettingScope keyPath="grid.gapSize" value={settings.grid.gapSize} section="grid" sectionKey="gapSize" /></>} description="Pixels between adjacent terminals.">
                    <input
                      className="settings-num"
                      type="number"
                      min={0}
                      max={32}
                      value={settings.grid.gapSize}
                      onChange={(e) => { const v = parseInt(e.target.value); updateGrid({ gapSize: isNaN(v) ? 0 : v }) }}
                    />
                  </SettingsField>
                </SettingsCard>
              </div>
            )}
            {tab === 'keybindings' && (
              <div className="settings-stack">
                <SettingsCard
                  title="Focus navigation"
                  description="Move focus between terminals in the grid."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <polyline points="12,3 12,7" />
                      <polyline points="12,17 12,21" />
                      <polyline points="3,12 7,12" />
                      <polyline points="17,12 21,12" />
                    </svg>
                  }
                >
                  <KeybindInput label="Focus up" value={settings.keybindings.focusUp} defaultValue={DEFAULT_SETTINGS.keybindings.focusUp} onChange={(v) => updateKeybindings({ focusUp: v })} />
                  <KeybindInput label="Focus down" value={settings.keybindings.focusDown} defaultValue={DEFAULT_SETTINGS.keybindings.focusDown} onChange={(v) => updateKeybindings({ focusDown: v })} />
                  <KeybindInput label="Focus left" value={settings.keybindings.focusLeft} defaultValue={DEFAULT_SETTINGS.keybindings.focusLeft} onChange={(v) => updateKeybindings({ focusLeft: v })} />
                  <KeybindInput label="Focus right" value={settings.keybindings.focusRight} defaultValue={DEFAULT_SETTINGS.keybindings.focusRight} onChange={(v) => updateKeybindings({ focusRight: v })} />
                </SettingsCard>

                <SettingsCard
                  title="Editing"
                  description="Text editing shortcuts inside the terminal input."
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
                    </svg>
                  }
                >
                  <KeybindInput label="Undo input" value={settings.keybindings.undo} defaultValue={DEFAULT_SETTINGS.keybindings.undo} onChange={(v) => updateKeybindings({ undo: v })} />
                  <KeybindInput label="Redo input" value={settings.keybindings.redo} defaultValue={DEFAULT_SETTINGS.keybindings.redo} onChange={(v) => updateKeybindings({ redo: v })} />
                  <KeybindInput label="Select all" value={settings.keybindings.selectAll} defaultValue={DEFAULT_SETTINGS.keybindings.selectAll} onChange={(v) => updateKeybindings({ selectAll: v })} />
                </SettingsCard>
              </div>
            )}
            {tab === 'plugins' && projectDir && (
              <div className="plugin-hub-wrap">
                <PluginPanel projectDir={projectDir} />
                <div className="plugin-hub-footer">
                  <label className="plugin-hub-inline-toggle">
                    <input
                      type="checkbox"
                      checked={settings.updater?.autoUpdatePlugins ?? false}
                      onChange={(e) => updateUpdater({ autoUpdatePlugins: e.target.checked })}
                    />
                    Automatically update plugins on launch
                  </label>
                  <button
                    className="plugin-hub-btn"
                    onClick={() => window.dispatchEvent(new CustomEvent('plugin-update-open'))}
                  >
                    Check for Updates
                  </button>
                </div>
              </div>
            )}
            {tab === 'behavior' && (
              <div className="behavior-shell">
                <nav className="settings-subnav">
                  {BEHAVIOR_SECTIONS.map((sec) => (
                    <button
                      key={sec.id}
                      type="button"
                      className={`settings-subnav-item${behaviorSection === sec.id ? ' active' : ''}`}
                      onClick={() => setBehaviorSection(sec.id)}
                    >
                      <span className="settings-subnav-icon">{sec.icon}</span>
                      <span className="settings-subnav-label">{sec.label}</span>
                    </button>
                  ))}
                </nav>
                <div className="behavior-content">
                  {behaviorSection === 'general' && (
                  <div className="settings-stack">
                    <SettingsCard title="General">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.confirmCloseWithRunning}
                    onChange={(e) => updateBehavior({ confirmCloseWithRunning: e.target.checked })}
                  />
                  Confirm close with running terminals
                </label>
                {settings.behavior.closeAction !== 'ask' && (
                  <div className="settings-inline-row">
                    <span className="settings-description" style={{ margin: 0 }}>
                      Close action remembered: <strong>{settings.behavior.closeAction === 'close' ? 'Close (keep sessions)' : 'Clear sessions & close'}</strong>
                    </span>
                    <button
                      className="settings-reset-btn"
                      onClick={() => updateBehavior({ closeAction: 'ask' })}
                    >
                      Reset
                    </button>
                  </div>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.autoSpawnFirstTerminal}
                    onChange={(e) => updateBehavior({ autoSpawnFirstTerminal: e.target.checked })}
                  />
                  Auto-spawn first terminal
                </label>
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'notifications' && (
                  <div className="settings-stack">
                    <SettingsCard title="Notifications">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.markNotificationsRead}
                    onChange={(e) => updateBehavior({ markNotificationsRead: e.target.checked })}
                  />
                  Mark all notifications as read
                </label>
                <div className="settings-description">
                  Incoming notifications will not trigger the unread badge.
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.idleNotification ?? false}
                    onChange={(e) => updateBehavior({ idleNotification: e.target.checked })}
                  />
                  Notify when terminal goes idle
                </label>
                <div className="settings-description">
                  Send an OS notification and flash the taskbar when a terminal stops producing output after significant activity, while the dock is not focused.
                </div>
                <label className={settings.behavior.idleNotification ? '' : 'disabled'}>
                  Minimum lines of activity
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={settings.behavior.idleNotificationMinLines ?? 10}
                    disabled={!settings.behavior.idleNotification}
                    onChange={(e) => updateBehavior({ idleNotificationMinLines: parseInt(e.target.value) || 10 })}
                  />
                </label>
                <label className={settings.behavior.idleNotification ? '' : 'disabled'}>
                  Idle delay (ms)
                  <input
                    type="number"
                    min={1000}
                    max={60000}
                    step={1000}
                    value={settings.behavior.idleNotificationDelayMs ?? 5000}
                    disabled={!settings.behavior.idleNotification}
                    onChange={(e) => updateBehavior({ idleNotificationDelayMs: parseInt(e.target.value) || 5000 })}
                  />
                </label>
                <div className="settings-subsection-header">Block Notifications From</div>
                <div className="settings-description">
                  Mute toast notifications from selected sources.
                </div>
                {notifSources.map((src) => {
                  const blocked = settings.behavior?.blockedNotificationSources ?? []
                  const isBlocked = blocked.includes(src.id)
                  return (
                    <label key={src.id} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={isBlocked}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...blocked, src.id]
                            : blocked.filter((s: string) => s !== src.id)
                          updateBehavior({ blockedNotificationSources: next })
                        }}
                      />
                      {src.label}
                    </label>
                  )
                })}
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'shell' && (
                  <div className="settings-stack">
                    <SettingsCard title="Shell Integration">
                <div className="settings-row">
                  <span className="settings-label">
                    Context Menu: {ctxMenuRegistered === null ? '...' : ctxMenuRegistered ? 'Registered' : 'Not Registered'}
                  </span>
                  <button
                    className="settings-check-update-btn"
                    disabled={ctxMenuBusy}
                    onClick={async () => {
                      setCtxMenuBusy(true)
                      setCtxMenuStatus('')
                      try {
                        const api = getDockApi()
                        if (ctxMenuRegistered) {
                          const r = await api.contextMenu.unregister()
                          if (r.success) {
                            setCtxMenuRegistered(false)
                            setCtxMenuStatus('Context menu removed.')
                          } else {
                            setCtxMenuStatus(r.error || 'Failed to remove.')
                          }
                        } else {
                          const r = await api.contextMenu.register()
                          if (r.success) {
                            setCtxMenuRegistered(true)
                            setCtxMenuStatus('Context menu registered.')
                          } else {
                            setCtxMenuStatus(r.error || 'Failed to register.')
                          }
                        }
                      } catch {
                        setCtxMenuStatus('Operation failed.')
                      }
                      setCtxMenuBusy(false)
                    }}
                  >
                    {ctxMenuBusy ? '...' : ctxMenuRegistered ? 'Remove' : 'Register'}
                  </button>
                </div>
                <div className="settings-description">
                  Adds &quot;Open with Claude Dock&quot; to your file manager&apos;s right-click context menu.
                </div>
                {ctxMenuStatus && <div className="settings-update-status">{ctxMenuStatus}</div>}
                </SettingsCard>
                <SettingsCard title="Shell Panel">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.shellPanel?.enabled ?? true}
                    onChange={(e) => writeEdit('shellPanel', { enabled: e.target.checked })}
                  />
                  Enable embedded shell panel in terminals
                </label>
                <div className="settings-description">
                  Adds a toggleable shell panel at the bottom of each Claude terminal. Opens with the button in the terminal header or bottom-left corner.
                </div>
                <label>
                  Preferred Shell
                  <select
                    value={settings.shellPanel?.preferredShell ?? 'default'}
                    onChange={(e) => writeEdit('shellPanel', { preferredShell: e.target.value })}
                  >
                    <option value="default">Default (system shell)</option>
                    <option value="bash">Bash</option>
                    <option value="cmd">Command Prompt (cmd)</option>
                    <option value="powershell">PowerShell</option>
                    <option value="pwsh">PowerShell Core (pwsh)</option>
                  </select>
                </label>
                <label>
                  Default Height (px)
                  <input
                    type="number"
                    min={80}
                    max={600}
                    step={10}
                    value={settings.shellPanel?.defaultHeight ?? 200}
                    onChange={(e) => writeEdit('shellPanel', { defaultHeight: parseInt(e.target.value) || 200 })}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.behavior?.shellEventsEnabled ?? true}
                    onChange={(e) => updateBehavior({ shellEventsEnabled: e.target.checked })}
                  />
                  Show dock event cards in terminals
                </label>
                <div className="settings-description">
                  Displays event cards (exceptions, compile errors, server status, etc.) detected from shell output above each terminal.
                </div>
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'integrations' && (
                  <div className="settings-stack">
                    <SettingsCard title="Dock MCP Server">
                <div className="settings-row">
                  <span className="settings-label">
                    Status: {mcpInstalled === null ? '...' : mcpInstalled ? 'Installed' : 'Not Installed'}
                  </span>
                  <div className="settings-btn-group">
                    <button
                      className="settings-check-update-btn"
                      disabled={mcpBusy}
                      onClick={async () => {
                        setMcpBusy(true)
                        setMcpStatus('')
                        try {
                          if (mcpInstalled) {
                            const r = await getDockApi().linked.uninstallMcp()
                            if (r.success) {
                              setMcpInstalled(false)
                              if (settings.linked?.enabled) {
                                updateLinked({ enabled: false })
                                await getDockApi().linked.setEnabled(false)
                              }
                              setMcpStatus('Uninstalled successfully.')
                            } else {
                              setMcpStatus(r.error || 'Uninstall failed.')
                            }
                          } else {
                            const r = await getDockApi().linked.installMcp()
                            if (r.success) {
                              setMcpInstalled(true)
                              setMcpStatus('Installed. Restart dock to activate.')
                            } else {
                              setMcpStatus(r.error || 'Install failed.')
                            }
                          }
                        } catch {
                          setMcpStatus('Operation failed.')
                        }
                        setMcpBusy(false)
                      }}
                    >
                      {mcpBusy ? '...' : mcpInstalled ? 'Uninstall' : 'Install'}
                    </button>
                    <button
                      className="settings-check-update-btn"
                      disabled={!mcpInstalled}
                      onClick={() => getDockApi().dock.restart()}
                      title="Restart dock to apply MCP changes"
                    >
                      Restart Dock
                    </button>
                  </div>
                </div>
                {mcpStatus && <div className="settings-update-status">{mcpStatus}</div>}
                <label className={`checkbox-label${mcpInstalled ? '' : ' disabled'}`}>
                  <input
                    type="checkbox"
                    checked={settings.linked?.enabled ?? false}
                    disabled={!mcpInstalled}
                    onChange={async (e) => {
                      const enabled = e.target.checked
                      updateLinked({ enabled })
                      await getDockApi().linked.setEnabled(enabled)
                    }}
                  />
                  Linked Mode
                  {!mcpInstalled && <span className="settings-hint"> (install MCP first)</span>}
                </label>
                <div className="settings-description">
                  When enabled, Claude sessions can see what other terminals are working on to coordinate tasks.
                </div>
                <label className={`checkbox-label${mcpInstalled && settings.linked?.enabled ? '' : ' disabled'}`} style={{ paddingLeft: 24 }}>
                  <input
                    type="checkbox"
                    checked={settings.linked?.messagingEnabled ?? false}
                    disabled={!mcpInstalled || !settings.linked?.enabled}
                    onChange={async (e) => {
                      const enabled = e.target.checked
                      updateLinked({ messagingEnabled: enabled })
                      await getDockApi().linked.setMessaging(enabled)
                    }}
                  />
                  Inter-terminal Messaging
                  {(!mcpInstalled || !settings.linked?.enabled) && <span className="settings-hint"> (enable Linked Mode first)</span>}
                </label>
                <div className="settings-description" style={{ paddingLeft: 24 }}>
                  Allow Claude sessions to send messages to each other for coordination.
                </div>
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'api' && (
                  <div className="settings-stack">
                    <SettingsCard title="Anthropic API">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.anthropic?.showUsageMeter ?? true}
                    onChange={(e) => updateAnthropic({ showUsageMeter: e.target.checked })}
                  />
                  Show usage meter
                </label>
                <div className="settings-description">
                  Display API spend as a percentage bar in the toolbar.
                </div>
                <label>
                  Spend limit (USD)
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={settings.anthropic?.spendLimitUsd ?? 100}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value)
                      if (!isNaN(val) && val > 0) updateAnthropic({ spendLimitUsd: val })
                    }}
                    style={{ width: 80, marginLeft: 8 }}
                  />
                </label>
                <div className="settings-description">
                  Your monthly budget — the meter shows spend as a percentage of this limit.
                </div>
                <div className="settings-row">
                  <span className="settings-label">
                    API Key: {anthropicHasKey === null ? '...' : anthropicHasKey ? 'Configured' : 'Not configured'}
                  </span>
                  <div className="settings-btn-group">
                    {anthropicHasKey ? (
                      <button
                        className="settings-check-update-btn"
                        disabled={anthropicKeyBusy}
                        onClick={async () => {
                          setAnthropicKeyBusy(true)
                          setAnthropicStatus('')
                          try {
                            const r = await getDockApi().usage.clearKey()
                            if (r.success) {
                              setAnthropicHasKey(false)
                              setAnthropicStatus('API key cleared.')
                            } else {
                              setAnthropicStatus('Failed to clear key.')
                            }
                          } catch {
                            setAnthropicStatus('Operation failed.')
                          }
                          setAnthropicKeyBusy(false)
                        }}
                      >
                        {anthropicKeyBusy ? '...' : 'Clear API Key'}
                      </button>
                    ) : (
                      <>
                        <input
                          type="password"
                          placeholder="Paste API key"
                          value={anthropicKeyInput}
                          onChange={(e) => setAnthropicKeyInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && anthropicKeyInput.trim()) {
                              e.preventDefault()
                              ;(async () => {
                                setAnthropicKeyBusy(true)
                                setAnthropicStatus('')
                                try {
                                  const r = await getDockApi().usage.setKey(anthropicKeyInput.trim())
                                  if (r.success) {
                                    setAnthropicHasKey(true)
                                    setAnthropicKeyInput('')
                                    setAnthropicStatus('API key saved.')
                                  } else {
                                    setAnthropicStatus('Failed to save key.')
                                  }
                                } catch {
                                  setAnthropicStatus('Operation failed.')
                                }
                                setAnthropicKeyBusy(false)
                              })()
                            }
                          }}
                          style={{ width: 140, fontSize: 11, padding: '2px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 3, color: 'var(--text-primary)' }}
                        />
                        <button
                          className="settings-check-update-btn"
                          disabled={anthropicKeyBusy || !anthropicKeyInput.trim()}
                          onClick={async () => {
                            setAnthropicKeyBusy(true)
                            setAnthropicStatus('')
                            try {
                              const r = await getDockApi().usage.setKey(anthropicKeyInput.trim())
                              if (r.success) {
                                setAnthropicHasKey(true)
                                setAnthropicKeyInput('')
                                setAnthropicStatus('API key saved.')
                              } else {
                                setAnthropicStatus('Failed to save key.')
                              }
                            } catch {
                              setAnthropicStatus('Operation failed.')
                            }
                            setAnthropicKeyBusy(false)
                          }}
                        >
                          {anthropicKeyBusy ? '...' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {anthropicStatus && <div className="settings-update-status">{anthropicStatus}</div>}
                <div className="settings-description">
                  <button
                    className="usage-setup-link"
                    onClick={() => getDockApi().app.openExternal('https://console.anthropic.com/settings/admin-keys')}
                    style={{ fontSize: 11 }}
                  >
                    Manage API keys on Anthropic Console
                  </button>
                </div>
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'privacy' && (
                  <div className="settings-stack">
                    <SettingsCard title="Privacy">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.telemetry?.enabled ?? false}
                    onChange={(e) => {
                      getDockApi().telemetry.setConsent(e.target.checked)
                      writeEdit('telemetry', { enabled: e.target.checked, consentGiven: true })
                    }}
                  />
                  Share anonymous usage telemetry
                </label>
                <div className="settings-description">
                  Sends anonymous session stats (duration, crash count, feature usage) to help improve Claude Dock. No personal data, terminal content, or file paths are ever collected.
                </div>
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'updates' && (
                  <div className="settings-stack">
                    <SettingsCard title="Updates">
                {ENV_PROFILE === 'uat' ? (
                  <div className="settings-description">
                    This build is on the <strong>Bleeding Edge</strong> channel — updates arrive on every commit to main. Install the Stable build to switch to versioned releases.
                  </div>
                ) : ENV_PROFILE === 'dev' ? (
                  <div className="settings-description">
                    Automatic updates are disabled in dev builds.
                  </div>
                ) : (
                  <>
                    <label>
                      Update Profile
                      <select
                        value={settings.updater?.profile || 'latest'}
                        onChange={(e) => { void handleProfileChange(e.target.value) }}
                        disabled={switchingProfile || installingUpdate}
                      >
                        <option value="latest">Latest (Stable)</option>
                        <option value="bleeding-edge">Bleeding Edge</option>
                      </select>
                    </label>
                    <div className="settings-description">
                      {settings.updater?.profile === 'bleeding-edge'
                        ? 'Receiving a new build on every commit to main. May be unstable.'
                        : 'Receiving versioned stable releases only. Recommended for most users.'}
                    </div>
                  </>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={__DEV__ ? false : (settings.updater?.autoUpdate ?? false)}
                    onChange={(e) => updateUpdater({ autoUpdate: e.target.checked })}
                    disabled={__DEV__}
                  />
                  Automatically update app
                </label>
                <div className="settings-description">
                  {__DEV__
                    ? 'Automatic updates are disabled in dev builds.'
                    : 'When enabled, app updates are downloaded and installed automatically on launch.'}
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.updater?.autoUpdatePlugins ?? false}
                    onChange={(e) => updateUpdater({ autoUpdatePlugins: e.target.checked })}
                  />
                  Automatically update plugins
                </label>
                <div className="settings-description">
                  When enabled, plugin updates are installed automatically on launch. A restart notification is shown when complete.
                </div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={handleCheckForUpdates}
                    disabled={checkingUpdate || switchingProfile || installingUpdate}
                  >
                    {checkingUpdate ? 'Checking...' : 'Check for Updates'}
                  </button>
                  {pendingUpdate && (
                    <button
                      className="settings-check-update-btn"
                      style={{ marginLeft: 8 }}
                      onClick={handleInstallPendingUpdate}
                      disabled={installingUpdate}
                    >
                      {installingUpdate ? 'Installing...' : `Install ${pendingUpdate.version}`}
                    </button>
                  )}
                  {updateCheckStatus && (
                    <div className="settings-update-status">{updateCheckStatus}</div>
                  )}
                </div>
                </SettingsCard>
                  </div>
                )}
                  {behaviorSection === 'advanced' && (
                  <div className="settings-stack">
                    <SettingsCard title="Advanced">
                <label>
                  Environment
                  <input
                    type="text"
                    value={settings.environment?.profile || ENV_PROFILE}
                    readOnly
                    style={{ fontFamily: 'monospace', opacity: 0.8, cursor: 'default' }}
                  />
                </label>
                <div className="settings-description">
                  Build profile baked into this installation. <code>uat</code> = bleeding-edge, <code>prod</code> = stable, <code>dev</code> = run-from-source. Install a different build to change.
                </div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={() => getDockApi().debug.openDevTools()}
                  >
                    Open DevTools
                  </button>
                </div>
                <label>
                  Memory Limit (MB)
                  <input
                    type="number"
                    min={256}
                    max={8192}
                    step={256}
                    value={settings.advanced.maxHeapSizeMb}
                    onChange={(e) => writeEdit('advanced', { maxHeapSizeMb: parseInt(e.target.value) || 2048 })}
                  />
                </label>
                <div className="settings-description">
                  V8 heap size for renderer processes. Increase if the git-manager crashes on large repos. Requires restart.
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.advanced.livePluginReload}
                    onChange={(e) => writeEdit('advanced', { livePluginReload: e.target.checked })}
                  />
                  Live Plugin Reload
                </label>
                <div className="settings-description">
                  Watch plugin files for changes and reload automatically. Requires restart.
                </div>
                <div className="settings-subsection-header">Claude CLI</div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={handleCheckPath}
                    disabled={pathChecking}
                  >
                    {pathChecking ? 'Checking...' : 'Check & Fix PATH'}
                  </button>
                  <div className="settings-description" style={{ marginTop: 6 }}>
                    Check if the Claude CLI is in your shell PATH and fix it if not.
                  </div>
                  {pathCheckStatus && (
                    <div className="settings-update-status">{pathCheckStatus}</div>
                  )}
                </div>
                </SettingsCard>
                  </div>
                )}
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
        <div className="modal-footer">
          <span className="modal-footer-left">
            {__BUILD_SHA__} &middot; {__BUILD_DATE__}
          </span>
          <span className="modal-footer-right">
            By{' '}
            <a className="footer-link" onClick={() => getDockApi().app.openExternal('https://github.com/BenDol')}>
              Ben Dol
            </a>
            {' '}&middot;{' '}
            <a className="footer-link footer-sponsor" onClick={() => getDockApi().app.openExternal('https://github.com/sponsors/BenDol')}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.6 20.6 0 008 13.393a20.6 20.6 0 003.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.749.749 0 01-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5z" /></svg>
              {' '}Sponsor
            </a>
          </span>
        </div>
      </div>
    </div>
  )
}

declare const __BUILD_SHA__: string
declare const __BUILD_DATE__: string
declare const __DEV__: boolean

export default SettingsModal
