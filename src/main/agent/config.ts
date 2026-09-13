/**
 * Model routing config — see the plan's "Agent loop" section. Kept as data,
 * not hardcoded in the loop, so tiers are swappable without touching
 * router/loop logic. Tier 0 (local phrase match, no model call) lives
 * entirely in router.ts since it has no model config of its own.
 */
export type ModelTier = 'tier1' | 'tier2'

interface TierConfig {
  model: string
  /** Haiku 4.5 supports neither adaptive thinking nor `effort` — leave both undefined for it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  thinking?: boolean
}

export const MODEL_TIERS: Record<ModelTier, TierConfig> = {
  tier1: {
    model: 'claude-haiku-4-5'
    // No thinking/effort: Haiku 4.5 doesn't support adaptive thinking and
    // errors on `output_config.effort`. Fast + cheap for routine turns.
  },
  tier2: {
    model: 'claude-opus-5',
    effort: 'high',
    thinking: true
  }
}

export const MAX_RESPONSE_TOKENS = 1024
