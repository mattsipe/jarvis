import type { PricingConfig } from './pricing'

/**
 * Pure per-call cost/context-size arithmetic for the optimized engine's
 * turn ledger (usage/turnLedger.ts) — separate from pricing.ts's
 * per-period estimateCostUsd() so a single model call's cost/context size
 * can be computed and reasoned about (and unit-tested) independently of
 * the daily/monthly rollup shape.
 */
export interface CallUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface CallCost {
  usd: number
  /** True when the model has no rate in the pricing table — the cost is reported as 0, but this flag says that's "unknown", not "actually free". */
  unpriced: boolean
}

export function callCost(usage: CallUsage, pricing: PricingConfig): CallCost {
  const rates = pricing.anthropic[usage.model]
  if (!rates) return { usd: 0, unpriced: true }
  const usd =
    (usage.inputTokens / 1_000_000) * rates.inputPerMTok +
    (usage.outputTokens / 1_000_000) * rates.outputPerMTok +
    (usage.cacheWriteTokens / 1_000_000) * rates.cacheWritePerMTok +
    (usage.cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok
  return { usd, unpriced: false }
}

/** "Context size" for one call — everything that had to be read (fresh or cached) to make it, which is what actually matters for the "is the prompt growing" question. Output tokens are billed but don't reflect prompt growth, so they're excluded on purpose. */
export function contextTokens(usage: CallUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}
