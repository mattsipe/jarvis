import { describe, it, expect } from 'vitest'
import { pickTier } from './router'

describe('agent/router pickTier', () => {
  it('picks tier1 for a short, plain request', () => {
    expect(pickTier('open Chrome')).toBe('tier1')
  })

  it('picks tier2 for a long message', () => {
    expect(pickTier('a'.repeat(221))).toBe('tier2')
  })

  it('picks tier2 for complexity keywords', () => {
    expect(pickTier('can you explain why this happened and then summarize it')).toBe('tier2')
  })

  it('picks tier2 for deictic/vision phrasing', () => {
    expect(pickTier('what is this error on my screen')).toBe('tier2')
    expect(pickTier('look where my mouse is')).toBe('tier2')
  })

  it('does not false-positive on vision keywords inside unrelated words', () => {
    // "seeking" contains "see" as a substring but not as a whole word — the
    // word-boundary regex must not trigger tier2 from substring matches.
    expect(pickTier('I am seeking a good restaurant nearby')).toBe('tier1')
  })

  describe('cost pressure', () => {
    it('downgrades a length-triggered tier2 back to tier1 under cost pressure', () => {
      expect(pickTier('a'.repeat(221), { costPressure: true })).toBe('tier1')
    })

    it('downgrades a complexity-keyword tier2 back to tier1 under cost pressure', () => {
      expect(pickTier('please compare these two options for me', { costPressure: true })).toBe('tier1')
    })

    it('keeps a vision-triggered tier2 even under cost pressure', () => {
      expect(pickTier('what does this error say', { costPressure: true })).toBe('tier2')
    })

    it('keeps vision priority over length when both would otherwise apply, so cost pressure cannot downgrade it', () => {
      const longVisionText = `look at this and tell me what's wrong ${'x'.repeat(200)}`
      expect(pickTier(longVisionText, { costPressure: true })).toBe('tier2')
    })
  })
})
