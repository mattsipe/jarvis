/**
 * Pure data shapes and arithmetic for the usage ledger — no Electron/fs
 * imports here on purpose, so this half of the usage/budget manager can be
 * unit-tested directly. tracker.ts is the thin, impure layer that persists
 * this shape to disk.
 */

export interface AnthropicModelUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requestCount: number
}

export interface PeriodUsage {
  /** Keyed by Anthropic model id, e.g. "claude-haiku-4-5". */
  anthropic: Record<string, AnthropicModelUsage>
  deepgramSeconds: number
  elevenLabsChars: number
  sessionCount: number
}

export interface UsageFile {
  version: 2
  since: string
  /** Keyed by local-date "YYYY-MM-DD". Pruned to USAGE_DAILY_RETENTION_DAYS. */
  daily: Record<string, PeriodUsage>
  /** Keyed by local-month "YYYY-MM". Kept indefinitely — small (≤12/year). */
  monthly: Record<string, PeriodUsage>
  allTime: PeriodUsage
}

export const USAGE_DAILY_RETENTION_DAYS = 60

export function emptyModelUsage(): AnthropicModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requestCount: 0 }
}

export function emptyPeriodUsage(): PeriodUsage {
  return { anthropic: {}, deepgramSeconds: 0, elevenLabsChars: 0, sessionCount: 0 }
}

export function emptyUsageFile(since = new Date().toISOString()): UsageFile {
  return { version: 2, since, daily: {}, monthly: {}, allTime: emptyPeriodUsage() }
}

/** Local (not UTC) calendar date — matches how Weston thinks about "today"/"this month". */
export function dailyKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function monthlyKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export function addAnthropicUsage(
  period: PeriodUsage,
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }
): void {
  const existing = period.anthropic[model] ?? emptyModelUsage()
  existing.inputTokens += tokens.inputTokens
  existing.outputTokens += tokens.outputTokens
  existing.cacheWriteTokens += tokens.cacheWriteTokens ?? 0
  existing.cacheReadTokens += tokens.cacheReadTokens ?? 0
  existing.requestCount += 1
  period.anthropic[model] = existing
}

export function addDeepgramSeconds(period: PeriodUsage, seconds: number): void {
  period.deepgramSeconds += Math.max(0, seconds)
}

export function addElevenLabsChars(period: PeriodUsage, chars: number): void {
  period.elevenLabsChars += Math.max(0, chars)
}

/** Drops daily buckets older than the retention window so usage.json doesn't grow forever. Monthly/allTime are untouched. */
export function pruneOldDaily(daily: Record<string, PeriodUsage>, now: Date, retentionDays = USAGE_DAILY_RETENTION_DAYS): void {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffKey = dailyKey(cutoff)
  for (const key of Object.keys(daily)) {
    if (key < cutoffKey) delete daily[key]
  }
}
