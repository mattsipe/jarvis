import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { MAX_RESPONSE_TOKENS, MODEL_TIERS, PLANNER_TIER, SUMMARY_MODEL, type ModelTier } from './config'
import { pickRoute, type Route } from './turnRouter'
import { applyCostPressure, canReplan, canEscalate } from './tierPolicy'
import { planTask, renderPlanText, PLANNER_SYSTEM_PROMPT, type PlannerClient, type RawCallUsage } from './planner'
import { buildSystemBlocks, buildTurnContextLine, selectToolset, wantsCursorContext } from './promptBuilder'
import { conversationStore, buildDigest, truncateAssistantText, type DigestEntry } from './conversation'
import { foldSummary, extractiveFallback, SUMMARY_SYSTEM_PROMPT, type SummarizerClient } from './summarizer'
import { stubOlderEphemeralResults, stubOlderScreenshots, capResultLength } from './pruning'
import { SentenceChunker } from '../voice/sentence'
import { toolRegistry, resolveRisk, type RiskLevel, type ToolResult } from '../tools/registry'
import { getPlatformControl } from '../platform'
import { contextManager } from '../context'
import { usageTracker, budgetManager } from '../usage'
import { loadPricingConfig } from '../usage/pricing'
import { callCost, contextTokens as computeContextTokens } from '../usage/accounting'
import { recordTurn, type CallRecord } from '../usage/turnLedger'
import { operateContext } from '../operate/context'
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
import { OPERATE_TOOL_NAMES, type AgentTurnResult, type AgentTurnHooks, type ToolCallInfo, type TurnTier } from './loopTypes'

/**
 * Optimized turn engine — see the Cost + Context Optimization plan. Kept
 * in its own file, parallel to the frozen agent/loopLegacy.ts, so the
 * Command Center's routing-policy toggle (usage/budgetConfig.ts's
 * `routingPolicy`) is a genuine A/B comparison rather than two views onto
 * shared, ever-changing logic. agent/loop.ts dispatches between the two.
 *
 * The local (0-token) layer — mute/volume/open-app/settings-page/time/
 * stop-cancel/Operate-follow-ups — lives one level up, in
 * voice/session.ts + agent/localCommands.ts + operate/followups.ts, and
 * never reaches this function at all. Everything below assumes a Claude
 * call is actually going to happen.
 */

const ANTHROPIC_MAX_RETRIES = 2
// Cross-cutting safety nets, replacing the legacy engine's broken
// cumulative-token guard (see the plan's section A1): a normal
// conversational turn is capped by estimated $ cost rather than a raw
// token count that a multi-iteration tool loop could trip on its own
// prompt regrowth; an Operate task gets a more generous ceiling since it
// legitimately does more work. Both are checked via checkStopReason (task
// mode) or a plain break (non-task mode) — never by exiting the loop
// before the task-specific stop reason is ever computed, which was
// exactly the legacy bug.
const TURN_COST_CEILING_USD = 0.4
const TASK_COST_CEILING_USD = 1.5

const ESCALATE_TOOL: Anthropic.Tool = {
  name: 'escalate',
  description:
    'Call this instead of answering if the request needs stronger reasoning than you can reliably provide — multi-step planning, an ambiguous UI target, or genuine uncertainty. No arguments.',
  input_schema: { type: 'object', properties: {} }
}

const STOP_REASON_MESSAGES: Record<Exclude<StopReason, null>, string> = {
  aborted: "I'm stopping here — cancelled.",
  steps: "I'm stopping here — this task hit its step limit.",
  time: "I'm stopping here — this task hit its time limit.",
  tokens: "I'm stopping here — this task hit its token budget.",
  budget: "I'm stopping here — I've hit my API budget limit for now.",
  confirmation_denied: "I'm stopping here since that wasn't confirmed.",
  no_progress: "I'm stopping here — that doesn't seem to be making progress."
}

let cachedClient: Anthropic | null = null
let cachedKey = ''
function getClient(): Anthropic {
  if (!cachedClient || cachedKey !== config.anthropicApiKey) {
    cachedClient = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: ANTHROPIC_MAX_RETRIES })
    cachedKey = config.anthropicApiKey
  }
  return cachedClient
}

