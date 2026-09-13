import { describe, it, expect } from 'vitest'
import { emptyPeriodUsage, addAnthropicUsage, addDeepgramSeconds, addElevenLabsChars, dailyKey, monthlyKey, pruneOldDaily } from './model'

describe('usage/model', () => {
  it('accumulates Anthropic usage per model, including cache tokens and request count', () => {
    const period = emptyPeriodUsage()
    addAnthropicUsage(period, 'claude-haiku-4-5', { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 5 })
    addAnthropicUsage(period, 'claude-haiku-4-5', { inputTokens: 200, outputTokens: 25 })

    const model = period.anthropic['claude-haiku-4-5']
    expect(model.inputTokens).toBe(300)
    expect(model.outputTokens).toBe(75)
    expect(model.cacheWriteTokens).toBe(10)
    expect(model.cacheReadTokens).toBe(5)
    expect(model.requestCount).toBe(2)
  })

  it('keeps separate models independent', () => {
    const period = emptyPeriodUsage()
    addAnthropicUsage(period, 'claude-haiku-4-5', { inputTokens: 100, outputTokens: 50 })
    addAnthropicUsage(period, 'claude-opus-5', { inputTokens: 10, outputTokens: 5 })
    expect(Object.keys(period.anthropic).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5'])
    expect(period.anthropic['claude-opus-5'].inputTokens).toBe(10)
  })

  it('accumulates Deepgram seconds and ElevenLabs chars, never going negative', () => {
    const period = emptyPeriodUsage()
    addDeepgramSeconds(period, 12.5)
    addDeepgramSeconds(period, -5) // a clock skew or stop-before-start bug shouldn't be able to subtract
    addElevenLabsChars(period, 40)
    addElevenLabsChars(period, -10)
    expect(period.deepgramSeconds).toBe(12.5)
    expect(period.elevenLabsChars).toBe(40)
  })

  it('formats daily/monthly keys as local YYYY-MM-DD / YYYY-MM', () => {
    const date = new Date(2026, 0, 5) // Jan 5, 2026 — exercises zero-padding
    expect(dailyKey(date)).toBe('2026-01-05')
    expect(monthlyKey(date)).toBe('2026-01')
  })

  it('prunes daily buckets older than the retention window, keeping recent ones and monthly/allTime untouched', () => {
    const now = new Date(2026, 5, 15) // June 15, 2026
    const daily: Record<string, ReturnType<typeof emptyPeriodUsage>> = {
      '2026-06-14': emptyPeriodUsage(), // yesterday — kept
      '2026-01-01': emptyPeriodUsage() // way outside a 60-day window — pruned
    }
    pruneOldDaily(daily, now, 60)
    expect(Object.keys(daily)).toEqual(['2026-06-14'])
  })
})
