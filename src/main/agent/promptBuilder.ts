import type Anthropic from '@anthropic-ai/sdk'
import { PERSONA_SYSTEM_PROMPT } from './persona'

/**
 * Stable, cache-friendly system-prompt layout for the optimized engine —
 * see the plan's conversation-compression design. The key change from the
 * legacy layout: dynamic per-turn facts (time, active window, cursor,
 * OperateContext, a plan) never enter the system blocks — they go into the
 * *current user message* instead (buildTurnContextLine), so `system`
 * itself only changes when the persona or the memory/summary block
 * actually change, keeping both ephemeral cache breakpoints hot across an
 * entire session instead of missing on every turn.
 */

export interface TurnContextInput {
  nowIso: string
  timeZone: string
  activeWindowTitle?: string | null
  activeProcess?: string | null
  includeCursor: boolean
  cursor?: { x: number; y: number } | null
  operateSummary?: string
  planText?: string
}

/** BP1 (persona) + BP2 (memory + session summary) — at most 2 of the 4 available breakpoints; the other 2 are left for the caller's messages/tool-result breakpoints. */
export function buildSystemBlocks(memoryContext: string, sessionSummary: string): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: PERSONA_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]
  const memoryAndSummary = [memoryContext, sessionSummary ? `Session so far: ${sessionSummary}` : ''].filter(Boolean).join(' ')
  if (memoryAndSummary) blocks.push({ type: 'text', text: memoryAndSummary, cache_control: { type: 'ephemeral' } })
  return blocks
}

/**
 * Everything that changes every turn, rendered as one line prepended to
 * the user's own message rather than a system block. Cursor position is
 * included only when the utterance is plausibly about the pointer/screen
 * (`includeCursor`) — most turns don't need it, and it's one of the few
 * per-turn facts that would otherwise always differ.
 */
export function buildTurnContextLine(input: TurnContextInput): string {
  const parts = [
    `Time: ${input.nowIso.slice(0, 16).replace('T', ' ')} (${input.timeZone}).`,
    input.activeWindowTitle ? `Active window: "${input.activeWindowTitle}"${input.activeProcess ? ` (${input.activeProcess})` : ''}.` : '',
    input.includeCursor && input.cursor ? `Cursor at (${input.cursor.x}, ${input.cursor.y}).` : '',
    input.operateSummary ?? '',
    input.planText ? `Plan: ${input.planText}` : ''
  ]
  return parts.filter(Boolean).join(' ')
}

export type Toolset = 'core' | 'core+operate'

/** fast gets the non-Operate tool surface (plus a hand-added `escalate` tool at the call site); standard/deep/deep-plan get the full surface including Operate. */
export function selectToolset(route: 'fast' | 'standard' | 'deep' | 'deep-plan'): Toolset {
  return route === 'fast' ? 'core' : 'core+operate'
}

/** True when cursor position is worth spending tokens on for this utterance. */
export function wantsCursorContext(text: string): boolean {
  return /\b(this|that|click|cursor|mouse|pointer)\b/i.test(text)
}
