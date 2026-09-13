import type { PlatformControl } from './types'
import { DarwinPlatformControl } from './darwin'
import { WindowsPlatformControl } from './windows'

export type { PlatformControl, ToolResult, SystemStatusInfo } from './types'

let control: PlatformControl | null = null

/** Selects the adapter for the running OS. Unsupported platforms (Linux) throw at startup, not per-call. */
export function getPlatformControl(): PlatformControl {
  if (control) return control
  if (process.platform === 'darwin') control = new DarwinPlatformControl()
  else if (process.platform === 'win32') control = new WindowsPlatformControl()
  else throw new Error(`[jarvis] No platform adapter for "${process.platform}" — Windows and macOS only.`)
  return control
}
