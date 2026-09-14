import { describe, it, expect } from 'vitest'
import { planTask, renderPlanText, type PlannerClient, type RawCallUsage } from './planner'

const usage: RawCallUsage = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 }

function fakeClient(text: string | null, throwErr = false): PlannerClient {
  return {
    createMessage: async () => {
      if (throwErr) throw new Error('boom')
      return { text, usage }
    }
  }
}

describe('agent/planner planTask', () => {
  it('parses a valid plan', async () => {
    const text = '{"steps":[{"do":"open Settings","successCheck":"Settings window visible"},{"do":"toggle Bluetooth on","successCheck":"toggle shows On"}],"risky":false,"needsScreen":false}'
    const { plan, usage: u } = await planTask('turn on bluetooth', '', fakeClient(text))
    expect(plan?.steps).toHaveLength(2)
    expect(plan?.steps[0].do).toBe('open Settings')
    expect(plan?.risky).toBe(false)
    expect(u).toEqual(usage)
  })

  it('tolerates surrounding prose/markdown fences around the JSON', () => {
    return planTask('x', '', fakeClient('Here is the plan:\n```json\n{"steps":[{"do":"a","successCheck":"b"}]}\n```')).then(({ plan }) => {
      expect(plan?.steps).toHaveLength(1)
    })
  })

  it('caps steps at 8', async () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({ do: `step ${i}`, successCheck: '' }))
    const { plan } = await planTask('x', '', fakeClient(JSON.stringify({ steps })))
    expect(plan?.steps).toHaveLength(8)
  })

  it('returns null plan for invalid JSON', async () => {
    const { plan, usage: u } = await planTask('x', '', fakeClient('not json at all'))
    expect(plan).toBeNull()
    expect(u).toEqual(usage)
  })

  it('returns null plan for an empty steps array', async () => {
    const { plan } = await planTask('x', '', fakeClient('{"steps":[]}'))
    expect(plan).toBeNull()
  })

  it('returns null plan and null usage when the client throws', async () => {
    const { plan, usage: u } = await planTask('x', '', fakeClient(null, true))
    expect(plan).toBeNull()
    expect(u).toBeNull()
  })

  it('returns null plan when the client returns no text', async () => {
    const { plan, usage: u } = await planTask('x', '', fakeClient(null))
    expect(plan).toBeNull()
    expect(u).toEqual(usage)
  })

  it('drops malformed step entries but keeps valid ones', async () => {
    const text = JSON.stringify({ steps: [{ do: 'valid step', successCheck: 'ok' }, { successCheck: 'missing do' }, 'not an object'] })
    const { plan } = await planTask('x', '', fakeClient(text))
    expect(plan?.steps).toHaveLength(1)
  })
})

describe('agent/planner renderPlanText', () => {
  it('numbers each step compactly', () => {
    const text = renderPlanText({ steps: [{ do: 'open Settings', successCheck: '' }, { do: 'toggle Bluetooth', successCheck: '' }], risky: false, needsScreen: false })
    expect(text).toBe('1) open Settings 2) toggle Bluetooth')
  })

  it('truncates a very long rendering', () => {
    const longStep = 'x'.repeat(2000)
    const text = renderPlanText({ steps: [{ do: longStep, successCheck: '' }], risky: false, needsScreen: false })
    expect(text.length).toBeLessThanOrEqual(900)
    expect(text.endsWith('…')).toBe(true)
  })
})
