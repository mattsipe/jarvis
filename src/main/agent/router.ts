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
 * Deictic/vision phrasing ("look at this", "what's this error", "click
 * that") needs look_at_screen plus real visual reasoning over the
 * result — routed to tier2 rather than trusting Haiku with a screenshot
 * it's more likely to misread.
 */
const VISION_KEYWORDS = ['this', 'that', 'look', 'see', 'screen', 'error', 'click', 'cursor', 'mouse']

/**
 * Cheap heuristic for tier1 (Haiku, fast/cheap) vs tier2 (Opus, high
 * effort). Can graduate to a one-line Haiku classification later if this
 * proves too blunt in practice.
 */
export function pickTier(text: string): ModelTier {
  const t = text.trim().toLowerCase()
  if (t.length > 220) return 'tier2'
  if (COMPLEXITY_KEYWORDS.some((kw) => t.includes(kw))) return 'tier2'
  if (VISION_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(t))) return 'tier2'
  return 'tier1'
}
