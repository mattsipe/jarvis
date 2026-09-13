import { describe, it, expect } from 'vitest'
import { DEFAULT_PRICING, loadPricingConfig, estimateCostUsd } from './pricing'
import { emptyPeriodUsage, addAnthropicUsage, addDeepgramSeconds, addElevenLabsChars } from './model'

describe('usage/pricing', () => {
  it('estimates $0 for an empty period', () => {
    expect(estimateCostUsd(emptyPeriodUsage(), DEFAULT_PRICING)).toBe(0)
  })

  it('estimates Anthropic cost from input/output/cache tokens at the configured per-million rate', () => {
    const period = emptyPeriodUsage()
    addAnthropicUsage(period, 'claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 })
    const pricing = { anthropic: { 'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 } }, deepgramPerMinuteUsd: 0, elevenLabsPer1kCharsUsd: 0 }
    expect(estimateCostUsd(period, pricing)).toBeCloseTo(1 + 5 + 1.25 + 0.1, 6)
  })

  it('skips a model with no configured rate rather than guessing', () => {
    const period = emptyPeriodUsage()
    addAnthropicUsage(period, 'some-future-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(estimateCostUsd(period, DEFAULT_PRICING)).toBe(0)
  })

  it('estimates Deepgram cost per minute and ElevenLabs cost per 1000 chars', () => {
    const period = emptyPeriodUsage()
    addDeepgramSeconds(period, 120) // 2 minutes
    addElevenLabsChars(period, 2000)
    const pricing = { anthropic: {}, deepgramPerMinuteUsd: 0.01, elevenLabsPer1kCharsUsd: 0.05 }
    expect(estimateCostUsd(period, pricing)).toBeCloseTo(0.02 + 0.1, 6)
  })

  it('falls back to defaults when JARVIS_PRICING_OVERRIDES_JSON is unset or malformed', () => {
    expect(loadPricingConfig({})).toEqual(DEFAULT_PRICING)
    expect(loadPricingConfig({ JARVIS_PRICING_OVERRIDES_JSON: '{not json' })).toEqual(DEFAULT_PRICING)
  })

  it('deep-merges a partial override over the defaults, leaving unspecified rates untouched', () => {
    const merged = loadPricingConfig({
      JARVIS_PRICING_OVERRIDES_JSON: JSON.stringify({ deepgramPerMinuteUsd: 0.02, anthropic: { 'claude-opus-5': { outputPerMTok: 30 } } })
    })
    expect(merged.deepgramPerMinuteUsd).toBe(0.02)
    expect(merged.elevenLabsPer1kCharsUsd).toBe(DEFAULT_PRICING.elevenLabsPer1kCharsUsd)
    expect(merged.anthropic['claude-opus-5'].outputPerMTok).toBe(30)
    expect(merged.anthropic['claude-opus-5'].inputPerMTok).toBe(DEFAULT_PRICING.anthropic['claude-opus-5'].inputPerMTok)
    expect(merged.anthropic['claude-haiku-4-5']).toEqual(DEFAULT_PRICING.anthropic['claude-haiku-4-5']) // untouched model preserved
  })
})
