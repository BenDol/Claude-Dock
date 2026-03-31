#!/usr/bin/env node
/**
 * claude-dock MCP Server — SOURCE OF TRUTH
 *
 * This is the canonical copy. The file at .claude/claude-dock-mcp.js is an
 * exported copy that gets bundled into the Electron app's resources/ at build
 * time and deployed alongside user projects. Keep both files in sync.
 *
 * Standalone MCP server (zero dependencies) that reads terminal activity
 * from Claude Dock's shared state file and exposes it via MCP tools.
 *
 * Tools:
 *   dock_status          — View what other terminals are working on + unread messages
 *   dock_run_in_shell    — Run a command in the dock's shell panel (opens it if closed)
 *   dock_read_shell      — Read recent output from a shell panel
 *   dock_list_shells     — List all open shell panels for a session (or all sessions)
 *   dock_send_message    — Send a message to another terminal (requires messaging enabled)
 *   dock_check_messages  — Check for messages sent to this terminal (requires messaging enabled)
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP stdio transport)
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const crypto = require('crypto')

// Resolve data directory
const dataDir =
  process.env.DOCK_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), 'claude-dock')
const activityFile = path.join(dataDir, 'dock-activity.json')
const configFile = path.join(dataDir, 'dock-config.json')
const messagesFile = path.join(dataDir, 'dock-messages.json')

const shellCommandsFile = path.join(dataDir, 'dock-shell-commands.json')
const shellOutputFile = path.join(dataDir, 'dock-shell-output.json')

const MESSAGE_TTL = 3600000 // 1 hour
const pendingEventsFile = path.join(dataDir, 'dock-pending-events.json')

// JSON-RPC helpers

/**
 * Build a JSON-RPC response, automatically appending any pending shell events.
 * Events are consumed (cleared) after being included in a response, so they
 * only appear once. This piggybacks on normal tool calls so Claude sees events
 * without needing to poll.
 */
