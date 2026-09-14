import { describe, it, expect } from 'vitest'
import { createTaskState, recordStep, checkStopReason, buildStepSignature, isRejectedDuplicateAction, TASK_GUARD_DEFAULTS } from './taskGuard'

describe('operate/taskGuard checkStopReason', () => {
  it('returns null when nothing has hit a limit', () => {
    const state = createTaskState(1000)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBeNull()
  })

  it('stops for aborted, taking priority over everything else', () => {
    const state = { ...createTaskState(1000), aborted: true, stepCount: 999 }
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, true)).toBe('aborted')
  })

  it('stops for confirmation_denied', () => {
    const state = { ...createTaskState(1000), confirmationDenied: true }
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBe('confirmation_denied')
  })

  it('stops for budget when the caller says it was exceeded', () => {
    const state = createTaskState(1000)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, true)).toBe('budget')
  })

  it('stops at the step ceiling', () => {
    const state = { ...createTaskState(1000), stepCount: 25 }
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBe('steps')
  })

  it('stops at the wall-clock ceiling', () => {
    const state = createTaskState(1000)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000 + 180_000, false)).toBe('time')
  })

  it('stops at the token ceiling', () => {
    const state = { ...createTaskState(1000), tokensUsed: 300_000 }
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBe('tokens')
  })

  it('stops for no_progress after 4 consecutive no-effect steps', () => {
    let state = createTaskState(1000)
    for (let i = 0; i < 3; i++) state = recordStep(state, `sig${i}`, false)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBeNull()
    state = recordStep(state, 'sig3', false)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBe('no_progress')
  })

  it('a single effective step resets the no-effect streak', () => {
    let state = createTaskState(1000)
    for (let i = 0; i < 3; i++) state = recordStep(state, `sig${i}`, false)
    state = recordStep(state, 'sig-ok', true)
    state = recordStep(state, 'sig-fail', false)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBeNull()
  })

  it('stops for no_progress when the same signature repeats 3 times', () => {
    let state = createTaskState(1000)
    const sig = buildStepSignature('ui_act', 'e17', 'toggle')
    state = recordStep(state, sig, true)
    state = recordStep(state, sig, true)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBeNull()
    state = recordStep(state, sig, true)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBe('no_progress')
  })

  it('different signatures interleaved do not trigger the repeat detector', () => {
    let state = createTaskState(1000)
    state = recordStep(state, 'a', true)
    state = recordStep(state, 'b', true)
    state = recordStep(state, 'a', true)
    state = recordStep(state, 'b', true)
    expect(checkStopReason(state, TASK_GUARD_DEFAULTS, 1000, false)).toBeNull()
  })
})

describe('operate/taskGuard isRejectedDuplicateAction', () => {
  it('rejects a duplicate non-idempotent invoke sent right after itself', () => {
    const sig = buildStepSignature('ui_act', 'e17', 'invoke')
    expect(isRejectedDuplicateAction('invoke', sig, [sig])).toBe(true)
  })

  it('does not reject a duplicate idempotent toggle/select/expand/collapse/focus', () => {
    for (const action of ['toggle', 'select', 'expand', 'collapse', 'focus']) {
      const sig = buildStepSignature('ui_act', 'e17', action)
      expect(isRejectedDuplicateAction(action, sig, [sig])).toBe(false)
    }
  })

  it('does not reject an invoke whose signature differs from the last one', () => {
    const sig = buildStepSignature('ui_act', 'e17', 'invoke')
    const other = buildStepSignature('ui_act', 'e18', 'invoke')
    expect(isRejectedDuplicateAction('invoke', sig, [other])).toBe(false)
  })

  it('does not reject the first-ever action (no history)', () => {
    const sig = buildStepSignature('ui_act', 'e17', 'invoke')
    expect(isRejectedDuplicateAction('invoke', sig, [])).toBe(false)
  })
})
