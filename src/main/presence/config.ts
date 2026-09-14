import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { logInfo } from '../logger'

export interface PresenceConfig {
  /** Master switch for the wake-word layer itself (independent of whether an AccessKey/engine is actually available). */
  enabled: boolean
  /** Whether JARVIS should start automatically with Windows, hidden, on next login — applied via app.setLoginItemSettings. */
  launchAtLogin: boolean
  /** 0-1 — higher catches more true wakes at the cost of more false ones. Editable live from the Presence panel; env var only seeds the first run. */
  sensitivity: number
  /** How many consecutive 80ms frames must clear the sensitivity threshold before a wake is reported — false-positive protection, also editable live. */
  consecutiveFrames: number
}

function defaultConfig(): PresenceConfig {
  const envSensitivity = process.env.JARVIS_WAKE_WORD_SENSITIVITY ? parseFloat(process.env.JARVIS_WAKE_WORD_SENSITIVITY) : NaN
  const envConsecutive = process.env.JARVIS_WAKE_WORD_CONSECUTIVE_FRAMES ? parseInt(process.env.JARVIS_WAKE_WORD_CONSECUTIVE_FRAMES, 10) : NaN
  return {
    enabled: process.env.JARVIS_PRESENCE_ENABLED !== 'false',
    launchAtLogin: process.env.JARVIS_LAUNCH_AT_LOGIN === 'true',
    sensitivity: Number.isFinite(envSensitivity) ? envSensitivity : 0.5,
    consecutiveFrames: Number.isFinite(envConsecutive) ? envConsecutive : 2
  }
}

function configFilePath(): string {
  return join(app.getPath('userData'), 'presence-config.json')
}

let cached: PresenceConfig | null = null

function load(): PresenceConfig {
  const defaults = defaultConfig()
  try {
    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8'))
    return { ...defaults, ...raw }
  } catch {
    return defaults
  }
}

function save(cfg: PresenceConfig): void {
  try {
    writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[jarvis] Failed to persist presence-config.json:', (err as Error).message)
  }
}

export function getPresenceConfig(): PresenceConfig {
  if (!cached) cached = load()
  return cached
}

export function updatePresenceConfig(patch: Partial<PresenceConfig>): PresenceConfig {
  cached = { ...getPresenceConfig(), ...patch }
  save(cached)
  logInfo('presence:config', `updated: ${JSON.stringify(patch)}`)
  return cached
}
