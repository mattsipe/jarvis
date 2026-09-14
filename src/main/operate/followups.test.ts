import { describe, it, expect, beforeEach } from 'vitest'
import { matchOperateFollowup } from './followups'
import { operateContext } from './context'

function setTarget(overrides: Partial<{ ref: string; name: string | null; role: string | null; window: string | null }> = {}): void {
  operateContext.recordTarget({
    ref: 'e17',
    name: 'Bluetooth',
    role: 'ToggleSwitch',
    window: 'Settings',
    lastAction: 'toggle',
    lastVerifiedState: 'On',
    ...overrides
  })
}

describe('operate/followups matchOperateFollowup', () => {
  beforeEach(() => {
    operateContext.reset()
  })

  it('returns null when there is no last target', () => {
    expect(matchOperateFollowup('turn it off')).toBeNull()
  })

  it('matches "turn it off" against a fresh toggle target', () => {
    setTarget()
    const match = matchOperateFollowup('turn it off')
    expect(match).toEqual({
      toolName: 'ui_act',
      toolInput: { target: { ref: 'e17' }, action: 'toggle', desiredState: 'off', intent: 'turn off Bluetooth' },
      spoken: 'Turning Bluetooth off.',
      source: 'operate-followup'
    })
  })

  it('matches "turn it back on" and "switch it off" phrasing', () => {
    setTarget()
    expect(matchOperateFollowup('turn it back on')?.toolInput.desiredState).toBe('on')
    expect(matchOperateFollowup('switch it off')?.toolInput.desiredState).toBe('off')
  })

  it('matches "toggle it"', () => {
    setTarget()
    expect(matchOperateFollowup('toggle it')).not.toBeNull()
  })

  it('matches "click that" as an invoke', () => {
    setTarget({ role: 'Button', name: 'Refresh' })
    const match = matchOperateFollowup('click that')
    expect(match?.toolInput.action).toBe('invoke')
    expect(match?.spoken).toBe('Clicking Refresh.')
  })

  it('falls through (returns null) for a role that cannot be toggled', () => {
    setTarget({ role: 'Edit' })
    expect(matchOperateFollowup('turn it off')).toBeNull()
  })

  it('falls through for an elevated target (e.g. Send)', () => {
    setTarget({ name: 'Send', role: 'Button' })
    expect(matchOperateFollowup('click that')).toBeNull()
  })

  it('falls through for ordinary conversational text', () => {
    setTarget()
    expect(matchOperateFollowup('what time is it')).toBeNull()
    expect(matchOperateFollowup('')).toBeNull()
  })

  it('falls through once the target has expired', () => {
    setTarget()
    // Simulate expiry by resetting — getLastTarget's own TTL logic is
    // covered by operate/context.test.ts; this just confirms the
    // followup matcher has no target to work with once it's gone.
    operateContext.reset()
    expect(matchOperateFollowup('turn it off')).toBeNull()
  })
})
