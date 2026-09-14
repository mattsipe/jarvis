import { describe, it, expect } from 'vitest'
import { pickRoute } from './turnRouter'

function r(text: string, hasFreshOperateTarget = false): string {
  return pickRoute({ text, hasFreshOperateTarget }).route
}

describe('agent/turnRouter pickRoute', () => {
  it('routes ordinary conversation to fast', () => {
    expect(r('open chrome')).toBe('fast')
    expect(r('what is the weather like today')).toBe('fast')
    expect(r('good morning')).toBe('fast')
  })

  it('does not escalate on bare deixis with no visual/error cue', () => {
    expect(r('that')).toBe('fast')
    expect(r('do that again')).toBe('fast')
  })

  it('routes visual/error cues to deep', () => {
    expect(r('what does this error say')).toBe('deep')
    expect(r('look at this')).toBe('deep')
  })

  it('routes visual + diagnose combined to deep, reason visual diagnosis', () => {
    const d = pickRoute({ text: 'see this error? fix it', hasFreshOperateTarget: false })
    expect(d.route).toBe('deep')
    expect(d.reason).toContain('diagnosis')
  })

  it('routes a single-step operate request to standard', () => {
    expect(r('open Settings and turn Bluetooth on')).toBe('standard')
    expect(r('turn on Bluetooth')).toBe('standard')
    expect(r('click the second result')).toBe('standard')
  })

  it('routes a fresh operate-target follow-up to standard even without an operate verb match failure', () => {
    expect(r('turn it back off', true)).toBe('standard')
  })

  it('routes a multi-step operate request to deep-plan', () => {
    expect(r('turn on Bluetooth and then open Excel')).toBe('deep-plan')
  })

  it('routes an open-ended operate request to deep-plan', () => {
    expect(r('go through Settings and turn off things I do not need')).toBe('deep-plan')
  })

  it('routes an open-ended non-operate request to deep-plan', () => {
    expect(r('can you clean up my desktop icons')).toBe('deep-plan')
  })

  it('routes analytical keywords to deep-plan', () => {
    expect(r('can you compare these two options for me')).toBe('deep-plan')
  })

  it('a plain "and" joining two nouns is not a second step', () => {
    expect(r('open Excel and Outlook')).toBe('fast')
  })

  it('empty text routes to fast', () => {
    expect(r('')).toBe('fast')
  })
})
