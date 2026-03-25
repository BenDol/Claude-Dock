#!/usr/bin/env node
/**
 * claude-dock MCP Server
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

// JSON-RPC helpers
function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
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
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-dock', version: '2.0.0' }
      })

    case 'notifications/initialized':
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
              }
            },
            required: ['command']
          }
        },
        {
          name: 'dock_read_shell',
          description:
            'Read the recent output from a Claude Dock shell panel. Use this after dock_run_in_shell ' +
            'to see the command output (test results, build output, etc.). Returns the last 100 lines ' +
            'of shell output for the specified session.',
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
          const { command, project_dir, session_id, submit, shell } = args
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
            // Write command to the shared file for the dock to pick up
            const entry = {
              id: crypto.randomUUID(),
              command,
              projectDir: resolvedProjectDir,
              sessionId: session_id || null,
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

            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `Command sent to dock shell: ${command}` }]
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
                sections.push(`  - ${shellId} (${lineCount} lines, updated ${ageStr})`)
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
          const { session_id, shell_id } = args
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
            const header = `Shell output from ${resolvedShellId} (${shellEntry.lines.length} lines, updated ${ageStr})${shellCount > 1 ? ` [${shellCount} shells available]` : ''}:`
            const output = shellEntry.lines.join('\n')
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `${header}\n\n${output}` }]
            })
          } catch (err) {
            return jsonRpcResponse(id, {
              content: [{ type: 'text', text: `No shell output available: ${err.message || err}` }]
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
