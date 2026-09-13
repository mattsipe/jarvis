import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import {
  type UsageFile,
  type PeriodUsage,
  emptyUsageFile,
  emptyPeriodUsage,
  dailyKey,
  monthlyKey,
  addAnthropicUsage,
  addDeepgramSeconds,
  addElevenLabsChars,
  pruneOldDaily
} from './model'
import { loadPricingConfig, estimateCostUsd } from './pricing'
import { logInfo } from '../logger'

function usageFilePath(): string {
  return join(app.getPath('userData'), 'usage.json')
}

const SAVE_DEBOUNCE_MS = 2000

/** Shape of the pre-v2 usage.json (see the old voice/usage.ts) — folded into allTime on first load so a restart doesn't lose Weston's running totals. */
interface LegacyUsageFile {
  sttSecondsTotal?: number
  ttsCharsTotal?: number
  sessionCount?: number
  since?: string
}

function isLegacy(parsed: unknown): parsed is LegacyUsageFile {
  return typeof parsed === 'object' && parsed !== null && !('version' in parsed)
}

function loadUsageFile(): UsageFile {
  try {
    const raw = JSON.parse(readFileSync(usageFilePath(), 'utf-8'))
    if (isLegacy(raw)) {
      const file = emptyUsageFile(raw.since ?? new Date().toISOString())
      file.allTime.deepgramSeconds = raw.sttSecondsTotal ?? 0
      file.allTime.elevenLabsChars = raw.ttsCharsTotal ?? 0
      file.allTime.sessionCount = raw.sessionCount ?? 0
      logInfo('usage', 'migrated legacy usage.json (STT seconds/TTS chars/session count) into the new per-provider ledger — daily/monthly history starts fresh from today.')
      return file
    }
    if (raw.version === 2) return raw as UsageFile
    return emptyUsageFile()
  } catch {
    return emptyUsageFile()
  }
}

export interface ModelUsageSnapshot {
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requestCount: number
  estimatedCostUsd: number
}

export interface PeriodSnapshot {
  anthropicByModel: ModelUsageSnapshot[]
  deepgramSeconds: number
  elevenLabsChars: number
  sessionCount: number
  estimatedCostUsd: number
}

export interface UsageSnapshot {
  since: string
  today: PeriodSnapshot
  thisMonth: PeriodSnapshot
  allTime: PeriodSnapshot
}

function snapshotPeriod(period: PeriodUsage): PeriodSnapshot {
  const pricing = loadPricingConfig()
  const anthropicByModel = Object.entries(period.anthropic).map(([model, u]) => {
    const single: PeriodUsage = { ...emptyPeriodUsage(), anthropic: { [model]: u } }
    return { model, ...u, estimatedCostUsd: estimateCostUsd(single, pricing) }
  })
  return {
    anthropicByModel,
    deepgramSeconds: period.deepgramSeconds,
    elevenLabsChars: period.elevenLabsChars,
    sessionCount: period.sessionCount,
    estimatedCostUsd: estimateCostUsd(period, pricing)
  }
}

/**
 * Centralized usage ledger for every metered API JARVIS calls — Anthropic
 * tokens by model (with cache read/write broken out, since cached tokens
 * are billed at a different rate), Deepgram streaming seconds, and
 * ElevenLabs characters. Replaces the old voice/usage.ts running-total-only
 * tracker: this one keeps daily and monthly rollups (so "today" and "this
 * month" are real answers, not just "since the app was installed"), and is
 * the single source budgetManager.ts reads from to decide when to warn or
 * cut off nonessential calls.
 */
class UsageTracker {
  private data = loadUsageFile()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private sttStreamStartedAt: number | null = null

  private periodsFor(now = new Date()): { daily: PeriodUsage; monthly: PeriodUsage } {
    const dKey = dailyKey(now)
    const mKey = monthlyKey(now)
    if (!this.data.daily[dKey]) this.data.daily[dKey] = emptyPeriodUsage()
    if (!this.data.monthly[mKey]) this.data.monthly[mKey] = emptyPeriodUsage()
    return { daily: this.data.daily[dKey], monthly: this.data.monthly[mKey] }
  }

  recordAnthropicUsage(usage: { model: string; inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }): void {
    const { daily, monthly } = this.periodsFor()
    for (const period of [daily, monthly, this.data.allTime]) addAnthropicUsage(period, usage.model, usage)
    this.scheduleSave()
  }

  startDeepgramStream(): void {
    this.sttStreamStartedAt = Date.now()
  }

  /** Returns the seconds just recorded, so callers (budgetManager) can react to this specific stream's cost without waiting for the next tick. */
  stopDeepgramStream(): number {
    if (this.sttStreamStartedAt == null) return 0
    const seconds = (Date.now() - this.sttStreamStartedAt) / 1000
    this.sttStreamStartedAt = null
    const { daily, monthly } = this.periodsFor()
    for (const period of [daily, monthly, this.data.allTime]) addDeepgramSeconds(period, seconds)
    this.scheduleSave()
    return seconds
  }

  recordElevenLabsChars(count: number): void {
    const { daily, monthly } = this.periodsFor()
    for (const period of [daily, monthly, this.data.allTime]) addElevenLabsChars(period, count)
    this.scheduleSave()
  }

  recordSessionStart(): void {
    const { daily, monthly } = this.periodsFor()
    for (const period of [daily, monthly, this.data.allTime]) period.sessionCount += 1
    this.scheduleSave()
  }

  /** Today's/this month's/all-time raw totals, in the internal (pre-pricing) shape — what budgetManager checks limits against. */
  rawToday(now = new Date()): PeriodUsage {
    return this.data.daily[dailyKey(now)] ?? emptyPeriodUsage()
  }

  rawThisMonth(now = new Date()): PeriodUsage {
    return this.data.monthly[monthlyKey(now)] ?? emptyPeriodUsage()
  }

  snapshot(now = new Date()): UsageSnapshot {
    return {
      since: this.data.since,
      today: snapshotPeriod(this.rawToday(now)),
      thisMonth: snapshotPeriod(this.rawThisMonth(now)),
      allTime: snapshotPeriod(this.data.allTime)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      pruneOldDaily(this.data.daily, new Date())
      try {
        writeFileSync(usageFilePath(), JSON.stringify(this.data, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[jarvis] Failed to persist usage.json:', (err as Error).message)
      }
      this.saveTimer = null
    }, SAVE_DEBOUNCE_MS)
  }
}

export const usageTracker = new UsageTracker()
