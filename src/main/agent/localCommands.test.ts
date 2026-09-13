import { describe, it, expect, vi } from 'vitest'

// resolveApp pulls in the app catalog (Electron's app.getPath, the native
// helper, etc.) — irrelevant to what this file actually tests, which is
// localCommands' own phrase-matching/dispatch logic. Stubbed at the
// boundary instead of dragging the whole Electron-dependent app-resolution
// stack into a unit test.
const { resolveAppMock } = vi.hoisted(() => ({ resolveAppMock: vi.fn() }))
vi.mock('../apps/resolver', () => ({ resolveApp: resolveAppMock }))

const { matchLocalCommand, matchEndPhrase } = await import('./localCommands')

describe('agent/localCommands matchLocalCommand', () => {
  it('matches mute/unmute in a few common phrasings', () => {
    expect(matchLocalCommand('mute')).toEqual({ toolName: 'mute', toolInput: {}, spoken: 'Muted.' })
    expect(matchLocalCommand('Mute the volume.')).toEqual({ toolName: 'mute', toolInput: {}, spoken: 'Muted.' })
    expect(matchLocalCommand('unmute')).toEqual({ toolName: 'unmute', toolInput: {}, spoken: 'Unmuted.' })
  })

  it('matches an exact volume percentage and clamps out-of-range values', () => {
    expect(matchLocalCommand('set volume to 40')).toEqual({ toolName: 'set_volume', toolInput: { percent: 40 }, spoken: 'Volume set to 40 percent.' })
    expect(matchLocalCommand('volume to 150 percent')).toEqual({ toolName: 'set_volume', toolInput: { percent: 100 }, spoken: 'Volume set to 100 percent.' })
  })

  it('matches relative volume up/down', () => {
    expect(matchLocalCommand('volume up')?.toolName).toBe('volume_up')
    expect(matchLocalCommand('turn the volume down')?.toolName).toBe('volume_down')
  })

  it('matches screenshot and self-test phrasing', () => {
    expect(matchLocalCommand('take a screenshot')?.toolName).toBe('screenshot')
    expect(matchLocalCommand('screenshot')?.toolName).toBe('screenshot')
    expect(matchLocalCommand('run a self test')?.toolName).toBe('self_test')
    expect(matchLocalCommand('run self-test')?.toolName).toBe('self_test')
  })

  it('matches "open <app>" only when resolveApp returns a single unambiguous hit', () => {
    resolveAppMock.mockReturnValueOnce({ entry: { displayName: 'Google Chrome', kind: 'shortcut', launchTarget: 'chrome.exe' } })
    expect(matchLocalCommand('open chrome')).toEqual({ toolName: 'open_app', toolInput: { name: 'chrome' }, spoken: 'Opening Google Chrome.' })
  })

  it('falls through to Claude (returns null) when resolveApp reports ambiguity', () => {
    resolveAppMock.mockReturnValueOnce({ ambiguous: true, candidates: [] })
    expect(matchLocalCommand('open outlook')).toBeNull()
  })

  it('falls through to Claude (returns null) when resolveApp finds nothing', () => {
    resolveAppMock.mockReturnValueOnce(null)
    expect(matchLocalCommand('open some nonexistent thing')).toBeNull()
  })

  it('never matches destructive/elevated intents like closing an app', () => {
    expect(matchLocalCommand('close chrome')).toBeNull()
    expect(matchLocalCommand('quit outlook')).toBeNull()
  })

  it('returns null for ordinary conversational text', () => {
    expect(matchLocalCommand('what is the weather like today')).toBeNull()
    expect(matchLocalCommand('')).toBeNull()
  })
})

describe('agent/localCommands matchEndPhrase', () => {
  it('matches the three specified end phrases exactly', () => {
    expect(matchEndPhrase("that's all")).toBe(true)
    expect(matchEndPhrase('go back to sleep')).toBe(true)
    expect(matchEndPhrase('end conversation')).toBe(true)
  })

  it('tolerates punctuation, casing, and a short filler prefix', () => {
    expect(matchEndPhrase("That's all.")).toBe(true)
    expect(matchEndPhrase('OK, go back to sleep')).toBe(true)
    expect(matchEndPhrase('Okay Jarvis, end conversation')).toBe(true)
    expect(matchEndPhrase('jarvis, that\'s all')).toBe(true)
  })

  it('does not match a sentence that merely contains one of the phrases as a fragment', () => {
    expect(matchEndPhrase("that's all I wanted to say, can you also open Chrome")).toBe(false)
    expect(matchEndPhrase('please end conversation mode in the settings')).toBe(false)
  })

  it('returns false for ordinary conversational text and empty input', () => {
    expect(matchEndPhrase('what time is it')).toBe(false)
    expect(matchEndPhrase('')).toBe(false)
  })
})
