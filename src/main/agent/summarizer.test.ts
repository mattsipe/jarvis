import { describe, it, expect } from 'vitest'
import { foldSummary, extractiveFallback, type SummarizerClient } from './summarizer'
import type { TurnPair } from './conversation'

const usage = { inputTokens: 200, outputTokens: 60, cacheWriteTokens: 0, cacheReadTokens: 0 }

function pair(userText: string, assistantText: string, digest = ''): TurnPair {
  return { userText, assistantText, digest, at: 0 }
}

function fakeClient(text: string | null, throwErr = false): SummarizerClient {
  return {
    createMessage: async () => {
      if (throwErr) throw new Error('boom')
      return { text, usage }
    }
  }
}

describe('agent/summarizer foldSummary', () => {
  it('returns the existing summary unchanged when nothing was evicted', async () => {
    const { summary, usage: u } = await foldSummary('existing', [], fakeClient('ignored'))
    expect(summary).toBe('existing')
    expect(u).toBeNull()
  })

  it('uses the model result when it succeeds', async () => {
    const { summary, usage: u } = await foldSummary('', [pair('hi', 'hello')], fakeClient('Weston said hi.'))
    expect(summary).toBe('Weston said hi.')
    expect(u).toEqual(usage)
  })

  it('falls back to an extractive summary when the client throws', async () => {
    const { summary, usage: u } = await foldSummary('', [pair('open excel', 'Opened Excel.', '[did: open_app → ok]')], fakeClient(null, true))
    expect(summary).toContain('open excel')
    expect(summary).toContain('did: open_app')
    expect(u).toBeNull()
  })

  it('falls back to extractive when the model returns empty text', async () => {
    const { summary } = await foldSummary('', [pair('q', 'a')], fakeClient('   '))
    expect(summary).toContain('Earlier: asked')
  })

  it('caps the folded summary length', async () => {
    const { summary } = await foldSummary('', [pair('q', 'a')], fakeClient('x'.repeat(3000)))
    expect(summary.length).toBeLessThanOrEqual(1600)
  })
})

describe('agent/summarizer extractiveFallback', () => {
  it('builds one line per evicted turn and appends to the existing summary', () => {
    const summary = extractiveFallback('prior context.', [pair('what time is it', 'It is noon.'), pair('open chrome', 'Opened Chrome.', '[did: open_app → ok]')])
    expect(summary).toContain('prior context.')
    expect(summary).toContain('what time is it')
    expect(summary).toContain('did: open_app')
  })

  it('truncates a long user question in the fallback line', () => {
    const summary = extractiveFallback('', [pair('x'.repeat(200), 'reply')])
    expect(summary.length).toBeLessThan(300)
  })
})
