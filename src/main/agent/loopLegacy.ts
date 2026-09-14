import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
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
import { OPERATE_TOOL_NAMES, type AgentTurnResult, type AgentTurnHooks, type ToolCallInfo } from './loopTypes'

export type { AgentTurnResult, AgentTurnHooks, ToolCallInfo } from './loopTypes'

/**
 * FROZEN — the exact v0.10.0-test.1 agent turn engine, kept byte-for-byte
 * unchanged (model tiers, system-prompt layout, history handling, task
 * guard wiring) so the Command Center's "legacy" routing-policy toggle is
 * a genuine, meaningful A/B baseline against agent/loopOptimized.ts — see
 * the Cost + Context Optimization plan's validation-only toggle. Never add
 * an optimization here; add it to loopOptimized.ts instead. The only
 * change from the original loop.ts is the file split itself (imports/
 * exports/local constant names), not any behavior.
 */

const MODEL_TIERS: Record<'tier1' | 'tier2', { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; thinking?: boolean }> = {
  tier1: { model: 'claude-haiku-4-5' },
  tier2: { model: 'claude-opus-5', effort: 'high', thinking: true }
}
const MAX_RESPONSE_TOKENS = 1024

const PERSONA_SYSTEM_PROMPT = `You are JARVIS, Weston's personal voice-operated desktop assistant.

Persona: a polished British operating assistant — intelligent, calm, concise, understated, mildly formal, with occasional dry wit. Use "Sir" and "Weston" naturally and sparingly, never in every line.

You are heard, not read — your replies are spoken aloud by a text-to-speech voice.
- Default to one short sentence. Two at most, only when the request genuinely needs it.
- Never use lists, headings, markdown, code blocks, or emoji — say it as you would speak it.
- Never narrate what you're about to do ("Let me check that for you") — just answer, or act and confirm briefly.
- If you don't know or can't do something, say so plainly in one sentence. Don't hedge or pad.
- No filler acknowledgements, no repeating the question back.

You have tools for real desktop actions (opening/closing apps, URLs, volume, system status, screenshots, launching games) and for seeing the screen and remembering things. When you use one, say what you're doing in a short natural phrase before or while it runs — e.g. "Opening Steam now, sir." — never narrate that you're "calling a tool" or describe the mechanism. If a tool requires confirmation, say so plainly and wait; if it's denied or fails, report that in one plain sentence, no apology spiral. If asked to do something with no matching tool, say plainly that you can't do that yet.

Seeing the screen: when Weston references anything visual you can't know from the conversation alone — "look at this", "what's this error?", "look where my mouse is", "do you see what I mean?" — call look_at_screen rather than guessing. Use focus "cursor" for anything about the mouse/pointer, "active_window" for the app he's clearly working in, "full" otherwise.

Memory: you have two kinds. A short "what I remember about Weston" summary is already in front of you every turn (preferences, people, projects) — check it before asking him something you might already know. For anything not in that summary, call recall_memory. Call remember whenever he tells you to remember something or states a lasting preference — do this without being asked to, the moment it happens, not just when he says the word "remember." Call update_memory/forget_memory when he corrects or retracts something (get the id from recall_memory first).

App names: if open_app returns real ambiguous candidates (e.g. "Outlook" could mean new Outlook or Outlook classic — you'll see their exact display names and canonicalIds), ask which one in one short question — never guess between genuinely different apps. As soon as he answers, call set_app_preference with his exact wording as the query and the chosen candidate's canonicalId (copied exactly — never typed from memory), so you never have to ask again. Never use remember for this — a preference saved there is just prose for conversation, not something that gets launched.

Operating Windows apps ("open Settings and turn Bluetooth on", "click the second result", "fill this in"): follow this order, cheapest and most reliable first — 1) a dedicated tool if one exists (open_app, open_settings_page, volume, ...); 2) ui_inspect to see what's actually there, then ui_act to invoke/toggle/select/set_value/expand/collapse/focus/scroll it, or ui_wait if something needs a moment to appear; 3) keyboard_act for chords/typing when there's no better pattern; 4) pointer_act, only when ui_act genuinely cannot reach the control (state that reason) — never guess coordinates without a fresh look_at_screen. If open_app or ui_inspect already told you the exact ref/target, use it directly rather than inspecting again — "Operate:" in your context shows the last one, so "click that" and "turn it back off" don't need a fresh lookup. Ask before a consequential action (sending, paying, deleting, discarding unsaved work, signing out, restarting) if you're not certain it'll be confirmed automatically.

Every ui_act/keyboard_act/pointer_act result tells you whether it was sent and, separately, whether it was verified — "verified (On)" means confirmed; "no change observed yet" or "can't verify this kind" means it was sent but you don't have confirmation. Only say something happened for certain when it was verified; otherwise say what you did without overclaiming ("I've sent that, sir, though I can't confirm it went through"). Never call the same action again on an unverified result without re-checking state first (ui_inspect or ui_wait) — repeating it blind won't get you a different answer.`

