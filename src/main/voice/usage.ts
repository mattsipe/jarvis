import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

interface UsageData {
  sttSecondsTotal: number
  ttsCharsTotal: number
  sessionCount: number
  since: string
}

function usageFilePath(): string {
  return join(app.getPath('userData'), 'usage.json')
}

function defaultUsage(): UsageData {
  return { sttSecondsTotal: 0, ttsCharsTotal: 0, sessionCount: 0, since: new Date().toISOString() }
}

function loadUsage(): UsageData {
  try {
    return { ...defaultUsage(), ...JSON.parse(readFileSync(usageFilePath(), 'utf-8')) }
  } catch {
    return defaultUsage()
  }
}

const SAVE_DEBOUNCE_MS = 2000

/**
 * Persistent counters for the two metered voice services, so "how much
 * Deepgram/ElevenLabs have I actually used" survives restarts — see the
 * plan's API-safeguards priority. This is a coarse running total, not a
 * billing-accurate ledger; good enough to catch a runaway loop or a
 * surprising bill before either happens.
 */
class UsageTracker {
  private data = loadUsage()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private sttStreamStartedAt: number | null = null

  startSttStream(): void {
    this.sttStreamStartedAt = Date.now()
  }

  stopSttStream(): void {
    if (this.sttStreamStartedAt == null) return
    this.data.sttSecondsTotal += (Date.now() - this.sttStreamStartedAt) / 1000
    this.sttStreamStartedAt = null
    this.scheduleSave()
  }

  addTtsChars(count: number): void {
    this.data.ttsCharsTotal += count
    this.scheduleSave()
  }

  recordSessionStart(): void {
    this.data.sessionCount += 1
    this.scheduleSave()
  }

  snapshot(): UsageData {
    return { ...this.data }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      try {
        writeFileSync(usageFilePath(), JSON.stringify(this.data, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[jarvis] Failed to persist usage.json:', (err as Error).message)
      }
      this.saveTimer = null
    }, SAVE_DEBOUNCE_MS)
  }
}

export const usage = new UsageTracker()