function jsonRpcResponse(id, result) {
  // Append pending events to the response text
  const eventsSuffix = consumePendingEvents()
  if (eventsSuffix && result && result.content && result.content.length > 0) {
    const last = result.content[result.content.length - 1]
    if (last.type === 'text') {
      last.text += eventsSuffix
    }
  }
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

// ---------- Pending shell events ----------

function readPendingEvents() {
  try {
    const data = JSON.parse(fs.readFileSync(pendingEventsFile, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function clearPendingEvents() {
  try { fs.writeFileSync(pendingEventsFile, '[]') } catch { /* ignore */ }
}

/**
 * Read and clear all pending events. Returns a formatted string to append
 * to tool responses, or empty string if no events.
 */
function consumePendingEvents() {
  const events = readPendingEvents()
  if (events.length === 0) return ''
  clearPendingEvents()

  const lines = [`\n\n## Shell Events (${events.length} new)\n`]
  for (const e of events) {
    const shellShort = e.shellId ? e.shellId.split(':').pop() : '?'
    const time = new Date(e.timestamp).toLocaleTimeString()
    lines.push(`[${time}] [shell:${shellShort}] **${e.type}**: ${typeof e.payload === 'object' ? JSON.stringify(e.payload) : e.payload}`)
  }
  lines.push('')
  return lines.join('\n')
}

// Read files
function readActivity() {
  try {
    return JSON.parse(fs.readFileSync(activityFile, 'utf8'))
  } catch {
    return null
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch {
    return {}
  }
}

function isMessagingEnabled() {
  return readConfig().messagingEnabled === true
}

// Normalize path for comparison
function normalizePath(p) {
  if (!p) return ''
  const normalized = path.resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// ---------- Messages ----------

function readMessages() {
  try {
    return JSON.parse(fs.readFileSync(messagesFile, 'utf8'))
  } catch {
    return { messages: {} }
  }
}

function writeMessages(data) {
  const tmpFile = messagesFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2))
  fs.renameSync(tmpFile, messagesFile)
}

function pruneOldMessages(data) {
  const now = Date.now()
  for (const sessionId of Object.keys(data.messages)) {
    data.messages[sessionId] = data.messages[sessionId].filter(
      (m) => now - m.timestamp < MESSAGE_TTL
    )
    if (data.messages[sessionId].length === 0) {
      delete data.messages[sessionId]
    }
  }
}

/** Resolve a terminal by session ID prefix, full ID, or title */
function resolveTerminal(hint, projectDir) {
  const activity = readActivity()
  if (!activity || !activity.docks) return null

  const filterDir = projectDir ? normalizePath(projectDir) : null
  const lowerHint = hint.toLowerCase()

  for (const dock of Object.values(activity.docks)) {
    if (filterDir && normalizePath(dock.projectDir) !== filterDir) continue
    for (const term of dock.terminals || []) {
      if (!term.isAlive) continue
      if (term.sessionId === hint) return term
      if (term.sessionId && term.sessionId.startsWith(hint)) return term
      if (term.title && term.title.toLowerCase() === lowerHint) return term
      if (term.id && term.id.toLowerCase() === lowerHint) return term
    }
  }
  return null
}

function getUnreadMessages(sessionId) {
  const data = readMessages()
  pruneOldMessages(data)
  const msgs = data.messages[sessionId] || []
  return msgs.filter((m) => !m.read)
}

function formatMessages(msgs) {
  if (msgs.length === 0) return ''
  const lines = [`\n## Messages for you (${msgs.length} unread)\n`]
  for (const m of msgs) {
    const time = new Date(m.timestamp).toLocaleTimeString()
    const fromId = m.from ? m.from.slice(0, 8) : '?'
    lines.push(`[From ${m.fromTitle || 'Terminal'} (${fromId}) at ${time}]`)
    lines.push(`> ${m.text}`)
    lines.push('')
  }
  return lines.join('\n')
}

function markMessagesRead(sessionId) {
  const data = readMessages()
  pruneOldMessages(data)
  const msgs = data.messages[sessionId] || []
  let changed = false
  for (const m of msgs) {
    if (!m.read) {
      m.read = true
      changed = true
    }
  }
  if (changed) writeMessages(data)
}

// ---------- dock_status ----------

function readShellOutput() {
  try {
    return JSON.parse(fs.readFileSync(shellOutputFile, 'utf-8'))
  } catch {
    return {}
  }
}

function formatDockStatus(projectDir, sessionId) {
  const activity = readActivity()
  if (!activity || !activity.docks || Object.keys(activity.docks).length === 0) {
    return 'No active dock terminals found.'
  }

  const shellData = readShellOutput()
  const filterDir = projectDir ? normalizePath(projectDir) : null
  const sections = []

  for (const [dockId, dock] of Object.entries(activity.docks)) {
    if (!dock.terminals || dock.terminals.length === 0) continue
    if (filterDir && normalizePath(dock.projectDir) !== filterDir) continue

    const projectName = path.basename(dock.projectDir || 'unknown')
    sections.push(`## Dock: ${projectName} (${dock.projectDir})`)

    for (const term of dock.terminals) {
      const status = term.isAlive ? 'Active' : 'Exited'
      const age = term.lastUpdate ? Math.round((Date.now() - term.lastUpdate) / 1000) : null
      const ageStr = age !== null ? ` (${age}s ago)` : ''
      const sessionStr = term.sessionId ? ` [session ${term.sessionId.slice(0, 8)}]` : ''

      sections.push(`### ${term.title}${sessionStr} — ${status}${ageStr}`)

      if (term.recentLines && term.recentLines.length > 0) {
        sections.push('```')
        sections.push(term.recentLines.join('\n'))
        sections.push('```')
      } else {
        sections.push('(no recent output)')
      }

      // Include shell panel info if available
      const shellEntry = term.sessionId ? shellData[term.sessionId] : null
      if (shellEntry && shellEntry.shells) {
        const shellIds = Object.keys(shellEntry.shells)
        if (shellIds.length > 0) {
          sections.push(`**Shell panels (${shellIds.length}):** ${shellIds.join(', ')}`)
        }
      }
      sections.push('')
    }
  }

  if (sections.length === 0) {
    return filterDir
      ? 'No active dock terminals found for this project.'
      : 'No active dock terminals found.'
  }

  let result = sections.join('\n')

  // Append unread messages if messaging enabled and session_id provided
  if (sessionId && isMessagingEnabled()) {
    const unread = getUnreadMessages(sessionId)
    if (unread.length > 0) {
      result += formatMessages(unread)
      markMessagesRead(sessionId)
    }
  }

  return result
}

// ---------- MCP message handlers ----------

function handleMessage(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          experimental: { 'claude/channel': {} }
        },
        serverInfo: { name: 'claude-dock', version: '2.0.0' },
        instructions: 'Shell events from Dock arrive as channel notifications. React to them (e.g. exception_detected, server_stopped, compile_error) by investigating and helping the user.'
      })

    case 'notifications/initialized':
      startEventWatcher()
      return null

    case 'tools/list': {
      const tools = [
        {
          name: 'dock_status',
          description:
            'Get a summary of what other Claude Dock terminals are currently working on. ' +
            'Use this at the start of a task when the .linked file exists in the project root ' +
            'to coordinate with other terminals and avoid conflicts. ' +
            "Pass project_dir to filter results and session_id to also receive messages.",
          inputSchema: {
            type: 'object',
            properties: {
              project_dir: {
                type: 'string',
                description: 'Absolute path to the project directory. Filters results to only show terminals from this project.'
              },
              session_id: {
                type: 'string',
                description: 'Your session ID. When provided, unread messages for you are appended to the output.'
              }
            },
            required: []
          }
        },
        {
          name: 'dock_run_in_shell',
          description:
            'Run a command in the Claude Dock shell panel. The shell panel is a separate terminal ' +
            'embedded in the dock window — use it for running tests, builds, git commands, or any ' +
            'shell operation without interrupting your current conversation. The shell panel opens ' +
            'automatically if not already open. The command runs in the project directory.',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'The shell command to execute (e.g. "npm test", "git status", "make build")'
              },
              project_dir: {
                type: 'string',
                description: 'Absolute path to the project directory. Used to route the command to the correct dock window.'
              },
              session_id: {
                type: 'string',
                description: 'Your session ID. Routes the command to the shell panel of the specific terminal running this session.'
              },
              submit: {
                type: 'boolean',
                description: 'Whether to press Enter after typing the command. Default: true.'
              },
              shell: {
                type: 'string',
                enum: ['default', 'bash', 'cmd', 'powershell', 'pwsh'],
                description: 'Shell type to use. Use "bash" for bash/shell scripts, "cmd" for Windows batch, "powershell"/"pwsh" for PowerShell scripts. Default: uses the user\'s configured shell.'
              },
              shell_id: {
                type: 'string',
                description: 'Target a specific shell panel by ID (e.g. "shell:term-1-123:0"). Special values: omit/null = open a NEW shell panel; "-1" = use the first existing shell (default/reuse). Use dock_list_shells to discover available shell IDs.'
              },
              shell_layout: {
                type: 'string',
                enum: ['split', 'stack'],
                description: 'Layout for new shell panels (only applies when shell_id is omitted). "split" = new column to the right (horizontal), "stack" = below in same column (vertical). Default: "stack".'
              }
            },
            required: ['command']
          }
        },
        {
          name: 'dock_read_shell',
          description:
            'Read the recent output from a Claude Dock shell panel. Use this after dock_run_in_shell ' +
            'to see the command output (test results, build output, etc.). Returns the last N lines ' +
            'of shell output for the specified session (default 200).',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'Your session ID. Reads the shell panel output associated with this terminal session.'
              },
              shell_id: {
                type: 'string',
                description: 'Specific shell panel ID to read (e.g. "shell:term-1-123:0"). If not provided, reads the first (default) shell panel.'
              },
              lines: {
                type: 'number',
                description: 'Number of lines to return from the end of the output. Default: 200. Max: 500.'
              }
            },
            required: ['session_id']
          }
        },
        {
          name: 'dock_list_shells',
          description:
            'List all open shell panels for a session (or all sessions). Returns shell IDs, ' +
            'line counts, and last update times. Use this to discover available shells before ' +
            'reading their output with dock_read_shell.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'Your session ID. If provided, only lists shells for this session. If omitted, lists all sessions and their shells.'
              }
            },
            required: []
          }
        },
        {
          name: 'dock_check_shell_events',
          description:
            'Check for structured events emitted by scripts running in the Dock shell panel. ' +
            'Events are embedded as ##DOCK_EVENT:type:payload## markers in the shell output. ' +
            'Use this to detect compile errors, hot swap results, server start/stop events, etc. ' +
            'Returns only events, not the full shell output.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: {
                type: 'string',
                description: 'Your session ID to check events for.'
              },
              shell_id: {
                type: 'string',
                description: 'Target shell panel ID. If omitted, uses the default (first) shell.'
              },
              last_n: {
                type: 'number',
                description: 'Only scan the last N lines of output for events. Default: 50.'
              }
            },
            required: ['session_id']
          }
        }
      ]

      if (isMessagingEnabled()) {
        tools.push(
          {
            name: 'dock_send_message',
            description:
              'Send a message to another Claude Dock terminal. Use this to coordinate work, ' +
              'warn about file conflicts, or request information from another terminal. ' +
              'The recipient will see the message next time they call dock_status or dock_check_messages.',
            inputSchema: {
              type: 'object',
              properties: {
                from_session_id: {
                  type: 'string',
                  description: 'Your session ID.'
                },
                to: {
                  type: 'string',
                  description: 'Recipient: session ID (or prefix), or terminal title.'
                },
                message: {
                  type: 'string',
                  description: 'The message to send.'
                },
                project_dir: {
                  type: 'string',
                  description: 'Optional. Project directory to scope recipient lookup.'
                }
              },
              required: ['from_session_id', 'to', 'message']
            }
          },
          {
            name: 'dock_check_messages',
            description:
              'Check for messages sent to this terminal by other Claude Dock terminals. ' +
              'Returns unread messages and marks them as read.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: {
                  type: 'string',
                  description: 'Your session ID to check messages for.'
                },
                mark_read: {
                  type: 'boolean',
                  description: 'Whether to mark retrieved messages as read. Default: true.'
                }
              },
              required: ['session_id']
            }
          }
        )
      }

      return jsonRpcResponse(id, { tools })
    }

    case 'tools/call': {
      const toolName = params?.name
      const args = params?.arguments || {}

      switch (toolName) {
        case 'dock_status': {
          const status = formatDockStatus(args.project_dir || null, args.session_id || null)
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: status }]
          })
        }

        case 'dock_run_in_shell': {
          const { command, project_dir, session_id, submit, shell, shell_id, shell_layout } = args
          if (!command) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Missing required parameter: command.' }]
            })
          }

          // Resolve projectDir from session_id if not provided
          let resolvedProjectDir = project_dir || null
          if (!resolvedProjectDir && session_id) {
            const term = resolveTerminal(session_id, null)
            if (term && term.projectDir) resolvedProjectDir = term.projectDir
          }

          try {
            // shell_id behavior:
            //   null/omitted = open a NEW shell panel
            //   "-1"         = reuse the first existing shell (default panel)
            //   "<id>"       = target a specific shell panel by ID
            const useFirstShell = shell_id === '-1'
            const resolvedCommandShellId = useFirstShell ? null : (shell_id || null)

            // Write command to the shared file for the dock to pick up
            const entry = {
              id: crypto.randomUUID(),
              command,
              projectDir: resolvedProjectDir,
              sessionId: session_id || null,
              // null = new panel (renderer creates one), "__first__" = use default shell:0
              shellId: useFirstShell ? '__first__' : (shell_id || null),
              shellLayout: shell_layout || null, // 'split' or 'stack', null = default (stack)
              submit: submit !== false, // default true
              shell: shell || null, // null = use configured default
              timestamp: Date.now()
            }

            let commands = []
            try {
              commands = JSON.parse(fs.readFileSync(shellCommandsFile, 'utf-8'))
              if (!Array.isArray(commands)) commands = []
            } catch { /* file doesn't exist yet */ }

            // Prune old commands (> 30 seconds) to prevent stale buildup
            const cutoff = Date.now() - 30000
            commands = commands.filter(c => c.timestamp > cutoff)
            commands.push(entry)

            fs.writeFileSync(shellCommandsFile, JSON.stringify(commands, null, 2))

            // Resolve the shell ID and log file path for the response.
            // Check if the shell exists and is still active (updated recently).
            let resolvedShellId = resolvedCommandShellId
            let logFile = null
            let shellActive = false
            const creatingNewShell = !shell_id
            if (session_id) {
              try {
                const shellData = JSON.parse(fs.readFileSync(shellOutputFile, 'utf-8'))
                const sessionEntry = shellData[session_id] || Object.values(shellData).find(e => e.sessionId && e.sessionId.startsWith(session_id))
                if (sessionEntry && sessionEntry.shells) {
                  const shellIds = Object.keys(sessionEntry.shells).sort()
                  // For -1 (first shell), resolve to the first known shell
                  if (useFirstShell && !resolvedShellId) resolvedShellId = shellIds[0] || null
                  if (resolvedShellId && sessionEntry.shells[resolvedShellId]) {
                    logFile = sessionEntry.shells[resolvedShellId].logFile || null
                    const ageMs = Date.now() - (sessionEntry.shells[resolvedShellId].lastUpdate || 0)
                    shellActive = ageMs < 5 * 60 * 1000
                  }
                }
              } catch { /* shell output file may not exist yet */ }
            }

            const parts = [`Command sent to dock shell: ${command}`]
            if (resolvedShellId) {
              parts.push(`Shell ID: ${resolvedShellId}`)
              parts.push(`Shell status: ${shellActive ? 'active' : 'stale (may reopen)'}`)
            } else if (creatingNewShell) {
              parts.push('Opening new shell panel (no shell_id specified).')
            }
            if (logFile) {
              parts.push(`Output log: ${logFile}`)
              parts.push('You can read the shell output using the Read tool on the log file path, or use dock_read_shell with your session_id.')
            } else {
              parts.push('The shell panel will open automatically. Use dock_list_shells to discover the new shell ID, then dock_read_shell to read its output.')
            }

            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: parts.join('\n') }]
            })
          } catch (err) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `Failed to send command to dock shell: ${err.message || err}` }],
              isError: true
            })
          }
        }

        case 'dock_list_shells': {
          const { session_id } = args
          try {
            const data = readShellOutput()
            if (Object.keys(data).length === 0) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: 'No shell panels are currently open.' }]
              })
            }

            const sections = []

            for (const [sid, entry] of Object.entries(data)) {
              // Filter by session_id if provided
              if (session_id && sid !== session_id && !sid.startsWith(session_id)) continue

              const shells = entry.shells || {}
              const shellIds = Object.keys(shells)
              if (shellIds.length === 0) continue

              sections.push(`Session ${sid.slice(0, 8)} (${entry.projectDir ? path.basename(entry.projectDir) : 'unknown'}):`)
              for (const shellId of shellIds.sort()) {
                const shell = shells[shellId]
                const lineCount = shell.lines ? shell.lines.length : 0
                const age = Date.now() - (shell.lastUpdate || 0)
                const ageStr = age < 5000 ? 'just now' : age < 60000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60000)}m ago`
                const logPath = shell.logFile ? `  Log: ${shell.logFile}` : ''
                sections.push(`  - ${shellId} (${lineCount} lines, updated ${ageStr})${logPath}`)
              }
              sections.push('')
            }

            if (sections.length === 0) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: session_id ? 'No shell panels open for this session.' : 'No shell panels are currently open.' }]
              })
            }

            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: sections.join('\n') }]
            })
          } catch (err) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `Failed to list shells: ${err.message || err}` }]
            })
          }
        }

        case 'dock_read_shell': {
          const { session_id, shell_id, lines: maxLines } = args
          const lineCount = Math.min(Math.max(1, parseInt(maxLines) || 200), 500)
          if (!session_id) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Missing required parameter: session_id.' }]
            })
          }

          try {
            const data = JSON.parse(fs.readFileSync(shellOutputFile, 'utf-8'))
            // Find session by exact match or prefix match
            let entry = data[session_id]
            if (!entry) {
              for (const key of Object.keys(data)) {
                if (key.startsWith(session_id)) { entry = data[key]; break }
              }
            }

            if (!entry || !entry.shells || Object.keys(entry.shells).length === 0) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: 'No shell output available. The shell panel may not have been opened yet, or no commands have been run.' }]
              })
            }

            // If shell_id is specified, read that specific shell; otherwise read the first one
            let shellEntry
            let resolvedShellId
            if (shell_id) {
              shellEntry = entry.shells[shell_id]
              resolvedShellId = shell_id
              if (!shellEntry) {
                // Try partial match
                for (const sid of Object.keys(entry.shells)) {
                  if (sid.includes(shell_id)) { shellEntry = entry.shells[sid]; resolvedShellId = sid; break }
                }
              }
            } else {
              // Default to first shell (typically shell:term-X:0)
              const shellIds = Object.keys(entry.shells).sort()
              resolvedShellId = shellIds[0]
              shellEntry = entry.shells[resolvedShellId]
            }

            if (!shellEntry || !shellEntry.lines || shellEntry.lines.length === 0) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: `No output from shell ${resolvedShellId || '(unknown)'}. The shell may still be starting or the command hasn't produced output yet.` }]
              })
            }

            const age = Date.now() - (shellEntry.lastUpdate || 0)
            const ageStr = age < 5000 ? 'just now' : age < 60000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60000)}m ago`
            const shellCount = Object.keys(entry.shells).length
            const totalLines = shellEntry.lines.length
            const displayLines = shellEntry.lines.slice(-lineCount)
            const truncated = totalLines > lineCount ? ` (showing last ${lineCount} of ${totalLines})` : ''
            const logFilePath = shellEntry.logFile || null
            const header = `Shell output from ${resolvedShellId} (${displayLines.length} lines${truncated}, updated ${ageStr})${shellCount > 1 ? ` [${shellCount} shells available]` : ''}:`
            const logHint = logFilePath ? `\nLog file: ${logFilePath}` : ''
            const output = displayLines.join('\n')
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `${header}${logHint}\n\n${output}` }]
            })
          } catch (err) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `No shell output available: ${err.message || err}` }]
            })
          }
        }

        case 'dock_check_shell_events': {
          const { session_id, shell_id, last_n } = args
          if (!session_id) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Missing required parameter: session_id.' }]
            })
          }

          try {
            const data = readShellOutput()
            const sessionEntry = data[session_id] || data[Object.keys(data).find(k => k.startsWith(session_id)) || '']
            if (!sessionEntry || !sessionEntry.shells) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: 'No shell output found for this session.' }]
              })
            }

            // Resolve shell ID
            const shellIds = Object.keys(sessionEntry.shells).sort()
            const targetShellId = shell_id || shellIds[shellIds.length - 1] || null
            if (!targetShellId || !sessionEntry.shells[targetShellId]) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: `Shell ${shell_id || '(default)'} not found. Available: ${shellIds.join(', ')}` }]
              })
            }

            // Read log file for this shell
            const logFile = sessionEntry.shells[targetShellId].logFile
            if (!logFile) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: 'No log file available for this shell.' }]
              })
            }

            const logContent = fs.readFileSync(logFile, 'utf8')
            const lines = logContent.split('\n')
            const scanLines = lines.slice(-(last_n || 50))

            // Parse ##DOCK_EVENT:type:payload## markers
            // Join lines before scanning — terminal line-wrap can split events across lines
            const eventPattern = /##DOCK_EVENT:([^:]+):(.+?)##/g
            const events = []
            const joined = scanLines.join('')
            let evMatch
            while ((evMatch = eventPattern.exec(joined)) !== null) {
              try {
                events.push({ type: evMatch[1], payload: JSON.parse(evMatch[2]) })
              } catch {
                events.push({ type: evMatch[1], payload: evMatch[2] })
              }
            }

            if (events.length === 0) {
              return jsonRpcResponse(id, {
                content: [{ type: 'text', text: 'No events found in recent shell output.' }]
              })
            }

            const formatted = events.map(e => `[${e.type}] ${JSON.stringify(e.payload)}`).join('\n')
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `Found ${events.length} event(s):\n${formatted}` }]
            })
          } catch (err) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `Failed to check shell events: ${err.message || err}` }]
            })
          }
        }

        case 'dock_send_message': {
          if (!isMessagingEnabled()) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Messaging is disabled in Dock settings.' }]
            })
          }

          const { from_session_id, to, message: msgText, project_dir } = args
          if (!from_session_id || !to || !msgText) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Missing required parameters: from_session_id, to, message.' }]
            })
          }

          const recipient = resolveTerminal(to, project_dir)
          if (!recipient || !recipient.sessionId) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `Could not find active terminal matching "${to}".` }]
            })
          }

          // Look up sender title
          const sender = resolveTerminal(from_session_id, project_dir)
          const fromTitle = sender?.title || 'Terminal'

          const data = readMessages()
          pruneOldMessages(data)
          if (!data.messages[recipient.sessionId]) {
            data.messages[recipient.sessionId] = []
          }
          data.messages[recipient.sessionId].push({
            id: crypto.randomUUID(),
            from: from_session_id,
            fromTitle,
            to: recipient.sessionId,
            text: msgText,
            timestamp: Date.now(),
            read: false
          })
          writeMessages(data)

          const recipientLabel = `${recipient.title || 'Terminal'} (${recipient.sessionId.slice(0, 8)})`
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: `Message sent to ${recipientLabel}.` }]
          })
        }

        case 'dock_check_messages': {
          if (!isMessagingEnabled()) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'No messages (messaging disabled).' }]
            })
          }

          const { session_id, mark_read } = args
          if (!session_id) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Missing required parameter: session_id.' }]
            })
          }

          const unread = getUnreadMessages(session_id)
          if (unread.length === 0) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: 'No unread messages.' }]
            })
          }

          const formatted = formatMessages(unread)
          if (mark_read !== false) {
            markMessagesRead(session_id)
          }

          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: formatted }]
          })
        }

        default:
          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`)
      }
    }

    case 'ping':
      return jsonRpcResponse(id, {})

    default:
      if (id !== undefined) {
        return jsonRpcError(id, -32601, `Method not found: ${method}`)
      }
      return null
  }
}

