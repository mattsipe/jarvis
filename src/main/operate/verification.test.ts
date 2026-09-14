import { describe, it, expect } from 'vitest'
import { deriveToolOutcome } from './verification'
import type { ActionResult } from './types'

const TARGET = '"Bluetooth" (ToggleSwitch)'

describe('operate/verification deriveToolOutcome — the sent-vs-verified invariant', () => {
  it('toggle expected On, observed On -> ok:true, verified', () => {
    const result: ActionResult = { sent: true, sentVia: 'uia:Toggle', verification: { status: 'verified', before: 'Off', after: 'On' } }
    const outcome = deriveToolOutcome(result, 'toggle', TARGET)
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toMatch(/verified/i)
    expect(outcome.message).toContain('On')
  })

  it('toggle sent but still Off after the verification window -> ok:true (a miss is never a failure)', () => {
    const result: ActionResult = { sent: true, sentVia: 'uia:Toggle', verification: { status: 'no_effect_observed', before: 'Off', after: 'Off' } }
    const outcome = deriveToolOutcome(result, 'toggle', TARGET)
    expect(outcome.ok).toBe(true)
    expect(outcome.message).not.toMatch(/fail/i)
  })

  it('already in the desired state -> ok:true, reported as a no-op, not a re-send', () => {
    const result: ActionResult = { sent: true, sentVia: 'uia:Toggle', noop: true, verification: { status: 'verified', before: 'On', after: 'On' } }
    const outcome = deriveToolOutcome(result, 'toggle', TARGET)
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toMatch(/already/i)
  })

  it('invoke with no inherent before/after state -> not_verifiable, still ok:true', () => {
    const result: ActionResult = { sent: true, sentVia: 'uia:Invoke', verification: { status: 'not_verifiable' } }
    const outcome = deriveToolOutcome(result, 'invoke', '"OK" (Button)')
    expect(outcome.ok).toBe(true)
    expect(outcome.message).not.toMatch(/fail/i)
  })

  it('ONLY a real send failure (sent:false) produces ok:false', () => {
    const result: ActionResult = { sent: false, error: { code: 'not_actionable', message: "Element doesn't support Toggle." }, verification: { status: 'pending' } }
    const outcome = deriveToolOutcome(result, 'toggle', TARGET)
    expect(outcome.ok).toBe(false)
  })

  it('a stale ref is reported as a clean failure with no verification claim', () => {
    const result: ActionResult = { sent: false, error: { code: 'stale_ref', message: "Element ref 'e17' is stale or unknown." }, verification: { status: 'pending' } }
    const outcome = deriveToolOutcome(result, 'toggle', TARGET)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("Couldn't act on")
  })

  it('an ambiguous target lists the real candidates and never claims anything was sent', () => {
    const result: ActionResult = {
      sent: false,
      error: { code: 'ambiguous_target', message: 'Ambiguous target.' },
      candidates: [
        { ref: 'e1', role: 'Button', name: 'OK', automationId: null, enabled: true, state: null, patterns: [] },
        { ref: 'e2', role: 'Button', name: 'OK', automationId: null, enabled: true, state: null, patterns: [] }
      ],
      verification: { status: 'pending' }
    }
    const outcome = deriveToolOutcome(result, 'invoke', '"OK"')
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('More than one match')
  })
})
