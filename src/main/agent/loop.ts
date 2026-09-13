import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { MAX_RESPONSE_TOKENS, MODEL_TIERS } from './config'
import { PERSONA_SYSTEM_PROMPT } from './persona'
import { pickTier } from './router'
import { SentenceChunker } from '../voice/sentence'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

// In-memory only — see the plan's Persistence section for the on-disk
// preferences/routines store (not conversation history) landing later.
const history: ConversationTurn[] = []
const MAX_HISTORY_TURNS = 12

export interface AgentTurnResult {
  fullText: string
  tier: 'tier1' | 'tier2'
}

/**
 * Runs one no-tools conversational turn: streams Claude's reply and calls
 * `onSentence` as each complete sentence becomes available (so TTS can
 * start speaking before the whole reply has finished generating — the
 * plan's single biggest perceived-latency win).
 */
export async function runAgentTurn(
  userText: string,
  onSentence: (sentence: string) => void
): Promise<AgentTurnResult> {
  const tier = pickTier(userText)
  const tierConfig = MODEL_TIERS[tier]
  const chunker = new SentenceChunker()

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: 'user', content: userText }
  ]

  const stream = client.messages.stream({
    model: tierConfig.model,
    max_tokens: MAX_RESPONSE_TOKENS,
    system: PERSONA_SYSTEM_PROMPT,
    messages,
    ...(tierConfig.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(tierConfig.effort ? { output_config: { effort: tierConfig.effort } } : {})
  })

  let fullText = ''
  stream.on('text', (delta) => {
    fullText += delta
    for (const sentence of chunker.push(delta)) onSentence(sentence)
  })

  await stream.finalMessage()
  const last = chunker.flush()
  if (last) onSentence(last)

  history.push({ role: 'user', content: userText })
  history.push({ role: 'assistant', content: fullText })
  while (history.length > MAX_HISTORY_TURNS * 2) history.shift()

  return { fullText, tier }
}
