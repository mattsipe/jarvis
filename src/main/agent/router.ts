import type { ModelTier } from './config'

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
 * Cheap heuristic for tier1 (Haiku, fast/cheap) vs tier2 (Opus, high
 * effort). No tools exist yet (M2), so this rarely matters in practice —
 * it earns its keep once multi-tool requests show up in M3. Can graduate
 * to a one-line Haiku classification later if this proves too blunt.
 */
export function pickTier(text: string): ModelTier {
  const t = text.trim().toLowerCase()
  if (t.length > 220) return 'tier2'
  if (COMPLEXITY_KEYWORDS.some((kw) => t.includes(kw))) return 'tier2'
  return 'tier1'
}
