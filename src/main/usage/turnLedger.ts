import { broadcast } from '../window'
import { summarizeTurns as summarizeTurnsPure } from './turnLedgerMath'
import type { TurnLedgerSummary } from './turnLedgerMath'

export { summarizeTurns } from './turnLedgerMath'
export type { TurnLedgerSummary } from './turnLedgerMath'

/**
 * Per-turn routing/context/cost diagnostics for the optimized engine —
 * see the plan's context-accounting design. Thin and impure (broadcasts
 * to the Command Center) on purpose, wrapping the pure math in
 * usage/accounting.ts; usage/tracker.ts's daily/monthly ledger is
 * unchanged and remains the source of truth for spend totals — this is
 * an additional, short-lived "what just happened" view for the
 * Usage & Budget panel's Recent Turns table.
 */
export interface CallRecord {
  model: string
  purpose: 'chain' | 'plan' | 'replan' | 'summary' | 'autolearn'
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUsd: number
  unpriced: boolean
  contextTokens: number
}

export interface TurnRecord {
  turnId: string
  route: 'local' | 'fast' | 'standard' | 'deep' | 'deep-plan' | 'tier1' | 'tier2' | 'blocked'
  routeReason: string
  escalated: boolean
  replans: number
  calls: CallRecord[]
  totalCostUsd: number
  totalContextTokens: number
  localHandled: boolean
  startedAt: number
  endedAt: number
}

const MAX_TURNS = 50
const turns: TurnRecord[] = []

export function recordTurn(turn: TurnRecord): void {
  turns.unshift(turn)
  while (turns.length > MAX_TURNS) turns.pop()
  broadcast('usage:turn', turn)
}

export function getRecentTurns(): TurnRecord[] {
  return [...turns]
}

/** Test-only / policy-switch reset — never called from production code paths other than explicitly wanting a clean A/B slate. */
export function clearTurns(): void {
  turns.length = 0
}

/** Convenience wrapper over the module's own in-memory buffer — see usage/turnLedgerMath.ts for the pure aggregation this calls. */
export function summarizeRecentTurns(): TurnLedgerSummary {
  return summarizeTurnsPure(turns)
}
