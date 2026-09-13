import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import type { LocalHomeLocation } from './types'

/**
 * Precise home address support — LOCAL runtime configuration only. This
 * file lives in Electron's userData directory (e.g. ~/Library/Application
 * Support/jarvis on macOS, %APPDATA%/jarvis on Windows), which is entirely
 * outside the git repository, so there is no path by which a real street
 * address can end up committed. Never read/write this from anywhere that
 * touches source control.
 */
function localHomeFilePath(): string {
  return join(app.getPath('userData'), 'home-location.local.json')
}

export async function readLocalHomeLocation(): Promise<LocalHomeLocation | null> {
  try {
    const raw = await readFile(localHomeFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.label === 'string') return parsed as LocalHomeLocation
    return null
  } catch {
    return null // Not configured yet — callers fall back to the general location.
  }
}

export async function writeLocalHomeLocation(location: LocalHomeLocation): Promise<void> {
  await writeFile(localHomeFilePath(), JSON.stringify(location, null, 2), 'utf-8')
}
