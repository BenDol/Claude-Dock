import React, { useEffect, useState, useCallback, useMemo, useRef, Suspense, Component, type ErrorInfo, type ReactNode } from 'react'
import DockGrid from './components/DockGrid'
import { DockPanelLayout } from './components/DockPanelLayout'
import Toolbar from './components/Toolbar'
import EmptyState from './components/EmptyState'
import SettingsModal from './components/SettingsModal'
import BugReportModal from './components/BugReportModal'
import Launcher from './components/Launcher'
import ToastContainer from './components/ToastContainer'
import PluginUpdaterModal from './components/PluginUpdaterModal'
import { useDockStore } from './stores/dock-store'
import { useEditorStore } from './stores/editor-store'
import { useSettingsStore } from './stores/settings-store'
import { getDockApi } from './lib/ipc-bridge'
import { applyThemeToDocument } from './lib/theme'
import { computeAutoLayout, computePortraitLayout, findAdjacentTerminal, findTerminalFromToolbar, TOOLBAR_FOCUS_ID, type Direction } from './lib/grid-math'
import { getPluginViews } from './plugin-views'
import { useInputContextMenu } from './hooks/useInputContextMenu'
import type { ClaudeTaskRequest, CiFixTask, ReferenceThisTask, MergeResolveTask, IssueFixTask, TaskPermissions } from '../../shared/claude-task-types'
import { getTaskMeta, buildClaudeFlags } from '../../shared/claude-task-types'

const searchParams = new URLSearchParams(window.location.search)
const isLauncher = searchParams.has('launcher')
const isDetachedEditor = searchParams.has('detachedEditor')
const pluginView = getPluginViews().find((v) => searchParams.has(v.queryParam))

function matchesKeybind(e: KeyboardEvent, keybind: string): boolean {
  if (!keybind || keybind.startsWith('!')) return false
  const parts = keybind.split('+').map((p) => p.trim().toLowerCase())
  const needCtrl = parts.includes('ctrl')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  const key = parts.find((p) => !['ctrl', 'shift', 'alt', 'meta'].includes(p))
  if (!key) return false

  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false
  return e.key.toLowerCase() === key
}

/**
 * Error boundary that catches React render crashes.
 * Without this, a single component error nukes the entire window (blank screen).
 * Logs the error to the main-process log file via IPC and shows a recovery UI.
 */
class RendererErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const text = `[renderer] React error boundary caught: ${error.message}\n${error.stack || ''}\nComponent stack: ${info.componentStack || 'N/A'}`
    try { getDockApi().debug.write(text) } catch { /* IPC may be dead */ }
    try { getDockApi().debug.reportCrash('react-error-boundary', error.message, (error.stack || '') + '\nComponent stack: ' + (info.componentStack || 'N/A')) } catch { /* IPC may be dead */ }
    console.error(text)
  }

  render() {
    if (this.state.error) {
      const label = this.props.label || 'component'
      return (
        <div style={{
          padding: 24, color: 'var(--text-primary, #c0caf5)',
          background: 'var(--bg-primary, #0f0f14)', height: '100%',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          display: 'flex', flexDirection: 'column', gap: 12
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f87171' }}>
            {label} crashed
          </h2>
          <pre style={{
            fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'var(--bg-secondary, #1a1b26)', padding: 12, borderRadius: 6,
            border: '1px solid var(--border-color, #292e42)', maxHeight: 200, overflow: 'auto'
          }}>
            {this.state.error.message}
            {this.state.error.stack && '\n\n' + this.state.error.stack}
          </pre>
          <div>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
                background: 'var(--accent-color, #da7756)', color: '#fff', border: 'none'
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  // Right-click Cut/Copy/Paste menu on all text inputs and textareas
  useInputContextMenu()

  const [showPluginUpdater, setShowPluginUpdater] = useState(false)

  // Listen for plugin update open event (from notification action) — works in all window types
  useEffect(() => {
    const handler = () => setShowPluginUpdater(true)
    window.addEventListener('plugin-update-open', handler)
    return () => window.removeEventListener('plugin-update-open', handler)
  }, [])

  // Handle "Update All" action from notification toast
  useEffect(() => {
    const handler = async () => {
      try {
        await getDockApi().pluginUpdater.installAll()
      } catch { /* errors shown via state change broadcast */ }
    }
    window.addEventListener('plugin-update-all', handler)
    return () => window.removeEventListener('plugin-update-all', handler)
  }, [])

  // Handle "Restart Now" action from auto-update notification
  useEffect(() => {
    const handler = () => getDockApi().app.restart()
    window.addEventListener('app-restart', handler)
    return () => window.removeEventListener('app-restart', handler)
  }, [])

  // Listen for shell run-command from main process (e.g. cloud re-auth)
  useEffect(() => {
    return getDockApi().shell.onRunCommand((command, submit, targetTerminalId, shellType, targetShellId, shellLayout) => {
      useDockStore.getState().setPendingShellCommand({ command, submit, targetTerminalId, shellType, targetShellId, shellLayout })
    })
  }, [])

  // When a plugin window opens, show "updated" notification if that plugin has a new override
  useEffect(() => {
    if (!pluginView) return
    const timer = setTimeout(async () => {
      const api = getDockApi()
      try {
        const newOverrides = await api.pluginUpdater.getNewOverrides()
        const ov = newOverrides.find((o) => o.pluginId === pluginView.pluginId)
        if (!ov) return
        const sha = ov.buildSha.slice(0, 7)
        const lines = [`v${ov.version} (${sha})`]
        if (ov.changelog) lines.push(ov.changelog)
        api.notifications.emit({
          id: `plugin-updated-${ov.pluginId}-${ov.hash.slice(0, 8)}`,
          title: `${ov.pluginName} Updated`,
          message: lines.join('\n'),
          type: 'success',
          source: 'plugin-updater',
          timeout: 0
        })
        await api.pluginUpdater.markOverrideSeen(ov.pluginId, ov.hash)
      } catch { /* ignore */ }
    }, 1000)
    return () => clearTimeout(timer)
  }, [])

  // When a dock window opens, check if there are pending plugin updates and re-notify
  useEffect(() => {
    if (isLauncher || pluginView) return
    const timer = setTimeout(async () => {
      const api = getDockApi()
      try {
        const updates = await api.pluginUpdater.getAvailable()
        if (updates.length > 0 && updates.some((u) => u.status === 'available')) {
          const names = updates.filter((u) => u.status === 'available').map((u) => u.pluginName)
          api.notifications.emit({
            id: `plugin-updates-${Date.now()}`,
            title: 'Plugin Updates Available',
            message: names.length <= 3
              ? names.join(', ')
              : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more...`,
            type: 'info',
            source: 'plugin-updater',
            timeout: 0,
            actions: [
              { label: 'View', event: 'plugin-update-open' },
              { label: 'Update All', event: 'plugin-update-all' }
            ]
          })
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  const pluginUpdaterModal = showPluginUpdater
    ? <PluginUpdaterModal onClose={() => setShowPluginUpdater(false)} />
    : null

  if (isDetachedEditor) {
    return (
      <RendererErrorBoundary label="detached-editor">
        <DetachedEditorShell />
      </RendererErrorBoundary>
    )
  }
  if (pluginView) {
    const PluginComponent = pluginView.component
    return (
      <>
        <RendererErrorBoundary label={pluginView.pluginId}>
          <Suspense fallback={<div className="loading">Loading...</div>}>
            <PluginComponent />
          </Suspense>
        </RendererErrorBoundary>
        <ToastContainer />
        {pluginUpdaterModal}
      </>
    )
  }
  if (isLauncher) {
    return (
      <>
        <RendererErrorBoundary label="Launcher">
          <LauncherApp />
        </RendererErrorBoundary>
        <ToastContainer />
        {pluginUpdaterModal}
      </>
    )
  }
  return (
    <>
      <RendererErrorBoundary label="Dock">
        <DockApp />
      </RendererErrorBoundary>
      <ToastContainer />
      {pluginUpdaterModal}
    </>
  )
}

function LauncherApp() {
  const loadSettings = useSettingsStore((s) => s.load)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  return <Launcher />
}

let nextTermId = 1


async function buildCiFixPrompt(task: CiFixTask, context: string, api: ReturnType<typeof getDockApi>, dir: string): Promise<string> {
  try {
    const { runName, runNumber, headBranch: branch, failedJobs } = task

    // Save full job logs to temp files for Claude to read
    const jobLogFiles: { name: string; path: string }[] = []
    for (const fj of failedJobs) {
      if (!fj.id) continue
      try {
        // Try sourceDir first (submodule may have its own CI), fall back to dock projectDir
        let result = { path: '', error: undefined as string | undefined }
        if (task.sourceDir && task.sourceDir !== dir) {
          try { result = await api.ci.saveJobLog(task.sourceDir, task.runId, fj.id, fj.name) } catch { /* fall through */ }
        }
        if (!result.path) {
          try { result = await api.ci.saveJobLog(dir, task.runId, fj.id, fj.name) } catch { /* continue */ }
        }
        if (result.path) {
          jobLogFiles.push({ name: fj.name, path: result.path })
        }
      } catch { /* continue without log */ }
    }

    const jobList = failedJobs.map((j) => {
      const steps = j.failedSteps.length > 0 ? ` (failed steps: ${j.failedSteps.join(', ')})` : ''
      return `  - ${j.name}${steps}`
    }).join('\n')

    let logSection = ''
    if (jobLogFiles.length === 1) {
      logSection = `\nThe full CI log for "${jobLogFiles[0].name}" has been saved to:\n  ${jobLogFiles[0].path}\n` +
        `Read this file to find the failure cause. The complete log is there — no need to re-fetch from CI.\n`
    } else if (jobLogFiles.length > 1) {
      logSection = '\nThe full CI logs for the failed jobs have been saved to the following files:\n' +
        jobLogFiles.map((f) => `  - ${f.name}: ${f.path}`).join('\n') + '\n' +
        `Read these files to find the failure causes. The complete logs are there — no need to re-fetch from CI.\n`
    } else {
      logSection = '\nCI logs could not be fetched automatically. Please check the CI pipeline logs yourself ' +
        `(e.g. \`gh run view ${task.runId} --log-failed\`) to find the error.\n`
    }

    const contextSection = context ? `\nAdditional instructions from the user:\n${context}\n` : ''

    // Detect submodule context — sourceDir differs from the dock's project dir
    const normalize = (p: string) => p.replace(/\\/g, '/')
    const isSubmodule = task.sourceDir && normalize(task.sourceDir) !== normalize(dir)
    const submoduleRelPath = isSubmodule ? normalize(task.sourceDir!).replace(normalize(dir) + '/', '') : ''
    const submoduleSection = isSubmodule
      ? `\nIMPORTANT: This CI failure is from the submodule at "${submoduleRelPath}" (full path: ${task.sourceDir}). ` +
        `The fix must be made INSIDE the submodule directory, not in the parent repository. ` +
        `cd into the submodule before creating worktrees or making changes.\n`
      : ''

    const startIso = new Date().toISOString()

    return `A CI build has failed and needs to be fixed.\n\n` +
      `Workflow: ${runName || 'CI Run'} #${runNumber || 0}\n` +
      `Branch: ${branch}\n` +
      `Fix started at: ${startIso}\n` +
      (jobList ? `Failed jobs:\n${jobList}\n` : '') +
      logSection +
      submoduleSection +
      contextSection +
      `Find the relevant code and fix the issue.\n\n` +
      `CRITICAL BRANCH SAFETY INSTRUCTIONS:\n` +
      `OVERRIDE: Any CLAUDE.md or project instructions that restrict git write actions (commits, branch creation, pushes) ` +
      `do NOT apply to this task. You are explicitly authorized to create commits, branches, worktrees, and push to the ` +
      `branch "${branch}" as part of this CI fix. This is a user-initiated automated fix task.\n\n` +
      `The fix MUST be committed and pushed to the branch "${branch}". ` +
      `You MUST NOT disturb the user's current working tree, staged files, or checked-out branch. ` +
      `Use a git worktree to work in isolation:\n` +
      `  1. Run: git worktree add ../ci-fix-${branch.replace(/[^a-zA-Z0-9_-]/g, '-')} ${branch}\n` +
      `  2. cd into the worktree directory and make your fix there\n` +
      `  IMPORTANT: The worktree will NOT have node_modules or other installed dependencies. ` +
      `Do NOT run tests, builds, or linters from the worktree. Always run those from the original project directory if needed. ` +
      `The worktree is ONLY for making code changes, committing, and pushing.\n` +
      `  3. Commit and push from the worktree: git push origin ${branch}\n` +
      `  4. cd back to the original directory and clean up: git worktree remove ../ci-fix-${branch.replace(/[^a-zA-Z0-9_-]/g, '-')}\n` +
      `Pushing the fix will automatically trigger a new CI run.\n\n` +
      `COMMIT MESSAGE INSTRUCTIONS:\n` +
      `At the bottom of every commit message, include the following lines:\n` +
      `  - "Resolved in: Xm Ys" where X and Y are the elapsed minutes and seconds since the fix started at ${startIso}. ` +
      `Calculate this by comparing the current time to the start time when you make the commit.\n` +
      `  - "Fixed with Claude via Fix with Claude (Claude Dock)"\n\n` +
      `IMPORTANT: When you have successfully fixed the issue, committed, and pushed the changes, output the exact text CI_FIX_COMPLETE on its own line. ` +
      `If you cannot fix the issue or need more information, do NOT output this marker.`
  } catch {
    return 'A CI build has failed. Please check the CI logs and fix the issue.\n\n' +
      'IMPORTANT: When you have successfully fixed the issue, committed, and pushed the changes, output the exact text CI_FIX_COMPLETE on its own line.'
  }
}

function buildWriteTestsPrompt(task: import('../../shared/claude-task-types').WriteTestsTask, context: string): string {
  const parts: string[] = []

  if (task.commitHash) {
    parts.push(
      `Write tests for the changes in commit ${task.commitHash.slice(0, 8)}${task.commitSubject ? ` ("${task.commitSubject}")` : ''}.`,
      `Run \`git show ${task.commitHash}\` to see the full diff, then read the source files to understand the full context.`
    )
  } else {
    parts.push(
      `Write tests for the following files:`,
      task.files.map(f => `  - ${f}`).join('\n'),
      `Read each file to understand what it does before writing tests.`
    )
  }

  if (task.selectedDiff) {
    parts.push(`\nThe following diff lines were specifically selected for focus:\n\`\`\`diff\n${task.selectedDiff}\n\`\`\``)
  }

  if (context) {
    parts.push(`\nAdditional instructions:\n${context}`)
  }

  parts.push(
    '\nBefore writing tests, carefully review the code logic for correctness. ' +
    'If you identify any bugs, edge cases, or unsound logic, fix those issues first. ' +
    'Then write tests that verify both the corrected behavior and the existing functionality, ' +
    'ensuring the code is robust and sound.\n\n' +
    'Only write tests for code where testing is appropriate and adds value. ' +
    'If the changes are purely cosmetic, configuration-only, or otherwise not suited for testing, ' +
    'state this clearly and explain why no tests are warranted instead of writing unnecessary tests.\n\n' +
    'Follow the existing test patterns and conventions in this project. ' +
    'If test files already exist for these modules, add to them; otherwise create new test files in the appropriate location.'
  )

  return parts.join('\n')
}

function buildReferenceThisPrompt(task: ReferenceThisTask, context: string): string {
  const parts: string[] = []

  if (task.commitHash) {
    parts.push(
      `Reference changes in commit ${task.commitHash.slice(0, 8)}${task.commitSubject ? ` ("${task.commitSubject}")` : ''}.`,
      `Run \`git show ${task.commitHash}\` to see the diff.`
    )
  } else if (task.files.length > 0) {
    parts.push(
      `Reference the following files:`,
      task.files.map(f => `  - ${f}`).join('\n'),
      `Read each file.`
    )
  }

  if (task.selectedDiff) {
    parts.push(`\nThe following diff lines were specifically selected for focus:\n\`\`\`diff\n${task.selectedDiff}\n\`\`\``)
  }

  parts.push(`\nRead the referenced code and be ready for further instructions. Do not make changes yet.`)

  if (context) {
    parts.push(`\nAdditional instructions:\n${context}`)
  }

  return parts.join('\n')
}

function buildMergeResolvePrompt(task: MergeResolveTask, dir: string): string {
  const normalize = (p: string) => p.replace(/\\/g, '/')
  const isSubmodule = task.sourceDir && normalize(task.sourceDir) !== normalize(dir)
  const submoduleNote = isSubmodule
    ? `\nNote: This file is inside the submodule at "${normalize(task.sourceDir!).replace(normalize(dir) + '/', '')}". ` +
      `Work within that submodule directory (${task.sourceDir}).\n`
    : ''

  const parts: string[] = [
    `Resolve the merge conflict in the file: ${task.filePath}`,
    '',
    `Read the file first — it contains conflict markers (<<<<<<< / ======= / >>>>>>>).`,
    `Resolve the conflicts according to these instructions:`,
    '',
    task.instructions,
    submoduleNote,
    `After resolving, write the file back with all conflict markers removed.`,
    `Make sure the result is valid, compiles, and preserves the intent described above.`
  ]
  return parts.join('\n')
}

/**
 * Build the prompt for a "Solve Issue" Claude task.
 *
 * The main process classifies the issue by label (with a configurable mapping)
 * before dispatching, so `task.selectedBehavior` and `task.behaviorDescription`
 * are already populated. Claude is still instructed to self-classify from the
 * body as a sanity check, and to ALWAYS ask the developer when context is thin.
 *
 * Unlike ci-fix, there is NO completion marker — Claude writes the Agent
 * Resolution back to the issue body itself via gh/glab CLI. The dock does not
 * parse stdout for this flow.
 */
function buildIssueFixPrompt(task: IssueFixTask, context: string): string {
  const startIso = new Date().toISOString()

  // Strip any existing Agent Resolution section from the ORIGINAL BODY block
  // so Claude reasons about the clean original text. The writeback instructions
  // still tell Claude to detect-and-replace regardless of this flag.
  const stripAgentResolution = (body: string): string => {
    const match = body.match(/\n?---\s*\n+##\s+Agent Resolution\b/m) || body.match(/\n?##\s+Agent Resolution\b/m)
    if (!match || match.index == null) return body
    return body.slice(0, match.index).replace(/\s+$/, '')
  }

  const cleanBody = stripAgentResolution(task.issueBody || '(empty)')
  const existingNote = task.hasExistingAgentResolution
    ? 'NOTE: This issue already has an Agent Resolution section from a previous run — REPLACE it in full on writeback; do not preserve the old one.\n'
    : ''

  const commentsBlock = task.commentsPreview.length > 0
    ? task.commentsPreview
        .map((c) => `  - @${c.author} (${c.createdAt}):\n    ${c.body.replace(/\n/g, '\n    ')}`)
        .join('\n')
    : '  (no comments)'

  const labelsStr = task.labels.length > 0 ? task.labels.join(', ') : '(none)'
  const assigneesStr = task.assignees.length > 0 ? task.assignees.map((a) => '@' + a).join(', ') : '(none)'

  // CLI-specific writeback commands
  const cli = task.providerCli
  const fetchBodyCmd = cli === 'gh'
    ? `gh issue view ${task.issueId} --json body -q .body > /tmp/issue-${task.issueId}-body.md`
    : `glab issue view ${task.issueId} --output json | jq -r .description > /tmp/issue-${task.issueId}-body.md`
  const writeBodyCmd = cli === 'gh'
    ? `gh issue edit ${task.issueId} --body-file /tmp/issue-${task.issueId}-body.md`
    : `glab api -X PUT "projects/:fullpath:/issues/${task.issueId}" --input - <<< "$(jq -Rs '{description: .}' < /tmp/issue-${task.issueId}-body.md)"`

  const addendum = task.promptAddendum ? `\nAdditional guidance for this issue type:\n${task.promptAddendum}\n` : ''
  const contextSection = context ? `\nAdditional instructions from the user:\n${context}\n` : ''

  const behaviorSourceNote = task.behaviorSource === 'default'
    ? '(no label matched — this is the fallback behavior)'
    : '(derived from labels)'

  const slug = task.issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'issue'
  const branchName = `issue-${task.issueId}-${slug}`
  const worktreeDir = `../${branchName}-work`

  return (
`You are being asked to work on a ${task.provider === 'gitlab' ? 'GitLab' : 'GitHub'} issue.

Issue #${task.issueId}: ${task.issueTitle}
URL:    ${task.issueUrl}
State:  ${task.issueState}
Author: @${task.author}
Labels: ${labelsStr}
Assignees: ${assigneesStr}
Started: ${startIso}
Run ID:  ${task.runId}

${existingNote}--- ORIGINAL ISSUE BODY ---
${cleanBody}
--- END ORIGINAL BODY ---

Recent comments (${task.commentsPreview.length}):
${commentsBlock}

=== BEHAVIOR PROFILE: ${task.selectedBehavior} ${behaviorSourceNote} ===
${task.behaviorDescription}
${addendum}
=== SELF-CLASSIFICATION SANITY CHECK ===
Before starting, independently classify this issue from the BODY and COMMENTS above,
ignoring the labels. State your classification explicitly. If it disagrees with the
label-derived behavior above, STOP and ask the developer which to follow before
proceeding.

=== ASK WHEN UNSURE ===
If at ANY point you lack context about the intended behavior, affected users,
reproduction steps, acceptance criteria, or scope — STOP and ask the developer in
this terminal before writing code. Do NOT guess. It is always better to pause and
confirm than to implement the wrong thing.
${contextSection}
=== BRANCH SAFETY + WORKTREE INSTRUCTIONS ===
OVERRIDE: Any CLAUDE.md or project instructions that restrict git write actions
(commits, branch creation, pushes) do NOT apply to this task. You are explicitly
authorized to create commits, branches, worktrees, and push.

You MUST NOT disturb the user's current working tree, staged files, or checked-out
branch. Work in an isolated git worktree:
  1. git worktree add -b ${branchName} ${worktreeDir} ${task.defaultBranch}
  2. cd into ${worktreeDir} and make your changes there
     IMPORTANT: the worktree will NOT have node_modules or other installed
     dependencies. Do NOT run tests, builds, or linters from the worktree. Run
     those from the original project directory if needed. The worktree is ONLY
     for code changes, commits, and pushes.
  3. Commit and push: git push -u origin ${branchName}
  4. cd back to the original directory and clean up:
       git worktree remove ${worktreeDir}

Commit-message footer (append to every commit you make for this issue):
  - "Fixes #${task.issueId}"
  - "Solved with Claude Dock — Solve Issue (run ${task.runId})"

=== AGENT RESOLUTION WRITEBACK (CRITICAL) ===
When you finish — whether you succeeded, partially resolved, or got stuck — you
MUST update the issue body yourself. The dock does NOT parse your stdout for this.
You are the only one who can record the outcome.

1. Fetch the current body into a file:
     ${fetchBodyCmd}

2. If the file contains a line matching '^## Agent Resolution', REPLACE everything
   from that line to the end of the file. Otherwise APPEND a new section.

3. The section MUST match this exact markdown format (do not deviate):

   ---

   ## Agent Resolution

   _Updated: <ISO timestamp> — Claude Dock — Solve Issue — run \`${task.runId}\`_

   **Behavior:** ${task.selectedBehavior} ${behaviorSourceNote}

   **Process:**
   <1–3 paragraphs describing what you investigated, which files you read, which
   commands/tests you ran, and how you arrived at the resolution.>

   **Decisions:**
   - <bullet per meaningful decision or trade-off>

   **Code Changes:**
   - \`path/to/file\`: <one-line summary>
   - (repeat for each touched file)
   - Branch: \`${branchName}\`
   - Commit(s): <sha1[, sha2...]>

   **Notes for Review:**
   - <anything reviewers should double-check or verify manually>

   **Status:** <Resolved | Partial — needs follow-up | Blocked — waiting on developer>

4. Write the updated body back to the issue:
     ${writeBodyCmd}

5. Re-fetch the issue and grep for your run id (\`${task.runId}\`) to confirm the
   writeback succeeded.

6. IF YOU CRASH OR HIT AN UNRECOVERABLE ERROR, still write an Agent Resolution
   section with Status: "Blocked — waiting on developer" describing exactly what
   failed and what you need. Do not leave the issue untouched — the developer
   needs to know this run happened.

Good luck. Be careful, be thorough, and ask questions.`
  )
}

/** Detached editor window — renders EditorOverlay full-screen with tabs from URL */
const LazyEditorOverlay = React.lazy(() => import('./components/EditorOverlay'))

// EditorOverlay (rendered inside DetachedEditorShell) owns the IPC listeners
// for `editor:open-file` and `editor:hydrate-tabs`, so they're not duplicated here.

function DetachedEditorShell() {
  const loadSettings = useSettingsStore((s) => s.load)
  const tabCount = useEditorStore((s) => s.tabs.length)

  const projectDir = useMemo(
    () => decodeURIComponent(new URLSearchParams(window.location.search).get('projectDir') || ''),
    []
  )
  const projectName = useMemo(() => projectDir.split(/[/\\]/).pop() || projectDir, [projectDir])

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  // Editor IPC listeners at root level — registered before EditorOverlay finishes
  // lazy-loading so initial `editor:hydrate-tabs` (pushed after did-finish-load) lands.
  useEffect(() => {
    const api = getDockApi()
    const cleanupHydrate = api.workspace.onHydrateTabs((tabsJson: string) => {
      try {
        const tabs = JSON.parse(tabsJson)
        const store = useEditorStore.getState()
        for (const tab of tabs) {
          if (tab.projectDir && tab.relativePath && tab.content != null) {
            store.openFile(tab.projectDir, tab.relativePath, tab.content)
          }
        }
      } catch { /* ignore malformed */ }
    })
    const cleanupOpen = api.workspace.onOpenFile((req) => {
      const store = useEditorStore.getState()
      if (req.line != null) store.openFileAtPosition(req.projectDir, req.relativePath, req.content, req.line, req.column ?? 1)
      else store.openFile(req.projectDir, req.relativePath, req.content)
    })
    return () => { cleanupHydrate(); cleanupOpen() }
  }, [])

  const handleRedock = useCallback(async () => {
    const tabs = useEditorStore.getState().tabs
    const dirty = tabs.filter((t) => t.content !== t.savedContent)
    if (dirty.length > 0) {
      const names = dirty.map((t) => t.fileName).join(', ')
      if (!confirm(`Unsaved changes in: ${names}\nRedock anyway? Changes will move with the tabs but stay unsaved.`)) return
    }
    await getDockApi().workspace.redockEditor(projectDir, JSON.stringify(tabs))
  }, [projectDir])

  return (
    <div className="app" style={{ height: '100vh' }}>
      {/* Frameless window title bar with drag region + controls */}
      <div className="detached-editor-titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="detached-editor-titlebar-left" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="detached-editor-titlebar-title">Editor</span>
          {projectName && <span className="detached-editor-titlebar-project">{projectName}</span>}
        </div>
        <div className="detached-editor-titlebar-right" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            className="detached-editor-redock-btn"
            onClick={handleRedock}
            disabled={tabCount === 0}
            title="Move all tabs back to the dock window"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3h18v18H3z" /><path d="M9 12h12" /><path d="M15 6l-6 6 6 6" />
            </svg>
            <span>Redock</span>
          </button>
          <div className="detached-editor-titlebar-sep" />
          <button className="win-btn" onClick={() => getDockApi().win.minimize()} title="Minimize">&#x2015;</button>
          <button className="win-btn" onClick={() => getDockApi().win.maximize()} title="Maximize">&#9744;</button>
          <button className="win-btn win-close" onClick={() => getDockApi().win.close()} title="Close">&#10005;</button>
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <Suspense fallback={<div className="loading">Loading editor...</div>}>
          <LazyEditorOverlay />
        </Suspense>
      </div>
    </div>
  )
}

function DockApp() {
  const terminals = useDockStore((s) => s.terminals)
  const projectDir = useDockStore((s) => s.projectDir)
  const setDockInfo = useDockStore((s) => s.setDockInfo)
  const addTerminal = useDockStore((s) => s.addTerminal)
  const setTerminalAlive = useDockStore((s) => s.setTerminalAlive)
  const removeTerminal = useDockStore((s) => s.removeTerminal)
  const focusNextTerminal = useDockStore((s) => s.focusNextTerminal)
  const loadSettings = useSettingsStore((s) => s.load)
  const autoSpawn = useSettingsStore((s) => s.settings.behavior.autoSpawnFirstTerminal)

  const [showSettings, setShowSettings] = useState<{ tab?: string; section?: string; pluginId?: string } | false>(false)

  // Listen for plugin settings open event — dispatched from plugin headers
  // (e.g. the workspace plugin's settings cog) to jump straight to the
  // plugin's detail view in the settings modal.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { pluginId?: string } | undefined
      setShowSettings({ tab: 'plugins', pluginId: detail?.pluginId })
    }
    window.addEventListener('plugin-settings-open', handler)
    return () => window.removeEventListener('plugin-settings-open', handler)
  }, [])
  const [showBugReport, setShowBugReport] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [initialTerminalCount, setInitialTerminalCount] = useState(1)
  const [isResumingSession, setIsResumingSession] = useState(false)

  // Initialize dock info and settings
  useEffect(() => {
    async function init() {
      const api = getDockApi()
      const [info] = await Promise.all([
        api.dock.getInfo(),
        loadSettings()
      ])
      if (info) {
        setDockInfo(info.id, info.projectDir)
        if (info.savedSessionCount > 0) {
          setInitialTerminalCount(info.savedSessionCount)
          setIsResumingSession(true)
        }
      }
      setInitialized(true)
    }
    init()
  }, [setDockInfo, loadSettings])

  // Set window title to include project folder name
  useEffect(() => {
    if (projectDir) {
      const name = projectDir.split(/[/\\]/).pop() || projectDir
      document.title = `${name} - Claude Dock`
    }
  }, [projectDir])

  // Editor IPC listeners — must be at root level (not inside EditorOverlay)
  // because EditorOverlay unmounts when tabs.length === 0, which happens
  // after the user drags the last tab out to the detached window. Without
  // root-level listeners, redock and forwarded file-open events would be
  // fired into the void when the dock has no open editor tabs.
  useEffect(() => {
    const api = getDockApi()
    const cleanupHydrate = api.workspace.onHydrateTabs((tabsJson: string) => {
      try {
        const tabs = JSON.parse(tabsJson)
        const store = useEditorStore.getState()
        for (const tab of tabs) {
          if (tab.projectDir && tab.relativePath && tab.content != null) {
            store.openFile(tab.projectDir, tab.relativePath, tab.content)
          }
        }
      } catch { /* ignore malformed */ }
    })
    const cleanupOpen = api.workspace.onOpenFile((req) => {
      const store = useEditorStore.getState()
      if (req.line != null) store.openFileAtPosition(req.projectDir, req.relativePath, req.content, req.line, req.column ?? 1)
      else store.openFile(req.projectDir, req.relativePath, req.content)
    })
    return () => { cleanupHydrate(); cleanupOpen() }
  }, [])

  // Auto-spawn terminals (matching saved session count or 1)
  useEffect(() => {
    if (initialized && autoSpawn && terminals.length === 0) {
      for (let i = 0; i < initialTerminalCount; i++) {
        const id = `term-${nextTermId++}-${Date.now()}`
        addTerminal(id)
        // Mark terminals created from saved sessions so the loading overlay
        // can show "Resuming session..." and wait longer for ConPTY to settle
        if (isResumingSession) {
          useDockStore.getState().markTerminalResumed(id)
        }
      }
    }
  }, [initialized, autoSpawn])

  // Listen for terminal exits
  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.terminal.onExit((terminalId, _exitCode) => {
      setTerminalAlive(terminalId, false)
    })
    return cleanup
  }, [setTerminalAlive])

  // "Send to Claude" — show terminal picker, then send prompt to chosen terminal
  const [pendingTask, setPendingTask] = useState<ClaudeTaskRequest | null>(null)

  useEffect(() => {
    const api = getDockApi()
    // Listen for tasks from IPC (generic claude:task channel)
    const ipcCleanup = api.claudeTask.onTask((task) => {
      setPendingTask(task)
    })
    // Listen for CI fix from DOM events (notification-triggered)
    const domHandler = (e: Event) => {
      const data = (e as CustomEvent).detail as Record<string, unknown>
      if (data?.runId) {
        const task: CiFixTask = {
          type: 'ci-fix',
          runId: data.runId as number,
          runName: data.runName as string,
          runNumber: data.runNumber as number,
          headBranch: data.headBranch as string,
          failedJobs: data.failedJobs as CiFixTask['failedJobs'],
          primaryFailedJobId: data.primaryFailedJobId as number | undefined
        }
        setPendingTask(task)
      }
    }
    window.addEventListener('ci-fix-with-claude', domHandler)
    return () => {
      ipcCleanup()
      window.removeEventListener('ci-fix-with-claude', domHandler)
    }
  }, [])

  // Track active CI fix terminals for completion monitoring
  const ciFixCleanups = useRef<Map<string, () => void>>(new Map())

  const stripAnsi = useCallback((str: string) =>
    str
      .replace(/\x1b\][^\x07]*\x07/g, '')                                              // OSC sequences
      .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, '')  // CSI sequences
      .replace(/\x1b[()][A-Z0-9]/g, '')                                                // Character set selection
      .replace(/\x1b[78DEHM]/g, '')                                                     // Other single-char escapes
      .replace(/\r/g, ''),                                                               // Carriage returns
  [])

  const monitorForCompletion = useCallback((termId: string, fixData: Record<string, unknown>) => {
    const api = getDockApi()
    const MARKER = 'CI_FIX_COMPLETE'
    let triggered = false
    // The prompt contains CI_FIX_COMPLETE as an instruction. Claude CLI echoes
    // it when pasting the prompt. We skip any marker sightings within the first
    // 15 seconds (the echo window), then trigger on the first sighting after that
    // (Claude's actual completion output).
    const monitorStartedAt = Date.now()
    const ECHO_WINDOW_MS = 15000
    let recentBuf = ''

    const cleanup = api.terminal.onData((id, chunk) => {
      if (id !== termId || triggered) return
      const clean = stripAnsi(chunk)

      recentBuf += clean
      if (recentBuf.length > 2000) recentBuf = recentBuf.slice(-1500)

      const found = recentBuf.includes(MARKER) ||
        recentBuf.replace(/\s+/g, '').includes(MARKER)

      if (found) {
        if (Date.now() - monitorStartedAt < ECHO_WINDOW_MS) {
          // Within echo window — this is the prompt echo, ignore and clear buffer
          recentBuf = ''
        } else {
          // Past echo window — Claude's actual completion signal
          triggered = true
          doCleanup()
          window.dispatchEvent(new CustomEvent('ci-fix-complete', { detail: fixData }))
          setTimeout(() => {
            api.terminal.kill(termId)
            removeTerminal(termId)
          }, 2000)
        }
      }
    })

    const doCleanup = () => {
      cleanup()
      ciFixCleanups.current.delete(termId)
    }

    // Also clean up if the terminal is closed manually
    const exitCleanup = api.terminal.onExit((id) => {
      if (id !== termId) return
      doCleanup()
      exitCleanup()
    })

    ciFixCleanups.current.set(termId, () => { doCleanup(); exitCleanup() })
  }, [removeTerminal, stripAnsi])

  const handleTaskTerminalSelected = useCallback(async (terminalId: string | null, context: string, permissions: TaskPermissions, useSession: boolean) => {
    const task = pendingTask
    setPendingTask(null)
    if (!task) return

    const api = getDockApi()
    const dir = useDockStore.getState().projectDir
    const meta = getTaskMeta(task)
    const flags = buildClaudeFlags(permissions)

    // Build prompt based on task type
    let prompt = ''
    if (task.type === 'ci-fix') {
      prompt = await buildCiFixPrompt(task, context, api, dir)
    } else if (task.type === 'write-tests') {
      prompt = buildWriteTestsPrompt(task, context)
    } else if (task.type === 'reference-this') {
      prompt = buildReferenceThisPrompt(task, context)
    } else if (task.type === 'merge-resolve') {
      prompt = buildMergeResolvePrompt(task, dir)
    } else if (task.type === 'issue-fix') {
      prompt = buildIssueFixPrompt(task, context)
    }

    const sendToTerminal = (termId: string) => {
      const paste = `\x1b[200~${prompt}\x1b[201~`
      api.terminal.write(termId, paste)
      setTimeout(() => api.terminal.write(termId, '\x1b'), 400)
      setTimeout(() => api.terminal.write(termId, '\r'), 700)
    }

    const startMonitoring = (termId: string) => {
      if (meta.completionMarker) {
        // Start monitoring after prompt is submitted (give time for paste + submit)
        setTimeout(() => monitorForCompletion(termId, task as Record<string, unknown>), 1500)
      }
    }

    if (terminalId) {
      // Existing terminal — send prompt directly, don't steal focus
      useDockStore.getState().setTerminalClaudeTask(terminalId, task.type)
      sendToTerminal(terminalId)
      startMonitoring(terminalId)
    } else {
      // New terminal — create, wait for Claude to start, then send
      const termId = `term-${nextTermId++}-${Date.now()}`
      const prevFocus = useDockStore.getState().focusedTerminalId
      useDockStore.getState().setTerminalClaudeTask(termId, task.type)
      if (useSession) {
        // Persistent session — use session-id mode, not ephemeral
        useDockStore.getState().setTerminalPersistentTask(termId, true)
      }
      if (flags) {
        useDockStore.getState().setTerminalClaudeFlags(termId, flags)
      }
      addTerminal(termId)
      if (prevFocus) useDockStore.getState().setFocusedTerminal(prevFocus)

      let sent = false
      const send = () => {
        if (sent) return
        sent = true
        sendToTerminal(termId)
        startMonitoring(termId)
      }

      let dataLen = 0
      const cleanup = api.terminal.onData((id, chunk) => {
        if (id !== termId) return
        dataLen += chunk.length
        if (dataLen > 2000) {
          cleanup()
          setTimeout(send, 500)
        }
      })
      setTimeout(() => { cleanup(); send() }, 8000)
    }
  }, [pendingTask, addTerminal, monitorForCompletion])

  // Handle manual cancellation of Claude task terminals
  useEffect(() => {
    const handler = (e: Event) => {
      const termId = (e as CustomEvent).detail as string
      if (!termId) return
      // Clean up the completion monitor
      const cleanup = ciFixCleanups.current.get(termId)
      if (cleanup) cleanup()
      useDockStore.getState().setTerminalClaudeTask(termId, null)
    }
    window.addEventListener('claude-task-cancelled', handler)
    return () => window.removeEventListener('claude-task-cancelled', handler)
  }, [])

  // Cleanup CI fix monitors on unmount
  useEffect(() => {
    return () => {
      for (const cleanup of ciFixCleanups.current.values()) cleanup()
      ciFixCleanups.current.clear()
    }
  }, [])

  const DEFAULT_FONT_SIZE = 14

  // Apply zoom: changes font size
  const applyZoom = useCallback((newSize: number) => {
    const size = Math.max(8, Math.min(32, newSize))
    const settings = useSettingsStore.getState().settings
    if (size === settings.terminal.fontSize) return

    useSettingsStore.getState().update({
      terminal: { ...settings.terminal, fontSize: size }
    })
  }, [])

  // Directional focus navigation — supports grid ↔ toolbar ↔ shell transitions
  const focusDirection = useCallback((direction: Direction) => {
    const state = useDockStore.getState()

    // If currently in toolbar, only down returns to the grid
    if (state.focusRegion === 'toolbar') {
      if (direction === 'down') {
        const maxCols = useSettingsStore.getState().settings.grid.maxColumns
        const { layout } = computeAutoLayout(state.terminals.map((t) => t.id), maxCols)
        const targetId = findTerminalFromToolbar(layout)
        if (targetId) {
          useDockStore.getState().setFocusedTerminal(targetId)
          window.dispatchEvent(new CustomEvent('refocus-terminal'))
        }
      }
      // Left/right/up are handled by the toolbar's own hook
      return
    }

    // If currently in a shell panel, navigate back to the terminal or to adjacent shell
    if (state.focusRegion === 'shell') {
      if (direction === 'up') {
        // Return focus to the parent terminal
        useDockStore.getState().setFocusRegion('grid')
        window.dispatchEvent(new CustomEvent('refocus-terminal'))
        return
      }
      if (direction === 'left' || direction === 'right') {
        // Navigate to adjacent terminal's shell (or terminal if no shell)
        const maxCols = useSettingsStore.getState().settings.grid.maxColumns
        const { layout } = computeAutoLayout(state.terminals.map((t) => t.id), maxCols)
        const targetId = findAdjacentTerminal(layout, state.focusedTerminalId!, direction)
        if (targetId && targetId !== TOOLBAR_FOCUS_ID) {
          useDockStore.getState().setFocusedTerminal(targetId)
          // Try to focus the target's shell; the shell listens and falls back to terminal
          setTimeout(() => window.dispatchEvent(new CustomEvent('focus-shell', { detail: { terminalId: targetId } })), 50)
        }
        return
      }
      // Down from shell — no-op (already at bottom)
      return
    }

    // Grid navigation
    if (!state.focusedTerminalId || state.terminals.length === 0) return
    const maxCols = useSettingsStore.getState().settings.grid.maxColumns
    const { layout } = computeAutoLayout(state.terminals.map((t) => t.id), maxCols)

    // Down from grid — if this terminal has an open shell, focus it
    if (direction === 'down') {
      const hasShell = document.querySelector(`[data-terminal-id="${state.focusedTerminalId}"] .shell-area`)
      if (hasShell) {
        useDockStore.getState().setFocusRegion('shell')
        window.dispatchEvent(new CustomEvent('focus-shell', { detail: { terminalId: state.focusedTerminalId } }))
        return
      }
    }

    const targetId = findAdjacentTerminal(layout, state.focusedTerminalId, direction)
    if (targetId === TOOLBAR_FOCUS_ID) {
      useDockStore.getState().setFocusRegion('toolbar')
    } else if (targetId) {
      useDockStore.getState().setFocusedTerminal(targetId)
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Check directional focus keybinds first
      const { keybindings } = useSettingsStore.getState().settings
      const directionMap: [string, Direction][] = [
        [keybindings.focusUp, 'up'],
        [keybindings.focusDown, 'down'],
        [keybindings.focusLeft, 'left'],
        [keybindings.focusRight, 'right']
      ]
      for (const [bind, dir] of directionMap) {
        if (matchesKeybind(e, bind)) {
          e.preventDefault()
          focusDirection(dir)
          return
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const currentSize = useSettingsStore.getState().settings.terminal.fontSize
        switch (e.key) {
          case '=':
          case '+':
            e.preventDefault()
            applyZoom(currentSize + 1)
            return
          case '-':
            e.preventDefault()
            applyZoom(currentSize - 1)
            return
          case '0':
            e.preventDefault()
            applyZoom(DEFAULT_FONT_SIZE)
            return
          case 't':
            e.preventDefault()
            handleAddTerminal()
            break
          case 'w':
            e.preventDefault()
            handleCloseFocused()
            break
          case ',':
            e.preventDefault()
            setShowSettings({})
            break
          case 'n':
            e.preventDefault()
            getDockApi().app.newDock()
            break
          case 'Tab':
            e.preventDefault()
            focusNextTerminal()
            break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusNextTerminal, applyZoom, focusDirection])

  // Ctrl+MouseWheel zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const currentSize = useSettingsStore.getState().settings.terminal.fontSize
      applyZoom(currentSize + (e.deltaY < 0 ? 1 : -1))
    }
    window.addEventListener('wheel', handler, { passive: false })
    return () => window.removeEventListener('wheel', handler)
  }, [applyZoom])

  const handleAddTerminal = useCallback(() => {
    const id = `term-${nextTermId++}-${Date.now()}`
    addTerminal(id)
  }, [addTerminal])

  const handleAddWorktreeTerminal = useCallback(() => {
    const id = `term-${nextTermId++}-${Date.now()}-wt`
    const store = useDockStore.getState()
    // Block PTY spawn until the user picks a branch from the popover.
    // The sentinel branch name is recognised by TerminalView's loading state.
    store.setPendingWorktree(id, '__awaiting__')
    store.markAutoOpenWorktree(id)
    addTerminal(id)
  }, [addTerminal])

  const handleRestoreLastClosed = useCallback(async () => {
    const sessionId = await getDockApi().terminal.popClosedSession()
    if (!sessionId) return
    const id = `term-${nextTermId++}-${Date.now()}`
    useDockStore.getState().setManualResumeId(id, sessionId)
    addTerminal(id)
  }, [addTerminal])

  const handleAddTerminalWithSession = useCallback((sessionId: string) => {
    const id = `term-${nextTermId++}-${Date.now()}`
    useDockStore.getState().setManualResumeId(id, sessionId)
    addTerminal(id)
  }, [addTerminal])

  const handleCloseFocused = useCallback(() => {
    const state = useDockStore.getState()
    if (!state.focusedTerminalId) return
    const taskType = state.claudeTaskTerminals.get(state.focusedTerminalId)
    if (taskType) {
      const labels: Record<string, string> = { 'ci-fix': 'a CI fix', 'write-tests': 'a Write Tests task', 'reference-this': 'a Reference This session' }
      const label = labels[taskType] || 'a Claude task'
      if (!window.confirm(`This terminal is running ${label}. Close it and cancel?`)) return
      window.dispatchEvent(new CustomEvent('claude-task-cancelled', { detail: state.focusedTerminalId }))
    }
    getDockApi().terminal.kill(state.focusedTerminalId)
    removeTerminal(state.focusedTerminalId)
  }, [removeTerminal])

  if (!initialized) {
    return <div className="loading">Loading...</div>
  }

  return (
    <div className="app">
      <Toolbar
        projectDir={projectDir}
        onAddTerminal={handleAddTerminal}
        onAddWorktreeTerminal={handleAddWorktreeTerminal}
        onRestoreLastClosed={handleRestoreLastClosed}
        onAddTerminalWithSession={handleAddTerminalWithSession}
        onOpenSettings={(opts) => setShowSettings(opts || {})}
        onOpenBugReport={() => setShowBugReport(true)}
      />
      {terminals.length === 0 ? (
        <EmptyState onAddTerminal={handleAddTerminal} projectDir={projectDir} />
      ) : (
        <DockPanelLayout>
          <DockGrid />
        </DockPanelLayout>
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} initialTab={(showSettings as any).tab} initialSection={(showSettings as any).section} initialPluginId={(showSettings as any).pluginId} />}
      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} />}
      {pendingTask && (
        <TerminalPicker
          taskLabel={getTaskMeta(pendingTask).label}
          defaultPermissions={getTaskMeta(pendingTask).defaultPermissions}
          onSelect={handleTaskTerminalSelected}
          onClose={() => setPendingTask(null)}
        />
      )}
    </div>
  )
}

const AVAILABLE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']
const PERMISSION_MODES: { value: import('../../shared/claude-task-types').PermissionMode; label: string }[] = [
  { value: 'default', label: 'Default (ask each time)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'bypassPermissions', label: 'Bypass all permissions' }
]

function TerminalPicker({ taskLabel, defaultPermissions, onSelect, onClose }: {
  taskLabel: string
  defaultPermissions: TaskPermissions
  onSelect: (terminalId: string | null, context: string, permissions: TaskPermissions, useSession: boolean) => void
  onClose: () => void
}) {
  const terminals = useDockStore((s) => s.terminals)
  const maxColumns = useSettingsStore((s) => s.settings.grid.maxColumns)
  const viewportMode = useSettingsStore((s) => s.settings.grid.viewportMode ?? 'auto')
  const [selected, setSelected] = useState<string | null>(null) // null = new terminal
  const [contextText, setContextText] = useState('')
  const [permMode, setPermMode] = useState(defaultPermissions.permissionMode)
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set(defaultPermissions.allowedTools))
  const [showPerms, setShowPerms] = useState(false)
  const [useSession, setUseSession] = useState(false)

  // Measure the real dock grid so the picker mini-map mirrors it.
  const [dockSize, setDockSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = document.querySelector('.dock-grid-container')
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setDockSize({ width: rect.width, height: rect.height })
      }
    }
  }, [])

  // Match the same orientation detection useGridLayout uses so the mini-map
  // reflects whichever mode the dock is currently in.
  const orientation: 'landscape' | 'portrait' = useMemo(() => {
    if (viewportMode === 'landscape') return 'landscape'
    if (viewportMode === 'portrait') return 'portrait'
    if (!dockSize) return 'landscape'
    return (dockSize.height > dockSize.width || dockSize.width < 500) ? 'portrait' : 'landscape'
  }, [viewportMode, dockSize])

  // Compute the layout exactly the way the dock does — including spanning
  // rules (e.g., 3-terminal layouts where one cell spans two rows). Custom
  // column/row ratios from manual resize aren't mirrored; the picker shows
  // default equal ratios.
  const { cols: gridCols, rows: gridRows, layout: miniLayout } = useMemo(() => {
    const ids = terminals.map((t) => t.id)
    const { cols, layout } = orientation === 'portrait'
      ? computePortraitLayout(ids)
      : computeAutoLayout(ids, maxColumns)
    const rows = layout.length > 0 ? Math.max(...layout.map((l) => l.y + l.h)) : 1
    return { cols, rows, layout }
  }, [terminals, orientation, maxColumns])

  // Pin the mini-map to a square bounding box so both orientations fit the
  // modal consistently. Landscape → wide & short, portrait → narrow & tall.
  const MINI_MAX = 300
  const { miniW, miniH } = useMemo(() => {
    const aspect = dockSize ? dockSize.width / Math.max(1, dockSize.height) : 16 / 9
    if (aspect >= 1) return { miniW: MINI_MAX, miniH: Math.max(80, Math.round(MINI_MAX / aspect)) }
    return { miniW: Math.max(80, Math.round(MINI_MAX * aspect)), miniH: MINI_MAX }
  }, [dockSize])

  const backdropRef = useRef<HTMLDivElement>(null)

  const toggleTool = useCallback((tool: string) => {
    setAllowedTools((prev) => {
      const next = new Set(prev)
      if (next.has(tool)) next.delete(tool)
      else next.add(tool)
      return next
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const perms: TaskPermissions = { allowedTools: Array.from(allowedTools), permissionMode: permMode }
    onSelect(selected, contextText, perms, useSession)
  }, [selected, contextText, allowedTools, permMode, useSession, onSelect])

  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault()
      e.stopPropagation()
      handleSubmit()
    }
  }, [handleSubmit, onClose])

  return (
    <div
      className="tp-backdrop"
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="tp-modal" onKeyDown={handleModalKeyDown}>
        <div className="tp-header">
          <span className="tp-title">{taskLabel} — Send to terminal</span>
          <button className="tp-close" onClick={onClose}>{'\u2715'}</button>
        </div>
        {terminals.length > 0 && (
          <div className="tp-grid" style={{ width: miniW, height: miniH }}>
            {miniLayout.map((l) => {
              const term = terminals.find((t) => t.id === l.i)
              if (!term) return null
              const isSelected = selected === term.id
              const isAlive = term.isAlive
              return (
                <button
                  key={term.id}
                  className={`tp-cell${isSelected ? ' tp-cell-selected' : ''}${!isAlive ? ' tp-cell-dead' : ''}`}
                  onClick={() => setSelected(term.id)}
                  disabled={!isAlive}
                  title={term.title || ''}
                  style={{
                    left: `${(l.x / gridCols) * 100}%`,
                    top: `${(l.y / gridRows) * 100}%`,
                    width: `${(l.w / gridCols) * 100}%`,
                    height: `${(l.h / gridRows) * 100}%`
                  }}
                >
                  <span className="tp-cell-num">{term.title?.replace(/\D/g, '') || '?'}</span>
                  <span className="tp-cell-label">{term.title || 'Terminal'}</span>
                </button>
              )
            })}
          </div>
        )}
        <div className="tp-new-row">
          <button
            className={`tp-cell tp-cell-new${selected === null ? ' tp-cell-selected' : ''}`}
            onClick={() => setSelected(null)}
            title="Create new terminal"
          >
            <span className="tp-cell-icon">+</span>
            <span className="tp-cell-label">New Terminal</span>
          </button>
        </div>
        <div className="tp-context">
          <textarea
            className="tp-context-input"
            placeholder="Optional instructions for Claude..."
            value={contextText}
            onChange={(e) => setContextText(e.target.value)}
            rows={2}
          />
        </div>
        {selected === null && (
          <div className="tp-perms">
            <label className="tp-session-toggle">
              <input type="checkbox" checked={useSession} onChange={() => setUseSession(!useSession)} />
              <span className="tp-session-text">
                Persistent session
                <span className="tp-session-hint">Uses --session-id so the terminal retains context across restarts</span>
              </span>
            </label>
            <button className="tp-perms-toggle" onClick={() => setShowPerms(!showPerms)}>
              <span className="tp-perms-chevron">{showPerms ? '\u25BC' : '\u25B6'}</span>
              Permissions
            </button>
            {showPerms && (
              <div className="tp-perms-body">
                <div className="tp-perms-row">
                  <label className="tp-perms-label">Mode</label>
                  <select
                    className="tp-perms-select"
                    value={permMode}
                    onChange={(e) => setPermMode(e.target.value as import('../../shared/claude-task-types').PermissionMode)}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className="tp-perms-row">
                  <label className="tp-perms-label">Allowed tools</label>
                  <div className="tp-perms-tools">
                    {AVAILABLE_TOOLS.map((tool) => (
                      <label key={tool} className="tp-perms-tool">
                        <input
                          type="checkbox"
                          checked={allowedTools.has(tool)}
                          onChange={() => toggleTool(tool)}
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="tp-footer">
          <button className="tp-cancel" onClick={onClose}>Cancel</button>
          <button className="tp-confirm" onClick={handleSubmit}>
            {selected === null ? 'Create & Send' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
