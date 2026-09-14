import type { RiskLevel, ToolResult } from '../tools/registry'

/**
 * Shared between the legacy and optimized turn engines (loopLegacy.ts /
 * loopOptimized.ts) and the thin dispatcher (loop.ts) — see
 * usage/budgetConfig.ts's `routingPolicy` for how the dispatcher picks
 * between them. Kept in one place so callers (voice/session.ts, ipc.ts)
 * never need to know which engine actually ran.
 */
export type TurnTier = 'tier1' | 'tier2' | 'local' | 'fast' | 'standard' | 'deep' | 'deep-plan' | 'blocked'

export interface AgentTurnResult {
  fullText: string
  tier: TurnTier
}

export interface ToolCallInfo {
  id: string
  name: string
  input: unknown
  risk: RiskLevel
}

export interface AgentTurnHooks {
  /** Fires once, on the first streamed text token — for latency telemetry. */
  onFirstToken?: () => void
  onToolStart?: (call: ToolCallInfo) => void
  onToolResult?: (call: ToolCallInfo, result: ToolResult) => void
  /** Only called for 'elevated' risk tools. Resolve true/false to allow/deny. */
  requestConfirmation?: (call: ToolCallInfo) => Promise<boolean>
}

/** Any tool call among these puts the turn into bounded "task mode" — see operate/taskGuard.ts. */
export const OPERATE_TOOL_NAMES = new Set(['ui_inspect', 'ui_act', 'ui_wait', 'keyboard_act', 'pointer_act'])
