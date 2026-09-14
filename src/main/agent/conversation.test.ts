import { describe, it, expect } from 'vitest'
import { ConversationStore, buildDigest, truncateAssistantText, estimateTokensForText } from './conversation'

describe('agent/conversation buildDigest', () => {
  it('returns empty string for no entries', () => {
    expect(buildDigest([])).toBe('')
  })

  it('formats a single successful action', () => {
    expect(buildDigest([{ tool: 'open_settings_page', ok: true }])).toBe('[did: open_settings_page → ok]')
  })

  it('includes a note and joins multiple entries', () => {
    const digest = buildDigest([
      { tool: 'open_settings_page', ok: true },
      { tool: 'ui_act', ok: true, note: 'toggle Bluetooth on' }
    ])
    expect(digest).toBe('[did: open_settings_page → ok; ui_act toggle Bluetooth on → ok]')
  })

  it('truncates to the max length', () => {
    const digest = buildDigest([{ tool: 'x', ok: true, note: 'y'.repeat(300) }], 50)
    expect(digest.length).toBeLessThanOrEqual(50)
    expect(digest.endsWith('…]')).toBe(true)
  })
})

describe('agent/conversation truncateAssistantText', () => {
  it('leaves short text alone', () => {
    expect(truncateAssistantText('hello')).toBe('hello')
  })

  it('truncates long text with an ellipsis', () => {
    const text = truncateAssistantText('a'.repeat(500), 400)
    expect(text.length).toBe(400)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('agent/conversation estimateTokensForText', () => {
  it('scales with length', () => {
    expect(estimateTokensForText('')).toBe(0)
    expect(estimateTokensForText('a'.repeat(35))).toBe(10)
  })
})

describe('agent/conversation ConversationStore', () => {
  it('records a turn and returns no eviction until the pair cap is exceeded', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    for (let i = 0; i < 6; i++) {
      const { evicted } = store.recordTurn({ userText: `q${i}`, assistantText: `a${i}`, digest: '' })
      expect(evicted).toHaveLength(0)
      t += 1000
    }
    expect(store.getWindow()).toHaveLength(6)
  })

  it('evicts the oldest pair once the pair cap is exceeded', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    for (let i = 0; i < 7; i++) {
      store.recordTurn({ userText: `q${i}`, assistantText: `a${i}`, digest: '' })
      t += 1000
    }
    const window = store.getWindow()
    expect(window).toHaveLength(6)
    expect(window[0].userText).toBe('q1') // q0 evicted
  })

  it('evicts by estimated token size even under the pair cap', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    const { evicted } = store.recordTurn({ userText: 'x'.repeat(10000), assistantText: 'y'.repeat(10000), digest: '' })
    expect(evicted).toHaveLength(1) // the oversized pair itself gets evicted immediately
  })

  it('folds evicted pairs into the summary only via applySummary', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    for (let i = 0; i < 7; i++) {
      store.recordTurn({ userText: `q${i}`, assistantText: `a${i}`, digest: '' })
      t += 1000
    }
    expect(store.getSummary()).toBe('') // nothing folds automatically
    store.applySummary('earlier: asked about q0')
    expect(store.getSummary()).toBe('earlier: asked about q0')
  })

  it('clears the window and summary after the idle TTL', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    store.recordTurn({ userText: 'q', assistantText: 'a', digest: '' })
    store.applySummary('summary text')
    t += 11 * 60 * 1000 // > 10 minute TTL
    expect(store.getWindow()).toHaveLength(0)
    expect(store.getSummary()).toBe('')
  })

  it('does not clear within the idle TTL', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    store.recordTurn({ userText: 'q', assistantText: 'a', digest: '' })
    t += 5 * 60 * 1000
    expect(store.getWindow()).toHaveLength(1)
  })

  it('reset() clears everything immediately', () => {
    const store = new ConversationStore()
    store.recordTurn({ userText: 'q', assistantText: 'a', digest: '' })
    store.applySummary('s')
    store.reset()
    expect(store.getWindow()).toHaveLength(0)
    expect(store.getSummary()).toBe('')
  })

  it('stays bounded across many simulated turns', () => {
    let t = 1000
    const store = new ConversationStore(() => t)
    for (let i = 0; i < 30; i++) {
      store.recordTurn({ userText: `turn ${i} `.repeat(20), assistantText: `reply ${i} `.repeat(20), digest: `[did: x → ok]` })
      t += 1000
    }
    expect(store.getWindow().length).toBeLessThanOrEqual(6)
  })
})
