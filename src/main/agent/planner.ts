/**
 * One-shot Opus planning/replanning call for multi-step or open-ended
 * Operate tasks — see the plan's "separate planning from execution"
 * section. Deliberately has no tools of its own: it only proposes a short
 * step list that the standard-tier executor (agent/loopOptimized.ts)
 * carries out with the real tools. `client` is injected so this is
 * directly unit-testable with a fake, matching the project's existing
 * client-injection testing pattern (voice/transport/fakeSocket.ts etc.).
 */

export interface PlanStep {
  do: string
  successCheck: string
}

export interface TaskPlan {
  steps: PlanStep[]
  risky: boolean
  needsScreen: boolean
}

export interface RawCallUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface PlannerClient {
  createMessage(prompt: string): Promise<{ text: string | null; usage: RawCallUsage }>
}

export interface PlanResult {
  plan: TaskPlan | null
  usage: RawCallUsage | null
}

export const PLANNER_SYSTEM_PROMPT = `You plan a multi-step Windows desktop task for a separate execution model to carry out using UI Automation tools (inspect elements, toggle/click/set values, wait for state changes). You never execute anything yourself.

Given the goal and what's currently known about the screen/window, return a short ordered plan.

Return ONLY strict JSON, no other text, no markdown fences:
{"steps":[{"do":"one short imperative step","successCheck":"how to tell it worked"}],"risky":boolean,"needsScreen":boolean}

At most 8 steps. Keep each step short — the executor will figure out the exact UI elements itself. "risky" means the task includes anything consequential (sending, paying, deleting, discarding unsaved work, signing out, restarting). "needsScreen" means the executor will likely need an actual screenshot (e.g. a custom-drawn surface with poor accessibility support) rather than UI Automation alone.`

const MAX_STEPS = 8
const MAX_PLAN_TEXT_CHARS = 900

function buildPrompt(goal: string, context: string): string {
  return `Goal: ${goal}\n\nWhat's currently known: ${context || '(nothing yet)'}`
}

function parsePlan(text: string): TaskPlan | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.steps)) return null
  const steps: PlanStep[] = obj.steps
    .slice(0, MAX_STEPS)
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && typeof s.do === 'string' && s.do.trim().length > 0)
    .map((s) => ({ do: String(s.do).trim(), successCheck: typeof s.successCheck === 'string' ? s.successCheck.trim() : '' }))
  if (steps.length === 0) return null
  return { steps, risky: obj.risky === true, needsScreen: obj.needsScreen === true }
}

/** Never throws — a malformed response, an empty plan, or a client error all just mean "no plan"; the caller proceeds without one. */
export async function planTask(goal: string, context: string, client: PlannerClient): Promise<PlanResult> {
  try {
    const { text, usage } = await client.createMessage(buildPrompt(goal, context))
    if (!text) return { plan: null, usage }
    return { plan: parsePlan(text), usage }
  } catch {
    return { plan: null, usage: null }
  }
}

/** Compact, one-line rendering injected into the executor's next user message — never a system block, so it doesn't disturb the cache. */
export function renderPlanText(plan: TaskPlan): string {
  const text = plan.steps.map((s, i) => `${i + 1}) ${s.do}`).join(' ')
  return text.length > MAX_PLAN_TEXT_CHARS ? text.slice(0, MAX_PLAN_TEXT_CHARS - 1) + '…' : text
}
