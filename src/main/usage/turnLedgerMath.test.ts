import { describe, it, expect } from 'vitest'
import { summarizeTurns, type TurnRecord } from './turnLedgerMath'

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: 't1',
    route: 'standard',
    routeReason: 'test',
    escalated: false,
    replans: 0,
    calls: [],
    totalCostUsd: 0,
    totalContextTokens: 0,
    localHandled: false,
    startedAt: 0,
    endedAt: 0,
    ...overrides
  }
}

describe('usage/turnLedgerMath summarizeTurns', () => {
  it('returns zeroed values for an empty ledger', () => {
    const s = summarizeTurns([])
    expect(s).toEqual({ count: 0, localHandledCount: 0, localHandledPct: 0, totalCostUsd: 0, avgCostUsdPerModelTurn: 0, deepShare: 0 })
  })

  it('computes local-handled percentage', () => {
    const s = summarizeTurns([turn({ localHandled: true }), turn({ localHandled: true }), turn({ localHandled: false })])
    expect(s.count).toBe(3)
    expect(s.localHandledCount).toBe(2)
    expect(s.localHandledPct).toBeCloseTo((2 / 3) * 100, 5)
  })

  it('computes total cost across all turns and average cost only over model turns', () => {
    const s = summarizeTurns([
      turn({ localHandled: true, totalCostUsd: 0 }),
      turn({ localHandled: false, totalCostUsd: 0.1 }),
      turn({ localHandled: false, totalCostUsd: 0.3 })
    ])
    expect(s.totalCostUsd).toBeCloseTo(0.4, 6)
    expect(s.avgCostUsdPerModelTurn).toBeCloseTo(0.2, 6)
  })

  it('computes the Opus share of individual model calls, not turns', () => {
    const call = (model: string): TurnRecord['calls'][number] => ({
      model,
      purpose: 'chain',
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      unpriced: false,
      contextTokens: 0
    })
    const s = summarizeTurns([
      turn({ calls: [call('claude-sonnet-5'), call('claude-sonnet-5')] }),
      turn({ calls: [call('claude-opus-5')] })
    ])
    expect(s.deepShare).toBeCloseTo((1 / 3) * 100, 5)
  })
})
