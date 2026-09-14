import { describe, it, expect } from 'vitest'
import { pctOfHard, isSoftCrossed, isHardCrossed, nextWarningThreshold, decideGate, applyCostPressure } from './budgetLogic'

describe('usage/budgetLogic', () => {
  describe('pctOfHard / isSoftCrossed / isHardCrossed', () => {
    it('returns null pct when there is no hard limit configured', () => {
      expect(pctOfHard(100, { softUsd: 5, hardUsd: null })).toBeNull()
    })

    it('computes percent spent of the hard limit', () => {
      expect(pctOfHard(5, { softUsd: null, hardUsd: 10 })).toBe(50)
    })

    it('treats an unset (null) limit as never crossed', () => {
      expect(isSoftCrossed(1_000_000, { softUsd: null, hardUsd: null })).toBe(false)
      expect(isHardCrossed(1_000_000, { softUsd: null, hardUsd: null })).toBe(false)
    })

    it('crosses soft/hard exactly at the configured value, not just above it', () => {
      expect(isSoftCrossed(3, { softUsd: 3, hardUsd: 8 })).toBe(true)
      expect(isHardCrossed(8, { softUsd: 3, hardUsd: 8 })).toBe(true)
      expect(isHardCrossed(7.99, { softUsd: 3, hardUsd: 8 })).toBe(false)
    })
  })

  describe('nextWarningThreshold', () => {
    it('returns null when nothing new was crossed', () => {
      expect(nextWarningThreshold(40, 0)).toBeNull()
      expect(nextWarningThreshold(null, 0)).toBeNull()
      expect(nextWarningThreshold(50, 50)).toBeNull() // already warned at this exact threshold
    })

    it('returns the single highest newly-crossed threshold, not a list', () => {
      expect(nextWarningThreshold(60, 0)).toBe(50)
      expect(nextWarningThreshold(95, 0)).toBe(90) // jumped straight past 50 and 75 — only report the highest
      expect(nextWarningThreshold(95, 75)).toBe(90)
    })

    it('never re-announces a threshold already warned, even if spend dips and climbs again', () => {
      expect(nextWarningThreshold(80, 75)).toBeNull()
      expect(nextWarningThreshold(76, 75)).toBeNull()
    })
  })

  describe('decideGate', () => {
    it('always allows when protection is disabled, regardless of hard-limit state', () => {
      expect(decideGate({ protectionEnabled: false, essential: true, dailyHardCrossed: true, monthlyHardCrossed: true })).toEqual({ allowed: true })
    })

    it('allows everything when no hard limit has been crossed', () => {
      expect(decideGate({ protectionEnabled: true, essential: false, dailyHardCrossed: false, monthlyHardCrossed: false }).allowed).toBe(true)
    })

    it('blocks a nonessential call once a hard limit is crossed', () => {
      const result = decideGate({ protectionEnabled: true, essential: false, dailyHardCrossed: true, monthlyHardCrossed: false })
      expect(result.allowed).toBe(false)
      expect(result.reason).toMatch(/Daily/)
    })

    it('also blocks an essential call once a hard limit is crossed — local JARVIS functions are what keep working, not the Claude reply itself', () => {
      const result = decideGate({ protectionEnabled: true, essential: true, dailyHardCrossed: false, monthlyHardCrossed: true })
      expect(result.allowed).toBe(false)
      expect(result.reason).toMatch(/Monthly/)
    })
  })

  describe('applyCostPressure', () => {
    it('leaves the tier alone when there is no cost pressure', () => {
      expect(applyCostPressure('tier2', false, 'length')).toBe('tier2')
    })

    it('downgrades a length/complexity escalation under cost pressure', () => {
      expect(applyCostPressure('tier2', true, 'length')).toBe('tier1')
      expect(applyCostPressure('tier2', true, 'complexity')).toBe('tier1')
    })

    it('never downgrades a vision escalation, even under cost pressure — a wrong screen-reading answer is a correctness problem', () => {
      expect(applyCostPressure('tier2', true, 'vision')).toBe('tier2')
    })

    it('never downgrades an Operate escalation, even under cost pressure — a wrong click/toggle is a correctness problem', () => {
      expect(applyCostPressure('tier2', true, 'operate')).toBe('tier2')
    })

    it('leaves tier1 as tier1 regardless of pressure or reason', () => {
      expect(applyCostPressure('tier1', true, 'vision')).toBe('tier1')
    })
  })
})
