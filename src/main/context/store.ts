import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { defaultPersistentContext, type PersistentContext } from './types'

function contextFilePath(): string {
  return join(app.getPath('userData'), 'context.json')
}

export function loadPersistentContext(): PersistentContext {
  try {
    const raw = readFileSync(contextFilePath(), 'utf-8')
    return { ...defaultPersistentContext(), ...JSON.parse(raw) }
  } catch {
    return defaultPersistentContext()
  }
}

export function savePersistentContext(context: PersistentContext): void {
  try {
    writeFileSync(contextFilePath(), JSON.stringify(context, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[jarvis] Failed to persist context.json:', (err as Error).message)
  }
}
