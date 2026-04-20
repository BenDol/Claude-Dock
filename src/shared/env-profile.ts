/**
 * Environment profile — single source of truth for how the running instance
 * identifies itself across the OS (userData dir, appId/AUMID, MCP entry name,
 * linked-file name, window title). Used by every process.
 *
 * A profile is baked in at build time via the `DOCK_ENV_PROFILE` env var,
 * threaded through Vite's `define` into `__ENV_PROFILE__`. The runtime reads
 * that constant via `ENV_PROFILE` below.
 *
 * The `uat` profile keeps legacy identifiers (`claude-dock` userData,
 * `com.claude.dock` appId, `Claude Dock` product name) so that existing
 * installations upgrade in place. `dev` and `prod` get fresh, isolated
 * identifiers and can therefore coexist with `uat` and with each other.
 */

export type EnvProfile = 'dev' | 'uat' | 'prod'

declare const __ENV_PROFILE__: EnvProfile

const FALLBACK_PROFILE: EnvProfile = 'uat'

export const ENV_PROFILE: EnvProfile =
  typeof __ENV_PROFILE__ !== 'undefined' ? __ENV_PROFILE__ : FALLBACK_PROFILE

export const INSTALLABLE_PROFILES: EnvProfile[] = ['uat', 'prod']

/** Directory name under `appData` where userData lives. UAT keeps legacy name. */
export function getUserDataDirName(p: EnvProfile = ENV_PROFILE): string {
  return p === 'uat' ? 'claude-dock' : `claude-dock-${p}`
}

/** Human-readable product name. UAT keeps legacy name for backwards compat. */
export function getAppName(p: EnvProfile = ENV_PROFILE): string {
  if (p === 'uat') return 'Claude Dock'
  if (p === 'prod') return 'Claude Dock Stable'
  return 'Claude Dock Dev'
}

/** Windows AppUserModelId — must match electron-builder `appId`. */
export function getAppUserModelId(p: EnvProfile = ENV_PROFILE): string {
  return p === 'uat' ? 'com.claude.dock' : `com.claude.dock.${p}`
}

/** Filename of the linked-project marker in a project root. */
export function getLinkedFileName(p: EnvProfile = ENV_PROFILE): string {
  return `.linked-${p}`
}

/** Key used for this Dock's entry inside a project's `.mcp.json`. */
export function getMcpEntryName(p: EnvProfile = ENV_PROFILE): string {
  return `claude-dock-${p}`
}

/**
 * Suffix appended to the window title. Prod and UAT run un-suffixed: UAT keeps
 * the legacy `Claude Dock` title so existing installs don't see a surprise
 * `(uat)` suffix after upgrade. Only `dev` is visually marked.
 */
export function getTitleSuffix(p: EnvProfile = ENV_PROFILE): string {
  return p === 'dev' ? ` (${p})` : ''
}

/**
 * PascalCase identifier used for Windows registry keys, file/folder names,
 * and C# namespace/class names inside the shell-extension DLL. Must be
 * unique per installable profile so two profiles coexist in `HKCU` without
 * clobbering each other.
 */
export function getShellExtensionIdentifier(p: EnvProfile = ENV_PROFILE): string {
  if (p === 'uat') return 'ClaudeDock' // legacy — preserved for upgrade-in-place
  if (p === 'prod') return 'ClaudeDockStable'
  return 'ClaudeDockDev'
}

/**
 * COM CLSID for the Windows IExplorerCommand handler. Must be unique per
 * installable profile, otherwise the second install overwrites the first's
 * COM registration in HKCU\Software\Classes\CLSID.
 *
 * These are pre-generated fixed GUIDs, not random at build time — they must
 * remain stable across builds so uninstall always hits the right key.
 */
export function getContextMenuClsid(p: EnvProfile = ENV_PROFILE): string {
  if (p === 'uat') return '{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3D}' // legacy
  if (p === 'prod') return '{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3E}' // +1 on last hex digit
  return '{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3F}'
}

/**
 * Stable GUID returned by IExplorerCommand::GetCanonicalName. Different from
 * the CLSID and also must be unique per profile.
 */
export function getContextMenuCanonicalGuid(p: EnvProfile = ENV_PROFILE): string {
  if (p === 'uat') return 'D47C2B94-A3F5-4D8A-B61D-7C2E8F9A0B3D'
  if (p === 'prod') return 'D47C2B94-A3F5-4D8A-B61D-7C2E8F9A0B3E'
  return 'D47C2B94-A3F5-4D8A-B61D-7C2E8F9A0B3F'
}

/**
 * Human-readable verb shown in the OS context menu / Quick Action.
 * UAT keeps legacy wording so existing installs aren't visually renamed.
 */
export function getContextMenuLabel(p: EnvProfile = ENV_PROFILE): string {
  return p === 'uat' ? 'Open with Claude Dock' : `Open with ${getAppName(p)}`
}

