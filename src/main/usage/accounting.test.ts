import { describe, it, expect } from 'vitest'
import { callCost, contextTokens } from './accounting'
import { DEFAULT_PRICING } from './pricing'

describe('usage/accounting callCost', () => {
  it('computes cost from input/output/cache rates for a known model', () => {
    const { usd, unpriced } = callCost(
      { model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      DEFAULT_PRICING
    )
    expect(unpriced).toBe(false)
    expect(usd).toBeCloseTo(1 + 5, 5)
  })

  it('includes cache read/write at their own rates', () => {
    const { usd } = callCost(
      { model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      DEFAULT_PRICING
    )
    expect(usd).toBeCloseTo(6.25 + 0.5, 5)
  })

  it('flags an unknown model as unpriced with zero cost rather than guessing', () => {
    const { usd, unpriced } = callCost(
      { model: 'claude-future-model-x', inputTokens: 1000, outputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      DEFAULT_PRICING
    )
    expect(unpriced).toBe(true)
    expect(usd).toBe(0)
  })

  it('prices claude-sonnet-5 (the optimized engine\'s standard tier)', () => {
    const { usd, unpriced } = callCost(
      { model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      DEFAULT_PRICING
    )
    expect(unpriced).toBe(false)
    expect(usd).toBeCloseTo(3 + 15, 5)
  })

  it('returns zero cost for a call with no tokens', () => {
    const { usd } = callCost({ model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, DEFAULT_PRICING)
    expect(usd).toBe(0)
  })
})

describe('usage/accounting contextTokens', () => {
  it('sums input, cache read, and cache write but not output', () => {
    expect(contextTokens({ model: 'x', inputTokens: 100, outputTokens: 900, cacheWriteTokens: 50, cacheReadTokens: 25 })).toBe(175)
  })
})
