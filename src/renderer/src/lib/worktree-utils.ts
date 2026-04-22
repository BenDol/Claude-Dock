/**
 * If `cwd` is inside a `.claude/worktrees/<id>` directory, return the worktree
 * root path (everything up to and including the `<id>` segment). Otherwise
 * return null. Used to auto-register a terminal as a worktree terminal when
 * the spawn cwd is inside a dock-managed worktree.
 */
export function detectWorktreePath(cwd: string): string | null {
  if (!cwd) return null
  const normalized = cwd.replace(/\\/g, '/')
  const match = normalized.match(/^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/)
  if (!match) return null
  // Preserve the original separator style (important for Windows paths).
  const usesBackslash = cwd.includes('\\')
  return usesBackslash ? match[1].replace(/\//g, '\\') : match[1]
}
