import { runAgentTurnLegacy } from './loopLegacy'
import { runAgentTurnOptimized } from './loopOptimized'
import { getBudgetConfig } from '../usage/budgetConfig'
import type { AgentTurnHooks, AgentTurnResult } from './loopTypes'

export type { AgentTurnResult, AgentTurnHooks, ToolCallInfo } from './loopTypes'

/**
 * Thin dispatcher between the two turn engines — see
 * usage/budgetConfig.ts's `routingPolicy` (editable live in Command
 * Center's Usage & Budget panel) for the Cost + Context Optimization
 * milestone's validation-only A/B toggle. Read fresh on every call (not
 * cached) so flipping the toggle takes effect on the very next turn, no
 * restart needed. voice/session.ts and ipc.ts only ever import from this
 * file — neither engine is imported directly outside of here and their
 * own test files.
 */
export async function runAgentTurn(
  userText: string,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
  hooks?: AgentTurnHooks
): Promise<AgentTurnResult> {
  const policy = getBudgetConfig().routingPolicy
  return policy === 'legacy' ? runAgentTurnLegacy(userText, onSentence, signal, hooks) : runAgentTurnOptimized(userText, onSentence, signal, hooks)
}
