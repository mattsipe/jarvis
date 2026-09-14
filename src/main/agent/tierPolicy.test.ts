import { describe, it, expect } from 'vitest'
import { applyCostPressure, canReplan, canEscalate, MAX_REPLANS_PER_TASK, MAX_ESCALATIONS_PER_TURN } from './tierPolicy'

describe('agent/tierPolicy applyCostPressure', () => {
  it('leaves every route alone when there is no cost pressure', () => {
    expect(applyCostPressure('fast', false)).toBe('fast')
    expect(applyCostPressure('standard', false)).toBe('standard')
    expect(applyCostPressure('deep', false)).toBe('deep')
    expect(applyCostPressure('deep-plan', false)).toBe('deep-plan')
  })

  it('downgrades deep and deep-plan to standard under cost pressure', () => {
    expect(applyCostPressure('deep', true)).toBe('standard')
    expect(applyCostPressure('deep-plan', true)).toBe('standard')
  })

  it('leaves fast and standard alone under cost pressure', () => {
    expect(applyCostPressure('fast', true)).toBe('fast')
    expect(applyCostPressure('standard', true)).toBe('standard')
  })
})

describe('agent/tierPolicy replan/escalation budgets', () => {
  it('allows replanning until the cap, then stops', () => {
    for (let i = 0; i < MAX_REPLANS_PER_TASK; i++) expect(canReplan(i)).toBe(true)
    expect(canReplan(MAX_REPLANS_PER_TASK)).toBe(false)
  })

  it('allows escalation until the cap, then stops', () => {
    for (let i = 0; i < MAX_ESCALATIONS_PER_TURN; i++) expect(canEscalate(i)).toBe(true)
    expect(canEscalate(MAX_ESCALATIONS_PER_TURN)).toBe(false)
  })
})