function rawUsageFrom(final: { usage: Anthropic.Usage }): RawCallUsage {
  return {
    inputTokens: final.usage.input_tokens ?? 0,
    outputTokens: final.usage.output_tokens,
    cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: final.usage.cache_read_input_tokens ?? 0
  }
}

/** One-shot side-call client (planner/replanner/summarizer) — no tools, no streaming, no history. Shared shape across all three call sites below. */
function makeSideCallClient(model: string, system: string, maxTokens: number, thinking?: boolean, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'): PlannerClient & SummarizerClient {
  return {
    createMessage: async (prompt: string) => {
      const res = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        ...(thinking ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(effort ? { output_config: { effort } } : {})
      })
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? null
      return { text, usage: rawUsageFrom(res) }
    }
  }
}

function noteForResult(result: ToolResult): string | undefined {
  const data = result.data as { ambiguous?: boolean; candidates?: Array<{ displayName?: string; name?: string }> } | undefined
  if (data?.ambiguous && Array.isArray(data.candidates) && data.candidates.length > 0) {
    return `asked: ${data.candidates
      .slice(0, 5)
      .map((c) => c.displayName ?? c.name ?? '?')
      .join(' | ')}`
  }
  return undefined
}

export async function runAgentTurnOptimized(
  userText: string,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
  hooks?: AgentTurnHooks
): Promise<AgentTurnResult> {
  const gate = budgetManager.checkAnthropicCall({ essential: true })
  if (!gate.allowed) {
    const message = gate.reason ?? "I've hit my API budget limit for now, so I can't respond right now."
    onSentence(message)
    return { fullText: message, tier: 'blocked' }
  }

  const turnStartedAt = Date.now()
  const turnId = `t-${turnStartedAt}-${Math.random().toString(36).slice(2, 7)}`
  const pricing = loadPricingConfig()
  const calls: CallRecord[] = []
  const digestEntries: DigestEntry[] = []

  function recordCall(purpose: CallRecord['purpose'], model: string, usage: RawCallUsage): void {
    const cost = callCost({ model, ...usage }, pricing)
    calls.push({
      model,
      purpose,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: cost.usd,
      unpriced: cost.unpriced,
      contextTokens: computeContextTokens({ model, ...usage })
    })
    usageTracker.recordAnthropicUsage({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens })
    budgetManager.notifyUsageRecorded()
  }

  const lastTarget = operateContext.getLastTarget()
  const decision = pickRoute({ text: userText, hasFreshOperateTarget: !!lastTarget })
  let route: Route = applyCostPressure(decision.route, budgetManager.costPressure())
  const decidedRoute = route // what we report/log as the routing decision, even once execution below resolves to a concrete tier

  let planText = ''
  if (route === 'deep-plan') {
    const plannerClient = makeSideCallClient(PLANNER_TIER.model, PLANNER_SYSTEM_PROMPT, 500, PLANNER_TIER.thinking, PLANNER_TIER.effort)
    const { plan, usage } = await planTask(userText, operateContext.summary(), plannerClient)
    if (usage) recordCall('plan', PLANNER_TIER.model, usage)
    if (plan) planText = renderPlanText(plan)
    route = 'standard'
  }

  const memoryContext = contextManager.buildMemoryContext()
  const sessionSummary = conversationStore.getSummary()
  const system: Anthropic.TextBlockParam[] = buildSystemBlocks(memoryContext, sessionSummary)

  const activeWindow = await contextManager.getActiveWindow()
  const live = await contextManager.getLiveContext(false)
  const includeCursor = wantsCursorContext(userText)
  const turnContextLine = buildTurnContextLine({
    nowIso: live.nowIso,
    timeZone: live.timeZone,
    activeWindowTitle: activeWindow?.title || undefined,
    activeProcess: activeWindow?.processName || undefined,
    includeCursor,
    cursor: activeWindow?.cursor,
    operateSummary: operateContext.summary(),
    planText
  })

  const windowPairs = conversationStore.getWindow()
  const historyMessages: Anthropic.MessageParam[] = windowPairs.flatMap((p) => [
    { role: 'user', content: p.userText } as Anthropic.MessageParam,
    { role: 'assistant', content: p.digest ? `${p.assistantText} ${p.digest}` : p.assistantText } as Anthropic.MessageParam
  ])

  const ctx = { platform: getPlatformControl(), context: contextManager }
  const chunker = new SentenceChunker()

  let messages: Anthropic.MessageParam[] = [...historyMessages, { role: 'user', content: `${turnContextLine}\n\n${userText}` }]
  let fullText = ''
  let firstTokenSeen = false
  let lastStopReason: string | null = null
  let taskState: TaskState | null = null
  let taskStopReason: StopReason = null
  let escalateRequested = false
  let escalations = 0
  let replans = 0
  let turnCostExceededNoTask = false
  const toolNameByUseId = new Map<string, string>()

  async function runOnce(tierName: ModelTier, allowEscalate: boolean): Promise<void> {
    const tierConfig = MODEL_TIERS[tierName]
    const baseTools = toolRegistry.toAnthropicTools(selectToolset(tierName))
    const anthropicTools = allowEscalate ? [...baseTools, ESCALATE_TOOL] : baseTools
    const maxIterations = tierName === 'fast' ? 3 : 6

    for (let iteration = 0; ; iteration++) {
      if (taskStopReason) break
      if (!taskState && iteration > maxIterations) break

      if (taskState) {
        const midGate = budgetManager.checkAnthropicCall({ essential: true })
        if (!midGate.allowed) {
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
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
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
      recordCall('chain', tierConfig.model, rawUsageFrom(final))

      const turnCostSoFar = calls.reduce((s, c) => s + c.costUsd, 0)
      const ceiling = taskState ? TASK_COST_CEILING_USD : TURN_COST_CEILING_USD
      const costExceeded = turnCostSoFar > ceiling

      lastStopReason = final.stop_reason
      if (final.stop_reason !== 'tool_use') break

      const toolUses = final.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      if (toolUses.length === 0) break

      messages = [...messages, { role: 'assistant', content: final.content as unknown as Anthropic.ContentBlockParam[] }]

      const escalateCall = allowEscalate ? toolUses.find((c) => c.name === 'escalate') : undefined
      if (escalateCall) {
        escalateRequested = true
        messages = [...messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: escalateCall.id, content: 'Escalating to a stronger model.' }] }]
        break
      }

      const resultBlocks: Anthropic.ToolResultBlockParam[] = []
      for (const call of toolUses) {
        if (call.name === 'escalate') {
          resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: 'Not escalating further this turn.' })
          continue
        }
        toolNameByUseId.set(call.id, call.name)
        if (signal?.aborted) {
          if (taskState) taskState = { ...taskState, aborted: true }
          break
        }
        const tool = toolRegistry.get(call.name)
        const risk: RiskLevel = tool ? resolveRisk(tool, call.input) : 'moderate'
        const info: ToolCallInfo = { id: call.id, name: call.name, input: call.input, risk }

        const isOperateCall = OPERATE_TOOL_NAMES.has(call.name)
        if (isOperateCall && !taskState) taskState = createTaskState(turnStartedAt)

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
            digestEntries.push({ tool: call.name, ok: false, note: 'rejected duplicate' })
            continue
          }
        }

        hooks?.onToolStart?.(info)

        let result: ToolResult
        if (!tool) {
          result = { ok: false, message: `Unknown tool: ${call.name}.` }
        } else if (risk === 'elevated') {
          const approved = hooks?.requestConfirmation ? await hooks.requestConfirmation(info) : false
          result = approved ? await toolRegistry.execute(call.name, call.input, ctx) : { ok: false, message: 'Not confirmed — cancelled.' }
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
        digestEntries.push({ tool: call.name, ok: result.ok, note: noteForResult(result) })

        const cappedMessage = capResultLength(result.message)
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content:
            result.images && result.images.length > 0
              ? [
                  { type: 'text' as const, text: cappedMessage },
                  ...result.images.map((img) => ({
                    type: 'image' as const,
                    source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 }
                  }))
                ]
              : cappedMessage,
          is_error: !result.ok
        })
      }

      messages = [...messages, { role: 'user', content: resultBlocks }]
      stubOlderScreenshots(messages, messages.length - 1)
      stubOlderEphemeralResults(messages, toolNameByUseId)

      if (taskState) {
        taskState = {
          ...taskState,
          tokensUsed: calls.reduce((s, c) => s + c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens, 0)
        }
        const stop = checkStopReason(taskState, TASK_GUARD_DEFAULTS, Date.now(), costExceeded)
        if (stop === 'no_progress' && canReplan(replans)) {
          replans++
          const replanClient = makeSideCallClient(PLANNER_TIER.model, PLANNER_SYSTEM_PROMPT, 500, PLANNER_TIER.thinking, PLANNER_TIER.effort)
          const { plan, usage: replanUsage } = await planTask(
            userText,
            `${operateContext.summary()} The previous approach was not making progress — propose a different way to accomplish the same goal.`,
            replanClient
          )
          if (replanUsage) recordCall('replan', PLANNER_TIER.model, replanUsage)
          if (plan) {
            messages = [...messages, { role: 'user', content: `Replanning — that approach wasn't working. New plan: ${renderPlanText(plan)}` }]
            taskState = { ...taskState, recentSignatures: [], noEffectStreak: 0 }
            continue
          }
        }
        taskStopReason = stop
        if (taskStopReason) break
      } else if (costExceeded) {
        turnCostExceededNoTask = true
        break
      }
    }
  }

  if (route === 'fast') {
    await runOnce('fast', true)
    if (escalateRequested && canEscalate(escalations)) {
      escalations++
      messages = [...historyMessages, { role: 'user', content: `${turnContextLine}\n\n${userText}` }]
      taskStopReason = null
      lastStopReason = null
      turnCostExceededNoTask = false
      route = 'standard'
      await runOnce('standard', false)
    }
  } else {
    await runOnce(route === 'deep' ? 'deep' : 'standard', false)
  }

  const last = chunker.flush()
  if (last) onSentence(last)

  if (taskStopReason && taskStopReason !== 'aborted' && lastStopReason === 'tool_use') {
    const note = STOP_REASON_MESSAGES[taskStopReason]
    fullText += (fullText ? ' ' : '') + note
    onSentence(note)
  } else if (turnCostExceededNoTask && lastStopReason === 'tool_use') {
    const note = "I'm stopping here — this reply hit its cost budget."
    fullText += (fullText ? ' ' : '') + note
    onSentence(note)
  }

  if (!signal?.aborted) {
    const digest = buildDigest(digestEntries)
    const { evicted } = conversationStore.recordTurn({ userText, assistantText: truncateAssistantText(fullText), digest })
    if (evicted.length > 0) {
      const sumGate = budgetManager.checkAnthropicCall({ essential: false })
      if (sumGate.allowed) {
        const summarizerClient = makeSideCallClient(SUMMARY_MODEL, SUMMARY_SYSTEM_PROMPT, 600)
        const { summary, usage } = await foldSummary(conversationStore.getSummary(), evicted, summarizerClient)
        conversationStore.applySummary(summary)
        if (usage) recordCall('summary', SUMMARY_MODEL, usage)
      } else {
        conversationStore.applySummary(extractiveFallback(conversationStore.getSummary(), evicted))
      }
    }
  }

  const totalCostUsd = calls.reduce((s, c) => s + c.costUsd, 0)
  const totalContextTokens = calls.reduce((s, c) => s + c.contextTokens, 0)
  recordTurn({
    turnId,
    route: decidedRoute,
    routeReason: decision.reason,
    escalated: escalateRequested,
    replans,
    calls,
    totalCostUsd,
    totalContextTokens,
    localHandled: false,
    startedAt: turnStartedAt,
    endedAt: Date.now()
  })

  const reportedTier: TurnTier = escalateRequested ? 'standard' : (decidedRoute as TurnTier)
  return { fullText, tier: reportedTier }
}