// ---------- Active event push via channel notifications ----------

let eventWatcher = null
let lastEventCount = 0

/**
 * Watch dock-pending-events.json for new events and push them to Claude
 * via notifications/claude/channel so Claude reacts without needing to poll.
 */
function startEventWatcher() {
  if (eventWatcher) return
  // Seed initial count so we don't push stale events on startup
  lastEventCount = readPendingEvents().length

  // Poll the file every 2 seconds (fs.watch is unreliable on Windows for atomic writes)
  eventWatcher = setInterval(() => {
    try {
      const events = readPendingEvents()
      if (events.length <= lastEventCount) {
        lastEventCount = events.length
        return
      }
      const newEvents = events.slice(lastEventCount)
      lastEventCount = events.length

      // Format and push each event as a channel notification
      const lines = []
      for (const e of newEvents) {
        const shellShort = e.shellId ? e.shellId.split(':').pop() : '?'
        const time = new Date(e.timestamp).toLocaleTimeString()
        const payload = typeof e.payload === 'object' ? JSON.stringify(e.payload) : e.payload
        lines.push(`[${time}] [shell:${shellShort}] **${e.type}**: ${payload}`)
      }

      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: `## Shell Events (${newEvents.length} new)\n${lines.join('\n')}`,
          meta: {
            event_count: String(newEvents.length),
            event_types: [...new Set(newEvents.map(e => e.type))].join(',')
          }
        }
      })
      process.stdout.write(notification + '\n')

      // Clear consumed events
      clearPendingEvents()
      lastEventCount = 0
    } catch { /* ignore polling errors */ }
  }, 2000)
}

// Stdio transport
const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  line = line.trim()
  if (!line) return

  try {
    const msg = JSON.parse(line)
    const response = handleMessage(msg)
    if (response) {
      process.stdout.write(response + '\n')
    }
  } catch (err) {
    process.stdout.write(jsonRpcError(null, -32700, 'Parse error') + '\n')
  }
})

process.stdin.resume()
