/**
 * Pure feature-based router for the optimized engine — replaces the
 * legacy keyword-list pickTier (agent/router.ts, kept frozen for the
 * legacy engine). Cost-pressure downgrading is NOT done here — see
 * agent/tierPolicy.ts's applyCostPressure(), called by the caller after
 * this returns a route. Keeping the two separate means this file's
 * feature detection stays testable without a costPressure axis on every
 * case.
 */
export type Route = 'fast' | 'standard' | 'deep-plan' | 'deep'

export interface RouteInput {
  text: string
  /** OperateContext has a fresh last target this turn could plausibly act on (see operate/context.ts). */
  hasFreshOperateTarget: boolean
}

export interface RouteDecision {
  route: Route
  reason: string
}

// Visual/deictic cues that need a real screenshot + reasoning over it —
// narrower than the old VISION_KEYWORDS list (which fired on bare "this"/
// "that"/"see"), so ordinary conversation containing those words no
// longer gets escalated for nothing.
const VISUAL_CUE =
  /\b(look at (this|that)|see (this|that)|what('?s| is) (this|that) error|this error|that error|on (my|the) screen|read (this|that|it) (out|for me)|what does (this|that|it) say)\b/

const DIAGNOSE_CUE = /\b(fix (it|this|that)|figure out|troubleshoot|what'?s wrong|why (is|isn'?t|does(n'?t)?))\b/

// A real operate verb *with* an object/target phrase — deliberately
// excludes bare "open" (which the local/native app-launch path or
// open_settings_page already covers without needing tier2 reasoning).
// "turn ... on/off" allows an arbitrary target between the verb and its
// on/off ("turn Bluetooth on", not just "turn it on") within the same
// clause (stops at sentence punctuation).
const OPERATE_VERB =
  /\bturn\b[^.!?]*\b(on|off)\b|\btoggle\b|\bclick\b|\bpress\b|\bselect\b|\bfill (this|it|that) in\b|\bfill in\b|\btype (into|in)\b|\bswitch to\b|\benable\b|\bdisable\b/

const OPEN_ENDED = /\b(go through|set up|clean up|organize|walk me through)\b/

// Only counts an explicit sequencing word as a second "step" — a plain
// "and" joining two nouns ("Excel and Outlook") is not a second step.
const STEP_JOINER = /(,?\s*then\b|\band then\b|\bafter that\b|\band also\b)/g

const COMPLEXITY_KEYWORDS = ['explain why', 'compare', 'analyze', 'summarize']

/**
 * Deterministic route classification. `applyCostPressure` (tierPolicy.ts)
 * is applied by the caller afterward — this function never sees budget
 * state, so its output is stable and easy to table-test.
 */
export function pickRoute(input: RouteInput): RouteDecision {
  const t = input.text.trim().toLowerCase()
  if (!t) return { route: 'fast', reason: 'empty' }

  const visual = VISUAL_CUE.test(t)
  const diagnose = DIAGNOSE_CUE.test(t)
  if (visual && diagnose) return { route: 'deep', reason: 'visual diagnosis' }
  if (visual) return { route: 'deep', reason: 'visual reasoning' }

  const stepCount = 1 + (t.match(STEP_JOINER) ?? []).length
  const hasOperateVerb = OPERATE_VERB.test(t)
  const openEnded = OPEN_ENDED.test(t)

  if (hasOperateVerb || input.hasFreshOperateTarget) {
    if (openEnded || stepCount >= 2) {
      return { route: 'deep-plan', reason: stepCount >= 2 ? 'multi-step operate' : 'open-ended operate' }
    }
    return { route: 'standard', reason: 'single-step operate' }
  }

  if (openEnded || stepCount >= 3) {
    return { route: 'deep-plan', reason: 'open-ended or multi-clause request' }
  }

  if (COMPLEXITY_KEYWORDS.some((kw) => t.includes(kw))) {
    return { route: 'deep-plan', reason: 'analytical request' }
  }

  return { route: 'fast', reason: 'conversational' }
}
