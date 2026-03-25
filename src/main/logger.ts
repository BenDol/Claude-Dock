import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

let logStream: fs.WriteStream | null = null
let debugEnabled = false

const MAX_LOG_FILES = 5

export function initLogger(debug: boolean): void {
  debugEnabled = debug

  // Always open a log file for errors; debug controls verbose logging
  const logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })

  // Rotate: keep only the last N log files
  try {
    const files = fs.readdirSync(logDir)
      .filter((f) => f.startsWith('dock-') && f.endsWith('.log'))
      .sort()
    while (files.length >= MAX_LOG_FILES) {
      const old = files.shift()!
      fs.unlinkSync(path.join(logDir, old))
    }
  } catch {
    // best-effort rotation
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logDir, `dock-${ts}.log`)
  logStream = fs.createWriteStream(logPath, { flags: 'a' })

  log('Logger initialized', `debug=${debug}`, `version=${app.getVersion()}`, `platform=${process.platform}`)
}

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled
}

export function isDebug(): boolean {
  return debugEnabled
}

// Lazy import to avoid circular dependency (crash-reporter imports logger)
let _feedLogLine: ((line: string) => void) | null = null
function feedCrashReporter(line: string): void {
  if (!_feedLogLine) {
    try { _feedLogLine = require('./crash-reporter').feedLogLine } catch { _feedLogLine = () => {} }
  }
  _feedLogLine!(line)
}

function write(level: string, args: unknown[]): void {
  const timestamp = new Date().toISOString()
  const parts = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack || a.message
    try { return JSON.stringify(a) } catch { return String(a) }
  })
  const line = `[${timestamp}] [${level}] ${parts.join(' ')}\n`
  logStream?.write(line)
  // Feed to crash reporter for recent-log context
  feedCrashReporter(line.trimEnd())
  if (level === 'ERROR') {
    process.stderr.write(line)
  } else if (debugEnabled) {
    process.stdout.write(line)
  }
}

/** Debug log — only writes when debug mode is enabled */
export function log(...args: unknown[]): void {
  if (!debugEnabled) return
  write('DEBUG', args)
}

/** Always logged regardless of debug toggle */
export function logInfo(...args: unknown[]): void {
  write('INFO', args)
}

/** Always logged regardless of debug toggle */
export function logError(...args: unknown[]): void {
  write('ERROR', args)
}

export function getLogDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}
