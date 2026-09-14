import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { logInfo } from '../logger'

export interface BudgetConfig {
  /** Master switch. On by default — turning it off restores today's unrestricted, un-gated behavior (still tracked, never enforced). */
  protectionEnabled: boolean
  dailySoftUsd: number | null
  dailyHardUsd: number | null
  monthlySoftUsd: number | null
  monthlyHardUsd: number | null
  /** Cross-cutting safety net for one agent turn's tool loop — see agent/loopLegacy.ts. Not a per-provider $ limit, just bounds on one runaway turn. Only read by the legacy engine; the optimized engine uses its own cost-based ceilings (loopOptimized.ts's TURN_COST_CEILING_USD/TASK_COST_CEILING_USD) instead — see the Cost + Context Optimization plan for why the token-based version was unreliable in task mode. */
  maxTurnTokens: number
  maxTurnWallMs: number
  /**
   * Validation-only A/B toggle for the Cost + Context Optimization
   * milestone — 'optimized' routes through agent/loopOptimized.ts (local
   * fast-path, Haiku/Sonnet/Opus routing, bounded conversation, pruning);
   * 'legacy' routes through the frozen agent/loopLegacy.ts exactly as
   * shipped in v0.10.0-test.1. See agent/loop.ts's dispatcher.
   */
  routingPolicy: 'optimized' | 'legacy'
}

/**
 * Conservative starting guardrails, not a claim about what any provider's
 * free tier or pricing actually is — every one of these is meant to be
 * tuned in Command Center (or via the JARVIS_BUDGET_* env vars below) to
 * Weston's actual plan/spend comfort, not treated as a correct default.
 */
function defaultConfig(): BudgetConfig {
  return {
    protectionEnabled: process.env.JARVIS_BUDGET_PROTECTION_ENABLED !== 'false',
    dailySoftUsd: envNumber('JARVIS_BUDGET_DAILY_SOFT_USD', 3),
    dailyHardUsd: envNumber('JARVIS_BUDGET_DAILY_HARD_USD', 8),
    monthlySoftUsd: envNumber('JARVIS_BUDGET_MONTHLY_SOFT_USD', 40),
    monthlyHardUsd: envNumber('JARVIS_BUDGET_MONTHLY_HARD_USD', 100),
    maxTurnTokens: envNumber('JARVIS_MAX_TURN_TOKENS', 40000) ?? 40000,
    maxTurnWallMs: (envNumber('JARVIS_MAX_TURN_SECONDS', 180) ?? 180) * 1000,
    routingPolicy: process.env.JARVIS_ROUTING_POLICY === 'legacy' ? 'legacy' : 'optimized'
  }
}

function envNumber(name: string, fallback: number): number | null {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (raw.trim() === '' || raw.trim().toLowerCase() === 'unlimited') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function configFilePath(): string {
  return join(app.getPath('userData'), 'budget-config.json')
}

let cached: BudgetConfig | null = null

function load(): BudgetConfig {
  const defaults = defaultConfig()
  try {
    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8'))
    return { ...defaults, ...raw }
  } catch {
    return defaults
  }
}

function save(cfg: BudgetConfig): void {
  try {
    writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[jarvis] Failed to persist budget-config.json:', (err as Error).message)
  }
}

/** Persisted, user-editable overrides win over env-var defaults (env vars only seed the first run). */
export function getBudgetConfig(): BudgetConfig {
  if (!cached) cached = load()
  return cached
}

export function updateBudgetConfig(patch: Partial<BudgetConfig>): BudgetConfig {
  cached = { ...getBudgetConfig(), ...patch }
  save(cached)
  logInfo('usage:budget', `budget config updated: ${JSON.stringify(patch)}`)
  return cached
}
