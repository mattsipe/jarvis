/**
 * Pure decision logic for the budget manager — no Electron/fs/network
 * imports, so it's directly unit-testable. budgetManager.ts wraps this with
 * the real usage tracker, persisted config, and broadcast/logging calls.
 */

export interface Limits {
  softUsd: number | null
  hardUsd: number | null
}

export const WARNING_THRESHOLDS = [50, 75, 90] as const
export type WarningThreshold = (typeof WARNING_THRESHOLDS)[number]

/** Percent of the hard limit already spent, or null if there's no hard limit to measure against. */
export function pctOfHard(spentUsd: number, limits: Limits): number | null {
  if (limits.hardUsd == null || limits.hardUsd <= 0) return null
  return (spentUsd / limits.hardUsd) * 100
}

export function isSoftCrossed(spentUsd: number, limits: Limits): boolean {
  return limits.softUsd != null && limits.softUsd > 0 && spentUsd >= limits.softUsd
}

export function isHardCrossed(spentUsd: number, limits: Limits): boolean {
  return limits.hardUsd != null && limits.hardUsd > 0 && spentUsd >= limits.hardUsd
}

/**
 * Given the current percent-of-hard-limit spent and the highest threshold
 * already announced for this period (0 if none yet), returns the single
 * new threshold that should be announced now, or null if nothing new was
 * crossed. Only ever moves forward — a limit raised after a warning won't
 * re-trigger an already-announced threshold.
 */
export function nextWarningThreshold(currentPct: number | null, alreadyWarnedPct: number): WarningThreshold | null {
  if (currentPct == null) return null
  let next: WarningThreshold | null = null
  for (const threshold of WARNING_THRESHOLDS) {
    if (currentPct >= threshold && threshold > alreadyWarnedPct) next = threshold
  }
  return next
}

export interface GateInput {
  protectionEnabled: boolean
  /** True for calls JARVIS can't skip and still be useful this turn (e.g. answering the user). False for optional/background calls (auto-learn, speculative escalation). */
  essential: boolean
  dailyHardCrossed: boolean
  monthlyHardCrossed: boolean
}

export interface GateResult {
  allowed: boolean
  reason?: string
}

/**
 * The one place that decides whether a metered call should actually go out.
 * Nonessential calls are cut off the moment either hard limit is crossed;
 * essential calls (the user is mid-conversation and expects an answer) are
 * only cut off once protection is on AND a hard limit is crossed — local
 * JARVIS functions (native tools, self-test, standalone actions) never call
 * this gate at all, so they keep working regardless.
 */
export function decideGate(input: GateInput): GateResult {
  if (!input.protectionEnabled) return { allowed: true }
  const hardCrossed = input.dailyHardCrossed || input.monthlyHardCrossed
  if (!hardCrossed) return { allowed: true }
  if (!input.essential) {
    return { allowed: false, reason: `${input.dailyHardCrossed ? 'Daily' : 'Monthly'} budget limit reached — skipping a nonessential API call.` }
  }
  return { allowed: false, reason: `${input.dailyHardCrossed ? 'Daily' : 'Monthly'} budget limit reached.` }
}

/** Downgrades an escalated tier to the cheapest tier once the soft limit is crossed — vision and Operate calls are exempt (a wrong screen-reading answer or a wrong click/toggle is a correctness problem, not just a cost one) and left to the caller to keep as tier2. */
export function applyCostPressure(tier: 'tier1' | 'tier2', costPressure: boolean, reason: 'length' | 'complexity' | 'vision' | 'operate'): 'tier1' | 'tier2' {
  if (!costPressure) return tier
  if (reason === 'vision' || reason === 'operate') return tier
  return 'tier1'
}
