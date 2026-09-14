import type { Route } from './turnRouter'

/**
 * Escalation/replan budgets and cost-pressure downgrading for the
 * optimized engine — see agent/loopOptimized.ts for where each is
 * consulted. Kept separate from turnRouter.ts so route classification
 * stays pure and budget-state-free (see that file's doc comment).
 */

/** At most one fast→standard escalation per turn (the fast tier's `escalate` tool) — see loopOptimized.ts. */
export const MAX_ESCALATIONS_PER_TURN = 1

/** At most this many Opus replan side-calls per Operate task, triggered only by taskGuard's 'no_progress' stop reason. */
export const MAX_REPLANS_PER_TASK = 2

/**
 * Downgrades an escalated route once the soft budget limit is crossed —
 * `deep`/`deep-plan` both fall back to `standard` (no plan, no adaptive
 * thinking); `fast` is left alone since it's already the cheapest tier.
 * Mirrors usage/budgetLogic.ts's applyCostPressure but over the
 * optimized engine's Route type instead of the legacy tier1/tier2 pair
 * (that file stays frozen for the legacy engine — see its doc comment).
 */
export function applyCostPressure(route: Route, costPressure: boolean): Route {
  if (!costPressure) return route
  if (route === 'deep' || route === 'deep-plan') return 'standard'
  return route
}

export function canReplan(replansUsed: number): boolean {
  return replansUsed < MAX_REPLANS_PER_TASK
}

export function canEscalate(escalationsUsed: number): boolean {
  return escalationsUsed < MAX_ESCALATIONS_PER_TURN
}
