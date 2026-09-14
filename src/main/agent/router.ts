import type { ModelTier } from './config'
import { applyCostPressure } from '../usage/budgetLogic'

const COMPLEXITY_KEYWORDS = [
  'and then',
  'after that',
  'step by step',
  'compare',
  'explain why',
  'plan',
  'analyze',
  'summarize'
]

/**
 * Deictic/vision phrasing ("look at this", "what's this error", "click
 * that") needs look_at_screen plus real visual reasoning over the
 * result — routed to tier2 rather than trusting Haiku with a screenshot
 * it's more likely to misread.
 */
const VISION_KEYWORDS = ['this', 'that', 'look', 'see', 'screen', 'error', 'click', 'cursor', 'mouse']

/**
 * Operate phrasing needs the same real reasoning as vision (deciding
 * which UIA element a name refers to, sequencing multi-step control) —
 * routed to tier2 and, like vision, never downgraded under cost pressure:
 * a wrong click/toggle is a correctness problem, not just a cost one.
 */
const OPERATE_KEYWORDS = ['turn on', 'turn off', 'toggle', 'enable', 'disable', 'click', 'select', 'fill', 'type', 'switch to', 'fix']

/**
 * Cheap heuristic for tier1 (Haiku, fast/cheap) vs tier2 (Opus, high
 * effort). Can graduate to a one-line Haiku classification later if this
 * proves too blunt in practice.
 *
 * `costPressure` (set once the daily/monthly *soft* budget limit is
 * crossed — see usage/budgetManager.ts) downgrades a length/complexity
 * escalation back to tier1, since those are judgment calls about how much
 * effort a turn deserves, not correctness requirements. A vision
 * escalation is never downgraded: look_at_screen results need real visual
 * reasoning, so a wrong answer there is a correctness problem, not just a
 * cost one — see the plan's screen-perception priority.
 */
export function pickTier(text: string, opts?: { costPressure?: boolean }): ModelTier {
  const t = text.trim().toLowerCase()
  const costPressure = opts?.costPressure ?? false
  if (VISION_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(t))) {
    return applyCostPressure('tier2', costPressure, 'vision')
  }
  if (OPERATE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(t))) {
    return applyCostPressure('tier2', costPressure, 'operate')
  }
  if (t.length > 220) return applyCostPressure('tier2', costPressure, 'length')
  if (COMPLEXITY_KEYWORDS.some((kw) => t.includes(kw))) return applyCostPressure('tier2', costPressure, 'complexity')
  return 'tier1'
}
