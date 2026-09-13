import { describe, it, expect } from 'vitest'
import { computeState } from './state'

const base = { muted: false, enabled: true, engineReady: true, sessionActive: false }

describe('presence/state computeState', () => {
  it('is "sleeping" when enabled, ready, not muted, and no session is active', () => {
    expect(computeState(base)).toBe('sleeping')
  })

  it('is "muted" whenever muted, regardless of anything else', () => {
    expect(computeState({ ...base, muted: true })).toBe('muted')
    expect(computeState({ ...base, muted: true, sessionActive: true })).toBe('muted')
    expect(computeState({ ...base, muted: true, enabled: false, engineReady: false })).toBe('muted')
  })

  it('is "active" whenever a session is active and not muted', () => {
    expect(computeState({ ...base, sessionActive: true })).toBe('active')
    expect(computeState({ ...base, sessionActive: true, enabled: false })).toBe('active')
  })

  it('is "disabled" when the feature is turned off, even with a ready engine', () => {
    expect(computeState({ ...base, enabled: false })).toBe('disabled')
  })

  it('is "disabled" when the wake-word engine is not ready (e.g. no AccessKey), even when enabled', () => {
    expect(computeState({ ...base, engineReady: false })).toBe('disabled')
  })

  it('mute takes precedence over an active session, and an active session takes precedence over disabled', () => {
    // muted > active > disabled > sleeping, in that priority order
    expect(computeState({ muted: true, enabled: false, engineReady: false, sessionActive: true })).toBe('muted')
    expect(computeState({ muted: false, enabled: false, engineReady: false, sessionActive: true })).toBe('active')
  })
})
