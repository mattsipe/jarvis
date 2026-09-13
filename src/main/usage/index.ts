import { usageTracker, type UsageSnapshot } from './tracker'
import { budgetManager } from './budgetManager'
import { getBudgetConfig, type BudgetConfig } from './budgetConfig'
import { isHardCrossed, isSoftCrossed } from './budgetLogic'
import { loadPricingConfig, estimateCostUsd } from './pricing'

export { usageTracker } from './tracker'
export { budgetManager } from './budgetManager'
export type { BudgetConfig } from './budgetConfig'
export type { UsageSnapshot } from './tracker'
export type { BudgetWarningEvent } from './budgetManager'

export interface BudgetStatus {
  config: BudgetConfig
  usage: UsageSnapshot
  daily: { softCrossed: boolean; hardCrossed: boolean }
  monthly: { softCrossed: boolean; hardCrossed: boolean }
}

/** Everything the Command Center's Usage & Budget panel needs in one call. */
export function getBudgetStatus(): BudgetStatus {
  const cfg = getBudgetConfig()
  const pricing = loadPricingConfig()
  const dailySpend = estimateCostUsd(usageTracker.rawToday(), pricing)
  const monthlySpend = estimateCostUsd(usageTracker.rawThisMonth(), pricing)
  return {
    config: cfg,
    usage: usageTracker.snapshot(),
    daily: {
      softCrossed: isSoftCrossed(dailySpend, { softUsd: cfg.dailySoftUsd, hardUsd: cfg.dailyHardUsd }),
      hardCrossed: isHardCrossed(dailySpend, { softUsd: cfg.dailySoftUsd, hardUsd: cfg.dailyHardUsd })
    },
    monthly: {
      softCrossed: isSoftCrossed(monthlySpend, { softUsd: cfg.monthlySoftUsd, hardUsd: cfg.monthlyHardUsd }),
      hardCrossed: isHardCrossed(monthlySpend, { softUsd: cfg.monthlySoftUsd, hardUsd: cfg.monthlyHardUsd })
    }
  }
}

export function setBudgetConfig(patch: Partial<BudgetConfig>): BudgetStatus {
  budgetManager.updateConfig(patch)
  return getBudgetStatus()
}
