import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { MAX_RESPONSE_TOKENS, MODEL_TIERS } from './config'
import { PERSONA_SYSTEM_PROMPT } from './persona'
import { pickTier } from './router'
import { SentenceChunker } from '../voice/sentence'
import { toolRegistry, type RiskLevel, type ToolResult } from '../tools/registry'
import { getPlatformControl } from '../platform'
import { contextManager } from '../context'

// Built lazily (and rebuilt if the key changes) rather than captured once at
// module load — the key can now change at runtime via the Command Center's
// API-config UI (see config.ts's saveApiKeys), and a client built with a
// stale empty key would otherwise keep failing until a full app restart.
let cachedClient: Anthropic | null = null
let cachedKey = ''
function getClient(): Anthropic {
  if (!cachedClient || cachedKey !== config.anthropicApiKey) {
    cachedClient = new Anthropic({ apiKey: config.anthropicApiKey })
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
  tier: 'tier1' | 'tier2'
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
  const tier = pickTier(userText)
  const tierConfig = MODEL_TIERS[tier]
  const chunker = new SentenceChunker()
  const ctx = { platform: getPlatformControl(), context: contextManager }

  let messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: 'user', content: userText }
  ]

  const dynamicContext = await contextManager.buildSystemPromptContext()
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: PERSONA_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Context: ${dynamicContext}` }
  ]
  const tools = toolRegistry.toAnthropicTools()

  let fullText = ''
  let firstTokenSeen = false

  for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
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

    if (final.stop_reason !== 'tool_use' || iteration === MAX_TOOL_ITERATIONS) break

    const toolUses = final.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    )
    if (toolUses.length === 0) break

    messages = [...messages, { role: 'assistant', content: final.content as unknown as Anthropic.ContentBlockParam[] }]

    const resultBlocks: Anthropic.ToolResultBlockParam[] = []
    for (const call of toolUses) {
      if (signal?.aborted) break
      const tool = toolRegistry.get(call.name)
      const risk: RiskLevel = tool?.risk ?? 'moderate'
      const info: ToolCallInfo = { id: call.id, name: call.name, input: call.input, risk }
      hooks?.onToolStart?.(info)

      let result: ToolResult
      if (!tool) {
        result = { ok: false, message: `Unknown tool: ${call.name}.` }
      } else if (risk === 'elevated') {
        const approved = hooks?.requestConfirmation ? await hooks.requestConfirmation(info) : false
        result = approved
          ? await toolRegistry.execute(call.name, call.input, ctx)
          : { ok: false, message: 'Not confirmed — cancelled.' }
      } else {
        result = await toolRegistry.execute(call.name, call.input, ctx)
      }

      hooks?.onToolResult?.(info, result)
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.message,
        is_error: !result.ok
      })
    }

    messages = [...messages, { role: 'user', content: resultBlocks }]
  }

  const last = chunker.flush()
  if (last) onSentence(last)

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
