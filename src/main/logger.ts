import { app } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'

function logFilePath(): string {
  return join(app.getPath('logs'), 'jarvis.log')
}

/**
 * Minimal file logger alongside the usual console output — a packaged
 * Windows build's console.log is invisible with no attached terminal, so
 * this is the actual way to diagnose a failure after the fact. Never logs
 * secret values. Best-effort: a logging failure must never break the app.
 */
function write(level: 'INFO' | 'ERROR', scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
  try {
    appendFileSync(logFilePath(), line + '\n', 'utf-8')
  } catch {
    // Best-effort — logging must never be the thing that crashes the app.
  }
}

export function logInfo(scope: string, message: string): void {
  write('INFO', scope, message)
}

export function logError(scope: string, message: string): void {
  write('ERROR', scope, message)
}

export function getLogFilePath(): string {
  return logFilePath()
}
