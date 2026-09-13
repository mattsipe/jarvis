import { broadcast } from '../window'
import { logInfo, logError } from '../logger'
import { usageTracker } from './tracker'
import { getBudgetConfig, updateBudgetConfig, type BudgetConfig } from './budgetConfig'
import { loadPricingConfig, estimateCostUsd } from './pricing'
import { decideGate, isHardCrossed, nextWarningThreshold, pctOfHard, type GateResult } from './budgetLogic'

export interface BudgetWarningEvent {
  period: 'daily' | 'monthly'
  threshold: number
  spentUsd: number
  limitUsd: number
}

// In-memory only — the worst case of not persisting this is one duplicate
// warning after a restart, which is a fair trade against the extra file
// I/O of persisting a small threshold map that resets naturally at each
// new day/month anyway.
const warnedPct = new Map<string, number>()

function spendFor(period: 'daily' | 'monthly'): number {
  const pricing = loadPricingConfig()
  const raw = period === 'daily' ? usageTracker.rawToday() : usageTracker.rawThisMonth()
  return estimateCostUsd(raw, pricing)
}

function limitsFor(cfg: BudgetConfig, period: 'daily' | 'monthly'): { softUsd: number | null; hardUsd: number | null } {
  return period === 'daily' ? { softUsd: cfg.dailySoftUsd, hardUsd: cfg.dailyHardUsd } : { softUsd: cfg.monthlySoftUsd, hardUsd: cfg.monthlyHardUsd }
}

/** Emits (broadcast + log) the next crossed 50/75/90% warning for one period, if any, at most once per threshold per period. */
function checkWarning(period: 'daily' | 'monthly'): void {
  const cfg = getBudgetConfig()
  const limits = limitsFor(cfg, period)
  const spent = spendFor(period)
  const pct = pctOfHard(spent, limits)
  const key = period
  const already = warnedPct.get(key) ?? 0
  const threshold = nextWarningThreshold(pct, already)
  if (threshold == null || limits.hardUsd == null) return
  warnedPct.set(key, threshold)
  const event: BudgetWarningEvent = { period, threshold, spentUsd: spent, limitUsd: limits.hardUsd }
  logInfo('usage:budget', `${period} spend reached ${threshold}% of the hard limit ($${spent.toFixed(2)} / $${limits.hardUsd.toFixed(2)})`)
  broadcast('usage:warning', event)
}

function checkAllWarnings(): void {
  checkWarning('daily')
  checkWarning('monthly')
}

/**
 * The single gate every metered call should check before it goes out. Cost
 * is tracked unconditionally either way (see tracker.ts) — this only
 * decides whether the call is *allowed to happen at all*, and only when the
 * master "protectionEnabled" switch is on. Native/local tool calls never
 * call this — they have no metered cost to gate.
 */
export const budgetManager = {
  /** `essential: false` for calls JARVIS can skip without breaking the current interaction (auto-learn extraction, speculative tier2 escalation). `essential: true` for the reply the user is actively waiting on. */
  checkAnthropicCall(opts: { essential: boolean }): GateResult {
    const cfg = getBudgetConfig()
    const result = decideGate({
      protectionEnabled: cfg.protectionEnabled,
      essential: opts.essential,
      dailyHardCrossed: isHardCrossed(spendFor('daily'), limitsFor(cfg, 'daily')),
      monthlyHardCrossed: isHardCrossed(spendFor('monthly'), limitsFor(cfg, 'monthly'))
    })
    if (!result.allowed) logError('usage:budget', `blocked an Anthropic call (essential=${opts.essential}): ${result.reason}`)
    return result
  },

  checkDeepgramStream(): GateResult {
    const cfg = getBudgetConfig()
    return decideGate({
      protectionEnabled: cfg.protectionEnabled,
      essential: true,
      dailyHardCrossed: isHardCrossed(spendFor('daily'), limitsFor(cfg, 'daily')),
      monthlyHardCrossed: isHardCrossed(spendFor('monthly'), limitsFor(cfg, 'monthly'))
    })
  },

  checkElevenLabsSynthesis(): GateResult {
    const cfg = getBudgetConfig()
    // Speech is nice-to-have once a hard limit is hit — JARVIS can still
    // reply in text (the transcript panel) without spending more here.
    return decideGate({
      protectionEnabled: cfg.protectionEnabled,
      essential: false,
      dailyHardCrossed: isHardCrossed(spendFor('daily'), limitsFor(cfg, 'daily')),
      monthlyHardCrossed: isHardCrossed(spendFor('monthly'), limitsFor(cfg, 'monthly'))
    })
  },

  /** True once the soft (not hard) limit is crossed for either period — used by the router to prefer the cheapest adequate model. */
  costPressure(): boolean {
    const cfg = getBudgetConfig()
    const daily = spendFor('daily')
    const monthly = spendFor('monthly')
    return (cfg.dailySoftUsd != null && daily >= cfg.dailySoftUsd) || (cfg.monthlySoftUsd != null && monthly >= cfg.monthlySoftUsd)
  },

  /** Call after recording any usage — cheap, and the only place 50/75/90% warnings get evaluated. */
  notifyUsageRecorded(): void {
    checkAllWarnings()
  },

  config(): BudgetConfig {
    return getBudgetConfig()
  },

  updateConfig(patch: Partial<BudgetConfig>): BudgetConfig {
    return updateBudgetConfig(patch)
  }
}