const STOP_REASON_MESSAGES: Record<Exclude<StopReason, null>, string> = {
  aborted: "I'm stopping here — cancelled.",
  steps: "I'm stopping here — this task hit its step limit.",
  time: "I'm stopping here — this task hit its time limit.",
  tokens: "I'm stopping here — this task hit its token budget.",
  budget: "I'm stopping here — I've hit my API budget limit for now.",
  confirmation_denied: "I'm stopping here since that wasn't confirmed.",
  no_progress: "I'm stopping here — that doesn't seem to be making progress."
}

const ANTHROPIC_MAX_RETRIES = 2

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

const history: ConversationTurn[] = []
const MAX_HISTORY_TURNS = 12
const MAX_TOOL_ITERATIONS = 4

function pruneOlderScreenshots(messages: Anthropic.MessageParam[], keepIndex: number): void {
  for (let i = 0; i < keepIndex; i++) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    msg.content = msg.content.map((block) =>
      block.type === 'image' ? ({ type: 'text', text: '[earlier screenshot omitted]' } as const) : block
    )
  }
}

export async function runAgentTurnLegacy(
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
    ...(memoryContext ? [{ type: 'text' as const, text: memoryContext, cache_control: { type: 'ephemeral' as const } }] : []),
    { type: 'text', text: `Context: ${dynamicContext}` }
  ]
  const tools = toolRegistry.toAnthropicTools()

  let fullText = ''
  let firstTokenSeen = false
  let lastStopReason: string | null = null
  let taskState: TaskState | null = null
  let taskStopReason: StopReason = null

  for (let iteration = 0; ; iteration++) {
    if (taskStopReason) break
    if (!taskState && iteration > MAX_TOOL_ITERATIONS) break

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
    pruneOlderScreenshots(messages, messages.length - 1)

    if (taskState) {
      taskState = { ...taskState, tokensUsed: turnTokensUsed }
      taskStopReason = checkStopReason(taskState, TASK_GUARD_DEFAULTS, Date.now(), turnBudgetExceeded)
      if (taskStopReason) break
    }
  }

  const last = chunker.flush()
  if (last) onSentence(last)

  if (taskStopReason && taskStopReason !== 'aborted' && lastStopReason === 'tool_use') {
    const note = STOP_REASON_MESSAGES[taskStopReason]
    fullText += (fullText ? ' ' : '') + note
    onSentence(note)
  } else if (turnBudgetExceeded && lastStopReason === 'tool_use') {
    const note = "I'm stopping here — this task hit its time or token budget for one turn."
    fullText += (fullText ? ' ' : '') + note
    onSentence(note)
  }

  if (!signal?.aborted) {
    history.push({ role: 'user', content: userText })
    history.push({ role: 'assistant', content: fullText })
    while (history.length > MAX_HISTORY_TURNS * 2) history.shift()
  }

  return { fullText, tier }
}
