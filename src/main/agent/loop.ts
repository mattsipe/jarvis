import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { MAX_RESPONSE_TOKENS, MODEL_TIERS } from './config'
import { PERSONA_SYSTEM_PROMPT } from './persona'
import { pickTier } from './router'
import { SentenceChunker } from '../voice/sentence'
import { toolRegistry, resolveRisk, type RiskLevel, type ToolResult } from '../tools/registry'
import { getPlatformControl } from '../platform'
import { contextManager } from '../context'
import { usageTracker, budgetManager } from '../usage'
import { getBudgetConfig } from '../usage/budgetConfig'
import {
  createTaskState,
  recordStep,
  checkStopReason,
  buildStepSignature,
  isRejectedDuplicateAction,
  TASK_GUARD_DEFAULTS,
  type TaskState,
  type StopReason
} from '../operate/taskGuard'

/** Any tool call among these puts the turn into bounded "task mode" — see operate/taskGuard.ts and the plan's execution-loop design. Everything else keeps the original short MAX_TOOL_ITERATIONS behavior. */
const OPERATE_TOOL_NAMES = new Set(['ui_inspect', 'ui_act', 'ui_wait', 'keyboard_act', 'pointer_act'])

const STOP_REASON_MESSAGES: Record<Exclude<StopReason, null>, string> = {
  aborted: "I'm stopping here — cancelled.",
  steps: "I'm stopping here — this task hit its step limit.",
  time: "I'm stopping here — this task hit its time limit.",
  tokens: "I'm stopping here — this task hit its token budget.",
  budget: "I'm stopping here — I've hit my API budget limit for now.",
  confirmation_denied: "I'm stopping here since that wasn't confirmed.",
  no_progress: "I'm stopping here — that doesn't seem to be making progress."
}

// Caps the SDK's own automatic retry-on-transient-error behavior — see the
// API-safeguards priority's "cap retries". 2 is the SDK's own default, made
// explicit here rather than relied on, so a future SDK upgrade can't
// silently raise it and turn one flaky request into an unbounded retry
// storm against the budget.
const ANTHROPIC_MAX_RETRIES = 2

// Built lazily (and rebuilt if the key changes) rather than captured once at
// module load — the key can now change at runtime via the Command Center's
// API-config UI (see config.ts's saveApiKeys), and a client built with a
// stale empty key would otherwise keep failing until a full app restart.
let cachedClient: Anthropic | null = null
let cachedKey = ''
function getClient(): Anthropic {
  if (!cachedClient || cachedKey !== config.anthropicApiKey) {
    cachedClient = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: ANTHROPIC_MAX_RETRIES })
    cachedKey = config.anthropicApiKey
  }
  return cachedClient
}

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

// In-memory only — see the plan's Persistence section for the on-disk
// preferences/routines store (not conversation history) landing later.
// Only the final natural-language text of a turn is remembered; the
// tool_use/tool_result exchange that produced it is internal to that
// turn's own request loop below, not replayed in later turns.
const history: ConversationTurn[] = []
const MAX_HISTORY_TURNS = 12
const MAX_TOOL_ITERATIONS = 4

export interface AgentTurnResult {
  fullText: string
  tier: 'tier1' | 'tier2' | 'blocked'
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

/** Replaces image blocks in every message before `keepIndex` with a text placeholder — see the call site in the tool loop below. */
function pruneOlderScreenshots(messages: Anthropic.MessageParam[], keepIndex: number): void {
  for (let i = 0; i < keepIndex; i++) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    msg.content = msg.content.map((block) =>
      block.type === 'image' ? ({ type: 'text', text: '[earlier screenshot omitted]' } as const) : block
    )
  }
}

/**
 * Runs one conversational turn, including any tool calls Claude makes as
 * part of answering it (the plan's "manual streaming loop", not the SDK's
 * tool runner, so we can gate on risk and emit HUD events per call).
 * Streams text as it's generated and calls `onSentence` per complete
 * sentence so TTS can start speaking before generation finishes — still
 * the single biggest perceived-latency win, tool calls or not.
 */
