import type { PeriodUsage } from './model'

export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

export interface PricingConfig {
  anthropic: Record<string, ModelPricing>
  deepgramPerMinuteUsd: number
  elevenLabsPer1kCharsUsd: number
}

/**
 * Best-known public per-unit rates, used ONLY to turn raw token/second/char
 * counts into an approximate dollar figure for the budget UI — never to
 * decide what's "free". Every one of these is an editable estimate, not an
 * assumption about a provider's free tier (see the explicit instruction not
 * to hardcode those): override any of them with JARVIS_PRICING_OVERRIDES_JSON
 * (a JSON object matching PricingConfig, deep-merged over these defaults) if
 * a rate changes or Weston's actual plan differs.
 */
export const DEFAULT_PRICING: PricingConfig = {
  anthropic: {
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
    'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 }
  },
  deepgramPerMinuteUsd: 0.0043,
  elevenLabsPer1kCharsUsd: 0.1
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMergePricing(base: PricingConfig, override: unknown): PricingConfig {
  if (!isPlainObject(override)) return base
  const merged: PricingConfig = {
    anthropic: { ...base.anthropic },
    deepgramPerMinuteUsd: base.deepgramPerMinuteUsd,
    elevenLabsPer1kCharsUsd: base.elevenLabsPer1kCharsUsd
  }
  if (isPlainObject(override.anthropic)) {
    for (const [model, rates] of Object.entries(override.anthropic)) {
      if (!isPlainObject(rates)) continue
      const existing = merged.anthropic[model] ?? { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 }
      merged.anthropic[model] = {
        inputPerMTok: typeof rates.inputPerMTok === 'number' ? rates.inputPerMTok : existing.inputPerMTok,
        outputPerMTok: typeof rates.outputPerMTok === 'number' ? rates.outputPerMTok : existing.outputPerMTok,
        cacheWritePerMTok: typeof rates.cacheWritePerMTok === 'number' ? rates.cacheWritePerMTok : existing.cacheWritePerMTok,
        cacheReadPerMTok: typeof rates.cacheReadPerMTok === 'number' ? rates.cacheReadPerMTok : existing.cacheReadPerMTok
      }
    }
  }
  if (typeof override.deepgramPerMinuteUsd === 'number') merged.deepgramPerMinuteUsd = override.deepgramPerMinuteUsd
  if (typeof override.elevenLabsPer1kCharsUsd === 'number') merged.elevenLabsPer1kCharsUsd = override.elevenLabsPer1kCharsUsd
  return merged
}

/** Reads JARVIS_PRICING_OVERRIDES_JSON (if set) and merges it over DEFAULT_PRICING. Never throws — a malformed override just falls back to the defaults. */
export function loadPricingConfig(env: NodeJS.ProcessEnv = process.env): PricingConfig {
  const raw = env.JARVIS_PRICING_OVERRIDES_JSON
  if (!raw) return DEFAULT_PRICING
  try {
    return deepMergePricing(DEFAULT_PRICING, JSON.parse(raw))
  } catch {
    return DEFAULT_PRICING
  }
}

/** Pure — cost estimate for one period bucket under a given pricing table. */
export function estimateCostUsd(period: PeriodUsage, pricing: PricingConfig): number {
  let total = 0
  for (const [model, usage] of Object.entries(period.anthropic)) {
    const rates = pricing.anthropic[model]
    if (!rates) continue // unknown model — no rate to estimate against, skip rather than guess
    total += (usage.inputTokens / 1_000_000) * rates.inputPerMTok
    total += (usage.outputTokens / 1_000_000) * rates.outputPerMTok
    total += (usage.cacheWriteTokens / 1_000_000) * rates.cacheWritePerMTok
    total += (usage.cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok
  }
  total += (period.deepgramSeconds / 60) * pricing.deepgramPerMinuteUsd
  total += (period.elevenLabsChars / 1000) * pricing.elevenLabsPer1kCharsUsd
  return total
}
