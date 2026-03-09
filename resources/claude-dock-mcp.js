#!/usr/bin/env node
/**
 * claude-dock MCP Server
 *
 * Standalone MCP server (zero dependencies) that reads terminal activity
 * from Claude Dock's shared state file and exposes it via the dock_status tool.
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP stdio transport)
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')

// Resolve activity file path
const dataDir =
  process.env.DOCK_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), 'claude-dock')
const activityFile = path.join(dataDir, 'dock-activity.json')

// JSON-RPC helpers
function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

// Read current dock activity
function readActivity() {
  try {
    const raw = fs.readFileSync(activityFile, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Normalize path for comparison (lowercase on Windows, forward slashes)
function normalizePath(p) {
  if (!p) return ''
  const normalized = path.resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// Format activity into a readable summary, optionally filtered to a specific project
function formatDockStatus(projectDir) {
  const activity = readActivity()
  if (!activity || !activity.docks || Object.keys(activity.docks).length === 0) {
    return 'No active dock terminals found.'
  }

  const filterDir = projectDir ? normalizePath(projectDir) : null
  const sections = []

  for (const [dockId, dock] of Object.entries(activity.docks)) {
    if (!dock.terminals || dock.terminals.length === 0) continue

    // Filter by project directory if specified
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
      sections.push('')
    }
  }

  if (sections.length === 0) {
    return filterDir
      ? 'No active dock terminals found for this project.'
      : 'No active dock terminals found.'
  }

  return sections.join('\n')
}

// MCP message handlers
function handleMessage(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-dock', version: '1.0.0' }
      })

    case 'notifications/initialized':
      // Client notification, no response needed
      return null

    case 'tools/list':
      return jsonRpcResponse(id, {
        tools: [
          {
            name: 'dock_status',
            description:
              'Get a summary of what other Claude Dock terminals are currently working on. ' +
              'Use this at the start of a task when the .linked file exists in the project root ' +
              'to coordinate with other terminals and avoid conflicts. ' +
              'Pass project_dir to filter results to only your project\'s terminals.',
            inputSchema: {
              type: 'object',
              properties: {
                project_dir: {
                  type: 'string',
                  description: 'Absolute path to the project directory. Filters results to only show terminals from this project.'
                }
              },
              required: []
            }
          }
        ]
      })

    case 'tools/call': {
      const toolName = params?.name
      if (toolName === 'dock_status') {
        const projectDir = params?.arguments?.project_dir || null
        const status = formatDockStatus(projectDir)
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: status }]
        })
      }
      return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`)
    }

    case 'ping':
      return jsonRpcResponse(id, {})

    default:
      // Ignore unknown notifications (no id = notification)
      if (id !== undefined) {
        return jsonRpcError(id, -32601, `Method not found: ${method}`)
      }
      return null
  }
}

// Stdio transport: read newline-delimited JSON from stdin
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
    // Malformed JSON — send parse error if we can extract an id
    process.stdout.write(jsonRpcError(null, -32700, 'Parse error') + '\n')
  }
})

// Keep process alive
process.stdin.resume()
