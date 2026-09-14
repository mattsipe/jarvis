import type { TurnPair } from './conversation'
import type { RawCallUsage } from './planner'

/**
 * Folds turns evicted from the conversation window into the rolling
 * session summary — called by agent/loopOptimized.ts after a turn has
 * finished speaking (never before, and never blocking the reply). Haiku,
 * no thinking, `essential:false` at the call site. `client` is injected
 * for direct testing, same pattern as agent/planner.ts.
 */

export interface SummarizerClient {
  createMessage(prompt: string): Promise<{ text: string | null; usage: RawCallUsage }>
}

export interface FoldResult {
  summary: string
  usage: RawCallUsage | null
}

const MAX_SUMMARY_CHARS = 1600 // ~400 tokens

export const SUMMARY_SYSTEM_PROMPT = `You maintain a short rolling summary of an ongoing conversation between Weston and his voice assistant JARVIS, so JARVIS can stay continuous without re-reading the full transcript.

Fold the new turns into the existing summary. Keep it under roughly 400 tokens. Structure it as compact prose covering: what Weston is currently doing/working on, any open question or pending item, decisions made this session, and entities referenced (apps, windows, files, people, ambiguous choices already resolved). Drop anything no longer relevant. Return ONLY the updated summary text, no preamble, no markdown.`

function truncate(text: string, max = MAX_SUMMARY_CHARS): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function buildFoldPrompt(existingSummary: string, evicted: TurnPair[]): string {
  const turnsText = evicted.map((t) => `Weston: ${t.userText}\nJARVIS: ${t.assistantText}`).join('\n\n')
  return `Existing summary: ${existingSummary || '(none yet)'}\n\nNew turns to fold in:\n${turnsText}`
}

/** Deterministic fallback when the model call is blocked or fails — one short extractive line per evicted turn, appended to whatever summary already existed. Never model-quality, but always available and cheap. */
export function extractiveFallback(existingSummary: string, evicted: TurnPair[]): string {
  const lines = evicted.map((t) => {
    const q = t.userText.length > 60 ? t.userText.slice(0, 60) + '…' : t.userText
    const did = t.digest || 'no notable action'
    return `Earlier: asked "${q}"; ${did}.`
  })
  return truncate([existingSummary, ...lines].filter(Boolean).join(' '))
}

export async function foldSummary(existingSummary: string, evicted: TurnPair[], client: SummarizerClient): Promise<FoldResult> {
  if (evicted.length === 0) return { summary: existingSummary, usage: null }
  try {
    const { text, usage } = await client.createMessage(buildFoldPrompt(existingSummary, evicted))
    if (!text || !text.trim()) return { summary: extractiveFallback(existingSummary, evicted), usage }
    return { summary: truncate(text.trim()), usage }
  } catch {
    return { summary: extractiveFallback(existingSummary, evicted), usage: null }
  }
}
