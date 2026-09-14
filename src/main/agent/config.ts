/**
 * Model routing config for the OPTIMIZED engine (agent/loopOptimized.ts) —
 * see the Cost + Context Optimization plan's model-tier strategy. The
 * legacy engine (agent/loopLegacy.ts) intentionally does NOT import this
 * file — it carries its own frozen tier1/tier2 config so the Command
 * Center's routing-policy toggle is a genuine A/B baseline, not two
 * views onto the same tuning.
 */
export type ModelTier = 'fast' | 'standard' | 'deep'

export interface TierConfig {
  model: string
  /** Haiku 4.5 supports neither adaptive thinking nor `effort` — leave both undefined for it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  thinking?: boolean
}

export const MODEL_TIERS: Record<ModelTier, TierConfig> = {
  // Conversation, questions, memory, and any single non-Operate tool the
  // local fast-path couldn't resolve — see agent/turnRouter.ts.
  fast: {
    model: 'claude-haiku-4-5'
  },
  // Every Operate execution chain (all ui_*/keyboard/pointer steps) and
  // single-step Operate from cold — deliberately no thinking by default,
  // since a UIA action loop is mostly mechanical once a target is known.
  standard: {
    model: 'claude-sonnet-5'
  },
  // Planning/replanning side-calls and genuine visual-diagnosis turns
  // only — never per Operate step. See agent/planner.ts.
  deep: {
    model: 'claude-opus-5',
    effort: 'medium',
    thinking: true
  }
}

/** One Opus call producing a short step plan, consumed by agent/planner.ts. Kept separate from MODEL_TIERS.deep so its effort/thinking can be tuned independently of ad hoc "deep" conversational turns. */
export const PLANNER_TIER: TierConfig = {
  model: 'claude-opus-5',
  effort: 'medium',
  thinking: true
}

/** Haiku, no thinking — used by agent/summarizer.ts's session-summary fold and context/autolearn.ts. */
export const SUMMARY_MODEL = 'claude-haiku-4-5'

export const MAX_RESPONSE_TOKENS = 1024