export async function runAgentTurn(
  userText: string,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
  hooks?: AgentTurnHooks
): Promise<AgentTurnResult> {
  // This is the reply the user is actively waiting on — "essential" — so
  // protection only blocks it once a HARD limit is crossed, never a soft
  // one (soft limits instead bias pickTier toward the cheapest model, just
  // below). See the API-safeguards priority: hard limits stop nonessential
  // spend without breaking local JARVIS functions — this gate is the only
  // thing standing between a turn and an actual Anthropic call, so a tool
  // like open_app/mute/self_test invoked outside this function (standalone,
  // or via agent/localCommands.ts) never has to pass through it at all.
  const gate = budgetManager.checkAnthropicCall({ essential: true })
  if (!gate.allowed) {
    const message = gate.reason ?? "I've hit my API budget limit for now, so I can't respond right now."
    onSentence(message)
    return { fullText: message, tier: 'blocked' }
  }

  const tier = pickTier(userText, { costPressure: budgetManager.costPressure() })
  const tierConfig = MODEL_TIERS[tier]
  const chunker = new SentenceChunker()
  const ctx = { platform: getPlatformControl(), context: contextManager }
  const turnStartedAt = Date.now()
  const budgetCfg = getBudgetConfig()
  let turnTokensUsed = 0
  let turnBudgetExceeded = false

  let messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: 'user', content: userText }
  ]

  const dynamicContext = await contextManager.buildSystemPromptContext()
  const memoryContext = contextManager.buildMemoryContext()
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: PERSONA_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    // Its own breakpoint: changes far less often than per-turn context
    // (window/cursor/time) but far more often than the persona, so it
    // shouldn't share a cache entry with either.
    ...(memoryContext ? [{ type: 'text' as const, text: memoryContext, cache_control: { type: 'ephemeral' as const } }] : []),
    { type: 'text', text: `Context: ${dynamicContext}` }
  ]
  const tools = toolRegistry.toAnthropicTools()

  let fullText = ''
  let firstTokenSeen = false
  let lastStopReason: string | null = null
  // Created lazily on the first Operate tool call this turn actually makes
  // — see OPERATE_TOOL_NAMES. Most turns never touch this at all.
  let taskState: TaskState | null = null
  let taskStopReason: StopReason = null

  for (let iteration = 0; ; iteration++) {
    if (taskStopReason) break
    if (!taskState && iteration > MAX_TOOL_ITERATIONS) break

    // Task mode re-checks the budget every iteration, not just once at
    // turn start — a long-running Operate task shouldn't be able to run
    // past a hard limit that got crossed mid-task. Every other kind of
    // turn is still gated once, at the top of runAgentTurn.
    if (taskState) {
      const midTaskGate = budgetManager.checkAnthropicCall({ essential: true })
      if (!midTaskGate.allowed) {
        taskStopReason = 'budget'
        break
      }
    }

    const stream = getClient().messages.stream(
      {
        model: tierConfig.model,
        max_tokens: MAX_RESPONSE_TOKENS,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(tierConfig.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(tierConfig.effort ? { output_config: { effort: tierConfig.effort } } : {})
      },
      { signal }
    )

    stream.on('text', (delta) => {
      if (!firstTokenSeen) {
        firstTokenSeen = true
        hooks?.onFirstToken?.()
      }
      fullText += delta
      for (const sentence of chunker.push(delta)) onSentence(sentence)
    })

    const final = await stream.finalMessage()

    // Real, API-reported counts — the actual hook point for accurate
    // Anthropic usage tracking (as opposed to estimating from text length).
    // Recorded every iteration, including the last one, so a multi-step
    // tool-using turn is billed for all of it, not just the final reply.
    usageTracker.recordAnthropicUsage({
      model: tierConfig.model,
      inputTokens: final.usage.input_tokens ?? 0,
      outputTokens: final.usage.output_tokens,
      cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: final.usage.cache_read_input_tokens ?? 0
    })
    budgetManager.notifyUsageRecorded()
    turnTokensUsed +=
      (final.usage.input_tokens ?? 0) +
      final.usage.output_tokens +
      (final.usage.cache_creation_input_tokens ?? 0) +
      (final.usage.cache_read_input_tokens ?? 0)

    // Safety net for a runaway multi-step tool loop (see the
    // long-agent-tasks priority) — bounds one turn's worst case regardless
    // of MAX_TOOL_ITERATIONS, independent of the budget manager's
    // daily/monthly $ limits above.
    if (turnTokensUsed > budgetCfg.maxTurnTokens || Date.now() - turnStartedAt > budgetCfg.maxTurnWallMs) {
      turnBudgetExceeded = true
    }

    lastStopReason = final.stop_reason
    if (final.stop_reason !== 'tool_use' || turnBudgetExceeded) break

    const toolUses = final.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    )
    if (toolUses.length === 0) break

    messages = [...messages, { role: 'assistant', content: final.content as unknown as Anthropic.ContentBlockParam[] }]

    const resultBlocks: Anthropic.ToolResultBlockParam[] = []
    for (const call of toolUses) {
      if (signal?.aborted) {
        if (taskState) taskState = { ...taskState, aborted: true }
        break
      }
      const tool = toolRegistry.get(call.name)
      const risk: RiskLevel = tool ? resolveRisk(tool, call.input) : 'moderate'
      const info: ToolCallInfo = { id: call.id, name: call.name, input: call.input, risk }

      const isOperateCall = OPERATE_TOOL_NAMES.has(call.name)
      if (isOperateCall && !taskState) taskState = createTaskState(turnStartedAt)

      // A duplicate, non-idempotent action right after itself (e.g. two
      // identical `invoke` calls in a row) is rejected before it's even
      // attempted — idempotent actions (toggle/select/expand/...) are
      // exempt, since repeating those with the same desired state is
      // exactly what makes "turn it back off" safe. See taskGuard.ts.
      if (isOperateCall && taskState) {
        const targetDesc = typeof call.input === 'object' && call.input && 'target' in call.input ? JSON.stringify((call.input as { target?: unknown }).target) : ''
        const actionDesc = typeof call.input === 'object' && call.input && 'action' in call.input ? String((call.input as { action?: unknown }).action) : call.name
        const signature = buildStepSignature(call.name, targetDesc, actionDesc)
        if (isRejectedDuplicateAction(actionDesc, signature, taskState.recentSignatures)) {
          const result: ToolResult = { ok: false, message: 'Not repeating that — it was just attempted with no observed change. Re-inspect first if you need to confirm the current state.' }
          hooks?.onToolStart?.(info)
          hooks?.onToolResult?.(info, result)
          resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: result.message, is_error: true })
          taskState = recordStep(taskState, signature, false)
          continue
        }
      }

      hooks?.onToolStart?.(info)

      let result: ToolResult
      if (!tool) {
        result = { ok: false, message: `Unknown tool: ${call.name}.` }
      } else if (risk === 'elevated') {
        const approved = hooks?.requestConfirmation ? await hooks.requestConfirmation(info) : false
        result = approved
          ? await toolRegistry.execute(call.name, call.input, ctx)
          : { ok: false, message: 'Not confirmed — cancelled.' }
        // A denied confirmation stops the whole task, not just this one
        // step — see the plan: no alternate route to the same
        // consequential action should be tried afterward.
        if (!approved && taskState) taskState = { ...taskState, confirmationDenied: true }
      } else {
        result = await toolRegistry.execute(call.name, call.input, ctx)
      }

      if (isOperateCall && taskState) {
        const targetDesc = typeof call.input === 'object' && call.input && 'target' in call.input ? JSON.stringify((call.input as { target?: unknown }).target) : ''
        const actionDesc = typeof call.input === 'object' && call.input && 'action' in call.input ? String((call.input as { action?: unknown }).action) : call.name
        taskState = recordStep(taskState, buildStepSignature(call.name, targetDesc, actionDesc), result.ok)
      }

      hooks?.onToolResult?.(info, result)
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        // look_at_screen is the only tool that ever sets `images` — every
        // other tool_result stays a plain string exactly as before.
        content:
          result.images && result.images.length > 0
            ? [
                { type: 'text' as const, text: result.message },
                ...result.images.map((img) => ({
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 }
                }))
              ]
            : result.message,
        is_error: !result.ok
      })
    }

    messages = [...messages, { role: 'user', content: resultBlocks }]
    // Only the screenshot from the tool call that just ran stays as an
    // actual image — every earlier one (from a previous iteration of
    // *this* turn) is replaced with a text placeholder so a multi-step
    // turn with several look_at_screen calls doesn't compound image
    // tokens across iterations. Never touches `history` below, which only
    // ever stores final text, not these message objects.
    pruneOlderScreenshots(messages, messages.length - 1)

    // Once a turn has entered task mode, every one of these stop
    // conditions is checked before the next model call is even made — see
    // operate/taskGuard.ts and the plan's execution-loop design.
    if (taskState) {
      taskState = { ...taskState, tokensUsed: turnTokensUsed }
      taskStopReason = checkStopReason(taskState, TASK_GUARD_DEFAULTS, Date.now(), turnBudgetExceeded)
      if (taskStopReason) break
    }
  }

  const last = chunker.flush()
  if (last) onSentence(last)

  // The loop was cut off mid-tool-use by an Operate task's own guard
  // (steps/time/tokens/budget/abort/confirmation-denied/no-progress) — say
  // so, since otherwise the turn would end in silence with no text ever
  // generated for this last step. Checked before the generic turn-budget
  // note below, since a task stop reason is always the more specific one.
  if (taskStopReason && taskStopReason !== 'aborted' && lastStopReason === 'tool_use') {
    const note = STOP_REASON_MESSAGES[taskStopReason]
    fullText += (fullText ? ' ' : '') + note
    onSentence(note)
  } else if (turnBudgetExceeded && lastStopReason === 'tool_use') {
    const note = "I'm stopping here — this task hit its time or token budget for one turn."
    fullText += (fullText ? ' ' : '') + note
    onSentence(note)
  }

  // Don't let a barge-in-interrupted (or otherwise cut-off) reply pollute
  // history with a truncated answer — only a turn that ran to completion
  // becomes part of the conversation's context.
  if (!signal?.aborted) {
    history.push({ role: 'user', content: userText })
    history.push({ role: 'assistant', content: fullText })
    while (history.length > MAX_HISTORY_TURNS * 2) history.shift()
  }

  return { fullText, tier }
}
