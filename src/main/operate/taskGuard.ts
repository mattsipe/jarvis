/**
 * Bounded multi-step Operate task execution — pure decision logic so the
 * stop conditions (steps/time/tokens/budget/abort/no-progress/completion)
 * are unit-testable without the real agent loop. See agent/loop.ts for
 * where this is actually consulted each iteration.
 */
export interface TaskLimits {
  maxSteps: number
  maxWallMs: number
  maxTokens: number
}

export interface TaskState {
  stepCount: number
  startedAt: number
  tokensUsed: number
  aborted: boolean
  confirmationDenied: boolean
  /** Last N `(tool|target|action)` signatures, most recent last — used to detect a repeated identical action getting nowhere. */
  recentSignatures: string[]
  /** Consecutive steps in a row that ended with no_effect_observed or stale_ref — a different, faster-tripping no-progress signal than signature repetition. */
  noEffectStreak: number
}

export type StopReason = 'aborted' | 'steps' | 'time' | 'tokens' | 'budget' | 'confirmation_denied' | 'no_progress' | null

const SIGNATURE_REPEAT_THRESHOLD = 3
const NO_EFFECT_STREAK_THRESHOLD = 4
const MAX_TRACKED_SIGNATURES = 10

export function createTaskState(startedAt: number): TaskState {
  return { stepCount: 0, startedAt, tokensUsed: 0, aborted: false, confirmationDenied: false, recentSignatures: [], noEffectStreak: 0 }
}

export function buildStepSignature(toolName: string, target: string, action: string): string {
  return `${toolName}|${target}|${action}`
}

/** Call once per completed step, before the next checkStopReason(). */
export function recordStep(state: TaskState, signature: string, hadEffect: boolean): TaskState {
  const recentSignatures = [...state.recentSignatures, signature].slice(-MAX_TRACKED_SIGNATURES)
  return {
    ...state,
    stepCount: state.stepCount + 1,
    recentSignatures,
    noEffectStreak: hadEffect ? 0 : state.noEffectStreak + 1
  }
}

function isSignatureRepeating(signatures: string[]): boolean {
  if (signatures.length < SIGNATURE_REPEAT_THRESHOLD) return false
  const last = signatures[signatures.length - 1]
  let count = 0
  for (const s of signatures) if (s === last) count++
  return count >= SIGNATURE_REPEAT_THRESHOLD
}

/**
 * Checked before every model call and every tool call — see the plan's
 * task-mode stop reasons. Order matters: an explicit abort or a denied
 * confirmation always wins over a ceiling that happened to be hit at the
 * same moment.
 */
export function checkStopReason(state: TaskState, limits: TaskLimits, now: number, budgetExceeded: boolean): StopReason {
  if (state.aborted) return 'aborted'
  if (state.confirmationDenied) return 'confirmation_denied'
  if (budgetExceeded) return 'budget'
  if (state.stepCount >= limits.maxSteps) return 'steps'
  if (now - state.startedAt >= limits.maxWallMs) return 'time'
  if (state.tokensUsed >= limits.maxTokens) return 'tokens'
  if (state.noEffectStreak >= NO_EFFECT_STREAK_THRESHOLD) return 'no_progress'
  if (isSignatureRepeating(state.recentSignatures)) return 'no_progress'
  return null
}

/** A duplicate, non-idempotent action (e.g. `invoke` — as opposed to `toggle`/`select`/`expand`, which are already desired-state-based and safe to repeat) sent right after its own identical signature — rejected before it's even attempted, not just counted toward the no-progress streak. */
export function isRejectedDuplicateAction(action: string, signature: string, recentSignatures: string[]): boolean {
  const idempotentActions = new Set(['toggle', 'select', 'expand', 'collapse', 'focus'])
  if (idempotentActions.has(action)) return false
  return recentSignatures.length > 0 && recentSignatures[recentSignatures.length - 1] === signature
}

export const TASK_GUARD_DEFAULTS: TaskLimits = {
  maxSteps: 25,
  maxWallMs: 180_000,
  maxTokens: 300_000
}
