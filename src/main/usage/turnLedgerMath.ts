/**
 * Pure aggregation over TurnRecord[] — split out from usage/turnLedger.ts
 * (which imports '../window' to broadcast) so this half is directly
 * unit-testable without touching Electron, matching the project's
 * pure-core/thin-impure-edge convention (see e.g. usage/budgetLogic.ts
 * vs. usage/budgetManager.ts).
 */
import type { CallRecord, TurnRecord } from './turnLedger'

export type { CallRecord, TurnRecord } from './turnLedger'

export interface TurnLedgerSummary {
  count: number
  localHandledCount: number
  localHandledPct: number
  totalCostUsd: number
  avgCostUsdPerModelTurn: number
  /** Percent of individual model *calls* (not turns) that used an Opus model — the plan's "Opus 5 share of model calls" target. */
  deepShare: number
}

export function summarizeTurns(records: TurnRecord[]): TurnLedgerSummary {
  const count = records.length
  const localHandledCount = records.filter((t) => t.localHandled).length
  const modelTurns = records.filter((t) => !t.localHandled)
  const totalCostUsd = records.reduce((sum, t) => sum + t.totalCostUsd, 0)
  const allCalls: CallRecord[] = records.flatMap((t) => t.calls)
  const deepCalls = allCalls.filter((c) => c.model.includes('opus')).length
  return {
    count,
    localHandledCount,
    localHandledPct: count > 0 ? (localHandledCount / count) * 100 : 0,
    totalCostUsd,
    avgCostUsdPerModelTurn: modelTurns.length > 0 ? modelTurns.reduce((sum, t) => sum + t.totalCostUsd, 0) / modelTurns.length : 0,
    deepShare: allCalls.length > 0 ? (deepCalls / allCalls.length) * 100 : 0
  }
}
