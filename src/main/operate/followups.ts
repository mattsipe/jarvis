import { operateContext } from './context'
import { classifyRisk } from './risk'
import type { LocalCommandMatch } from '../agent/localCommands'

export type OperateFollowupMatch = LocalCommandMatch

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
}

/** Roles a plain "turn it on/off"/"toggle it" can plausibly apply to — matches the ones ui_act's toggle action actually supports (see native/jarvis-helper/Uia/UiaActions.cs). */
const TOGGLEABLE_ROLES = new Set(['ToggleSwitch', 'CheckBox', 'Button', 'RadioButton'])

/**
 * L0 local layer for Operate short-term referents ("turn it back off",
 * "click that") — see the Cost + Context Optimization plan's routing
 * architecture. Runs only when the optimized routing policy is active
 * (see voice/session.ts) and only when OperateContext already has a
 * fresh last target from earlier this conversation; a target it can't
 * confidently act on (wrong role, or a risk classification that comes
 * back elevated) falls through to a full Claude turn instead of guessing
 * or silently skipping confirmation. On a failed local attempt (e.g. a
 * stale ref), this reports the honest tool failure rather than
 * transparently retrying through Claude — see the plan-consistency note
 * in the implementation report for why this is a deliberate, lower-risk
 * simplification of the plan's more elaborate "fallthrough with a note"
 * design.
 */
export function matchOperateFollowup(rawText: string): OperateFollowupMatch | null {
  const text = normalize(rawText)
  if (!text) return null

  const last = operateContext.getLastTarget()
  if (!last) return null

  const toggleMatch = text.match(/^(?:turn|switch)\s+(?:it|that|this)\s*(?:back\s+)?(on|off)$/) ?? text.match(/^toggle\s+(?:it|that|this)$/)
  const invokeMatch = /^(?:click|press|invoke)\s+(?:it|that|this)$/.test(text)

  if (toggleMatch) {
    if (last.role && !TOGGLEABLE_ROLES.has(last.role)) return null
    const desiredState: 'on' | 'off' = toggleMatch[1] === 'off' ? 'off' : 'on'
    const intent = `turn ${desiredState} ${last.name ?? 'that'}`
    const { risk } = classifyRisk({ intent, targetName: last.name, targetRole: last.role, windowTitle: last.window })
    if (risk === 'elevated') return null
    return {
      toolName: 'ui_act',
      toolInput: { target: { ref: last.ref }, action: 'toggle', desiredState, intent },
      spoken: `Turning ${last.name ?? 'that'} ${desiredState}.`,
      source: 'operate-followup'
    }
  }

  if (invokeMatch) {
    const intent = `click ${last.name ?? 'that'}`
    const { risk } = classifyRisk({ intent, targetName: last.name, targetRole: last.role, windowTitle: last.window })
    if (risk === 'elevated') return null
    return {
      toolName: 'ui_act',
      toolInput: { target: { ref: last.ref }, action: 'invoke', intent },
      spoken: `Clicking ${last.name ?? 'that'}.`,
      source: 'operate-followup'
    }
  }

  return null
}
